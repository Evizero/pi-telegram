---
title: "Omit main branch from default Telegram topic names"
status: "review"
priority: 3
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "topic-naming", "ux"]
traces_to: ["SyRS-register-session-route", "SyRS-topic-routes-per-session"]
source_inbox: "omit-main-branch-from"
branch: "task/omit-main-branch-from-default-telegram"
---
## Objective

Adjust the default Telegram topic-name formatter so it omits the Git branch segment when the branch is `main`, while preserving the current project-plus-branch behavior for other branches.

## Codebase grounding

Likely touchpoints:
- `src/shared/format.ts` for `topicNameFor(...)`
- `src/client/session-registration.ts` and `src/extension.ts` where registration/topic names are refreshed
- focused checks under `scripts/` if there is already coverage for naming helpers or registration formatting

## Acceptance criteria

- A session on `main` gets the default topic name without a ` · main` suffix.
- Sessions on non-main branches still include the branch in the default topic name.
- Existing session-name dedupe behavior still works when `piSessionName` matches an existing piece case-insensitively.
- Long-name truncation and hashing behavior remain unchanged apart from the omitted `main` segment.

## Validation

Run focused checks covering `topicNameFor(...)` for `main`, non-main, session-name dedupe, and truncation behavior, then run `npm run check` if implementation proceeds.

## Decisions

- 2026-04-25: 2026-04-25: Added focused checks in scripts/check-pairing-and-format.ts for main-branch omission, non-main branch retention, case-insensitive piSessionName dedupe, and truncation/hash preservation. A focused compile-and-run of that check passed. npm run check is currently blocked by unrelated pre-existing compaction-check TypeScript errors in scripts/check-manual-compaction.ts from task queue-telegram-input-during-compaction.
- 2026-04-25: 2026-04-25: Implemented the naming change in topicNameFor(...) by omitting the Git branch segment only when the normalized branch name is main, keeping non-main branches, existing case-insensitive piSessionName dedupe, and existing truncation/hash behavior unchanged.
