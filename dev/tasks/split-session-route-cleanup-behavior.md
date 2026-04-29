---
title: "Split session route cleanup behavior checks"
status: "done"
priority: 3
created: "2026-04-29"
updated: "2026-04-29"
author: "pi-agent"
assignee: "pi-agent"
labels: ["tests", "cleanup", "behavior-checks"]
traces_to: ["SyRS-behavior-check-domain-fixtures", "SyRS-runtime-validation-check", "SyRS-behavior-check-discovery"]
source_inbox: "split-oversized-session-route"
branch: "task/split-session-route-cleanup-behavior"
---
## Goal

Split the oversized session route cleanup behavior check into focused domain check files while preserving every existing assertion and keeping the behavior-check runner unchanged.

## Scope

- Extract shared session-route check fixtures into a non-executable support module, for example `scripts/support/session-route-fixtures.ts`.
- Keep support files out of the root `scripts/check-*.ts` discovery pattern.
- Split `scripts/check-session-route-cleanup.ts` into focused root-level check files:
  - `scripts/check-session-unregister-cleanup.ts` for unregister cleanup, retryable topic cleanup, queued-control finalization before topic deletion, idempotent already-deleted topic cleanup, and terminal auth failure handling.
  - `scripts/check-session-disconnect-requests.ts` for client shutdown route final retry queues, pending-final waiting, late/stale/scoped disconnect requests, and route-scoped final cancellation.
  - `scripts/check-session-route-registration.ts` for reconnect route reuse, pending-disconnect handling during registration, stale registration protection, route home changes, cleanup rechecks/fencing/skips, and route creation failure preservation.
  - `scripts/check-session-pending-turn-rehome.ts` for offline marking with pending work/finals, pending-turn route rehome, preview delete retry behavior, permanent preview-delete failure behavior, and preview-ref preservation on retryable delete failures.
  - `scripts/check-session-topic-setup-and-offline-grace.ts` for topic setup rollback/orphan cleanup and reconnect grace before cleanup.
- Preserve route/thread, pending-turn, pending-final, preview, queued-control, Telegram method, retry-after/transient failure, and user-visible text assertions.

## Non-goals

- Do not change runtime behavior.
- Do not change behavior-check discovery or the `npm run check` entrypoint.
- Do not migrate to `node:test` or Vitest in this task.
- Do not broaden the split to unrelated behavior check files.

## Implementation notes

The current runner auto-discovers sorted root-level `scripts/check-*.ts`, so newly split executable check files should be picked up without runner changes. Each split check file must be independently executable through top-level await and must not rely on execution order.

Likely shared fixture exports:

- `session()` / compatibility alias `makeSession()`
- `topicRoute()` / compatibility alias `makeTopicRoute()`
- `selectorRoute()` / compatibility alias `makeSelectorRoute()`
- `state()` / compatibility alias `makeBrokerState()`
- `honorScopedDisconnect()`
- `registrationCoordinatorForCleanupCheck()`
- small typed call-recorder aliases for Telegram edit/delete calls where useful

Prefer typed fixture parameters and narrow production types over broad `as any` / `as never` casts where practical, but avoid broad refactors unrelated to this check split.

## Acceptance criteria

- The original `scripts/check-session-route-cleanup.ts` is removed or reduced to a small domain-specific file below the project 1000-line TypeScript guidance.
- New root-level check files cover all 31 executable check functions that were previously in `check-session-route-cleanup.ts`.
- Shared fixtures live under `scripts/support/` or another non-executable support path and are not discovered as standalone behavior checks.
- Existing behavioral assertions are preserved, especially safe unregister/disconnect cleanup, reconnect grace, pending-turn rehome, pending-final retry preservation/removal, preview cleanup, topic setup rollback, route/thread preservation, queued-control finalization, retry-after/transient cleanup retries, stale scoped request rejection, and retry-safe pending work/finals.
- `npm run check` passes and executes the new split check files.

## Decisions

## Implementation record

Implemented 2026-04-29:

- Removed the oversized root `scripts/check-session-route-cleanup.ts` executable check file.
- Added `scripts/support/session-route-fixtures.ts` for shared session, topic-route, selector-route, broker-state, scoped-disconnect, and registration-coordinator fixtures plus compatibility aliases.
- Added `scripts/check-session-unregister-cleanup.ts` for unregister, queued-control finalization, retryable topic cleanup, idempotent already-deleted topic cleanup, and terminal auth failure scenarios.
- Added `scripts/check-session-disconnect-requests.ts` for shutdown route final retry queues, pending-final waiting, late/stale/scoped disconnect requests, and route-scoped final cancellation scenarios.
- Added `scripts/check-session-route-registration.ts` for reconnect route reuse, pending-disconnect handling during registration, stale registration protection, route home changes, cleanup rechecks/fencing/skips, and route creation failure preservation scenarios.
- Added `scripts/check-session-pending-turn-rehome.ts` for offline marking with pending work/finals, pending-turn route rehome, preview delete retry behavior, permanent preview-delete failure behavior, and preview-ref preservation on retryable delete failures.
- Added `scripts/check-session-topic-setup-and-offline-grace.ts` for topic setup rollback/orphan cleanup and reconnect grace scenarios.
- Preserved all 31 executable check functions from the original file; a local function-name comparison found no missing or extra check functions.
- Left runtime source code and behavior-check discovery unchanged.

Validation run:

- `npm run check` passed and executed the new split check files.
