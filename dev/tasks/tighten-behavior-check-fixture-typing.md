---
title: "Tighten behavior-check fixture typing"
status: "done"
priority: 3
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["tests", "cleanup", "typing", "behavior-checks"]
traces_to: ["SyRS-behavior-check-domain-fixtures", "SyRS-runtime-validation-check", "SyRS-behavior-check-discovery"]
source_inbox: "reduce-duplicated-test-discovery"
branch: "main"
---
## Objective

Finish the still-valid part of `reduce-duplicated-test-discovery` by tightening weak TypeScript seams in the behavior-check harness and the two small production API type leaks, while leaving the now-stabilized behavior-check discovery runner unchanged.

This is a cleanup slice. It should preserve existing runtime behavior and all existing behavior-check assertions.

## Current investigation

The original duplicate discovery problem is already resolved: `scripts/run-behavior-check.mjs` now discovers sorted root-level `scripts/check-*.ts` files, generates `tsconfig.behavior-check.generated.json`, compiles the discovered set with package sources, runs each emitted check, and deletes the generated config. `tsconfig.activity-check.json` and the manual `check:activity` list are gone.

Remaining evidence from 2026-04-29:

- `npm run check` passes before this task.
- Broad casts and `any` usage are still concentrated in behavior-check harness setup:
  - `scripts/check-runtime-pi-hooks.ts`
  - `scripts/check-client-runtime-host.ts`
  - `scripts/check-client-turn-delivery.ts`
  - `scripts/check-callback-updates.ts`
  - `scripts/check-broker-background.ts`
  - `scripts/check-client-info.ts`
  - `scripts/check-session-pending-turn-rehome.ts`
  - `scripts/check-session-topic-setup-and-offline-grace.ts`
- Production `any` leaks remain in:
  - `src/client/info.ts` — `clientSetModel` accepts `(model: any) => Promise<boolean>` even though the model originates from `ctx.modelRegistry.getAvailable()`.
  - `src/shared/ui-status.ts` — `telegramStatusText` accepts `theme: any` even though pi exports a `Theme` type.
- Runtime-update checks duplicate `RuntimeUpdateDeps` stubs for `createRuntimeUpdateHandlers` and currently use weak `commandRouter` casts.
- Pi-hook checks duplicate partial `ExtensionAPI`, `ExtensionContext`, and `RuntimePiHooksDeps` fixtures and contain the largest cluster of broad casts.

## Scope

- Replace the production `any` leaks with appropriate exported types from the pi packages where available:
  - likely `Model<Api>` from `@mariozechner/pi-ai` for the `clientSetModel` callback;
  - likely `Theme` from `@mariozechner/pi-coding-agent` for status rendering.
- Add typed behavior-check support helpers only where they remove repeated weak harness setup without hiding scenario logic, for example:
  - a typed `scripts/support/runtime-update-fixtures.ts` builder around `RuntimeUpdateDeps` and no-op `TelegramCommandRouter` methods;
  - a typed `scripts/support/pi-hook-fixtures.ts` builder around `ExtensionAPI`, event handler registration, minimal `ExtensionContext`, `ActivityReporter`, and `RuntimePiHooksDeps` defaults;
  - a small typed model fixture for `scripts/check-client-info.ts` if that is cleaner than local inline typing.
- Refactor existing checks to use those helpers where practical, prioritizing repeated `as any`, `as never`, and broad callback payload casts.
- Keep check files independently executable under top-level await.
- Preserve current behavior-check domain organization and support-file naming so support modules do not match the root `scripts/check-*.ts` discovery pattern.

## Out of scope

- Do not change `scripts/run-behavior-check.mjs`, `tsconfig.behavior-check.json`, or the generated-tsconfig discovery strategy unless a small bug is found directly while implementing this task.
- Do not move behavior checks from `scripts/` to `test/behavior/`; treat layout migration as a separate future decision.
- Do not split additional large behavior-check files in this task unless a narrow helper extraction naturally reduces duplication; avoid re-opening the command/session split work.
- Do not change Telegram, broker, client, or pi-hook runtime behavior.
- Do not attempt to eliminate every `unknown as TResponse` response shim when TypeScript cannot express the generic test double cleanly without making fixtures harder to read.

## Codebase grounding

Likely touchpoints:

- Production typing:
  - `src/client/info.ts`
  - `src/shared/ui-status.ts`
- Behavior support fixtures:
  - new `scripts/support/runtime-update-fixtures.ts`
  - new `scripts/support/pi-hook-fixtures.ts`
  - possibly new or inline helpers for model-selection checks
- Existing behavior checks likely to import those fixtures:
  - `scripts/check-callback-updates.ts`
  - `scripts/check-broker-background.ts`
  - `scripts/check-session-pending-turn-rehome.ts`
  - `scripts/check-session-topic-setup-and-offline-grace.ts`
  - `scripts/check-runtime-pi-hooks.ts`
  - `scripts/check-client-info.ts`
  - optionally `scripts/check-client-runtime-host.ts` and `scripts/check-client-turn-delivery.ts` if a small typed helper is obvious.

## Acceptance criteria

- `npm run check` passes.
- `rg` inspection shows the production `any` uses in `src/client/info.ts` and `src/shared/ui-status.ts` are removed.
- Behavior-check broad casts are materially reduced in the files listed above, especially repeated `commandRouter ... as any/as never`, partial `ExtensionAPI` registration harness casts, and model-selection `as any` contexts.
- New shared fixtures are typed, live under `scripts/support/`, and are imported by checks rather than executed as root behavior checks.
- Existing check assertions and user-visible behavior expectations remain present; cleanup does not weaken coverage to satisfy types.
- Any remaining broad casts are local, justified by external generic boundaries or partial pi API simulation, and not broader than the current state.

## Validation

Run:

```bash
npm run check
pln hygiene
```

Before close-out, inspect remaining broad casts with a command such as:

```bash
rg -n "\\bas (any|never)\\b|: any\\b|Record<string, any>|unknown as" scripts src index.ts
```

Use the inspection to confirm the slice improved the harness typing without hiding required scenario setup.

## Implementation record

Implemented the planned cleanup slice without changing the behavior-check runner or runtime semantics.

- Replaced the production `any` leaks with exported pi package types:
  - `src/client/info.ts` now types `clientSetModel` callbacks as `Model<Api>`.
  - `src/shared/ui-status.ts` now types the status theme as `Theme`.
- Added typed behavior-check support modules under `scripts/support/`:
  - `runtime-update-fixtures.ts` for `RuntimeUpdateDeps`, broker state, lease, extension context, and a no-op real `TelegramCommandRouter`.
  - `pi-hook-fixtures.ts` for the pi-hook harness, `RuntimePiHooksDeps` defaults, typed activity reporters, route/turn builders, and test contexts.
  - `model-fixtures.ts` for typed model-selection fixtures.
- Refactored the targeted checks to import those helpers, removing repeated `commandRouter ... as any/as never`, local pi-hook harness `any` plumbing, model-selection `as any` contexts, and the largest cluster of `ActivityReporter ... as never` casts.
- Left remaining response-generic casts and partial external API shims local where TypeScript cannot represent the generic test double cleanly without obscuring the scenario.

Validation completed during implementation:

```bash
npm run check
pln hygiene
rg -n "\\bas (any|never)\\b|: any\\b|Record<string, any>|unknown as" scripts src index.ts
```

The inspection confirms the production `any` leaks are gone, runtime-update command-router casts are gone, and remaining broad casts are concentrated in local external/generic test doubles.

## Decisions

