---
title: "Preserve long Telegram command result chunks"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: "agent"
labels: ["telegram", "bug", "commands"]
traces_to: ["SyRS-command-result-text-preservation", "SyRS-telegram-text-method-contracts", "SyRS-telegram-git-menu", "SyRS-local-git-inspection", "SyRS-interactive-model-picker"]
source_inbox: "edited-telegram-command-results"
branch: "task/preserve-long-telegram-command-result"
---
## Objective

Fix Telegram command/control result delivery so long results are not silently truncated when the bridge updates an existing Telegram message.

The current bug is that shared edit helpers only use the first `chunkParagraphs(...)` chunk. That keeps `editMessageText` below Telegram's 4096-character method limit but loses overflow text for command/control result paths such as Git and model controls.

## Scope

- Make the Telegram text helper layer explicit about two behaviors:
  - single-message edits, where only one Telegram message can be edited and truncation/chunk selection is intentional;
  - edit-first-and-send-rest result delivery, where the first chunk updates the target message and remaining chunks are sent as follow-up messages in the same chat/thread.
- Apply the complete-result behavior to command/control result paths that currently use edit-or-send semantics for operator-visible results.
- Preserve reply markup behavior: if a result has multiple chunks, interactive markup should only remain where it is still meaningful and should not be duplicated across overflow messages.
- Preserve `retry_after` handling: Telegram rate limits must propagate through the same retry-aware paths rather than falling back, and multi-chunk result delivery must not be replayed from the beginning after a partial successful delivery.
- For callback/control paths that persist completed result text and may retry finalization, record enough delivery progress or use an equivalent retry-safe delivery mechanism so a later callback retry resumes or stops safely instead of duplicating already-sent overflow chunks.

## Codebase Grounding

Likely touchpoints:

- `src/telegram/message-ops.ts` owns `editTelegramTextMessage()`, `editTelegramMarkdownMessage()`, and `editOrSendTelegramText()`.
- `src/telegram/text.ts` re-exports the text helper API.
- `src/broker/inline-controls.ts` owns common command/control edit-or-send behavior used by Git and model controls.
- `src/broker/git-command.ts`, `src/broker/model-command.ts`, and related behavior checks are the main user-facing command/control paths to exercise; both persist completed control result text and can re-enter result finalization after a retryable Telegram failure.
- `src/shared/types.ts` may need minimal control-state progress fields if the chosen implementation records delivered result chunks for retry-safe callback finalization.
- `scripts/check-telegram-text-replies.ts`, `scripts/check-telegram-io-policy.ts`, `scripts/check-telegram-git-controls.ts`, and/or command-routing checks are likely validation targets.

## Preserved Behavior

- Telegram sends remain split below the 4096-character message limit.
- Existing single-message edit callers that intentionally render a compact preview/status message continue to edit only one message.
- Missing-editable fallback behavior still sends the full result rather than dropping text.
- Markdown fallback and `message is not modified` handling remain stable.
- `message_thread_id` is preserved for overflow chunks.
- `retry_after` errors are not swallowed and do not trigger non-rate-limit fallback behavior.
- If a multi-chunk command/control result hits `retry_after` after some chunks have already been delivered, a subsequent retry does not duplicate those delivered chunks.
- Git inspections remain read-only bounded local IPC queries and do not create pi agent turns.

## Acceptance Criteria

- A focused check demonstrates that a long command/control result edits the original message with the first chunk and sends remaining chunks in order to the same chat/thread.
- A focused check demonstrates that if the edit target is missing and fallback sends a new result, all chunks are sent rather than only the first chunk.
- Existing short command/control results still produce one edited message without extra sends.
- Reply markup is not attached to intermediate overflow chunks; if markup is retained, it is attached only to the intended edited/final message according to the helper contract.
- A focused check demonstrates retry safety for partial multi-chunk delivery: when a retryable Telegram failure occurs after the edit or after at least one overflow chunk is sent, the next callback/control retry does not resend already-delivered overflow text.
- Existing Telegram IO policy checks for formatting fallback, `message is not modified`, missing-editable fallback, and `retry_after` propagation continue to pass.

## Out of Scope

- Do not redesign all Telegram output rendering or move command/control results into the assistant-final FIFO ledger.
- Do not change activity preview debouncing or final-response delivery semantics.
- Do not change Git/model command semantics except to preserve complete result text.
- Do not take on the broader Telegram API error-classification cleanup in this slice.

## Validation

Run `npm run check`. Add or update focused behavior checks around Telegram text helpers and at least one command/control caller that can produce multi-chunk output.

## Decisions

- 2026-04-30: Implemented command/control result preservation with an explicit edit-first/send-rest helper instead of changing existing single-message edit helpers. Control records now carry minimal resultDeliveryProgress so callback retries can resume after partial multi-chunk delivery without replaying already-sent overflow chunks. The fallback path sends full chunks directly through the centralized Telegram JSON helper rather than the older sendTextReply callback so per-chunk progress can be recorded after each successful send.
- 2026-04-30: Review found that progress-persistence failures after a successful edit must not be treated like edit failures. The helper now separates Telegram edit errors from progress persistence errors, wraps progress persistence failures in TelegramTextDeliveryProgressError, and rethrows that error through control-result delivery instead of falling back or marking controls complete.
