---
title: "Append Telegram finals after settling previews"
status: "done"
priority: 2
created: "2026-04-27"
updated: "2026-04-27"
author: "Christof Salis"
assignee: ""
labels: ["telegram", "final-delivery", "preview", "bug"]
traces_to: ["SyRS-final-preview-deduplication", "SyRS-final-delivery-fifo-retry", "SyRS-telegram-retry-after"]
source_inbox: "final-telegram-message-can"
branch: "task/append-telegram-finals-after-settling"
---
## Objective

Make Telegram final-response delivery chronologically reliable by treating streamed assistant preview messages as temporary previews only. Final assistant response text must be appended as new Telegram messages after preview detachment/cleanup, never produced by editing an older preview message into the final answer.

## Scope

- Finish the broker final-delivery path so preview detachment and retry-safe cleanup handling happen before the first final text chunk is sent.
- Ensure final content uses `sendMessage` for the first and later text chunks, including after broker restart with a durable preview reference.
- Preserve existing retry-safe ledger behavior: FIFO delivery, per-chunk/attachment progress, terminal failure classification, and no duplicate chunks or attachments.
- Preserve Telegram route context, including `message_thread_id`, for final text and attachments.
- Keep activity completion before final delivery so activity renderer state is closed before final text is appended.

## Codebase Grounding

Likely touchpoints:

- `src/broker/finals.ts` owns broker-side assistant final delivery, durable progress, preview detachment, text chunk sending, retry/terminal handling, and attachment ordering.
- `src/telegram/previews.ts` owns streaming preview state and detach/clear behavior; avoid moving final-ledger policy back into the preview manager unless a narrow helper is needed.
- `src/broker/activity.ts` and `src/pi/hooks.ts` are relevant for chronology tests but should not need broad redesign.
- `scripts/check-final-delivery.ts` should carry focused regression coverage; `scripts/check-activity-rendering.ts` may need a chronology assertion only if final/activity coordination changes.

## Acceptance Criteria

- With a live preview message, final delivery detaches the preview, performs cleanup when Telegram permits it, and sends the final text through `sendMessage` as a new Telegram message.
- Final assistant text is not delivered by `editMessageText` against the preview message ID.
- If preview deletion reports "message to delete not found", final delivery still sends the final once as a new message.
- If preview cleanup hits `retry_after`, a server/transport ambiguity, or another retryable error, the final remains pending and no final text is sent until retry.
- If Telegram permanently refuses preview cleanup, the implementation may mark the preview cleanup as terminal or replace the preview with a non-final tombstone, but final assistant content is still appended once with `sendMessage` and is never edited into the preview. If Telegram leaves a stale preview visible because cleanup is impossible, treat that as a recorded cleanup limitation rather than as duplicate final delivery.
- Chunked finals, formatting fallback, outbound attachments, and message-thread routing still behave as before.
- Durable preview references after broker restart follow the same append-final path.

## Out of Scope

- Do not redesign activity rendering, Telegram preview streaming, or the broker ledger data model beyond fields needed for retry-safe preview settlement.
- Do not add Telegram draft support or alter preview throttling policy.
- Do not weaken `retry_after` handling or let newer finals bypass an older pending final.

## Validation

Run `npm run check`. The targeted final-delivery checks should explicitly cover preview detachment/cleanup, retry-after blocking, transport ambiguity, permanent-cleanup fallback, durable-preview restart behavior, and duplicate-prevention for chunk/attachment progress.

## Decisions

- 2026-04-27: Implementation keeps preview cleanup separate from final text delivery: final text chunks are always sent with sendMessage. Retry-after, server, and transport failures during preview cleanup keep the final pending before any final text is sent; permanent cleanup refusal is recorded on the delivery progress and the final is appended once as a fresh message.
- 2026-04-27: Review found the no-edit-final policy also had to cover generated fallback final text such as error-only and attachment-only notices; those paths now use the same deliverText preview-cleanup gate instead of clearing the preview as a terminal pre-step. The legacy PreviewManager.finalize helper was also aligned to delete/ignore cleanup limitations before appending fresh replies without dropping preview state until the fresh send succeeds.
- 2026-04-27: Durable retry must also migrate pending finals produced by the previous edit-based path: if chunk 0 is recorded as delivered by the preview message before preview cleanup was marked done, retry now cleans up that preview reference and resends chunk 0 as a fresh sendMessage before continuing remaining chunks or attachments.
- 2026-04-27: Legacy edited-preview migration resets the full text-chunk progress, not only chunk 0. It attempts retry-aware deletion of any later chunk messages that were already sent by the old path, then appends the full final text sequence fresh so migrated finals do not display later chunks before the resent first chunk.
