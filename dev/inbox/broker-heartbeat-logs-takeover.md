---
title: "Broker heartbeat logs takeover lock contention"
type: "bug"
created: "2026-04-30"
author: "Christof Stocker"
status: "planned"
planned_as: ["stabilize-broker-heartbeat-diagnostics"]
---
## User report

In a broker with two sessions, after the agent ran and wrote a message, the broker session printed twice:

```text
[pi-telegram] Broker heartbeat failed: EEXIST: file already exists, mkdir '/home/csto/.pi/agent/telegram-broker/bot-8634491900/takeover.lock'
[pi-telegram] Broker heartbeat failed: EEXIST: file already exists, mkdir '/home/csto/.pi/agent/telegram-broker/bot-8634491900/takeover.lock'
```

The message also rendered in a non-pi-typical way and glitched the TUI.

## Initial investigation

Relevant code paths:

- `src/extension.ts` broker heartbeat calls `renewBrokerLease()` inside a timer and logs non-stale failures with `console.warn(...)`. That raw console write likely explains the TUI glitch; it bypasses normal pi UI/status reporting.
- `src/broker/lease.ts` uses the same `TAKEOVER_LOCK_DIR` for takeover acquisition and broker lease renewal. `tryAcquireBrokerLease()` handles `EEXIST` by inspecting/removing stale takeover locks, but `renewBrokerLease()` directly calls `mkdir(TAKEOVER_LOCK_DIR)` and lets `EEXIST` throw.
- Therefore a second session attempting broker takeover at the same time as the current broker heartbeat can produce a transient `EEXIST` that is logged as a heartbeat failure. If repeated, the heartbeat failure counter can stand the broker down even though this may be ordinary contention.

Runtime filesystem check immediately afterward showed no lingering `takeover.lock`; `leader.lock/lock.json` existed and was updating recently for bot `8634491900`. This suggests transient contention rather than a permanently stale lock in that moment.

## Suspected underlying issues

1. Broker heartbeat renewal should probably handle `takeover.lock` contention explicitly instead of surfacing raw `EEXIST` as a generic heartbeat failure.
2. If another session is repeatedly attempting takeover while the leader lease is live, investigate why it believes takeover is needed: possible stale lease read, missed/blocked heartbeat, failed broker IPC/register path, or heartbeat starvation while the broker session is running agent work.
3. Broker heartbeat errors should be reported through a pi-appropriate status/notification path or be classified as controlled stand-down/diagnostic logging, not raw `console.warn` that disrupts the TUI.

## Reproduction notes

Observed with two connected sessions and the broker session running an agent turn that wrote a message. No automated reproducer yet. A useful regression would simulate one process holding `takeover.lock` while `renewBrokerLease()` runs, and verify it does not produce raw TUI-glitching output or incorrectly count benign contention as an ordinary heartbeat failure.


## Deep-dive root cause

The root cause is not the recent turn-lifecycle refactor. It is the broker lease/heartbeat locking design plus error classification:

1. `src/broker/lease.ts` uses one filesystem directory, `TAKEOVER_LOCK_DIR`, for two different operations:
   - contender election/takeover in `tryAcquireBrokerLease()` via `acquireTakeoverLock()`;
   - normal leader renewal in `renewBrokerLease()`.
2. `acquireTakeoverLock()` treats an existing takeover lock as ordinary contention unless it is stale.
3. `renewBrokerLease()` does not do the same. It calls `mkdir(TAKEOVER_LOCK_DIR)` and lets `EEXIST` escape.
4. `src/extension.ts` broker heartbeat catches that escaped `EEXIST` as a generic heartbeat failure, writes it with raw `console.warn`, increments `brokerHeartbeatFailures`, and can stand the broker down after two occurrences.

That means a transient and expected race becomes a visible broker failure:

- current broker heartbeat tries to renew the leader lease every 2s;
- another connected session can enter reconnect/election after IPC/registration/lease liveness appears bad;
- the contender briefly creates `takeover.lock`;
- the broker heartbeat concurrently calls `renewBrokerLease()` and receives `EEXIST`;
- the broker session logs `[pi-telegram] Broker heartbeat failed: EEXIST...` because only the broker process runs that heartbeat logger.

The repeated message is explained by the same fixed-interval heartbeat path: each tick is independent and there is no specific suppression/classification for takeover-lock contention. Repetition can come from repeated contender reconnect/election attempts, or from a long enough lock/renew overlap. After two such ticks the current code may trigger broker stand-down even if the contention was transient.

### Evidence

