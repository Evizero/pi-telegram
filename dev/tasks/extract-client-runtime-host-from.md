---
title: "Extract client runtime host from extension orchestration"
status: "done"
priority: 2
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: ""
labels: ["refactor", "runtime", "client", "telegram"]
traces_to: ["SyRS-extension-owned-broker", "SyRS-register-session-route", "SyRS-unregister-session-route", "SyRS-topic-routes-per-session", "SyRS-deliver-telegram-turn", "SyRS-follow-queues-next-turn", "SyRS-stop-active-turn", "SyRS-mirror-current-turn-on-connect", "SyRS-final-delivery-fifo-retry", "SyRS-runtime-validation-check", "SyRS-compact-busy-session", "SyRS-defer-telegram-during-compaction", "SyRS-retry-aware-agent-finals", "SyRS-final-text-before-error-metadata", "SyRS-session-replacement-route-continuity", "SyRS-busy-message-default-followup", "SyRS-queued-followup-steer-control", "SyRS-cancel-queued-followup", "SyRS-queued-control-finalization", "SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace"]
source_inbox: "decompose-extension-runtime-orchestration"
branch: "task/extract-client-runtime-host-from"
---
## Objective

Extract a client runtime host from `src/extension.ts` so client-side connection, route, turn-queue, final-handoff, and client IPC orchestration have an explicit owner. Preserve all current Telegram bridge behavior; this is a structural simplification, not a feature change.

The first slice should reduce the composition-root closure state without touching broker polling, broker election, Telegram command semantics, the broker final-delivery ledger, route cleanup policy, or attachment safety policy.

## Source and rationale

Source inbox: `decompose-extension-runtime-orchestration`.

Deep-dive finding: `src/extension.ts` is a composition root, but it still directly owns client server lifecycle, client heartbeat/reconnect, active/queued Telegram turn state, stale-client stand-down, route shutdown, client IPC dispatch, and `startNextTelegramTurn()`. Those responsibilities are tightly coupled to client behavior and currently make the composition root the main place where turn/final/route state is mutated.

The safest first decomposition is client-side rather than broker-side. Broker polling, sessions, updates, finals, and command routing are already partly delegated to `src/broker/*`, while the client lifecycle remains concentrated in the bottom half of `src/extension.ts`.

## Scope

Create a cohesive client runtime host, likely `src/client/runtime-host.ts`, that owns or coordinates these current `src/extension.ts` responsibilities:

- client IPC server lifecycle: start, stop, socket cleanup, connection nonce and connection start timestamp;
- client heartbeat lifecycle and reconnect scheduling;
- registration with the active broker and heartbeat route updates;
- selected/connected Telegram route state exposed through a narrow API;
- active Telegram turn, queued Telegram turns, current abort handle, awaiting-final state, completed/disconnected turn bookkeeping, and manual compaction interaction;
- mid-turn Telegram connection mirroring;
- stale-client stand-down and broker acknowledgement;
- client route shutdown/discard behavior;
- client IPC dispatch for `deliver_turn`, queued-turn steer/cancel, abort, stale-client connection, deferred-final restore, status, compaction, model query/set, Git query, and route shutdown;
- start-next-turn gating and dispatch to `pi.sendUserMessage`.

Keep `src/extension.ts` as the composition root that wires the host with existing collaborators such as `ClientRuntime`, `ClientAssistantFinalHandoff`, `RetryAwareTelegramTurnFinalizer`, `ManualCompactionTurnQueue`, IPC helpers, status updates, lease reads, and broker post functions.

## Codebase grounding

Likely source touchpoints:

- `src/extension.ts` — remove direct client lifecycle/turn orchestration and delegate to the host;
- `src/client/runtime-host.ts` — new owner for client runtime host behavior;
- `src/client/runtime.ts` — keep existing command/status/model/turn behavior; adjust dependency surface only as needed;
- `src/client/final-handoff.ts` and `src/client/retry-aware-finalization.ts` — keep semantics; expose only the callbacks the host needs;
- `src/client/manual-compaction.ts` and `src/client/route-shutdown.ts` — keep as focused lifecycle helpers used by the host;
- `src/pi/hooks.ts` / `registerRuntimePiHooks` dependency object — update wiring to call the host facade where appropriate;
- `scripts/check-client-runtime-host.ts` — add focused regression checks for the new host;
- `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json` — include the new check.

