---
title: "Telegram attachment tmp cleanup should follow session lifetime, not broker shutdown"
type: "observation"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["implement-session-scoped-telegram-temp"]
---
Source prompt (2026-04-28): "i want to think of when to clear the tmp files (attachments) locally maybe when broker closes? investigate"

## Investigation notes

Current behavior:
- Inbound Telegram files are downloaded to `~/.pi/agent/tmp/telegram/<sessionId>/` in `src/telegram/api.ts`.
- `src/shared/config.ts` defines `TEMP_DIR` as `~/.pi/agent/tmp/telegram`.
- `src/client/attachment-path.ts` allowlists that temp root for outbound `telegram_attach` paths.
- `src/extension.ts` creates `TEMP_DIR` on session start, but I did not find runtime cleanup for downloaded attachment files or per-session temp directories.

Why broker shutdown is the wrong cleanup boundary:
- `stopBroker()` in `src/extension.ts` is used for broker failover / lease loss paths, not only intentional session teardown.
- Durable pending turn/final state can survive broker changes.
- `handleTurnConsumed()` removes durable pending-turn state before the client session is necessarily done using the local attachment path during the active run.
- A broker-scoped cleanup could therefore delete files still needed by an in-flight session or retry path.

Current architecture signals:
- `src/pi/hooks.ts` disconnects the Telegram route on `session_shutdown` and then stops the broker.
- `src/extension.ts` `disconnectSessionRoute("shutdown")` already treats shutdown as a stronger lifecycle boundary than ordinary broker turnover.
- `dev/ARCHITECTURE.md` and `README.md` document downloaded Telegram files under `~/.pi/agent/tmp/telegram/` but do not currently define a retention/cleanup policy.

Local evidence from this machine during investigation:
- `~/.pi/agent/tmp/telegram/019dd2ee-3528-77f7-b973-dd285fb82bc8/` still exists with a downloaded voice note and derived transcript.
- Active broker state was under `~/.pi/agent/telegram-broker/bot-8663783196/state.json` for a different live session, with no pending turns/finals.
- This shows stale temp session dirs can accumulate today.

## Direction to plan later

Safest cleanup policy found so far:
1. Keep inbound Telegram temp files for the lifetime of the pi session / Telegram route.
2. Delete `TEMP_DIR/<sessionId>` on authoritative session end such as explicit `/disconnect`, normal `session_shutdown`, or stale-session teardown after reconnect grace really expires.
3. Add a broker-side orphan sweeper as backup: remove old session temp dirs only when there is no live session, no pending turns/finals for that session, and the dir is older than a conservative TTL.

Open question for planning: whether session replacement flows like `/new`, resume, or fork should preserve or transfer the temp dir instead of deleting it immediately.
