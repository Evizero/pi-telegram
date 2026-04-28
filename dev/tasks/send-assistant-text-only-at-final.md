---
title: "Send assistant text only at final delivery"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: ""
labels: []
traces_to: ["SyRS-final-preview-deduplication", "SyRS-activity-history-rendering", "SyRS-final-delivery-fifo-retry", "SyRS-silent-passive-telegram-updates"]
source_inbox: "stop-streaming-assistant-text"
branch: "task/final-only-assistant-text"
---
## Objective

Stop sending assistant response text to Telegram as streamed/provisional preview messages during ordinary Telegram-supervised turns. Keep live supervision through activity rendering and send assistant text once through the existing durable final-delivery ledger when the agent finishes.

This replaces the earlier narrower plan to silence streamed previews. The desired user experience is: activity can update while the agent works, but assistant response text appears only as the final answer.

## Planning context

The project owner changed direction after the double-notification investigation: model responses are fast enough that streamed assistant text previews do not add enough value to justify notification churn or preview replacement complexity. This task implements the updated `SyRS-final-preview-deduplication` requirement, which now treats final-only assistant text as the normal behavior while preserving cleanup compatibility for any existing preview state.

The task still preserves durable final delivery, FIFO retry, route/thread context, and final deduplication. It should remove the ordinary preview-producing path, not weaken final ledger behavior.

## Pre-edit impact preview

- Likely code touchpoints: `src/pi/hooks.ts`, `src/extension.ts`, `src/telegram/previews.ts`, `src/shared/types.ts` only if stale preview types can be narrowed safely, and regression scripts such as `scripts/check-runtime-pi-hooks.ts`, `scripts/check-preview-manager.ts`, and `scripts/check-final-delivery.ts`.
- Likely planning/doc touchpoints: `dev/ARCHITECTURE.md` has already been revised to describe final-only assistant text as the target architecture; update again only if implementation reveals a different boundary.
- Main risks: losing live progress visibility by accidentally suppressing activity, breaking final delivery handoff/retry, leaving stale durable preview refs uncleared across broker turnover, or removing preview compatibility too aggressively for in-flight/migrated state.

## Codebase grounding

- `src/pi/hooks.ts` currently posts `assistant_message_start` and `assistant_preview` IPC during assistant `message_start` / `message_update`. The ordinary `assistant_preview` emission on text streaming should stop. Thinking/tool activity reporting should remain intact.
- `finishActivityBeforeAssistantText()` and activity segmentation currently exist partly to keep activity chronology sensible before assistant preview text appears. With no assistant preview text, reassess whether text-stream events still need to close activity segments, or whether only final delivery should close outstanding activity.
- `src/extension.ts` currently routes `assistant_message_start`, `assistant_preview`, and `assistant_preview_clear` to `PreviewManager`. Normal runtime should no longer create visible preview messages, but final delivery may still need preview cleanup support for stale durable preview refs or old in-flight turns.
- `src/telegram/previews.ts` may remain as a compatibility cleanup helper initially, or be narrowed later. Do not delete it in this slice unless all callers/tests and stale-state paths are safely accounted for.
- `src/broker/finals.ts` remains the authority for Telegram final assistant response delivery and must continue to deliver text once, in order, with retry_after behavior preserved.

## Acceptance Criteria

- Assistant text streaming events during an ordinary active Telegram turn do not send `assistant_preview` IPC and do not create, edit, or delete Telegram preview messages.
- Thinking and tool activity updates still render live through the activity renderer, including route/thread preservation and existing silent activity behavior.
- Final assistant text is delivered once through `AssistantFinalDeliveryLedger` with FIFO retry, chunking, route/thread context, and attachment sequencing preserved.
- Any existing in-memory or durable assistant preview state from older/in-flight runtimes is still detached or cleaned before final delivery; final text is never delivered by editing a preview message.
- The rejected `silence-streamed-assistant-preview` behavior is not implemented as the main fix; preview silence is unnecessary when ordinary previews are not sent.
- Telegram `retry_after`, broker turnover, duplicate/redelivered final handoff, and missing/stale preview cleanup semantics remain safe.

## Out of Scope

- Do not remove live activity rendering or typing indicators just because assistant text previews stop.
- Do not redesign the final-delivery ledger, attachment delivery, or route lifecycle beyond what is needed to stop ordinary assistant previews.
- Do not enable Telegram draft streaming in this slice.
- Do not remove compatibility cleanup for existing preview message refs unless tests prove there is no remaining migration or retry path that needs it.
- Do not silence final answers; they remain ordinary notifying Telegram messages.

## Validation

- Update runtime hook checks to prove assistant text updates no longer emit `assistant_preview` IPC while thinking/tool activity still emits activity updates.
- Update preview/final tests so ordinary final-only turns have no preview send/edit/delete calls before final send.
- Keep or add coverage for stale durable preview cleanup before final delivery.
- Run `npm run check`.

## Decisions

- 2026-04-28: Planning superseded the preview-silencing task and chose final-only assistant text as the cleaner redesign because it eliminates provisional assistant-message notifications and replacement churn while preserving live activity supervision.
- 2026-04-28: Planning review initially found a source traceability gap from the original double-notification inbox to the replacement final-only task; after adding an explicit supersession note, re-review reported no findings.
- 2026-04-28: Implementation stopped emitting assistant_preview IPC from pi message_update text events, removed the preview-driven activity segmentation helper, and now leaves outstanding activity open until final delivery completes it. Compatibility preview cleanup remains in broker/final delivery paths for legacy or in-flight state.
- 2026-04-28: Implementation review after npm run check reported no findings across hook changes, regression checks, docs, and planning artifacts.
- 2026-04-28: Close-out confirmed all acceptance criteria are satisfied: ordinary assistant text updates no longer emit previews; activity and final delivery behavior remain covered; legacy preview cleanup compatibility remains; pln hygiene, npm run check, and implementation re-review all passed.
