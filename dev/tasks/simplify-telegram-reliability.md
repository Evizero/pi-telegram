---
title: "Simplify Telegram reliability orchestration ownership"
status: "done"
priority: 2
created: "2026-04-26"
updated: "2026-04-26"
author: "Christof Salis"
assignee: ""
labels: ["refactor", "maintainability", "telegram-reliability"]
traces_to: ["SyRS-final-delivery-fifo-retry", "SyRS-final-preview-deduplication", "SyRS-retry-aware-agent-finals", "SyRS-final-text-before-error-metadata", "SyRS-stop-active-turn", "SyRS-telegram-retry-after", "SyRS-runtime-validation-check", "SyRS-topic-routes-per-session", "SyRS-telegram-text-method-contracts", "SyRS-explicit-artifact-return"]
source_inbox: "simplify-telegram-reliability-orchestration"
branch: "task/simplify-telegram-reliability"
---
## Objective

Simplify the Telegram reliability orchestration slice by making **client-to-broker assistant-final handoff** a narrow, explicit ownership boundary instead of a collection of overlapping retry, replay, deferred-final, and broker-ledger paths spread through `src/extension.ts`.

The broader maintainability goal from the source inbox remains: simpler code, less duplication or reimplementation of parallel almost-same features, and generally improved maintainability. This task is the first ready implementation slice for that goal. It should reduce duplicated final-handoff machinery while preserving existing Telegram-visible reliability behavior.

## Selected implementation slice

Focus on final-handoff ownership between the client session and broker. After this task, it should be clear in code that:

- the client owns execution-time finalization and only the narrow handoff-until-broker-acceptance problem;
- the broker `AssistantFinalDeliveryLedger` owns durable final delivery after broker acceptance;
- any client-side queue or `client-pending-finals` disk file that remains exists only to protect ambiguous pre-acceptance handoff, not as a parallel durable final-delivery system;
- deferred retry-aware finalization remains cohesive and does not grow ad hoc recovery branches in `src/extension.ts`;
- stale-client stand-down either cannot mutate broker-visible final state or can do so only through one documented, narrow final-handoff exception.

Do not try to solve every reliability orchestration smell in this task. Broker cleanup policy, preview-store simplification, and full client turn-lifecycle consolidation are follow-up candidates unless they are directly required to make final handoff simpler.

## Codebase grounding

Likely touchpoints:

- `src/extension.ts`
  - currently owns `assistantFinalQueue`, `persistedDeferredPayload`, `persistAssistantFinalQueueToDisk(...)`, `processPendingClientFinalFiles(...)`, `handoffAssistantFinalToBrokerConfirmed(...)`, `sendAssistantFinalToBroker(...)`, `retryPendingAssistantFinals(...)`, shutdown handoff, and stale-stand-down final persistence;
  - should shrink below the project 1,000-line source-file limit and keep mostly composition, dependency construction, and thin callbacks.
- `src/client/final-delivery.ts`
  - currently contains `AssistantFinalRetryQueue`; either evolve this into the final-handoff abstraction or replace it with a clearer `src/client/final-handoff.ts` module.
- `src/client/retry-aware-finalization.ts`
  - keep retry-aware active-turn finalization cohesive; it may depend on a narrower final-handoff interface but should not learn broker replay details.
- `src/client/route-shutdown.ts` and `src/client/abort-turn.ts`
  - preserve behavior around shutdown, disconnect, and `/stop` during deferred retry/final-handoff windows.
- `src/broker/finals.ts`
  - preserve as the broker durable final ledger after acceptance; do not duplicate its FIFO/retry-after/progress responsibilities on the client side.
- `src/shared/types.ts`
  - small type clarifications are acceptable if they make the ownership boundary explicit.
- `scripts/check-final-delivery.ts`, `scripts/check-retry-aware-finalization.ts`, `scripts/check-client-abort-turn.ts`, `scripts/check-session-route-cleanup.ts`, and `scripts/run-activity-check.mjs`
  - extend or add focused checks for the extracted handoff boundary.
- `dev/ARCHITECTURE.md`
  - update the assistant-final durability / migration note if the implementation changes the stated client-vs-broker ownership contract.

## Acceptance Criteria

