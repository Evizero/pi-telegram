---
title: "Unify Telegram command and callback controls"
status: "done"
priority: 2
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: "pi-agent"
labels: ["telegram", "commands", "callbacks", "refactor", "reliability"]
traces_to: ["SyRS-interactive-model-picker", "SyRS-telegram-git-menu", "SyRS-queued-followup-steer-control", "SyRS-cancel-queued-followup", "SyRS-queued-control-finalization", "SyRS-busy-message-default-followup", "SyRS-follow-queues-next-turn", "SyRS-selector-selection-durability", "SyRS-list-and-select-sessions", "SyRS-topic-routes-per-session", "SyRS-telegram-text-method-contracts", "SyRS-telegram-retry-after", "SyRS-deliver-telegram-turn", "SyRS-stop-active-turn", "SyRS-compact-busy-session", "SyRS-local-git-inspection", "SyRS-reject-unauthorized-telegram", "SyRS-local-authority-boundary", "SyRS-unregister-session-route", "SyRS-cleanup-route-on-close"]
source_inbox: "unify-telegram-command-and"
branch: "task/unify-telegram-command-controls"
---
## Objective

Define and implement a common Telegram command/control architecture so `/model`, `/git`, queued follow-up controls, session selection, ordinary commands, and callback finalization stop evolving as parallel mini-systems. The implementation should reduce `src/broker/commands.ts` into a thin dispatcher plus focused command/control modules while preserving all current user-visible behavior.

## Source Context

The source inbox item identifies a codebase coherence problem: Telegram controls have grown feature-by-feature. Session selection, model picker callbacks, Git action callbacks, queued-turn steer/cancel controls, command replies, route checks, token expiry, callback acknowledgement, and stale-message finalization each use similar patterns with local differences.

Deep-dive evidence from the current codebase after the Telegram IO policy refactor:

- `src/broker/commands.ts` is still near the 1,000-line guard rail and owns command parsing, route lookup, session selection, ordinary command execution, model picker state, Git control state, queued-turn control state, IPC calls, pruning, callback dispatch, and helper retry behavior.
- `/model` and `/git` both create tokenized inline controls with route/session/message identity, expiration, persisted broker state, stale callback rejection, optional edit-or-send result delivery, callback acknowledgement, and pruning; those mechanics are duplicated instead of represented as a shared control lifecycle.
- Queued follow-up controls are rightly stricter because they affect durable pending turns, but they still share token parsing, route/message matching, visible-message finalization, callback answering, and expiry mechanics with other controls.
- `src/broker/model-picker.ts`, `src/broker/git-controls.ts`, and `src/broker/queued-controls.ts` already contain some rendering/parser/state helpers, but orchestration and lifecycle policy remain concentrated in `TelegramCommandRouter`.
- Current checks cover command routing, model picker rendering, queued controls, Git controls, retry_after handling, and topic thread preservation, but the largest check script mirrors the runtime sprawl.

This task should build on the new `src/telegram/errors.ts` and `src/telegram/message-ops.ts` IO policy seam. It should not reintroduce local Telegram fallback/error classifiers.

## Scope

Create a shared broker-side command/control layer for the common lifecycle around Telegram commands and callback controls. A good first implementation shape is likely:

- a thin command router that maps Telegram command names and callback prefixes to focused handlers;
- a shared inline-control helper module for tokenized controls that can:
  - parse and identify callback prefixes;
  - bind controls to chat, message thread, message id, route id, and session id;
  - validate callback origin against stored control state;
  - validate current route/session authority, including selector-mode selection freshness when required;
  - manage expiration, pruning, and broker-state persistence conventions;
  - answer callbacks and edit-or-send/finalize visible control messages through the centralized Telegram IO helpers;
- focused handlers/modules for:
  - session listing and `/use` selector routing;
  - basic route/session commands (`/status`, `/compact`, `/stop`, `/disconnect`, `/help`, `/broker`);
  - model command and picker callbacks;
  - Git command and action callbacks;
  - queued follow-up steer/cancel controls, keeping their stricter durable-turn authority semantics;
  - ordinary Telegram turn delivery, `/follow`, and `/steer` handoff.

