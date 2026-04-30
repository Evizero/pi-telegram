---
title: "Stabilize broker heartbeat diagnostics"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["broker", "diagnostics", "reliability"]
traces_to: ["SyRS-broker-renewal-contention", "SyRS-pi-safe-diagnostics", "SyRS-broker-lease-loss-standdown"]
source_inbox: "broker-heartbeat-logs-takeover"
branch: "task/stabilize-broker-heartbeat-diagnostics"
---
## Objective

Stabilize broker heartbeat and diagnostic behavior so transient takeover-lock contention during lease renewal does not look like a broker failure, does not force unnecessary broker stand-down, and does not print raw warning text into the pi TUI.

The task should address the observed `EEXIST` takeover-lock race as part of the broader coordination/logging splash zone: classify benign contention explicitly, preserve controlled stand-down for true lease loss, and route user-visible extension diagnostics through pi-native surfaces or session-visible diagnostic messages rather than raw terminal writes.

## Scope

- Classify takeover-lock contention during `renewBrokerLease()` as a distinct transient broker coordination state when the current broker still owns a live lease.
- Keep true lease loss behavior intact: missing, expired, mismatched-owner, or mismatched-epoch broker leases should still trigger controlled stand-down without unhandled async failures.
- Prevent one-off benign renewal contention from incrementing generic broker heartbeat failure counters or reaching the two-failure stand-down path.
- Escalate repeated live takeover-lock contention across a bounded window into actionable pi-safe diagnostic state, because persistent contention can indicate client reconnect/election churn or broker coordination failure even while the leader lease remains live.
- Suppress overlapping broker heartbeat ticks or otherwise make the heartbeat loop serialized enough that slow renewal/maintenance work does not create self-inflicted contention.
- Replace user-visible raw `console.warn` paths in broker heartbeat/background diagnostics with a small pi-safe reporting abstraction.
- Use the diagnostic abstraction to choose between:
  - silent/internal diagnostics for non-actionable transient contention;
  - `ctx.ui.notify` / `ctx.ui.setStatus` style feedback for short-lived degraded or recovered states when a current context is available;
  - displayed custom session messages for durable/actionable events such as broker stand-down, repeated unrecovered failure, or route/final-delivery outcomes the user may need to see later.

## Codebase grounding

Likely touchpoints:

- `src/broker/lease.ts` — `acquireTakeoverLock()`, `tryAcquireBrokerLease()`, and `renewBrokerLease()` currently share `TAKEOVER_LOCK_DIR` but classify contention asymmetrically.
- `src/extension.ts` — broker heartbeat timer currently catches renewal errors, increments `brokerHeartbeatFailures`, calls raw `console.warn`, and stands down after two failures.
- `src/broker/background.ts` and nearby broker maintenance helpers — existing detached task error handling should use the same stale-broker and diagnostic classification vocabulary where practical.
- `src/client/runtime-host.ts` and `src/client/connection.ts` — inspect reconnect/election pressure enough to avoid accidentally making client retries more aggressive, but do not redesign client lifecycle in this slice unless required by tests.
- Behavior-check scripts or a focused new script under `scripts/` — add regression coverage without turning this into a full integration harness.
- `dev/ARCHITECTURE.md` — update the broker turnover/quality-goal sections if the fix introduces a named diagnostic/reporting abstraction or changes the lease/heartbeat coordination contract.

## Acceptance Criteria

