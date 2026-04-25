---
title: "Telegram topics not cleaned up after session closes"
type: "bug"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["clean-up-telegram-topics-when-sessions"]
---
User noticed that often when a pi session connected to Telegram is closed, dies, or otherwise goes away, the corresponding Telegram topics are no longer deleted.

Expected behavior from user: when the connection is closed, including session disappearance by any path, the Telegram topic is cleaned up.

Initial request: investigate and report back.


## Investigation notes — 2026-04-25

Current implementation intentionally distinguishes session shutdown/offline from unregister:

- `src/pi/hooks.ts` session_shutdown clears local transient state, then calls `markSessionOffline` / IPC `mark_session_offline`, not `unregisterSession`.
- `src/broker/sessions.ts` `markSessionOfflineInBroker` only sets the session offline, clears active liveness, and preserves routes. It does not call `deleteForumTopic`.
- `src/broker/updates.ts` stale heartbeat handling also only marks sessions offline after `SESSION_OFFLINE_MS` and preserves routes/topics.
- `src/broker/sessions.ts` `unregisterSessionFromBroker` is the only observed path that removes routes and calls Telegram `deleteForumTopic`. It is reached by explicit `/telegram-disconnect` in pi and Telegram `/disconnect`.
- `docs.md` currently says bridge policy is to only delete topics on explicit disconnect/unregister, not temporary shutdown/offline transitions.
- `dev/SYSTEM_REQUIREMENTS.json` currently contains `SyRS-offline-without-deleting-state`, requiring shutdown to preserve durable routes. This conflicts with the user-stated expected behavior that topics are cleaned up whenever the connection closes or the session goes away.

Likely source/change: commit `7ae9e6d` introduced the broker/session lifecycle split; commit `8e1ca3e` codified the offline-without-deleting-state requirement.

Additional caveats found: explicit unregister swallows `deleteForumTopic` failures and removes route state anyway, so rate limits/permission/network errors can still leave orphaned topics. Non-broker `/telegram-disconnect` also catches and ignores unregister IPC failure; this is already separately captured in `non-broker-disconnect-should`.


## User direction — 2026-04-25

The project owner clarified that Telegram topics/routes are temporary connection-scoped views, not durable session history. Closing a pi process, explicit disconnect, death, or crash should clean up the Telegram topic after the built-in automatic reconnect window has failed. Continuing work via native pi `/resume` can reconnect Telegram later in a new topic because durable session history lives on the machine, not in Telegram.

Captured verbatim reference: `telegram-views-are-connection-scoped`.
