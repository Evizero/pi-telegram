---
title: "Default Telegram busy messages to follow-up with steer buttons"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["default-busy-telegram-messages-to"]
---
# Default Telegram busy messages to follow-up with steer buttons

## Source context

Captured from two Telegram voice notes transcribed with local Whisper large on 2026-04-28.

Important source excerpts, preserved as brainstorming input rather than final requirements:

> Most of the time I post something in Telegram, I actually don't want it to steer immediately.
>
> Usually I want it as a follow-up. At the moment we do it the opposite way, where by default it's a steer and for a follow-up I need to use the command slash follow.
>
> If I post something, it is by default a follow-up message.
>
> As soon as the activity starts and the text bubble appears for the agent in Telegram ... this text message should also have a button attached to it, a Telegram button, that says steer.
>
> If I press it, the message gets converted from a follow-up to a steering message.

Follow-up clarification from the second voice note:

> A user could post another message after the first one ... and it's automatically a follow-up ... then the activity starts ... I could write another message from Telegram and it would be another follow-up after the first one and behave like a follow-up in pi currently.
>
> From this point forward probably the first activity bubbles would stop, the button removed, and then after the second message from me arrives a new activity bubble starts after it so chronologically in Telegram it looks correct.
>
> At that point this one probably has two buttons and kind of referencing somehow in a simple way a steering for each of the messages ... think about how this behavior should work and the edge cases and other things I didn't describe that are related.

Third voice note asked for a deeper design/race-condition analysis before any implementation:

> Do a real deep dive on it and how we would do it and how to make sure this doesn't cause any race conditions or weird out of sync things or some other issues that would make the behavior regress.

## Historical behavior and resolved planning pivot

At capture time, implementation and planning intentionally made the opposite default:

- `src/broker/commands.ts` marks only `/follow <message>` as `deliveryMode = "followUp"`; ordinary authorized messages have no delivery mode marker.
- `src/client/turn-delivery.ts` treats an ordinary message delivered while pi is busy as active-turn steering, immediately calls `sendUserMessage(..., { deliverAs: "steer" })`, acknowledges the pending turn, and does not queue it for later.
- `SyRS-busy-message-steers` said ordinary authorized Telegram messages sent while the selected pi session is busy shall steer the active turn by default.
- `SyRS-follow-queues-next-turn` reserved queued follow-up behavior for explicit `/follow` messages.
- `StRS-busy-turn-intent` only required the operator to be able to choose steer vs follow-up; it did not inherently require steer to be the default.

Planning accepted the pivot on 2026-04-28: `SyRS-busy-message-steers` is deprecated, `SyRS-busy-message-default-followup` and `SyRS-queued-followup-steer-control` define the replacement behavior, and task `default-busy-telegram-messages-to` carries the planned implementation slice. The notes below remain source/context material, not current normative requirements.

## Problem statement

When supervising pi from Telegram, the operator often sends thoughts that should become the next turn after the active work settles, not immediate steering for the current run. The existing default optimizes for urgent mid-turn correction. The new idea optimizes for ordinary mobile note-taking and follow-up composition, while still preserving a low-friction way to convert a queued follow-up into steering when the operator decides it is urgent.

The product question is: can Telegram make follow-up the default for busy sessions without making urgent steering harder than it should be, and can the Telegram transcript remain chronologically intelligible when several queued follow-ups each expose their own possible steer action?

## Goals for a future design

1. Ordinary Telegram messages sent while the selected pi session is busy should default to queued follow-up work.
2. The operator should be able to convert a queued follow-up into steering with a Telegram inline button rather than retyping the message or remembering a command.
3. The Telegram transcript should make the chronological relationship clear: queued message, activity for the turn it eventually starts, final answer, then next queued message/activity, etc.
4. Multiple queued follow-ups should remain distinct. A steer action must target a specific queued message or queued group, not an ambiguous "latest" message.
5. Existing explicit controls should remain understandable: `/stop`, `/status`, `/compact`, `/model`, `/disconnect`, session selection, media groups, and attachments should not be accidentally converted into steer/follow-up ambiguity.
6. Retry, broker failover, callback redelivery, and duplicate Telegram updates should not cause a queued message to both steer and later run as a follow-up.

