---
title: "Handle stale broker lease loss without process crashes"
status: "done"
priority: 1
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Salis"
assignee: ""
labels: ["reliability", "broker", "lifecycle"]
traces_to: ["SyRS-broker-lease-loss-standdown", "SyRS-final-delivery-fifo-retry", "SyRS-durable-update-consumption", "SyRS-media-group-batching", "SyRS-retry-topic-cleanup", "SyRS-cleanup-route-after-reconnect-grace"]
source_inbox: "stale-broker-from-pending"
branch: "task/handle-stale-broker-lease-loss-without"
---
## Objective

Make broker lease loss a controlled lifecycle outcome everywhere broker maintenance can observe it, instead of allowing `stale_broker` to escape from detached asynchronous work and crash the pi process.

The immediate regression is the reported crash path:

`retryPendingTurns()` → `persistBrokerState()` → `assertCurrentBrokerLeaseForPersist()` → `Error("stale_broker")` → unhandled rejection under Node 24.

The fix should preserve the lease fence added to protect broker state from stale writes. Do not weaken stale-write prevention. Instead, make stale-broker detection distinguishable and route it through controlled stand-down / ignore-stale-work behavior.

## Requirement links

Primary:
- `SyRS-broker-lease-loss-standdown` — stale broker lease loss must not create unhandled rejections or terminate the pi session process.

Preserved adjacent behavior:
- `SyRS-final-delivery-fifo-retry` — assistant finals must remain durable and ordered across broker turnover.
- `SyRS-durable-update-consumption` — update offsets must still advance only after durable handling decisions.
- `SyRS-media-group-batching` — media-group retry/late-update behavior must survive broker turnover.
- `SyRS-retry-topic-cleanup` — route/topic cleanup retry semantics must remain intact.
- `SyRS-cleanup-route-after-reconnect-grace` — session offline/reconnect grace behavior must not be shortened by generic broker lease loss.

## Source context

Inbox source: `dev/inbox/stale-broker-from-pending.md`.

Observed crash excerpt:

```text
Error: stale_brokeressions
    at assertCurrentBrokerLeaseForPersist (.../src/extension.ts:500:149)
    at async .../src/extension.ts:505:7
    at async Object.retryPendingTurns (.../src/broker/updates.ts:430:5)
```

Deep-dive conclusion: commit `e844f5c` added current-broker lease fencing to persistence, but existing background work such as pending-turn retry was still launched fire-and-forget without terminal stale-broker handling.

## Pre-edit impact preview

Likely code touchpoints:
- `src/extension.ts` — stale broker error/type guard, `persistBrokerState()`/lease assertion behavior, safe detached broker-task wrapper, startup maintenance IIFE, detached `retryPendingTurns()` calls, heartbeat stale-stop catch.
- `src/broker/updates.ts` — pending-turn retry final persist, media-group flush timer persistence, optional lease-loss behavior exposed through deps.
- `src/broker/finals.ts` — assistant final ledger `kick()` / retry timer promise handling around stale broker persistence.
- `src/broker/lease.ts` — preserve existing lease acquisition/renewal semantics; only touch if a shared stale error/helper belongs there.
- `src/client/retry-aware-finalization.ts`, `src/client/runtime-host.ts`, `src/client/runtime.ts`, `src/client/compact.ts` — audit and, where practical in this slice, add terminal catches for nearby fire-and-forget promises that can reject after broker IPC/standdown failures.
- Check scripts under `scripts/` and `scripts/run-activity-check.mjs` / `tsconfig.activity-check.json` if adding a new focused validation script.

Main risks:
- Accidentally swallowing real persistence failures such as malformed state or permission errors.
- Calling `stopBroker()` recursively or racing cleanup in a way that removes the current broker's lease/state.
- Weakening the stale-write fence and allowing old brokers to overwrite newer broker state.
- Introducing catch-all logging that hides retryable Telegram failures or terminal delivery failures.

## Implementation plan

### 1. Introduce explicit stale-broker classification

Create a narrow way to identify stale broker lease loss, rather than relying on arbitrary string comparisons scattered through the code.

