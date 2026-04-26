---
title: "Keep Telegram finals pending across pi auto-retry"
status: "review"
priority: 1
created: "2026-04-26"
updated: "2026-04-26"
author: "Christof Salis"
assignee: ""
labels: []
traces_to: ["SyRS-retry-aware-agent-finals", "SyRS-final-text-before-error-metadata", "SyRS-final-delivery-fifo-retry", "SyRS-final-preview-deduplication", "SyRS-stop-active-turn"]
source_inbox: "assistant-final-lost-with"
branch: "task/keep-telegram-finals-pending-across-pi"
---
## Objective

Prevent Telegram from receiving low-context transient provider errors such as `fetch failed` or `terminated` in place of the real assistant final when pi auto-retries and later completes the turn locally.

The bridge should treat retryable assistant/provider errors during an active Telegram turn as an intermediate state, not as the stable Telegram final, and should still produce a clear terminal failure if no retry/success follows.

## Planned approach

- Add a retryable assistant-error classifier shared by pi-hook/finalization code. It should cover the same family of transient provider strings pi retries today, including `fetch failed`, `terminated`, 429/5xx, overloaded/rate-limit, network, connection, timeout, and similar transport failures.
- In the active Telegram turn finalization path, defer `assistant_final` handoff when `agent_end` reports a retryable `stopReason: "error"` with no stable answer yet.
- Keep the active Telegram turn associated with the retry attempt instead of calling `rememberCompletedLocalTurn(...)`, clearing `activeTelegramTurn`, or starting the next queued Telegram turn prematurely.
- When the retry attempt starts, cancel the deferred-error fallback while preserving the active Telegram turn so the eventual successful `agent_end` can send the real final.
- If pi exposes session auto-retry events to extensions, prefer those events for retry start/end detection. If not, use a conservative client-side grace/watchdog around retryable error finals so auto-retry-disabled or exhausted cases do not leave the Telegram route stuck forever.
- Clear or safely supersede stale preview state from the failed attempt before a retry response can create/finalize a new preview.
- Change broker final text selection so non-empty assistant final text wins over raw error metadata, while error-only finals still produce a clear failure message.
- Ensure `/stop`, explicit disconnect, session shutdown, and route cleanup cancel any deferred retryable final state and do not leave queued Telegram turns blocked indefinitely. In particular, `/stop` during a deferred retry window must work even if there is an active Telegram turn but no live `currentAbort` callback because the provider request is between retry attempts.

## Codebase grounding

Likely touchpoints:

- `src/pi/hooks.ts`
  - `agent_end` currently sends every active-turn assistant final immediately and clears active-turn state.
  - `agent_start` may be the practical point to detect a retry continuation if session auto-retry events are not available through the extension API.
- `src/extension.ts`
  - Owns `activeTelegramTurn`, `currentAbort`, queued turns, assistant final handoff, IPC handlers, and lifecycle cleanup. It is likely the right composition point for deferred-final state and timers, while cohesive helper logic should be extracted rather than expanding the file unnecessarily.
- `src/broker/finals.ts`
  - `AssistantFinalDeliveryLedger.deliver()` currently prioritizes `stopReason === "error"` over `entry.text` and sends `entry.errorMessage` as the final body.
  - Preserve FIFO retry, `retry_after` propagation, chunk progress, attachment progress, preview detach/finalize behavior, and terminal failure classification.
- `src/telegram/previews.ts` / broker preview handlers
  - Use existing preview clear/detach behavior where possible; add only the narrow broker IPC needed to clear stale failed-attempt previews if current handlers are insufficient.
- `scripts/check-final-delivery.ts`
  - Add ledger coverage for `stopReason: "error"` with non-empty text and error-only finals.
- Add or extend a pi-hook/client-level check script, wired into `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json`, to exercise deferred retryable final behavior without requiring a live provider.

## Acceptance Criteria

- A simulated active Telegram turn whose first `agent_end` contains `stopReason: "error"` and `errorMessage: "fetch failed"` or `"terminated"` does not send `assistant_final`, does not mark the turn completed locally, and does not clear `activeTelegramTurn` before retry handling has a chance to continue.
- A subsequent retry attempt for the same pi turn can deliver the successful assistant text to Telegram as the visible final; Telegram does not receive the earlier transient error string as a final answer.
- If no retry starts or retry is exhausted, the bridge eventually sends one clear terminal failure response and releases the active Telegram turn so queued Telegram work is not permanently blocked.
- `/stop` during a deferred retry window cancels the deferred retry/fallback state, releases or completes the active Telegram turn consistently, sends one operator-facing confirmation, and ensures queued Telegram turns are not left blocked even when no live `currentAbort` callback exists.
- Stale previews from the failed attempt are cleared or superseded without producing duplicate preview/final messages.
- `AssistantFinalDeliveryLedger` delivers non-empty assistant text even when `stopReason === "error"`, and uses a clear error fallback only when no final text exists.
- Telegram API send failures, including generic `fetch failed` from `callTelegram`, remain delivery failures that keep broker final delivery retryable; they are not converted into Telegram message text.
- FIFO final ordering, `retry_after` handling, message-thread preservation, long-text chunking, Markdown fallback behavior, and attachment delivery progress remain intact.

## Out of Scope

- Do not redesign pi's provider auto-retry settings or retry classifier beyond what the bridge must recognize to avoid premature Telegram finalization.
- Do not make Telegram retry decisions for Bot API failures behave like assistant/provider retry decisions; those remain broker final-delivery retry concerns.
- Do not change paired-user authorization, route selection, topic creation, or attachment safety semantics.
- Do not globally suppress error reporting; real terminal failures should still be visible in Telegram.

## Validation

- Add focused regression checks for retryable assistant-error deferral and successful retry final delivery.
- Add a check for `/stop` during the deferred retry window where an active Telegram turn exists but no live abort callback exists, confirming deferred state is canceled and queued work is not blocked.
- Add final-ledger checks for error-with-text, error-only, aborted, and Telegram API failure cases.
- Run `npm run check` before reporting implementation complete.

## Pre-edit impact preview

Likely affected code areas are the pi hook finalization boundary, composition-root state cleanup, broker final delivery text selection, preview cleanup IPC, and local check scripts. The main risks are accidentally blocking queued Telegram turns during retry grace, losing `/stop` ability while no model request is active, duplicating previews when retry starts, or weakening broker-side FIFO/retry-after behavior.

## Decisions

- 2026-04-26: Implemented retry-aware active-turn finalization with a client-side deferred retry grace that clears the visible preview and pauses typing via broker IPC, then either resumes on the next agent_start or emits one fallback terminal final if no retry begins.
- 2026-04-26: Kept /stop resilient during deferred retry by preserving or reconstructing an abort callback from the latest session context when possible, and otherwise releasing the deferred Telegram turn without leaving queued work blocked.
- 2026-04-26: Kept the deferred-turn marker alive until the retry attempt emits assistant message_start, while canceling only the watchdog timer on agent_start, so local input can still flush the old Telegram turn before any retry output would be re-associated.
- 2026-04-26: Used preview-manager clear-with-preserve behavior for deferred retry preview cleanup so failed deleteMessage attempts do not drop the durable preview reference needed for later final dedupe or preview replacement.