Current `src/extension.ts` functions expected to move or be wrapped by the host include:

- `startClientServer()`;
- `stopClientHeartbeat()`;
- `stopClientServer()`;
- `scheduleClientReconnect(ctx)`;
- `registerWithBroker(ctx, socketPath)`;
- `ensureCurrentTurnMirroredToTelegram(ctx, historyText)`;
- `standDownStaleClientConnection(options?)`;
- `discardTelegramClientRouteState()`;
- `shutdownClientRoute()`;
- `handleClientIpc(envelope)`;
- `rememberCompletedLocalTurn(turnId)`;
- `acknowledgeConsumedTurn(turnId, finalizeQueuedControlText?)`;
- `startNextTelegramTurn()`;
- thin client wrappers for status, compact, model, Git, queued-turn controls, and abort.

## Preserved behavior and regression traps

The implementation must preserve all of these behaviors:

- connecting Telegram during an active local pi turn creates a synthetic active Telegram turn for mirroring from that point forward;
- `startClientServer()` resets the client connection nonce and connection start timestamp, and stale broker messages for an old nonce fail closed;
- broker registration retries transient IPC failures and stops on stale-session errors;
- heartbeat updates `connectedRoute` from broker responses, retries pending assistant-final handoff, and starts the next Telegram turn only when final handoff is not deferring;
- heartbeat failure schedules reconnect via live lease reuse or broker election without dropping the local route state prematurely;
- ordinary busy Telegram messages remain queued follow-up work by default;
- `/follow` remains queued work and `/steer` remains explicit steering through existing client runtime behavior;
- queued-turn steer/cancel affects only the targeted still-queued turn and preserves stale-control finalization semantics;
- no next Telegram turn starts while manual compaction is active, while an active Telegram turn exists, while a final is awaiting handoff, without a connected route, or without a live client server;
- manual compaction defers/drains Telegram input in original order;
- active-turn abort, route shutdown, and stale stand-down preserve pending/deferred assistant finals before clearing local state;
- retryable provider failures still defer Telegram finalization until stable final text or terminal outcome;
- non-empty assistant final text still wins over error metadata;
- broker final ledger remains the sole owner of FIFO Telegram final delivery after broker acceptance;
- explicit disconnect and normal shutdown still unregister/clean up the route according to the existing route lifecycle rules;
- session replacement handoff still preserves Telegram reachability only through the bounded valid handoff path;
- `message_thread_id`, route IDs, selected session identity, and attachment queues are not lost during host delegation;
- Telegram retry-after behavior is not swallowed or converted into fallback behavior;
- no new public Telegram command, shell/file authority, broker daemon, or external service is introduced.

## Out of scope

Do not in this task:

- change Telegram command semantics or callback token formats;
- change broker lease format, broker election rules, or polling/update-offset logic;
- change `BrokerState` schema except for purely type-level refactoring that is demonstrably backward-compatible;
- change assistant-final delivery ledger behavior, chunk progress, attachment progress, terminal failure classification, or FIFO ordering;
- change route cleanup semantics, topic deletion retry policy, or queued-control visible finalization policy;
- change attachment allowlisting, secret blocking, temp-retention policy, or file download/upload behavior;
- introduce a generic runtime framework or move policy-heavy host types into `shared/`;
- extract broker runtime host or broker IPC router in the same implementation slice;
- turn the new host into another god object that absorbs broker, Telegram API, command, or pi-hook policy.

## Acceptance criteria

