import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadEnvFile, parseEnvFile } from './loadEnvFile';

describe('parseEnvFile', () => {
  it('parses plain key=value pairs', () => {
    expect(parseEnvFile('ITEST_USERNAME=marcus.webb\nITEST_SEED=42')).toEqual({
      ITEST_USERNAME: 'marcus.webb',
      ITEST_SEED: '42',
    });
  });

  it('ignores blank lines and comments', () => {
    expect(parseEnvFile('# a comment\n\nITEST_USERNAME=x\n   \n')).toEqual({ ITEST_USERNAME: 'x' });
  });

  it('accepts a leading export', () => {
    expect(parseEnvFile('export ITEST_USERNAME=x')).toEqual({ ITEST_USERNAME: 'x' });
  });

  it('strips matching surrounding quotes and keeps inner characters', () => {
    expect(parseEnvFile('A="pa ss#word"\nB=\'other\'')).toEqual({ A: 'pa ss#word', B: 'other' });
  });

  it('treats a trailing " #" as a comment only when unquoted', () => {
    expect(parseEnvFile('A=value # trailing note')).toEqual({ A: 'value' });
  });

  it('preserves a # that is part of an unquoted value', () => {
    expect(parseEnvFile('A=va#lue')).toEqual({ A: 'va#lue' });
  });

  it('skips malformed lines and invalid keys', () => {
    expect(parseEnvFile('no_equals_here\n=novalue\n1BAD=x\nGOOD=y')).toEqual({ GOOD: 'y' });
  });

  it('allows an empty value', () => {
    expect(parseEnvFile('ITEST_PASSWORD=')).toEqual({ ITEST_PASSWORD: '' });
  });
});

describe('loadEnvFile', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'itest-env-'));
    file = path.join(dir, '.env.itest');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('applies file values that are absent from the environment', () => {
    fs.writeFileSync(file, 'ITEST_USERNAME=from-file\n');
    const env: NodeJS.ProcessEnv = { ITEST_ENV_FILE: file };

    const result = loadEnvFile(env);

    expect(env['ITEST_USERNAME']).toBe('from-file');
    expect(result.applied).toEqual(['ITEST_USERNAME']);
    expect(result.file).toBe(file);
  });

  it('never overwrites a value already set in the environment', () => {
    fs.writeFileSync(file, 'ITEST_USERNAME=from-file\n');
    const env: NodeJS.ProcessEnv = { ITEST_ENV_FILE: file, ITEST_USERNAME: 'from-shell' };

    const result = loadEnvFile(env);

    expect(env['ITEST_USERNAME']).toBe('from-shell');
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['ITEST_USERNAME']);
  });

  it('treats an empty environment value as unset', () => {
    fs.writeFileSync(file, 'ITEST_USERNAME=from-file\n');
    const env: NodeJS.ProcessEnv = { ITEST_ENV_FILE: file, ITEST_USERNAME: '' };

    loadEnvFile(env);

    expect(env['ITEST_USERNAME']).toBe('from-file');
  });

  it('returns an empty result when no file exists', () => {
    const env: NodeJS.ProcessEnv = {};
    // No ITEST_ENV_FILE and no .env.itest in the repo root during unit runs.
    const result = loadEnvFile(env);

    if (result.file === null) {
      expect(result.applied).toEqual([]);
    }
  });

  it('throws when ITEST_ENV_FILE points at a missing file', () => {
    const env: NodeJS.ProcessEnv = { ITEST_ENV_FILE: path.join(dir, 'nope') };

    expect(() => loadEnvFile(env)).toThrow(/does not exist/);
  });
});
