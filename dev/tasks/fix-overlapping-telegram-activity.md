---
title: "Fix overlapping Telegram activity flush stall"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: ""
labels: []
traces_to: ["SyRS-activity-history-rendering", "SyRS-final-preview-deduplication", "SyRS-final-delivery-fifo-retry", "SyRS-telegram-retry-after"]
source_inbox: "telegram-activity-can-stop"
branch: "task/fix-overlapping-telegram-activity"
---
## Objective

Restore live Telegram activity updates during busy turns when a previous activity flush is still in flight. The renderer must keep debounced activity sends/edits progressing even if a timer fires during an existing flush, so activity does not batch until final completion.

## Planning context

This task plans the confirmed bug from `dev/inbox/telegram-activity-can-stop.md`. The current architecture already says activity collection must preserve ordered history while Telegram rendering debounces visible edits, and that typing/other advisory behavior must not block activity, previews, or finals. No new product behavior or architectural seam is intended here; the task should repair renderer bookkeeping so the existing contract becomes true under overlapping flush timing.

## Pre-edit impact preview

- Likely code touchpoints: `src/broker/activity.ts` and `scripts/check-activity-rendering.ts`.
- Possible nearby checks: `scripts/check-runtime-pi-hooks.ts` only if the chosen fix changes chronology boundaries or reveals a related regression.
- Likely planning/doc touchpoints: probably task-only; update `dev/ARCHITECTURE.md` only if implementation reveals the current activity-rendering contract is incomplete or inaccurate.
- Main risks: regressing activity ordering, causing duplicate or overly eager flushes, or weakening preview/final chronology around `completeActivity()` and final delivery.

## Codebase grounding

- `src/broker/activity.ts` owns activity message state, debounced flush scheduling, and turn/activity completion. The reproduced bug lives in the interaction between `scheduleFlush()` and `flush()` when `this.flushes.get(activityId)` is already populated.
- `scripts/check-activity-rendering.ts` already covers blocked typing startup, chronology segmentation, stale in-flight completion cleanup, and other renderer edge cases; extend it with a direct regression proving that activity arriving during an in-flight flush still triggers a later visible flush after the first flush resolves.
- Final delivery still closes activity through `AssistantFinalDeliveryLedger` and `ActivityRenderer.complete()`, so the fix must preserve the current guarantee that final responses do not depend on stale activity rows being left active forever.

## Acceptance Criteria

- When an activity flush is already in flight and additional activity arrives before it completes, the renderer still performs a later send/edit after the first flush resolves instead of leaving later lines buffered until turn completion.
- Activity history remains ordered and debounced; the fix does not create duplicate visible rows or overlapping flush storms for the same activity message.
- Existing chronology behavior remains intact: activity that must complete before assistant preview/final transitions still does so, and the fix does not reintroduce batching behind typing startup or preview/final ordering regressions.
- Telegram `retry_after` compatibility remains intact: a slow or waiting Telegram send/edit may delay the next visible flush, but it must not permanently wedge future activity scheduling once the in-flight attempt settles.
- Passive activity messages remain silent (`disable_notification: true`) with thread routing preserved.

## Out of Scope

- Do not redesign the broader activity/preview/final architecture or replace debouncing with per-event sends.
- Do not broaden this slice into unrelated typing-loop, route cleanup, or final-ledger behavior unless a newly discovered regression is required to make the flush-stall fix correct.
- Do not change user-facing activity formatting except as needed for a focused regression test or renderer correctness.

## Validation

- Add focused renderer regression coverage for overlapping timer/in-flight flush behavior, ideally by blocking one Telegram send/edit, letting another debounce timer fire, then proving a subsequent flush still occurs after release.
- Run `npm run check`.
- If implementation reveals a broader timing edge case, document it in task decisions and extend validation only as far as needed to keep the fix honest.

## Decisions

- 2026-04-28: Planning concluded that the bug is already covered by existing SyRS and architecture direction; a new requirement or architecture revision is not needed before implementation unless the fix uncovers a deeper contract gap.
- 2026-04-28: Local reproduction confirmed the stall: after an overlapping timer fires during an in-flight flush, `flushTimer` can remain truthy with no in-flight flush, leaving later activity buffered until some later completion path forces a flush.
- 2026-04-28: Planning review reported no findings; the task is concrete, codebase-grounded, and ready to implement without adding new requirements or architecture changes first.
- 2026-04-28: Implemented the renderer fix with per-activity render-pending bookkeeping so overlapping timer flushes trigger exactly one follow-up flush after an in-flight send/edit settles, while completion and teardown stop cleanly if the renderer state has already been cleared.
- 2026-04-28: Validation passed with node scripts/run-activity-check.mjs and npm run check, and the latest implementation review reported no findings.
- 2026-04-28: Close-out confirmed the implementation satisfies the acceptance criteria and traced SyRS, preserves activity/final chronology, and needs no requirement or architecture change before archive.
