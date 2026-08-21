import * as fs from 'fs';
import * as path from 'path';

/**
 * Loads integration-test credentials from a git-ignored `.env.itest` file.
 *
 * The spec's Environment Contract says credentials live "in the developer's
 * shell or a git-ignored `.env.itest` file". The shell half works for free;
 * this is the file half. Deliberately dependency-free — the package's
 * dependency surface is supposed to mirror a real SDK consumer, and a
 * key=value parser does not justify pulling in dotenv.
 *
 * Precedence: the real environment always wins. A value already present in
 * `process.env` is never overwritten, so `ITEST_FOO=x npm run test:integration`
 * still beats the file, and CI (which sets real env vars) ignores it entirely.
 *
 * Values are never logged — only the names of the keys that were applied.
 */

export interface LoadEnvFileResult {
  /** Absolute path of the file that was read, or null when none was found. */
  readonly file: string | null;
  /** Names (never values) of the keys applied to process.env. */
  readonly applied: readonly string[];
  /** Names of keys present in the file but already set in the environment. */
  readonly skipped: readonly string[];
}

/**
 * Parses `.env`-style text. Supports `KEY=value`, a leading `export `, `#`
 * comments, blank lines, and single- or double-quoted values (quoted values
 * keep any trailing `#`, unquoted ones treat it as a comment).
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separator = withoutExport.indexOf('=');
    if (separator <= 0) {
      continue;
    }

    const key = withoutExport.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = withoutExport.slice(separator + 1).trim();

    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value[value.length - 1] === quote) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) {
        value = value.slice(0, comment).trim();
      }
    }

    result[key] = value;
  }

  return result;
}

/**
 * Finds and applies `.env.itest`. Search order: `ITEST_ENV_FILE` if set, then
 * the repo root, then this package's directory. The first existing file wins.
 */
export function loadEnvFile(env: NodeJS.ProcessEnv = process.env): LoadEnvFileResult {
  const packageDir = path.resolve(__dirname, '..', '..');
  const repoRoot = path.resolve(packageDir, '..', '..');

  const candidates = env['ITEST_ENV_FILE']
    ? [path.resolve(env['ITEST_ENV_FILE'])]
    : [path.join(repoRoot, '.env.itest'), path.join(packageDir, '.env.itest')];

  const file = candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  if (file === null) {
    if (env['ITEST_ENV_FILE']) {
      throw new Error(
        `[itest] ITEST_ENV_FILE points at ${candidates[0]}, which does not exist.`,
      );
    }
    return { file: null, applied: [], skipped: [] };
  }

  const parsed = parseEnvFile(fs.readFileSync(file, 'utf8'));
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === '') {
      env[key] = value;
      applied.push(key);
    } else {
      skipped.push(key);
    }
  }

  return { file, applied, skipped };
}
