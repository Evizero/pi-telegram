---
title: "Fix and document Telegram /git status"
status: "done"
priority: 2
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: "pi-agent"
labels: ["telegram", "git", "docs"]
traces_to: ["SyRS-local-git-inspection", "SyRS-telegram-git-menu"]
source_inbox: "telegram-git-command-may"
branch: "task/fix-and-document-telegram-git-status"
---
## Objective

Fix the confusing /git Status result that reports `State: unknown — bounded Git query incomplete` even when the only issue is the intentional metadata-only unstaged-content limitation, and document /git in the README.

## Scope

- Keep /git as the existing read-only Telegram action menu with Status and Diffstat.
- Distinguish true bounded-query/component failures from informational safety notes about metadata-only unstaged detection.
- Keep compact Telegram output and avoid patch contents or arbitrary shell execution.
- Add user-facing README coverage for /git and BotFather command completion.

## Acceptance Criteria

- A clean repository with successful bounded components formats as `State: clean` while still explaining the metadata-only limitation as a note.
- Real component failures still mark the status/diffstat as incomplete/unknown.
- README includes /git in command autocomplete and usage documentation.
- `npm run check` passes.

## Decisions

- 2026-04-29: Expanded scripts/check-client-git-status.ts beyond formatter unit cases to create temporary Git repositories and query the real client path across clean, initial no-HEAD, unstaged/untracked, staged+mixed, deleted, detached HEAD, merge conflict, upstream ahead/behind, staged diffstat, unstaged diffstat, and non-git workspace states.
- 2026-04-29: Hardened temporary Git simulations by stripping inherited GIT_* environment, disabling system/global Git config, and preventing interactive prompts; changed diffstat formatting to prioritize the diffstat failure note before informational safety notes so true failures remain visible under note truncation.
- 2026-04-29: Aligned the production Git query environment with the test isolation by disabling inherited system/global Git config after stripping GIT_* variables, and split diffstat notes into failure-priority and informational-priority paths so successful unstaged-line-skip notes cannot hide component warnings.
- 2026-04-29: Performed the requested cleanup pass after the /git fix: renamed status diagnostics to failureNotes/infoNotes, replaced the diffstat boolean note flag with a typed GitOutputNote, and reduced temp-repo test repetition with withTempDir/withRepo helpers while preserving scenario coverage.
- 2026-04-29: Close-out validation passed: npm run check, pln hygiene, git diff --check, and fresh review agent after cleanup reported no findings. Acceptance criteria are satisfied for clean status formatting, failure visibility, README documentation, and bounded read-only Git inspection.
