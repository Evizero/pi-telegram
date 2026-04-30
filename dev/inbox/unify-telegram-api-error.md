---
title: "Finish Telegram API retry/error classification cleanup"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

Telegram retry/terminal/missing-message classification is spread across modules. Additionally, `src/telegram/api.ts:50` and `src/telegram/api.ts:77` assume JSON Bot API responses for send/upload calls; non-JSON rate-limit or gateway responses may lose HTTP status and Retry-After metadata.

Suggested planning direction: centralize Telegram error classification in a dedicated module and make JSON/multipart API calls preserve HTTP status and Retry-After data consistently.



## Deep-dive update (2026-04-30)

Partially stale. The original non-JSON/metadata concern appears resolved: `src/telegram/api.ts` now tolerates non-JSON API responses, creates `TelegramApiError` with HTTP status, and parses `Retry-After` headers when `parameters.retry_after` is unavailable; the common result path is used by JSON calls, multipart uploads, and download-file failures. Error classification is also now partly centralized in `src/telegram/errors.ts`. The remaining cleanup is narrower: retry extraction still lives in `src/telegram/api.ts` as `getTelegramRetryAfterMs`, many broker/client modules import it directly, and retry-vs-terminal policy is split between low-level API error construction and higher-level classifiers. Re-plan this item, if kept, as ownership cleanup for retry/error classification rather than as missing non-JSON response handling.
