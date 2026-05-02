---
title: "Activity message restarts during same busy turn"
type: "bug"
created: "2026-05-02"
author: "Christof Salis"
status: "planned"
planned_as: ["stabilize-same-turn-telegram-activity"]
---
Source: Telegram voice note transcribed on 2026-05-02.

User observation: while an agent is busy and only activity is being shown in Telegram, the visible activity bubble/message often stops and then a new activity bubble/message starts immediately after it, with no intervening assistant final, steering event, or other Telegram message. This can happen repeatedly. Intended behavior: while the same turn remains active, activity should stay in one coherent Telegram activity message unless something truly interleaves in the chat, such as a final/ordinary message, steering/control interaction, or a deliberate segmentation boundary.

Deep-dive findings from code inspection:

- The strongest cause candidate is the hidden/untitled thinking path in `src/broker/activity.ts` plus `src/shared/activity-lines.ts`.
  - `thinkingActivityLine(false)` without a title renders as active `*⏳ working ...`.
  - `thinkingActivityLine(true)` without a title renders as completed `⏳ working ...`.
  - `ActivityRenderer.handleUpdate()` treats that as a working activity line; on completion it calls `removeActiveWorkingLines(state)`, leaving no line behind if the bubble contained only the transient working row.
  - `ActivityRenderer.doFlush()` deletes the Telegram message when `state.lines.length === 0`.
  - The next activity update for the same active turn then has `state.messageId === undefined`, so `doFlush()` calls `sendMessage` and creates a fresh Activity message.
- Existing behavior checks currently lock this in: `scripts/check-activity-rendering.ts` has `assertHiddenThinkingIsTransient()`, which explicitly expects a hidden-thinking-only activity message to be sent and then deleted after thinking completes.
- The visible-message lifecycle therefore already has a code path that can produce exactly the reported pattern: `sendMessage(Activity: working...)` -> `deleteMessage` on untitled thinking end -> `sendMessage(Activity: ...)` on the next same-turn activity, even though no user-visible final/steer/message happened between those activity updates.
- The normal tool-call path is less suspicious once any durable line exists: completed tool rows remain in `state.lines`, so later untitled working rows should be removed by edit rather than deleting the whole activity message. This means the bug likely shows most often during stretches of untitled thinking before the first visible tool row, between sparse visible events, or in turns where pi emits repeated thinking start/end cycles without titled thinking/tool rows.
- The `activity_complete` segmentation path exists but does not look like the ordinary source of this report. Current normal runtime hooks do not post `activity_complete` during assistant text streaming; final delivery closes activity only when the final is being delivered. An external/legacy `activity_complete` IPC could segment activity, but it is not the primary code path found here.
- A separate lower-probability hypothesis is Telegram typing indicators rather than the visible Activity message. `src/telegram/typing.ts` sends `sendChatAction` every 4000 ms; Telegram typing indicators are inherently temporary and can flicker if network/API timing slips. However the user's wording about one coherent activity message points more strongly at the visible Activity message delete/recreate path above.
- Another lower-probability contributor: `ActivityRenderer.doFlush()` swallows Telegram send/edit/delete failures. If a `sendMessage` fails and leaves `messageId` unset, a later flush will try another `sendMessage`, but this explains missing/duplicate sends more than the observed delete/recreate rhythm.

Splash zone for planning/fix:

- `src/broker/activity.ts`: message lifecycle, hidden working-line handling, deletion when lines become empty, completion behavior, flush/debounce behavior.
- `src/shared/activity-lines.ts`: distinction between untitled working, titled thinking, tool rows, and active/completed normalization.
- Runtime event sources: `src/pi/activity.ts` and the equivalent bootstrap hook code in `src/bootstrap.ts` that translate pi `thinking_start`, `thinking_delta`, `thinking_end`, `tool_call`, and `tool_result` events into activity lines.
- `scripts/check-activity-rendering.ts`: update/add behavior checks. Existing tests currently assert the transient delete behavior and will need to be revised if the intended behavior is a continuous same-turn Activity message.
- `src/telegram/typing.ts`: only if follow-up confirms the report is about Telegram's typing indicator bubble rather than the visible Activity message.

Potential fix directions to evaluate:

