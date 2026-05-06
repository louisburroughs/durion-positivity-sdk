# Agent Registry

This repository uses `.github/agents/*.agent.md` files to define automation-ready agents and subagents.

## Global Rules

- All subagents in this repository are automation-facing unless explicitly marked otherwise.
- Parent orchestrators must respect documented wave ordering and dependency constraints.
- Agents must read `sdk-seeder-plan.json` before acting on the sdk-seeder workstream.
- Agents must use Spongebot MCP to validate standards and best practices before finalizing output.

## Agents

### AgentCreator

- File: `.github/agents/agent-creator.agent.md`
- Role: Creates or modifies agent definition files inside `.github`.
- Invocation: User-invokable only when the task is strictly limited to agent-definition work in `.github`.

### SeederScaffold

- File: `.github/agents/seeder-scaffold.agent.md`
- Role: Wave 1 sdk-seeder subagent that scaffolds `packages/sdk-seeder` and its shared TypeScript infrastructure.
- Invocation: Parent orchestrator only. Must run before all Wave 2 sdk-seeder agents.
- Dependencies: `sdk-seeder-plan.json`, root `package.json`, `packages/sdk-transport/src/`, `packages/sdk-security/src/`.

### SeederBootstrap

- File: `.github/agents/seeder-bootstrap.agent.md`
- Role: Wave 2 sdk-seeder subagent that implements idempotent location, people, catalog, and inventory bootstrap flows.
- Invocation: Parent orchestrator only after `SeederScaffold` completes.
- Dependencies: `sdk-seeder-plan.json`, `packages/sdk-seeder/src/support/ReferenceCache.ts`, `packages/sdk-location/src/`, `packages/sdk-people/src/`, `packages/sdk-catalog/src/`, `packages/sdk-inventory/src/`.

### SeederDailyLoop

- File: `.github/agents/seeder-daily-loop.agent.md`
- Role: Wave 2 sdk-seeder subagent that implements the daily loop, customer-event simulation, shift simulation, and inventory maintenance.
- Invocation: Parent orchestrator only after `SeederScaffold` completes.
- Dependencies: `sdk-seeder-plan.json`, scaffold outputs, `packages/sdk-workorder/src/`, `packages/sdk-customer/src/`, `packages/sdk-invoice/src/`, `packages/sdk-inventory/src/`, `packages/sdk-people/src/`.

### SeederBackendChanges

- File: `.github/agents/seeder-backend-changes.agent.md`
- Role: Wave 2 sdk-seeder subagent that applies the accelerated-profile backend scheduler and configuration changes in `C:/POS/durion-positivity-backend`.
- Invocation: Parent orchestrator only. Independent from scaffold output, but still bound to `sdk-seeder-plan.json`.
- Dependencies: `sdk-seeder-plan.json`, backend repository search results, located `ApprovalExpirationJob.java`, located `OutboxProcessor.java`.

## Suggested Supplementary Files

- `.github/instructions/sdk-seeder-implementation.instructions.md`
- `.github/prompts/sdk-seeder-wave-orchestration.prompt.md`
- `.github/skills/sdk-seeder-bootstrap.skill.md`
- `.github/skills/sdk-seeder-simulation.skill.md`
- `.github/instructions/sdk-client-source-verification.instructions.md`
- `.github/instructions/backend-accelerated-profile-changes.instructions.md`
- `.github/prompts/sdk-seeder-backend-verification.prompt.md`
- `.github/prompts/sdk-seeder-daily-loop-validation.prompt.md`
