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
