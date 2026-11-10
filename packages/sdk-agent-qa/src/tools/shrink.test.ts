import { shrink } from './shrink';

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

  it('serializes dates', () => {
    expect(shrink({ at: new Date('2026-01-05T00:00:00Z') }, 100)).toEqual({ at: '2026-01-05T00:00:00.000Z' });
  });
});
