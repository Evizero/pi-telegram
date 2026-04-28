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

Current evidence from the audit pass:
- `src/extension.ts` is 1156 lines and imports about 40 modules while owning broker/client/session/turn/finalization state.
- `src/broker/commands.ts` is 1005 lines and mixes several command and callback-control families.
- `src/shared/types.ts` is a broad 461-line cross-domain type bucket.

Desired outcome: an explicit cleanup direction that makes future features fit a coherent shape instead of adding more parallel machinery.



## Cluster note: simplification pass (2026-04-28)

Related cleanup cluster:
- Runtime hosts: decompose extension orchestration.
- Client lifecycle: make turn/final/handoff states explicit.
- Telegram policy: centralize message operations and durable side-effect retries.
- Controls/routing: unify inline controls and route ownership helpers.
- Shared/test hygiene: split bounded-context types/constants and reusable validation fixtures.

Intent: prioritize simplifications that remove parallel mechanisms without dropping behavior.
