---
title: "Reduce duplicated test discovery and weak test typing"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`commonjs scripts/run-activity-check.mjs` manually lists every check script while `tsconfig.activity-check.json` also has to include the same files. Several checks use `as any` / `as never` fixtures, and production code also has small `any` leaks in `src/client/info.ts:76` and `src/shared/ui-status.ts:4`.

Suggested planning direction: use one test manifest or auto-discover `scripts/check-*.ts`, extract typed test harness helpers, and derive production callback/theme types from the pi extension API types.
