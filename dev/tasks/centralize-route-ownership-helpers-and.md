---
title: "Centralize route ownership helpers and fix route reuse"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["refactor", "routing", "telegram", "reliability"]
traces_to: ["SyRS-register-session-route", "SyRS-topic-routes-per-session", "SyRS-session-replacement-route-continuity", "SyRS-cleanup-route-on-close", "SyRS-cleanup-route-after-reconnect-grace", "SyRS-retry-topic-cleanup", "SyRS-selector-selection-durability", "SyRS-queued-followup-steer-control", "SyRS-cancel-queued-followup", "SyRS-queued-control-finalization", "SyRS-runtime-validation-check"]
source_inbox: "centralize-route-ownership-retargeting"
branch: "task/centralize-route-ownership-helpers-and"
---
## Objective

Centralize Telegram route ownership helpers and fix stale route reuse when Telegram routing configuration changes. The implementation should make route identity, route reuse eligibility, route-key construction, turn/control route matching, pending-work retargeting, and cleanup queueing easier to audit without changing user-visible routing semantics.

This task combines the broad cleanup request from `centralize-route-ownership-retargeting` with the concrete bug captured in `route-reuse-should-respect`. The primary `source_inbox` metadata points at the accepted cleanup request; the bug inbox item is a secondary source and has been marked planned with an explicit backlink to this task because the current PLN task metadata has one primary source-inbox field.

The concrete bug: an existing route must not remain active merely because its chat ID matches when the current config now expects selector routing, forum-topic routing, private-topic routing, or disabled routing.

## Scope

Implement a focused route ownership seam, likely in `src/broker/routes.ts` or a sibling broker routing module, that owns reusable helpers for:

- computing the expected route target and route mode from `TelegramConfig` plus an optional selector chat;
- determining whether an existing route is reusable under the current routing config;
- rejecting disabled routing before reusing an old route;
- building canonical route keys for topic routes and selector routes;
- queueing route/topic cleanup and removing cleanup records when a route becomes active again;
- matching pending turns and assistant finals to a route;
- retargeting pending turns, assistant finals, selector selections, and cleanup records during successful session replacement handoff;
- exposing one route/control matching helper for queued-control cleanup and callback validation when that avoids duplicate route-comparison rules.

The route reuse bug is in scope. `ensureRouteForSessionInBroker()` should only reuse a route when the route's chat ID, `message_thread_id`, and route mode match the current expected routing shape. Configured disabled routing should fail before reuse rather than preserving an old active route.

## Codebase grounding

Likely touchpoints:

- `src/broker/routes.ts` — route mode/target computation, route reuse eligibility, route-key construction, cleanup queue helpers, and maybe turn-to-route helpers.
- `src/broker/sessions.ts` — currently has its own `queueRouteCleanup`, `turnBelongsToRoute`, route cleanup active-route checks, and route detach/matching helpers; migrate to shared route helpers where behavior stays equivalent.
- `src/client/session-replacement.ts` — currently retargets routes, pending turns, assistant finals, selector selections, and cleanup records locally; reuse route retargeting/key/cleanup helpers where possible.
- `src/broker/queued-controls.ts` and `src/broker/queued-turn-control-handler.ts` — use shared route/control matching only if it reduces duplication without weakening callback fail-closed behavior.
- `src/shared/types.ts` — add clarifying type comments only if needed; avoid broad type splitting in this slice.
- `scripts/check-session-route-registration.ts`, `scripts/check-session-replacement-handoff.ts`, `scripts/check-session-unregister-cleanup.ts`, `scripts/check-session-disconnect-requests.ts`, and `scripts/check-telegram-command-routing.ts` — extend focused coverage around route reuse, cleanup, retargeting, and control route matching.

## Preserved behavior

- Reconnect within the bounded grace period still reuses the same valid route/topic when the current routing config still expects that route shape.
- If creating the newly expected route fails, the existing active route and cleanup state remain unchanged and the error is surfaced; route replacement must not strand the session without its previous valid route.
- Session replacement handoff still retargets Telegram reachability to the replacement session and clears stale cleanup for the carried-forward route.
- Explicit disconnect, terminal shutdown, and reconnect-grace expiry still unregister only the target session and queue/delete only its route/topic.
- Old forum topics are cleaned up only when safe; active routes must not be deleted because a cleanup record still exists.
- Pending turns, pending assistant finals, visible preview references, queued-turn controls, and selector selections must not be silently orphaned or cross-routed.
- Selector routing and topic routing remain distinct. Selector routes should not be treated as forum/private topics, and topic routes should not be reused as selector routes.
- `message_thread_id` continues to be preserved for topic-routed replies, previews, uploads, final delivery, queued-control visible finalization, and typing actions.
- Telegram `retry_after` and retryable topic-cleanup failures remain retry-significant and must not be hidden by helper extraction.
- No new Telegram commands, callback token formats, broker daemon, hosted relay, or user-visible routing mode are introduced.

## Acceptance Criteria