## Non-goals / likely out of scope for the first slice

- Do not remove the ability to steer during a busy run.
- Do not make Telegram callback text the authority for local execution; button presses should refer to durable broker/client state by compact token or turn ID.
- Do not use this inbox item as direct implementation authorization; it needs requirements and task planning first.
- Do not redesign pi's own follow-up semantics unless investigation proves the bridge cannot express the desired behavior through existing `deliverAs` options.
- Do not make activity bubbles durable session history. They are still Telegram view state and should follow existing cleanup/finalization rules.

## Existing mechanisms that may help

- `PendingTelegramTurn.deliveryMode` already has `"steer" | "followUp"` shape in `src/shared/types.ts`.
- The client already knows how to queue follow-up work behind active work and how to send follow-up turns with `deliverAs: "followUp"` in `src/extension.ts` and manual-compaction paths.
- Telegram callback handling and inline keyboards already exist for the model picker. `docs.md` records the important callback constraints: `callback_data` is limited to 1-64 bytes, callbacks must be authorized by paired user/chat, and handled callbacks should call `answerCallbackQuery` while preserving `retry_after` behavior.
- `ActivityRenderer` already creates and edits Telegram activity messages, but it currently only renders passive activity text and does not attach inline keyboards.

## Design sketch A: default busy messages become queued follow-ups

High-level behavior:

1. User sends ordinary message while selected session is busy.
2. Broker creates a durable pending turn with `deliveryMode = "followUp"` by default for the busy case.
3. Client accepts it into `queuedTelegramTurns` rather than steering the active pi turn.
4. Telegram receives an acknowledgement/status message or later activity message that exposes a `Steer now` action for that specific queued turn.
5. If the user never presses the button, the queued turn starts normally after the current active turn/finals settle.
6. If the user presses the button before the queued turn starts, the system removes/suppresses that queued turn and sends its content as active-turn steering exactly once.

Open question: should ordinary Telegram messages sent while the session is idle still start a normal turn immediately? The voice note appears to discuss busy sessions specifically. Idle behavior likely should stay as it is.

## Design sketch B: put steer buttons on activity messages

The user specifically suggested attaching buttons to the agent activity bubble. That has a nice property: the operator is already watching current work, so the steer affordance appears near the live run it would affect.

Possible shape:

- Activity message for active turn includes a row like `Steer queued #1`, `Steer queued #2` when there are queued follow-ups eligible to steer the current turn.
- Button label needs a compact reference because callback labels cannot include full message text. Examples:
  - `Steer #1`
  - `Steer latest`
  - `Steer: <short excerpt>` if label length stays safe
- Callback data should be a compact token, not raw message text. The token resolves to `{ routeId, sessionId, queuedTurnId, targetActiveTurnId? }` in broker/client state.

Risk: `ActivityRenderer` is currently a broker-side renderer of activity payloads, while the queued-turn state that must be mutated lives partly in broker durable state and partly in the client queue. Planning should decide whether the button is owned by broker activity rendering, by a separate "queued controls" renderer, or by a client-mediated status update.

## Design sketch C: separate queued-message status instead of activity buttons

An alternative is to send a small silent Telegram message when a busy message is queued:

`Queued as follow-up #2` with buttons `Steer now` / maybe `Cancel`.

Pros:

- The button is attached directly to the queued user message/status, so mapping is simpler.
- No need to overload the activity renderer with queue controls.
- It can remain visible even if the activity bubble is completed or deleted.

Cons:

- More Telegram message noise.
- The user specifically asked to explore activity-bubble controls and chronological activity flow.
- Need cleanup rules so stale buttons do not linger after the queued message starts or after the current turn ends.

## Multiple queued follow-ups and chronological display

The second voice note raises the hard case:

1. Active pi turn is running.
2. User sends message A from Telegram. It becomes queued follow-up A.
3. Activity for the current active turn continues and may show a button to steer A.
4. User sends message B from Telegram before A starts. It becomes queued follow-up B, behind A.
5. The current activity bubble probably should stop offering stale controls when it completes.
6. When A eventually starts and has its own activity bubble, Telegram should make it clear A is now running and B is still queued behind it.
7. If B is eligible to steer A, A's activity bubble may show a button for B.

