#!/usr/bin/env node
// Post-generation fix for a typescript-fetch naming bug.
//
// When an operationId collides with a model name (setTimeOffBalance vs the
// SetTimeOffBalanceRequest DTO), the generator renames the operation's request
// interface to <Op>OperationRequest and its inline enum to <Op>Operation<Param>Enum,
// but still types the parameter field with the un-renamed <Op><Param>Enum, which
// it never declares. tsc then fails with TS2304. For every declared
// <Op>Operation<Param>Enum whose <Op><Param>Enum is referenced but not declared or
// imported, point the references at the declared enum.
//
// Usage: node scripts/fix-operation-enum-refs.mjs <module>
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const module = process.argv[2];
if (!module) {
  console.error('usage: fix-operation-enum-refs.mjs <module>');
  process.exit(2);
}
const apisDir = join('packages', `sdk-${module}`, 'src', 'apis');
if (!existsSync(apisDir)) process.exit(0);

for (const name of readdirSync(apisDir).filter((f) => f.endsWith('.ts'))) {
  const file = join(apisDir, name);
  let src = readFileSync(file, 'utf8');
  let changed = false;
  for (const [, op, param] of src.matchAll(/^export enum (\w+)Operation(\w+Enum) \{/gm)) {
    const declared = `${op}Operation${param}`;
    const dangling = `${op}${param}`;
    const ref = new RegExp(`\\b${dangling}\\b`, 'g');
    const isDeclared = new RegExp(`^export (enum|type|const|interface) ${dangling}\\b`, 'm').test(src);
    const isImported = new RegExp(`^\\s*${dangling},?\\s*$`, 'm').test(src);
    if (isDeclared || isImported || !ref.test(src)) continue;
    src = src.replace(ref, declared);
    changed = true;
    console.log(`[generate] ${file}: ${dangling} -> ${declared}`);
  }
  if (changed) writeFileSync(file, src);
}
