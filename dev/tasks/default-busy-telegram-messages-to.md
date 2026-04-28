---
title: "Default busy Telegram messages to follow-up with steer controls"
status: "done"
priority: 1
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: "pi-agent"
labels: []
traces_to: ["SyRS-busy-message-default-followup", "SyRS-queued-followup-steer-control", "SyRS-follow-queues-next-turn", "SyRS-defer-telegram-during-compaction", "SyRS-durable-update-consumption", "SyRS-telegram-retry-after"]
source_inbox: "default-telegram-busy-messages"
branch: "task/default-busy-telegram-messages-to"
---
## Objective

Make Telegram busy-time ordinary messages default to queued follow-up work while preserving a low-friction, explicit way to steer a specific queued message into the current active turn.

The implementation should satisfy the accepted source item `default-telegram-busy-messages`: ordinary messages received while a selected session is already active/queued should no longer steer by default; `/follow` remains a compatibility path for explicit queued work; `/steer <message>` and Telegram inline controls provide explicit steering.

## Scope

- Change default client delivery semantics so only explicit steering (`deliveryMode = "steer"`) steers an active pi turn.
- Preserve idle-message behavior: ordinary Telegram messages should still start normally when the client is idle.
- Add durable broker-owned queued-turn control state with compact callback tokens and route/session context.
- After a turn is accepted as queued while an active turn exists, send a routed Telegram status message with a `Steer now` inline button for that exact queued turn.
- Add callback handling that converts a still-queued turn into steering exactly once via client IPC.
- Keep `/follow <message>` as explicit follow-up and add `/steer <message>` as an explicit text-command accessibility path.
- Expire/remove queued-turn controls when the turn starts normally, is converted, is suppressed by `/stop`, or becomes stale.

## Preserved behavior

- Slash commands keep command semantics and must not become queued user turns.
- Unauthorized callback and message handling remains fail-closed through the existing update authorization gate.
- Pending turns remain retry-safe until consumed; converting a queued turn to steering must mark it consumed so broker retry does not later enqueue it as a follow-up.
- Telegram `retry_after` from callback answers or message edits remains retry-significant and must not be swallowed as ordinary UI failure.
- Media groups and attachments stay attached to the queued turn; conversion changes delivery mode only and must not delete temp files.
- Manual compaction continues to defer Telegram input and resume it without concurrent pi turns.
- Existing model-picker callbacks keep working.

## Codebase grounding

Likely touchpoints:

- `src/shared/types.ts`: queued-turn control and client conversion result types.
- `src/broker/commands.ts`: default delivery mode, `/steer`, queued-control creation, callback parsing/handling, control expiry.
- `src/client/turn-delivery.ts`: return queued metadata and stop default steering for ordinary busy messages.
- `src/client/runtime.ts`, `src/client/manual-compaction.ts`, `src/extension.ts`: client-side atomic conversion/removal from queues and IPC handler.
- `dev/INTENDED_PURPOSE.md`, `dev/ARCHITECTURE.md`, `SPEC.md`, `README.md` if their user-facing/default-behavior text contradicts the new baseline.
- `scripts/check-client-turn-delivery.ts`, `scripts/check-telegram-command-routing.ts`, `scripts/check-manual-compaction.ts`: regression coverage.

## Acceptance criteria

- Ordinary Telegram messages delivered while a client has an active Telegram/pi turn are queued as follow-up and do not call `sendUserMessage(..., { deliverAs: "steer" })`.
- Idle ordinary Telegram messages still start normally.
- `/follow <message>` still queues follow-up work.
- `/steer <message>` steers active work when possible and falls back to normal queued/start behavior when there is no active turn.
- A queued follow-up with an offered `Steer now` callback can be converted to steering once, is removed from local queues before sending, is acknowledged/consumed, and cannot later start as its own follow-up.
- Duplicate, stale, wrong-route, already-started, stopped, or offline callback cases answer safely and do not duplicate delivery.
- Broker failover or crash around a converting callback is handled without duplicate steering, lost queued work, or permanently stuck controls.
- Manual-compaction deferred input preserves order under the new default-follow-up semantics.
- Existing model-picker callback and command-routing behavior remains covered.

## Out of scope

- Do not integrate buttons directly into activity bubbles in this first implementation slice; use a routed queued-status message with an inline button as the safer first UI.
- Do not add multi-user authorization or hosted relay behavior.
- Do not redesign pi's `sendUserMessage` semantics beyond the bridge's delivery-mode choices.

## Validation

Run targeted scripts through `npm run check`, with added cases for default follow-up, explicit steer, queued-control conversion, duplicate/stale callbacks, broker failover/converting-state recovery, and manual compaction ordering. Run `pln hygiene` before reporting implementation completion.

## Decisions

- 2026-04-28: Implemented the first UI slice with a separate silent queued-status message carrying a route-scoped Steer now button, leaving activity-bubble integration out of scope as planned.
- 2026-04-28: Client conversion removes the queued turn before sending it as steer; broker controls persist converting/converted/expired state so duplicate callbacks and broker failover around conversion do not duplicate delivery.