Key design decision: a follow-up should probably only be steerable into the currently active turn while it is still queued and before it has started. Once a queued follow-up starts as its own turn, it is no longer convertible; later messages can steer or queue relative to that new active turn according to the default behavior.

## Edge cases to settle before implementation

### Button timing

- What happens if the user presses `Steer` after the active turn already ended?
  - Likely answer: answer callback with "Too late; this follow-up is already queued/running" and leave queue unchanged.
- What happens if the queued follow-up has already started as the next turn?
  - Likely answer: callback expires; do not also steer it.
- What happens if the callback arrives twice or Telegram redelivers it?
  - Must be idempotent: at most one conversion from queued follow-up to steering.

### Final delivery and turn advancement

- Current final delivery owns FIFO delivery and calls activity completion before final text. Converting queued work to steering must not cause final text ordering to skip or duplicate.
- If a queued turn is converted to steering, the pending-turn ledger must mark it consumed/suppressed so retry does not later deliver it as a normal queued turn.

### Attachments and media groups

- If a busy Telegram message includes attachments and defaults to follow-up, can it be steered into the current turn later?
  - If yes, confirm pi `sendUserMessage` steering can carry the same content and attachment references safely.
  - If no, button should be omitted or disabled for attachment-heavy turns with a clear reason.
- Media groups are debounced and persisted before dispatch. The button mapping should target the final grouped turn, not individual late media-group updates.

### Manual compaction

- At capture time, `SyRS-defer-telegram-during-compaction` said while Telegram-started manual compaction is running, ordinary messages and `/follow` are held; after compaction finishes, the first deferred item starts the next turn, later ordinary messages steer that turn, and later `/follow` remains queued.
- Planning has since revised that requirement to resume deferred input using each input's explicit or default delivery semantics, so implementation should test the new default-follow-up behavior at the compaction boundary.

### Commands versus messages

- Slash commands should keep command semantics, not become queued follow-ups.
- `/follow` may remain as an explicit "queue this" command for users who like commands, become redundant, or be repurposed only as a compatibility alias. Planning should decide.
- A new explicit steer command such as `/steer <message>` might still be useful for accessibility, clients that hide inline keyboards, or cases where callbacks expire.

### Activity-message lifecycle

- Activity messages are passive visibility updates and are currently sent with `disable_notification: true`.
- Adding buttons changes them from passive status to interactive control surfaces. Planning should decide whether they remain silent and whether docs should still classify them as passive visibility updates.
- On activity completion, buttons should be removed or made inert so stale controls do not imply conversion is still possible.

### Broker failover and reconnect

- Callback tokens and queued-turn conversion state must survive broker lease turnover if the button is still visible and actionable.
- If the client disconnects or session route is cleaned up, visible buttons should answer with expired/unavailable rather than enqueue work into a dead session.
- Replacement handoff should preserve queued controls only when the route/queued turns are retargeted safely to the replacement session.

### Multi-session and topics

- Buttons must preserve route and topic context. A steer callback in session A's topic must not steer session B.
- In single-chat mode without topics, the callback token must still identify the selected route/session at the time the button was created; it should not follow a later `/use` selection accidentally.

### Security and privacy

- Callback data should contain only compact opaque tokens, not message text, file paths, model IDs, or secrets.
- Authorization must match existing callback rules: paired user, allowed chat, and valid route/session.
- Button labels should avoid leaking long user prompts into chat UI beyond what was already visible in the user's own Telegram message.

## Planning implications resolved into current plan

Requirement changes accepted on 2026-04-28:

- Deprecated `SyRS-busy-message-steers` instead of treating steer-by-default as the current baseline.
- Kept `StRS-busy-turn-intent` as the stakeholder anchor and updated validation criteria for default-follow-up plus explicit steer controls.
- Updated `SyRS-follow-queues-next-turn` so `/follow` remains a compatibility/accessibility command for queued work.
- Added `SyRS-busy-message-default-followup` for the new default behavior.
- Added `SyRS-queued-followup-steer-control` for callback-driven conversion of queued follow-ups into steering, including idempotence and route authorization expectations.
- Revised `SyRS-defer-telegram-during-compaction` so deferred input resumes with each input's current explicit/default delivery semantics.

