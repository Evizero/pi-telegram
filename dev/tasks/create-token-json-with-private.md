---
title: "Create token JSON with private permissions"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "telegram-voice"
assignee: ""
labels: []
traces_to: ["SyRS-bridge-secret-privacy"]
source_inbox: "write-token-bearing-json"
branch: "task/create-token-json-with-private"
---
## Objective

Close the creation-time permission window for JSON files that may contain Telegram bot tokens, broker state, pending final handoff data, or other bridge secrets. Secret-bearing JSON should be created with private permissions before bytes are written, not made private only after `writeFile()` completes.

## Scope

This is a focused secret-storage hardening task. It should make the generic JSON write helper safe for current config/state callers and ensure the config parent directory is private before token-bearing config is written.

## Codebase grounding

- `src/shared/utils.ts` owns `writeJson()` and currently creates temp JSON through `writeFile(tempPath, ..., "utf8")`, then calls `chmod(tempPath, 0o600)`.
- `src/shared/config.ts` writes `~/.pi/agent/telegram.json`, which contains the bot token, after creating the parent directory with plain `mkdir()`.
- Other broker/client paths already call `ensurePrivateDir()` for many state directories, but `writeJson()` itself should not depend on every caller remembering to do so before secret bytes are written.
- Existing private-file precedent: `src/telegram/api.ts` writes downloaded files with `{ mode: 0o600 }`; `src/broker/lease.ts` writes `TOKEN_PATH` with `{ mode: 0o600 }`.

## Acceptance Criteria

- `writeJson()` creates its temporary JSON file with restrictive permissions at open/write time and retains atomic rename behavior.
- Token-bearing config writes ensure `~/.pi/agent` is private (`0700`) before writing `telegram.json`.
- Existing JSON readers and broker-state/final-handoff persistence behavior remain compatible.
- Tests or inspection cover the creation mode of the temp/write path, not just final chmod after the fact.

## Out of Scope

- Do not introduce encryption, keychain integration, or a broader secret-manager abstraction.
- Do not change JSON schemas or persisted file locations.
- Do not log bot tokens or dump config/state in new diagnostics.

## Validation

- Add or update a focused runtime/check script that verifies `writeJson()`-created files end with `0600` and that the implementation uses a restrictive creation path.
- Run `npm run check`.

## Decisions

- 2026-04-28: Implemented writeJson temp writes with restrictive mode and exclusive creation flag; writeConfig now ensures ~/.pi/agent is private before token config writes.
- 2026-04-28: Close-out validation passed: npm run check, pln hygiene, and final review agent re-review reported no findings.
