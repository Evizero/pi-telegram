---
title: "Clean up pi hook boundaries and dependency bag"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`src/pi/hooks.ts:8` imports broker activity formatting directly, and `RuntimePiHooksDeps` is a large cross-cutting dependency bag. This makes the pi layer aware of broker implementation details and pushes tests toward broad casts and oversized fixtures.

Suggested planning direction: move activity formatting/reporting contracts to `shared`, and split runtime hook registration by concern: commands, lifecycle, activity mirroring, attachment tool, and finalization.