Remaining future planning concern: update `docs.md` inline-keyboard/activity policy if a later implementation integrates controls into activity bubbles rather than the first-slice queued-status message.

## Suggested investigation tasks for planning, not implementation yet

1. Decide whether default-follow-up applies only while selected session is busy, or also to other transient blocked states such as manual compaction and retry-aware finalization.
2. Decide whether the steer affordance belongs on the activity bubble, on a queued-status message, or both.
3. Define the lifecycle of a queued follow-up: queued, steer-offered, converted-to-steer, started-as-turn, expired/cancelled, delivered/finalized.
4. Define exact idempotence rules for callback redelivery and broker retry.
5. Decide what to do with attachments/media groups when converting a queued follow-up into steering.
6. Decide whether `/follow` remains documented, is deprecated, or simply becomes a no-op alias for default behavior during busy turns.
7. Consider adding `/steer <message>` as an accessibility/compatibility escape hatch even if inline buttons are the main UX.

## Deeper implementation model

The safe implementation probably needs to introduce an explicit queued-control state instead of trying to infer everything from the current `queuedTelegramTurns` array and visible activity text.

A plausible new broker-state entity:

```ts
interface QueuedTurnControlState {
  token: string;                 // compact callback token, e.g. tq:<nonce>
  turnId: string;                // pending follow-up turn this controls
  routeId: string;
  sessionId: string;
  chatId: number | string;
  messageThreadId?: number;
  targetActiveTurnId?: string;   // active turn that can receive this as steering
  status: "offered" | "converting" | "converted" | "started" | "expired";
  sourceMessageId?: number;      // original user message or queued-status msg
  activityMessageId?: number;    // optional activity bubble carrying the button
  createdAtMs: number;
  updatedAtMs: number;
  expiresAtMs: number;
  conversionAttemptId?: string;  // optional idempotence marker
}
```

Key point: the callback token should resolve to a durable state row. Do not encode message text, file paths, or mutable selector state in `callback_data`.

Suggested state ownership split:

- Broker owns Telegram updates, callback authorization, durable pending turns, visible button metadata, and retry/failover semantics.
- Client owns the in-memory active/queued turn arrays and the actual call to `pi.sendUserMessage`.
- Conversion from queued follow-up to steering should therefore be an explicit client IPC operation, for example `convert_queued_turn_to_steer`, rather than a broker directly mutating only durable `pendingTurns` and hoping the client's local queue follows.

Possible IPC request:

```ts
{
  type: "convert_queued_turn_to_steer",
  payload: {
    turnId: string,
    targetActiveTurnId?: string,
    conversionToken: string,
  }
}
```

Possible client result categories:

- `converted`: queued turn was removed from the local queue or deferred compaction remainder and sent once with `{ deliverAs: "steer" }`.
- `already_converted`: duplicate callback; do not send again.
- `already_started`: turn is active or completed; too late to convert.
- `not_found`: broker/client state is stale; expire the visible control.
- `no_active_turn`: active turn ended before conversion; leave as queued or expire according to chosen UX.
- `wrong_active_turn`: target active turn changed; do not steer a different run accidentally.

## Recommended flow to avoid races

### 1. Busy message ingestion

When `TelegramCommandRouter.dispatch()` receives an ordinary non-command message for a busy selected session, it should mark the new `PendingTelegramTurn` as `deliveryMode = "followUp"` if the new default is adopted.

Race concern: broker session status can lag actual client state. The client should remain authoritative. A safe split is:

- Broker may set a desired default based on visible status, but client must still enforce final delivery semantics.
- If the client is actually idle by the time `deliver_turn` arrives, it can start the turn normally; the turn may still have `deliveryMode = "followUp"`, which is acceptable for a first queued follow-up if pi supports it.
- If the client is busy, it queues the turn and reports enough queue/control metadata back to the broker for buttons.

