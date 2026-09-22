/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  // ts-jest warns TS151002 on every run: a Node16/NodeNext module kind is only
  // "supported" with isolatedModules, which the root tsconfig does not set.
  //
  // Setting it is the fix the message asks for, and it breaks these tests.
  // Without isolatedModules, ts-jest downlevels `await import('@durion-sdk/...')`
  // to a require; with it, the dynamic import survives into Jest's CommonJS
  // environment, where it fails — and sdk-003/sdk-004 swallow that failure and
  // report the module as missing. 66 tests turn red for a warning.
  //
  // So the code is ignored, which is the other remedy the message itself names.
  // Revisit when the suites can load the transport package without a dynamic
  // import, or when Jest runs them as ESM.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: { ignoreCodes: [151002] } }],
  },
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  // Integration tests (*.itest.ts) need a live backend and run only through
  // packages/sdk-integration-tests/jest.integration.config.js.
  testPathIgnorePatterns: ['/node_modules/', '\\.itest\\.ts$'],
  coverageProvider: 'v8',
  // Committed build artifacts (.js/.d.ts) still sit beside the .ts sources in
  // packages/*/src. Jest's default moduleFileExtensions puts 'js' first, so a
  // stale .js shadows its current .ts twin (e.g. an April apis/index.js that
  // predates LocationBulkIngestAPIApi). Resolve TypeScript first.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    // The seeder's index.ts is an executable entrypoint (it starts a run on
    // import); its library surface is the lib.ts barrel. Must precede the
    // generic mapping below.
    '^@durion-sdk/seeder$': '<rootDir>/packages/sdk-seeder/src/lib.ts',
    '^@durion-sdk/(.+)$': '<rootDir>/packages/sdk-$1/src/index.ts',
  },
  passWithNoTests: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    'packages/sdk-transport/src/**/*.ts',
    'packages/sdk-*/src/index.ts',
    'packages/sdk-*/src/workflows/**/*.ts',
    '!**/__tests__/**',
    '!**/*.d.ts',
    '!packages/sdk-*/src/apis/**',
    '!packages/sdk-*/src/models/**',
    '!packages/sdk-*/src/runtime.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};

module.exports = config;