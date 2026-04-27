---
title: "Disconnect should clear active Telegram turn state"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "rejected"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: explicit `/telegram-disconnect` can unregister/stop the local client route while leaving `activeTelegramTurn`, queued Telegram turns, or abort state alive. A later `agent_end` can still send a final to Telegram using stale route data.

Evidence:
- `src/pi/hooks.ts` local `telegram-disconnect` path calls unregister/IPC, `stopClientServer()`, and hides status.
- `src/extension.ts` final delivery can still use the turn's stored `chatId`/`messageThreadId`.

Requirements: `SyRS-unregister-session-route`, `SyRS-offline-without-deleting-state`, `StRS-session-lifecycle-control`.

Fix direction: make explicit disconnect clear or abort active Telegram-originated turn state and make broker final delivery treat missing/unregistered routes as terminal no-send outcomes.


## Deep-dive triage (2026-04-27)

Status: already fixed / stale as an open inbox item. Explicit `/telegram-disconnect` now flows through `disconnectSessionRoute()` and clears local route state via `discardTelegramClientRouteState()` or `shutdownClientRoute()`. Those paths cancel/defer finalization state, clear `currentAbort`/`awaitingTelegramFinalTurnId`, remember disconnected active and queued turns, reset manual-compaction state, clear queued turns and `activeTelegramTurn`, and clear pending assistant-final handoff state through `shutdownTelegramClientRoute()`. Broker-side route-scoped cleanup in `honorExplicitDisconnectRequestInBroker()` also removes matching pending turns/finals and cancels pending final deliveries. I did not find a remaining path where an explicit disconnect leaves an active Telegram turn that later sends a stale final.

Rejected reason: Already fixed; explicit disconnect now clears local active/queued turn state and broker route-scoped pending work.
