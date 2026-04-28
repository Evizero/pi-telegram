---
title: "Implement Telegram /git repository controls"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: "pi-agent"
labels: ["telegram", "git", "commands"]
traces_to: ["SyRS-telegram-git-menu", "SyRS-local-git-inspection", "SyRS-telegram-text-method-contracts", "SyRS-telegram-retry-after"]
source_inbox: "telegram-git-status-command"
branch: "task/implement-telegram-git-repository"
---
## Objective

Implement a Telegram `/git` command that opens an inline-button menu for repository inspection on the selected pi session. The first actions are `Status` and `Diffstat`. Both actions must be read-only, compact, Telegram-friendly, and must not create, steer, or queue an agent turn.

## Scope

- Add `/git` to the Telegram command surface for an authorized, selected, online session.
- `/git` should send a route/thread-preserving inline menu with two buttons: `Status` and `Diffstat`.
- Button callbacks should validate the paired-user route/session context, reject expired or mismatched controls safely, and query the selected client session over IPC.
- `Status` should summarize branch/upstream/HEAD and working-tree state using safe read-only Git metadata, index-diff, and `ls-files` queries rather than `git status`, including a bounded file list for dirty state and explicit notes when safe metadata-only detection may be incomplete.
- `Diffstat` should summarize changed-file counts plus safe staged/index insertion/deletion totals without patch contents; unstaged line totals should be omitted rather than executing configured Git filter helpers.
- Non-git directories, Git command timeouts, and unavailable clients should return clear compact Telegram replies.
- All menu, callback-answer, and result replies should preserve Telegram text method contracts: non-empty text, safe chunking below Telegram limits through the existing send helpers, thread routing, and `retry_after` propagation rather than fallback retries that bypass rate-limit handling.

## Codebase grounding

Likely touchpoints:

- `src/broker/commands.ts` for `/git` dispatch, callback dispatch, route/session validation, help text, and IPC calls.
- A small broker helper module such as `src/broker/git-controls.ts` if the inline callback state merits separation, mirroring the existing model-picker/queued-control patterns rather than expanding `commands.ts` too much.
- `src/shared/types.ts` for any new callback/menu state or Git result DTOs.
- `src/client/runtime.ts`, `src/client/info.ts`, and/or a new `src/client/git-status.ts` for client-owned read-only Git inspection from the active `ExtensionContext.cwd`.
- `src/extension.ts` for new client IPC handling, e.g. `query_git_status` / `query_git_diffstat` or one typed query with an action enum.
- `scripts/check-telegram-command-routing.ts` and possibly a focused new script to exercise formatting/parsing edge cases.

Implementation should prefer `execFile`/non-shell Git invocation with a short timeout and capped output. The broker should not inspect its own repository unless it is also the selected client session; repository inspection belongs on the target client because the broker can be running from a different pi session/workspace.

## Acceptance Criteria

- `/git` with no selected route replies with the existing “No pi session selected” style guidance and does not create a turn.
- `/git` for an offline selected session reports the offline session and does not create a turn.
- `/git` for an online selected session sends an inline menu with `Status` and `Diffstat` buttons to the same chat/thread.
- Pressing `Status` queries the selected client, returns compact branch/upstream/clean/dirty/file-status text without executing configured Git filter helpers, labels incomplete counts conservatively, preserves topic/thread routing, and does not call `pi.sendUserMessage`.
- Pressing `Diffstat` queries the selected client, returns compact changed-file counts and safe staged/index insertion/deletion totals without patch content or configured Git helper execution, preserves topic/thread routing, and does not call `pi.sendUserMessage`.
- Callback handling fails closed for expired, mismatched, malformed, or stale route/session controls and answers the callback with an actionable short message.
- Git inspection handles clean repos, dirty repos, untracked files, no upstream, detached HEAD where practical, non-git directories, command failure, timeout, and overly long output with bounded Telegram text.
- Result text and callback/menu messages use existing Telegram send/edit/callback helpers or equivalent behavior so non-empty text, chunking, Markdown fallback where applicable, message_thread_id preservation, and `retry_after` handling remain consistent with existing command replies.
- Existing `/status`, `/model`, `/compact`, `/follow`, `/steer`, `/stop`, `/disconnect`, queued follow-up controls, and model picker behavior remain unchanged.

