---
title: "Pi streams assistant text mid-turn"
type: "request"
created: "2026-04-27"
author: "Christof Salis"
status: "planned"
planned_as: ["segment-telegram-activity-around"]
---
User noticed that while the agent is still working and Telegram is updating its activity message, the agent sometimes writes a normal assistant message instead of only thinking traces. Investigation on 2026-04-27 found this matches pi behavior: pi message_update events include distinct assistantMessageEvent types for text_start/text_delta/text_end as well as thinking_start/thinking_delta/thinking_end and toolcall events. The interactive TUI creates an AssistantMessageComponent at assistant message_start and updates it on every assistant message_update, rendering text blocks as normal assistant text and thinking blocks separately. Current pi-telegram hooks also post assistant_preview on every assistant message_update using getMessageText(event.message), while only thinking_* events are added to ActivityReporter. This means Telegram can show a normal assistant preview/message during an active turn when pi has streamed text before continuing with tools.


Follow-up desired behavior from user: when visible assistant text is interleaved during an active Telegram turn, the current activity message should be finished before that assistant message appears; subsequent agent work should start a new activity message after the assistant message, so Telegram chronology remains activity → assistant text → later activity rather than editing an older activity message below/above newer assistant text.