- `src/broker/lease.ts:36-55`: takeover acquisition handles existing `takeover.lock` by inspecting stale/non-stale state and returning `false` for live contention.
- `src/broker/lease.ts:58-91`: `tryAcquireBrokerLease()` uses that takeover lock and removes it in `finally`.
- `src/broker/lease.ts:94-110`: `renewBrokerLease()` also uses `takeover.lock`, but bare `mkdir(TAKEOVER_LOCK_DIR)` lets `EEXIST` throw before `locked = true`.
- `src/extension.ts:544-563`: broker heartbeat runs every tick, catches non-stale errors, logs with raw `console.warn`, increments the failure counter, and stands down after two failures.
- `src/client/connection.ts:45-66` and `src/client/runtime-host.ts:208-218`: client reconnect/connect paths can enter election when the live broker cannot be registered with or the lease is considered not live.
- Runtime check immediately after the report found no persistent `takeover.lock`, while `leader.lock/lock.json` was present and updating. That matches transient contention, not a permanently wedged takeover lock.

### Fix direction

Planned work should treat takeover-lock contention during broker renewal as a classified state, not a generic heartbeat failure. Options include:

- split the election lock from the renewal write mutex, or make renewal use a lock helper that recognizes live same/other-owner contention;
- serialize/suppress overlapping broker heartbeat ticks so one slow renewal cannot collide with the next tick;
- do not count benign `EEXIST` contention toward broker stand-down unless the lease actually becomes stale or ownership changes;
- replace raw `console.warn` UI output with pi-safe status/diagnostic reporting.


## Splash-zone assessment

This looks like a symptom of a broader broker coordination weakness, not only a one-line `EEXIST` bug. The broader pattern is:

- Lease/election/renewal coordination uses a shared coarse filesystem lock but has asymmetric contention handling. Election handles live contention; renewal does not.
- Periodic broker/client heartbeat loops are fixed-interval and fire-and-forget. They do not generally guard against an already-running tick, so a slow IPC, Telegram API retry, filesystem write, or TUI/event-loop delay can create overlapping maintenance work.
- Client heartbeat treats any non-stale IPC heartbeat failure as reconnect pressure. Reconnect can fall into broker election if the lease appears not live or registration fails, which can create takeover-lock contention while the original broker is still alive.
- Background broker errors are often logged through raw `console.warn`, so internal coordination noise leaks into the pi TUI and can visibly corrupt the interface.
- Failure classification is too coarse: transient contention, stale lease, IPC timeout, Telegram retry/rate limit, and real broker corruption are not consistently separated before incrementing failure counters or taking stand-down actions.

Likely splash zone for planning/tests:

1. Broker lease renewal/takeover lock semantics (`src/broker/lease.ts`).
2. Broker heartbeat scheduling, failure counters, and stand-down policy (`src/extension.ts`).
3. Client heartbeat/reconnect/election thresholds (`src/client/runtime-host.ts`, `src/client/connection.ts`).
4. IPC timeout/registration behavior (`src/shared/ipc.ts`, broker registration handlers).
5. Pi-safe diagnostic/reporting path for broker/client background failures (`src/broker/background.ts`, raw `console.warn` call sites).

A robust fix should avoid merely swallowing `EEXIST`; it should make broker coordination states explicit enough that benign contention does not count as failure, true stale ownership still stands down quickly, and diagnostics are visible without breaking the TUI.


## Logging/UI direction

Use pi-native surfaces instead of raw `console.warn` for user-visible extension diagnostics. Pi extension docs expose `ctx.ui.notify(...)`, `ctx.ui.setStatus(...)`, widgets, and `pi.sendMessage({ customType, content, display: true }, ...)` for session-visible custom messages. Raw `console.warn` is appropriate only for developer/debug logs outside the TUI path; in interactive pi it can bypass rendering and corrupt the terminal UI.

For this bug class, classify outputs into tiers:

- Silent/internal diagnostic: transient benign contention such as takeover-lock `EEXIST` during renewal should not create a conversation message by default. It can update debug counters/state.
- Status/notification: short-lived degraded states, reconnecting, broker stand-down, or recovered coordination should use `ctx.ui.notify` or `ctx.ui.setStatus` when a current context is available.
- Conversation message: durable events the user may need to see later, such as broker role changed, broker stood down, final delivery abandoned, route disconnected, or repeated recovery failure, should use `pi.sendMessage` with a `customType` like `telegram_diagnostic`, `display: true`, and `triggerTurn: false` so it becomes part of the session transcript without steering the agent.

This should be part of the fix task: add a small diagnostic/reporting abstraction so background broker code can emit pi-safe status/messages when `latestCtx` is available, while keeping low-level modules free of direct TUI concerns.
