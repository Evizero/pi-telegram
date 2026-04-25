---
title: "Setup getMe should use retry-aware Telegram API path"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: setup token validation calls Telegram `getMe` directly with `fetch` and GET instead of the shared POST/retry-aware Bot API path.

Evidence:
- `src/extension.ts` `promptForConfig()` directly calls `fetch("https://api.telegram.org/bot.../getMe")`.

Requirement: `SyRS-telegram-retry-after`; docs.md request/response contract.

Fix direction: validate candidate bot tokens through the same low-level POST JSON helper/retry wrapper used by other Telegram API calls, parameterized with the candidate token.
