---
title: "Format local pi user mirror messages"
status: "done"
priority: 3
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["ux", "telegram", "next"]
traces_to: ["SyRS-mirror-local-user-input", "SyRS-telegram-text-method-contracts", "SyRS-topic-routes-per-session"]
source_inbox: "format-pi-user-telegram"
branch: "task/format-local-pi-user-mirror-messages"
---
## Objective

Improve the Telegram mirror of local interactive pi user messages so the phone view clearly shows them as local pi user input instead of the current rough `pi user:` prefix.

## Scope

- Replace the current `pi user:\n\n...` mirror text with a clear title-style presentation such as `PI User Message`.
- Preserve the routed chat/topic used for the connected session.
- Preserve the local message body and the existing image-count notice.
- Keep the current filter behavior: only mirror interactive non-command local input, and continue ignoring slash commands and Telegram prompt text.
- Use a safe Telegram formatting approach: if bold/title markup is used, user-provided message text must not be interpreted as unsafe or accidental markup, and Telegram text size/empty-text constraints must still be respected.

## Codebase Grounding

The likely runtime touchpoint is `handleLocalUserMessage()` in `src/extension.ts`, with possible helper extraction into `src/shared/format.ts` if escaping or formatting becomes reusable. The input hook that decides which local messages to mirror is in `src/pi/hooks.ts` and should not be broadened in this slice unless needed for correctness.

## Acceptance Criteria

- A local interactive user message in a connected pi session is mirrored to Telegram with a distinct local-user title.
- Message content remains visible and is not corrupted by Telegram parse mode or escaping rules.
- The existing image-count suffix remains visible when local images are attached in pi.
- Slash commands, empty input, and Telegram prompt text remain unmirrored.
- The mirror still targets the connected session route/thread.

## Preserved Behavior

- This mirror remains informational; it must not create a Telegram-originated turn or alter busy-turn steering/follow-up behavior.
- Activity previews, final responses, and attachment delivery must not be reformatted or duplicated by this change.

## Out of Scope

- Redesigning all activity rendering.
- Changing final response formatting.
- Adding new Telegram commands or session-routing behavior.

## Validation

Run `npm run check`. The check suite now includes `scripts/check-pairing-and-format.ts` coverage for the local-user mirror formatter, including title text, body preservation, literal markup preservation, and image-count suffix behavior. Inspect `src/pi/hooks.ts` and `handleLocalUserMessage()` in `src/extension.ts` to confirm routing and filtering remain unchanged.

## Coordination Note

This is a small UX polish task intended to travel with the mobile pairing PIN work, but it should stay separated from pairing authorization logic in code and review.

## Decisions

- 2026-04-25: Implementation uses plain sendMessage text with the title 'PI User Message' instead of Telegram parse-mode markup, so user-provided local input is mirrored without escaping or accidental formatting risk while preserving the routed chat/thread.
