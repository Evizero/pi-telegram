---
title: "Silence streamed assistant preview notifications"
status: "rejected"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: ""
labels: []
traces_to: ["SyRS-silent-passive-telegram-updates", "SyRS-final-preview-deduplication"]
source_inbox: "telegram-final-notification-can"
branch: "task/silence-streamed-assistant-preview"
---
## Objective

Prevent the user-visible double-notification effect at the end of longer Telegram-supervised agent turns by making streamed assistant preview messages silent. The final assistant response should remain the normal notifying message.

The confirmed failure mode is not duplicate final delivery. When a turn streams long enough for a visible preview to flush, the bridge currently sends a non-silent preview message, later deletes that preview, and sends the final answer as a fresh non-silent message. Telegram can therefore alert or animate twice even though only the final message remains.

## Planning context

This task implements the refined non-alerting supervision requirement from `telegram-final-notification-can`. It deliberately preserves `SyRS-final-preview-deduplication`: final answer text must still be sent as fresh Telegram messages after detaching/cleaning up any preview, rather than editing the preview into the final. The clean fix is to make provisional preview sends non-alerting, not to collapse final delivery back into preview editing.

## Pre-edit impact preview

- Likely code touchpoints: `src/telegram/previews.ts` and preview/final regression scripts under `scripts/`, especially `scripts/check-preview-manager.ts` and possibly `scripts/check-runtime-pi-hooks.ts` or `scripts/check-final-delivery.ts` if assertion coverage should be clearer.
- Likely planning/doc touchpoints: task only unless implementation reveals architecture text is now misleading. The existing architecture already separates advisory previews from final delivery; no architecture rewrite is expected for simply silencing preview sends.
- Main risks: accidentally silencing final answers, setup/command/error replies, or attachment notices; weakening preview cleanup/final chronology; missing the replacement-preview path used when editing a stale preview fails.

## Codebase grounding

- `src/telegram/previews.ts` owns streamed assistant preview rendering. Its `flush()` method sends the initial visible preview with `sendMessage` when `state.messageId` is undefined, and sends a replacement preview with `sendMessage` if an existing preview message cannot be edited. Both preview send paths should carry `disable_notification: true` while preserving `message_thread_id`.
- `src/broker/finals.ts` owns durable final delivery. Its `sendMarkdownMessage()` and plain final send paths should remain normally notifying unless another requirement changes them later.
- `src/broker/activity.ts` already marks activity renderer messages silent and should not need behavior changes.
- `src/telegram/text.ts` already supports `disableNotification` for shared text replies; avoid broad changes there that accidentally silence unrelated operator-facing messages.

## Acceptance Criteria

- Assistant preview `sendMessage` calls include `disable_notification: true` for both the initial visible preview and replacement preview after a stale/missing editable message, with `message_thread_id` preserved when present.
- Final assistant response `sendMessage` calls remain normally notifying by default and do not inherit preview silence.
- Existing final chronology remains intact: visible previews are detached/deleted before final text is sent fresh, and final text is not delivered by editing an older preview message.
- Activity renderer and local-input mirror silence remain intact.
- Telegram `retry_after`, message-not-modified handling, and missing/stale preview recovery semantics remain unchanged except for the added preview silence flag.

## Out of Scope

- Do not redesign preview/final chronology or reintroduce editing previews into final answers.
- Do not enable or rely on Telegram draft mode in this slice.
- Do not silence final answers, explicit command replies, setup replies, explicit errors, or attachment failure notices.
- Do not remove the visible delete/reappear animation when the Telegram chat is open; this task targets unwanted notification alerts while preserving the current fresh-final behavior.

## Validation

- Extend preview-manager regression coverage to assert `disable_notification: true` on preview `sendMessage` bodies, including the stale-preview replacement path.
- Add or adjust final-delivery coverage to assert final text sends remain non-silent where useful.
- Run `npm run check`.

## Decisions

- 2026-04-28: Planning chose silent assistant previews as the clean fix because it addresses the extra notification while preserving the established final-preview deduplication and chronology requirement.
- 2026-04-28: Planning review reported no findings: the StRS/SyRS/task chain is coherent, preserves final-preview deduplication, and covers preview silence edge cases without silencing final answers.
- 2026-04-28: Superseded before implementation by the project owner's 2026-04-28 voice-note direction to stop streaming assistant text previews entirely and wait for final assistant text instead of merely silencing previews.
