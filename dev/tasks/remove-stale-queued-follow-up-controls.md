---
title: "Remove stale queued follow-up controls"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: "pi-agent"
labels: []
traces_to: ["SyRS-queued-control-finalization", "SyRS-queued-followup-steer-control", "SyRS-cancel-queued-followup", "SyRS-telegram-retry-after", "SyRS-durable-update-consumption", "SyRS-topic-routes-per-session", "SyRS-defer-telegram-during-compaction"]
source_inbox: "remove-stale-queued-follow"
branch: "task/remove-stale-queued-follow-up-controls"
---
## Objective

Remove misleading stale `Steer now` / `Cancel` buttons from Telegram queued-follow-up status messages once the targeted follow-up is no longer actionable, without changing the durable queued-turn authority model.

The visible Telegram cleanup is a user-interface finalization step. Broker/client state remains authoritative for whether a callback is valid, whether a turn is still queued, and whether a turn has been consumed.

## Scope

- Finalize queued-follow-up status messages when the targeted turn leaves the actionable waiting state without a button press, including normal start, stop/clear flows, expiry/pruning, and other durable terminal states already represented by queued-turn controls.
- Edit the known Telegram status message to remove the inline keyboard and replace or keep the text as a clear terminal state such as started, no longer waiting, cancelled, steered, or cleared.
- Preserve route and topic context when editing status messages.
- Keep cleanup retry-aware: Telegram `retry_after` during a status-message edit should remain significant and should not be treated as success.
- Keep stale callback handling fail-closed through durable broker/client state even if the visible edit never succeeds.

## Preserved behavior

- `Steer now` and `Cancel` remain sibling controls for a still-queued follow-up; neither action becomes authority by itself.
- Cancelling one follow-up must still remove only the targeted queued/deferred turn.
- Steering a queued follow-up must still atomically remove that target before delivering it as active-turn steering.
- Ordinary busy messages still queue as follow-up by default; `/follow`, `/steer`, `/stop`, model-picker callbacks, route/topic scoping, and broker pending-turn dedupe must keep their existing semantics.
- UI cleanup failure must not resurrect a consumed turn, duplicate delivery, drop unrelated queued work, or advance Telegram update handling as if a retryable edit had succeeded.

## Codebase grounding

Likely touchpoints:

- `src/broker/commands.ts`: queued-turn control records, status-message rendering, callback terminal states, pruning/expiration, and any new status-message finalization helper.
- `src/extension.ts`: lifecycle paths that mark controls expired when queued turns start normally, are stopped, are disconnected, or are otherwise cleared without a queued-control callback.
- `src/client/runtime.ts`, `src/client/turn-delivery.ts`, and `src/client/manual-compaction.ts`: inspect only as needed to identify the exact moments when normal queued/deferred turns become active or leave the queue.
- `src/shared/types.ts`: adjust queued-control state only if existing statuses and `completedText` are not enough to represent visible terminal cleanup.
- `scripts/check-telegram-command-routing.ts`, `scripts/check-client-turn-delivery.ts`, and possibly lifecycle-focused checks under `scripts/`: add regression coverage for cleanup paths and retry behavior.

## Acceptance criteria

- A queued follow-up that starts normally later has its queued-status message finalized without `Steer now` / `Cancel` buttons, where Telegram editing is possible.
- Stop/clear, control expiry, and missing-pending-turn cleanup paths finalize visible queued controls where a status message is known.
- Duplicate or stale callbacks after visible cleanup still answer from durable control state without steering, cancelling, or mutating unrelated queued turns.
- `retry_after` from a cleanup edit remains retry-significant and a retry does not duplicate turn delivery, resurrect cancelled work, or lose unrelated queued controls.
- Manual-compaction deferred follow-ups keep their ordering and can have stale controls finalized when the deferred turn starts or is cleared.
- Existing cancel/steer, model-picker callback, delivery durability, and Telegram text method regression checks still pass.

## Out of scope

- Do not redesign queued controls into the activity bubble.
- Do not add a generic `/cancel <message>` or broader queue-management UI.
- Do not make visible Telegram edits the source of truth for queue state.
- Do not delete Telegram attachment temp files from this UI cleanup path.
- Do not require successful visible cleanup before a queued turn may start; cleanup should improve clarity without blocking local execution on Telegram availability.

## Validation

Run `npm run check` and `pln hygiene` before reporting implementation completion. Add focused tests for normal-start cleanup, stop/clear cleanup, expiry cleanup, stale callback behavior after cleanup, `retry_after` during cleanup edit, and manual-compaction deferred cleanup.

## Decisions

