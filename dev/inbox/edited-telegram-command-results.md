---
title: "Edited Telegram command results can silently drop chunks"
type: "bug"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`src/telegram/text.ts:66` edits only `chunkParagraphs(...)[0]`. Callers that edit command/control messages, including Git controls, can silently truncate output above Telegram's 4096-character limit instead of sending remaining chunks.

Suggested planning direction: make edit helpers explicit about single-message edits versus edit-first-chunk-and-send-rest behavior, and ensure command/control results do not silently lose text.
