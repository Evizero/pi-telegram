---
title: "Validate setup getMe through retry-aware API"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "telegram-voice"
assignee: ""
labels: []
traces_to: ["SyRS-telegram-retry-after"]
source_inbox: "setup-getme-should-use"
branch: "task/validate-setup-getme-through-retry"
---
## Objective

Make Telegram setup token validation use the same retry-aware Bot API path as normal runtime JSON calls.

Setup currently validates a candidate token with direct GET `fetch(.../getMe)` and inline JSON parsing. It should instead use shared POST/error handling and `retry_after` preservation with the candidate token.

## Scope

Keep the interactive setup UX the same: the user enters a bot token, setup validates it with `getMe`, stores bot metadata and pairing state, and shows pairing instructions. Change only the Telegram API call path and related tests.

## Codebase grounding

- `src/telegram/setup.ts` currently calls `fetch(https://api.telegram.org/bot.../getMe)` directly.
- `src/telegram/api.ts` owns `callTelegram()`, `TelegramApiError`, and response-parameter parsing for JSON Bot API calls.
- `src/telegram/retry.ts` owns `withTelegramRetry()`.
- `src/client/connection.ts` already uses the normal `callTelegram("getMe", {})` path after config exists; setup needs the same behavior while parameterized by a not-yet-persisted candidate token.

## Acceptance Criteria

- Setup `getMe` validation uses POST JSON through shared Bot API response/error handling.
- `ResponseParameters.retry_after` from setup validation is honored rather than treated as a generic invalid-token failure.
- Invalid-token and malformed/non-OK Telegram responses still produce clear setup errors without persisting the candidate token as paired config.
- Successful setup still records bot id, username, topic capability, pairing hash/timestamps, and broker scope as before.

## Out of Scope

- Do not redesign the attended PIN pairing flow.
- Do not change normal `/telegram-connect` behavior beyond shared setup validation.
- Do not add configurable Bot API base URL in this slice.

## Validation

- Add focused setup tests or runtime checks for success, invalid token, and retry_after behavior.
- Run `npm run check`.

## Decisions

- 2026-04-28: Setup getMe validation now uses shared POST callTelegram through withTelegramRetry with the candidate token; invalid token errors are still reported without persisting config.
- 2026-04-28: Close-out validation passed: npm run check, pln hygiene, and final review agent re-review reported no findings.
