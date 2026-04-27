---
title: "Selector and forum topic routing should preserve route identity"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "rejected"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: route identity can be lost or mismatched. `/use` stores only a selected session id, while turn construction uses the incoming source chat/thread rather than the selected route. Forum-topic fallback also matches by `message_thread_id` without requiring the incoming chat to match the stored route.

Evidence:
- `src/broker/commands.ts` stores `selectedSessionByChat` by chat and returns a selected route by session id.
- `src/telegram/turns.ts` sets turn `chatId` and `messageThreadId` from the first Telegram message.
- `src/broker/commands.ts` forum fallback can find any `forum_supergroup_topic` route with a matching thread id.

Requirement: `SyRS-topic-routes-per-session`.

Fix direction: restrict selector mode to same-chat routes or override created turns with the selected route; require chat id/username plus thread id for forum-topic fallback.


## Deep-dive triage (2026-04-27)

Status: already fixed / stale as an open inbox item. `routeForMessage()` in `src/broker/commands.ts` now requires both chat identity and `message_thread_id` for forum-topic fallback, so same-thread-id collisions across chats no longer match. Selector mode now stores selections by source chat, only returns `single_chat_selector` routes whose `chatId` matches the incoming chat, and creates/updates a selector route for that same chat in `/use`. Delivered turns also receive `turn.routeId = route.routeId`. I did not find the originally described cross-chat/thread route identity loss in current code.

Rejected reason: Already fixed; current selector/forum routing preserves chat+thread route identity.
