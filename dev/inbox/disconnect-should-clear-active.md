---
title: "Disconnect should clear active Telegram turn state"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: explicit `/telegram-disconnect` can unregister/stop the local client route while leaving `activeTelegramTurn`, queued Telegram turns, or abort state alive. A later `agent_end` can still send a final to Telegram using stale route data.

Evidence:
- `src/pi/hooks.ts` local `telegram-disconnect` path calls unregister/IPC, `stopClientServer()`, and hides status.
- `src/extension.ts` final delivery can still use the turn's stored `chatId`/`messageThreadId`.

Requirements: `SyRS-unregister-session-route`, `SyRS-offline-without-deleting-state`, `StRS-session-lifecycle-control`.

Fix direction: make explicit disconnect clear or abort active Telegram-originated turn state and make broker final delivery treat missing/unregistered routes as terminal no-send outcomes.
