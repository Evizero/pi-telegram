---
title: "Edited Telegram command results can silently drop chunks"
type: "bug"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["preserve-long-telegram-command-result"]
---
Code-quality audit finding from 2026-04-28.

`src/telegram/text.ts:66` edits only `chunkParagraphs(...)[0]`. Callers that edit command/control messages, including Git controls, can silently truncate output above Telegram's 4096-character limit instead of sending remaining chunks.

Suggested planning direction: make edit helpers explicit about single-message edits versus edit-first-chunk-and-send-rest behavior, and ensure command/control results do not silently lose text.



## Deep-dive update (2026-04-30)

Still current. `src/telegram/message-ops.ts` still implements `editTelegramTextMessage()` and `editTelegramMarkdownMessage()` by editing only `chunkParagraphs(...)[0]`, and `editOrSendTelegramText()` returns after a successful edit without sending remaining chunks. Current callers include control-result paths such as `src/broker/inline-controls.ts`, which are used by Git/model command controls, so long command/control results can still be truncated unless edit helpers distinguish single-message edits from edit-first-and-send-rest behavior.