- `src/extension.ts` is reduced below 1,000 lines without creating a new god file or any TypeScript source file over the project limit.
- Client final handoff has one cohesive owner module/interface. `src/extension.ts` should not directly own the full combination of retry queue, disk replay file format, stale-connection replay filtering, deferred-payload persistence, and broker IPC retry policy.
- Final durability ownership is explicit: broker-owned durable final state begins at successful `AssistantFinalDeliveryLedger.accept(...)`; any remaining client-side persistence is documented and tested as pre-acceptance handoff protection only.
- Ambiguous broker handoff, broker turnover, Telegram `retry_after`, and duplicate/redelivered final-handoff attempts do not create duplicate broker ledger entries or duplicate visible Telegram finals.
- Deferred retry-aware finalization still behaves as before: transient assistant/provider errors without useful final text defer Telegram finalization, later successful finals win, exhausted/no-retry cases produce one clear terminal failure, and `/stop` during the deferred window releases the turn without blocking queued work.
- Stale connection replacement has one final-handoff rule. If the superseded client may hand off pending final data under a stand-down fence, that rule is centralized in the handoff module and covered by a focused check; otherwise stale clients stand down without mutating broker-visible final state.
- Existing user-visible final behavior is preserved: FIFO final delivery, `retry_after` handling, preview/final deduplication, message-thread preservation, long-text chunking, Markdown fallback behavior, attachment progress, and terminal Telegram failure classification remain intact.
- Follow-up concerns are not made worse: cleanup policy and preview refs should not gain new duplicate branches as part of this extraction.

## Out of Scope

- Do not redesign all Telegram reliability orchestration in this task.
- Do not centralize broker session cleanup, preview-store semantics, pending-turn route rehome, manual compaction, busy-message steering, or `/follow` queueing unless directly required by the final-handoff extraction.
- Do not add new Telegram commands or new user-visible reliability features.
- Do not redesign paired-user authorization, pairing, Telegram polling, attachment safety, topic naming, or model/session commands.
- Do not introduce an external broker daemon, hosted relay, webhook mode, or a second execution authority.
- Do not remove the broker final ledger or weaken FIFO/retry-after final delivery guarantees.
- Do not weaken Telegram Bot API constraints documented in `docs.md`.

## Validation

- Run `npm run check` before reporting implementation complete.
- Add or extend a focused check for the final-handoff owner module. The check should prove at least:
  - repeated/ambiguous client-to-broker handoff for the same turn does not duplicate broker final ledger work;
  - client-side persisted pending finals, if still present, are replayed only until broker acceptance and are removed or ignored afterward;
  - stale-connection replacement either blocks final mutation or allows only the documented narrow handoff exception.
- Preserve existing focused checks around final delivery, retry-aware finalization, client abort/deferred retry behavior, preview manager behavior, and session route cleanup.
- Inspect dependency direction after the refactor: `src/extension.ts` composes modules; client modules depend on shared types/utilities and injected broker-posting functions; broker final delivery remains under `src/broker/finals.ts`; shared modules do not import broker/client/pi/Telegram policy.

## Pre-edit impact preview

Expected blast radius is medium-high but deliberately narrower than the full inbox item. Likely edits are under `src/extension.ts`, `src/client/final-delivery.ts` or a new `src/client/final-handoff.ts`, `src/client/retry-aware-finalization.ts`, `src/client/route-shutdown.ts`, `src/client/abort-turn.ts`, check scripts, and possibly `dev/ARCHITECTURE.md`. The main risks are losing a final before broker acceptance, duplicating a final after ambiguous handoff, blocking queued work during deferred retry/final-handoff windows, or accidentally moving broker final-ledger responsibilities back into the client.

## Follow-up candidates

After this first slice, separately plan smaller tasks for:

- broker-side cleanup policy consolidation across explicit disconnect, offline/reconnect-grace expiry, post-final route cleanup, pending preview cleanup, and topic deletion retry;
- preview refs as a shallow best-effort/dedup store rather than a correctness mechanism;
- broader client turn-lifecycle consolidation for active turns, queued turns, awaiting-final state, manual compaction, and start-next-turn gating.

## Decisions

- 2026-04-26: Plan this as a maintainability refactor whose success is simpler ownership and less duplicated/parallel lifecycle machinery, not as a broad reliability feature expansion.
- 2026-04-26: Implemented the first handoff slice by moving client-side assistant-final pre-acceptance handoff into src/client/final-handoff.ts. The broker final ledger remains the durable delivery owner after acceptance; client persistence now protects only pre-broker-acceptance handoff, including stale-stand-down races via prepared/disk-only payload handling and pending-final file locking.
