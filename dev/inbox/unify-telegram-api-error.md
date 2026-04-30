---
title: "Move Telegram retry/error ownership out of API module"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["move-telegram-retry-and-error"]
---
Code-quality audit finding from 2026-04-28, rechecked on 2026-04-30.

## Original concern

Telegram retry/terminal/missing-message classification was spread across modules. The original audit also suspected `src/telegram/api.ts` JSON and multipart calls assumed JSON Bot API responses, so non-JSON rate-limit or gateway responses might lose HTTP status and `Retry-After` metadata.

## Current verdict

Keep this inbox item open, but narrow it. It is no longer an urgent correctness bug about non-JSON Bot API handling; that part is stale. It is still worth doing as a small maintainability and ownership refactor before the next larger Telegram reliability change.

Already resolved:

- `src/telegram/api.ts` now routes JSON calls, multipart uploads, and download-file failures through common result/error construction.
- Non-JSON HTTP failures are tolerated and become `TelegramApiError` values with `httpStatus`.
- Retry delay can come from either structured `parameters.retry_after` or the HTTP `Retry-After` header.
- `scripts/check-telegram-io-policy.ts` covers non-JSON HTTP 429 handling, multipart retry metadata, and central classifier behavior.
- Terminal/missing/formatting/photo-contract classifiers already live in `src/telegram/errors.ts`.

Remaining live cleanup:

- `TelegramApiError`, retry-header parsing, error construction, and `getTelegramRetryAfterMs()` still live in the low-level API transport module `src/telegram/api.ts`.
- `src/telegram/errors.ts` imports error primitives from `api.ts`, so the classifier owner depends on the transport owner.
- Many callers import retry extraction directly from `telegram/api.js`; a recheck found 15 source files with direct `getTelegramRetryAfterMs` imports, including broker, client, extension, and Telegram helper modules.
- `src/telegram/retry.ts` only owns retry sleeping; it does not own retry-signal extraction.

## Suggested future task

Plan this as a narrow behavior-preserving refactor:

- Move `TelegramApiError`, retry-after extraction, and API error construction/parsing into an error-owned Telegram module, or introduce a narrow `src/telegram/api-errors.ts` used by both `api.ts` and `errors.ts`.
- Update broker/client/Telegram helper imports to get retry extraction from the error/retry ownership surface rather than from `telegram/api.js`.
- Optionally keep compatibility re-exports from `src/telegram/api.ts` for tests or migration only if that materially reduces churn, but runtime code should use the owning module.
- Preserve all existing error messages, `errorCode`, `description`, `httpStatus`, `retryAfterSeconds`, and generic `Error` message fallback behavior in `getTelegramRetryAfterMs()`.
- Keep `scripts/check-telegram-io-policy.ts` passing, and consider adding a static check that runtime code does not import retry classification from `telegram/api.js`.

Likely trace links for a future task: `SyRS-telegram-retry-after` and `SyRS-runtime-validation-check`; `SyRS-api-guidance-maintained` is nearby only if docs/guidance changes are needed.

## Non-goals

- Do not change Telegram retry timing, fallback, terminal-vs-retry classification, topic cleanup, final delivery, update offset, upload/download, or attachment behavior.
- Do not re-plan this as missing non-JSON Bot API response handling unless new evidence shows that coverage regressed.
- Do not combine this with semantic TTL splitting or bounded recent-id utility extraction.
