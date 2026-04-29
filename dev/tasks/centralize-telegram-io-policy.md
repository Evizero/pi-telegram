---
title: "Centralize Telegram IO policy"
status: "done"
priority: 2
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: "pi-agent"
labels: ["telegram", "refactor", "reliability"]
traces_to: ["SyRS-telegram-retry-after", "SyRS-telegram-text-method-contracts", "SyRS-topic-routes-per-session", "SyRS-final-preview-deduplication", "SyRS-final-delivery-fifo-retry", "SyRS-retry-topic-cleanup", "SyRS-outbound-photo-document-rules", "SyRS-api-guidance-maintained", "SyRS-interactive-model-picker", "SyRS-queued-followup-steer-control", "SyRS-cancel-queued-followup", "SyRS-queued-control-finalization", "SyRS-telegram-git-menu"]
source_inbox: "centralize-telegram-io-policy"
branch: "task/centralize-telegram-io-policy"
---
## Objective

Create a coherent Telegram IO policy layer so feature code stops reimplementing Telegram edge behavior for sends, edits, deletes, callback acknowledgements, retry classification, message-thread targeting, chunking, Markdown fallback, and upload fallback. The first implementation slice should reduce duplicated policy in the existing runtime without changing user-visible command, activity, final, attachment, setup, or route-cleanup behavior.

## Source Context

The source inbox item identifies a codebase coherence problem: Telegram API usage crosses text replies, previews, attachments, typing, assistant finals, activity rendering, setup, route cleanup, update handling, and command controls. Each path currently decides locally how to preserve `message_thread_id`, classify errors, honor `retry_after`, fall back from Markdown or edit to send, ignore missing messages, split text, or choose upload methods.

Deep-dive evidence from the current codebase:

- `src/telegram/api.ts` owns low-level JSON/multipart/file calls, but JSON and multipart calls assume JSON error bodies and do not preserve HTTP status or `Retry-After` headers as consistently as file downloads.
- `getTelegramRetryAfterMs()` is imported broadly by broker, client, and Telegram modules; retry/terminal/missing-message predicates are duplicated in `src/telegram/previews.ts`, `src/broker/finals.ts`, `src/broker/sessions.ts`, `src/broker/commands.ts`, `src/telegram/attachments.ts`, `src/telegram/final-errors.ts`, and test scripts.
- Message operations overlap across `src/telegram/text.ts`, `src/telegram/previews.ts`, `src/broker/finals.ts`, `src/broker/activity.ts`, `src/broker/commands.ts`, and `src/broker/updates.ts`.
- Command controls already share `editTelegramTextMessage()` and `answerTelegramCallbackQuery()` in some paths, but Git controls, model pickers, queued-turn controls, and generic callback fallback behavior still carry local retry/fallback wrappers.
- Final delivery and preview cleanup contain deliberately durable behavior that must not be flattened into best-effort helper calls without preserving partial-progress and FIFO semantics.

Related but not fully consumed inbox items: `unify-telegram-api-error` is a natural sub-slice of this task; `consolidate-durable-telegram-side` is downstream and should not be implemented wholesale in this refactor.

## Scope

Implement a small policy layer under `src/telegram/` that gives feature modules named operations and predicates instead of ad hoc Telegram edge handling. The slice should include:

- Central Telegram error classification for:
  - retryable/rate-limited failures, including Bot API `parameters.retry_after` and HTTP `Retry-After` where available;
  - formatting/entity parse failures that may fall back from Markdown/HTML to plain text;
  - message-not-modified success semantics;
  - missing/non-editable/non-deletable message outcomes;
  - terminal send/final-delivery errors;
  - terminal and already-deleted topic cleanup outcomes;
  - sendPhoto contract failures that are eligible for sendDocument fallback.
- Low-level API hardening so JSON and multipart Bot API failures preserve method, HTTP status when useful, response description/error code when present, and retry-after information from structured response parameters or headers.
- Shared message operation helpers for the common cases:
  - send chunked plain text with route/thread context and optional reply markup/notification flags;
  - send chunked Markdown with plain fallback only for formatting failures, never for `retry_after`;
  - edit text treating “message is not modified” as success;
  - edit-or-send fallback for stale/non-editable callback-originated messages while preserving retry-after;
  - delete message with explicit caller-selected handling for missing, retryable, and terminal outcomes;
  - answer callback query with best-effort handling only where the caller has explicitly chosen best-effort semantics.
- Migrate representative call sites so the new policy is actually used in the highest-risk paths: command/control edits, previews, final text/preview cleanup, queued-control finalization, topic cleanup classification, and attachment upload fallback.
- Keep activity rendering and typing loops within their current durability semantics, but route their send/edit/delete calls through shared helpers where that reduces duplication without making passive activity delivery more alerting or more durable than intended.

## Preserved Behavior

- Always preserve `message_thread_id` for topic-routed replies, previews, uploads, typing actions, command results, and cleanup-related visible messages.
- Preserve `ResponseParameters.retry_after`; do not fall back to another Telegram method or advance durable lifecycle state through a rate-limit window.
- Preserve assistant-final FIFO delivery and partial-progress ledgers; do not resend already recorded chunks or attachments.
- Preserve final-preview deduplication: final text is sent through final delivery, not edited into an old preview message as the stable path.
- Preserve command/control semantics: model picker, Git controls, queued follow-up steer/cancel controls, and stale callback finalization must still answer callbacks and finalize visible messages according to their current authority and route checks.
- Preserve route cleanup safety from the recent stabilization work: topic deletion remains retryable/fenced and must not delete active routes.
- Preserve upload behavior: `sendPhoto` is used only for likely photos within the photo limit, photo-contract failures may fall back to `sendDocument`, and rate limits must not trigger that fallback.
- Preserve local-first architecture; this task must not introduce a hosted broker, external daemon, webhook server, or broad Telegram bot framework abstraction.

