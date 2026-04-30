---
title: "Extract client Telegram turn lifecycle"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["refactor", "lifecycle", "client"]
traces_to: ["SyRS-deliver-telegram-turn", "SyRS-topic-routes-per-session", "SyRS-busy-message-default-followup", "SyRS-follow-queues-next-turn", "SyRS-queued-followup-steer-control", "SyRS-cancel-queued-followup", "SyRS-queued-control-finalization", "SyRS-defer-telegram-during-compaction", "SyRS-compact-busy-session", "SyRS-mirror-current-turn-on-connect", "SyRS-stop-active-turn", "SyRS-final-preview-deduplication", "SyRS-final-delivery-fifo-retry", "SyRS-retry-aware-agent-finals", "SyRS-final-text-before-error-metadata", "SyRS-explicit-artifact-return", "SyRS-outbound-attachment-safety", "SyRS-session-replacement-route-continuity", "SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace", "SyRS-runtime-validation-check"]
source_inbox: "create-shared-lifecycle-state"
branch: "task/extract-client-telegram-turn-lifecycle"
---
## Objective

Extract an explicit client-side Telegram turn lifecycle/queue API so active turns, queued follow-ups, manual-compaction deferral, retry-aware finalization, final handoff, and route shutdown are coordinated through named transitions instead of scattered flag and array mutation.

The task is a refactor: preserve current Telegram-visible behavior while making the lifecycle easier for future agents to reason about and extend.

## Scope

Focus on the client-side lifecycle currently spread across:

- `src/client/runtime-host.ts` (`queuedTelegramTurns`, `activeTelegramTurn`, `currentAbort`, `awaitingTelegramFinalTurnId`, stale-client stand-down, route shutdown, `startNextTelegramTurn`);
- `src/client/runtime.ts` (turn delivery, queued-turn steer/cancel, abort, compaction entry points);
- `src/client/turn-delivery.ts` and `src/client/manual-compaction.ts` (idle start, busy follow-up queueing, manual-compaction deferral/drain);
- `src/client/retry-aware-finalization.ts` and `src/client/final-handoff.ts` (active-turn finalization, retry deferral, pre-broker-acceptance handoff gating);
- `src/client/route-shutdown.ts`, `src/client/abort-turn.ts`, and the pi hook paths in `src/pi/hooks.ts` that set or clear turn/final state through the host.

A good shape would introduce one cohesive lifecycle owner under `src/client/` (for example a `ClientTurnLifecycle`, `TelegramTurnQueue`, or similarly named module) that owns the mutable turn state and exposes operations such as deliver/queue/start-next, convert queued turn to steer, cancel queued turn, queue an explicit outbound attachment on the active Telegram turn, mark awaiting final, complete/release final, abort/clear on disconnect, and snapshot registration/status state. The exact API is up to implementation, but it should make illegal or ambiguous state transitions harder to express.

## Preserved behavior

Do not change Telegram behavior while extracting the lifecycle seam:

- idle authorized Telegram input still starts a pi turn normally;
- ordinary busy Telegram messages queue as follow-up by default;
- `/follow` remains queued follow-up work;
- explicit `/steer` or a valid queued steer control still steers only when the target active turn is still valid;
- queued cancel controls remove only the targeted still-queued follow-up;
- queued controls are finalized when their turn starts, is steered, cancelled, stopped, expires, or otherwise becomes non-actionable;
- Telegram `/compact` on a busy selected session still invokes native pi manual-compaction/interrupt semantics and reports completion or failure without changing ordinary busy-message routing;
- manual-compaction deferral preserves order and does not start concurrent pi turns;
- `/telegram-connect` during an already-running local pi turn still starts mirroring current activity and final delivery;
- per-session route context, including `chatId` and `message_thread_id`, remains attached to turns, activity, finals, previews, uploads, and controls so concurrent sessions do not cross-post;
- retry-aware finalization still defers transient provider/assistant errors until a stable final or terminal outcome;
- non-empty assistant final text still wins over stop/error metadata when constructing the Telegram final response;
- explicit `telegram_attach`/pi outbound attachments queued on an active Telegram turn still travel with the associated assistant reply, keep allowed-path and obvious-secret blocking, and do not create broader Telegram upload authority;
- assistant response text still appears only through final delivery, and any legacy/in-flight preview state is detached or cleaned before final delivery rather than duplicated or edited into the final;
- `/stop` still aborts the selected session's active turn, clears associated lifecycle state, and reports one clear Telegram confirmation;
- client-side final handoff remains only the pre-broker-acceptance safety window; broker-owned final delivery remains the durable FIFO Telegram delivery authority;
- stale-client stand-down, explicit disconnect, normal route shutdown, replacement handoff, and reconnect-grace behavior keep their existing route/final cleanup semantics;
- aborted/disconnected/completed turn dedupe remains bounded and retry-safe.

## Codebase grounding

