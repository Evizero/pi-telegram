---
title: "Unify Telegram API error and retry classification"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

Telegram retry/terminal/missing-message classification is spread across modules. Additionally, `src/telegram/api.ts:50` and `src/telegram/api.ts:77` assume JSON Bot API responses for send/upload calls; non-JSON rate-limit or gateway responses may lose HTTP status and Retry-After metadata.

Suggested planning direction: centralize Telegram error classification in a dedicated module and make JSON/multipart API calls preserve HTTP status and Retry-After data consistently.
