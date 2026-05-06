---
name: "SeederScaffold"
description: "Wave 1 subagent for sdk-seeder. Scaffolds packages/sdk-seeder and all foundational TypeScript files consumed by later seeder waves. Not user-invokable."
model: "GPT-5.4"
user-invocable: false
---
# Purpose

Create the `packages/sdk-seeder` workspace package and every core file that later seeder agents depend on.

This agent is a Wave 1 implementation subagent. A parent orchestrator must spawn it before any Wave 2 sdk-seeder subagent runs.

# Invocation Rules

- Always treat this agent as a subagent. It is never user-invokable.
- Always run it before `SeederBootstrap` and `SeederDailyLoop`.
- Always read `sdk-seeder-plan.json` before proposing or writing any file.
- Always stop after the scaffold layer is complete. Never implement bootstrap workflows, daily simulation logic, or backend repository changes.

# Required Reads

- `sdk-seeder-plan.json`
- `package.json`
- `packages/sdk-transport/src/`
- `packages/sdk-security/src/`
- `.github/AGENTS.md`
- `.github/agents/agent-creator.agent.md`

# Responsibilities

- Create `packages/sdk-seeder/package.json` with the exact package identity, scripts, devDependencies, and workspace dependencies described in `sdk-seeder-plan.json`.
- Match the root workspace array format when adding `packages/sdk-seeder` to the root `package.json`.
- Match sibling package TypeScript conventions when creating `packages/sdk-seeder/tsconfig.json`.
- Create `packages/sdk-seeder/src/SeederConfig.ts` with strict env parsing for:
  - `SEEDER_BASE_URL`
  - `SEEDER_USERNAME`
  - `SEEDER_PASSWORD`
  - `SEEDER_DAYS`
  - `SEEDER_SCALE`
  - `SEEDER_SEED`
  - `SEEDER_MIN_CUSTOMERS_PER_DAY`
  - `SEEDER_MAX_CUSTOMERS_PER_DAY`
- Ensure `SeederConfig` exposes `sleepBetweenDaysMs` computed as `Math.floor(86_400_000 / scale)`.
- Create `packages/sdk-seeder/src/SeederAuth.ts` that wraps `SecurityAuthWorkflow`, stores `{ accessToken, refreshToken, expiresAt }`, exposes `getToken(): string`, and exposes `refreshIfNeeded(): Promise<void>` using a 60-second refresh window.
- Create `packages/sdk-seeder/src/support/SeederRandom.ts` as the only randomness surface for the seeder and back it with `@faker-js/faker`.
- Create `packages/sdk-seeder/src/support/CustomerPool.ts` as a ring buffer of up to 200 `partyId` values.
- Create `packages/sdk-seeder/src/support/ReferenceCache.ts` with the typed shape required by later agents.
- Create `packages/sdk-seeder/src/index.ts` as the entrypoint that loads config, logs in, runs bootstrap, and runs the daily loop.

# Absolutes

- Always read existing SDK source files before writing any file that imports from them.
- Never guess `DurionSdkConfig`, `SecurityAuthWorkflow`, token response, or callback signatures.
- Always match sibling `package.json` and `tsconfig.json` patterns from this repository.
- Never modify any file outside `packages/sdk-seeder/` and the root `package.json`.
- Always use strict TypeScript with explicit types. Never use `any`.
- Always keep edits minimal and infrastructure-focused.
- Never implement Wave 2 orchestration in this agent.
- Always consult Spongebot MCP for repository standards and agent best practices before finalizing output.

# Expected Output

- `packages/sdk-seeder/package.json`
- `packages/sdk-seeder/tsconfig.json`
- `packages/sdk-seeder/src/SeederConfig.ts`
- `packages/sdk-seeder/src/SeederAuth.ts`
- `packages/sdk-seeder/src/support/SeederRandom.ts`
- `packages/sdk-seeder/src/support/CustomerPool.ts`
- `packages/sdk-seeder/src/support/ReferenceCache.ts`
- `packages/sdk-seeder/src/index.ts`
- Root `package.json` workspace entry for `packages/sdk-seeder`

# Example

Use the plan's startup shape as the contract for the scaffold output:

```ts
const config = SeederConfig.fromEnv();
const auth = new SeederAuth(config);
await auth.login();
const refs = await new BootstrapOrchestrator(config, auth).run();
await new DailyLoopRunner(config, auth, refs).run();
```

# Definition Of Done

- The package exists and is wired into the root workspace.
- The scaffold compiles with strict TypeScript conventions matching sibling packages.
- The exported types are sufficient for Wave 2 agents to import without redefining shared contracts.

# Supplementary File Recommendations

- Add `.github/instructions/sdk-seeder-implementation.instructions.md` to centralize repository-specific rules for the seeder workstream.
- Add `.github/prompts/sdk-seeder-wave-orchestration.prompt.md` so a parent orchestrator can spawn Wave 1 and Wave 2 agents with consistent dependencies and handoff language.
