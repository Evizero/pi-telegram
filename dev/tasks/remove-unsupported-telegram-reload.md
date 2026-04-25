---
title: "Remove unsupported Telegram reload command"
status: "done"
priority: 2
created: "2026-04-25"
updated: "2026-04-25"
author: ""
assignee: ""
labels: []
traces_to: ["SyRS-local-authority-boundary"]
source_inbox: "telegram-reload-should-be"
branch: "task/remove-unsupported-telegram-reload"
---
## Objective

Completely remove the unsupported Telegram `/reload` runtime-reload workflow because the current pi extension API does not provide a safe way to trigger runtime reload from Telegram-only control.

## Scope

- Remove Telegram-facing `/reload` command handling and help text.
- Remove the internal `/telegram-reload-runtime` command used by the broken command-injection workaround.
- Remove broker/client IPC messages, queues, intent state, helper functions, and types that only supported Telegram-triggered runtime reload.
- Preserve unrelated `reload_config` behavior, which refreshes extension configuration and is not the Telegram runtime reload feature.
- Preserve existing route/session behavior and unrelated activity-rendering work already in the worktree.

## Acceptance criteria

- `/reload` is no longer advertised in Telegram help text.
- `/reload` is no longer handled as a Telegram broker command.
- No code path sends `/telegram-reload-runtime <intent>` as a user/follow-up message.
- `reload_runtime`, `reload_started`, `reload_failed`, `reloadIntents`, and `TelegramReloadIntent` runtime plumbing are removed.
- Old persisted broker state containing reload intent fields is harmlessly ignored/stripped on subsequent save rather than used.
- `npm run check` passes.

## Decisions

- 2026-04-25: Remove the Telegram reload feature instead of keeping a known-broken command. It can be reconsidered only after pi exposes a safe reload API for extension contexts or an intentional extension command execution API.
- 2026-04-25: 2026-04-25: Implemented removal by deleting Telegram /reload command handling, internal telegram-reload-runtime command, reload IPC messages, reload queues/helpers, reload intent type/state, broker reload helper module, and README/architecture mentions. Kept only a load-time legacy deletion of reloadIntents so old persisted broker state is stripped instead of used.
- 2026-04-25: Review loop: first review found README BotFather command list still advertised reload; removed that line. Fresh review reported no findings on reload removal. npm run check passed after the fix.
