---
title: "Route reuse should respect current Telegram routing config"
type: "bug"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`src/broker/routes.ts:34-38` reuses an existing route mainly because the chat id matches. If Telegram routing config changes from topic routing to selector routing, or to disabled, stale routes can remain active and continue receiving Telegram traffic.

Suggested planning direction: compute the expected route mode before reuse, reject disabled routing before reuse, and only reuse routes whose chat id, message thread id, and route mode match current config.
