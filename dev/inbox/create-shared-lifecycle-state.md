---
title: "Create shared lifecycle state-machine conventions for turns finals and handoff"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: turn delivery, queued follow-ups, active-turn finalization, retry-aware finalization, pending finals, assistant final handoff, session replacement, disconnect, and broker failover all interact. Much of the logic is split across `src/extension.ts`, `src/client/*`, `src/broker/finals.ts`, `src/broker/sessions.ts`, and related checks.

Concern: each feature has been made correct locally, but the global lifecycle model is hard to see. That raises the risk that future fixes introduce another parallel path or miss one retry/failover edge.

Desired cleanup direction: document and encode explicit state-machine boundaries for Telegram turns, assistant finals, queued follow-ups, route disconnect, and session replacement handoff. Prefer named transitions over scattered flags and callback bags.



## Simplification pass note (2026-04-28)

Potential simplification: replace parallel flags/queues (`queuedTelegramTurns`, `activeTelegramTurn`, `awaitingTelegramFinalTurnId`, manual compaction deferred turns, retry/deferred final state, abort state) with one `ClientTurnLifecycle`/`TurnQueue` API. Preserve FIFO, busy-session follow-up queueing, `/follow`, valid `/steer`, queued cancel, manual compaction deferral/drain, retry-safe final handoff, and mid-turn Telegram connection mirroring.
