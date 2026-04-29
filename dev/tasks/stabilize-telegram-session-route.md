---
title: "Stabilize Telegram session route liveness"
status: "done"
priority: 1
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: "pi-agent"
labels: ["telegram", "routing", "liveness", "durability"]
traces_to: ["SyRS-cleanup-route-after-reconnect-grace", "SyRS-retry-topic-cleanup", "SyRS-topic-routes-per-session", "SyRS-register-session-route", "SyRS-session-replacement-route-continuity", "SyRS-final-delivery-fifo-retry", "SyRS-durable-update-consumption", "SyRS-cleanup-route-on-close", "SyRS-unregister-session-route"]
source_inbox: "telegram-sessions-disappeared-and"
branch: "task/stabilize-telegram-session-route"
---
## Objective

Prevent connected Telegram session topics/routes from being deleted and recreated empty after transient liveness, broker, Telegram API, or state-read disruptions. A temporary heartbeat gap, sleep/resume, event-loop stall, broker failover, or route setup failure must not make live/reconnecting sessions look like terminally dead sessions.

## Source Context

The user observed that about three connected Telegram sessions disappeared and were recreated empty. The investigation captured in `dev/inbox/telegram-sessions-disappeared-and.md` found a likely chain: client heartbeats can miss the 15s offline window, `markOfflineSessions()` calls `markSessionOfflineInBroker()`, routes are detached unless a pending assistant final already exists, `retryPendingRouteCleanupsInBroker()` deletes the forum topics, and later reconnect/register creates fresh topics.

Internet loss alone should not stop local IPC heartbeats, but it can delay `deleteForumTopic` retries so old topics disappear later when Telegram becomes reachable.

## Scope

- Make offline/session cleanup distinguish a transient reconnectable lapse from a terminal session end strongly enough that sleep/resume, event-loop lag, broker failover, or IPC stalls do not immediately delete topics for sessions that can still reconnect.
- Preserve routes during reconnect grace for sessions with active local work or route-dependent durable state, including active/busy session registrations, pending turns, pending assistant finals, queued controls, replacement handoffs, and recently live client connections where applicable.
- Make pending route cleanup safe: before `deleteForumTopic`, re-check that the cleanup route is not currently active for a live/reconnected session and clear or skip stale cleanup entries instead of deleting active topics.
- Make route replacement/setup transactional enough that old routes are not detached or queued for cleanup until replacement routing is safely established; failed `/topicsetup` or failed topic creation must not leave cleanup entries that later delete restored active routes.
- Harden durable state loading so malformed or unreadable broker/config/lease/final JSON is not silently treated as missing state and overwritten with empty defaults.
- Guard broker-state persistence with current lease owner/epoch where stale broker writes could resurrect old routes, erase newer routes, requeue stale cleanup, or regress update-offset/recent-ID state after failover.
- Add focused regression coverage for the observed multi-session disappearance class and the related state/cleanup hazards.

## Codebase Grounding

Likely touchpoints:

- `src/shared/config.ts` for heartbeat/offline/reconnect timing policy if a distinct post-lag cleanup grace or event-loop lag threshold is needed.
- `src/broker/updates.ts` `markOfflineSessions()` for heartbeat expiry and broker lag handling.
- `src/broker/sessions.ts` `markSessionOfflineInBroker()`, `pendingOfflineSessionState()`, `retryPendingRouteCleanupsInBroker()`, and route detach/cleanup helpers.
- `src/broker/routes.ts` `ensureRouteForSessionInBroker()` for route reuse, route replacement ordering, and cleanup queuing.
- `src/broker/session-registration.ts` for registration/heartbeat interactions with route preservation and replacement handoff.
- `src/client/session-replacement.ts` if replacement handoff consumption needs to clear stale route cleanups.
- `src/shared/utils.ts`, `src/extension.ts`, and client final-handoff/config/lease callers for `readJson()` behavior, durable-state load handling, and stale broker persist guards.
- `scripts/check-session-route-cleanup.ts`, `scripts/check-session-replacement-handoff.ts`, and focused state/config checks for regression coverage.

## Acceptance Criteria

