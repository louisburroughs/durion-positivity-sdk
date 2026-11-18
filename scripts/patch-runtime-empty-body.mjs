#!/usr/bin/env node
// Teach the generated JSONApiResponse to read an empty body as "no value".
//
// typescript-fetch emits JSONApiResponse.value() as `this.raw.json()`, so any
// operation documented with a 200 body and a bodiless 204 (for example
// order getCurrentRegisterSession: "204 when the terminal has no active
// session") throws "Unexpected end of JSON input" on the 204 instead of
// returning. The patched value() returns undefined for a 204 or an empty body
// and parses everything else as before.
//
// Idempotent: a runtime.ts already patched is left alone. A runtime.ts whose
// JSONApiResponse no longer matches the generator's shape fails the run, so a
// generator upgrade cannot drop the patch silently.
//
//   node scripts/patch-runtime-empty-body.mjs              every packages/sdk-*/src/runtime.ts
//   node scripts/patch-runtime-empty-body.mjs <module>...  only packages/sdk-<module>
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

export const GENERATED = `    async value(): Promise<T> {
        return this.transformer(await this.raw.json());
    }`;

export const PATCHED = `    async value(): Promise<T> {
        // A 204, or any empty body, has no JSON to parse (patched by
        // scripts/patch-runtime-empty-body.mjs after generation).
        if (this.raw.status === 204) {
            return undefined as T;
        }
        const text = await this.raw.text();
        if (text.trim() === '') {
            return undefined as T;
        }
        return this.transformer(JSON.parse(text));
    }`;

/** Returns the patched source, or throws when the generated shape is not found. */
export function patchRuntime(source, file = 'runtime.ts') {
  if (source.includes(PATCHED)) return source;
  const start = source.indexOf('export class JSONApiResponse<T>');
  if (start < 0) throw new Error(`${file}: no JSONApiResponse class`);
  const at = source.indexOf(GENERATED, start);
  const classEnd = source.indexOf('\n}', start);
  if (at < 0 || at > classEnd) {
    throw new Error(`${file}: JSONApiResponse.value() is not the generated shape; update scripts/patch-runtime-empty-body.mjs`);
  }
  return source.slice(0, at) + PATCHED + source.slice(at + GENERATED.length);
}

function runtimeFiles(modules) {
  const dirs = modules.length > 0
    ? modules.map((m) => `sdk-${m}`)
    : readdirSync(PACKAGES_DIR).filter((d) => d.startsWith('sdk-')).sort();
  return dirs.map((d) => join(PACKAGES_DIR, d, 'src', 'runtime.ts')).filter((f) => existsSync(f));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let changed = 0;
  const files = runtimeFiles(process.argv.slice(2));
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const next = patchRuntime(source, file);
    if (next !== source) {
      writeFileSync(file, next);
      changed += 1;
    }
  }
  console.log(`[generate] runtime empty-body patch: ${changed} patched, ${files.length - changed} already patched`);
}
