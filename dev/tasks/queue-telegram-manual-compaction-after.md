---
title: "Queue Telegram manual compaction after active work"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["telegram", "compaction", "queue"]
traces_to: ["SyRS-idle-telegram-compact", "SyRS-queue-busy-compact", "SyRS-compact-barrier-ordering", "SyRS-queued-compact-durability", "SyRS-compact-request-coalescing", "SyRS-defer-telegram-during-compaction"]
source_inbox: "queue-manual-compaction-after"
branch: "task/queue-telegram-manual-compaction-after"
---
## Objective

Make Telegram `/compact` behave like a queued, non-urgent session-control operation when the selected pi session is already busy, so it no longer aborts useful active work just because the command arrived from Telegram during a long turn.

When the selected session is idle and there is no earlier queued work, keep the existing immediate behavior: start pi manual compaction and report start/completion/failure to Telegram. When the selected session has active work, awaiting-final state, manual compaction already active, or earlier queued Telegram work, queue a manual-compaction barrier and acknowledge that compaction is queued. Later Telegram follow-up work must remain behind that barrier and run only after compaction completes or fails.

This is a pi-telegram behavior change only. Do not attempt to change native local pi `/compact`, pi RPC `compact`, or `AgentSession.compact()` semantics in this task.

## Requirement trace

Primary:

- `SyRS-idle-telegram-compact`
- `SyRS-queue-busy-compact`
- `SyRS-compact-barrier-ordering`
- `SyRS-queued-compact-durability`
- `SyRS-compact-request-coalescing`

Preserve and regression-check nearby behavior:

- `SyRS-defer-telegram-during-compaction`
- `SyRS-busy-message-default-followup`
- `SyRS-follow-queues-next-turn`
- `SyRS-queued-followup-steer-control`
- `SyRS-cancel-queued-followup`
- `SyRS-stop-active-turn`
- `SyRS-durable-update-consumption`

## Codebase grounding

Likely touchpoints:

- `src/broker/commands.ts` currently handles `/compact` by posting IPC `compact_session` immediately.
- `src/client/runtime-host.ts` currently dispatches `compact_session` to `clientCompact()`.
- `src/client/compact.ts` currently calls `ctx.compact()` immediately and reports completion/failure through a synthetic command turn.
- `src/client/turn-lifecycle.ts` owns active Telegram turn state, queued follow-up turns, awaiting-final gating, abort cleanup, and `ManualCompactionTurnQueue` integration.
- `src/client/manual-compaction.ts` already defers Telegram turns while manual compaction is active; the new behavior needs the preceding queued-compaction barrier, not just the already-running compaction case.
- `src/shared/types.ts` / broker state likely need a first-class representation for queued manual-compaction operations with route/session identity and dedupe/lifecycle state.
- Behavior checks under `scripts/run-behavior-check.mjs` and `scripts/support/pi-hook-fixtures.ts` should gain focused regression coverage for the new scheduler behavior.

Prefer modeling queued compaction as a first-class session operation/barrier rather than injecting `/compact` as fake user text. A unified ordered operation queue is the clean target if it can be introduced without destabilizing the existing turn lifecycle; a smaller deferred-compaction queue is acceptable only if tests prove FIFO ordering against later Telegram turns and existing queued-turn controls.

## Acceptance criteria

- Busy Telegram `/compact` acknowledges as queued and does not call `ctx.compact()` until the active turn and earlier queued lifecycle gates have settled.
- Idle Telegram `/compact` still starts compaction immediately and preserves the existing start/completion/failure Telegram replies.
- A Telegram message or `/follow <message>` sent after queued `/compact` remains behind the compaction barrier and starts only after compaction completion or failure releases the barrier; explicit `/steer <message>` remains governed by active-turn steering behavior.
- Existing behavior for Telegram input received while compaction is already running remains intact: no concurrent pi turn starts; deferred input resumes afterward in original order using explicit/default delivery semantics.
- `/steer <message>` remains an explicit urgent active-turn correction while a compact barrier is queued, unless implementation finds a concrete safety reason to change that; record any different decision in the task before coding it.
- `/stop`, explicit disconnect, route cleanup, and session death/reconnect-grace handling clear or finalize queued compaction state consistently with queued turns instead of leaving stale runnable operations behind.
- Duplicate/redelivered Telegram updates do not create duplicate queued compactions for the same command/update, and broker turnover preserves or terminally clears queued compaction according to the selected session lifecycle.
- A repeated `/compact` for a selected session that already has a queued or running Telegram manual compaction does not add another barrier in this slice; because custom compact instructions are out of scope, it receives a clear already-queued or already-running acknowledgement instead.
- Queued follow-up steer/cancel controls for ordinary queued turns continue to target only still-queued turns and do not accidentally act on the compaction barrier.
- User-visible Telegram text distinguishes queued, started, completed, failed, and no-longer-actionable compaction outcomes clearly.

## Validation

Run `npm run check` before completion.

Add focused behavior coverage for at least:

1. busy `/compact` queues without immediate `ctx.compact()`;
2. active turn settles, queued compact starts, then later ordinary follow-up starts after compaction completion;
3. compaction failure releases later queued work with a clear failure notification;
4. idle `/compact` still starts immediately;
5. `/stop` or route shutdown clears queued compaction state and does not leave stale controls or pending operations;
6. duplicate/redelivered compact request is idempotent;
7. repeated `/compact` while one is queued or running is coalesced with a clear acknowledgement rather than stacked as a second barrier.

If the implementation introduces broker-state schema fields, include migration/default handling in tests or fixture coverage so older broker state without queued-compaction fields still loads.

## Out of scope

- Changing native local pi `/compact` behavior, pi RPC `compact`, or upstream `AgentSession.compact()`.
- Adding Telegram `/compact <custom instructions>` support unless it falls out naturally without increasing risk; otherwise leave custom instructions for a later task.
- Adding a Telegram cancel button specifically for queued compaction. Clearing via existing lifecycle controls is in scope; a new user-visible cancel control can be planned separately.
- Redesigning all Telegram command routing or queued-turn controls beyond what the compaction barrier requires.

## Decisions

- Planning direction: implement the first slice in pi-telegram as an extension-owned queued manual-compaction barrier, because pi core currently exposes manual compaction as an immediate aborting control and does not provide a queued control-operation scheduler for extensions.
- Requirement update: `SyRS-compact-busy-session` is deprecated because it required the old immediate-interrupt behavior; new implementation should satisfy the queued-compaction requirements instead.
- 2026-04-30: Implemented queued Telegram manual compaction as a broker-persisted, route-scoped pending manual-compaction operation delivered through a new queue_or_start_compact_session IPC path. The client keeps the operation as an ordered barrier in ClientTelegramTurnLifecycle with a turns-before count so earlier queued turns run first, later ordinary/follow-up turns wait behind compaction, and explicit /steer remains governed by existing active-turn steering. Repeated /compact coalesces unless distinct instructions are later supported; stop/route cleanup clear pending operation state.
- 2026-04-30: Hardened durable ordering and stale-state recovery: later non-steer turns are durably marked behind a compact barrier and are not IPC-dispatched until the barrier settles; compaction retry waits for earlier unblocked pending turns; lost settled IPC reconciliation retries blocked turns; session replacement and route replacement retarget pending compactions; stop/offline cleanup clears no-longer-actionable queued compactions and blocked turns; synchronous/unavailable compact failures settle once and release later work.
- 2026-04-30: Validation passed with `npm run check`; final implementation review returned no findings.
