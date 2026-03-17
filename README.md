# durion-positivity-sdk

Durion Positivity Backend SDK — TypeScript client library for Durion backend APIs.

## Overview

This SDK provides strongly typed clients generated from the Durion backend OpenAPI contracts.
It targets Angular-first but remains framework-agnostic across the JavaScript ecosystem.

## Setup

```bash
npm install
```

## Available Scripts

| Script | Command | Description |
| ------ | ------- | ----------- |
| `build` | `npm run build` | Compile TypeScript sources |
| `test` | `npm test` | Run tests with Jest |
| `lint` | `npm run lint` | Lint TypeScript with ESLint |
| `generate` | `npm run generate` | Run OpenAPI generation pipeline |

## Phase Status

- **Phase 1 (in progress)**: Package structure, generation pipeline, shared transport, and initial generated clients (security, order, inventory, workorder, accounting)
- **Phase 2**: Remaining public module clients, error model, correlation support, idempotency helpers
- **Phase 3**: Workflow helpers, internal profile, contract-diff and release automation

## Key Directories

| Directory | Purpose |
| --------- | ------- |
| `packages/` | Monorepo workspace packages (one per SDK module) |
| `scripts/` | Build and generation scripts |
| `src/` | Shared source and test utilities |
