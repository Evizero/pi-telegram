---
title: "Unify Telegram command and callback control architecture"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: Telegram command/control behavior has grown by feature: session selection, model picker, queued-turn controls, Git controls, stop/steer/follow/disconnect/status/help, and callback finalization each carry their own local patterns.

Concern: the code risks drifting into multiple subtly different control systems with different TTLs, route matching, retry behavior, finalization semantics, and text-edit behavior.

Desired cleanup direction: define a common command/control architecture: command registry, route requirements, callback token ownership, expiration policy, retry/finalization policy, and shared menu/edit/send behavior. Then migrate individual controls to that shape.



## Simplification pass note (2026-04-28)

Potential simplification: introduce a shared inline-control abstraction for tokenized callback state, route/session validation, TTL pruning, callback answering, and edit/finalization behavior. Model picker, Git controls, and queued-turn controls share the same skeleton, with queued-turn controls remaining the stricter authority-bearing specialization.
