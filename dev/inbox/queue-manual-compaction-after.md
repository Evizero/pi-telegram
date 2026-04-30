---
title: "Queue manual compaction after active work"
type: "request"
created: "2026-04-30"
author: "Christof Stocker"
status: "planned"
planned_as: ["queue-telegram-manual-compaction-after"]
---
Source: Telegram voice note transcribed 2026-04-30.

Raw transcript excerpt:

> new idea for maybe an inbox item i want you to investigate feasibility with pi and this extension
> what if we make compact behave a little more in terms of scheduling like messages ... by default it behaves like a follow-up meaning the compact is only executed once the agent is fully done ... i can already follow up a slash compact and after that ... plan it or something like that so the message that you execute after compacting is done ... do a deep dive if it's feasible and how and if it would be clean and make a detailed inbox item

## User goal

Allow a user to request manual compaction while an agent is still working, without interrupting/aborting the active turn. The desired default is follow-up-like scheduling:

1. User starts a long-running task, e.g. "implement it".
2. While the agent is still working, user sends `/compact`.
3. `/compact` should wait until the current agent work is fully settled.
4. Compaction should run after that active work is done.
5. Messages sent after the compact request, e.g. "plan it", should execute only after compaction completes, so they see the compacted context.

This is mainly motivated by Telegram/mobile use: the user often already knows they want compaction after the current task, and wants to enqueue that intent early instead of waiting for the agent to finish.

## Current behavior observed from code/docs

### Pi core behavior

- `README.md` documents `/compact [prompt]` as manual compaction and separately documents message queue semantics: Enter while working queues steering, Alt+Enter queues follow-up.
- In `dist/modes/interactive/interactive-mode.js`, `/compact` is handled before the `session.isStreaming` queue branch. That means typing `/compact` while streaming does not go through the steering/follow-up queue path.
- `AgentSession.compact()` in `dist/core/agent-session.js` explicitly disconnects from the agent and calls `await this.abort()` before starting manual compaction. So the current manual compact operation is interrupting by design.
- Pi already has some compaction-adjacent queue logic: while `session.isCompacting` is true, ordinary submitted messages are stored in `compactionQueuedMessages`, and `flushCompactionQueue()` sends them after compaction. This helps with messages entered during an already-running compaction, but it does not solve scheduling the compaction itself after an active turn.
- RPC docs say messages can be queued with `streamingBehavior: "followUp"`, but extension commands execute immediately during streaming, and the RPC `compact` command is an immediate compaction operation rather than a queued control operation.

### pi-telegram behavior

- Telegram `/compact` is handled as a session command in `src/broker/commands.ts` and posts IPC `compact_session` directly to the connected pi client.
- `src/client/runtime-host.ts` dispatches `compact_session` to `clientCompact()`.
- `src/client/compact.ts` calls `ctx.compact()` immediately. The extension context compact API is fire-and-forget, but it is backed by pi's manual compaction behavior above, which aborts current agent work before compacting.
- pi-telegram already has `ManualCompactionTurnQueue` in `src/client/manual-compaction.ts`. It defers Telegram turns that arrive while manual compaction is already active and starts them after compaction finishes. This is close to the desired "message after compact runs after compact" behavior, but only after compaction has already started.
- Normal Telegram messages sent while the pi session is busy already queue as follow-up work by default, and `/follow <message>` queues follow-up. `/steer <message>` remains the explicit urgent correction path.

## Feasibility conclusion

Feasible, but there are two different scopes:

1. **Telegram-only behavior in this extension:** feasible without changing pi core, by adding an extension-owned deferred manual-compaction request/barrier. This can make Telegram `/compact` follow-up-like while preserving current local pi behavior.
2. **Native pi behavior for typed `/compact` or RPC `compact`:** probably requires pi core changes. Existing pi APIs expose `ctx.compact()`/`session.compact()` as immediate manual compaction, and `session.compact()` aborts the active agent operation. Existing message queues carry user messages, not control operations like compaction barriers.

The extension-only path is useful and likely clean enough if modeled explicitly as a queued session-control operation, not disguised as a fake Telegram user message. The cleanest broader design would be a pi-core queued-control-operation API that supports manual compaction in the same ordered scheduler as follow-up messages.

## Possible extension-only design

Add a deferred compaction request to pi-telegram's client/broker scheduling layer.

### Desired Telegram command semantics

- `/compact` while idle: keep current behavior; start compaction immediately and reply `Compaction started.` / `Compaction completed.`.
- `/compact` while an active pi turn or Telegram turn is in progress: do **not** call `ctx.compact()` immediately. Queue a manual compaction barrier behind active work and acknowledge with something like `Compaction queued after current work.`.
- Ordinary Telegram messages after the queued `/compact` should be ordered after the compaction barrier by default, so they run after compaction completes.
- `/follow <message>` after the queued `/compact` should also remain behind that barrier.
- `/steer <message>` should remain the explicit urgent active-turn correction. It probably should be allowed to steer the currently active turn even if a compact barrier is queued, because `/steer` means "now". This needs a deliberate product decision.
- `/stop` should probably cancel the active turn and clear/suppress queued follow-ups and any queued compaction barrier, consistent with current stop behavior suppressing queued turns. This needs explicit acceptance criteria.
- Multiple queued `/compact` requests should probably coalesce into one pending compaction unless they have distinct custom instructions. If distinct instructions are later supported, either preserve FIFO or reject the second with a clear message.

