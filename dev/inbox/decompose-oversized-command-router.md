---
title: "Decompose oversized command router and large check scripts"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["split-telegram-command-routing"]
---
Code-quality audit finding from 2026-04-28.

`src/broker/commands.ts` is 1005 lines and mixes route lookup, command parsing, IPC calls, model pickers, Git controls, queued-turn controls, pruning, and help text. `scripts/check-telegram-command-routing.ts` and `scripts/check-session-route-cleanup.ts` also exceed the project guidance that TypeScript source files stay under 1000 lines.

Suggested planning direction: split the command router into a thin dispatcher plus focused command/control modules, and split large check scripts by behavior area with shared fixtures.


## Deep-dive note (2026-04-29)

Current-state correction: the original command-router evidence is materially stale. `src/broker/commands.ts` is now 323 lines, not ~1005, and the production command/control split already exists: `broker/model-command.ts`, `broker/model-picker.ts`, `broker/git-command.ts`, `broker/git-controls.ts`, `broker/queued-turn-control-handler.ts`, `broker/queued-controls.ts`, and `broker/inline-controls.ts` own the heavier command/control behavior. `dev/ARCHITECTURE.md` already describes `broker/commands.ts` as the thin route-aware dispatcher and composition point.

The still-valid cleanup pressure is the oversized behavior checks:
- `scripts/check-telegram-command-routing.ts` is 1364 lines.
- `scripts/check-session-route-cleanup.ts` is 1327 lines.
- Both exceed the project source-file guidance and make future command/session refactors harder to review.

Recommended planning stance: do not promote the original runtime-router decomposition as written. Treat the runtime part as already substantially complete, and promote the remaining work as validation-suite/domain cleanup unless a later feature proves `commands.ts` needs another production extraction.

Option A, recommended first slice: split `scripts/check-telegram-command-routing.ts` because it mostly tests one facade (`TelegramCommandRouter`) and can prove the support-fixture pattern safely. Extract a non-executable support module such as `scripts/support/telegram-command-fixtures.ts` for `makeSession`, `makeBrokerState`, `makeMessage`, `makeCallbackQuery`, `createCommandRouterHarness`, callback-button extraction, shared model fixtures, and call recorder types. Then split checks into root-level auto-discovered files such as:
- `scripts/check-telegram-command-routing.ts` for core dispatch, `/compact`, `/stop`, `/follow`, `/steer`, and plain-turn delivery;
- `scripts/check-telegram-queued-controls.ts` for queued follow-up steer/cancel, stale/offline/wrong-route handling, retry-after/transient-edit behavior, and broker-failover/idempotency;
- `scripts/check-telegram-git-controls.ts` for `/git` menu and Git callback behavior;
- `scripts/check-telegram-model-picker.ts` for `/model`, provider/model picker, numeric compatibility, stale selector rejection, UI failure tolerance, and retry-after idempotency.

Option B, second slice after A: split `scripts/check-session-route-cleanup.ts`, which is broader and more integration-like. Use a separate support module such as `scripts/support/session-route-fixtures.ts` for session/route/state/queued-control/pending-turn/pending-final/runtime-update dependency builders, but keep scenario-specific mutations visible. Candidate check files:
- `scripts/check-session-unregister-cleanup.ts`;
- `scripts/check-session-disconnect-requests.ts`;
- `scripts/check-session-route-registration.ts`;
- `scripts/check-session-pending-turn-rehome.ts`;
- `scripts/check-session-topic-setup-and-offline-grace.ts`.

Option C, lower priority: if a production extraction is still desired, only small slices remain: extract selector/list commands from `sendSessions`, `handleUseCommand`, and selector pruning; or extract inbound turn delivery from `deliverTelegramTurn`. This is not the recommended next move because the current router is below the line-count guard rail and matches the architecture contract.

Preserved behavior for planned tasks: keep all existing assertions, especially busy-message default follow-up, `/follow` vs `/steer`, queued-control idempotency across retry-after and broker failover, stale/offline/wrong-route callback rejection, `/stop` queued-control finalization without abort replay, Git/model callback no-replay after Telegram retry-after, route/thread preservation, safe disconnect/offline cleanup, reconnect grace, pending-turn rehome, preview cleanup, and topic-setup rollback.

Implementation constraints for planning: fixture files must not match root `scripts/check-*.ts` or the behavior runner will execute them as standalone checks; split check files must be independent under top-level await and cannot rely on execution order; validation remains `npm run check`.
