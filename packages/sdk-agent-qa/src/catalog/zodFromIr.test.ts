import type { SchemaIR } from './types';
import { formatIssues, hydrate, zodFromIr } from './zodFromIr';

const ir: SchemaIR = {
  kind: 'object',
  required: ['id', 'when'],
  properties: {
    id: { kind: 'string' },
    when: { kind: 'date' },
    reason: { kind: 'enum', values: ['A', 'B'] },
    lines: { kind: 'array', items: { kind: 'object', required: ['at'], properties: { at: { kind: 'date' }, qty: { kind: 'number' } } } },
    tags: { kind: 'record', values: { kind: 'string' } },
    file: { kind: 'blob' },
    note: { kind: 'nullable', inner: { kind: 'string' } },
    extra: { kind: 'any' },
  },
};

describe('zodFromIr', () => {
  const schema = zodFromIr(ir);

  it('accepts a well-formed input', () => {
    expect(schema.safeParse({ id: 'x', when: '2026-01-05T10:00:00Z', reason: 'A', lines: [{ at: '2026-01-05' }], note: null }).success).toBe(true);
  });

  it('names each problem by path: missing, wrong type, bad enum, bad date, unknown key', () => {
    const result = schema.safeParse({ when: 'yesterday', reason: 'C', lines: [{ at: '2026-01-05', qty: '2' }], typo: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = formatIssues(result.error).join('\n');
      expect(issues).toMatch(/^id: /m);
      expect(issues).toMatch(/^when: must be an ISO-8601/m);
      expect(issues).toMatch(/^reason: /m);
      expect(issues).toMatch(/^lines\.0\.qty: /m);
      expect(issues).toMatch(/typo/);
    }
  });
});

describe('hydrate', () => {
  it('turns ISO strings into Dates and upload descriptors into Blobs, at any depth', async () => {
    const value = hydrate(ir, {
      id: 'x',
      when: '2026-01-05T10:00:00Z',
      lines: [{ at: '2026-02-01', qty: 2 }],
      tags: { a: 'b' },
      file: { text: 'sku,qty\nA,1', contentType: 'text/csv' },
      note: null,
      extra: { when: '2026-01-05' },
    }) as Record<string, any>;
    expect(value['when']).toEqual(new Date('2026-01-05T10:00:00Z'));
    expect(value['lines'][0].at).toBeInstanceOf(Date);
    expect(value['lines'][0].qty).toBe(2);
    expect(value['file']).toBeInstanceOf(Blob);
    expect(value['file'].type).toBe('text/csv');
    expect(await value['file'].text()).toBe('sku,qty\nA,1');
    expect(value['note']).toBeNull();
    // Untyped values pass through untouched: nothing says that string is a date.
    expect(value['extra']).toEqual({ when: '2026-01-05' });
  });
});
