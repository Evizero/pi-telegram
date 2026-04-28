---
title: "Expand outbound attachment secret-path guard"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "telegram-voice"
assignee: ""
labels: []
traces_to: ["SyRS-outbound-attachment-safety", "SyRS-bridge-secret-privacy"]
source_inbox: "outbound-attachment-guard-should"
branch: "task/expand-outbound-attachment-secret-path"
---
## Objective

Extend outbound attachment safety so `telegram_attach` blocks common cloud and Kubernetes credential locations inside otherwise allowed workspaces or bridge temp directories.

The current guard blocks `.env`, SSH keys, `.ssh`, and `.aws`; the requirement already calls out cloud credential directories more broadly. This task closes that gap without turning `telegram_attach` into a full DLP system.

## Scope

Centralize the secret-path policy used by outbound attachment validation and expand it to cover documented credential families such as Azure, Google Cloud, and Kubernetes credentials. Keep the policy conservative, explainable, and test-backed.

## Codebase grounding

- `src/client/attachment-path.ts` owns `resolveAllowedAttachmentPath()` and currently performs inline deny checks before allowing workspace/temp paths.
- `src/pi/hooks.ts` calls that resolver from the `telegram_attach` tool before queueing attachments.
- `SPEC.md` now documents the planned broader default `security.sensitive_path_denylist`; keep implementation and docs aligned if the policy changes during implementation.
- Relevant requirement: `SyRS-outbound-attachment-safety`; adjacent privacy requirement: `SyRS-bridge-secret-privacy`.

## Acceptance Criteria

- Existing allowed-path behavior remains: regular outbound attachments must still resolve only under the session workspace or bridge temp directory.
- Existing blocked cases remain blocked: `.env`, `.env.*`, SSH key basenames, `/.ssh/`, and `/.aws/`.
- New blocked cases include at least `/.azure/`, `/.config/gcloud/`, and `/.kube/`, plus obvious credential filenames where they are safe to classify without excessive false positives.
- Secret-path matching is centralized enough that future additions do not require editing a long inline condition in the resolver.
- Regression coverage exercises allowed workspace files, blocked existing secret paths, blocked cloud/Kubernetes credential paths, and symlink/realpath behavior already expected by the resolver.

## Out of Scope

- Do not add content scanning or attempt to detect every possible secret string.
- Do not allow arbitrary non-workspace file uploads.
- Do not change inbound Telegram attachment handling.

## Validation

- Add focused checks for `resolveAllowedAttachmentPath()`.
- Run `npm run check`.

## Decisions

- 2026-04-28: Centralized outbound sensitive path matching in src/client/attachment-path.ts and added Azure, Google Cloud, Kubernetes, and application-default-credentials blocks while preserving workspace/temp realpath bounds.
- 2026-04-28: Close-out validation passed: npm run check, pln hygiene, and final review agent re-review reported no findings.
