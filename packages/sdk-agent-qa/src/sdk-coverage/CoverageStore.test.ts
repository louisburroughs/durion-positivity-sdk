import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildCatalog } from '../catalog/buildCatalog';
import type { Risk } from '../catalog/types';
import type { CallRecord } from '../ledger/CallLedger';
import { CoverageStore, sweepQuota, type SweepOptions } from './CoverageStore';

const catalog = buildCatalog();
const reachable = (pkg: string): boolean => pkg !== 'internal' && pkg !== 'documents';

const call = (operationId: string, overrides: Partial<CallRecord> = {}): CallRecord => ({
  at: '2026-03-10T15:00:00Z',
  runId: 'r',
  scenarioId: 's',
  operationId,
  pkg: operationId.split('.')[0],
  persona: 'admin',
  kind: 'success',
  status: 200,
  httpMethod: 'GET',
  durationMs: 1,
  source: 'agent',
  ...overrides,
});

const sweep = (overrides: Partial<SweepOptions> = {}): SweepOptions => ({
  level: 'package',
  quota: 100,
  allowed: new Set<Risk>(['read']),
  isReachable: reachable,
  isDenied: () => false,
  ...overrides,
});

describe('CoverageStore', () => {
  it('counts a call the backend answered, whatever the status, and nothing else', () => {
    const store = CoverageStore.inMemory('2026-03');
    store.record(call('order.SalesOrdersApi.getOrder', { kind: 'http-error', status: 404 }));
    store.record(call('order.SalesOrdersApi.listCarts', { kind: 'transport-error', status: undefined }));
    store.record(call('order.SalesOrdersApi.createCart', { kind: 'client-error', status: undefined }));
    expect(store.isCalled('order.SalesOrdersApi.getOrder')).toBe(true);
    expect(store.isCalled('order.SalesOrdersApi.listCarts')).toBe(false);
    expect(store.isCalled('order.SalesOrdersApi.createCart')).toBe(false);
  });

  it('ignores calls from another month', () => {
    const store = CoverageStore.inMemory('2026-03');
    store.record(call('order.SalesOrdersApi.getOrder', { at: '2026-04-01T00:00:01Z' }));
    expect(store.isCalled('order.SalesOrdersApi.getOrder')).toBe(false);
  });

  it('starts a fresh document each month and reloads the current one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qa-coverage-'));
    const march = CoverageStore.open(dir, new Date('2026-03-10T15:00:00Z'));
    march.record(call('order.SalesOrdersApi.getOrder'));
    march.save();
    expect(CoverageStore.open(dir, new Date('2026-03-28T15:00:00Z')).isCalled('order.SalesOrdersApi.getOrder')).toBe(true);
    expect(CoverageStore.open(dir, new Date('2026-04-01T15:00:00Z')).isCalled('order.SalesOrdersApi.getOrder')).toBe(false);
    expect(fs.readdirSync(dir)).toEqual(['coverage-2026-03.json']);
  });

  it('summarizes by package, leaving unroutable packages out of the target', () => {
    const store = CoverageStore.inMemory('2026-03');
    store.record(call('order.SalesOrdersApi.getOrder'));
    store.record(call('order.RegisterSessionsApi.getSessionPolicy'));
    const summary = store.summary(catalog, 'package', reachable);
    expect(summary.unitsTotal).toBe(catalog.packages.length - 2);
    expect(summary.unitsCalled).toBe(1);
    expect(summary.missing).not.toContain('order');
    expect(summary.missing).not.toContain('internal');
    expect(summary.packages.find((entry) => entry.pkg === 'order')).toMatchObject({ operationsCalled: 2, apisCalled: 2, reachable: true });
    expect(summary.packages.find((entry) => entry.pkg === 'internal')).toMatchObject({ reachable: false });
    expect(store.summary(catalog, 'method', reachable).unitsCalled).toBe(2);
  });
});

describe('sweepTargets', () => {
  it('proposes one cheap read per uncovered package', () => {
    const store = CoverageStore.inMemory('2026-03');
    store.record(call('order.SalesOrdersApi.getOrder'));
    const targets = store.sweepTargets(catalog, sweep());
    expect(targets.map((operation) => operation.pkg).sort()).toEqual(
      catalog.packages.filter((pkg) => reachable(pkg) && pkg !== 'order').sort(),
    );
    expect(targets.every((operation) => operation.risk === 'read')).toBe(true);
  });

  it('spreads a small quota across packages, untouched packages first', () => {
    const store = CoverageStore.inMemory('2026-03');
    store.record(call('accounting.GLAccountsApi.listGLAccounts'));
    const targets = store.sweepTargets(catalog, sweep({ level: 'api', quota: 12 }));
    expect(targets).toHaveLength(12);
    expect(new Set(targets.map((operation) => operation.pkg)).size).toBe(12);
    expect(targets.map((operation) => operation.pkg)).not.toContain('accounting');
  });

  it('never proposes a denied, unreachable or disallowed-risk operation, or one already called', () => {
    const store = CoverageStore.inMemory('2026-03');
    store.record(call('location.LocationAPIApi.listLocations'));
    const targets = store.sweepTargets(
      catalog,
      sweep({ level: 'method', quota: 5000, allowed: new Set<Risk>(['read', 'write']), isDenied: (operation) => operation.pkg === 'security' }),
    );
    expect(targets.some((operation) => operation.risk === 'destructive')).toBe(false);
    expect(targets.some((operation) => operation.pkg === 'security' || operation.pkg === 'internal')).toBe(false);
    expect(targets.map((operation) => operation.id)).not.toContain('location.LocationAPIApi.listLocations');
    expect(targets.some((operation) => operation.risk === 'write')).toBe(true);
  });

  it('is empty once the month is covered', () => {
    const store = CoverageStore.inMemory('2026-03');
    for (const operation of store.sweepTargets(catalog, sweep())) {
      store.record(call(operation.id));
    }
    expect(store.sweepTargets(catalog, sweep())).toEqual([]);
    expect(store.summary(catalog, 'package', reachable).missing).toEqual([]);
  });
});

describe('sweepQuota', () => {
  it('spreads what is left over the days that are left, capped per day', () => {
    expect(sweepQuota(0, 10, 20)).toBe(0);
    expect(sweepQuota(23, 26, 20)).toBe(1);
    expect(sweepQuota(260, 26, 20)).toBe(10);
    expect(sweepQuota(1300, 26, 20)).toBe(20);
    expect(sweepQuota(7, 0, 20)).toBe(7);
  });
});
