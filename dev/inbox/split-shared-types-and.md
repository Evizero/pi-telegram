---
title: "Split shared types and constants by bounded context"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: `src/shared/types.ts` mixes Telegram DTOs, broker durable state, client IPC contracts, model picker state, Git controls, and runtime turn types. `src/shared/config.ts` similarly centralizes many unrelated timing and size constants, and some features reuse constants from unrelated domains.

Concern: broad shared buckets make it easy for layers to depend on each other accidentally and hard to see which concepts belong together.

Desired cleanup direction: split shared definitions by context, for example Telegram API DTOs, broker state, IPC contracts, turn/final lifecycle, command-control state, and configuration policy. Give constants semantic homes instead of using a single global bag.



## Simplification pass note (2026-04-28)

Related simplification: after runtime/control boundaries are clearer, split shared types and constants by bounded context rather than by convenience. This should reduce accidental imports and make policy constants live next to the behavior they govern.



## Deep-dive update (2026-04-30)

Mostly still current. Some small extractions now exist, such as centralized Telegram error helpers under `src/telegram/errors.ts`, but the broad concern remains: `src/shared/types.ts` still mixes Telegram DTOs, broker durable state, IPC contracts, model picker/Git control state, session state, turn/final lifecycle, and outbox jobs. `src/shared/config.ts` still mixes paths, Telegram limits, broker/session timing, model/control TTLs, temp cleanup, update limits, and prompt text. Treat this as a larger bounded-context refactor, not a quick mechanical split.
