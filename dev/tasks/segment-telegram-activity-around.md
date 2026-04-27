---
title: "Segment Telegram activity around interleaved assistant text"
status: "done"
priority: 2
created: "2026-04-27"
updated: "2026-04-27"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "activity", "preview"]
traces_to: ["SyRS-activity-history-rendering", "SyRS-final-preview-deduplication"]
source_inbox: "pi-streams-assistant-text"
branch: "task/segment-telegram-activity-around"
---
## Objective

Keep the Telegram timeline chronological when pi streams visible assistant prose in the middle of a still-active turn. If activity has already been rendered and pi then emits normal assistant text, the bridge should finish the current activity message before showing the assistant text, and route later thinking/tool activity into a new activity message after that assistant text.

This preserves the useful behavior that mid-turn assistant text becomes visible in Telegram, while avoiding an older activity message being edited after a newer assistant message appears.

## Source context

The source inbox item records that pi legitimately streams `text_start` / `text_delta` / `text_end` events separately from `thinking_*` events. The user specifically wants the Telegram order to read as activity → assistant text → later activity when those visible text events are interleaved with continued work.

## Codebase grounding

Likely touchpoints:

- `src/pi/hooks.ts`
  - Currently posts thinking/tool activity through `ActivityReporter` and posts assistant previews on every assistant `message_update` using `getMessageText(event.message)`.
  - Should detect visible text stream events and create an ordering boundary before preview delivery when there is prior activity to finish.
- `src/broker/activity.ts`
  - Owns activity message state, debounced Telegram sends/edits, completion behavior, closed-turn guards, and typing-loop start.
  - Should preserve the existing turn identity as the lifecycle/final-cleanup key while allowing distinct activity-message segments inside that turn. Segment identity, if added, should be an IPC/rendering concern rather than a replacement for the Telegram turn ID.
- `src/extension.ts`
  - Owns broker IPC dispatch and should expose only the narrow broker message needed to complete an activity segment if the client hook cannot do it through existing messages.
- `scripts/check-activity-rendering.ts` and `scripts/check-runtime-pi-hooks.ts`
  - Add regression coverage for segment ordering and hook event order without needing a live Telegram bot.

## Acceptance Criteria

- When a Telegram turn has pending or visible activity and pi emits a visible assistant text stream event, the current activity message is flushed and completed before the assistant preview/message is posted.
- Continued thinking/tool activity after that visible assistant text is rendered as a new Telegram activity message after the assistant text, not as edits to the earlier activity message.
- Segment completion is not the same as turn completion: finishing an intra-turn activity segment must not mark the Telegram turn closed, stop all later activity for that turn, consume the turn, or interfere with final delivery.
- The renderer keeps turn-scoped cleanup and guards: final turn cleanup completes/closes every known activity segment for the turn before final handling finishes, and late updates after the actual turn final remain ignored.
- Segment identity, if introduced, is deterministic within the active turn and carried only where needed for activity rendering/IPC; it does not replace `turnId` for typing loops, preview state, final delivery, pending-turn bookkeeping, route cleanup, or retry-aware finalization.
- If pi emits visible assistant text before any activity exists, no empty activity message is created or completed.
- Existing activity-history behavior remains intact: thinking/tool events stay ordered within a segment, Telegram activity sends/edits stay debounced, completed thinking/tool rows are not lost, and `message_thread_id`/typing behavior remain preserved.
- Existing assistant preview/final deduplication remains intact: the interleaved assistant text is not duplicated as both a preview and final beyond the existing preview finalization behavior.

## Out of Scope

- Do not change pi streaming semantics or suppress legitimate assistant text events.
- Do not redesign assistant final delivery, retry-aware finalization, Telegram route selection, topic management, or attachment behavior.
- Do not make activity messages alerting; passive activity rendering should remain silent.

## Validation

- Add or update local activity-rendering checks to prove a completed activity segment is not edited after an interleaved assistant preview and that later work creates a new activity message.
- Add or update runtime pi-hook checks to prove text stream events emit the activity-completion boundary before assistant preview, and later activity uses a new segment identifier.
- Run `npm run check`.

## Pre-edit impact preview

Likely implementation is limited to the pi event hook boundary, broker activity renderer state, broker IPC dispatch, and local check scripts. The main risks are accidentally dropping late tool-result updates, completing empty activity messages, weakening the closed-turn guard against post-final edits, or causing duplicate preview/final messages.

## Decisions

- 2026-04-27: Implemented intra-turn activity segmentation as an activity-rendering/IPC concern: the original turnId remains the lifecycle key for typing, previews, final delivery, and cleanup, while optional activityId values identify later activity messages after interleaved visible assistant text. The pi hook completes the current activity segment before posting assistant preview text only when prior activity exists.
- 2026-04-27: Kept activity segment state across retry-deferred agent_end results so a retry for the same Telegram turn does not restart at the already-closed base segment. Segment state is cleared only when active-turn finalization is not deferred.
- 2026-04-27: Do not advance to the next activity segment or post the interleaved assistant preview if the broker does not acknowledge the activity_complete boundary. The next text update can retry the boundary; meanwhile later activity remains on the existing segment instead of making chronology appear completed when it was not.
- 2026-04-27: Activity segment completion now also marks active tool rows complete by removing their active marker while preserving their arguments, so a closed segment does not remain visually bold/running after an interleaved assistant preview.
- 2026-04-27: Also preserve segment state when active-turn finalization reports completed but the same active turn remains in place awaiting broker final handoff; segment state is cleaned up only once the active turn has actually moved on.
