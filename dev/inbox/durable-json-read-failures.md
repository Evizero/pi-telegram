---
title: "Durable JSON boundary failures need safer recovery"
type: "bug"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["harden-durable-json-boundary-recovery"]
---
Code-quality audit finding from 2026-04-28.

`src/shared/utils.ts:22-26` returns `undefined` for every `readJson` failure, including malformed JSON and permission errors. Callers use this helper for config, broker state, leases, handoffs, and pending finals, so corrupt durable state can be silently treated as absent and later overwritten or cleaned up.

Suggested planning direction: return `undefined` only for missing files, surface parse and permission failures, and consider schema validation at durable-state boundaries.



## Investigation update (2026-04-30)

Deep-dive found the original claim is stale: `src/shared/utils.ts` now returns `undefined` only for `ENOENT` and rethrows malformed JSON, permission errors, directories, and other filesystem failures. `scripts/check-durable-json-loading.ts` already covers missing, valid, malformed, and directory cases.

Remaining risk: parseable-but-schema-invalid durable records and per-file maintenance failures can still be skipped, deleted, or block unrelated recovery work. The highest-risk areas are pending client finals (`src/client/final-handoff.ts`), disconnect requests (`src/extension.ts`), session replacement handoffs (`src/client/session-replacement.ts`), and broker lease/state diagnostics. Planning should focus on durable-boundary validation, fail-closed non-destructive handling, path-context diagnostics, and isolating bad per-file records so valid durable work can continue.
