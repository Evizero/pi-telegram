---
title: "Outbound attachment guard should block cloud credentials"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: outbound attachment allowlisting blocks `.env`, SSH, and `.aws`, but misses common credential directories such as `.azure`, `.config/gcloud`, and `.kube` under the workspace.

Evidence:
- `src/extension.ts` `resolveAllowedAttachmentPath()` blocks `.env`, `id_rsa`, `id_ed25519`, `/.ssh/`, and `/.aws/` only.

Requirements: `SyRS-outbound-attachment-safety`, `SyRS-bridge-secret-privacy`, `StRS-attachment-exchange`.

Fix direction: centralize the secret-path policy and block documented cloud/Kubernetes credential directory families and key-file patterns before upload.


## Deep-dive triage (2026-04-27)

Status: still current. `src/client/attachment-path.ts` still blocks `.env`, `.env.*`, `id_rsa`, `id_ed25519`, paths under `/.ssh/`, and paths under `/.aws/`, then allows files under the workspace or Telegram temp directory. I did not find blocking for `.azure`, `.config/gcloud`, `.kube`, generic cloud credential files, or a centralized secret-path policy. This should remain open.
