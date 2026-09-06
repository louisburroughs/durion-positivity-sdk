#!/usr/bin/env node
// Delete generated files the generator no longer produces.
//
// OpenAPI Generator writes the files a spec calls for and never removes the
// ones it stops writing. When an endpoint or schema leaves a spec its client
// lingers, and because tsc type-checks every file under src/ a file nothing
// imports can still break the build. sdk-workorder's TimeEntryAPIApi.ts did
// exactly that and made `npm ci` fail for the whole repository.
//
// The oracle
// ----------
// `.openapi-generator/FILES`, which the generator rewrites on every run and
// which lists exactly the files the current spec produced. A file under
// src/apis or src/models that is absent from it was not emitted this run.
//
// An earlier version of this script inferred the same thing from import
// reachability and got it wrong in the one case that mattered: the broken
// TimeEntryAPIApi.ts was imported by the hand-written src/index.ts, so it was
// reachable and kept, while the two models it imported were unreachable and
// deleted -- taking a broken tree and leaving it broken, with real files gone
// and exit 0. Reachability answers "does anything point at this?", which is a
// different question from "did the generator make this?".
//
// Imports are still parsed, but only to answer the second question: is an
// orphan still referenced by something that survives? If it is, deleting it
// would trade a dangling symbol for a dangling path, so it is reported and the
// run fails instead. That is the signal this repository lacked -- hand-written
// code still naming a surface the backend has dropped.
//
// Safety
// ------
// - FILES missing => that package is skipped, never pruned by guesswork. Run
//   this after generation, which is where generate-openapi.sh calls it.
// - A blast-radius ceiling refuses a package whose orphan count looks like a
//   half-finished generation rather than a few removed endpoints. A truncated
//   (not merely empty) barrel is the case that motivated it.
// - Anything in .openapi-generator-ignore is hand-maintained and untouchable.
// - Deletions are computed per package, checked, and only then applied, and a
//   refusal never aborts the run mid-loop with earlier packages already cut.
//
// Usage:
//   node scripts/prune-orphans.mjs                 # every package
//   node scripts/prune-orphans.mjs --module order  # one package
//   node scripts/prune-orphans.mjs --dry-run       # report, delete nothing
//   node scripts/prune-orphans.mjs --force         # bypass the ceiling

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const KNOWN_FLAGS = new Set(['--dry-run', '--module', '--force']);
const GENERATED_DIRS = ['src/apis', 'src/models'];
// Below this many files a package is too small for a percentage to mean much.
const CEILING_MIN_FILES = 10;
const CEILING_FRACTION = 0.25;

// ---------------------------------------------------------------------------
// Arguments. Every unrecognised token is fatal: this deletes files, and the
// failure mode of a silently ignored argument is a run that quietly widens from
// one package to all of them.
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let dryRun = false;
let force = false;
let moduleArg = null;

for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === '--dry-run') {
    dryRun = true;
  } else if (arg === '--force') {
    force = true;
  } else if (arg === '--module') {
    moduleArg = args[i + 1];
    if (!moduleArg || KNOWN_FLAGS.has(moduleArg) || moduleArg.startsWith('-')) {
      console.error('[prune] --module requires a package name, for example: --module order');
      process.exit(2);
    }
    i += 1;
  } else {
    console.error(`[prune] unknown argument: ${arg}`);
    console.error('[prune] usage: prune-orphans.mjs [--module <name>] [--dry-run] [--force]');
    process.exit(2);
  }
}

function listPackages() {
  if (moduleArg) return [`packages/sdk-${moduleArg}`];
  return readdirSync('packages')
    .filter((name) => name.startsWith('sdk-'))
    .map((name) => path.join('packages', name))
    .filter((dir) => existsSync(path.join(dir, 'src')))
    .sort();
}

// ---------------------------------------------------------------------------
// Import scanning. Used only to decide whether an orphan is still referenced,
// so every miss here risks deleting something that is still used: the patterns
// deliberately over-match rather than under-match. A hit inside a comment or a
// template string only over-protects.
// ---------------------------------------------------------------------------
function relativeSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g, // static import/export
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]/g, // dynamic import()
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]/g, // require() and import x = require()
    /\bimport\s+['"](\.[^'"]+)['"]/g, // side-effect import
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

// './Foo', './Foo.js' (NodeNext style) and './Foo/index' all name a .ts file.
function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    path.join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Every .ts file in the repo that could reference a generated file, including
// the root test tree and cross-package harnesses that deep-import package
// internals. Scanning everything removes any need to guess at entry points.
function allSourceFiles() {
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path.resolve(full));
    }
  };
  walk('src');
  for (const name of existsSync('packages') ? readdirSync('packages') : []) {
    walk(path.join('packages', name, 'src'));
  }
  return files;
}

// file -> the set of files importing it, across the whole repo.
function buildReferenceIndex() {
  const importers = new Map();
  for (const file of allSourceFiles()) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (!target) continue;
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return importers;
}

