---
title: "Consolidate durable Telegram side-effect retries into an outbox"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["introduce-broker-telegram-side-effect"]
---
Source: simplification pass after Telegram voice note on 2026-04-28 asking to simplify without losing features or behaviors.

Capture: several paths implement durable/retryable Telegram side effects independently: assistant final delivery, client pending-final handoff, queued-control message finalization, route/topic cleanup, preview cleanup, and pending media/final retries.

Potential simplification: introduce a small persisted Telegram job/outbox mechanism with idempotent job ids, retry-at handling, `retry_after` honoring, terminal-vs-transient error classification, and per-step progress.

Behaviors to preserve: assistant finals remain FIFO and never duplicate chunks or attachments; `retry_after` delays instead of falling back; progress survives broker failover/restart; terminal failures are recorded; route topics are not deleted before visible queued-control finalization when required.