- A simulated multi-session heartbeat lapse or broker timer lag does not immediately delete/recreate routes for still-live or reconnecting sessions; clients that reconnect within the intended grace reuse their existing routes/topics.
- Busy/active sessions and sessions with pending Telegram turns keep route context during reconnect grace even before an assistant final has been handed to the broker.
- `retryPendingRouteCleanupsInBroker()` never deletes a forum topic when the cleanup entry matches a currently active route for a live/reconnected session.
- Failed route replacement or `/topicsetup` leaves previous active routes safe from later cleanup, and any newly-created orphan topics are handled deliberately rather than causing silent empty-topic drift.
- Corrupt or unreadable durable JSON used for broker state/config/lease/final handoff surfaces as an error or safe quarantine path, not as an empty missing state that overwrites sessions/routes.
- Pending assistant finals remain protected while retryable or partially delivered: topic cleanup must either wait for broker final delivery to succeed or reach an explicit terminal outcome, or preserve the route until that lifecycle is deliberately resolved.
- Explicit `/telegram-disconnect`, normal shutdown, true unrecovered death after the bounded grace, and terminal topic cleanup behavior still remove temporary routes/topics as required when no protected pending work/final lifecycle remains.
- Existing Telegram retry-after handling remains intact; retryable Telegram failures delay cleanup instead of falling back to unsafe deletion or route recreation.
- A broker that has lost its lease owner/epoch cannot persist stale broker state over newer session, route, cleanup, pending final, update-offset, or recent-ID state.
- `npm run check` passes with new focused regression scenarios.

## Out of Scope

- Do not build the full durable Telegram outbox in this slice.
- Do not redesign command/callback controls or decompose the command router except where tests require small helpers.
- Do not make Telegram topics durable session history; they remain temporary connection-scoped views.
- Do not weaken explicit disconnect/shutdown cleanup semantics.
- Do not introduce a hosted broker, inbound workstation endpoint, or multi-user access model.

## Validation Plan

Add or extend checks for:

- three sessions with routes experiencing a synthetic heartbeat/timer gap, then reconnecting without topic deletion;
- active/busy session with `activeTurnId` or pending turn losing heartbeat before final handoff;
- stale `pendingRouteCleanups` entry matching an active route;
- failed `createForumTopic` during route replacement preserving old route state;
- failed `/topicsetup` after partial route creation restoring routes and cleanup state safely;
- malformed broker state JSON not loading as empty state;
- malformed config, lease, disconnect/replacement request, and client pending-final JSON following explicit missing-file-vs-corrupt-file semantics instead of being silently treated as absent;
- stale broker persist attempts after lease loss being rejected or no-op before they can overwrite newer sessions/routes/update offsets;
- pending assistant final route cleanup waiting for delivery success or terminal final outcome;
- replacement handoff retargeting or route reuse clearing any stale cleanup for the preserved route;
- existing explicit disconnect, shutdown, retry-after cleanup, and session replacement tests still passing.

Run `npm run check` before completion.

## Planning Notes

This task intentionally combines the liveness, stale cleanup, transactional route replacement, and durable JSON read hardening because each can produce the same user-visible failure: all routes disappear and reconnect creates empty topics. Keep commits internally coherent during implementation if the code naturally splits into liveness, cleanup safety, and state-load hardening slices.

Update `dev/ARCHITECTURE.md` only if implementation introduces a new persistent liveness/cleanup state model or changes the broker state ownership contract beyond the existing bounded reconnect grace.

## Decisions

- 2026-04-29: Implemented a two-stage heartbeat loss model: heartbeat-stale sessions are marked offline and given a persisted reconnect-grace start, while route/topic cleanup is deferred until the bounded reconnect grace expires; successful registration/heartbeat clears the grace marker.
- 2026-04-29: Made route cleanup and route replacement fail-safe: stale pending cleanup entries matching active routes are cleared without deleteForumTopic, replacement routes are created before old routes are queued for cleanup, failed /topicsetup restores routes/cleanup state and queues any newly-created orphan topics for cleanup, and replacement handoff clears stale cleanup for preserved routes.
- 2026-04-29: Hardened durable JSON and broker persistence: readJson now treats only ENOENT as missing, malformed/unreadable JSON surfaces to callers, and broker state writes re-check the current lease owner/epoch immediately before writing.
- 2026-04-29: Review found stale brokers could still perform deleteForumTopic before the persist fence ran; route cleanup now fences immediately before Telegram topic deletion and broker heartbeat follow-up work stops if lease renewal left the broker inactive.
- 2026-04-29: Second review found route cleanup needed a post-await active-route recheck and stale local brokers could miss durable disconnect handoff; cleanup now revalidates the pending entry and active route immediately before deleteForumTopic, and disconnect routing treats only lease-active brokers as local brokers.