## Out of Scope

- No arbitrary `/git <subcommand>` passthrough.
- No patch, diff body, file content, log history, branch switching, staging, committing, pulling, pushing, or shell execution.
- No agent turn creation or hidden prompt injection into the pi session.
- No general Telegram bot plugin framework.

## Validation

- Extend or add command-routing checks that prove `/git` and its callbacks do not create agent turns, preserve chat/thread routing, and use the normal Telegram text/callback paths so chunking and `retry_after` behavior are not bypassed.
- Add focused Git formatter/parser checks using representative porcelain/status and diffstat inputs, including clean, dirty, untracked, non-git, and truncation cases.
- Run `npm run check` before close-out.
- Run `pln hygiene` before reporting planning/close-out completion.

## Architecture impact

This should fit the existing broker-command plus client-IPC architecture. It introduces a new read-only session-inspection command surface, but not a new execution authority or a general bot framework. No architecture document update is required unless implementation creates a persistent new command-control abstraction beyond the existing model-picker/queued-control style.

## Decisions

- 2026-04-28: Implemented /git as a broker-owned inline menu with short token callbacks, while Git execution remains client-owned over query_git_repository IPC so repository inspection runs in the selected session workspace without creating agent turns or arbitrary shell authority. Git formatting is plain text and bounded, and result delivery reuses existing Telegram send/edit/callback helpers so thread routing and retry_after propagation are preserved.
- 2026-04-28: Hardened client Git invocation against configured helper execution by using git --no-optional-locks, disabling core.fsmonitor and diff.external, setting GIT_OPTIONAL_LOCKS=0/GIT_EXTERNAL_DIFF=, using --no-ext-diff/--no-textconv for diffstat, and ignoring submodules for the compact read-only status surface.
- 2026-04-28: Sanitized inherited Git environment for repository inspection by dropping incoming GIT_* variables before setting the controlled Git environment, preventing GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE or injected config env from redirecting the query away from the selected session cwd.
- 2026-04-28: Made Git callbacks retry-safe and selector-stale-safe: completed Git result text/action is persisted before Telegram delivery, result delivery is marked before callback answers so retry_after redelivery does not rerun Git or duplicate fallback sends, and selector-mode controls capture the exact selector selection timestamps so old menus fail closed even if the user later reselects the same session.
- 2026-04-28: Adjusted Diffstat to avoid working-tree diff commands because Git may execute configured clean/process filters while diffing unstaged files. Diffstat now reports overall changed/untracked file counts from status plus staged/index insertion/deletion totals; unstaged line totals are explicitly skipped in safe mode.
- 2026-04-28: Replaced the runtime status query's use of git status with safe component Git queries (rev-parse, branch, rev-list, cached diff name-status, and ls-files) so Status and Diffstat avoid working-tree diff/filter-helper execution while still reporting branch/upstream, staged/unstaged/deleted/untracked file state, and safe staged line totals.
- 2026-04-28: Removed Git filter-capable modified-file queries from the runtime status path. Unstaged modification detection now uses ls-files debug metadata plus Node lstat size/mtime comparison, with component-query failures surfaced as Note lines instead of silently reporting a clean tree.
- 2026-04-28: Changed failed staged diffstat queries to render staged diff unknown with a warning instead of displaying zero-file/no-diff totals, so bounded Git failures do not masquerade as clean state.
- 2026-04-28: Made safe status counts conservative when component queries or metadata-only checks can be incomplete: dirty/status counts are labelled at least, clean status becomes unknown when warnings exist, file mode changes are detected from ls-files stage metadata, and same-size same-second unstaged edits are called out as a safe-mode limitation.
- 2026-04-28: Adjusted safe mode comparison to respect core.filemode=false before treating executable-bit differences as changed, matching Git repositories that intentionally ignore file mode changes.
- 2026-04-28: Skipped gitlink/submodule index entries in metadata-only unstaged detection so clean submodules are not falsely reported as modified while the safe status path otherwise ignores submodule internals.
