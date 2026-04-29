---
title: "Centralize route ownership retargeting and cleanup helpers"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["centralize-route-ownership-helpers-and"]
---
Source: simplification pass after Telegram voice note on 2026-04-28 asking to simplify without losing features or behaviors.

Capture: route ownership logic appears in several domains: queueing route cleanup, matching turns/controls to routes, resolving current routes for pending work, retargeting after session replacement, and constructing selector/topic route keys.

Potential simplification: add a `routing`/`route-index` module with helpers such as `turnBelongsToRoute`, `controlBelongsToRoute`, `resolveCurrentRouteForTurn`, `retargetTurnToRoute`, `queueRouteCleanup`, and canonical route-key construction.

Behaviors to preserve: pending turns/finals retarget correctly after session replacement or route recreation; old forum topics are cleaned up only when safe; selector and forum-topic routing stay distinct; preview cleanup preserves retryable failures.
