---
title: "Split Telegram command-routing behavior checks"
status: "done"
priority: 3
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: "pi-agent"
labels: ["tests", "cleanup", "behavior-checks"]
traces_to: ["SyRS-behavior-check-domain-fixtures", "SyRS-runtime-validation-check", "SyRS-behavior-check-discovery"]
source_inbox: "decompose-oversized-command-router"
branch: "task/split-telegram-command-routing"
---
## Goal

Split the oversized Telegram command-routing behavior check into focused domain check files while preserving every existing assertion and keeping the behavior-check runner unchanged.

## Scope

- Extract shared command-router check fixtures into a non-executable support module, for example `scripts/support/telegram-command-fixtures.ts`.
- Keep support files out of the root `scripts/check-*.ts` discovery pattern.
- Keep `scripts/check-telegram-command-routing.ts` focused on core dispatch behavior:
  - plain turn delivery;
  - `/compact`;
  - `/stop`;
  - `/follow`;
  - `/steer`.
- Move queued follow-up control scenarios into `scripts/check-telegram-queued-controls.ts`.
- Move Git command/control scenarios into `scripts/check-telegram-git-controls.ts`.
- Move model picker scenarios into `scripts/check-telegram-model-picker.ts`.
- Preserve route/thread, IPC, Telegram method, retry-after, stale callback, and user-facing text assertions.

## Non-goals

- Do not change runtime behavior.
- Do not change behavior-check discovery or the `npm run check` entrypoint.
- Do not split `scripts/check-session-route-cleanup.ts` in this task; that should be planned as a follow-up after this fixture pattern proves out.
- Do not migrate to `node:test` or Vitest in this task.

## Implementation notes

The current runner auto-discovers sorted root-level `scripts/check-*.ts`, so newly split executable check files should be picked up without runner changes. Each split check file must be independently executable through top-level await and must not rely on execution order.

Likely shared fixture exports:

- `makeSession()`
- `makeBrokerState()`
- `makeMessage()`
- `makeCallbackQuery()`
- `createCommandRouterHarness()`
- callback button data extraction helpers
- shared model catalog fixtures
- typed IPC, Telegram-call, and sent-reply recorder types

Prefer typed fixture parameters and narrow production types over broad `as any` / `as never` casts where practical, but avoid broad refactors unrelated to this command-routing check split.

## Acceptance criteria

- `scripts/check-telegram-command-routing.ts` is below the project 1000-line TypeScript guidance and contains only the core command-routing scenarios.
- New root-level check files cover queued controls, Git controls, and model picker scenarios that were previously in `check-telegram-command-routing.ts`.
- Shared fixtures live under `scripts/support/` or another non-executable support path and are not discovered as standalone behavior checks.
- Existing behavioral assertions are preserved, especially busy-message default follow-up, `/follow` vs `/steer`, queued-control idempotency across retry-after and broker failover, stale/offline/wrong-route callback rejection, `/stop` queued-control finalization without abort replay, Git/model callback no-replay after Telegram retry-after, and route/thread preservation.
- `npm run check` passes and executes the new split check files.

## Decisions
## Implementation record

Implemented 2026-04-29:

- Added `scripts/support/telegram-command-fixtures.ts` for shared command-router fixtures, typed call recorders, callback helpers, and compatibility aliases such as `makeSession`, `makeBrokerState`, `makeMessage`, `makeCallbackQuery`, and `createCommandRouterHarness`.
- Reduced `scripts/check-telegram-command-routing.ts` to the core command-routing scenarios.
- Added `scripts/check-telegram-queued-controls.ts` for queued follow-up, steer/cancel, retry-after, cleanup, failover, stale, offline, and wrong-route control scenarios.
- Added `scripts/check-telegram-git-controls.ts` for `/git` menu and Git callback scenarios.
- Added `scripts/check-telegram-model-picker.ts` for `/model`, numeric compatibility, picker callback, UI-failure, and retry-after scenarios.
- Left runtime source code and behavior-check discovery unchanged.

Validation run:

- `npm run check` passed and executed the split check files.