Acceptable shapes:
- a small `StaleBrokerError` class plus `isStaleBrokerError()` helper; or
- a shared error code helper that preserves `error.message === "stale_broker"` compatibility while giving callers a single guard.

Likely home: `src/broker/lease.ts`, `src/shared/errors.ts`, or a broker lifecycle helper if one already fits during implementation.

Constraints:
- Do not classify arbitrary IPC or Telegram errors as stale broker.
- Do not swallow permission, JSON parse, filesystem, or Telegram errors under this guard.
- Keep IPC serialization behavior acceptable: remote callers may still see a clear stale-broker message when broker IPC itself is stale.

### 2. Keep broker persistence fenced, but make stale loss controlled

`persistBrokerState()` should continue to refuse writes when this process is no longer current broker.

The planned change is not "persist anyway". It is:
- stale broker detected before/during broker maintenance → old broker stops or ignores stale work;
- stale broker detected by a detached background promise → promise is caught and completed safely;
- non-stale failures → still surface/log/fail according to existing semantics.

Consider adding a helper near the composition root such as `handleBrokerBackgroundError(error, context)` / `runBrokerBackgroundTask(label, task)` that:
- if `isStaleBrokerError(error)`, calls or schedules `stopBroker()` safely and does not rethrow;
- otherwise logs or routes the error consistently without crashing detached promises;
- protects `stopBroker()` itself from becoming another unhandled rejection.

### 3. Fix the reported pending-turn retry path

Cover all current launch sites:
- startup maintenance IIFE in `ensureBrokerStarted()`;
- injected `retryPendingTurns: () => { void retryPendingTurns(); }` used after session heartbeat;
- stale-client standdown fence clear path after `persistBrokerState()`.

`retryPendingTurns()` itself may also need local lease-loss handling around its final persist, but prefer one consistent background-task wrapper so future callers do not have to remember bespoke catches.

Preserve behavior:
- per-turn IPC failures remain non-terminal so durable pending turns retry later;
- successful IPC delivery may update `pending.updatedAtMs` only if the broker still owns persistence;
- if the broker lost ownership, the current/new broker remains responsible for durable retry from stored state.

### 4. Audit and harden the same pattern in broker-owned timers/background tasks

At minimum inspect and either fix or explicitly justify:
- `scheduleMediaGroupFlush()` timer → `flushMediaGroup()` → `removeProcessedMediaGroupUpdates()` → `persistBrokerState()`;
- `AssistantFinalDeliveryLedger.kick()` and retry timers, especially `.finally()` without terminal `.catch()`;
- broker heartbeat `.catch()` path that calls `void stopBroker()`;
- any broker route cleanup / queued-control retry scheduling called from startup or heartbeat maintenance.

Expected outcome:
- broker-owned detached tasks never produce unhandled rejections for stale broker lease loss;
- assistant final delivery still stops/pauses on broker loss without dropping pending final ledger entries;
- media group pending state is not incorrectly removed by a stale broker.

### 5. Audit client-side detached rejections separately but include cheap fixes

Client-side fire-and-forget promises are not the root cause of this crash, but they are the same Node 24 process-crash shape.

Inspect:
- deferred final timer in `src/client/retry-aware-finalization.ts`;
- fire-and-forget `persistDeferredState?.()` calls;
- `pi.sendUserMessage()` calls in `src/client/runtime.ts` and `src/client/runtime-host.ts`;
- `setTimeout(() => void this.standDownStaleClientConnection(...))` and `setTimeout(() => void this.stopClientServer())`.

Include small, clearly safe terminal catches where they do not change lifecycle semantics. If a broader client async-safety cleanup emerges, capture a follow-up inbox/task rather than expanding this broker lease-loss fix indefinitely.

### 6. Add focused regression validation

Add or extend a check script that simulates the reported failure without needing real Telegram.

