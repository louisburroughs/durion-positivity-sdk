// eslint-disable-next-line @typescript-eslint/no-var-requires
const AcceleratedSequencer = require('../../jest.accelerated.sequencer.js');

/**
 * The ordering the accelerated run depends on. The year suite converges the
 * clock it runs on, so any suite scheduled after it meets a backend that is no
 * longer accelerated: one run put the year first, and 105 of 113 tests failed
 * on `not a usable accelerated clock`, 00-harness included.
 *
 * Jest's own sequencer orders by recorded duration, and failing that by file
 * size, largest first — which is precisely the wrong end for the year.
 */
describe('the accelerated test sequencer', () => {
  /** The year is the biggest suite on disk, so size alone would schedule it first. */
  const sizes: Record<string, number> = {
    'z-year-volume.accel.itest.ts': 48_000,
    'c-workorder-execution.accel.itest.ts': 12_000,
    '00-harness.accel.itest.ts': 3_000,
  };

  const context = {
    // No cache: with one absent, jest falls back to file size for ordering.
    config: { cache: false, cacheDirectory: '/tmp', id: 'accel' },
    hasteFS: { getSize: (path: string) => sizes[path.split('/').pop() as string] ?? 1_000 },
  };

  const test = (name: string) => ({
    path: `/repo/packages/sdk-integration-tests/src/suites-accelerated/${name}`,
    context,
  });

  const order = (tests: ReturnType<typeof test>[]): string[] =>
    (new AcceleratedSequencer().sort(tests) as ReturnType<typeof test>[]).map(
      (entry) => entry.path.split('/').pop() as string,
    );

  it('puts the year last however big it is', () => {
    const sorted = order([
      test('z-year-volume.accel.itest.ts'),
      test('00-harness.accel.itest.ts'),
      test('c-workorder-execution.accel.itest.ts'),
    ]);

    expect(sorted[sorted.length - 1]).toBe('z-year-volume.accel.itest.ts');
    expect(sorted).toHaveLength(3);
  });

  it('puts the year last wherever it arrives in the list', () => {
    const middle = order([
      test('a-appointments.accel.itest.ts'),
      test('z-year-volume.accel.itest.ts'),
      test('h-service-position.accel.itest.ts'),
    ]);

    expect(middle[middle.length - 1]).toBe('z-year-volume.accel.itest.ts');
  });

  it('loses no suite and reorders nothing when the year is not selected', () => {
    const sorted = order([
      test('b-estimates.accel.itest.ts'),
      test('e-cycle-count.accel.itest.ts'),
    ]);

    expect([...sorted].sort()).toEqual([
      'b-estimates.accel.itest.ts',
      'e-cycle-count.accel.itest.ts',
    ]);
  });
});