- 2026-04-28: Implement stale-control cleanup as broker-owned visible finalization on existing queued-turn control records. The broker will edit known status messages to terminal text without an inline keyboard while durable control status remains authoritative for callbacks and turn consumption.
- 2026-04-28: Implemented visible cleanup through broker-owned queued-control finalization. Normal queued-turn start, stop/clear, expiry sweeps, and manual-compaction deferred drains now mark matching offered controls expired with terminal text and edit known status messages without reply markup; durable control state remains authoritative if Telegram editing is unavailable or retry-limited.
- 2026-04-28: After focused review, extended finalization to offered controls whose durable pending turn is already gone and to broker turn-consumed handling. This covers missed turn-start IPC and other durable terminal paths without overriding in-flight converting or cancelling controls.
- 2026-04-28: Resolved manual-compaction ordering by carrying queued-control terminal text on the existing turn_consumed IPC instead of posting a separate finalization IPC. This keeps consumption and visible cleanup ordering coherent for deferred follow-up drains.
- 2026-04-28: Decoupled non-idempotent /stop from cleanup edit rate limits by persisting terminal queued-control state and retrying visible cleanup later instead of replaying abort_turn on Telegram redelivery. Added regression coverage for retry_after during stop cleanup.
- 2026-04-28: Extended terminal session and route cleanup to mark queued controls for removed pending turns as cleared and attempt visible status-message finalization after broker state persistence. Retry-limited cleanup edits leave durable terminal state for later retry rather than blocking route/session cleanup.
- 2026-04-28: Session and route cleanup now also terminalize queued controls that were already converting or cancelling when the route/session was removed, so visible controls are finalized even if cleanup races with a queued-control callback state.
- 2026-04-28: Added retry timestamps for queued-control status-message cleanup. Retry-limited edits now defer further visible-cleanup attempts and session cleanup skips immediate topic deletion when Telegram asked the bot to back off.
- 2026-04-28: Preserved queued-control cleanup retry records through pruning and propagated cleanup retry_after to pending route cleanup retryAtMs so topic deletion does not bypass Telegram backoff before visible queued-control cleanup can retry.
- 2026-04-28: Route cleanup retry now retries queued-control status-message finalization before deleting the Telegram topic. Pending route cleanup keeps its retryAtMs aligned with queued-control cleanup backoff so stale buttons are finalized before topic deletion where Telegram permits it.
- 2026-04-28: Retry sweeps now terminalize converting/cancelling controls whose pending turn is gone, and pending route-cleanup retries mark unfinalized route-scoped queued controls before attempting topic deletion.
- 2026-04-28: Added compatibility finalization for legacy expired queued-control records that predate completedText tracking, so old visible buttons can be edited to terminal text before pruning.
- 2026-04-28: Session-offline cleanup now terminalizes visible queued controls even when pending finals preserve routes, and route-scoped disconnect of the current connection terminalizes all controls for the removed session rather than only the target route.
- 2026-04-28: Stop/clear finalization now terminalizes in-progress queued controls as well as offered controls, and route/session cleanup assigns terminal text to legacy expired controls that still have visible status messages.
- 2026-04-28: Session and route cleanup now also retry visible finalization for already-terminal controls with completedText but no finalized timestamp, covering controls left pending after an earlier retry_after.
- 2026-04-28: Session queued-control cleanup now treats non-Telegram and 5xx status-message edit failures as retryable instead of finalized, and broker heartbeat/startup now sweeps queued-control finalization retries so selector/single-chat or preserved-route cleanup is retried even without pending topic cleanup.
- 2026-04-28: Command-router queued-control finalization now treats transient edit failures without retry_after as retryable instead of finalized, preserving visible-cleanup retry state for turn-start/turn-consumed and heartbeat sweeps.
- 2026-04-28: Background queued-control finalization sweeps now swallow retry_after after recording retry state so stale UI cleanup cannot block unrelated commands or still-actionable queued-control callbacks.
- 2026-04-28: Command-router queued-control cleanup now uses the non-retrying Telegram call path in production, so retry_after is recorded immediately by cleanup logic instead of sleeping inside the generic Telegram retry wrapper.
- 2026-04-28: Direct queued-control finalization calls now respect existing statusMessageRetryAtMs, so duplicate turn-start/clear events do not retry Telegram edits before the recorded backoff expires.
- 2026-04-28: Queued-control retry sweeps stop after recording a retry_after so remaining cleanup edits are deferred until the backoff window instead of continuing with more Telegram edits.
- 2026-04-28: Added broker-wide queued-control cleanup backoff so a retry_after from one stale-control edit gates later visible-cleanup sweeps and defers remaining edits until the deadline.
- 2026-04-28: Direct queued-control finalization now honors the broker-wide cleanup backoff before editing and records the broker-wide retry deadline when a direct cleanup edit receives retry_after.
- 2026-04-28: Session and route cleanup now share the broker-wide queued-control cleanup backoff, skipping status-message edits while a retry_after deadline is active and setting the shared deadline when cleanup hits retry_after.
- 2026-04-28: Session queued-control cleanup now stops when it encounters any per-control retry timestamp still in the future and promotes that deadline to the broker-wide cleanup backoff.
- 2026-04-28: Session queued-control cleanup now pre-scans controls for future per-control retry timestamps, promotes the earliest one to broker-wide backoff, and returns before attempting any Telegram cleanup edits.
- 2026-04-28: Offline or invalid-route queued-control callbacks now terminalize the visible control state, and direct callback cleanup edits observe/set the broker-wide cleanup backoff.
- 2026-04-28: 2026-04-28: Close-out review accepted implementation. Acceptance criteria are covered by targeted command-routing, client-turn, manual-compaction, session-route-cleanup, and full npm run check validation; traced SyRS remain satisfied and final focused review reported no findings where applicable.
