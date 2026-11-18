import { compactResult, shrink } from './shrink';

describe('shrink', () => {
  it('leaves a small value alone', () => {
    expect(shrink({ id: 'a', total: 12.5 }, 4000)).toEqual({ id: 'a', total: 12.5 });
  });

  it('cuts long lists and says how many there were', () => {
    const rows = Array.from({ length: 250 }, (_, index) => ({ id: index, name: `row ${index}` }));
    const result = shrink(rows, 4000) as unknown[];
    expect(result.length).toBeLessThanOrEqual(11);
    expect(result[result.length - 1]).toMatch(/250 total/);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(4000);
  });

  it('always returns valid JSON within the budget, however large the input', () => {
    const huge = { items: Array.from({ length: 50 }, () => ({ text: 'x'.repeat(5000), nested: { deep: { deeper: ['y'.repeat(5000)] } } })) };
    const result = shrink(huge, 500);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(500);
    expect(() => JSON.parse(JSON.stringify(result))).not.toThrow();
  });

  it('survives a date the generated model could not parse', () => {
    expect(shrink({ startDate: new Date('not a date'), nested: [{ at: new Date(Number.NaN) }], ok: 1 }, 200)).toEqual({
      startDate: null,
      nested: [{ at: null }],
      ok: 1,
    });
  });

  it('serializes dates', () => {
    expect(shrink({ at: new Date('2026-01-05T00:00:00Z') }, 100)).toEqual({ at: '2026-01-05T00:00:00.000Z' });
  });
});

describe('compactResult', () => {
  const DETAIL = {
    outcome: 'success',
    status: 200,
    correlationId: 'trace-1',
    body: {
      workorderId: 'wo-1',
      workorderNumber: 'WO-7',
      status: 'WORK_IN_PROGRESS',
      estimatedTotal: 312.5,
      capabilities: { canStart: true, canRecordLabor: false },
      services: ['sv-1', 'sv-2', 'sv-3'].map((id) => ({ id, serviceEntityId: `svc-${id}`, status: 'OPEN', lineTotal: 75, quantity: 0.6, unitPrice: 125 })),
      parts: [{ id: 'pt-1', productEntityId: 'prod-1', description: 'Oil filter '.repeat(40), quantity: 1, status: 'OPEN' }],
    },
  };

  it('keeps every line id and status, and drops the bulk and the trace id', () => {
    expect(compactResult(DETAIL, 1200)).toEqual({
      outcome: 'success',
      status: 200,
      body: {
        workorderId: 'wo-1',
        workorderNumber: 'WO-7',
        status: 'WORK_IN_PROGRESS',
        services: ['sv-1', 'sv-2', 'sv-3'].map((id) => ({ id, serviceEntityId: `svc-${id}`, status: 'OPEN' })),
        parts: [{ id: 'pt-1', productEntityId: 'prod-1', status: 'OPEN' }],
      },
    });
  });

  it('keeps id lists and page tokens, and stays within budget on a long list', () => {
    expect(compactResult({ body: { skuIds: ['a', 'b'], nextPageToken: 't', total: 2 } }, 1200)).toEqual({ body: { skuIds: ['a', 'b'], nextPageToken: 't' } });
    const long = { body: { items: Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}`, note: 'x' })) } };
    expect(JSON.stringify(compactResult(long, 1200)).length).toBeLessThanOrEqual(1200);
  });

  it('falls back to the shrunk result when nothing in it is an identity field', () => {
    expect(compactResult({ body: { lines: [{ qty: 1 }] } }, 1200)).toEqual({ body: { lines: [{ qty: 1 }] } });
    expect(compactResult('plain text', 1200)).toBe('plain text');
  });
});
