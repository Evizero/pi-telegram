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
