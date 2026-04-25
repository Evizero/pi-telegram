---
title: "Queue Telegram input during compaction"
status: "done"
priority: 1
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "compaction", "busy-routing"]
traces_to: ["SyRS-defer-telegram-during-compaction", "SyRS-busy-message-steers", "SyRS-follow-queues-next-turn", "SyRS-compact-busy-session"]
source_inbox: "telegram-starts-new-turn"
branch: "task/queue-telegram-input-during-compaction"
---
## Objective

Make ordinary Telegram messages and `/follow` work received while a selected session is running manual compaction started by Telegram `/compact` behave like native pi: do not start a second turn during compaction; instead defer that input until compaction completes, then let the first deferred input item — including a lone deferred `/follow` — start the next turn while later plain messages steer that turn and later `/follow` work remains queued behind it.

## Codebase grounding

Likely touchpoints:
- `src/extension.ts` for client-side lifecycle state, turn-start gates, and compaction callback wiring
- `src/client/turn-delivery.ts` for the current busy/idle routing decision that relies on `ctx.isIdle()`
- `src/client/compact.ts` for bridge-owned manual-compaction lifecycle hooks
- `src/client/session-registration.ts` and `src/client/info.ts` for reporting compaction as non-idle
- `src/pi/hooks.ts` if compaction lifecycle events need to update bridge state from pi runtime events
- focused regression checks under `scripts/` and `tsconfig.activity-check.json`

## Pre-edit impact preview

- Likely code touchpoints: `src/extension.ts`, `src/client/turn-delivery.ts`, `src/client/compact.ts`, `src/client/session-registration.ts`, `src/client/info.ts`, possibly `src/pi/hooks.ts`
- Likely planning touchpoints: no further requirement changes expected unless implementation uncovers a missing compaction-state contract in pi
- Validation: extend focused activity checks plus `npm run check`
- Main risk: pi's extension API does not expose a full generic compaction busy state, so the bridge must stay truthful without inventing bridge-specific behavior that diverges from native pi

## Acceptance Criteria

- A plain Telegram message sent while Telegram-started manual compaction is still running does not start a concurrent or forked pi turn.
- Plain Telegram messages and `/follow` work received while Telegram-started manual compaction is running are held until compaction completes; the first deferred input item, including a lone deferred `/follow`, starts the next turn, later deferred plain messages steer that turn, and later deferred `/follow` work remains queued behind it.
- Existing active-turn semantics remain unchanged: ordinary busy-turn messages still steer and `/follow` during an active turn still queues after that turn.
- During compaction, `/stop` and `/compact` continue to use their existing immediate command paths instead of being misclassified as deferred ordinary-message input.
- Client status and registration treat Telegram-started manual compaction as busy enough that queued Telegram work is not started early by idle-only gates.
- Focused regression coverage proves that no new turn starts during compaction and that queued compaction input resumes correctly afterward.

## Out of Scope

- redesigning pi compaction itself
- adding new Telegram commands or a user-visible bridge lifecycle state
- unrelated topic-cleanup or broker-failover work beyond what this bug directly requires

## Validation

Run `npm run check` after implementation. Add or update focused regression coverage for: Telegram-started manual compaction in progress, ordinary Telegram messages during that compaction, `/follow` during that compaction, the `/follow`-only compaction case, the post-compaction flush order (first deferred input item starts the turn, including a lone deferred `/follow`; later plain messages steer; later `/follow` stays queued), existing immediate `/compact` and `/stop` command behavior during compaction, and the gates that decide whether a queued Telegram turn may start immediately.

## Architecture

No architecture document update is planned up front. This looks like a runtime-parity correction inside the existing bridge/client lifecycle rather than a new architectural boundary. If implementation reveals a durable new ownership seam for compaction queue state, update `dev/ARCHITECTURE.md` in the same slice.

## Decisions

- 2026-04-25: Planned this as a bridge runtime-parity fix rather than a new UX feature. Native pi's compaction message queue lives in interactive mode, not in the current extension API. The intended parity rule for this task is explicit: while Telegram-started manual compaction runs, ordinary messages and `/follow` are deferred; after compaction, the first deferred input item, including a lone deferred `/follow`, starts the next turn, later plain messages steer that turn, and later `/follow` work stays queued behind it.
- 2026-04-25: Implemented this parity with a bridge-local queue controller around Telegram-started manual compaction. Because pi's public extension API does not expose the interactive compaction queue directly, the client now blocks auto-start during Telegram-initiated compaction, defers plain Telegram messages and /follow work locally, starts the first deferred item when compaction ends, and drains the remaining deferred items into the new active turn on agent_start so later plain messages steer and later /follow work stays queued behind it.
- 2026-04-25: Manual compaction tracking uses a depth counter rather than a single boolean because /compact remains an immediate command path during compaction. Deferred turns also stay visible to duplicate suppression while waiting in the post-compaction remainder buffer so broker retry/redelivery cannot execute them twice.
- 2026-04-25: Kept the implementation and requirement scope on manual compaction started by Telegram /compact. Pi's public extension API does not expose a full generic compaction lifecycle with reliable end events for arbitrary local/manual compaction, so this slice preserves truthful parity for the reported Telegram-triggered bug instead of claiming broader runtime coverage it cannot currently prove.
- 2026-04-25: Prepared currentAbort before sending the first deferred post-compaction turn so /stop can still cancel work in the finish-to-agent_start handoff window. Messages that arrive in that same boundary window are appended to the deferred remainder buffer and drained on agent_start so they still steer the newly started turn instead of slipping into the next turn queue.
- 2026-04-25: Defensive edge handling: synchronous ctx.compact() failures now unwind compaction state immediately, and /stop clears the post-compaction awaiting-agent-start boundary so new Telegram input cannot be appended to a turn the user just stopped.
- 2026-04-25: Implementation verified with npm run check and a final gpt-5.5 review pass that returned no findings for the scoped compaction parity files before close-out.
