import { deserializeContext, serializeContext, type ItestContext } from './ItestContext';

describe('ItestContext serialization', () => {
  it('round-trips the ReferenceCache including its Maps', () => {
    const context: ItestContext = {
      runId: 'itest-1755000000-ab12',
      mode: 'role',
      referenceCache: {
        locationId: 'loc-1',
        bayIds: ['bay-1', 'bay-2'],
        employees: {
          technicians: ['t-1', 't-2'],
          serviceWriters: ['w-1'],
          manager: 'm-1',
          partsClerk: 'p-1',
        },
        serviceEntityIds: ['svc-1'],
        productEntityIds: ['prod-1'],
        serviceNameById: new Map([['svc-1', 'Oil Change']]),
        productNameById: new Map([['prod-1', 'Oil Filter']]),
        employeeNameById: new Map([
          ['t-1', 'Tech One'],
          ['m-1', 'Manager One'],
        ]),
      },
    };

    const restored = deserializeContext(serializeContext(context));

    expect(restored.runId).toBe(context.runId);
    expect(restored.mode).toBe('role');
    expect(restored.referenceCache.bayIds).toEqual(['bay-1', 'bay-2']);
    expect(restored.referenceCache.serviceNameById).toBeInstanceOf(Map);
    expect(restored.referenceCache.serviceNameById.get('svc-1')).toBe('Oil Change');
    expect(restored.referenceCache.productNameById.get('prod-1')).toBe('Oil Filter');
    expect(restored.referenceCache.employeeNameById.get('m-1')).toBe('Manager One');
    expect(restored.referenceCache.employees.partsClerk).toBe('p-1');
  });
});
