/**
 * Workspace build order.
 *
 * Every domain package imports @durion-sdk/transport, and a package's types
 * resolve through its dist/index.d.ts, so transport must be compiled before any
 * package that imports it. npm runs workspace lifecycle scripts in no dependency
 * order, so a `prepare` hook that built on install failed on whichever
 * dependent's tsc started first — API Artifacts Sync run 35088746691 died on
 * @durion-sdk/catalog with TS2307 that way, and the seeder Dockerfile had been
 * carrying a private workaround for the same thing. The rules these tests pin:
 * no package builds on install, and the one build orders itself.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PACKAGES_DIR = path.join(REPO_ROOT, 'packages');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-workspaces.mjs');

interface Manifest {
  name: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function manifests(): Manifest[] {
  return fs
    .readdirSync(PACKAGES_DIR)
    .map((dir) => path.join(PACKAGES_DIR, dir, 'package.json'))
    .filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf-8')) as Manifest);
}

function workspaceDeps(manifest: Manifest, names: Set<string>): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.peerDependencies,
    ...manifest.optionalDependencies,
  }).filter((name) => names.has(name));
}

describe('workspace build order', () => {
  const all = manifests();
  const names = new Set(all.map((m) => m.name));

  it('no package compiles on install', () => {
    const offenders = all.filter((m) => m.scripts?.prepare !== undefined).map((m) => m.name);
    expect(offenders).toEqual([]);
  });

  it('the root build is the ordered workspace build', () => {
    const root = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as Manifest;
    expect(root.scripts?.build).toBe('node scripts/build-workspaces.mjs');
  });

  describe('the build order', () => {
    const order = execFileSync(process.execPath, [BUILD_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
    })
      .trim()
      .split('\n');

    it('lists every workspace package exactly once', () => {
      expect([...order].sort()).toEqual([...names].sort());
    });

    it('places every package after each package it depends on', () => {
      const position = new Map(order.map((name, i) => [name, i]));
      const violations: string[] = [];
      for (const m of all) {
        for (const dep of workspaceDeps(m, names)) {
          if ((position.get(dep) ?? -1) > (position.get(m.name) ?? -1)) {
            violations.push(`${m.name} before ${dep}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });
  });
});
