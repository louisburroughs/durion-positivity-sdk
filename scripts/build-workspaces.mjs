#!/usr/bin/env node
// Compile every workspace package in dependency order.
//
// Every domain package imports @durion-sdk/transport, and a package's types
// resolve through its dist/index.d.ts, so transport must be compiled before any
// package that imports it — and the seeder and integration-tests packages
// depend on most of the domain packages in turn. npm runs workspace lifecycle
// scripts in no dependency order, which is why a `prepare` hook that built on
// install failed on whichever dependant's tsc happened to start first (API
// Artifacts Sync run 35088746691 died on @durion-sdk/catalog that way). No
// package builds on install any more; this script is the one build, and it
// orders the packages itself from their manifests.
//
//   node scripts/build-workspaces.mjs            build, in order
//   node scripts/build-workspaces.mjs --dry-run  print the order, build nothing
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const SCOPE = '@durion-sdk/';

function loadPackages() {
  const packages = new Map();
  for (const dir of readdirSync(PACKAGES_DIR).sort()) {
    const file = join(PACKAGES_DIR, dir, 'package.json');
    if (!existsSync(file)) continue;
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    packages.set(manifest.name, { name: manifest.name, dir, manifest });
  }
  return packages;
}

function workspaceDeps(manifest, packages) {
  const declared = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  };
  return Object.keys(declared)
    .filter((name) => name.startsWith(SCOPE) && packages.has(name))
    .sort();
}

// Kahn's algorithm with alphabetical tie-breaking, so the order is stable
// between runs and readable in a log.
export function buildOrder(packages) {
  const remaining = new Map();
  for (const [name, pkg] of packages) {
    remaining.set(name, new Set(workspaceDeps(pkg.manifest, packages)));
  }
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, deps]) => deps.size === 0)
      .map(([name]) => name)
      .sort();
    if (ready.length === 0) {
      const cycle = [...remaining.keys()].sort().join(', ');
      throw new Error(`workspace dependency cycle among: ${cycle}`);
    }
    for (const name of ready) {
      order.push(name);
      remaining.delete(name);
      for (const deps of remaining.values()) deps.delete(name);
    }
  }
  return order;
}

function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const packages = loadPackages();
  const order = buildOrder(packages);
  if (dryRun) {
    for (const name of order) console.log(name);
    return 0;
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  for (const name of order) {
    if (!packages.get(name).manifest.scripts?.build) continue;
    console.log(`\n> ${name}`);
    const result = spawnSync(npm, ['run', 'build', '-w', name], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      console.error(`\nbuild failed in ${name}`);
      return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
