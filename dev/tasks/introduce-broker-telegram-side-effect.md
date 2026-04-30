---
title: "Introduce broker Telegram side-effect outbox"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["broker", "telegram", "retry", "reliability", "refactor"]
traces_to: ["SyRS-final-delivery-fifo-retry", "SyRS-telegram-retry-after", "SyRS-queued-control-finalization", "SyRS-retry-topic-cleanup", "SyRS-topic-routes-per-session", "SyRS-pi-safe-diagnostics", "SyRS-broker-lease-loss-standdown", "SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace"]
source_inbox: "consolidate-durable-telegram-side"
branch: "task/introduce-broker-telegram-side-effect"
---
## Objective

Introduce a broker-owned Telegram side-effect outbox foundation so durable/retryable Telegram side effects stop being reimplemented as separate ad hoc retry loops. The implementation slice should consolidate the simplest broker-side side effects first—queued-control status-message finalization and route/topic cleanup—while preserving the existing assistant-final delivery ledger until a later, separately validated migration can safely move final delivery onto the same abstraction.

The desired outcome is a clearer ownership seam: feature modules decide that a Telegram side effect is needed, record an idempotent durable job, and a serialized broker outbox executor owns retry timing, `retry_after`, terminal classification, broker lease/stand-down safety, and completion/diagnostic state.

## Deep-dive findings

Current durable Telegram side effects are correct in many individual places, but the retry shape is duplicated and hard to reason about globally:

- `BrokerState` currently stores several side-effect-specific retry surfaces: `pendingAssistantFinals`, `pendingRouteCleanups`, `pendingMediaGroups`, per-control `statusMessageRetryAtMs`, broker-wide `queuedTurnControlCleanupRetryAtMs`, `assistantPreviewMessages`, and completed-turn dedupe.
- `src/broker/finals.ts` already has the strongest ledger: FIFO ordering, per-step progress, preview detachment/cleanup, text chunk progress, attachment progress, terminal classification, and retry-after scheduling. This is too risk-sensitive to migrate in the first outbox slice.
- `src/broker/sessions.ts` couples route cleanup with queued-control finalization. It has to finalize visible queued buttons before deleting a topic, but retry state is split between `pendingRouteCleanups`, queued-control records, and `queuedTurnControlCleanupRetryAtMs`.
- `src/broker/queued-turn-control-handler.ts` also performs inline status-message finalization and carries its own retry bookkeeping for callback-driven paths.
- `src/broker/updates.ts` has a separate media-group flush retry path. That path protects inbound update preparation rather than an ordinary outbound side effect, so it should be inspected but not folded into the first outbox migration unless a small shared retry helper naturally applies.
- `src/telegram/message-ops.ts`, `src/telegram/errors.ts`, `src/telegram/final-errors.ts`, `src/telegram/attachments.ts`, and `src/telegram/retry.ts` already centralize much of the Telegram API policy. The outbox should reuse those helpers rather than reintroducing local description-string classifiers.
- `src/extension.ts` heartbeat is now the natural place to kick broker maintenance, including an outbox drain, but the outbox executor should live under `src/broker/` rather than in the composition root.

## Scope

Implement a first outbox slice with a deliberately bounded migration:

1. Add a persisted broker Telegram outbox model, likely in `BrokerState`, with stable idempotent job IDs, job kind, target chat/thread/message metadata, status/progress fields, `retryAtMs`, terminal reason, created/updated timestamps, and enough payload data for broker takeover to resume the job.
2. Add a focused broker module, likely `src/broker/telegram-outbox.ts` or `src/broker/outbox.ts`, that owns:
   - enqueue/upsert by idempotency key;
   - serialized drain/kick behavior;
   - `retry_after` scheduling;
   - terminal-vs-transient Telegram error classification through existing `src/telegram/` helpers;
   - broker lease-loss/stale-broker safety through the existing broker background conventions;
   - completion and terminal diagnostic hooks through the pi-safe diagnostic reporter.