The implementation may proceed incrementally, but the completed slice should leave the command/control architecture visibly more regular. It should not merely move large chunks of `commands.ts` into another god file.

## Preserved Behavior

- Ordinary Telegram messages sent while a session is busy still queue as follow-up work by default.
- `/follow <message>` queues follow-up work; `/steer <message>` explicitly steers active work.
- Queued follow-up steer/cancel buttons must only affect their still-queued target turn and must fail closed when stale, expired, already converted/cancelled, route-mismatched, or no longer pending.
- Queued-control visible finalization remains retry-aware and must not delete or hide durable control state through a Telegram `retry_after` window.
- `/model` behavior remains stable, including provider disambiguation, pagination, exact picker selection, callback expiry, stale route rejection, selector-mode/session checks, `/model list`, `/model <number>` from the cached list, and direct `/model <selector>` compatibility.
- `/git` remains read-only and keeps the documented action menu, callback expiry, session/route validation, result delivery, and topic/thread preservation.
- `/sessions` and `/use` retain selector-mode selection durability across broker turnover until selection expiry or invalidation.
- `/status`, `/compact`, `/stop`, `/disconnect`, `/help`, and `/broker` keep their current semantics and route/session targeting.
- Callback queries are answered or rejected according to current authority checks; unsupported or unauthorized callbacks must remain fail-closed.
- Telegram `message_thread_id` is preserved for topic-routed command replies, control menus, callback edits, fallback sends, and finalization messages.
- Telegram `retry_after` remains a control signal; command/control code must not fall back to another method or mark lifecycle progress through a rate-limit window.
- The local-first boundary remains unchanged: commands may request local IPC operations, but Telegram does not become an independent execution surface or general bot framework.

## Codebase Grounding

Likely runtime touchpoints:

- `src/broker/commands.ts` — shrink to routing/composition plus maybe thin glue; avoid leaving it above the project guard rail.
- New or revised broker modules such as `src/broker/command-router.ts`, `src/broker/command-handlers.ts`, `src/broker/inline-controls.ts`, `src/broker/model-command.ts`, `src/broker/git-command.ts`, and/or `src/broker/turn-command.ts` if those names fit the implementation.
- `src/broker/model-picker.ts`, `src/broker/git-controls.ts`, and `src/broker/queued-controls.ts` — keep rendering/domain helpers, but move shared lifecycle operations into the common control layer where appropriate.
- `src/shared/types.ts` — consider extracting command/control state types only if it reduces accidental coupling; do not force a broad shared-type split in this task.
- `src/telegram/message-ops.ts` and `src/telegram/errors.ts` — use these for callback answering, edit/send fallback, retry_after propagation, and edit error classification.
- `src/broker/updates.ts` — callback dispatch should remain behind the authorization gate and continue returning a boolean handled/not-handled result.
- Check scripts: `scripts/check-telegram-command-routing.ts`, `scripts/check-model-picker.ts`, `scripts/check-client-turn-delivery.ts`, `scripts/check-client-git-status.ts`, `scripts/check-telegram-io-policy.ts`, and possibly a new focused command/control lifecycle check.

## Acceptance Criteria

- `src/broker/commands.ts` is below 1,000 lines and reads as a dispatcher/composition layer rather than the owner of every command/control lifecycle detail.
- Tokenized inline controls share one lifecycle/helper path for callback-prefix matching, route/message binding, callback-origin validation, expiry/pruning conventions, callback acknowledgement, and edit-or-send/finalization policy where those behaviors are actually common.
- Queued follow-up controls retain their stricter durable-turn authority and retry-aware visible finalization; the abstraction does not weaken their correctness to fit model/Git controls.
- Model picker and Git controls use the shared lifecycle helpers for common validation and visible message handling while keeping their domain-specific renderers and IPC actions separate.
- Command routing remains authorized, route-aware, and topic-thread-aware for selector and forum-topic modes.
- Existing command/control behavior remains covered for `/sessions`, `/use`, `/model` picker/list/number/direct-selector forms, `/git`, `/status`, `/compact`, `/stop`, `/disconnect`, `/follow`, `/steer`, ordinary busy messages, queued steer/cancel callbacks, and stale callback finalization.
- Regression coverage includes callback route mismatch, expired controls, stale/deleted callback-origin messages, retry_after propagation, selector-mode freshness, and topic `message_thread_id` preservation.
- The refactor reduces duplicated command/control lifecycle policy rather than only relocating it.
- `dev/ARCHITECTURE.md` is updated to reflect the resulting command/control seam, or the task records an explicit decision that the final module boundary did not materially change the architecture contract.
- No new TypeScript source file exceeds 1,000 lines, and no broad Telegram bot framework or external broker abstraction is introduced.
- `npm run check`, `pln hygiene`, and `git diff --check` pass before completion.

