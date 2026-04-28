---
title: "Write token-bearing JSON with private permissions from creation"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "planned"
planned_as: ["create-token-json-with-private"]
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: token-bearing JSON is written with default temp-file permissions and chmodded afterward. With a permissive umask, secrets can be briefly visible before chmod.

Evidence:
- `src/shared/utils.ts` `writeJson()` uses `writeFile(tempPath, ...)` and then `chmod(tempPath, 0o600)`.
- `writeConfig()` uses this path for `~/.pi/agent/telegram.json`, which contains the bot token.

Requirement: `SyRS-bridge-secret-privacy`.

Fix direction: ensure config/state parent directories are private and create temp JSON files with restrictive mode at open/write time before token-bearing bytes are written.


## Deep-dive triage (2026-04-27)

Status: still current. `src/shared/utils.ts` `writeJson()` still creates temp JSON with `writeFile(tempPath, ..., "utf8")` and only then calls `chmod(tempPath, 0o600)`. `writeConfig()` creates `~/.pi/agent` with plain `mkdir(..., { recursive: true })` before writing token-bearing config through `writeJson()`. Other callers do use `ensurePrivateDir()` first in several broker paths, but the generic write helper still has the creation-time permission window described by this item. This should remain open.
