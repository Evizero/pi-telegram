---
title: "Extract bounded recent-id utilities"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Source: simplification pass after Telegram voice note on 2026-04-28 asking to simplify without losing features or behaviors.

Capture: bounded dedupe/idempotency structures recur for completed turn ids, disconnected turn ids, activity closed ids, broker completed ids, and recent Telegram update ids.

Potential simplification: add a small `BoundedRecentSet` / `rememberBoundedId` utility usable for both in-memory sets and persisted arrays.

Behaviors to preserve: duplicate updates/turns/finals remain idempotent; memory and state files stay bounded; existing limits such as 1000 recent ids remain visible policy decisions.



## Deep-dive update (2026-04-30)

Still current. Repeated bounded recent-id logic remains in `src/broker/updates.ts` for `recentUpdateIds`, `src/broker/sessions.ts`, `src/broker/queued-turn-control-handler.ts`, and `src/extension.ts` for `completedTurnIds`, `src/broker/activity.ts` for closed turn/activity IDs, and `src/client/turn-lifecycle.ts` for completed/disconnected/manual-compaction operation IDs. Several paths still hardcode `1000` or duplicate array/set trimming, so a small bounded recent-id helper plus explicit limit constants remains a valid cleanup.