## Out of Scope

- Do not build the durable Telegram side-effect outbox in this task.
- Do not redesign client turn lifecycle, assistant-final delivery, broker lease/state persistence, route cleanup ownership, or session replacement handoff except where command/control callers need narrow interfaces.
- Do not change user-facing command names, callback token formats, pairing/setup behavior, topic routing policy, or final-delivery ordering.
- Do not implement a general plugin/command framework for arbitrary Telegram bot applications.
- Do not perform the broad `src/shared/types.ts` bounded-context split unless a tiny extraction is needed to keep the command/control module boundary clear.
- Do not split the whole validation suite in this slice; only restructure or add checks needed to validate the command/control refactor.

## Pre-edit Impact Preview

Expected blast radius is medium-to-large but behavior-preserving. The likely code changes are concentrated in `src/broker/commands.ts` plus new focused modules under `src/broker/`, with test updates in command routing/model picker/Git/queued-control checks. The main risks are weakening queued-turn authority, dropping selector-mode freshness checks, losing `message_thread_id` on fallback sends/edits, swallowing `retry_after`, or turning a useful shared lifecycle into an over-general framework. Architecture should be updated once the final command/control module boundary is clear, unless implementation proves the architecture contract stayed materially unchanged and records that decision.

## Validation Plan

- Run and, where needed, extend command-routing checks for ordinary commands, `/follow`, `/steer`, busy-message follow-up defaults, selector-mode `/use` routing, and `/model` picker/list/number/direct-selector compatibility.
- Add or extend callback-control checks for model picker, Git menu, queued steer/cancel, expired controls, route-mismatched controls, offline sessions, stale/deleted callback messages, and already-terminal queued controls.
- Verify retry_after is propagated through callback edit/send/finalization paths and does not trigger fallback progress.
- Verify topic `message_thread_id` is preserved for command replies, menus, callback edits, and fallback sends.
- Verify large-command output behavior remains explicit: single-message edits must not silently drop chunks unless the caller intentionally uses a single-message edit path.
- Run the full local suite with `npm run check`, then `pln hygiene` and `git diff --check`.

## Decisions

- 2026-04-29: Pre-edit planning direction: treat this as a broker command/control architecture refactor, not a generic Telegram bot framework. First centralize the shared lifecycle of tokenized inline controls and split `commands.ts` into focused handlers while preserving stricter queued-turn authority and all current command semantics.
- 2026-04-29: Started implementation. Treat this as a behavior-preserving broker command/control refactor: create focused command/control modules and shared lifecycle helpers while keeping queued-turn authority, retry_after handling, topic thread routing, and current command semantics intact.
- 2026-04-29: Implemented the refactor as focused broker modules: command-text/command-types for shared command plumbing, inline-controls for common callback binding/route validation/edit-answer policy, model-command for /model and picker callbacks, git-command for /git controls, and queued-turn-control-handler for queued follow-up controls. commands.ts now acts as the dispatcher/composition layer and remains below the 1,000-line guard rail.
- 2026-04-29: Added selector freshness to persisted model picker state so selector-mode model callbacks fail closed after /use changes, matching the existing Git control freshness policy while preserving forum-topic picker behavior and /model list number compatibility.
- 2026-04-29: Validation passed with npm run check, pln hygiene, git diff --check, and a clean read-only review agent verdict. Architecture was updated to document the command/control seam.
