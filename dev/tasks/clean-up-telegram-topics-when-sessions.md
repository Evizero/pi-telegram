---
title: "Clean up Telegram topics when sessions close or die"
status: "done"
priority: 1
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "lifecycle", "topics"]
traces_to: ["SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace", "SyRS-retry-topic-cleanup", "SyRS-unregister-session-route"]
source_inbox: "telegram-topics-not-cleaned"
branch: "task/clean-up-telegram-topics-when-sessions"
---
## Objective

Make Telegram routes/topics connection-scoped. A connected pi session should lose its Telegram topic/route when it explicitly disconnects, closes normally, crashes/dies, or fails to reconnect within the built-in automatic reconnect grace period. Native pi session history remains local; if the user later starts pi with `/resume`, `/telegram-connect` can create a fresh Telegram view.

## Planning context

This task replaces the old `SyRS-offline-without-deleting-state` direction, which is now deprecated. The governing source is captured in `dev/references/telegram-views-are-connection-scoped.md`, and the bug/source notes are in `dev/inbox/telegram-topics-not-cleaned.md`.

Preserve the useful part of delivery continuity: retryable Telegram delivery, broker takeover, and temporary network/IPC trouble must not lose work for sessions that are still connected or reconnect inside the grace window. Do not preserve Telegram topics indefinitely for closed or dead sessions.

## Codebase grounding

Likely touchpoints:

- `src/pi/hooks.ts`: change `session_shutdown` from offline preservation to route cleanup/unregister semantics for a normal process close.
- `src/broker/sessions.ts`: separate immediate unregister/cleanup from grace-period liveness, and make topic deletion retry-safe instead of swallowing `deleteForumTopic` failures while deleting route state.
- `src/broker/updates.ts`: replace stale-heartbeat "mark offline forever" behavior with bounded reconnect grace and cleanup after expiry.
- `src/extension.ts`: broker IPC handlers, registration/heartbeat behavior, route reuse during grace, and any cleanup retry loop/kick points.
- `src/shared/types.ts` / `src/shared/config.ts`: add durable cleanup/grace state or constants if needed.
- `src/broker/commands.ts`: keep Telegram `/disconnect` cleanup behavior aligned with the same unregister path.
- `docs.md`, `dev/ARCHITECTURE.md`, `AGENTS.md`, and README if implementation details or user-facing behavior need final wording after code changes.

## Acceptance criteria

- `/telegram-disconnect` and Telegram `/disconnect` unregister only the selected session and remove/delete its route/topic without disrupting unrelated sessions.
- A normal pi `session_shutdown` for a connected session triggers the same cleanup intent rather than preserving the topic as an offline route.
- A crash/death or heartbeat/IPC loss preserves the route only during a bounded automatic reconnect grace period; reconnect before expiry reuses the existing route, while no reconnect by expiry cleans up the route/topic.
- `deleteForumTopic` cleanup handles Telegram `retry_after` and transient failures as retryable pending cleanup; route state is not dropped in a way that silently orphans topics.
- Already-deleted/not-found topics are treated idempotently; permission/auth terminal failures are surfaced or recorded without blocking unrelated session cleanup.
- Later native `/resume` plus `/telegram-connect` after cleanup creates a fresh Telegram route/topic over the local session history.
- Busy-turn steering, `/follow`, final FIFO retry, media group retry behavior, and topic `message_thread_id` preservation do not regress.

## Out of scope

- Do not implement a Telegram-side durable history model.
- Do not add a hosted broker, external daemon, webhook endpoint, or multi-user route ownership.
- Do not revive Telegram-triggered `/reload`; reconnect/resume should use native pi behavior plus explicit Telegram connection.

## Validation

Add focused regression coverage or executable checks for close cleanup, reconnect-within-grace reuse, cleanup-after-grace expiry, retryable `deleteForumTopic` failure, and idempotent already-deleted cleanup. Run `npm run check` before close-out.

## Decisions

- 2026-04-25: Planning review on 2026-04-25 reported no findings: requirements, architecture/docs guidance, and ready task align with the project-owner directive for connection-scoped Telegram views and bounded reconnect grace.
- 2026-04-25: Implementation uses durable pendingRouteCleanups in broker state so active routes disappear immediately on disconnect/death, retryable deleteForumTopic failures remain queued for broker-heartbeat retry, and the reconnect grace window remains the existing heartbeat timeout boundary before stale sessions are unregistered.
- 2026-04-25: Disconnecting Telegram now detaches only the Telegram view state: queued Telegram turns and pending Telegram-only final retries are cleared, but the underlying local pi run is not aborted solely because the Telegram route is being cleaned up.
- 2026-04-25: 2026-04-25 close-out: npm run check passed and the latest focused review reported no findings for the implemented topic-cleanup behavior; remaining dirty compaction planning files are unrelated and excluded from this close-out.