This argues for extending the deliver-turn response from `{ accepted: true }` to something like `{ accepted: true, queued?: true, activeTurnId?: string }`, or for a separate broker IPC from client back to broker after queueing. Without this, the broker has to guess whether a button should exist.

### 2. Offer steer controls only after the client confirms queue state

Do not create a steer button merely because broker persisted a pending turn. The button should be created only when the client has accepted the turn into a queue that can be converted.

This avoids a visible button for a turn that already started because the session became idle between update handling and IPC delivery.

### 3. Conversion must be atomic on the client side

The core race is between `startNextTelegramTurn()` shifting the next queued turn and a callback trying to convert that same turn to steering.

The client-side conversion operation should synchronously perform one critical section on its in-memory state:

1. Check `activeTelegramTurn` still matches `targetActiveTurnId` if one was provided.
2. Find `turnId` in `queuedTelegramTurns` or in `ManualCompactionTurnQueue`'s pending remainder.
3. Remove it from that queue before sending anything to pi.
4. Mark it completed/consumed locally enough that duplicate delivery cannot re-queue it.
5. Call `pi.sendUserMessage(turn.content, { deliverAs: "steer" })`.
6. Acknowledge consumption to broker only after the local conversion decision has been made.

The important invariant is remove-before-send. If sending throws synchronously, the system needs a conscious policy: either reinsert the turn or mark conversion failed. Since `pi.sendUserMessage` is currently fire-and-forget in several places, planning should verify whether it can throw synchronously and whether conversion needs a confirmed-send wrapper.

### 4. Broker callback handling should be two-phase but idempotent

A safe callback flow:

1. Authorize callback by paired user/chat and route/topic exactly like model picker callbacks.
2. Load `queuedTurnControls[token]`.
3. If missing/expired/terminal, `answerCallbackQuery` with expired/too-late and optionally edit the visible message to remove controls.
4. If status is `converted`, answer as already handled and do not call client again.
5. Set status to `converting` with `updatedAtMs` and persist before IPC.
6. Call client `convert_queued_turn_to_steer`.
7. On `converted`, mark control `converted`, delete the durable `pendingTurns[turnId]` or mark it completed through the same consumed-turn path, persist, and edit/remove buttons.
8. On too-late results, mark `started` or `expired`, persist, and remove buttons.
9. On retryable Telegram edit/answer `retry_after`, throw so polling offset is not advanced through the rate limit window.

If broker crashes after step 5 but before step 7, the next broker should not get stuck forever in `converting`. Use a short conversion lease, e.g. statuses older than 30 seconds can be retried by another broker only after confirming the client still has the turn queued. Do not blindly send steering again.

### 5. Pending-turn ledger must stay single-source-of-truth for retry

Current broker behavior stores every incoming turn in `brokerState.pendingTurns` before IPC delivery and deletes it on `turn_consumed` or final acceptance. Conversion must integrate with that existing lifecycle:

- If a turn converts to steering, it should become consumed from the perspective of pending-turn retry.
- `completedTurnIds` should include the converted turn so duplicate update redelivery or ambiguous IPC retry does not later enqueue it as a follow-up.
- If conversion fails before the client sends steering, the pending turn should remain queued and retryable, not disappear.
- If conversion succeeds but broker fails before persisting consumed state, duplicate callback or pending-turn retry must be recognized by the client via a conversion idempotence marker or local completed-turn memory.

This is the highest-risk correctness area. A future implementation should write tests that simulate broker persistence failure boundaries around conversion.

## Activity-button placement recommendation

The activity-bubble button is attractive but should not be the first persistence owner. The safer design is:

1. Broker/client first implement durable queued-turn controls independent of activity rendering.
2. Activity rendering may then display a projection of the currently offered controls.
3. The activity bubble must not be the only place that knows which turn a button controls.

If the activity message carries the buttons:

