---
title: "Split oversized session route cleanup check"
type: "request"
created: "2026-04-29"
author: "pi-agent"
status: "open"
planned_as: []
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
