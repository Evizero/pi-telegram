---
title: "Decompose extension runtime orchestration into bounded coordinators"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["extract-client-runtime-host-from"]
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: `src/extension.ts` appears to be the main gravitational center of the codebase. It wires pi hooks, broker leadership, client IPC, session registration, turn queues, finals, previews, typing, compaction, disconnects, handoff, and status updates in one closure with many mutable variables.

Concern: this can make behavior hard to reason about across files because state transitions are physically separated from the concepts they belong to, while new modules still need callbacks back into the giant extension closure.

Desired cleanup direction: identify bounded coordinators or state owners for broker lifecycle, client lifecycle, turn/final lifecycle, Telegram IO, and session replacement, then shrink the extension entrypoint to composition.



## Simplification pass note (2026-04-28)

High-leverage shape: extract `BrokerRuntimeHost` and `ClientRuntimeHost` from `src/extension.ts`, then keep `registerTelegramExtension()` mostly as composition. Preserve broker lease exclusivity, client reconnect/fallback, stale session handling, broker heartbeat duties, pending final retry, disconnect processing, offline marking, queued-control cleanup, route cleanup, temp cleanup, and status UI.
