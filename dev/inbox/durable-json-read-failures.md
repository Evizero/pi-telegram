---
title: "Durable JSON read failures are treated as missing state"
type: "bug"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`src/shared/utils.ts:22-26` returns `undefined` for every `readJson` failure, including malformed JSON and permission errors. Callers use this helper for config, broker state, leases, handoffs, and pending finals, so corrupt durable state can be silently treated as absent and later overwritten or cleaned up.

Suggested planning direction: return `undefined` only for missing files, surface parse and permission failures, and consider schema validation at durable-state boundaries.
