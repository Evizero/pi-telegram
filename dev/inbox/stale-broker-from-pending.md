---
title: "stale_broker from pending-turn retry can crash process"
type: "bug"
created: "2026-04-29"
author: "Christof Salis"
status: "planned"
planned_as: ["handle-stale-broker-lease-loss-without"]
---
Source: user report on 2026-04-29. A pi-telegram extension process crashed with:

```text
/home/csto/.pi/agent/git/github.com/evizero/pi-telegram/src/extension.ts:500
    if (!isBroker || !lease || lease.ownerId !== ownerId || lease.leaseEpoch !== brokerLeaseEpoch || lease.leaseUntilMs <= (0, _utils.now)()) throw new Error(\"stale_broker\");
                                                                                                                                                    ^
Error: stale_brokeressions
    at assertCurrentBrokerLeaseForPersist (/home/csto/.pi/agent/git/github.com/evizero/pi-telegram/src/extension.ts:500:149)
    at async /home/csto/.pi/agent/git/github.com/evizero/pi-telegram/src/extension.ts:505:7
    at async Object.retryPendingTurns (/home/csto/.pi/agent/git/github.com/evizero/pi-telegram/src/broker/updates.ts:430:5)

Node.js v24.12.0
```

Initial investigation:
- `src/extension.ts:498-500` makes every broker-state persist assert the current broker lease and throws `stale_broker` if the lease is gone, expired, or owned by a different broker.
- `src/broker/updates.ts:388-430` `retryPendingTurns()` catches per-turn IPC delivery failures but unconditionally calls `deps.persistBrokerState()` afterward, so a lease race during persistence escapes as `stale_broker`.
- `src/extension.ts:559-567` starts a one-shot startup maintenance async IIFE with `void (...)();` and no `.catch(...)`; this path calls `retryPendingTurns()` directly. A stale lease here can become an unhandled rejection/process crash under current Node behavior.
- `src/broker/session-registration.ts:84-85` can also trigger pending-turn retry from session heartbeat. The injected dependency in `src/extension.ts` is `retryPendingTurns: () => { void retryPendingTurns(); }`, also fire-and-forget without a catch.
- The poll loop has explicit stale-lease checks and calls `stopBroker()`, but background maintenance/retry paths do not consistently convert stale broker detection into graceful broker stand-down.
- Lease timing is short (`BROKER_LEASE_MS = 10_000`, heartbeat every `2_000` ms), so a long event-loop stall, suspended process, startup/failover race, or broker replacement could make the lease stale between beginning retry work and persisting retry metadata.

Expected behavior: losing or expiring the broker lease should make the old broker stop/stand down or ignore stale background work, not crash the whole pi session process.

Follow-up ideas:
- Treat `stale_broker` from background broker maintenance as a controlled stand-down path.
- Add `.catch(...)` to fire-and-forget startup/session pending-turn retry calls.
- Consider a named stale-broker error/type guard so callers can distinguish lease loss from real persistence failures.
- Add a validation scenario where `retryPendingTurns()` reaches `persistBrokerState()` after the lease has been replaced/expired and assert that the process remains alive and broker stops or ignores the work.


## Deep-dive update (2026-04-29)

Root cause now looks like a regression from adding the broker-lease persistence fence in commit `e844f5c` (`fix: stabilize Telegram session routes`) without making all background broker work lease-loss-safe.

Evidence:
- Before `e844f5c`, `persistBrokerState()` wrote state without checking broker ownership. `e844f5c` added `assertCurrentBrokerLeaseForPersist()` and now every persist rejects with `stale_broker` when the process is no longer current broker.
- The crashed stack exactly matches `retryPendingTurns()` reaching its final `await deps.persistBrokerState()` after broker leadership was no longer current.
- `retryPendingTurns()` is launched from at least three detached/background paths without a terminal catch: startup maintenance IIFE, session heartbeat retry hook, and stale-client standdown fence clearing.
- Normal poll-loop lease loss is handled by checking lease and calling `stopBroker()`, but pending-turn retry does not have the same guard or stale-broker catch.

Most likely runtime timeline:
1. This process had a broker lease and pending Telegram turns to retry.
2. `retryPendingTurns()` started from startup maintenance or a detached heartbeat/fence-clear path.
3. Before its final persist, the lease became stale/expired/replaced or `stopBroker()` flipped `isBroker` false after another lease check noticed staleness.
4. `persistBrokerState()` rejected with `stale_broker`.
5. The fire-and-forget caller had no `.catch()`, so Node 24 treated the unhandled rejection as fatal and exited the pi process.

Trigger for the stale lease may be ordinary failover, process suspend/resume, long event-loop stall, config/scope race, or another pi session taking over after the 10s broker lease. The crashing bug is not lease loss itself; it is that background maintenance treats lease loss as an uncaught exception instead of controlled broker stand-down/ignore-stale-work.

Splash zone to inspect/fix with the same pattern:
- `src/extension.ts`: startup maintenance IIFE, detached `retryPendingTurns()` calls, heartbeat catch calling `void stopBroker()`.
- `src/broker/updates.ts`: pending-turn retry final persist; media-group flush timer final persist.
- `src/broker/finals.ts`: `AssistantFinalDeliveryLedger.kick()` stores a `.finally()` promise with no catch; delivery paths persist repeatedly and can reject after lease loss.
- `src/client/retry-aware-finalization.ts`: deferred-final timer calls `flushDeferred()` without catch; persist-deferred calls are fire-and-forget.
- `src/client/runtime-host.ts` / `src/client/runtime.ts` / `src/client/compact.ts`: several `pi.sendUserMessage()` and stop/standdown timer calls are fire-and-forget and can become similar unhandled-rejection crashes even when not directly `stale_broker`.

Fix direction: introduce a typed/named stale-broker guard, make all broker background tasks run through a safe detached-task wrapper, and treat stale broker from maintenance persists as `stopBroker()`/ignore rather than fatal. Add a regression check where `retryPendingTurns()` loses the lease before final persist and does not crash.
