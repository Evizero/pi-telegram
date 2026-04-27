---
title: "Telegram activity can batch until final during busy turns"
type: "bug"
created: "2026-04-27"
author: "Christof Salis"
status: "planned"
planned_as: ["prevent-telegram-activity-batching"]
---
User observation from 2026-04-27: "i noticed recently that sometimes i stop getting updates in telegram if pi is busy. meaning the activity stops updating and i only get the updates all at once when pi is finished and sends the last message. can you check why that is? it seems like a new thing. deep dive"

Initial note: preserve as a possible regression in activity preview/final flushing while a pi turn is busy. Investigation pending.


## Deep-dive findings (2026-04-27)

Likely regression path found. Activity delivery currently has a head-of-line blocking chain:

1. `src/pi/hooks.ts` posts tool/thinking events through `ActivityReporter.post()`. `src/broker/activity.ts` serializes those posts on a single promise queue to preserve order.
2. Each queued post sends an `activity_update` IPC request to the broker and waits for the broker reply.
3. The broker's `ActivityRenderer.handleUpdate()` awaits `startTypingLoopFor()` before it records the activity line or schedules the debounced activity message flush.
4. `startTypingLoopFor()` in `src/extension.ts` awaits the first `sendChatAction` call, and that call uses the retry-aware Telegram path. If Telegram/network/rate-limit handling stalls, the low-value typing indicator stalls the activity IPC response.
5. Because `ActivityReporter` is serialized, one stuck activity IPC blocks later tool/thinking activity updates behind it.
6. Commit `b1e4802` (`fix(telegram): segment activity around streamed text`, 2026-04-27) added `finishActivityBeforeAssistantText()`, which now waits for `activityReporter.flush()` and an `activity_complete` IPC before posting assistant text previews whenever text starts after activity. That preserves Telegram chronology, but it also makes assistant previews wait behind the same activity/typing bottleneck.
7. `AssistantFinalDeliveryLedger.deliver()` also calls `activityRenderer.complete()` before final delivery, so when the turn ends the queued activity can be drained/flushed immediately before the final. To the Telegram user this looks like no live updates while pi is busy, then a burst of activity updates plus the final answer.

This connects to existing inbox item `typing-loop-should-not`: the typing loop retry/in-flight behavior is not just noisy; because activity rendering awaits typing startup, it can block activity ingestion and, after `b1e4802`, assistant text preview ordering too.

Probable fix direction:

- Make typing indicators advisory and non-blocking for activity/preview ingestion. `ActivityRenderer.handleUpdate()` should not await a retry-aware `sendChatAction` before recording activity.
- Change `startTypingLoopFor()` so the first `sendChatAction` is fire-and-forget or bounded, with per-turn in-flight/retry-until guards so retry_after is honored without overlapping calls.
- Consider moving activity state mutation/scheduling before typing startup, or starting typing outside the serialized activity IPC acknowledgement path.
- Revisit the strict `finishActivityBeforeAssistantText()` barrier: it should preserve chronology, but not let passive activity/typing delivery indefinitely block assistant previews.
- Add regression coverage where `startTypingLoopFor()` never resolves or sleeps for retry_after; activity ingestion, assistant previews, and final delivery should not batch behind it.


## Implementation note (2026-04-27)

Task `prevent-telegram-activity-batching` has been implemented and moved to review with regression coverage for blocked typing startup, preview progress during blocked typing, typing non-overlap, and abort-on-stop cleanup.


## Close-out note (2026-04-27)

Resolved by task `prevent-telegram-activity-batching`; close-out confirmed activity updates and assistant previews no longer wait for blocked typing startup, typing sends do not overlap, and stopped loops abort in-flight retry-aware typing sends.
