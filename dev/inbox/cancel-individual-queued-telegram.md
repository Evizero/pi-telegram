---
title: "Cancel individual queued Telegram follow-ups"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
User asked whether a queued follow-up can be cancelled individually. Current implementation only offers `Steer now` for eligible queued follow-ups; `/stop` can clear queued work broadly but is not a precise cancel-this-follow-up control.

Capture request: add a per-follow-up cancel affordance, likely a Telegram inline `Cancel` button on the queued-status message and/or a text command for accessibility. Planning should decide semantics for attachments/media groups, stale/already-started turns, broker failover, duplicate callbacks, route/session scoping, and interaction with `/stop`, manual compaction, and queued-turn steer controls.

Important boundary: cancelling one follow-up should not stop the active turn or discard unrelated queued follow-ups.
