---
title: "Separate durable Telegram footer status from diagnostics"
status: "done"
priority: 2
created: "2026-05-03"
updated: "2026-05-03"
author: "Christof Salis"
assignee: ""
labels: ["ui", "diagnostics", "status"]
traces_to: ["SyRS-durable-pi-footer-status", "SyRS-pi-safe-diagnostics"]
source_inbox: "separate-durable-telegram-status"
branch: "task/separate-durable-telegram-footer"
---
## Objective

Keep the pi footer/statusbar as a durable Telegram bridge-state indicator and route event-like bridge diagnostics through the same pi-native notification mechanism used by `/telegram-status`, without injecting those diagnostics into future LLM context.

## Scope

- Refactor the Telegram status path so `updateStatus` and `telegramStatusText` describe durable state only: configuration missing, broker/session count, connected route, disconnected, hidden/cleared.
- Remove the transient error/detail overload from footer updates; call sites that currently pass raw errors or `statusDetail` should either refresh durable status or report a diagnostic notification.
- Align `createPiDiagnosticReporter` with the new diagnostic contract: actionable/user-facing events notify via `ctx.ui.notify` or another non-LLM UI surface, and diagnostics that should not affect the agent must not use `pi.sendMessage`/custom messages.
- Route poll-loop and background transient failures away from the footer; suppress or dedupe ordinary retryable noise, while preserving notifications for actionable, repeated, or terminal failures.
- Preserve `/telegram-status` and `/telegram-broker-status` behavior as the model for local diagnostic display: concise `ctx.ui.notify(..., "info")` output, not session-message injection.

## Codebase Grounding

Likely touchpoints:

- `src/extension.ts`: `updateStatus(ctx, error?)`, diagnostic reporting call sites, command/bootstrap error paths, and broker/client lifecycle status refreshes.
- `src/shared/ui-status.ts`: `telegramStatusText(...)` currently accepts `error?: string` and renders an error branch.
- `src/pi/diagnostics.ts`: currently maps `statusDetail` to footer updates and `display` to `pi.sendMessage`, which creates LLM-visible custom messages.
- `src/broker/updates.ts`: poll-loop errors currently flash in status, sleep, then refresh durable status.
- `src/pi/commands.ts` and `src/bootstrap.ts`: `/telegram-status` and `/telegram-broker-status` show the intended notification mechanism.
- Behavior checks likely belong near `scripts/check-runtime-pi-hooks.ts` or a focused new check for status/diagnostics.

## Preserved Behavior

- The footer remains hideable/clearable through existing status visibility controls.
- Durable footer states still update on setup, connect, disconnect, broker/client role changes, session count changes, and agent lifecycle refreshes.
- `/telegram-status` and `/telegram-broker-status` continue to notify concise current-state summaries.
- Telegram retry handling, broker polling offsets, final delivery, and activity rendering behavior are not changed by this UI-surface refactor.
- Non-actionable transient coordination noise remains quiet enough not to spam the operator.

## Acceptance Criteria

- Focused tests or inspection show no production path can pass raw transient diagnostic/error text into the Telegram footer/statusbar update function.
- Focused tests cover durable footer rendering for not configured, broker/session count, connected route, disconnected, and hidden/cleared states.
- Diagnostic reporter tests show actionable diagnostics call `ctx.ui.notify` with the expected severity and do not call `pi.sendMessage` for diagnostics that should stay out of LLM context.
- Poll-loop or retryable background failures no longer briefly replace durable footer text; repeated or terminal failures remain observable through the planned notification policy.
- The implementation explicitly classifies representative existing diagnostic sources after removing `statusDetail`/`display` paths: poll-loop retry failures, heartbeat repeated contention/failure, terminal route cleanup/final-delivery failures, invalid durable-state diagnostics, activity-renderer failures, and setup/connect/disconnect command errors. Coverage should prove each class is either suppressed/deduped as non-actionable transient noise or surfaced through notification/non-LLM UI when actionable, repeated, user-initiated, or terminal.
- `npm run check` passes.

## Out of Scope

- Do not create a general diagnostic history browser or custom pi widget in this slice.
- Do not change Telegram message delivery, activity rendering, final-response delivery, broker election, or retry semantics except where needed to stop footer/error misuse.
- Do not use `pi.sendMessage` for bridge diagnostics unless a future requirement explicitly decides that the agent should see those diagnostics as user-message context.

## Decisions

- 2026-05-03: Diagnostics that are event-like and should not influence the agent will use the same pi-native notification mechanism as /telegram-status rather than pi.sendMessage/custom session messages; the footer remains durable bridge state.
- 2026-05-03: Implemented diagnostic disposition as: poll-loop retry failures suppress footer overrides and refresh durable status after backoff; repeated heartbeat contention and repeated heartbeat failures notify; terminal final-delivery and route-cleanup failures notify; invalid durable-state diagnostics notify; activity-renderer failures are deduped and notify only for non-retry-after failures; setup/connect/disconnect command errors continue to notify and only refresh durable status.
- 2026-05-03: Review follow-up: invalid durable-state notifications and non-retry-after queued-control/manual-compaction maintenance notifications are bounded with per-key dedupe so persistent failures remain visible without heartbeat/startup notification spam.
