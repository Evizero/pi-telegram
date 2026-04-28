---
title: "Restrict sendPhoto fallback to photo-contract errors"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "telegram-voice"
assignee: ""
labels: []
traces_to: ["SyRS-outbound-photo-document-rules", "SyRS-telegram-retry-after"]
source_inbox: "sendphoto-fallback-should-only"
branch: "task/restrict-sendphoto-fallback-to-photo"
---
## Objective

Restrict `sendPhoto` to `sendDocument` fallback so it only happens for Telegram photo-contract failures, not for unrelated Telegram API failures.

The current behavior can mask bad chat/thread IDs, permission errors, or other non-photo failures by attempting a document upload after any non-rate-limit `sendPhoto` error.

## Scope

Introduce a conservative classifier for photo-specific `sendPhoto` failures and use it before falling back to `sendDocument`. Preserve existing retry-aware behavior and attachment failure reporting.

## Codebase grounding

- `src/telegram/attachments.ts` owns `sendQueuedAttachment()` and currently falls back from `sendPhoto` to `sendDocument` for any `sendPhoto` error without `retry_after`.
- `src/telegram/api.ts` exposes `TelegramApiError` details and `getTelegramRetryAfterMs()`.
- `docs.md` and `SyRS-outbound-photo-document-rules` distinguish photo-contract fallback from rate-limit or unrelated API failures.
- Final delivery calls `sendQueuedAttachment()` from `src/broker/finals.ts`, so changes must preserve final FIFO/retry behavior.

## Acceptance Criteria

- Likely photos within the size cap still try `sendPhoto` first.
- Photo-specific contract failures, such as invalid photo/image format or Telegram photo size/dimension constraints, may fall back to `sendDocument`.
- `retry_after` from `sendPhoto` remains retryable and does not fall back.
- Non-photo failures such as unauthorized/forbidden chat, bad thread, missing permissions, or unrelated Telegram validation errors do not trigger fallback and are reported/preserved as the original failure.
- Existing `message_thread_id` behavior for uploads remains unchanged.

## Out of Scope

- Do not add local image decoding or dimension probing unless needed for a minimal classifier.
- Do not change document upload limits or attachment queue ordering.
- Do not silence attachment failure notices.

## Validation

- Add focused final-delivery or attachment checks for photo-contract fallback, retry_after preservation, and unrelated error propagation.
- Run `npm run check`.

## Decisions

- 2026-04-28: sendPhoto fallback now uses a conservative TelegramApiError classifier and falls back only for 400-level photo/image/file contract failures; retry_after and unrelated errors do not fall back.
- 2026-04-28: Review narrowed the sendPhoto classifier to explicit image/photo contract phrases rather than any error mentioning photos, so permission errors like missing rights to send photos remain original failures.
- 2026-04-28: Close-out validation passed: npm run check, pln hygiene, and final review agent re-review reported no findings.
