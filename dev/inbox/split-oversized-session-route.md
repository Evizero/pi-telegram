---
title: "Split oversized session route cleanup check"
type: "request"
created: "2026-04-29"
author: "pi-agent"
status: "planned"
planned_as: ["split-session-route-cleanup-behavior"]
---
Follow-up preserved during close-out of `split-telegram-command-routing`.

The archived source item `decompose-oversized-command-router` also identified `scripts/check-session-route-cleanup.ts` as an oversized behavior check (about 1327 lines during the 2026-04-29 deep dive). That work was explicitly out of scope for the completed command-routing split.

Suggested later planning direction: split `scripts/check-session-route-cleanup.ts` after the command-routing support-fixture pattern has proven out. Use a separate non-executable support module such as `scripts/support/session-route-fixtures.ts` for session, route, state, queued-control, pending-turn, pending-final, and runtime-update builders, while keeping scenario-specific mutations visible.

Candidate domain check files:

- `scripts/check-session-unregister-cleanup.ts`
- `scripts/check-session-disconnect-requests.ts`
- `scripts/check-session-route-registration.ts`
- `scripts/check-session-pending-turn-rehome.ts`
- `scripts/check-session-topic-setup-and-offline-grace.ts`

Preserve existing assertions around safe disconnect/offline cleanup, reconnect grace, pending-turn rehome, preview cleanup, topic setup rollback, route/thread preservation, queued-control finalization, and retry-safe pending work/finals.

Implementation constraints: support fixture files must not match root `scripts/check-*.ts`; split check files must be independent under top-level await and cannot rely on execution order; validation remains `npm run check`.


## Investigation note (2026-04-29)

Current check shape: `scripts/check-session-route-cleanup.ts` is 1327 lines and contains 31 executable check functions plus shared fixture/helpers. The oversized file is validation-only; no runtime decomposition is indicated by this investigation.

Reusable fixture/helper candidates are concentrated at the top and middle of the file:

- `session(overrides)`
- `topicRoute(sessionId)`
- `selectorRoute(sessionId)`
- `state(overrides)`
- `honorScopedDisconnect(...)`
- `registrationCoordinatorForCleanupCheck(...)`

Recommended split keeps those in a non-executable support module such as `scripts/support/session-route-fixtures.ts`, then moves executable checks into root-level auto-discovered files. Candidate grouping:

- `scripts/check-session-unregister-cleanup.ts`: unregister, queued-control finalization before cleanup, retryable topic cleanup, idempotent already-deleted topic cleanup, terminal auth failure handling.
- `scripts/check-session-disconnect-requests.ts`: client shutdown route final queue behavior, pending-final waiting, stale/late/scoped disconnect requests, and route-scoped final cancellation.
- `scripts/check-session-route-registration.ts`: reconnect route reuse, pending-disconnect handling during registration, route home changes, cleanup rechecks/fencing/skips, creation failure preservation.
- `scripts/check-session-pending-turn-rehome.ts`: offline marking with pending work/finals, pending-turn route rehome, preview delete/retry behavior, and permanent preview-delete failure behavior.
- `scripts/check-session-topic-setup-and-offline-grace.ts`: topic setup rollback/orphan cleanup and reconnect grace before cleanup.

Implementation constraints remain unchanged: support files must not match root `scripts/check-*.ts`; each split check file must be independently executable under top-level await; preserve all 31 existing check functions/assertions; do not change runtime behavior, behavior-check discovery, or the `npm run check` entrypoint.
