---
title: "Honor explicit Telegram disconnect before route reuse"
status: "done"
priority: 2
created: "2026-04-27"
updated: "2026-04-27"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "lifecycle", "routing", "bug"]
traces_to: ["SyRS-unregister-session-route", "SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace", "SyRS-register-session-route", "SyRS-topic-routes-per-session", "SyRS-retry-topic-cleanup", "SyRS-final-delivery-fifo-retry"]
source_inbox: "reconnect-after-explicit-telegram"
branch: "task/honor-explicit-telegram-disconnect"
---
## Objective

Make explicit Telegram disconnect a terminal route-lifecycle event so reconnecting the same pi session later creates a fresh Telegram route, and a fresh Telegram topic where topic routing applies, instead of reusing the old Telegram view. Preserve route reuse for automatic reconnect and broker turnover cases.

The bug to fix is that the current non-broker disconnect flow can queue a disconnect request, stop/hide the local client, then lose a race to a later registration that reuses the old route and clears or invalidates the pending request. A related self-broker path can leave old route state behind when pending final delivery blocks unregister while the client is still stopped/hidden.

## Planned approach

Treat explicit disconnect as a broker-owned state transition that targets a specific route incarnation, not as a best-effort session-id cleanup request.

Implementation should prefer this shape:

- Extend `PendingDisconnectRequest` with enough route-generation identity to terminate only the old Telegram view, such as `routeId`, `chatId`, `messageThreadId`, `connectionStartedAtMs`, and the existing `connectionNonce`.
- Make `queueDisconnectRequest()` include the current `connectedRoute` identity when available.
- Add a cohesive broker/session helper that honors an explicit disconnect intent by:
  - removing the targeted old route from `brokerState.routes`,
  - queueing retry-safe topic cleanup for topic routes,
  - removing selector selections for the target session where appropriate,
  - stopping/clearing route-bound pending turn, final, preview, and typing state according to explicit-disconnect semantics,
  - persisting broker state before the intent is considered complete.
- Call that helper from both pending disconnect request processing and the session registration path before route ensure/reuse.
- Change registration so it cannot blindly reuse an old route and then clear a pending explicit-disconnect request for the same route.
- Change pending disconnect request staleness logic so a newer `connectionNonce` or `connectionStartedAtMs` does not by itself make an explicit disconnect request stale when the request names an old route that still exists.
- Add or adjust broker IPC so non-broker explicit disconnect can get an acknowledgement when the broker is reachable; retain the durable request file as a fallback for broker unavailable/failover cases.
- Fix the self-broker pending-final path so explicit disconnect does not stop/hide the client while leaving the old route registered. If route-bound pending finals are canceled or terminally no-sent, record an explicit broker-owned terminal outcome so FIFO final delivery is not silently bypassed. If final delivery is allowed to finish first, persist a guaranteed unregister-after-final intent and keep local status honest until unregister is complete.

## Codebase grounding

Likely touchpoints:

- `src/extension.ts`
  - `disconnectSessionRoute()`, `queueDisconnectRequest()`, `processPendingDisconnectRequests()`, `handleBrokerIpc()`, and client/broker connection startup ordering.
  - Watch the `isBroker` branch, the non-broker `hadConnectedRoute` branch, and the asynchronous `ensureBrokerStarted()` processing path.
- `src/broker/disconnect-requests.ts`
  - Request schema and stale-request handling. Route-scoped requests should remove the old route even if the session has already re-registered with a newer connection nonce.
- `src/broker/session-registration.ts`
  - `registerSession()` currently calls `ensureRouteForSessionLocked(...)` before clearing the request. It should honor pending explicit-disconnect route intents before route reuse.
- `src/broker/routes.ts`
  - `ensureRouteForSessionInBroker()` currently returns any existing matching route for the same session. It should continue to do that for automatic reconnect, but not when an explicit-disconnect intent targets that route.
- `src/broker/sessions.ts`
  - Route detachment, selector cleanup, pending turn/final cleanup, and topic cleanup queuing should be shared rather than duplicated.
- `src/broker/finals.ts` and final-ledger lifecycle hooks if explicit disconnect must cancel or terminally classify pending final deliveries for the route.
- Check scripts under `scripts/` and `scripts/run-activity-check.mjs` for focused lifecycle regressions without a live Telegram bot.

## Acceptance Criteria