- A focused regression simulates a live `takeover.lock` while the broker lease is still owned by the renewing broker and verifies one-off contention is classified as benign/transient rather than a heartbeat failure.
- Broker heartbeat failure counters and broker stand-down are not advanced by one-off benign renewal contention.
- A repeated-contention regression keeps the leader lease live while takeover-lock contention recurs across a bounded threshold/window, then verifies the condition is surfaced through the pi-safe diagnostic path without triggering an agent turn or spamming Telegram/pi conversation messages.
- True stale/missing/mismatched broker leases still lead to controlled stand-down and do not produce unhandled promise rejections or pi process termination.
- Broker heartbeat ticks cannot overlap in a way that causes repeated self-inflicted renewal failures.
- User-visible extension diagnostics no longer use raw terminal `console.warn` from interactive broker heartbeat paths.
- Non-actionable transient contention does not spam the pi conversation or Telegram.
- Durable/actionable broker lifecycle failures can be surfaced through pi-native notification/status or displayed custom session-message mechanisms without triggering an unintended agent turn.
- Existing Telegram behavior remains stable: pending turns, final delivery retry, route cleanup, topic context, and Telegram `retry_after` handling are not broadened or weakened by the diagnostic work.

## Out of Scope

- Do not replace the extension-owned broker with an external daemon or service.
- Do not redesign Telegram routing, pending-turn delivery, assistant-final ledgers, or client turn lifecycle.
- Do not make every debug event conversation-visible; only durable/actionable diagnostics should enter the session transcript.
- Do not weaken secret redaction or bridge privacy in diagnostic text.

## Validation

Run `npm run check` before close-out. Add targeted behavior/regression coverage for renewal contention and heartbeat diagnostic classification, and include inspection or tests proving raw interactive warning output is no longer used for the broker heartbeat failure path.

Also run `pln hygiene` after planning/implementation artifact updates.

## Pre-edit impact preview

Expected blast radius is moderate: broker lease classification, broker heartbeat scheduling, diagnostic reporting, and one or more focused behavior checks. The main risks are accidentally hiding real broker loss, creating conversation/log spam, or destabilizing client reconnect/election behavior while fixing the visible `EEXIST` symptom.

## Decisions

- 2026-04-30: Implementation started from the ready task. Initial impact preview: change broker lease contention classification in src/broker/lease.ts, broker heartbeat serialization/failure reporting in src/extension.ts, add or extend focused behavior checks under scripts/, and update task decisions. Main risks are hiding true lease loss, over-reporting diagnostics, or disrupting client reconnect/election; validations will include targeted behavior checks plus npm run check and review.
- 2026-04-30: Implemented broker lease renewal contention as a first-class BrokerRenewalContentionError from src/broker/lease.ts when a live takeover lock blocks renewal while the current broker still owns a live lease. Added src/broker/heartbeat.ts to serialize heartbeat cycles, keep generic failure counters separate from renewal contention, escalate repeated contention once through pi-safe diagnostics, and preserve controlled stand-down for true lease loss and repeated generic heartbeat failure. Added src/pi/diagnostics.ts so user-visible broker background diagnostics are routed through pi status/notification/session-message surfaces instead of the heartbeat path writing raw console output.
- 2026-04-30: Review found that heartbeat failures from maintenance were reset before they could accumulate, and that coverage did not explicitly check missing leases, mismatched epochs, or stale takeover-lock recovery. Fixed heartbeat success accounting so generic failures reset only after renewal, active check, and maintenance all succeed; added regressions for repeated maintenance failure stand-down, missing lease, mismatched epoch, and stale takeover-lock renewal recovery.
- 2026-04-30: Second review identified two heartbeat-maintenance diagnostic paths that still wrote raw console warnings: queued-control finalization failures and terminal route cleanup failures. Routed both through the pi-safe diagnostic reporter; queued-control failures now remain status-only, while terminal route-cleanup failures are actionable displayed diagnostics with triggerTurn false.
- 2026-04-30: Final review found assistant-final terminal delivery diagnostics were still raw console warnings from a heartbeat-reachable ledger kick, and repeated-failure stand-down could reject if stopBroker failed. Routed terminal final delivery failures through pi-safe displayed diagnostics with triggerTurn false and made heartbeat stand-down catch/report stopBroker failures. Added a regression proving rejected stand-down is reported without rejecting the heartbeat cycle.
