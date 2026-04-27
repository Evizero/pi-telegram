---
title: "Prevent Telegram activity batching behind typing"
status: "done"
priority: 2
created: "2026-04-27"
updated: "2026-04-27"
author: "Christof Salis"
assignee: ""
labels: ["telegram", "activity", "typing", "regression"]
traces_to: ["SyRS-activity-history-rendering", "SyRS-telegram-retry-after", "SyRS-silent-passive-telegram-updates", "SyRS-final-preview-deduplication", "SyRS-final-delivery-fifo-retry", "SyRS-topic-routes-per-session"]
source_inbox: "telegram-activity-can-batch"
branch: "task/prevent-telegram-activity-batching"
---
## Objective

Restore live Telegram progress during busy pi turns by removing head-of-line blocking between advisory typing indicators, activity ingestion, assistant previews, and final delivery.

A slow or retry-delayed `sendChatAction` must not cause activity updates to batch until the assistant final is delivered.

## Source Context

Source inbox: `telegram-activity-can-batch`.

User-observed regression on 2026-04-27: Telegram sometimes stops receiving live activity while pi is busy, then receives activity updates all at once when the final answer is sent.

Deep-dive finding: the likely blocking chain is `ActivityReporter.post()` serialization → broker `activity_update` IPC → `ActivityRenderer.handleUpdate()` → awaited `startTypingLoopFor()` → retry-aware `sendChatAction`. Commit `b1e4802` added `finishActivityBeforeAssistantText()`, so assistant text previews can now also wait behind `activityReporter.flush()` when activity ingestion is stalled.

Related inbox: `typing-loop-should-not`; the fix should cover that typing-loop retry/in-flight concern instead of creating a separate duplicate implementation slice.

## Scope

- Make typing indicators advisory for activity rendering. Activity state mutation and debounced activity message scheduling must not wait for a retry-aware typing call to finish.
- Ensure `startTypingLoopFor()` does not overlap repeated `sendChatAction` attempts while a prior attempt is in flight or waiting for Telegram `retry_after`.
- Preserve Telegram `retry_after` semantics: do not immediately retry or fall back, and do not convert rate limiting into a terminal activity failure.
- Preserve activity chronology around streamed assistant text: activity that happened before assistant text should still be completed or made non-active before the text preview is shown, but passive typing delivery must not be allowed to block previews indefinitely.
- Preserve final delivery ordering and deduplication. Final responses should not bypass older retryable finals, duplicate previews, or leave stale activity rows active.

## Codebase Grounding

Likely touchpoints:

- `src/broker/activity.ts`
  - `ActivityReporter` serialization and `ActivityRenderer.handleUpdate()` / `completeActivity()` behavior.
  - Start typing outside the critical path or after activity state is already recorded and scheduled.
- `src/extension.ts`
  - `startTypingLoopFor()`, `stopTypingLoop()`, and typing-loop state in the composition root.
  - Add per-turn in-flight/retry suppression or another bounded non-overlap mechanism.
- `src/pi/hooks.ts`
  - `finishActivityBeforeAssistantText()` and activity segment handling around streamed assistant text.
  - Keep chronology safeguards without making assistant previews depend on advisory typing completion.
- `scripts/check-activity-rendering.ts` and/or `scripts/check-runtime-pi-hooks.ts`
  - Add regression coverage for blocked typing startup and retry-like typing delay.

## Acceptance Criteria

- Activity updates are recorded and scheduled even when typing startup is slow, rate-limited, or never resolves.
- Assistant preview updates are not indefinitely blocked behind advisory typing activity when a busy turn begins streaming text.
- Typing-loop sends for a turn do not overlap while a previous `sendChatAction` attempt is still pending or deliberately waiting out `retry_after`.
- Existing behavior remains intact:
  - ordered activity history is preserved while Telegram edits/sends are debounced;
  - `message_thread_id` is preserved for activity, previews, finals, and typing actions;
  - passive activity messages remain `disable_notification: true`;
  - final delivery remains FIFO/retry-safe and preview/final deduplication still works;
  - `/stop`, disconnect, offline cleanup, and final completion still stop typing loops.

## Out of Scope

- Do not redesign broker/client IPC or replace long polling.
- Do not change Telegram final delivery ledger ownership or FIFO semantics.
- Do not change user-facing activity formatting except where needed to complete stale active rows correctly.
- Do not broaden this into unrelated preview, attachment, model-picker, or session-routing behavior.

## Validation

- Add focused tests that simulate a blocked or delayed `startTypingLoopFor()` and prove activity ingestion/flush scheduling is not blocked.
- Add or update tests for typing-loop non-overlap under retry-like delay.
- Add or update runtime hook coverage showing streamed assistant preview is not suppressed indefinitely by activity/typing completion barriers.
- Run `npm run check`.

## Pre-edit Impact Preview

Likely blast radius is moderate and localized to activity rendering, typing-loop orchestration, and pi hook tests. Main risk is accidentally weakening the chronology fix from `b1e4802`; implementation should preserve chronological readability while making low-value typing indicators non-blocking.

## Decisions

- 2026-04-27: Implementation starts from the ready task as scoped. Pre-edit impact: modify activity renderer typing invocation, typing-loop state in the extension composition root, and focused check scripts; preserve chronology by making typing advisory rather than weakening activity completion semantics.
- 2026-04-27: Implemented typing as an advisory controller: activity rendering now records and schedules updates without awaiting typing startup, while typing sends use a per-turn in-flight guard so retry-aware sendChatAction waits suppress overlapping sends instead of spawning parallel attempts.
- 2026-04-27: Regression coverage now exercises blocked typing startup at both ActivityRenderer and runtime-hook chronology boundaries, plus typing-loop non-overlap with message_thread_id preservation and passive activity send options.
- 2026-04-27: Review found stopped typing loops could leave an in-flight retry-aware sendChatAction asleep until retry_after elapsed. The typing controller now creates an AbortController per in-flight typing send and aborts it on stop/stopAll, preserving cleanup semantics for stopped turns while still honoring retry_after for live typing loops.