1. Keep one turn-scoped visible Activity message alive until finalization/explicit segmentation. When hidden working is the only row and it completes, edit to a stable neutral state or retain last known state instead of deleting immediately.
2. Do not render hidden-only `⏳ working ...` as a visible Activity message until there is a meaningful durable line, but once a message has been sent for a turn, avoid delete/recreate churn before finalization.
3. Treat empty-after-transient as `renderPending=false` while preserving `messageId` and renderer state until the next update or final completion; be careful that Telegram cannot represent an actually empty message, so final cleanup still needs a deliberate delete or finalization step.
4. Add a regression scenario where repeated same-turn untitled thinking start/end cycles and later tool activity produce at most one Activity `sendMessage` before finalization, with edits rather than delete+send churn.


## Screenshot evidence added 2026-05-02

Two Telegram screenshots supplied after the initial capture show the user-visible failure more concretely:

- In a `pln` session screenshot, Telegram shows one Activity message around 16:08 containing an Agent tool call and `rg -n ...`, immediately followed by a second Activity message around 16:08 with edits, thinking lines, a bash command, and another Agent tool call. Later, after an unread separator, a third Activity message around 16:13 appears with another Agent/edit pair. There is no visible assistant final or user steering/control message between the first two Activity messages.
- In a `subject_engine` screenshot, after the user message `Create detailed inbox item with all this` at 16:06, Telegram shows separate Activity messages at 16:07, 16:08, and 16:10 before the next queued-follow-up response. Again, these look like same busy-turn activity bubbles being left behind while a new Activity bubble starts.

This evidence broadens the root-cause hypothesis beyond only the hidden-thinking delete path. The screenshots show older Activity messages still visible, not just a single message being edited/deleted. Concrete mechanisms that can leave an old Activity message visible and start a new one are:

1. **Renderer loses `messageId` while Telegram kept the prior message.** `ActivityRenderer.doFlush()` catches all `sendMessage` failures. If Telegram accepted a `sendMessage` but the HTTP/client side failed before returning `message_id`, `state.messageId` remains undefined. The next flush will call `sendMessage` again, leaving the first Activity bubble in chat and starting another.
2. **Renderer state resets during the active turn.** Activity message state is only in the in-memory `ActivityRenderer.messages` map. `stopBroker()` calls `activityRenderer.clearAllTimers()` and does not persist visible Activity message ids. If the broker stops/restarts/fails over/reloads while the pi turn continues, the old Activity message remains in Telegram; the next activity update reaches a renderer with no state and creates a fresh Activity message. Broker stop paths include session shutdown/replacement, stale lease detection, heartbeat failure, and stale broker/background errors.
3. **Successful empty-state deletion is still relevant but not sufficient.** The previous hidden/untitled thinking analysis explains a delete/recreate variant, especially if `deleteMessage` fails or if a hidden-only message is cleared and later activity starts again. But the screenshots require investigating message-id loss and renderer reset as first-class causes too.
4. **Explicit `activity_complete` segmentation remains lower probability for the normal path.** The ordinary bootstrap/runtime hooks still do not appear to post `activity_complete` during assistant text streaming, but any legacy/external IPC or future hook that completes the current activity while the turn remains live would intentionally freeze an old message and allow a new one.

Follow-up diagnostics/fix ideas from the screenshots:

- Add instrumentation or tests around `sendMessage` ambiguous failure: simulate `sendMessage` visibly succeeding but throwing/returning no `message_id`; verify the renderer does not create repeated Activity bubbles without a dedupe/recovery strategy.
- Add tests for broker/renderer reset mid-turn: create one Activity message, clear/recreate renderer state, then send more updates for the same turn; decide whether expected behavior should persist/recover the message id or deliberately annotate the restart.
- Consider persisting minimal active activity render state in broker state, similar to `assistantPreviewMessages`, so broker turnover can edit/continue the existing Activity message instead of starting over.
- If persistence is too heavy, at least avoid silent failure paths: do not swallow activity `sendMessage` failures without diagnostics, and distinguish retryable/ambiguous send failures from a clean absence of a message id.


## Confirmed root-cause research update (2026-05-02)

Follow-up request: continue researching until confident. Result: the current code definitely can produce multiple visible Activity bubbles for one logical busy turn. The exact production occurrence still needs runtime instrumentation to rank which trigger happened in a specific screenshot, but the code-level mechanisms are now proven/reproducible.

Core invariant discovered:

