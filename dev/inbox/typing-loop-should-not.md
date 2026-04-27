---
title: "Typing loop should not overlap retry_after waits"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
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
