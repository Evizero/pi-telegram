---
title: "Split semantic TTL constants for model cache selectors and Git controls"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`MODEL_LIST_TTL_MS` is reused for model cache lifetime, single-chat selector lifetime, model picker expiration, and Git control expiration (`src/broker/commands.ts:928`, `src/broker/git-controls.ts:1,30`). Changing model-cache behavior would unintentionally change unrelated Telegram control lifetimes.

Suggested planning direction: introduce semantic constants such as `MODEL_CACHE_TTL_MS`, `SELECTOR_SELECTION_TTL_MS`, `MODEL_PICKER_TTL_MS`, and `GIT_CONTROL_TTL_MS`.



## Deep-dive update (2026-04-30)

Still current. `src/shared/config.ts` still defines only `MODEL_LIST_TTL_MS`, and it is reused for model-list cache expiry in `src/broker/model-command.ts`, selector selection expiry in `src/broker/commands.ts`, model picker expiry in `src/broker/model-picker.ts`, and Git control expiry in `src/broker/git-controls.ts`. The stale part is only the exact line numbers in the original note; the coupling itself remains.
