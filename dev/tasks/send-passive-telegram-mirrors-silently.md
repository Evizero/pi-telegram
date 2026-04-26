---
title: "Send passive Telegram mirrors silently"
status: "done"
priority: 3
created: "2026-04-26"
updated: "2026-04-26"
author: "Christof Salis"
assignee: ""
labels: []
traces_to: ["SyRS-silent-passive-telegram-updates", "SyRS-mirror-local-user-input", "SyRS-activity-history-rendering", "SyRS-telegram-text-method-contracts"]
source_inbox: "silent-telegram-notifications-for"
branch: "task/send-passive-telegram-mirrors-silently"
---
## Objective

Make Telegram delivery for targeted passive visibility updates non-alerting: local pi-user messages mirrored from laptop input and broker activity-renderer status messages should update the Telegram route without causing Telegram notification alerts.

## Scope

- Add a per-call silent/notification option to the text send helper path instead of making every bridge reply silent globally.
- Use the silent option when `handleLocalUserMessage()` mirrors `formatLocalUserMirrorMessage(...)` output to Telegram.
- Confirm `ActivityRenderer` broker activity/status sends continue to use `disable_notification: true` for initial `sendMessage` requests and cover any similar broker-activity sends introduced or touched in this slice.
- Preserve `message_thread_id` on all affected sends.
- Keep Telegram `retry_after` behavior unchanged; do not convert rate-limit handling into fallback or immediate retry.

## Codebase grounding

Likely touchpoints:

- `src/extension.ts`
  - `handleLocalUserMessage()` currently calls `sendTextReply(...)` without a silent option.
  - `sendTextReply()` and `sendMarkdownReply()` are shared by command/setup/error/final-adjacent flows, so the change should be opt-in.
- `src/broker/activity.ts`
  - `ActivityRenderer.doFlush()` already sets `disable_notification: true` for initial activity messages; inspect and preserve this behavior.
- `src/telegram/previews.ts`, `src/broker/finals.ts`, and `src/telegram/attachments.ts`
  - Treat these as neighboring send paths to avoid accidentally silencing assistant previews, final replies, preview/final delivery, or attachment failure notices unless the requirements explicitly say so.
- `docs.md`
  - Add or update the text-method guidance to mention bridge use of Telegram `disable_notification` for passive local-user mirrors/activity if implementation changes that policy.

## Acceptance Criteria

- Mirrored local interactive pi user input sent to Telegram includes `disable_notification: true` on every `sendMessage` request, including chunked messages.
- Broker activity-renderer initial `sendMessage` requests still include `disable_notification: true`; edits continue to preserve route/thread context.
- Assistant previews, final assistant replies, setup/pairing messages, Telegram command replies, explicit errors/status replies, and attachment failure notices remain normally notifying unless a separate future requirement changes them.
- Long text chunking, non-empty message handling, Markdown fallback behavior, and `message_thread_id` preservation remain intact.
- Telegram `retry_after` propagation/waiting behavior is not weakened.

## Validation

- Add focused unit-level or inspection-style coverage if the current test harness permits it; otherwise add a small local check similar in spirit to `scripts/run-activity-check.mjs` that exercises the relevant body construction paths.
- Run `npm run check` before reporting implementation complete.

## Out of Scope

- Do not redesign Telegram notification preferences globally.
- Do not make final assistant answers or command replies silent by default.
- Do not alter route selection, broker persistence, preview finalization, or attachment delivery semantics beyond preserving the silent flag on the targeted passive sends.

## Decisions

- 2026-04-26: Implemented the silent-send policy as an opt-in Telegram text helper option shared by plain and Markdown replies. Local pi-user mirror calls pass disableNotification=true; existing broker activity rendering already set disable_notification for its initial status message and was left intact. Assistant previews, finals, command/setup/error replies, and attachment failure notices remain normally notifying unless a caller opts in later.
