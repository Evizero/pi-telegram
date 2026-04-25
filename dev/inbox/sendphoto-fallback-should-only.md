---
title: "sendPhoto fallback should only handle photo contract failures"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: outbound attachment sending falls back from `sendPhoto` to `sendDocument` for any non-rate-limit error, including unrelated errors such as bad chat/thread or permissions.

Evidence:
- `src/telegram/attachments.ts` catches `sendPhoto` errors and falls back unless `retry_after` is present.

Requirement: `SyRS-outbound-photo-document-rules`.

Fix direction: classify known photo-contract failures before falling back; otherwise report or propagate the original Telegram failure.
