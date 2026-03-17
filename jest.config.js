/** @type {import('jest').Config} */
const config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@durion-sdk/(.+)$': '<rootDir>/packages/sdk-$1/src/index.ts',
  },
  passWithNoTests: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    'packages/sdk-transport/src/**/*.ts',
    'packages/sdk-*/src/index.ts',
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