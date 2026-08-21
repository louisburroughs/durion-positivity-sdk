const path = require('path');

/**
 * Integration run config — real backend required (see
 * BACKEND_INTERACTION_TEST_SPEC.md for the ITEST_* environment contract).
 * Deliberately separate from the root jest.config.js: only *.itest.ts files
 * run here, serially (suites share one backend and the workexec timer API is
 * per-user), with no coverage collection.
 *
 * @type {import('jest').Config}
 */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: path.join(__dirname, '..', '..'),
  roots: ['<rootDir>/packages/sdk-integration-tests/src'],
  testMatch: ['**/*.itest.ts'],
  maxWorkers: 1,
  testTimeout: 120000,
  // Suites arrive in Tasks 3-6; until then a run still executes globalSetup,
  // so the credential fail-fast is observable before any suite exists.
  passWithNoTests: true,
  globalSetup: '<rootDir>/packages/sdk-integration-tests/src/harness/globalSetup.ts',
  moduleNameMapper: {
    '^@durion-sdk/seeder$': '<rootDir>/packages/sdk-seeder/src/lib.ts',
    '^@durion-sdk/(.+)$': '<rootDir>/packages/sdk-$1/src/index.ts',
  },
};

module.exports = config;