Start by mapping every direct read/write of `queuedTelegramTurns`, `activeTelegramTurn`, `currentAbort`, `awaitingTelegramFinalTurnId`, `completedTurnIds`, `disconnectedTurnIds`, and manual-compaction pending state. The highest-risk locations are `ClientRuntimeHost.startNextTelegramTurn()`, `ClientRuntime.convertQueuedTurnToSteer()`, `ClientRuntime.cancelQueuedTurn()`, `clientDeliverTelegramTurn()`, `ManualCompactionTurnQueue.startDeferredTurnIfReady()`, `RetryAwareTelegramTurnFinalizer.releaseDeferredTurn()`, and `ClientAssistantFinalHandoff` retry gating.

Prefer moving ownership in small internal steps while preserving existing public IPC envelope shapes and Telegram command/callback behavior. Avoid replacing typed state with a generic event bus or a new god object that merely moves the same mutable fields into a larger file.

## Acceptance Criteria

- There is one named client lifecycle/queue owner for active/queued/deferred Telegram turn state, and direct mutation of that state from `ClientRuntimeHost`/`ClientRuntime` is reduced to calls on that owner or narrow snapshots.
- The lifecycle owner exposes explicit operations for the important transitions rather than leaking raw arrays and flags to callers.
- Manual-compaction deferral, queued follow-up steering/cancellation, outbound attachment queueing, abort/disconnect cleanup, retry-aware final release, and final-handoff gating all use the same lifecycle vocabulary for shared state.
- Existing IPC payload shapes and broker-owned durable state formats remain compatible unless a deliberate, tested migration is added.
- `src/extension.ts`, `src/broker/*`, and `src/telegram/*` do not gain client lifecycle policy as part of this refactor.
- No TypeScript source file exceeds 1,000 lines after the extraction.

## Out of Scope

- Do not introduce the durable Telegram outbox/retry-job mechanism; that belongs to the later `consolidate-durable-telegram-side` cleanup.
- Do not split all of `src/shared/types.ts` or `src/shared/config.ts`; only move types/constants if the lifecycle seam needs a clearly bounded helper.
- Do not redesign broker election, Telegram polling, Bot API retry classification, or command/callback routing.
- Do not change user-facing Telegram command names, inline-control text, topic routing, or final-delivery semantics.

## Validation

Run `npm run check` before reporting completion. Add or adjust focused behavior checks if the extraction changes seams around:

- idle versus busy Telegram turn delivery;
- ordinary busy-message follow-up queueing;
- `/follow`, explicit steer, queued steer, queued cancel, and stale queued-control finalization;
- Telegram `/compact` busy-session interrupt/compaction behavior;
- manual-compaction deferral/drain ordering;
- retry-aware finalization and subsequent stable final delivery;
- final text versus stop/error metadata handling;
- explicit `telegram_attach`/queued outbound attachment preservation through final handoff, including allowed-path resolution and obvious-secret blocking;
- assistant preview cleanup/deduplication before final delivery;
- pre-broker-acceptance final-handoff retry/release gating and its interaction with starting later queued turns;
- `/stop` abort behavior and confirmation;
- per-session route/thread context for activity, finals, previews, uploads, and controls;
- route shutdown, stale-client stand-down, or session replacement handoff.

If no behavior checks need changes, document why existing checks cover the moved lifecycle paths.

## Pre-edit impact preview

Likely code touchpoints: `src/client/runtime-host.ts`, `src/client/runtime.ts`, `src/client/turn-delivery.ts`, `src/client/manual-compaction.ts`, `src/client/abort-turn.ts`, `src/client/retry-aware-finalization.ts`, `src/client/final-handoff.ts`, `src/client/route-shutdown.ts`, and focused behavior-check fixtures.

Planning touchpoints: this task and possibly `dev/ARCHITECTURE.md` if the implementation settles on a durable lifecycle abstraction name that should become architecture contract text.

Main risks: accidentally changing busy-turn intent, losing retry-aware final handoff behavior, creating a new oversized lifecycle module, or making manual-compaction deferral diverge from normal queued-turn behavior.

## Decisions

- 2026-04-30: Implemented the client lifecycle seam as src/client/turn-lifecycle.ts. ClientRuntimeHost now delegates active/queued/awaiting/abort/completed/disconnected state and start-next/attachment/local-turn transitions to ClientTelegramTurnLifecycle; ClientRuntime, turn delivery, abort, route shutdown, and pi hooks use the lifecycle operations for production paths while preserving existing IPC and behavior-check contracts.
- 2026-04-30: Validation and review passed for the lifecycle extraction: npm run check succeeds, and a fresh Review pass after the latest runtime-shim fixes reported no findings.
- 2026-04-30: Close-out updated dev/ARCHITECTURE.md to name ClientTelegramTurnLifecycle as the client owner for active/queued/deferred Telegram turn state and to remove stale composition-root migration wording.