- Self-broker idle `/telegram-disconnect` removes the current route and queues topic cleanup where applicable; a later `/telegram-connect` in the same pi session creates a new route, and a new topic where topic routing applies.
- Non-broker `/telegram-disconnect` with a reachable broker receives broker acknowledgement only after the old route is detached or safely marked for cleanup; local status is not hidden as a completed disconnect before that broker-owned transition succeeds.
- Non-broker `/telegram-disconnect` followed by `/telegram-connect` before the broker heartbeat processes the request still removes the old route before registration can reuse it, then creates a fresh route, and a fresh topic where topic routing applies.
- If the disconnecting session later becomes broker while its disconnect request is pending, broker startup/registration ordering still honors the pending route-scoped disconnect before route reuse.
- Explicit disconnect with pending route-bound assistant finals, previews, typing loops, or pending Telegram turns does not leave the old route registered and reusable. Pending route-view work is canceled, terminally no-sent, or deferred under a durable unregister intent in broker-owned state in a way that preserves FIFO final-delivery accounting and cannot resurrect the old topic on reconnect.
- Telegram `/disconnect` and normal `session_shutdown` continue to remove only the target session route and queue topic cleanup where applicable; this task must not regress those existing cleanup paths even if its new race coverage focuses on local `/telegram-disconnect` reconnect flows.
- Automatic reconnect without explicit disconnect still reuses the existing route during the bounded reconnect grace and does not create duplicate topics.
- A stale disconnect request for an old route cannot delete a newly-created route/topic after reconnect; cleanup is scoped to the old `routeId`/thread identity.
- Unrelated sessions, routes, selector choices, pending turns, and finals remain intact when one session explicitly disconnects.
- Topic cleanup remains retry-safe and continues to honor Telegram `retry_after` behavior.

## Out of Scope

- Do not redesign Telegram topic naming, selector-mode UX, pairing, authorization, or general route selection semantics.
- Do not intentionally change Telegram `/disconnect` or normal `session_shutdown` behavior except where shared cleanup helpers require preservation-focused refactoring.
- Do not remove automatic reconnect route reuse; the distinction between explicit disconnect and recoverable runtime churn must remain.
- Do not convert Telegram topics into durable session history. Topics remain connection-scoped views over local pi history.
- Do not introduce a hosted broker or inbound server dependency.

## Validation

- Add focused regression checks for:
  - self-broker idle disconnect/reconnect creates a new route,
  - non-broker reachable-broker disconnect acknowledgement only reports local disconnect after broker-owned route detach/cleanup marking succeeds, and keeps status honest on broker failure,
  - non-broker reconnect-before-request-processing creates a new route,
  - broker self-promotion with pending disconnect request creates a new route,
  - explicit disconnect with pending final/turn state cannot leave a reusable old route and records either a terminal final outcome or durable unregister-after-final intent,
  - Telegram `/disconnect` and normal `session_shutdown` still remove the target route and preserve unrelated sessions,
  - automatic reconnect without explicit disconnect still reuses the route,
  - route-scoped stale requests cannot delete newly-created routes.
- Ensure existing final-delivery, route-context, and topic-cleanup checks still pass.
- Run `npm run check` before reporting implementation complete.

## Pre-edit impact preview

Likely blast radius is lifecycle orchestration across broker IPC, pending disconnect request persistence, session registration, route cleanup, and final/turn cleanup. The main risk is overcorrecting route reuse and creating duplicate topics during normal auto-reconnect, or undercorrecting explicit disconnect so a stale route can still be reused. Keep the fix centered on a route-scoped explicit-disconnect intent and shared broker cleanup helpers.

## Decisions

- 2026-04-27: Implemented explicit disconnect as a route-scoped broker intent: disconnect request files now carry route and connection generation identity, broker registration honors any pending route-scoped disconnect before route ensure/reuse, and stale requests only match routes created at or before the request so a later selector/topic route is not deleted. Local /telegram-disconnect now asks the broker to detach the route before discarding local Telegram view state; command status is only hidden after disconnect succeeds.
- 2026-04-27: Follow-up review fixes: stale incoming registrations are now rejected before pending disconnect requests are honored; normal session_shutdown uses an unscoped shutdown request and the preserving shutdownClientRoute path while explicit disconnect uses route-scoped terminal cleanup; broker-owned explicit disconnect no longer drains pending finals before route cleanup; route-scoped cleanup cancels route-bound pending final deliveries by turn id; non-broker explicit disconnect tears down local route state after the durable request is written even if broker IPC fails; route matching includes the original route createdAt timestamp to protect newly-created same-ms selector routes.
- 2026-04-27: Final review fix: non-broker explicit disconnect now treats broker IPC failure after the durable route-scoped request is written as non-fatal for local teardown, so the command can complete locally while broker heartbeat/failover later honors the request. npm run check passed and a gpt-5.5 Explore review reported no findings on the final diff.