## Codebase Grounding

Likely files and modules:

- `src/telegram/api.ts` — preserve structured and HTTP retry/error metadata across JSON, multipart, and file download calls.
- New or revised `src/telegram/errors.ts` / `src/telegram/message-ops.ts` — shared predicates and operations for Telegram IO policy.
- `src/telegram/text.ts` — likely becomes a thin compatibility wrapper or is absorbed into message operations.
- `src/telegram/previews.ts` — replace local formatting, not-modified, missing-edit/delete, and retry predicates while preserving preview throttling state.
- `src/telegram/attachments.ts` and `src/telegram/final-errors.ts` — move or re-export classification through the shared policy.
- `src/broker/finals.ts` — replace local chunk/send/fallback/delete classification carefully without disturbing the delivery ledger.
- `src/broker/sessions.ts` — route cleanup and queued-control visible finalization should use shared classification helpers.
- `src/broker/commands.ts` — centralize edit-or-send and callback acknowledgement policy for model/Git/queued controls where possible.
- `src/broker/activity.ts`, `src/broker/updates.ts`, and `src/extension.ts` — update only where policy helpers reduce duplication without broad orchestration changes.
- Regression scripts likely affected: `scripts/check-telegram-text-replies.ts`, `scripts/check-preview-manager.ts`, `scripts/check-final-delivery.ts`, `scripts/check-session-route-cleanup.ts`, `scripts/check-telegram-command-routing.ts`, `scripts/check-security-setup-attachments.ts`, and possibly a new focused check for Telegram API/error classification.

## Acceptance Criteria

- There is one authoritative Telegram error classification module used by message text, previews, finals, route cleanup, attachment upload fallback, and command/control finalization for the classifications in scope.
- JSON and multipart Bot API calls preserve retry-after information from structured Telegram response parameters and HTTP headers, including non-JSON gateway/rate-limit responses where practical.
- Markdown/plain fallback, edit-not-modified success, edit-or-send fallback, missing-delete handling, sendPhoto-to-sendDocument fallback, and terminal final/topic cleanup classification are covered by focused regression tests.
- Existing behavior remains stable for `/model`, `/git`, queued follow-up controls, final delivery retries, preview cleanup, topic cleanup retry, attachment sending, and command replies in forum topics.
- The refactor reduces local regex/error-policy duplication rather than only adding wrappers around the old scattered logic.
- `docs.md` and/or `dev/ARCHITECTURE.md` are updated if the implementation creates a durable new Telegram IO policy seam that future agents must preserve.
- No TypeScript source file exceeds 1,000 lines, and new modules follow the project responsibility layout under `src/telegram/` rather than expanding `src/extension.ts` or `src/broker/commands.ts`.
- `npm run check`, `pln hygiene`, and `git diff --check` pass before completion.

## Out of Scope

- Do not build the full durable Telegram side-effect outbox in this slice.
- Do not redesign broker/client lifecycle, session replacement, command registry architecture, or route ownership beyond what is needed to call shared Telegram IO helpers.
- Do not change user-facing command names, callback token formats, pairing/setup behavior, topic routing policy, or final-delivery ordering.
- Do not broaden the product into a general Telegram bot framework.

## Pre-edit Impact Preview

Likely blast radius is medium-to-large but should be behavior-preserving: new shared `src/telegram/*` policy modules plus targeted migrations in previews, finals, sessions, commands, attachments, and low-level API calls. The main risks are accidentally treating `retry_after` as a fallback-eligible error, weakening durable final progress, changing alert/silent notification behavior, or hiding terminal cleanup failures that should remain visible in state/logs.

## Validation Plan

Add or extend focused checks for:

- structured Telegram error bodies and non-JSON HTTP failures preserving retry-after metadata for JSON and multipart calls;
- Markdown send fallback only on formatting errors, not rate limits;
- edit-not-modified treated as success;
- edit-or-send fallback when callback-originated messages are no longer editable, with retry-after propagated;
- delete-message helpers distinguishing missing-message success from retryable/server failures according to caller policy;
- final delivery preserving chunk progress and FIFO when preview cleanup or sends hit retry-after;
- topic cleanup preserving retry-after, already-deleted success, and terminal permission/auth failures;
- sendPhoto contract fallback to sendDocument while preserving rate-limit failures;
- forum-topic `message_thread_id` preservation across migrated helpers.

Run the full local validation suite with `npm run check`.

## Decisions

- 2026-04-29: Pre-edit impact preview: implement a behavior-preserving Telegram IO policy seam in src/telegram by adding shared error classification and message operation helpers, hardening low-level API error metadata, then migrating previews, finals, route cleanup, command/control edits, and attachment fallback incrementally. Main risks are retry_after fallback mistakes, final-delivery ledger regressions, topic thread loss, and accidental over-scope into durable outbox or command architecture work; validation will combine focused scripts with npm run check.
- 2026-04-29: Implemented the first IO-policy slice as a centralized src/telegram seam: api.ts now preserves structured and HTTP retry metadata, errors.ts owns reusable Telegram classifications, message-ops.ts owns shared send/edit/delete/callback operations, and high-risk broker paths now call those helpers while preserving final-delivery ledgers and route cleanup semantics.
