---
title: "Silent Telegram notifications for local user mirrors"
type: "request"
created: "2026-04-26"
author: "Christof Salis"
status: "planned"
planned_as: ["send-passive-telegram-mirrors-silently"]
---
Source: Telegram voice note transcribed on 2026-04-26:

> investigate i think it makes sense that messages that the pi user sends you know they also get sent to telegram if the pi user types on the laptop those messages as well as the activity messages should not call notification maybe make an inbox item with this and see the feasibility

Requested behavior:
- When the pi user types locally on the laptop and the bridge mirrors that local user message into Telegram, send the mirror silently so it does not alert Telegram clients.
- Activity/progress messages should also remain silent.

Feasibility notes from code inspection:
- Telegram `sendMessage` accepts `disable_notification`; the bridge already uses `disable_notification: true` for first activity messages in `src/broker/activity.ts`.
- Local pi-user mirror messages flow through `src/pi/hooks.ts` as IPC type `local_user_message`, then `src/extension.ts` `handleLocalUserMessage()`, which calls `sendTextReply()` with `formatLocalUserMirrorMessage(...)`.
- `sendTextReply()` currently has no option to set `disable_notification`, so local-user mirror messages are likely normal notifying messages today.
- A small implementation path is to add a per-call silent option or dedicated silent send helper rather than making every `sendTextReply()` silent, because commands, setup, errors, and final replies may still be expected to notify.
- Activity messages already appear silent on initial `sendMessage`; edits do not create new message notifications. A later audit should confirm all activity-like sends use that path and that preview/final reply behavior is intentionally out of scope unless requirements say otherwise.
