---
title: "Move Telegram retry and error ownership out of API module"
status: "done"
priority: 3
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: "agent"
labels: ["refactor", "telegram", "retry"]
traces_to: ["SyRS-telegram-retry-after", "SyRS-runtime-validation-check"]
source_inbox: "unify-telegram-api-error"
branch: "task/move-telegram-retry-and-error"
---
## Objective

Clarify Telegram retry/error ownership without changing Telegram Bot API behavior. The low-level API transport should call shared Telegram error primitives, while retry extraction and classification should be imported from an error/retry ownership surface rather than from `src/telegram/api.ts`.

This is a maintainability refactor, not a fix for currently missing non-JSON response handling.

## Current codebase grounding

The original inbox concern is partly stale:

- `src/telegram/api.ts` already handles non-JSON HTTP Bot API failures by creating `TelegramApiError` with HTTP status.
- Retry delay already comes from structured `parameters.retry_after` or the HTTP `Retry-After` header.
- JSON calls, multipart uploads, and download-file failures now share the common result/error construction path.
- `scripts/check-telegram-io-policy.ts` covers non-JSON HTTP 429 handling, multipart retry metadata, and central classifier behavior.

Remaining ownership issue:

- `TelegramApiError`, retry-header parsing, API error construction, and `getTelegramRetryAfterMs()` still live in `src/telegram/api.ts`.
- `src/telegram/errors.ts` imports those primitives from `api.ts`, even though it owns most classifiers.
- Source grep on 2026-04-30 found 15 runtime files importing `getTelegramRetryAfterMs()` from `telegram/api.js`, across broker, client, extension, and Telegram helper modules.
- `src/telegram/retry.ts` owns retry sleeping only; it currently imports retry-signal extraction from `api.ts`.

Likely touchpoints:

- `src/telegram/api.ts`
- `src/telegram/errors.ts`
- optionally a new narrow owner such as `src/telegram/api-errors.ts`
- `src/telegram/retry.ts`
- broker/client/extension/Telegram helper imports that currently import `getTelegramRetryAfterMs` from `telegram/api.js`
- `scripts/check-telegram-io-policy.ts` and/or a focused static behavior check for import ownership

## Scope

- Move Telegram API error primitives out of the transport module into an owning Telegram error/retry module:
  - `TelegramApiError`
  - retry-after header parsing needed for API error construction
  - `telegramApiError()` or equivalent API error construction
  - `getTelegramRetryAfterMs()`
- Update `src/telegram/api.ts` so it uses the new owner for error construction but keeps transport responsibilities for Bot API JSON calls, multipart uploads, and downloads.
- Update runtime imports so callers use the owning error/retry surface for retry extraction rather than importing `getTelegramRetryAfterMs` from `telegram/api.js`.
- Keep or adjust compatibility exports only if helpful for migration, but runtime code should not depend on `telegram/api.ts` for retry/error classification.
- Add or update validation so the ownership boundary is guarded. A static check is acceptable if it prevents runtime code from reintroducing `getTelegramRetryAfterMs` imports from `telegram/api.js`.

## Preserved behavior

- Preserve all current `TelegramApiError` fields and constructor behavior: `method`, `description`, `errorCode`, `retryAfterSeconds`, `httpStatus`, `.name`, and generated `.message` text.
- Preserve `getTelegramRetryAfterMs()` behavior, including generic `Error` message fallback matching `retry after Ns`.
- Preserve non-JSON HTTP response handling, structured `parameters.retry_after`, and HTTP `Retry-After` header support.
- Preserve JSON call, multipart upload, and download-file API result behavior.
- Preserve all retry/fallback behavior in previews, message ops, attachments, commands, routes, updates, outbox, final delivery, and client final handoff.
- Preserve Telegram upload/download limits, final-delivery FIFO/retry ordering, update offset durability, topic cleanup retry behavior, and outbound attachment safety.

## Acceptance Criteria

- `src/telegram/api.ts` no longer owns retry extraction/classification; `getTelegramRetryAfterMs()` is defined in an error/retry ownership module.
- `src/telegram/errors.ts` no longer imports Telegram error primitives from `src/telegram/api.ts`.
- Runtime code outside `src/telegram/api.ts` imports retry extraction from the owning error/retry module, not from `telegram/api.js`.
- Existing behavior checks for non-JSON HTTP retry handling and multipart retry metadata still pass.
- A focused check or existing check coverage catches reintroduction of runtime `getTelegramRetryAfterMs` imports from `telegram/api.js`.
- `npm run check` passes.

## Out of Scope

- Do not change retry durations, retry-after grace timing, fallback decisions, terminal-vs-retry classification, topic cleanup behavior, final delivery behavior, update offset handling, upload/download limits, or attachment safety.
- Do not broaden this into a redesign of Telegram command routing, durable final delivery, outbox semantics, or setup/polling behavior.
- Do not re-solve the already covered non-JSON Bot API response issue unless implementation discovers a concrete regression.
- Do not combine this with semantic TTL splitting or bounded recent-id utility extraction.

## Validation

Run `npm run check`.

During review, inspect the import graph to confirm retry/error classification no longer flows through `src/telegram/api.ts` for runtime callers, while `src/telegram/api.ts` remains the low-level transport/download boundary.

## Pre-edit impact preview

Expected blast radius is import-heavy but behavior-light: one new or repurposed Telegram error ownership module, small edits to `api.ts`/`errors.ts`, import rewrites in broker/client/Telegram helper modules, and a focused behavior/static check. Main risk is accidentally changing retry/error message semantics while moving code, so implementation should avoid logic changes and preserve existing tests before adding stricter boundary checks.

## Implementation notes

Implemented with a new `src/telegram/api-errors.ts` owner for `TelegramApiError`, API error construction, and retry-signal extraction. `src/telegram/api.ts` now delegates error construction while retaining JSON, multipart, and download transport responsibilities. Runtime and behavior-check imports were rewritten to use `api-errors.js` for retry/error primitives, and `scripts/check-telegram-error-boundary.ts` now guards against reintroducing those imports from `telegram/api.js`. `dev/ARCHITECTURE.md` was updated to document the new Telegram module boundary.

Validation completed: `npm run check` and `pln hygiene` passed. Review completed with no findings.

## Decisions

- 2026-04-30: Use src/telegram/api-errors.ts as the narrow owner for TelegramApiError, API error construction, and retry-after extraction; keep src/telegram/api.ts as Bot API transport/download boundary only.
- 2026-04-30: Guard the new boundary with a behavior-check script that rejects runtime/test imports of retry/error primitives from src/telegram/api.ts.
