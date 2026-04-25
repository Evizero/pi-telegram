---
title: "Non-broker disconnect should not silently leave routes"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: non-broker `/telegram-disconnect` sends `unregister_session` best-effort and ignores IPC failure, then stops the client server and hides local status. If the broker is temporarily unavailable, durable route/topic state can remain even though the user sees a local disconnect.

Evidence:
- `src/pi/hooks.ts` catches and ignores unregister IPC failure for non-broker sessions.

Requirements: `SyRS-unregister-session-route`, `StRS-session-lifecycle-control`.

Fix direction: require unregister acknowledgement before reporting local disconnect success, or persist/retry an explicit unregister request and keep UI/status honest when unregister did not complete.
