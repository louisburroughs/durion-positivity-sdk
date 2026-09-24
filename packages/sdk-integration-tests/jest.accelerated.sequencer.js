const Sequencer = require('@jest/test-sequencer').default;

/**
 * Runs the parity suites first and the year last.
 *
 * The year drives the accelerated clock to convergence — that is its whole
 * purpose — and a converged backend is no longer an accelerated one. Anything
 * scheduled after it therefore fails its clock check, whatever the code does.
 *
 * Jest's default sequencer orders by recorded duration, slowest first, so as
 * soon as a timing cache exists the year goes first and takes the clock with
 * it. One run put `z-year-volume` at the head for 5.6 hours and every other
 * suite behind it failed on `not a usable accelerated clock` — 105 of 113
 * tests, including 00-harness, which asserts nothing but the clock.
 *
 * So the order is stated here rather than inferred from timings: the parity
 * suites get a live clock, and the year takes what is left.
 */
class AcceleratedSequencer extends Sequencer {
  /** The year, by file name, wherever it sits in the tree. */
  static isYear(test) {
    return /z-year-volume\.accel\.itest\.ts$/.test(test.path);
  }

  sort(tests) {
    const parity = tests.filter((test) => !AcceleratedSequencer.isYear(test));
    const year = tests.filter((test) => AcceleratedSequencer.isYear(test));
    // Parity suites keep the default ordering among themselves; only the year
    // is pinned, and pinned last.
    return [...super.sort(parity), ...year];
  }
}

module.exports = AcceleratedSequencer;
