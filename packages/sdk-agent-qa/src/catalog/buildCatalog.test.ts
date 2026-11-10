import { z } from 'zod';
import { toolNameFor } from '../tools/toolkit';
import { buildCatalog } from './buildCatalog';
import { classifyRisk } from './risk';
import { zodFromIr } from './zodFromIr';

const catalog = buildCatalog();

describe('buildCatalog', () => {
  it('reads every generated API package in the workspace', () => {
    expect(catalog.operations.length).toBeGreaterThan(1000);
    expect(catalog.packages).toEqual(
      expect.arrayContaining(['accounting', 'inventory', 'order', 'workorder', 'security', 'shop-manager', 'tenant']),
    );
    // Hand-written and tooling packages have no apis/ directory and are not SDK surfaces.
    expect(catalog.packages).not.toEqual(expect.arrayContaining(['transport', 'seeder', 'integration-tests', 'agent-qa']));
  });

  it('gives every operation a unique id, an HTTP verb and a route', () => {
    expect(new Set(catalog.operations.map((operation) => operation.id)).size).toBe(catalog.operations.length);
    for (const operation of catalog.operations) {
      expect(operation.path).toMatch(/^\//);
      expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).toContain(operation.http);
      expect(operation.summary.length).toBeGreaterThan(0);
    }
  });

  it('never lists a Raw twin as an operation', () => {
    expect(catalog.operations.filter((operation) => operation.method.endsWith('Raw'))).toEqual([]);
  });

  it('resolves path, header and nested body parameters with their requiredness', () => {
    const operation = catalog.byId.get('order.RegisterSessionsApi.recordCashMovement');
    expect(operation).toMatchObject({ http: 'POST', path: '/v1/orders/sessions/{sessionId}/cash-movements', takesIdempotencyKey: true });
    expect(operation?.input.required).toEqual(['sessionId', 'idempotencyKey', 'cashMovementRequest']);
    const body = operation?.input.properties['cashMovementRequest'];
    expect(body).toMatchObject({ kind: 'object', required: expect.arrayContaining(['amount', 'currencyCode', 'reason']) });
    if (body?.kind === 'object') {
      expect(body.properties['reason']).toMatchObject({ kind: 'enum', values: expect.arrayContaining(['PETTY_EXPENSE', 'BANK_DROP']) });
      expect(body.properties['statedTaxes']).toMatchObject({ kind: 'array', items: { kind: 'object' } });
      expect(body.properties['amount'].description).toMatch(/cash amount/i);
    }
  });

  it('gives a method without request parameters an empty input', () => {
    expect(catalog.byId.get('location.LocationAPIApi.listLocations')?.input).toEqual({ kind: 'object', properties: {}, required: [] });
  });

  it('carries the backend description, with the summary split off', () => {
    const operation = catalog.byId.get('order.RegisterSessionsApi.beginSessionClose');
    expect(operation?.summary).toBe('Begin Closing a Register Session');
    expect(operation?.description).toMatch(/^Records the physically counted drawer cash/);
    expect(operation?.description).not.toContain("\\'");
  });

  it('builds a Zod validator and a JSON Schema for every operation', () => {
    for (const operation of catalog.operations) {
      const schema = zodFromIr(operation.input);
      const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'any' }) as { type?: string };
      expect(json.type).toBe('object');
    }
  });

  it('produces tool names every provider accepts', () => {
    for (const operation of catalog.operations) {
      expect(toolNameFor(operation)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    }
  });
});

describe('classifyRisk', () => {
  const riskOf = (id: string): string | undefined => catalog.byId.get(id)?.risk;

  it('treats GETs and compute-only POSTs as reads', () => {
    expect(riskOf('order.SalesOrdersApi.getOrder')).toBe('read');
    expect(classifyRisk({ pkg: 'customer', method: 'checkPartyDuplicates', http: 'POST', path: '/v1/crm/accounts/parties/duplicate-check' })).toBe('read');
  });

  it('treats ordinary mutations as writes', () => {
    expect(riskOf('order.SalesOrdersApi.createCart')).toBe('write');
    expect(riskOf('workorder.EstimateAPIApi.approveEstimate')).toBe('write');
  });

  it('marks deletions, lockouts, bulk ingest, the tenant registry and book-locking as destructive', () => {
    for (const id of [
      'customer.CustomerAPIApi.deleteCustomer',
      'security.AdminAccountStateAPIApi.disableUserAccount',
      'customer.CustomerBulkIngestAPIApi.bulkIngestCustomers',
      'tenant.PlatformTenantAPIApi.suspendTenant',
      'tenant.PlatformTenantAPIApi.createTenant',
      'bulk-loader.BulkLoadJobsAPIApi.createBulkLoadJob',
      'security.AuthAPIApi.registerTenant',
      'security.AuthAPIApi.requestPasswordReset',
      'accounting.AccountingPeriodsApi.closeAccountingPeriod',
      'marketing.MarketingCampaignsApi.dispatchCampaign',
      'security.PlatformSupportAPIApi.mintImpersonationToken',
    ]) {
      expect([id, riskOf(id)]).toEqual([id, 'destructive']);
    }
  });
});
