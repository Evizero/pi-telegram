---
title: "Assess and restore top-level codebase coherence"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: run a whole-codebase architecture/coherence assessment rather than another localized bug hunt. Look for broad patterns: modules with overlapping responsibilities, duplicated control flows, diverging conventions, and places where new features are being duct-taped onto older paths.

Refreshed evidence on 2026-04-30 after the first simplification slices:
- `src/extension.ts` is down to 869 lines and is back under the 1,000-line guard rail, but it remains the cross-boundary composition root for broker/client/session/turn/finalization wiring.
- `src/broker/commands.ts` is down to 343 lines and now delegates model, Git, queued-control, and inline-control behavior to focused modules.
- `src/shared/types.ts` is still a broad 464-line cross-domain type bucket.
- The main remaining coherence pressure is no longer command-dispatch size; it is the client-side turn/final/handoff lifecycle spread across `src/client/runtime-host.ts`, `src/client/runtime.ts`, `src/client/turn-delivery.ts`, `src/client/manual-compaction.ts`, `src/client/retry-aware-finalization.ts`, `src/client/final-handoff.ts`, route shutdown, stale-client stand-down, and pi event hooks.

Desired outcome: an explicit cleanup direction that makes future features fit a coherent shape instead of adding more parallel machinery.



## Cluster note: simplification pass (2026-04-28; refreshed 2026-04-30)

Related cleanup cluster:
- Runtime hosts: decompose extension orchestration. This is partly improved by earlier client runtime-host extraction; remaining work should avoid creating a second hidden god object.
- Client lifecycle: make turn/final/handoff states explicit. This is the best next big refactor because the behavior is implemented but difficult to reason about globally.
- Telegram policy: centralize message operations and durable side-effect retries. This is still valuable, but should follow lifecycle cleanup unless a retry bug forces it first.
- Controls/routing: unify inline controls and route ownership helpers. This is largely improved by the focused command/control modules now present under `src/broker/`.
- Shared/test hygiene: split bounded-context types/constants and reusable validation fixtures. This should follow once lifecycle ownership seams are clearer.

Intent: prioritize simplifications that remove parallel mechanisms without dropping behavior. Next planned slice: turn `create-shared-lifecycle-state` into a ready task for a named client lifecycle/turn queue API that preserves current Telegram behavior while reducing scattered flags and queue manipulation.
