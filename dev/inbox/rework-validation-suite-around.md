---
title: "Rework validation suite around reusable fixtures and behavior domains"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: the validation suite has very large script files (`check-telegram-command-routing.ts` at 1337 lines, `check-session-route-cleanup.ts` at 1140 lines) plus manual check discovery in `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json`.

Concern: tests mirror the same accretion pattern as runtime code. Big scenario scripts make it difficult to identify conventions, reuse setup, or add coverage without copying fixtures and casts.

Desired cleanup direction: split tests by behavior domain, extract typed broker/client/Telegram fixtures, and use a single manifest or auto-discovery path so compiled checks and executed checks cannot diverge.



## Simplification pass note (2026-04-28)

Related simplification: tests should mirror the future bounded contexts rather than the current sprawl. Extract typed fixtures for broker/client/Telegram behaviors and use one manifest or auto-discovery so compiled checks and executed checks cannot diverge.
