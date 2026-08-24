module.exports = {
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  root: true,
  // This file is CommonJS config, not source.
  env: { node: true, es2022: true },
  // Build output is not source. Without this ESLint walked packages/*/dist and
  // coverage/ - both git-ignored, so a clean checkout never sees them - and
  // reported thousands of errors from compiled JavaScript, which drowned the
  // handful in code anyone can actually fix.
  //
  // Generated clients are deliberately NOT listed: every generated file already
  // opens with its own `/* eslint-disable */`, so it is suppressed at source and
  // stays visible here the day the generator stops emitting that header.
  ignorePatterns: ['node_modules/', 'dist/', 'coverage/', '**/*.js.map'],
  overrides: [
    {
      // Mock API instances are cast through `any` on purpose: the tests assert
      // delegation, and building a structurally complete generated client for
      // each would test the mock rather than the workflow.
      files: ['src/__tests__/**/*.test.ts', '**/*.test.ts'],
      rules: { '@typescript-eslint/no-explicit-any': 'off' },
    },
  ],
};
