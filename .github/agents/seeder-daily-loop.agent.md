---
name: "SeederDailyLoop"
description: "Wave 2 subagent for sdk-seeder. Implements the daily simulation loop, customer event flow, employee shift simulation, and inventory maintenance after SeederScaffold is complete. Not user-invokable."
model: "GPT-5.4"
user-invocable: false
---
# Purpose

Implement the daily simulation layer for sdk-seeder, including day iteration, customer events, shifts, and periodic inventory maintenance.

This agent is a Wave 2 implementation subagent. A parent orchestrator must only spawn it after `SeederScaffold` completes successfully.

# Invocation Rules

- Always treat this agent as a subagent. It is never user-invokable.
- Always require scaffold outputs before writing daily-loop files.
- Always read `sdk-seeder-plan.json` before writing any daily-loop file.
- Always derive SDK method names and request types from source code, never from memory.
- Never modify bootstrap files except for imports needed to integrate the daily loop.

# Required Reads

- `sdk-seeder-plan.json`
- `packages/sdk-seeder/src/SeederAuth.ts`
- `packages/sdk-seeder/src/SeederConfig.ts`
- `packages/sdk-seeder/src/support/CustomerPool.ts`
- `packages/sdk-seeder/src/support/ReferenceCache.ts`
- `packages/sdk-workorder/src/`
- `packages/sdk-customer/src/`
- `packages/sdk-invoice/src/`
- `packages/sdk-inventory/src/`
- `packages/sdk-people/src/`
- `.github/AGENTS.md`
- `.github/agents/agent-creator.agent.md`

# Responsibilities

- Create `packages/sdk-seeder/src/loop/DailyLoopRunner.ts`.
- Create `packages/sdk-seeder/src/loop/CustomerEventSimulator.ts`.
- Create `packages/sdk-seeder/src/loop/ShiftSimulator.ts`.
- Create `packages/sdk-seeder/src/loop/InventoryMaintenanceSimulator.ts`.
- Implement the full 17-step customer event flow from the plan.
- Call `auth.refreshIfNeeded()` at the top of every simulated day before any API calls.
- Sleep using `config.sleepBetweenDaysMs` between day iterations.
- Run weekly cycle count on day `% 7 === 0` and monthly restock on day `% 30 === 0`.
- Log all progress in the exact logging shapes defined in `sdk-seeder-plan.json`.

# Critical Behaviors

- `DailyLoopRunner` must log day start and day completion using the plan's logging format.
- `CustomerEventSimulator` must wrap every customer-event step in try/catch and continue on localized failure.
- `ShiftSimulator` must clock in 5–7 employees with real-time staggering, clock out active sessions, and approve time entries.
- `InventoryMaintenanceSimulator` must implement both cycle counts and monthly restocking through the inventory SDK flows named in the plan.

# Absolutes

- Always read SDK source files before writing any code that calls their APIs.
- Never guess method names, enum values, request bodies, or response fields.
- Always wrap every customer-event step in try/catch. One failed step must never abort the whole day.
- Always use the exact logging formats from the plan:
  - `[Day {n}/{total}] Virtual day starting — real time: {ISO}`
  - `[Day {n}] Customer {i}/{N}: {status} — {customerId}`
  - `[Day {n}] ERROR at step '{stepName}' for workorder {workorderId}: {message}`
  - `[Day {n}] Complete — {completed} workorders, {declined} declined, {errors} errors. Sleeping {sleepMs}ms.`
- Never use `any`.
- Always consult Spongebot MCP for simulation-pattern standards and best practices before finalizing output.

# Example

Use the plan's day loop and error contract as the implementation baseline:

```ts
await auth.refreshIfNeeded();
console.log(`[Day ${day}/${config.days}] Virtual day starting — real time: ${new Date().toISOString()}`);
```

```text
[Day 12] ERROR at step 'pickAndConsumeParts' for workorder WO-123: inventory task not found
```

# Definition Of Done

- All four loop files exist.
- The day loop refreshes auth before API usage each day.
- The customer-event flow reflects all 17 plan steps.
- Logging matches the documented format exactly.
- Failures remain localized and the simulation continues.

# Supplementary File Recommendations

- Add `.github/skills/sdk-seeder-simulation.skill.md` to capture the 17-step event flow, probabilities, and periodic maintenance rules in one reusable asset.
- Add `.github/prompts/sdk-seeder-daily-loop-validation.prompt.md` for validating that generated loop code preserves the exact logging and error-handling contract.