3. Migrate queued-control status-message finalization onto the outbox for both callback-driven finalization and maintenance cleanup paths. Durable queued-control state must remain the fail-closed authority for stale callbacks.
4. Migrate Telegram topic deletion for queued route cleanup onto the outbox while preserving the existing ordering rule: local route unregister/detachment remains lifecycle-owned, and visible queued-control status cleanup for a detached route must be complete or deliberately terminal before the Telegram topic is deleted.
5. Add persisted-state migration or compatibility handling for existing broker state that may already contain `pendingRouteCleanups`, queued-control `statusMessageRetryAtMs`, and `queuedTurnControlCleanupRetryAtMs`; those cleanup/finalization retry records must either be converted into equivalent outbox jobs or drained through a deliberate compatibility path.
6. Keep `AssistantFinalDeliveryLedger` and `pendingAssistantFinals` as-is for this slice, except for small adapter/shared-helper changes that reduce duplication without moving final text or attachment delivery into the new outbox.
7. Inspect pending media-group retry and command result edit/send paths for interaction risks, but do not migrate media preparation, command result chunking, or assistant-final delivery unless the implementation uncovers a very small, separately testable helper extraction.
8. Update `dev/ARCHITECTURE.md` to name the broker Telegram outbox seam, describe which side-effect families it owns now, and record the migration boundary for future assistant-final or media-related work.

## Preserved behavior and adjacent requirements

The refactor must preserve these behaviors while changing ownership shape:

- Assistant finals remain FIFO and retry-safe; older finals must not be bypassed, duplicated, or migrated to a weaker progress model.
- Telegram `retry_after` remains authoritative and must not trigger immediate fallback or repeated retries.
- Queued follow-up controls remain route-scoped, authorized, idempotent, and fail-closed even if visible status-message cleanup is delayed or terminal.
- Route cleanup must not detach a still-active local route or delete a Telegram topic before required visible queued-control finalization has succeeded or reached a documented terminal state.
- Explicit disconnect, terminal shutdown, expired reconnect grace, and successful session-replacement handoff semantics must remain unchanged: lifecycle code still decides when local routes are detached or preserved; the outbox only changes how resulting visible Telegram cleanup side effects are retried and finalized.
- Broker turnover and stale broker lease detection must not let old broker maintenance resurrect completed outbox jobs or drop pending ones.
- Topic/chat/thread context must be preserved for every outbox-send/edit/delete job.
- Terminal diagnostics should go through pi-safe reporting and must not trigger unintended agent turns.
- Existing Telegram API policy helpers remain the source of truth for text limits, retry metadata, formatting fallback, photo/document fallback, and terminal error classification.
- Broker states written by the previous cleanup implementation must remain safe: pending route cleanups and queued-control retry markers should continue toward the same visible cleanup outcomes after upgrade rather than being dropped or causing duplicate Telegram operations.

## Acceptance Criteria

- A focused regression shows duplicate enqueue/upsert attempts for the same queued-control or route-cleanup idempotency key produce one durable outbox job and do not duplicate visible Telegram operations.
- Queued-control status finalization that receives `retry_after` records a future retry in the outbox and leaves durable queued-control state fail-closed for stale callback handling.
- Route cleanup waits for pending queued-control status finalization before deleting the topic, then records topic deletion completion or terminal outcome idempotently.
- Explicit disconnect, normal terminal shutdown, expired reconnect grace, and successful session-replacement handoff keep their current local route cleanup/preservation decisions while queued-control visible edits and Telegram topic deletion move through the outbox.
- Route cleanup `retry_after` and transient failures survive broker-state reload/broker turnover and are retried only after the recorded retry time.
- Legacy persisted cleanup state (`pendingRouteCleanups`, queued-control `statusMessageRetryAtMs`, and `queuedTurnControlCleanupRetryAtMs`) is migrated into outbox jobs or drained compatibly without losing cleanup intent, duplicating Telegram operations, or moving `pendingAssistantFinals` out of the assistant-final ledger.
- Terminal topic cleanup failures are surfaced through the existing pi-safe diagnostic path without blocking unrelated route cleanup jobs.
- Assistant-final delivery behavior remains unchanged in this slice; existing final-delivery tests still pass and at least one inspection/test confirms the final ledger remains the owner of final text chunk and attachment progress.
- No new raw terminal warning path is introduced for broker-maintenance-visible failures.
- Existing pending-turn, media-group, preview, attachment, topic-route, and Telegram retry-after behavior remains stable under `npm run check`.

