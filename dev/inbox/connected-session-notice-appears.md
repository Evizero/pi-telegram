---
title: "Connected session notice appears pinned in Telegram topic"
type: "observation"
created: "2026-04-25"
author: "Christof Salis"
status: "rejected"
planned_as: []
---
User observed: in a new connected Telegram session, the first "Connected pi session" message appears pinned in the Telegram chat/topic, and asked whether pi-telegram is doing that.

Initial code check: no pin/unpin Bot API calls were found. The route creation path calls createForumTopic and then sendMessage with text `Connected pi session: ...`; sendTextReply only calls sendMessage with optional message_thread_id.

Archived at user request after confirming pi-telegram sends the connection notice but does not explicitly pin it.
