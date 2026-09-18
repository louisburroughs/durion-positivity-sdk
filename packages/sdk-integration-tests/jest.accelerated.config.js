const path = require('path');

/**
 * Accelerated run config — requires a backend on the `accelerated` profile, with
 * its clock anchored a year in the past (see
 * BACKEND_INTERACTION_TEST_SPEC_ACCELERATED.md and README, "Accelerated year run").
 *
 * Deliberately separate from jest.integration.config.js, and mutually exclusive
 * with it: this entry point's global setup *requires* GET /system/time to answer
 * 200, while the integration one aborts when it does. A normal interaction test
 * that measures real elapsed time is meaningless while the clock moves a
 * thousandfold.
 *
 * Only *.accel.itest.ts runs here, serially: the suites share one backend, the
 * workexec timer API is scoped to the calling user, and the year run holds the
 * shop's resources for its whole duration.
 *
 * @type {import('jest').Config}
 */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: path.join(__dirname, '..', '..'),
  roots: ['<rootDir>/packages/sdk-integration-tests/src'],
  testMatch: ['**/*.accel.itest.ts'],
  maxWorkers: 1,
  // The parity suites need minutes; the year run overrides this per test with
  // ITEST_ACCEL_RUN_BUDGET_MS, because a whole virtual year is 1-6 hours.
  testTimeout: 600_000,
  // Unlike the integration config, an empty run is a failure here: an accelerated
  // run that collected nothing has burned a deployment window for nothing.
  passWithNoTests: false,
  globalSetup: '<rootDir>/packages/sdk-integration-tests/src/harness/acceleratedGlobalSetup.ts',
  // Committed build artifacts (.js/.d.ts) still sit beside the .ts sources in
  // packages/*/src, and Jest's default moduleFileExtensions puts 'js' first, so a
  // stale .js shadows its current .ts twin. Resolve TypeScript first.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^@durion-sdk/seeder$': '<rootDir>/packages/sdk-seeder/src/lib.ts',
    '^@durion-sdk/(.+)$': '<rootDir>/packages/sdk-$1/src/index.ts',
  },
};

module.exports = config;
