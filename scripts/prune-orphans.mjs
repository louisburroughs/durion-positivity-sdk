#!/usr/bin/env node
// Delete generated files the generator no longer produces.
//
// OpenAPI Generator writes the files a spec calls for and never removes the
// ones it stops writing. When an endpoint or schema leaves a spec, its client
// lingers, and because tsc type-checks every file under src/ a file nothing
// imports can still break the build. That is what happened to sdk-workorder:
// TimeEntryAPIApi.ts outlived its spec, kept importing two models that were no
// longer exported, and made `npm ci` fail for the whole repository.
//
// What counts as an orphan
// ------------------------
// Reachability, not barrel membership. A file is kept when anything reachable
// from the package's entry points imports it, and removed only when nothing
// does.
//
// Barrel membership looked like the obvious test and is wrong: PageableObject
// and SortObject are absent from most models/index.ts yet are imported directly
// by the PageXxx models, so "not re-exported" would have deleted live code in
// 91 places. Reachability keeps them, because the models that need them are
// themselves reachable.
//
// The cascade falls out for free: dropping a file removes the only importer of
// whatever only it referenced, and a single reachability pass from the roots
// already accounts for that.
//
// What is never touched
// ---------------------
// - index.ts barrels, which the generator rewrites every run and which seed the walk
// - anything listed in the package's .openapi-generator-ignore, the repo's
//   existing record of hand-maintained files inside generated directories
//   (sdk-customer's VehicleSummary.ts is the live example)
// - anything outside src/apis/ and src/models/
//
// A file that is unreachable but still imported by hand-written code is a
// different problem and is reported, not deleted: removing it would only trade
// a dangling symbol for a dangling path. That report is the signal that a
// hand-written factory still refers to a surface the backend dropped.
//
// Usage:
//   node scripts/prune-orphans.mjs                 # every package
//   node scripts/prune-orphans.mjs --module order  # one package
//   node scripts/prune-orphans.mjs --dry-run       # report, delete nothing

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const moduleArg = args.includes('--module') ? args[args.indexOf('--module') + 1] : null;

const GENERATED_DIRS = ['src/apis', 'src/models'];

function listPackages() {
  if (moduleArg) return [`packages/sdk-${moduleArg}`];
  return readdirSync('packages')
    .filter((name) => name.startsWith('sdk-'))
    .map((name) => path.join('packages', name))
    .filter((dir) => existsSync(path.join(dir, 'src')))
    .sort();
}

// Every relative specifier in a file: import/export ... from './x', and the
// bare `import './x'` side-effect form.
function relativeSpecifiers(source) {
  const specifiers = [];
  const from = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"](\.[^'"]+)['"]/g;
  const bare = /(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g;
  for (const re of [from, bare]) {
    let match;
    while ((match = re.exec(source)) !== null) specifiers.push(match[1]);
  }
  return specifiers;
}

// './Foo' -> the .ts file it names, directory index included. Returns null for
// anything that does not resolve to a real file (a node_modules import, or a
// path already deleted).
function resolveSpecifier(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// Files the walk starts from: the package entry point, the two barrels the
// generator rewrites, and hand-written workflow helpers.
function rootsFor(pkgDir) {
  const roots = [];
  for (const rel of ['src/index.ts', 'src/apis/index.ts', 'src/models/index.ts']) {
    const file = path.join(pkgDir, rel);
    if (existsSync(file)) roots.push(path.resolve(file));
  }
  const workflows = path.join(pkgDir, 'src/workflows');
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows)) {
      if (name.endsWith('.ts')) roots.push(path.resolve(path.join(workflows, name)));
    }
  }
  return roots;
}

function reachableFrom(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of relativeSpecifiers(source)) {
      const target = resolveSpecifier(file, specifier);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

// Hand-maintained files inside generated directories, per the package's own
// .openapi-generator-ignore. Only plain paths and simple *.ts globs appear
// there today; both are handled, anything fancier is treated as protected.
function protectedPaths(pkgDir) {
  const ignoreFile = path.join(pkgDir, '.openapi-generator-ignore');
  const protectedSet = new Set();
  if (!existsSync(ignoreFile)) return protectedSet;
  for (const raw of readFileSync(ignoreFile, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (line.includes('*')) {
      const [prefix] = line.split('*');
      protectedSet.add(path.resolve(path.join(pkgDir, prefix)));
    } else {
      protectedSet.add(path.resolve(path.join(pkgDir, line)));
    }
  }
  return protectedSet;
}

function isProtected(file, protectedSet) {
  if (protectedSet.has(file)) return true;
  for (const entry of protectedSet) {
    if (file.startsWith(entry)) return true;
  }
  return false;
}

let removed = 0;
let reported = 0;

for (const pkgDir of listPackages()) {
  if (!existsSync(pkgDir)) {
    console.error(`[prune] no such package: ${pkgDir}`);
    process.exit(2);
  }

  const roots = rootsFor(pkgDir);
  if (roots.length === 0) continue;

  // A missing or empty barrel means generation did not finish for this package.
  // Pruning against it would delete everything, so refuse instead.
  for (const dir of GENERATED_DIRS) {
    const barrel = path.join(pkgDir, dir, 'index.ts');
    if (existsSync(path.join(pkgDir, dir)) && (!existsSync(barrel) || readFileSync(barrel, 'utf8').trim() === '')) {
      console.error(`[prune] ${pkgDir}/${dir}/index.ts is missing or empty; refusing to prune this package.`);
      process.exit(1);
    }
  }

  const reachable = reachableFrom(roots);
  const guarded = protectedPaths(pkgDir);

  for (const dir of GENERATED_DIRS) {
    const full = path.join(pkgDir, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full).sort()) {
      if (!name.endsWith('.ts') || name === 'index.ts') continue;
      const file = path.resolve(path.join(full, name));
      if (reachable.has(file) || isProtected(file, guarded)) continue;
      if (dryRun) {
        console.log(`[prune] would remove ${path.relative(process.cwd(), file)}`);
      } else {
        unlinkSync(file);
        console.log(`[prune] removed ${path.relative(process.cwd(), file)}`);
      }
      removed += 1;
    }
  }

  // Unreachable from the barrels but still named by hand-written code: deleting
  // it would swap a dangling symbol for a dangling path, so say so instead.
  const entry = path.resolve(path.join(pkgDir, 'src/index.ts'));
  if (existsSync(entry)) {
    for (const specifier of relativeSpecifiers(readFileSync(entry, 'utf8'))) {
      const target = resolveSpecifier(entry, specifier);
      if (!target) {
        console.error(`[prune] ${pkgDir}/src/index.ts imports '${specifier}', which does not exist.`);
        reported += 1;
      }
    }
  }
}

console.log(
  dryRun
    ? `[prune] dry run: ${removed} orphan(s) would be removed.`
    : `[prune] ${removed} orphan(s) removed.`,
);

if (reported > 0) {
  console.error(`[prune] ${reported} unresolved import(s) in hand-written entry points; fix these by hand.`);
  process.exit(1);
}
