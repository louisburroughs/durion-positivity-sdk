/**
 * Which SDK operations have been called this calendar month.
 *
 * The harness's standing promise is that every SDK is called at least once a
 * month. This file is where that promise is kept honest: one JSON document per
 * month, updated from the call ledger, read by the planner to decide what the
 * coverage sweep must still reach and by the report to say what is left.
 *
 * "Called" means a backend answered (any status). An error response is still
 * the SDK method doing its whole job; a call that never left the machine is
 * not.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { Catalog, Operation, Risk } from '../catalog/types';
import { reachedBackend, type CallRecord } from '../ledger/CallLedger';

/** The unit the monthly promise is measured in. */
export type CoverageLevel = 'package' | 'api' | 'method';

interface OperationCoverage {
  first: string;
  last: string;
  count: number;
  /** HTTP status → number of responses seen. */
  statuses: Record<string, number>;
}

interface CoverageFile {
  month: string;
  operations: Record<string, OperationCoverage>;
}

export interface PackageCoverage {
  pkg: string;
  reachable: boolean;
  operations: number;
  operationsCalled: number;
  apis: number;
  apisCalled: number;
}

export interface CoverageSummary {
  month: string;
  level: CoverageLevel;
  packages: PackageCoverage[];
  /** Units (at `level`) that exist, counting only reachable packages. */
  unitsTotal: number;
  unitsCalled: number;
  /** Units not yet called this month, as display names. */
  missing: string[];
}

export interface SweepOptions {
  level: CoverageLevel;
  /** At most this many operations. */
  quota: number;
  /** Risk classes the sweep may propose. */
  allowed: ReadonlySet<Risk>;
  isReachable(pkg: string): boolean;
  /** Operations never proposed, whatever else is true. */
  isDenied(operation: Operation): boolean;
}

export const monthOf = (date: Date): string => date.toISOString().slice(0, 7);

const RISK_ORDER: Record<Risk, number> = { read: 0, write: 1, destructive: 2 };

function unitOf(operation: Operation, level: CoverageLevel): string {
  if (level === 'package') {
    return operation.pkg;
  }
  return level === 'api' ? `${operation.pkg}.${operation.api}` : operation.id;
}

export class CoverageStore {
  private data: CoverageFile;

  private constructor(
    private readonly file: string | undefined,
    data: CoverageFile,
  ) {
    this.data = data;
  }

  static inMemory(month: string): CoverageStore {
    return new CoverageStore(undefined, { month, operations: {} });
  }

  /** Opens (or starts) the coverage document for the month containing `date`. */
  static open(stateDir: string, date: Date): CoverageStore {
    const month = monthOf(date);
    const file = path.join(stateDir, `coverage-${month}.json`);
    let data: CoverageFile = { month, operations: {} };
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<CoverageFile>;
      if (parsed.month === month && parsed.operations && typeof parsed.operations === 'object') {
        data = { month, operations: parsed.operations };
      }
    }
    return new CoverageStore(file, data);
  }

  get month(): string {
    return this.data.month;
  }

  record(call: CallRecord): void {
    if (!reachedBackend(call) || call.at.slice(0, 7) !== this.data.month) {
      return;
    }
    const entry = (this.data.operations[call.operationId] ??= { first: call.at, last: call.at, count: 0, statuses: {} });
    entry.last = call.at;
    entry.count += 1;
    const status = String(call.status ?? 0);
    entry.statuses[status] = (entry.statuses[status] ?? 0) + 1;
  }

  save(): void {
    if (!this.file) {
      return;
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
  }

  isCalled(operationId: string): boolean {
    return operationId in this.data.operations;
  }

  private calledUnits(catalog: Catalog, level: CoverageLevel): Set<string> {
    const units = new Set<string>();
    for (const id of Object.keys(this.data.operations)) {
      const operation = catalog.byId.get(id);
      if (operation) {
        units.add(unitOf(operation, level));
      }
    }
    return units;
  }

  summary(catalog: Catalog, level: CoverageLevel, isReachable: (pkg: string) => boolean): CoverageSummary {
    const called = this.calledUnits(catalog, level);
    const calledApis = this.calledUnits(catalog, 'api');
    const packages: PackageCoverage[] = catalog.packages.map((pkg) => {
      const operations = catalog.operations.filter((operation) => operation.pkg === pkg);
      const apis = new Set(operations.map((operation) => `${pkg}.${operation.api}`));
      return {
        pkg,
        reachable: isReachable(pkg),
        operations: operations.length,
        operationsCalled: operations.filter((operation) => this.isCalled(operation.id)).length,
        apis: apis.size,
        apisCalled: [...apis].filter((api) => calledApis.has(api)).length,
      };
    });
    const units = new Set(
      catalog.operations.filter((operation) => isReachable(operation.pkg)).map((operation) => unitOf(operation, level)),
    );
    const missing = [...units].filter((unit) => !called.has(unit)).sort();
    return { month: this.data.month, level, packages, unitsTotal: units.size, unitsCalled: units.size - missing.length, missing };
  }

  /**
   * The operations today's coverage sweep should try, most valuable first.
   *
   * One operation per uncovered unit, cheapest risk first, and spread across
   * packages round-robin so a small quota still touches many services instead
   * of draining one alphabetically.
   */
  sweepTargets(catalog: Catalog, options: SweepOptions): Operation[] {
    const called = this.calledUnits(catalog, options.level);
    const perUnit = new Map<string, Operation>();
    const candidates = catalog.operations
      .filter(
        (operation) =>
          options.isReachable(operation.pkg) &&
          options.allowed.has(operation.risk) &&
          !options.isDenied(operation) &&
          !this.isCalled(operation.id) &&
          !called.has(unitOf(operation, options.level)),
      )
      .sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || requiredCount(a) - requiredCount(b) || a.id.localeCompare(b.id));
    for (const operation of candidates) {
      const unit = unitOf(operation, options.level);
      if (!perUnit.has(unit)) {
        perUnit.set(unit, operation);
      }
    }

    const calledPackages = this.calledUnits(catalog, 'package');
    const byPackage = new Map<string, Operation[]>();
    for (const operation of perUnit.values()) {
      const list = byPackage.get(operation.pkg) ?? [];
      list.push(operation);
      byPackage.set(operation.pkg, list);
    }
    // Packages with nothing called at all go first.
    const order = [...byPackage.keys()].sort(
      (a, b) => Number(calledPackages.has(a)) - Number(calledPackages.has(b)) || a.localeCompare(b),
    );
    const picked: Operation[] = [];
    for (let round = 0; picked.length < options.quota; round += 1) {
      let added = false;
      for (const pkg of order) {
        const next = byPackage.get(pkg)?.[round];
        if (next && picked.length < options.quota) {
          picked.push(next);
          added = true;
        }
      }
      if (!added) {
        break;
      }
    }
    return picked;
  }
}

function requiredCount(operation: Operation): number {
  return operation.input.required.length;
}

/**
 * How many units today's sweep should aim for so the month finishes covered:
 * what is left, divided by the run days left (today included), never more than
 * `maxPerDay`.
 */
export function sweepQuota(remainingUnits: number, runDaysLeft: number, maxPerDay: number): number {
  if (remainingUnits <= 0) {
    return 0;
  }
  return Math.min(maxPerDay, Math.ceil(remainingUnits / Math.max(1, runDaysLeft)));
}
