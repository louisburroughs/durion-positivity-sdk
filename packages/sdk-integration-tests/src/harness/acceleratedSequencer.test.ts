// eslint-disable-next-line @typescript-eslint/no-var-requires
const AcceleratedSequencer = require('../../jest.accelerated.sequencer.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Sequencer = require('@jest/test-sequencer').default;

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
    'e-cycle-count.accel.itest.ts': 9_000,
    'b-estimates.accel.itest.ts': 6_000,
    'a-appointments.accel.itest.ts': 4_000,
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

  const names = (sorted: ReturnType<typeof test>[]): string[] =>
    sorted.map((entry) => entry.path.split('/').pop() as string);

  // Each takes its own copy: `sort` mutates, so a shared array would let the
  // reference run pre-sort the input for the run under test.
  const order = (tests: ReturnType<typeof test>[]): string[] =>
    names(new AcceleratedSequencer().sort([...tests]) as ReturnType<typeof test>[]);

  const jestOrder = (tests: ReturnType<typeof test>[]): string[] =>
    names(new Sequencer().sort([...tests]) as ReturnType<typeof test>[]);

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

  it('leaves the parity suites in the order jest would have chosen', () => {
    // Compared against the stock sequencer rather than a hardcoded list: the
    // contract is that only the year is special-cased, so whatever jest's own
    // heuristic decides for the rest is what this must reproduce. Asserting a
    // fixed order here would instead pin jest's current heuristic.
    // Deliberately not in sorted order already: fed the order jest would itself
    // produce, a sequencer that never called super.sort would pass this.
    const selection = [
      test('a-appointments.accel.itest.ts'),
      test('e-cycle-count.accel.itest.ts'),
      test('b-estimates.accel.itest.ts'),
    ];
    const expected = jestOrder(selection);

    expect(order(selection)).toEqual(expected);
    expect(expected).toHaveLength(3);
  });

  it('leaves the parity suites ordered among themselves with the year present', () => {
    const withYear = order([
      test('a-appointments.accel.itest.ts'),
      test('z-year-volume.accel.itest.ts'),
      test('e-cycle-count.accel.itest.ts'),
      test('b-estimates.accel.itest.ts'),
    ]);
    const withoutYear = order([
      test('a-appointments.accel.itest.ts'),
      test('e-cycle-count.accel.itest.ts'),
      test('b-estimates.accel.itest.ts'),
    ]);

    // Pulling the year out must not disturb anything else.
    expect(withYear).toEqual([...withoutYear, 'z-year-volume.accel.itest.ts']);
  });
});
