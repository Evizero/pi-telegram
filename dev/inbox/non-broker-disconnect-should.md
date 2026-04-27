---
title: "Non-broker disconnect should not silently leave routes"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "rejected"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: non-broker `/telegram-disconnect` sends `unregister_session` best-effort and ignores IPC failure, then stops the client server and hides local status. If the broker is temporarily unavailable, durable route/topic state can remain even though the user sees a local disconnect.

Evidence:
- `src/pi/hooks.ts` catches and ignores unregister IPC failure for non-broker sessions.

Requirements: `SyRS-unregister-session-route`, `StRS-session-lifecycle-control`.

Fix direction: require unregister acknowledgement before reporting local disconnect success, or persist/retry an explicit unregister request and keep UI/status honest when unregister did not complete.


## Deep-dive triage (2026-04-27)

Status: already fixed / stale as an open inbox item. Non-broker explicit disconnect now writes a durable route-scoped disconnect request under `DISCONNECT_REQUESTS_DIR` before attempting broker IPC. If the broker IPC fails, the client still discards its local route and stops the client server, while broker startup/heartbeat calls `processPendingDisconnectRequests()` to honor the durable request later. Broker handling validates route and connection identity, removes matching routes, pending turns, pending finals, selector selections, and queues topic cleanup. This satisfies the item's retry/persist option; no current best-effort-only unregister path matching the original finding remains.

Rejected reason: Already fixed; non-broker disconnect intent is durable and broker failover/heartbeat processes it.