- `ActivityRenderer` needs an input that includes reply markup or a control lookup. Today it only receives activity lines and renders text.
- `doFlush()` must include `reply_markup` on both `sendMessage` and `editMessageText` while controls are active.
- `completeActivity()` must remove reply markup before deleting local state, or edit the final activity text without markup. Otherwise stale buttons can remain attached to completed activity.
- If editing fails with a non-rate-limit Telegram error, the durable control should still expire so callbacks answer safely. Visible stale buttons are acceptable only if callback handling rejects them.

A lower-risk first UI may be a separate silent queued-status message with the button, then later attach a summary/button row to activity messages once the conversion lifecycle is solid. The inbox item should keep the activity-bubble UX as the desired direction, but planning may choose a staged implementation.

## Race-condition inventory

### Callback versus turn start

Scenario: final delivery completes, `startNextTelegramTurn()` shifts queued turn A into `activeTelegramTurn`, and at the same time the user presses `Steer A`.

Required outcome: A starts once, either as its own follow-up turn or as steering, never both.

Guard: client conversion checks and removes from queue atomically. If A is already active or completed, callback returns too late.

### Callback versus duplicate pending-turn retry

Scenario: broker delivered turn A, client queued it, callback converts A to steering, but broker still has `pendingTurns[A]` because a `turn_consumed` acknowledgement was lost.

Required outcome: retry does not re-deliver A as a follow-up.

Guard: client `completedTurnIds` already handles completed turn re-delivery; conversion should add A to that set before/when steering is sent. Broker should also persist consumed/completed state after successful conversion.

### Callback versus broker failover

Scenario: old broker receives callback and sets control status to `converting`, then loses lease or dies.

Required outcome: new broker can recover without duplicate steering or permanent stuck buttons.

Guard: persist conversion status with lease/updated timestamp; retry only after checking client state. Treat stale `converting` as unknown, not as permission to send steering again.

### Activity flush versus control changes

Scenario: activity renderer is editing an activity message while queued controls are added/removed.

Required outcome: text edits do not resurrect stale buttons or drop active buttons accidentally.

Guard: activity state should have a `renderPending` flag for both text and markup changes, just like recent activity-stall fixes. Edits should render from current state, not from captured stale markup.

### Activity completion versus callback

Scenario: final delivery calls `activityComplete()` while user taps a button on that activity message.

Required outcome: either conversion wins before completion, or callback is answered too late. No hidden queue mutation after finalization.

Guard: completion marks related controls expired before or during markup removal. Callback handler checks control status, not visible button presence.

### Manual compaction boundary

Scenario: compaction finishes and `ManualCompactionTurnQueue.startDeferredTurnIfReady()` moves first queued turn into active state while later callback tries to steer that same first turn.

Required outcome: no duplicate turn and no skipped queued item.

Guard: expose conversion/removal operations for both `queuedTelegramTurns` and `ManualCompactionTurnQueue.pendingRemainder`; do not let external code mutate those arrays indirectly.

### Attachments and temp-file lifetime

Scenario: queued follow-up with downloaded Telegram attachments is converted to steering, or is left queued across reconnect/replacement.

Required outcome: attachment paths remain available for whichever delivery mode actually happens and are cleaned according to session lifecycle, not prematurely after button expiry.

Guard: conversion changes delivery mode only; it must not delete temp files or queued attachments. Temp cleanup remains session lifecycle/final cleanup owned.

### Stop command versus conversion

Scenario: user presses `Steer A` while `/stop` aborts active turn and clears queued turns.

Required outcome: stop wins cleanly or conversion wins cleanly; no steering into an aborted context and no resurrected queued turn.

Guard: client abort path clears queued turns and marks them completed/suppressed. Conversion should reject turns no longer present and broker should expire their controls.

### Session replacement handoff

Scenario: old session is replaced through `/new`, `/resume`, or `/fork` while queued controls exist.

Required outcome: controls either retarget only with the session replacement handoff or expire; they must not point at the old dead client socket.

Guard: queued-control state should include `sessionId`, `routeId`, and maybe connection/replacement context. Broker retargeting must update control state together with routes, pending turns, selector selections, and finals, or explicitly expire controls.

## Implementation staging recommendation

A staged plan would reduce regression risk:

