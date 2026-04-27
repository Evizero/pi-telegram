---
title: "Final Telegram message can appear before activity update"
type: "bug"
created: "2026-04-27"
author: "Christof Salis"
status: "planned"
planned_as: ["append-telegram-finals-after-settling"]
---
User observed that sometimes the agent works for a while and Telegram shows activity, then when it finishes the final assistant message appears earlier in the Telegram ordering than the activity message. User suspects another existing message is edited instead of a new message being appended for the last agent message. Requested investigation: "investigate if you find something".


Investigation result: the final delivery ledger was editing the visible assistant preview message into the final response (`src/broker/finals.ts`), while activity segments can be sent later in the chat after assistant text has already begun (`src/pi/hooks.ts` / `ActivityRenderer`). Because Telegram edits keep the original message position, the final text could remain above a later Activity message even though final delivery completed activity first. Implemented a fix to delete the preview message and send the final text as a fresh message, falling back to editing only if deleting the preview fails non-retryably. Validation: `npm run check` passed.

Close-out correction: the final implementation does not fall back to editing previews into final content. It treats previews as temporary, performs retry-aware cleanup before final text, records permanent cleanup limitations, and always appends final assistant text/notices via fresh sendMessage. Regression coverage covers durable preview references, retry_after/transport cleanup blocking, permanent cleanup refusal, error-only and attachment-only notices, and legacy edit-based pending-final migration.
