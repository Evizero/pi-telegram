---
title: "Typing loop should not overlap retry_after waits"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "rejected"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: typing loop schedules `sendChatAction` every 4 seconds even if the previous call is still sleeping inside retry handling for Telegram `retry_after`.

Evidence:
- `src/extension.ts` `startTypingLoopFor()` schedules repeatedly without an in-flight or retry-until guard.

Requirement: `SyRS-telegram-retry-after`.

Fix direction: track in-flight/retry-until state per typing loop and skip new typing sends while a retry-aware send is still pending or suppressed by flood control.


## Deep-dive triage (2026-04-27)

Status: still current. `startTypingLoopFor()` in `src/extension.ts` still sends one immediate `sendChatAction` and then installs `setInterval(() => void sendTyping(), 4000)`. `sendTyping()` calls the retry-aware `callTelegram()` path and swallows errors, but there is no in-flight flag, retry-until timestamp, or interval suppression while a prior `withTelegramRetry()` wait is still pending. This should remain open.


## Related deep-dive finding (2026-04-27)

The Telegram activity batching investigation found this issue is likely a direct contributor to live-update stalls. `ActivityRenderer.handleUpdate()` awaits `startTypingLoopFor()` before recording activity, and `startTypingLoopFor()` awaits retry-aware `sendChatAction`. Because `ActivityReporter` serializes activity IPC sends, a blocked first typing send can hold all later activity updates; after commit `b1e4802`, assistant text previews can also wait behind `activityReporter.flush()` before text starts. Fixing typing-loop in-flight/retry handling should also ensure typing startup does not block activity/preview ingestion.


## Planning handoff (2026-04-27)

Related to ready task `prevent-telegram-activity-batching`, which covers both the original typing-loop retry/in-flight concern and the newer activity batching regression caused by awaiting typing startup in the activity IPC path. This inbox item remains open because `pln inbox` currently cannot link an existing inbox item to an already-created task without accepting it as a duplicate task; close or reject it during implementation close-out once the task demonstrably covers the typing-loop concern.


## Implementation note (2026-04-27)

Task `prevent-telegram-activity-batching` now includes an advisory typing controller with per-turn in-flight suppression and abort-on-stop behavior. Leave this inbox item open until task close-out/archive confirms the implementation and commits are durable.


## Close-out note (2026-04-27)

Resolved by task `prevent-telegram-activity-batching`; the implementation added per-turn in-flight suppression and abort-on-stop for typing actions. Marked rejected rather than planned because the work was covered by the already-created activity batching task instead of accepting this item as a duplicate task.
