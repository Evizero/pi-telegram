---
title: "Split shared runtime types and config by bounded context"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: "agent"
labels: ["refactor", "architecture", "shared"]
traces_to: ["SyRS-shared-boundary-ownership", "SyRS-runtime-validation-check", "SyRS-lazy-inactive-runtime", "SyRS-durable-json-invalid-state", "SyRS-telegram-text-method-contracts"]
source_inbox: "split-shared-types-and"
branch: "task/split-shared-runtime-types-config"
---
## Objective

Refactor the broad shared TypeScript surfaces into bounded owner modules so future maintainers can tell where runtime data models and configuration policy belong.

This is primarily a maintainability and architecture-boundary slice. It should not change Telegram, broker, client, pi, IPC, or durable-state behavior.

## Scope

Create a conservative first bounded-context split for the current `src/shared/types.ts` and `src/shared/config.ts` pressure points:

- Move or group Telegram Bot API DTOs and Telegram-specific send/edit result types under an owner such as `src/telegram/types.ts` or a nearby Telegram module.
- Move or group broker durable-state records under an owner such as `src/broker/state-types.ts`, while preserving the JSON schema shape and validation performed by the runtime composition/state-loading code.
- Move or group local IPC envelope/request/response and client IPC contract types near `src/shared/ipc.ts` or a dedicated IPC contract module.
- Move or group client turn/final lifecycle records near `src/client/` ownership where that does not create dependency cycles.
- Move or group command/control state records for model picker, Git controls, queued controls, and control-result delivery progress near the broker command/control modules.
- Split configuration constants into semantic policy surfaces where practical: paths/scope, Telegram limits, broker/session timing, model/control TTLs, temp-retention policy, and prompt suffix. Values should remain unchanged unless a separately traced requirement/task explicitly changes policy.

The slice may keep compatibility re-exports from `src/shared/types.ts` and/or `src/shared/config.ts` if that makes migration safer, but those re-exports should be documented as transitional and should not become the destination for new concepts.

## Preserved behavior

- No Bot API behavior changes: polling, retry_after propagation, topic/thread preservation, message chunk limits, file limits, draft eligibility, upload fallback, and media-group behavior stay the same.
- No local-first authority changes: Telegram remains a control surface and pi remains execution authority.
- No durable JSON shape changes unless compatibility handling is explicit and covered by validation; existing broker/config/lease/pending-final/session-replacement artifacts must continue to load.
- No pi-visible command/tool/prompt surface changes, especially `telegram_attach` availability and lazy inactive startup behavior.
- No hidden TTL or limit policy changes: constants may move or get semantic aliases, but current numeric values and behavior stay stable in this slice.
- No source file should exceed the 1,000-line guard rail; avoid replacing one broad god file with another.

## Codebase grounding

Likely touchpoints:

- `src/shared/types.ts` currently mixes Telegram DTOs, attachments, turns, queued controls, finals, routes, sessions, model/Git controls, broker state, lease, IPC envelopes, and model summaries.
- `src/shared/config.ts` currently mixes config paths/scope, broker paths, Telegram limits, timing constants, prompt suffix, and config read/write/normalization.
- Heavy import consumers include `src/extension.ts`, `src/bootstrap.ts`, `src/broker/*`, `src/client/*`, `src/pi/*`, `src/telegram/*`, and behavior checks under `scripts/`.
- Durable validation in `src/extension.ts` must remain aligned with whichever module owns the relevant durable types after extraction.
- Existing architecture already requires shared modules to stay cohesive and low-level; this task makes that contract more concrete.

## Acceptance Criteria

- Repository imports no longer treat `src/shared/types.ts` and `src/shared/config.ts` as the default owner for all runtime concepts; major concepts have clear semantic module homes or intentionally documented compatibility re-exports.
- Telegram API DTOs and Telegram-specific message operation types are available from Telegram-owned modules.
- Broker durable-state, route/session, outbox, final-delivery progress, queued-control, and command-control records have clear broker/client/Telegram ownership boundaries that do not introduce dependency cycles.
- IPC envelopes and IPC request/response contract types are grouped with IPC ownership.
- Configuration constants are split or aliased by semantic policy domain without changing existing values or behavior.
- Existing behavior checks still compile and exercise the migrated imports; `npm run check` passes.
- A reviewer can inspect the resulting module map and determine where a new Telegram DTO, broker durable record, IPC contract, or timing/limit constant should be added.

## Out of Scope

- Do not change TTL durations, retry timing, file/message size limits, or prompt text beyond moving/aliasing their definitions.
- Do not redesign durable-state schemas, introduce migrations for renamed JSON fields, or change broker/client IPC protocol semantics.
- Do not implement the bounded recent-id helper in this slice unless it falls out as a trivial local extraction with no behavior change; it is a separate inbox item.
- Do not take on the narrowed Telegram API error-classification cleanup except where imports need to follow newly clarified ownership.
- Do not collapse existing broker/client/pi/telegram responsibility modules into shared modules.

## Validation

Run `npm run check`.

Also inspect import direction after the split to confirm shared/bounded modules do not import broker/client/pi/Telegram policy in ways that violate the architecture. A simple grep or import review is acceptable for this slice.

## Pre-edit impact preview

Likely blast radius is broad but mostly mechanical: type-only imports and constant imports across runtime modules and behavior checks. Main risks are dependency cycles, accidental value changes while moving constants, stale durable validation assumptions, and making lazy startup import heavier by introducing the wrong barrel imports.

## Decisions

- 2026-04-30: Plan this as a conservative first bounded-context split rather than a behavior-changing cleanup. Semantic TTL naming, IPC limit policy, and bounded recent-id utilities remain adjacent follow-up opportunities unless this slice can make non-behavioral aliases safely.
- 2026-04-30: Implemented the first bounded-context split with owner modules: Telegram DTOs and Telegram message-operation state in src/telegram/types.ts, broker durable/session/route/control state in src/broker/types.ts, client turn/final and client IPC result contracts in src/client/types.ts, IPC envelopes in src/shared/ipc-types.ts, config shape in src/shared/config-types.ts, paths in src/shared/paths.ts, file limits in src/shared/file-policy.ts, prompt text in src/shared/prompt.ts, broker timing/control policy in src/broker/policy.ts, and Telegram policy in src/telegram/policy.ts. Kept src/shared/types.ts and the limited CONFIG_PATH export from src/shared/config.ts as transitional compatibility surfaces only.
- 2026-04-30: Added scripts/check-shared-boundaries.ts to keep source imports from regressing back to broad src/shared/types.ts or shared config constants; readConfig/writeConfig and CONFIG_PATH remain allowed because shared/config.ts still owns persisted config loading.