// ---------------------------------------------------------------------------
// Hand-maintained files inside generated directories, per each package's own
// .openapi-generator-ignore. A pattern whose non-wildcard prefix is empty
// (`*.md`) would otherwise protect the entire package and silently disable
// pruning there, so those are skipped with a warning instead.
// ---------------------------------------------------------------------------
function protectedPaths(pkgDir) {
  const ignoreFile = path.join(pkgDir, '.openapi-generator-ignore');
  const guarded = new Set();
  if (!existsSync(ignoreFile)) return guarded;
  for (const raw of readFileSync(ignoreFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const prefix = line.includes('*') ? line.split('*')[0] : line;
    if (prefix === '') {
      console.error(`[prune] ${pkgDir}/.openapi-generator-ignore: ignoring unsupported pattern '${line}'`);
      continue;
    }
    guarded.add(path.resolve(path.join(pkgDir, prefix)));
  }
  return guarded;
}

// Compare by path segment, so `src/workflows` does not also guard
// `src/workflows-old.ts`.
function isProtected(file, guarded) {
  for (const entry of guarded) {
    if (file === entry) return true;
    const rel = path.relative(entry, file);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------

const importers = buildReferenceIndex();
let removed = 0;
let refused = 0;
let stillReferenced = 0;

for (const pkgDir of listPackages()) {
  if (!existsSync(pkgDir)) {
    console.error(`[prune] no such package: ${pkgDir}`);
    process.exit(2);
  }

  // The generator's own manifest of what this run produced. Without it there is
  // no way to know what should exist, and guessing is how the previous version
  // of this script went wrong.
  const manifestPath = path.join(pkgDir, '.openapi-generator/FILES');
  if (!existsSync(manifestPath)) {
    console.error(`[prune] ${pkgDir}: no .openapi-generator/FILES; skipping (run generation first).`);
    continue;
  }
  const emitted = new Set(
    readFileSync(manifestPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );

  const guarded = protectedPaths(pkgDir);
  const candidates = [];
  let generatedCount = 0;

  for (const dir of GENERATED_DIRS) {
    const full = path.join(pkgDir, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) {
      if (!name.endsWith('.ts')) continue;
      generatedCount += 1;
      const rel = `${dir}/${name}`;
      const file = path.resolve(path.join(full, name));
      if (emitted.has(rel) || isProtected(file, guarded)) continue;
      candidates.push(file);
    }
  }

  if (candidates.length === 0) continue;

  // A half-finished generation looks like a large fraction of the package
  // suddenly being unemitted. Removed endpoints do not.
  const ceiling = Math.max(CEILING_MIN_FILES, Math.floor(generatedCount * CEILING_FRACTION));
  if (candidates.length > ceiling && !force) {
    console.error(
      `[prune] ${pkgDir}: ${candidates.length} of ${generatedCount} generated files are unaccounted for, ` +
        `over the ceiling of ${ceiling}. This looks like an incomplete generation rather than removed ` +
        `endpoints, so nothing was deleted. Re-run generation, or pass --force if this is genuinely correct.`,
    );
    refused += 1;
    continue;
  }

  // A candidate is safe to delete only if every file importing it is itself
  // being deleted. Treating all candidates as gone up front is wrong: if one is
  // blocked because hand-written code still names it, whatever only it imports
  // must be kept too, or the block leaves dangling imports behind. Demote until
  // the set stops shrinking.
  const deletable = new Set(candidates);
  const blockedBy = new Map();
  for (let changed = true; changed; ) {
    changed = false;
    for (const file of [...deletable]) {
      const survivors = [...(importers.get(file) ?? [])].filter((f) => f !== file && !deletable.has(f));
      if (survivors.length > 0) {
        deletable.delete(file);
        blockedBy.set(file, survivors);
        changed = true;
      }
    }
  }

  for (const file of candidates) {
    const shown = path.relative(process.cwd(), file);
    if (!deletable.has(file)) {
      // The TimeEntryAPIApi case: the generator stopped emitting it, but
      // hand-written code still names it. Deleting would only swap a dangling
      // symbol for a dangling path.
      console.error(`[prune] ${shown} is no longer generated, but is still imported by:`);
      for (const user of blockedBy.get(file) ?? []) {
        console.error(`[prune]   ${path.relative(process.cwd(), user)}`);
      }
      stillReferenced += 1;
      continue;
    }
    if (dryRun) {
      console.log(`[prune] would remove ${shown}`);
    } else {
      unlinkSync(file);
      console.log(`[prune] removed ${shown}`);
    }
    removed += 1;
  }
}

console.log(
  dryRun ? `[prune] dry run: ${removed} orphan(s) would be removed.` : `[prune] ${removed} orphan(s) removed.`,
);

if (stillReferenced > 0) {
  console.error(
    `[prune] ${stillReferenced} file(s) are no longer generated but are still imported. ` +
      `Update the code that imports them, or restore the endpoint that produced them.`,
  );
}
if (refused > 0) {
  console.error(`[prune] ${refused} package(s) refused on the blast-radius ceiling.`);
}
if (stillReferenced > 0 || refused > 0) process.exit(1);