### Scheduling model

Represent deferred compaction as a first-class queue item/barrier rather than as text content:

```ts
type PendingSessionOperation =
  | { kind: "telegram_turn"; turn: PendingTelegramTurn }
  | { kind: "manual_compaction"; id: string; routeId: string; requestedAtMs: number; customInstructions?: string };
```

This could be implemented as either:

- a unified client-side queue in `ClientTelegramTurnLifecycle`, replacing or wrapping the current `queuedTelegramTurns` plus `ManualCompactionTurnQueue`; or
- a smaller `DeferredManualCompactionQueue` next to `ManualCompactionTurnQueue`, with careful FIFO interaction against existing queued turns.

The unified queue is conceptually cleaner because it naturally preserves `/compact` as a barrier between earlier active work and later follow-ups. The smaller queue is less invasive but risks subtle ordering bugs because queued turns and queued compaction requests live in separate lists.

### Execution flow sketch

1. Broker receives Telegram `/compact`.
2. Broker posts an IPC request such as `queue_or_start_compact_session` instead of always `compact_session`.
3. Client checks `ctx?.isIdle()`, active Telegram turn state, awaiting final state, and any existing queued work.
4. If truly idle with no earlier queued work, start `ctx.compact()` immediately.
5. Otherwise persist/enqueue a pending manual-compaction barrier.
6. When the active agent finishes and before starting queued turns behind the barrier, client starts manual compaction.
7. While compaction is active, existing `ManualCompactionTurnQueue` behavior or its successor defers incoming turns.
8. On compaction completion or failure, notify Telegram, clear the barrier, and start the next queued message.

### Durability / broker failover considerations

The request should not live only in transient local memory if we want retry-safe behavior comparable to queued Telegram turns and finals. Options:

- Store pending compaction operations in broker state, with an ID and route/session ownership, and redeliver/reconcile via IPC like pending turns.
- Or store them in client runtime state and expose them through session registration/heartbeat, but that is weaker across broker failover and client replacement.

For consistency with pi-telegram's existing reliability goals, a broker-state representation is likely cleaner, especially if Telegram control messages/buttons need visible finalization.

### Telegram UX considerations

Potential statuses:

- `Compaction queued after current work.`
- `Compaction started.`
- `Compaction completed.`
- `Compaction failed: ... Continuing with queued follow-up messages.`
- `Queued compaction cancelled.`

A queued compaction does not need a `Steer now` button. It may need a `Cancel` button if we want parity with queued follow-up controls, but that can be a second step.

## Pi-core design if broader behavior is desired

A pi-core solution would be cleaner for all frontends:

- Add a queued session-control operation concept alongside steering/follow-up messages.
- Let `/compact` submitted while streaming schedule a follow-up-like compaction barrier instead of aborting by default.
- Possibly expose `session.queueCompaction()` / RPC `compact` with `streamingBehavior: "followUp"` or `when: "idle" | "now"`.
- Preserve an explicit immediate escape hatch, e.g. `/compact --now`, if current aborting behavior is still useful.
- Ensure queued operations are visible in queue UI, restorable/cancellable, and ordered relative to follow-up messages.

This avoids pi-telegram inventing a parallel scheduling concept, but it requires upstream pi changes rather than only extension work.

## Cleanliness assessment

Clean if scoped and named as a queued manual-compaction barrier. Less clean if implemented by injecting `/compact` as a fake follow-up message, because pi's message follow-up path rejects/handles commands differently and built-in slash commands are not ordinary LLM/user content.

The extension-only implementation is acceptable if it preserves these invariants:

- never abort active agent work just because Telegram `/compact` arrived while busy;
- preserve FIFO ordering between queued compaction and later ordinary Telegram follow-ups;
- keep `/steer` semantics explicit and intentional;
- notify Telegram on queued/start/completion/failure;
- avoid duplicate compactions on duplicate/redelivered Telegram updates;
- clean up or carry pending compaction across disconnect, replacement, broker restart, and shutdown according to existing queued-turn/final-delivery rules;
- keep existing behavior for messages arriving during an already-running compaction.

## Open questions for planning

- Should this only change Telegram `/compact`, or should local pi `/compact` and RPC `compact` also change behavior?
- Does `/compact` need custom instructions from Telegram, e.g. `/compact focus on decisions`, matching pi's `/compact [prompt]`?
- Should a queued compact have a cancel button/status control like queued follow-ups?
- If compaction fails, should queued messages behind it still run automatically, or should they wait for user confirmation because they will run against uncompacted context?
- Should multiple queued compacts coalesce, reject, or preserve FIFO?
- Should `/stop` cancel pending compaction barriers as well as queued turns?
- How should queued compact requests be represented in status/session listings (`busy +N queued`, separate `+1 compact`, etc.)?

## Candidate next planning step

If accepted, promote this into planning as either:

- a pi-telegram requirement/task for Telegram-only deferred `/compact` scheduling; or
- a broader pi-core feature request plus a pi-telegram integration task once core exposes a clean queued compaction API.
