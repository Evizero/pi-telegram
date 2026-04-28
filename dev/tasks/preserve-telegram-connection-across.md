---
title: "Preserve Telegram connection across session replacement"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Salis"
assignee: ""
labels: []
traces_to: ["SyRS-session-replacement-route-continuity", "SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace", "SyRS-final-delivery-fifo-retry"]
source_inbox: "support-slash-new-without"
branch: "task/preserve-telegram-connection-across"
---
## Objective

Preserve Telegram reachability when a connected pi session is replaced through user-initiated pi session flows such as native `/new`, `/resume`, or `/fork`, without weakening cleanup for true disconnects or process exits.

The desired outcome is that local pi session replacement continues the remote supervision relationship instead of making the user manually reconnect Telegram after `/new`.

## Scope

Implement a bounded session-replacement handoff between the old extension runtime's `session_shutdown` and the replacement runtime's `session_start`. The handoff must be correlated to the intended replacement session, not just keyed by a TTL or shutdown reason. The first implementation may reconnect/register the replacement route or retarget the existing route, but it must make the lifecycle distinction explicit and retry-safe enough not to leave permanent stale topics or attach a route to the wrong replacement.

## Codebase grounding

- Pi emits `session_shutdown` with reasons including `quit`, `reload`, `new`, `resume`, and `fork`, and exposes `targetSessionFile` for replacement flows; `session_start` receives `startup`, `reload`, `new`, `resume`, and `fork` plus `previousSessionFile` for replacement flows.
- `src/pi/hooks.ts` currently drops the shutdown event object entirely, ignores shutdown reason/target session correlation, and always calls `disconnectSessionRoute("shutdown")` followed by `stopBroker()`.
- `src/extension.ts` passes `session_start` reason to `onSessionStart`, but the registered implementation currently ignores it and only initializes config/private directories.
- `src/broker/sessions.ts`, broker registration, route cleanup, pending finals, and temp cleanup must remain consistent with `SyRS-cleanup-route-on-close`, `SyRS-cleanup-route-after-reconnect-grace`, and `SyRS-final-delivery-fifo-retry`.
- Telegram-issued `/new` is not cleanly supported by current broker/event contexts because `ctx.newSession()` is available on command contexts, not ordinary broker update handlers. Treat that as future scope unless pi exposes a safe event-context replacement API.

## Acceptance Criteria

- Native pi replacement flows for connected sessions (`new`, `resume`, and `fork`) no longer perform irreversible route/topic cleanup before the replacement session can reconnect or be retargeted.
- The replacement session consumes a bounded handoff only when its `session_start` reason and previous/current session identity match the old runtime's recorded replacement target; stale or mismatched handoffs are rejected or allowed to expire safely.
- The matched replacement restores Telegram reachability without requiring manual `/telegram-connect` when the old session was connected.
- Explicit `/telegram-disconnect`, Telegram `/disconnect`, ordinary process close/quit, failed/cancelled replacement, and reconnect-grace expiry still clean up or preserve state according to existing lifecycle requirements.
- Unrelated connected sessions, pending finals, pending turns, activity cleanup, route cleanup retry, and session-scoped Telegram temp retention remain safe.
- Regression coverage distinguishes replacement shutdown reasons from terminal shutdown, verifies target/previous-session handoff correlation, and covers route/thread preservation or intentional route recreation behavior.

## Out of Scope

- Do not add a Telegram-issued `/new` command in this slice unless pi exposes a safe replacement API usable from the Telegram update path.
- Do not revive the deprecated Telegram `/reload` route-reattachment feature.
- Do not make Telegram topics durable session history; they remain connection-scoped views.
- Do not skip cleanup for terminal session closes just to preserve replacement behavior.

## Validation

- Add runtime hook/session-route cleanup checks for replacement handoff and terminal cleanup paths.
- Run `npm run check`.

## Decisions

- 2026-04-28: Session replacement now records a bounded handoff on new/resume/fork shutdown, auto-connects matching replacement starts, and has the broker retarget route, pending turns/finals, and selector selection only when previous/current session files match.
- 2026-04-28: Review found the replacement path also had to stop the old client server after route shutdown; the implementation now closes the client endpoint/heartbeat while preserving broker route state for the handoff.
- 2026-04-28: Replacement retargeting now deletes only routes owned by the old session so single-chat routes for unrelated sessions in the same chat are preserved.
- 2026-04-28: Review tightened the replacement shutdown error path: stopClientServer now runs in a finally after handoff-prepared route shutdown so the old IPC server and heartbeat are closed even if final handoff work throws.
- 2026-04-28: Close-out validation passed: npm run check, pln hygiene, and final review agent re-review reported no findings.