- Route reuse policy is centralized and tested: a route is reused only when current config expects the same route mode, chat ID, and thread shape; disabled routing rejects reuse.
- Existing valid reconnect/re-registration still reuses the old route without creating duplicate topics.
- Failed creation of a replacement route leaves the old route active, queues no cleanup for it, and surfaces the route-creation error.
- Config changes from topic routing to selector routing, selector routing to topic routing, different target chat, or disabled routing do not leave stale routes active; old topic routes are queued for cleanup where appropriate.
- Route cleanup queueing/removal and active-route cleanup protection are implemented through one helper boundary rather than duplicated local comparisons.
- Pending turns and pending assistant finals use shared route matching for cleanup/removal where possible, and successful session replacement retargets route-bound work without changing unrelated sessions or selector choices.
- Queued-control route matching either uses the shared helper or remains explicitly documented as a compatible specialization; wrong-route/stale callbacks still fail closed.
- Focused checks cover route reuse under changed config, disabled routing, valid reconnect reuse, route cleanup safety, and session replacement retargeting.
- No TypeScript source file under `src/` exceeds the 1,000-line guardrail.

## Out of Scope

- Do not build the broader durable Telegram side-effect outbox in this task.
- Do not redesign client turn lifecycle, final-handoff ownership, broker election, polling, update-offset durability, or assistant-final delivery ledgers.
- Do not split all of `src/shared/types.ts` or reorganize all shared constants in this slice.
- Do not change Telegram command semantics, callback token formats, topic naming policy, selector selection expiry, or attachment behavior.
- Do not weaken route cleanup retry, queued-control finalization, or final-delivery FIFO behavior.

## Validation

Run before reporting completion:

```bash
npm run check
pln hygiene
git diff --check
```

Add or extend focused checks to prove at least:

1. valid reconnect with unchanged forum/topic config reuses the existing topic route;
2. changing routing config from topic mode to selector mode does not reuse the old topic route;
3. changing from selector mode to topic mode does not reuse the old selector route;
4. disabled routing rejects before old-route reuse;
5. changing target chat queues cleanup for the old topic route and creates or selects the new expected route;
6. failed creation of a replacement route preserves the old route and does not queue cleanup for it;
7. session replacement retargets pending turns/finals and removes cleanup for the carried-forward route while leaving unrelated routes alone;
8. route cleanup skips a route that became active again and preserves retryable cleanup failures.

## Pre-edit impact preview

Expected blast radius is medium but bounded: route helper extraction plus targeted migrations in broker session cleanup, session replacement handoff, and route registration tests. Main risks are accidentally deleting active topics, reusing stale routes after config changes, breaking selector-mode route selection, or changing queued-control callback authority. Keep the first slice behavior-preserving except for the explicit stale-route-reuse bug fix.

## Decisions

- 2026-04-30: Implemented route identity as an explicit expected-target policy: existing routes are reused only when the current config expects the same route mode and chat/thread shape; disabled routing detaches any existing session routes and queues topic cleanup before rejecting; route-creation failures still preserve the previous route because replacement happens only after the new route is created successfully.
- 2026-04-30: Added shared route-bound helpers in src/shared/routing.ts for canonical selector/topic keys, topic cleanup identity, turn/control route matching, and turn retargeting. Broker route cleanup/reuse code uses broker-owned helpers around those primitives; client session-replacement keeps broker-state handoff local to avoid a client-to-broker dependency while sharing the route identity primitives.
- 2026-04-30: Review found two disabled-routing gaps. Fixed them by making /use respect current Telegram routing config before creating selector selections/routes and by having broker session registration persist disabled-route detach/cleanup state before surfacing the disabled-routing error, while still keeping route-creation failures non-mutating.
- 2026-04-30: Second review found disabled ensure-after-pairing only cleaned the first session. Fixed ensureRoutesAfterPairing to continue disabled-route detach/cleanup across every registered session before surfacing the disabled-routing error, with multi-session regression coverage.
- 2026-04-30: Final review found reusable expected routes and /use selector materialization could leave stale sibling routes for the same session. Fixed both paths to use replaceRoutesForSession so a valid reused/selected route becomes the single active route for that session and stale topic siblings are queued for cleanup, with regression checks for ensureRoute reuse and /use.
- 2026-04-30: Review found auto-mode topic creation failures could still fall back to selector and replace an existing route. Fixed auto fallback to rethrow retry_after errors and any topic creation failure when an existing route would otherwise be replaced, preserving old route/cleanup state; kept fallback only for new routes without existing route state.
- 2026-04-30: Review found auto fallback ignored fallbackMode=disabled. Fixed auto route creation so disabled fallback rethrows the topic creation error instead of creating a selector route, with regression coverage for auto plus disabled fallback.
- 2026-04-30: Review found session replacement retargeted pending turns/finals but left queued-turn controls bound to the old session. Fixed handoff retargeting to update queued controls to the replacement session and carried-forward route, with regression coverage in session replacement handoff checks.
- 2026-04-30: Validation exposed a timing-sensitive disconnect-request behavior check where requestedAtMs could precede connectionStartedAtMs by a millisecond. Stabilized the check by anchoring the request after the synthetic connection start; runtime code was unchanged for that flake.
- 2026-04-30: Final review found auto selector fallback reuse should happen before retrying topic creation to avoid heartbeat retry_after failures for already-fallback selector sessions. Fixed auto mode to reuse a matching selector fallback route before createForumTopic, while still attempting topic creation for new routes without fallback state.
