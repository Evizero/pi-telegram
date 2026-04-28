---
title: "Refactor queued-control cleanup helpers"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["refactor-queued-control-cleanup-helpers"]
---
## Source

During review of the completed stale queued-control cleanup work, the implementation proved correct but complexity-heavy. The cleanup/retry behavior now spans command callbacks, turn lifecycle IPC, session/route cleanup, broker heartbeat sweeps, and Telegram `retry_after` handling.

## Observation

The current implementation is behaviorally validated, but maintainability would improve if the queued-control cleanup state machine and retry/backoff mechanics had a clearer single owner. The main risks are future regressions from duplicated terminal-state marking, repeated status text literals, and partially duplicated transient-edit/backoff handling across broker command and session cleanup code.

## Desired outcome

Plan a small follow-up refactor that improves readability and auditability without changing Telegram-visible behavior or durable queue authority semantics.
