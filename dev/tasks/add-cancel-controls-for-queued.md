---
title: "Add cancel controls for queued Telegram follow-ups"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: "pi-agent"
labels: []
traces_to: ["SyRS-cancel-queued-followup", "SyRS-queued-followup-steer-control", "SyRS-durable-update-consumption", "SyRS-telegram-retry-after", "SyRS-defer-telegram-during-compaction"]
source_inbox: "cancel-individual-queued-telegram"
branch: "task/add-cancel-controls-for-queued"
---
## Objective

Add a precise cancel action for an individual Telegram follow-up that is still waiting in the queued-turn control lifecycle. Cancellation should be the sibling outcome to `Steer now`: both target the same queued turn from the same routed status message, but one converts the turn into active-turn steering and the other withdraws it before pi receives it as a future turn.

## Scope

- Extend the existing queued follow-up status message to show a `Cancel` inline button alongside `Steer now` for the same queued-turn control record.
- Treat steer and cancel as mutually exclusive terminal outcomes for one control token/turn, with durable state deciding validity rather than the visible Telegram button.
- Add client IPC that atomically removes the target queued turn from the normal queued-turn list or manual-compaction deferred queue before reporting cancellation success.
- Consume or dedupe the broker pending turn only after cancellation is durably accepted, so broker retry/failover does not later deliver the cancelled follow-up.
- Keep `/steer <message>` as the text path for urgent new steering and keep `/stop` as the broader active-turn/queue escape hatch. Do not add a generic `/cancel <message>` command in this slice; it would be ambiguous without a stable target selector and would duplicate the precise inline control.

## Preserved behavior

- `Steer now` behavior must remain unchanged and must not be implemented as a special case of cancellation.
- Cancelling one follow-up must not abort the active turn and must not remove unrelated queued follow-ups.
- `/follow`, ordinary busy-message default follow-up, `/steer`, `/stop`, model-picker callbacks, and route/topic scoping must keep their existing semantics.
- Unauthorized users and callbacks that no longer match the original chat/thread/status message must fail closed.
- If the target session is offline or no longer matches the route, cancellation should fail safely and leave retryable queued work intact rather than pretending a local queue was changed.
- Attachments and media-group content belonging to a cancelled queued turn must not be delivered to pi; downloaded temp files should remain governed by existing session-scoped temp retention rather than being deleted directly from the callback path.

## Codebase grounding

Likely touchpoints:

- `src/shared/types.ts`: extend queued-control state/status values and add cancel request/result types.
- `src/broker/commands.ts`: parse cancel callback data, render `Steer now` and `Cancel` on the same status message, handle idempotent terminal states, preserve route/message validation, and propagate retry_after from callback answers or message edits.
- `src/client/runtime.ts`: add cancellation IPC handling that removes the exact queued or deferred turn atomically and returns already-handled/stale/not-found outcomes without affecting other turns.
- `src/extension.ts`: wire `cancel_queued_turn` IPC and keep control expiry aligned with turns that start, stop, convert, or cancel.
- `src/client/manual-compaction.ts` and `src/client/turn-delivery.ts`: inspect only if the removal/queued metadata paths need small alignment for cancellation.
- `scripts/check-client-turn-delivery.ts`, `scripts/check-manual-compaction.ts`, and `scripts/check-telegram-command-routing.ts`: add focused coverage.
- `README.md` and `AGENTS.md`: update user-facing and agent guidance after behavior exists.

## Acceptance criteria

- A queued follow-up status message offers both `Steer now` and `Cancel` for the same route-scoped queued-control record.
- Activating `Cancel` for a still-queued follow-up removes exactly that queued/deferred turn, marks the broker pending turn consumed or completed, updates/answers Telegram clearly, and prevents the turn from starting later.
- Duplicate cancel callbacks are idempotent; duplicate or later steer callbacks after cancellation do not deliver the cancelled turn.
- Steer conversion followed by cancel, already-started turns, stale/expired controls, wrong-route/wrong-message callbacks, stopped turns, and offline sessions all answer safely without duplicate delivery or unrelated queue mutation.
- Broker failover or retry around a cancelling/cancelled state cannot lose unrelated queued work, cannot resurrect the cancelled follow-up, and cannot duplicate callback side effects.
- Telegram `retry_after` while answering callbacks or editing the queued-status message remains retry-significant; retries do not duplicate cancellation.
- Manual-compaction deferred input preserves order and supports cancellation of a deferred follow-up without starting a concurrent pi turn.
- Existing model-picker callback and queued steer-control regression coverage still passes.

## Out of scope

- Do not redesign queued-turn status into the activity bubble in this slice.
- Do not add multi-user authorization, hosted relay behavior, or broad queue management UI.
- Do not add a generic text `/cancel <message>` command until there is a coherent target-selection UX; a reply-to-status command can be planned later if accessibility testing shows the inline button is insufficient.
- Do not make cancellation delete Telegram temp files immediately; keep cleanup under the existing session-scoped retention model.

## Validation

Run `npm run check` with new targeted cases for cancel success, cancel/steer mutual exclusion, stale and duplicate callbacks, offline route failure, broker failover around cancelling state, retry_after redelivery, and manual-compaction deferred cancellation. Run `pln hygiene` before reporting completion.

## Decisions

- 2026-04-28: Plan cancellation as a sibling action on the existing queued-turn control record rather than a separate queue-management feature, so it shares steer-control route scoping, idempotence, callback validation, and retry behavior.
- 2026-04-28: Keep the first implementation slice inline-button based only; a generic `/cancel <message>` command is out of scope because it lacks a precise target and would overlap with `/stop` or `Steer now` semantics.
- 2026-04-28: Implemented cancel as a second action on the existing queued-turn control token. The broker persists cancelling/cancelled states and the client removes the exact queued or manual-compaction deferred turn before acknowledging consumption, so cancel and steer remain mutually exclusive and retry-safe.
- 2026-04-28: 2026-04-28: Close-out review accepted implementation. Acceptance criteria are covered by targeted command-routing, client-turn, manual-compaction, session-route-cleanup, and full npm run check validation; traced SyRS remain satisfied and final focused review reported no findings where applicable.
