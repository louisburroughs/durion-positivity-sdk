/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  coverageProvider: 'v8',
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