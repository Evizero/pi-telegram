---
title: "Improve Telegram activity labels for thinking and bash tools"
status: "done"
priority: 3
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["activity", "telegram-ui"]
traces_to: ["SyRS-activity-history-rendering"]
source_inbox: "activity-labels-should-show"
branch: "task/improve-telegram-activity-labels-for"
---
## Objective

Make Telegram activity lines easier to scan by improving the default thinking label and giving bash tool activity its own bash-specific presentation.

This is a display/readability refinement for the activity feed, not a change to turn routing, activity persistence, Telegram preview/final delivery, or tool execution semantics.

## Source and trace

Accepted from inbox item `activity-labels-should-show`, based on the 2026-04-25 Telegram request:

- when no thinking title is known yet, show the default brain thinking label with dots, e.g. `🧠 thinking ...`, instead of plain `🧠 thinking`;
- give bash a special emoji instead of the generic wrench;
- show the bash command prominently after the bash emoji/name, e.g. `💻 git clone ...` or an equivalent compact bash line where the command is immediately visible.

Trace this work to `SyRS-activity-history-rendering`: the visible activity feed should preserve meaningful activity history while Telegram rendering remains debounced.

## Scope

- Update activity-line construction/rendering in `src/broker/activity.ts`.
- Use `thinking ...` as the fallback thinking label when the thinking event has no title. Preserve existing behavior for real thinking titles.
- Use `💻` as the bash-specific emoji unless implementation discovers a strong rendering reason to choose another terminal-style emoji.
- Render bash activity with the bash emoji and compact command text prominently visible; retaining a `bash` tool label is acceptable if it preserves the existing activity parser and done/error replacement behavior.
- Preserve the existing compacting behavior for long command text.
- Preserve the existing ability for completed/error tool events to update the active activity line instead of duplicating noisy tool lines.

## Codebase grounding

Likely touchpoint: `src/broker/activity.ts`.

Relevant functions/classes:

- `thinkingActivityLine()` currently falls back to `🧠 thinking`.
- `toolActivityLine()` currently uses `🔧` for all non-error tools.
- `compactToolArgs()` already extracts `record.command` for bash.
- `ActivityRenderer.handleUpdate()` and `activityLineToHtml()` currently assume activity lines roughly look like `<emoji> <toolName> <details>`, so bash command-forward rendering must not break done/error replacement behavior.

## Acceptance Criteria

- Unknown-title thinking activity displays as `🧠 thinking ...` in Telegram activity output.
- Known thinking titles still display the title rather than the fallback label.
- Bash tool activity uses a bash-specific emoji instead of `🔧`.
- Bash activity exposes the compact command prominently, e.g. a `git clone ...` call is immediately visible after the bash emoji/name in the rendered activity line.
- Non-bash tools keep their existing generic wrench-style behavior unless needed to preserve shared parsing.
- Done/error updates for bash and non-bash tools do not create avoidable duplicate activity lines.
- Activity HTML escaping remains safe for command text and other tool details.

## Out of Scope

- Do not redesign the activity feed model or Telegram message layout.
- Do not change debounce timing, typing indicators, preview rendering, final delivery, or Telegram routing.
- Do not add a broad per-tool icon registry beyond the bash-specific behavior needed for this request unless it is the smallest clean implementation.
- Do not resolve unrelated activity rendering issues in this slice.

## Validation

- Run `npm run check`.
- Add focused test coverage if a practical local test harness is introduced in this slice; otherwise validate by inspection of `thinkingActivityLine()`, `toolActivityLine()`, `activityLineToHtml()`, and `ActivityRenderer.handleUpdate()` behavior for:
  - unknown-title thinking;
  - known-title thinking;
  - bash active line with command text;
  - bash done/error line update;
  - non-bash tool line remains unchanged.

## Planning notes

The source message ended mid-thought with “then”. This task intentionally scopes implementation to the three captured formatting requests above. If the user later supplies another formatting rule, capture or plan it separately unless it is a tiny adjustment to this same display slice before implementation starts.

## Decisions

- 2026-04-25: Implementation keeps the bash tool name in the activity line (`💻 bash <command>`) rather than dropping it, because `ActivityRenderer` currently uses the second token as the tool identity for done/error line replacement; this still makes the compact command immediately visible after the bash emoji/name.
- 2026-04-25: Validation used npm run check plus inspection of activity line construction/rendering paths; no runtime test was added because the repository currently has only a typecheck-based validation harness and this slice is isolated to pure display formatting.