- `ActivityRenderer` sends a new Telegram Activity message only when its in-memory state has no `messageId` for the activity (`src/broker/activity.ts`, `doFlush()`: `state.messageId === undefined` -> `sendMessage`; otherwise -> `editMessageText`). Therefore same-turn Activity restarts require the renderer to lose/clear/not-record `messageId` while the old Telegram message remains visible, or require a new renderer with no state.

Confirmed mechanisms:

1. **Failed delete after hidden/untitled thinking clears `messageId` anyway.**
   - Normal pi thinking events can create a hidden-only active `⏳ working ...` row.
   - On untitled thinking end, `ActivityRenderer.handleUpdate()` removes active working lines. If no durable row remains, `doFlush()` enters the empty-state branch.
   - The empty-state branch calls `deleteMessage(...).catch(() => undefined)` and then unconditionally sets `state.messageId = undefined`.
   - If deletion fails or is ambiguous, the old Activity message remains in Telegram, but the renderer has forgotten its id. The next same-turn activity calls `sendMessage`, leaving old+new bubbles.
   - This is a P1 defect because the code explicitly discards the reference after a failed/unknown delete.

2. **Ambiguous accepted `sendMessage` without response loses the initial `message_id`.**
   - Initial Activity sends use `sendMessage(...).catch(() => undefined)` and then `state.messageId = sent?.message_id`.
   - If Telegram accepted the message but the response was lost or the client threw, Telegram shows the Activity bubble while the renderer keeps `messageId` undefined.
   - The next flush for the same turn sends another Activity message instead of editing the first.
   - This is a P1/P2 defect because activity sends are not idempotent and failures are fully swallowed.

3. **Broker/renderer state reset mid-turn loses all Activity message ids.**
   - Activity render state lives only in `ActivityRenderer.messages` and is not part of durable `BrokerState`.
   - `stopBroker()` calls `activityRenderer.clearAllTimers()`, which clears messages, activity-id mappings, and closed-id sets without deleting Telegram Activity messages.
   - A new broker/renderer can continue receiving activity updates for a still-active client turn, but it has no remembered Activity `messageId`, so it starts a new bubble.
   - This strongly fits screenshots where several old Activity bubbles remain visible.

4. **Explicit `activity_complete` segmentation is not the normal current path.**
   - The broker has an `activity_complete` IPC handler, and tests cover segmented activity ids.
   - Current bootstrap/runtime pi hooks do not send `activity_complete` during assistant text streaming and do not provide custom `activityId`s for normal thinking/tool activity.
   - Final delivery completes activity, but that should be followed by final delivery, not silent mid-turn restarts.
   - Keep this as lower probability unless runtime traces show `activity_complete` IPC or custom activity ids.

Temporary proof executed during research:

- A throwaway TypeScript repro compiled against the current repo simulated:
  1. hidden thinking start -> Activity `sendMessage`; hidden thinking end -> `deleteMessage` throws; next same-turn tool -> second `sendMessage`;
  2. first `sendMessage` records a visible message but throws before returning `message_id`; next same-turn update -> second `sendMessage`;
  3. renderer reset between two updates with the same `turnId` -> second `sendMessage`.
- All three scenarios reproduced the current behavior: repeated `sendMessage` calls for the same logical turn/activity instead of continued `editMessageText`.
- The temporary repro was removed after execution.

Confidence:

- Code-level confidence is high: repeated Activity bubbles are a direct consequence of non-durable activity `messageId` state and swallowed Telegram send/delete failures.
- Screenshot-specific confidence: the old bubbles remaining visible make hidden-thinking successful delete insufficient by itself. The most likely production causes are failed/ambiguous delete after hidden thinking, ambiguous accepted send, or broker/renderer reset/failover. Runtime logging is needed to distinguish those in a specific live incident.

Fix direction now appears sharper:

- Stop swallowing activity send/delete failures silently; at minimum emit diagnostics with turnId/activityId and operation.
- Do not clear `state.messageId` when `deleteMessage` fails or is ambiguous.
- Treat activity `sendMessage` as non-idempotent; consider persisting visible Activity message refs in broker state before/after send where possible, or designing a recovery path that avoids repeated sends after ambiguous failures.
- Persist enough active Activity render state across broker turnover, or explicitly mark/reconcile old Activity messages when a renderer restarts.
- Revise tests that currently assert hidden-only thinking send/delete as desired behavior; add regressions for delete failure, ambiguous send, and renderer reset.
