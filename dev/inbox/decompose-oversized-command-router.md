---
title: "Decompose oversized command router and large check scripts"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`src/broker/commands.ts` is 1005 lines and mixes route lookup, command parsing, IPC calls, model pickers, Git controls, queued-turn controls, pruning, and help text. `scripts/check-telegram-command-routing.ts` and `scripts/check-session-route-cleanup.ts` also exceed the project guidance that TypeScript source files stay under 1000 lines.

Suggested planning direction: split the command router into a thin dispatcher plus focused command/control modules, and split large check scripts by behavior area with shared fixtures.
