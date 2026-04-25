---
title: "Write token-bearing JSON with private permissions from creation"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: token-bearing JSON is written with default temp-file permissions and chmodded afterward. With a permissive umask, secrets can be briefly visible before chmod.

Evidence:
- `src/shared/utils.ts` `writeJson()` uses `writeFile(tempPath, ...)` and then `chmod(tempPath, 0o600)`.
- `writeConfig()` uses this path for `~/.pi/agent/telegram.json`, which contains the bot token.

Requirement: `SyRS-bridge-secret-privacy`.

Fix direction: ensure config/state parent directories are private and create temp JSON files with restrictive mode at open/write time before token-bearing bytes are written.