Minimum regression scenario:
- construct runtime/update-handler dependencies with pending turns and a persist function that throws the stale-broker error at the same point as the real crash;
- launch pending-turn retry through the same detached/safe wrapper used by `extension.ts`, or expose a small unit seam for that wrapper;
- assert the promise is caught/settled and records controlled broker stand-down rather than surfacing an unhandled rejection.

Additional useful checks if practical:
- assistant-final ledger `kick()` catches stale-broker persistence failure and stops/settles without unhandled rejection;
- media-group flush timer persistence stale-broker failure is caught by the scheduler/wrapper;
- non-stale persistence errors are not silently swallowed by stale-broker-specific logic.

Wire any new script into `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json` if following the current check-script pattern.

### 7. Validate the whole package

Run:

```bash
npm run check
```

Also run any new focused check directly if it is not already included by `npm run check` during development.

## Acceptance criteria

- `stale_broker` from `retryPendingTurns()` final persistence cannot terminate the Node process through an unhandled rejection.
- Broker lease loss in detached broker maintenance paths is handled as controlled stand-down or stale-work discard.
- The stale broker write fence remains intact: stale brokers still cannot write broker state after losing lease ownership/epoch.
- Pending turns, media groups, assistant finals, queued controls, and route cleanup retry state remain durable for the current/new broker to resume; the old broker does not delete or overwrite newer state while standing down.
- Non-stale errors are not hidden behind stale-broker handling; they remain visible through existing status/log/test failure behavior.
- Focused regression coverage demonstrates the crash path and at least one adjacent detached broker task pattern no longer produce unhandled rejections.
- `npm run check` passes.

## Out of scope

- Do not remove broker lease fencing or allow stale brokers to persist state.
- Do not redesign broker election, lease timing, or the bot-scoped broker directory layout in this slice.
- Do not convert the extension to an external daemon or hosted broker.
- Do not rewrite all runtime lifecycle state machines; capture broader cleanup separately if discovered.
- Do not change Telegram retry_after, final FIFO ordering, media-group batching, or session reconnect-grace semantics except where necessary to prevent stale-broker crashes.

## Planning notes

Architecture impact: the existing architecture already says broker-state writes must be fenced by lease owner/epoch. This task clarifies the complementary invariant: discovering lease loss from already-running background work is a normal broker lifecycle outcome and must not be treated as an uncaught fatal process error.

## Decisions

- 2026-04-29: Implemented stale broker handling with a shared StaleBrokerError/isStaleBrokerError guard and a runBrokerBackgroundTask wrapper. The wrapper treats stale broker errors as broker stand-down via stopBroker while logging non-stale background errors instead of letting detached promises become unhandled rejections.
- 2026-04-29: Kept persistBrokerState lease fencing intact: stale brokers still reject before writing state. Background callers and broker-owned timers now catch that rejection rather than persisting anyway.
- 2026-04-29: Added focused activity coverage in scripts/check-broker-background.ts for pending-turn retry stale persistence, non-stale background error logging, and assistant-final ledger stale persistence from kick().
- 2026-04-29: Fixed the pre-existing macOS /var versus /private/var attachment safety check expectation so npm run check can validate this task on the current machine; the fix only normalizes the expected safe path to realpath and does not weaken attachment guards.
- 2026-04-29: Review found two visibility/semantics issues: queued-turn steer conversion must keep its failure-propagating requeue path, and media-group background failures must console-log non-stale errors. Updated the implementation accordingly while keeping ordinary fire-and-forget sends best-effort.
- 2026-04-29: Second review showed pi.sendUserMessage is synchronous in the API and direct-delivery paths rely on thrown failures to avoid acknowledging undelivered turns. Reverted the sendUserMessage best-effort helper changes and kept only actual Promise/timer rejection hardening.
- 2026-04-29: Added an explicit console warning before swallowing non-retry_after media-group preparation failures so album failures remain visible even when the Telegram status UI is hidden or the user-facing reply fails.
- 2026-04-29: Final review found startNextTelegramTurn also needed to preserve local delivery failure semantics. It now restores the queued turn/current abort/active turn and avoids posting turn_started if pi.sendUserMessage throws; check-client-runtime-host covers that failure path.