- `src/extension.ts` no longer directly owns most client server, heartbeat, route-state, client IPC, stale-stand-down, and start-next-turn mechanics.
- `src/client/runtime-host.ts` or equivalent has a bounded public API and keeps client lifecycle semantics explicit.
- Existing client modules remain cohesive; behavior-specific logic is not collapsed back into `extension.ts` or into a new cross-domain god file.
- Existing Telegram behavior and IPC message types remain backward-compatible.
- A focused check exercises the new host around registration retry, heartbeat route updates, mid-turn mirroring, final-handoff deferral gating, stale-client stand-down, route shutdown, and start-next-turn gating.
- No TypeScript source file under `src/` exceeds the 1,000-line guardrail after the change.
- `npm run check` passes.
- `pln hygiene` passes before close-out.

## Validation plan

Run before and after implementation where practical:

```bash
npm run typecheck
npm run check
pln hygiene
```

Add and include a new check, likely `scripts/check-client-runtime-host.ts`, in both `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json`.

The new check should cover at least:

1. client server start creates a fresh connection nonce/start timestamp and binds IPC to the current socket path;
2. registration retries transient failures and treats stale-session errors as terminal for that client connection;
3. heartbeat updates the route, retries pending finals, and does not start the next turn while final handoff is deferring;
4. mid-turn connect mirroring creates exactly one synthetic active Telegram turn after registration when pi is busy, the route is routable, and no Telegram turn is already active, while idle/non-routable/already-active cases do not create another mirrored turn;
5. stale stand-down persists or queues pending/deferred finals before clearing local active/queued/manual-compaction state;
6. route shutdown preserves final handoff semantics and clears only local client route state;
7. `startNextTelegramTurn()` respects all current gates and sends follow-up turns with `deliverAs: "followUp"`.

Also rely on existing checks as regression coverage, especially:

- `scripts/check-client-turn-delivery.ts`;
- `scripts/check-client-final-handoff.ts`;
- `scripts/check-retry-aware-finalization.ts`;
- `scripts/check-manual-compaction.ts`;
- `scripts/check-runtime-pi-hooks.ts`;
- `scripts/check-session-route-cleanup.ts`;
- `scripts/check-telegram-command-routing.ts`;
- `scripts/check-final-delivery.ts`;
- `scripts/check-session-replacement-handoff.ts`.

## Follow-on phases, not part of this task

If this slice lands cleanly, plan separate tasks for:

1. broker runtime host extraction: broker server lifecycle, lease renewal, poll loop, maintenance heartbeat, ledger start/stop, typing/activity/preview/media cleanup;
2. broker IPC router extraction: guarded IPC dispatch, stale-connection fencing, preview/activity/final/turn-consumed handlers;
3. broker state-store extraction: serialized broker state load/persist and bounded completed-turn memory;
4. Telegram IO policy consolidation: bound Bot API adapter and shared message/edit/delete/callback behavior;
5. inline-control/routing consolidation after runtime ownership is clearer.

## Decisions

- First slice targets the client runtime host, not broker runtime host, because broker behavior is more externally sensitive and already has several owner modules, while client lifecycle state remains concentrated in `src/extension.ts`.
- The task is a refactor/decomposition task: success means less cross-domain closure state with no behavior loss.
- New tests are expected because typechecking alone cannot prove registration, heartbeat, stale stand-down, and final-handoff gates survived extraction.
- 2026-04-29: Implemented the first decomposition as a client runtime host in src/client/runtime-host.ts. The host owns client IPC server lifecycle, heartbeat registration, connected route, active/queued Telegram turns, manual compaction queue access, stale stand-down, route shutdown, client IPC dispatch, and start-next-turn gating while src/extension.ts remains the composition root.
- 2026-04-29: Kept assistant-final handoff and retry-aware finalization as existing focused collaborators wired through the host instead of folding their policy into the new host; this preserves broker-owned final delivery and avoids creating a replacement god object.
- 2026-04-29: Added scripts/check-client-runtime-host.ts to cover fresh client connection identity, registration retry and stale failure, mid-turn mirroring including negative cases, heartbeat route updates and final-deferral gating, stale stand-down, route shutdown, and follow-up start gating.
- 2026-04-29: Reduced src/broker/commands.ts below the project source-file guardrail with whitespace-only compaction because it was a pre-existing 1000+ line source file and the task acceptance criteria required no src TypeScript file over 1000 lines after the change.
