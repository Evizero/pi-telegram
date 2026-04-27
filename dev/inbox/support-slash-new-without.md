---
title: "Support slash-new without losing Telegram connection"
type: "request"
created: "2026-04-27"
author: "Christof Salis"
status: "open"
planned_as: []
---
Voice-note transcript (2026-04-27): "Can you investigate, is there a way we could support a slash new command without losing connection?"

Initial interpretation: explore whether pi-telegram can support a Telegram-side /new or pi /new-style workflow that starts a fresh pi conversation/session while preserving the Telegram bridge connection, route/topic, and ability to receive final/activity updates.

## Investigation notes (2026-04-27)

Current pi docs say `/new` emits `session_before_switch`, then `session_shutdown` with reason `new`, then a new extension runtime receives `session_start` with reason `new` and `previousSessionFile`. `ExtensionCommandContext` exposes `newSession()`, but ordinary extension event contexts do not.

Current pi-telegram code disconnects on every `session_shutdown` without checking the reason: it clears media groups, calls `disconnectSessionRoute("shutdown")`, and stops the broker. That explains why native `/new` loses the Telegram bridge.

Likely feasible paths:

- Low-risk auto-reconnect: on session replacement shutdown (`new`, `resume`, `fork`), persist a short-lived "was connected" marker, perform normal route cleanup, then auto-run `connectTelegram(ctx, false)` in the replacement `session_start`. This preserves user convenience but may create a new topic/route.
- Better route continuity: persist a replacement handoff and add broker support to retarget the existing Telegram route/topic from the old sessionId to the new sessionId on replacement startup. This avoids topic churn but needs durable handoff expiry, stale-session safeguards, and pending-turn/final guards.
- Telegram-issued `/new`: not cleanly supported by current pi extension APIs because the actual `newSession()` method is available on command contexts, while Telegram broker/client IPC handlers run from ordinary extension context. A robust remote `/new` would likely need either upstream pi API support for safe session replacement from extension event handlers, or a carefully designed local command-context bridge.


## Deep-dive triage (2026-04-27)

Status: still current. `src/pi/hooks.ts` receives `session_start` reasons but the registered `onSessionStart` implementation in `src/extension.ts` currently ignores the reason and only initializes config/private directories. `session_shutdown` still unconditionally clears media groups, calls `disconnectSessionRoute("shutdown")`, and stops the broker, with no replacement-session handoff for `new`/`resume`/`fork`. I did not find code that preserves or retargets the Telegram route across `/new`, nor a Telegram-issued `/new` implementation. This should remain open as an investigation/request.
