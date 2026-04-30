---
title: "Clean up pi hook boundaries"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["pi", "hooks", "refactor", "architecture"]
traces_to: ["SyRS-local-authority-boundary", "SyRS-activity-history-rendering", "SyRS-final-delivery-fifo-retry", "SyRS-explicit-artifact-return", "SyRS-pi-safe-diagnostics", "SyRS-runtime-validation-check", "SyRS-mirror-local-user-input", "SyRS-cleanup-route-on-close"]
source_inbox: "clean-up-pi-hook"
branch: "task/clean-up-pi-hook-boundaries"
---
## Objective

Refactor the pi integration hook layer so `src/pi/hooks.ts` no longer acts as a broad cross-layer dependency bag. The target shape should keep pi hooks as the boundary where local pi commands, tools, and events are registered, while moving shared activity presentation contracts and concern-specific registration logic into narrower modules or dependency groups.

The desired outcome is a cleaner pi-owned seam: pi hook code should remain responsible for translating pi events into bridge callbacks, but it should not import broker implementation details or require every hook test fixture to construct unrelated broker/client/finalization dependencies.

## Refreshed assessment

Post lifecycle and broker-outbox cleanup, the main top-level pressure is no longer command dispatch or turn lifecycle ownership. `src/extension.ts` remains a composition root at roughly 900 lines, but the more concrete remaining architectural exception is `src/pi/hooks.ts`: it imports activity formatting from `src/broker/activity.ts` and exposes `RuntimePiHooksDeps` as a single dependency interface spanning config, route state, active-turn state, broker state, IPC, session lifecycle, final handoff, retry handling, media groups, diagnostics/status, shutdown, and attachment path validation.

This work should make the pi boundary easier to reason about without changing Telegram-visible behavior.

## Scope

- Split pi hook registration by concern where that reduces coupling, likely around commands/status, session lifecycle, local input mirroring, activity mirroring, attachment tool registration, and assistant finalization triggers.
- Replace the `src/pi/hooks.ts` dependency on `src/broker/activity.ts` with a shared activity presentation contract or formatter module if activity-line helpers remain needed from pi hooks.
- Shrink or segment `RuntimePiHooksDeps` so focused tests and future changes can depend on the concern they exercise rather than a monolithic bag.
- Keep `src/extension.ts` as the composition root that wires concrete broker/client/pi dependencies together.
- Update behavior-check fixtures to reflect the smaller dependency surfaces instead of relying on broad casts or unrelated no-op callbacks.

## Preserved behavior

- Pi commands `/telegram-setup`, `/telegram-topic-setup`, `/telegram-connect`, `/telegram-disconnect`, `/telegram-status`, and `/telegram-broker-status` keep their current user-visible behavior.
- `telegram_attach` remains explicit pi-owned outbound artifact intent and keeps the same path validation, file-size, and active-turn queueing semantics.
- Local interactive input mirroring still ignores slash commands and Telegram prompt text, preserves route/thread context, and starts local interactive turn tracking only under the current conditions.
- Prompt suffix injection still appends the Telegram bridge guidance to agent turns and adds the Telegram-origin note only for Telegram prompts, preserving attachment and trust-boundary instructions.
- Session start, shutdown, replacement handoff, disconnect, and broker stop ordering remain stable.
- Activity mirroring preserves thinking/tool event order and keeps the broker activity reporter as the rendering/delivery owner.
- Assistant-final handoff and retry-aware finalization behavior remain unchanged; this task must not move final delivery out of the broker final ledger.
- Pi-safe diagnostics/status surfaces remain pi-native and must not introduce raw terminal warning paths.

## Out of Scope

- Do not redesign broker activity rendering, final delivery, Telegram preview handling, or the broker Telegram outbox.
- Do not split all of `src/shared/types.ts` or `src/shared/config.ts`; only extract shared activity contracts/formatters if needed for the pi hook boundary.
- Do not change Telegram command semantics, callback controls, busy-message routing, or session route lifecycle decisions.
- Do not introduce a new runtime framework or dependency injection container.

## Codebase grounding

Likely touchpoints:

- `src/pi/hooks.ts`
- possibly new focused modules under `src/pi/`
- possibly a small shared activity formatter/contract under `src/shared/`
- `src/broker/activity.ts` if activity-line ownership is adjusted
- `src/extension.ts` for updated dependency wiring
- `scripts/check-runtime-pi-hooks.ts`
- `scripts/support/pi-hook-fixtures.ts`

## Acceptance Criteria

- `src/pi/hooks.ts` no longer imports broker implementation modules solely to format pi-originated activity lines; any cross-folder activity presentation helper has a shared owner or a narrower contract.
- Pi hook registration is separated enough that command/status, attachment, lifecycle, activity, local-input, and finalization behavior can be tested or reasoned about without constructing unrelated dependency state.
- The extension composition root still wires the same runtime behavior, and no new module outside `src/pi/` starts owning pi event registration.
- Focused behavior checks cover the preserved pi hook behaviors listed above, including prompt suffix injection, attachment queueing, local input mirroring, shutdown/handoff ordering, activity event reporting, and retry-aware finalization triggers.
- No Telegram-visible behavior, IPC shape, final-delivery ownership, or route lifecycle decision changes in this slice.

## Validation

Run `npm run check` before reporting completion. Ensure `scripts/check-runtime-pi-hooks.ts` remains focused and expands coverage if the refactor creates new hook modules or dependency groups. Run `pln hygiene` if planning or architecture artifacts are updated during implementation.

## Pre-edit impact preview

Expected blast radius is medium: mostly pi hook registration, extension wiring, activity helper placement, and pi-hook behavior fixtures. Main risks are moving too much behavior into `shared`, accidentally changing finalization/shutdown ordering, or turning a boundary cleanup into a broad shared-types split.

## Decisions

- 2026-04-30: Split runtime pi hooks into concern-specific pi modules, keeping src/pi/hooks.ts as a 40-line composition layer. Moved reusable activity-line formatting into src/shared/activity-lines.ts so pi hook code no longer imports broker/activity while broker ActivityRenderer continues to own Telegram delivery rendering.
- 2026-04-30: Kept the public registerRuntimePiHooks entrypoint and extension wiring shape stable for this slice; focused registrars now expose narrower dependency contracts for attachments, commands, local input, lifecycle, prompt suffixing, activity mirroring, and finalization.
- 2026-04-30: Expanded runtime pi hook behavior checks to exercise the dependency-free prompt suffix registrar and focused attachment/local-input registrars directly, while retaining full runtime hook checks for shutdown, activity, and finalization ordering.
- 2026-04-30: Updated architecture notes to remove the previous pi-to-broker activity helper exception and document shared/activity-lines.ts as the common presentation contract, with broker/activity.ts still owning Telegram rendering and debouncing.