## Out of Scope

- Do not migrate assistant final text/attachment delivery into the outbox in this first slice.
- Do not redesign `BrokerState` wholesale or split `src/shared/types.ts` as part of this task.
- Do not change Telegram command semantics, callback authorization, or busy-turn follow-up/steer behavior.
- Do not change low-level Telegram API request/response parsing except for narrowly shared classification helpers required by the outbox.
- Do not implement a database, external daemon, hosted queue, or inbound webhook service.
- Do not solve the separate edited-command-result chunk truncation bug in this refactor.

## Validation

Run `npm run check` before reporting completion.

Add focused behavior coverage, likely a new `scripts/check-telegram-outbox.ts` or extensions to the existing session cleanup / queued-control behavior checks, for:

- idempotent enqueue/upsert;
- queued-control edit retry-after and eventual completion;
- route cleanup ordering after queued-control finalization;
- route eligibility preservation for explicit disconnect, normal shutdown, expired reconnect grace, and session replacement handoff;
- persisted-state migration/compatibility from existing `pendingRouteCleanups` and queued-control retry markers into the new outbox behavior;
- topic deletion retry-after across reloaded broker state;
- terminal topic cleanup diagnostic reporting;
- no regression to assistant-final ledger ownership and FIFO behavior.

Also run `pln hygiene` after planning/architecture updates.

## Pre-edit impact preview

Expected blast radius is high but bounded: `src/shared/types.ts`, one new broker outbox module, `src/broker/sessions.ts`, `src/broker/queued-turn-control-handler.ts`, `src/extension.ts` heartbeat/maintenance wiring, existing Telegram error/message helpers only if needed, and behavior-check scripts. Main risks are accidentally weakening final-delivery FIFO semantics, deleting topics before stale controls are visibly finalized, duplicating Telegram edits/deletes after broker turnover, or turning a maintainability refactor into a behavior rewrite.

## Decisions

- 2026-04-30: Planning deep dive chose a staged outbox refactor rather than a single migration of every Telegram side-effect family. The first implementation slice should create the durable broker outbox seam and migrate queued-control status finalization plus route/topic cleanup; assistant-final delivery stays on its proven ledger until the outbox foundation is validated.
- 2026-04-30: Implemented the first Telegram outbox slice as broker/telegram-outbox.ts. The outbox now owns queued-control status-message finalization and Telegram topic deletion for detached route cleanup, including idempotent job IDs, persisted retry-at state, retry_after fan-out, terminal topic diagnostics, and legacy pendingRouteCleanups / queued-control retry marker migration. Assistant final text chunks and attachments remain on AssistantFinalDeliveryLedger and pendingAssistantFinals by design.
- 2026-04-30: Review fixes: queued-control command/callback drains are now scoped to queued-control status-edit jobs so route-topic deletion remains on fenced session/heartbeat cleanup paths; retry_after now records a broker outbox-wide retry barrier that migrated legacy queuedTurnControlCleanupRetryAtMs can seed and newly enqueued jobs inherit. Ordinary non-rate-limit transient failures defer only the failing job so unrelated cleanup jobs can continue.
- 2026-04-30: Final review fixes: fresh route cleanup can replace a retained completed/terminal route-topic-delete job for the same cleanup id, so reused topics are not suppressed during the retention window. Legacy queuedTurnControlCleanupRetryAtMs seeds the outbox-wide retry barrier only when no outbox jobs exist yet, avoiding promotion of ordinary per-job transient retries into a global retry_after barrier.
- 2026-04-30: Route-topic jobs now drain only through route-cleanup passes that first mark queued controls for the target routes. Session cleanup's immediate queued-control finalization drain is scoped to queued-control status-edit jobs, preventing unrelated pending route-topic deletes from running before their controls are finalized.
