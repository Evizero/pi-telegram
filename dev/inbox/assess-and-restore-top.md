---
title: "Assess and restore top-level codebase coherence"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["clean-up-pi-hook-boundaries"]
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: run a whole-codebase architecture/coherence assessment rather than another localized bug hunt. Look for broad patterns: modules with overlapping responsibilities, duplicated control flows, diverging conventions, and places where new features are being duct-taped onto older paths.

## Refreshed assessment (2026-04-30, after lifecycle and outbox refactors)

The two biggest previously identified pressure points have now been addressed enough to stop treating them as the next broad refactor blocks:

- Client turn/final lifecycle has a named owner in `src/client/turn-lifecycle.ts`, with related paths under `src/client/runtime-host.ts`, `src/client/runtime.ts`, `src/client/turn-delivery.ts`, `src/client/final-handoff.ts`, and route shutdown still coordinated but no longer anonymous scattered state.
- Broker-side durable Telegram cleanup side effects now have a named owner in `src/broker/telegram-outbox.ts`; assistant final delivery intentionally remains on `src/broker/finals.ts`.

Current code shape evidence:

- `src/extension.ts` is still the largest composition root at about 900 lines, but it mostly wires already-named broker/client/pi modules rather than owning one dominant feature concern.
- `src/broker/commands.ts` is now a focused dispatcher and delegates model, Git, queued-control, and inline-control behavior to focused broker modules.
- `src/pi/hooks.ts` is the clearest remaining cross-boundary pressure point: it registers several unrelated pi command/tool/event concerns, exposes a broad `RuntimePiHooksDeps` dependency bag, and imports activity formatting helpers from `src/broker/activity.ts`, an architecture-documented dependency-direction exception.
- `src/shared/types.ts` and `src/shared/config.ts` remain broad shared buckets, but a whole-sale split would be high churn and should be phased around concrete boundary improvements rather than performed mechanically.
- Telegram API error/retry classification and durable JSON read failure handling appear partly or fully improved in current code; those inbox items should be narrowed or closed after focused confirmation rather than treated as the next big refactor by default.

## Decision

The next concrete high-leverage refactor block is `clean-up-pi-hook`. This umbrella assessment is now planned through the concrete ready task `clean-up-pi-hook-boundaries`.

Reasoning: it is smaller and safer than a repository-wide shared type/config split, but it directly addresses a real architecture seam: pi remains the execution authority, broker owns Telegram activity rendering/delivery, and shared code should only carry common contracts/formatters. Cleaning that seam should also make a later phased shared-types split easier and less mechanical.

## Follow-up ordering

Recommended sequence after the pi hook boundary task:

1. Reassess `split-shared-types-and` as a phased bounded-context split, starting from any shared activity contract extracted during pi hook cleanup.
2. Refresh `unify-telegram-api-error`; likely narrow it to remaining direct retry/classifier imports if any remain.
3. Refresh or close `durable-json-read-failures`; current `readJson` appears to return `undefined` only for `ENOENT` and behavior coverage exists, so any remaining work is more likely schema validation than the originally captured bug.
4. Keep small hygiene items (`centralize-ipc-limits-and`, `extract-bounded-recent-id`, `split-semantic-ttl-constants`, `edited-telegram-command-results`) as separate focused tasks rather than grouping them into the next big refactor.
