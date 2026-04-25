---
title: "Match Telegram compact to pi busy behavior"
status: "done"
priority: 2
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "compact", "busy-control"]
traces_to: ["SyRS-compact-busy-session"]
source_inbox: "telegram-compact-should-match"
branch: "task/match-telegram-compact-to-pi-busy"
---
## Objective

Make Telegram `/compact` behave like native pi manual compaction when the selected session is busy: the command should invoke compaction through pi instead of returning the bridge-specific busy rejection. Native pi interrupts the active agent operation as part of manual compaction, so Telegram should preserve that control behavior.

## Codebase grounding

Likely touchpoints:
- `src/extension.ts` `clientCompact()` currently rejects when `!ctx.isIdle()`; remove or replace that bridge-only guard so `ctx.compact(...)` handles busy-session semantics and pi's own manual compaction path interrupts the active turn.
- `src/broker/commands.ts` already routes Telegram `/compact` to the selected session via `compact_session`; preserve that command routing and existing error reply behavior.
- Existing pi behavior is exposed through extension `ctx.compact(...)`, whose runtime implementation aborts the active operation before compacting.

## Preserved behavior

- Ordinary Telegram messages sent while busy must still steer the active turn.
- `/follow <message>` must still queue follow-up work rather than steer.
- `/stop` must still abort the active turn and send a clear confirmation.
- Completion and failure callbacks for compaction should continue to send exactly one routed Telegram result message where practical.
- Telegram route context, including `message_thread_id`, must be preserved for the start acknowledgement and completion/failure reply.

## Acceptance Criteria

- Sending `/compact` to a busy selected session no longer returns `Cannot compact while this session is busy. Send stop first.`
- The command invokes pi manual compaction and returns the existing start acknowledgement.
- The active turn is interrupted through pi's manual compaction path rather than by a bridge-specific substitute.
- Completion or failure is delivered back to the same Telegram route.
- A focused regression check covers the busy-session path and demonstrates that nearby busy message routing (`steer`, `/follow`, `/stop`) is not changed by the implementation.

## Out of Scope

- Do not redesign pi compaction itself.
- Do not add a new Telegram command or lifecycle state.
- Do not change normal text, `/follow`, or `/stop` routing semantics.
- Do not move compaction execution out of the local pi session.

## Validation

Run `npm run check` after implementation. Add or update focused regression coverage for the `/compact` busy-session path so the check proves the bridge invokes `ctx.compact(...)` while busy instead of returning the old rejection, and that nearby busy-message routing remains unchanged.

## Decisions

- 2026-04-25: Extracted Telegram compact client behavior into src/client/compact.ts instead of broad refactoring src/extension.ts. This keeps the change reliable and directly testable while preserving the existing broker command route; a broader client lifecycle extraction is not needed for this behavior.
- 2026-04-25: Review found completion callbacks should use the route active when /compact was invoked, not a later connected route. Updated compact helper and regression coverage to pin completion/failure replies to the original route, and extracted client turn delivery checks to prove ordinary busy turns still steer while /follow queues.
- 2026-04-25: Added command-router regression coverage for /compact, /stop, /follow, and plain routed messages. This checks /compact remains a control IPC command, /stop still uses abort_turn, /follow still marks followUp delivery, and plain messages remain ordinary turns for the client steer path.
- 2026-04-25: Validation passed with npm run check after implementation. Required review subagent attempts returned no output in this session, so close-out relied on passing local validation plus manual inspection rather than a clean read-only review verdict.
- 2026-04-25: User explicitly requested close-out and commit before investigating the next bug report. Closing this task with passing local validation and manual inspection even though review subagent attempts returned no verdict in this session.
