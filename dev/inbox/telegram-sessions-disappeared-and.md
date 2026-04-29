---
title: "Telegram sessions disappeared and were recreated empty"
type: "bug"
created: "2026-04-29"
author: "Christof Stocker"
status: "planned"
planned_as: ["stabilize-telegram-session-route"]
---
User reported from Telegram: "i just had a bug where out of nowhere sessions in telegram (like 3 connected) deleted and recreated empty. deep dive how that could happen. maybe if inet cant be reached or something? process busy and timeout? we need to find the instability"

Initial hypotheses to investigate: broker/session liveness timeout during busy work or network outage; route cleanup after reconnect grace; topic deletion/recreation path; session replacement handoff not preserving routes; route reuse/config mismatch; broker failover/state read/write instability.

## Deep-dive findings 2026-04-29

Most likely confirmed chain: clients heartbeat every 3s and broker marks sessions offline after 15s (`src/shared/config.ts`). `markOfflineSessions()` in `src/broker/updates.ts` expires sessions by wall-clock `lastHeartbeatMs`. `markSessionOfflineInBroker()` deletes the session and, unless a pending assistant final already exists, detaches routes and queues topic cleanup. `retryPendingRouteCleanupsInBroker()` later calls `deleteForumTopic`. When the still-running client reconnects/registers, no route remains and `ensureRouteForSessionInBroker()` creates a new topic. This can affect multiple sessions at once after sleep/resume, event-loop stall, broker failover, or IPC timeout.

Important detail: active/busy sessions are not enough to preserve routes. Offline cleanup checks pending turns but only preserves routes when `hasPendingAssistantFinals` is true; a live busy turn before final handoff can lose its Telegram topic.

Internet outage alone should not stop local IPC heartbeats, but it can amplify the symptom: cleanup may be queued while offline and execute later when Telegram is reachable, making deletion appear out of nowhere.

Other plausible instability paths:
- `readJson()` in `src/shared/utils.ts` catches all errors. Corrupt/unreadable broker state can load as empty state, causing all sessions/routes to disappear and be recreated.
- Broker lease is 10s and persist writes are not epoch-fenced; an old broker resuming after lease loss may be able to write stale state over a newer broker.
- `retryPendingRouteCleanupsInBroker()` does not verify that a cleanup entry no longer matches an active route before deleting the topic.
- `/topicsetup` rollback snapshots routes but not pending cleanup state; a failed partial setup can restore old routes while leaving cleanup entries that later delete them.
- `ensureRouteForSessionInBroker()` removes old routes before replacement topic creation is fully successful; failed/rate-limited creation can leave the old route queued for cleanup.
- Existing route selection uses first route for a session, which can pick stale selector/forum routes when multiple route records exist.

Potential fixes/tests: longer/safer reconnect grace with event-loop-lag/suspend detection; preserve routes for busy/active/pending-turn sessions; validate pending cleanup against current active routes before deletion; make route replacement transactional; make `readJson()` surface non-ENOENT failures; add broker epoch guard before persisting; add regression tests for multi-session heartbeat lapse, active busy offline preservation, stale cleanup against active route, failed topicsetup rollback, corrupt state load, and stale broker writes.