1. Completed planning baseline: revise StRS/SyRS and architecture so default-follow-up is an accepted UX, not a contradiction of deprecated `SyRS-busy-message-steers`.
2. During implementation, add broker/client tests around the existing/new behavior before changing it, especially `check-client-turn-delivery.ts`, `check-telegram-command-routing.ts`, `check-manual-compaction.ts`, and activity rendering checks.
3. Introduce durable queued-control state and callback parsing as its own implementation seam.
4. Add client IPC to convert a queued follow-up to steering, with tests for duplicate callback, already-started, not-found, stop, broker failover/ambiguous conversion persistence, and manual-compaction remainder cases.
5. Add a conservative UI, probably a silent queued-status message with a `Steer now` button, to validate the lifecycle.
6. Invert the busy ordinary-message default to follow-up only with that state machinery in place.
7. Finally integrate controls into activity bubbles later if the separate queued-status UI proves too noisy or does not meet the desired chronology.

This order keeps the riskiest semantic change behind tested state machinery.

## Files likely affected by a future implementation

- `dev/STAKEHOLDER_REQUIREMENTS.json`: update `StRS-busy-turn-intent` validation wording if default-follow-up becomes accepted.
- `dev/SYSTEM_REQUIREMENTS.json`: revised `SyRS-busy-message-steers`, revised `SyRS-follow-queues-next-turn`, added callback conversion/idempotence requirement, revisited manual compaction deferred-order requirement.
- `dev/ARCHITECTURE.md` and `SPEC.md`: update busy-turn control, activity-message, callback, and manual-compaction sections.
- `docs.md`: update inline-keyboard/activity policy if activity messages become interactive.
- `src/shared/types.ts`: add durable queued-control state and maybe IPC/result types.
- `src/broker/commands.ts`: choose default `deliveryMode`, dispatch new steer callbacks, persist/expire controls.
- `src/broker/activity.ts`: optionally render reply markup on activity messages and remove it on completion.
- `src/broker/updates.ts`: no major shape change expected, but callback dispatch must route the new callback family before unsupported-button fallback.
- `src/client/turn-delivery.ts`: return queue/control metadata and avoid immediate steering for ordinary busy messages under the new default.
- `src/client/runtime.ts` / `src/extension.ts`: add `convert_queued_turn_to_steer` IPC handler and client critical section.
- `src/client/manual-compaction.ts`: expose safe lookup/remove/convert behavior for pending remainder instead of only enqueue/drain/clear.
- `scripts/check-client-turn-delivery.ts`, `scripts/check-telegram-command-routing.ts`, `scripts/check-manual-compaction.ts`, `scripts/check-activity-rendering.ts`: add regression coverage.

## Key invariants for future requirements

1. A Telegram-originated turn has exactly one terminal delivery path: queued follow-up, converted steering, aborted/suppressed, or terminal failure.
2. A queued turn converted to steering must not later start as its own follow-up turn.
3. A queued turn that starts as its own follow-up must not later be converted to steering.
4. Callback handling must be authorized, route-scoped, idempotent, and retry-after aware.
5. Visible Telegram buttons are hints, not authority; durable control state decides whether an action is still valid.
6. Activity completion/final delivery must remove or invalidate controls before the final answer makes the old activity context obsolete.
7. Broker failover and session replacement must not widen the target of a steer action beyond the original route/session context.
8. `/stop` and explicit disconnect must suppress/expire queued controls together with queued turns.

## Draft validation ideas for later tasks

- Busy ordinary message queues as follow-up by default and does not call pi with `deliverAs: "steer"` unless converted.
- Pressing the steer button before the active turn ends removes/suppresses the queued follow-up and sends its content once as steering.
- Duplicate callback delivery does not duplicate steering and does not leave a queued turn behind.
- Pressing the button after the queued turn started produces an expired/too-late callback answer and no extra pi message.
- Two queued follow-ups expose distinct controls; steering B does not accidentally steer A.
- Activity completion removes or invalidates buttons from that activity bubble.
- `/follow` compatibility behavior is covered explicitly according to the chosen planning decision.
- Manual compaction ordering is revalidated under the new default.
- Callback controls survive or expire safely across broker turnover and session replacement handoff.
