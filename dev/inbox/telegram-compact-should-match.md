---
title: "Telegram /compact should match native pi busy behavior"
type: "request"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["match-telegram-compact-to-pi-busy"]
---
User noticed that sending `/compact` from Telegram while the target agent is busy returns the bridge rejection message `Cannot compact while this session is busy. Send stop first.`

Desired behavior: Telegram `/compact` should match native pi behavior instead of rejecting. Investigation on 2026-04-25 found native interactive pi handles `/compact` before normal streaming input steering and `AgentSession.compact()` explicitly disconnects from the agent, aborts the current agent operation, then starts manual compaction.
