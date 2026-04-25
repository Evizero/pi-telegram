---
title: "Implement durable idempotent final delivery"
status: "done"
priority: 1
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: ["telegram", "delivery", "retry", "durability"]
traces_to: ["SyRS-final-delivery-fifo-retry", "SyRS-final-preview-deduplication", "SyRS-telegram-retry-after", "SyRS-topic-routes-per-session", "SyRS-telegram-text-method-contracts", "SyRS-outbound-attachment-safety", "SyRS-outbound-photo-document-rules", "SyRS-explicit-artifact-return"]
source_inbox: "long-telegram-final-answers"
branch: "task/implement-durable-idempotent-final"
---
## Objective

Stop long Telegram final answers from duplicating by moving assistant-final delivery to a broker-owned, durable, retry-safe delivery ledger that can resume after partial visible Telegram output instead of resending from the beginning.

This task addresses the still-observed duplicate-final symptom captured in `long-telegram-final-answers`. The previous `fix-final-delivery-retry-ordering-and` task fixed FIFO retry ordering and terminal failure classification, but it did not make visible Telegram final delivery idempotent after partial chunk or attachment success.

## Scope

- Add a persisted broker-state assistant-final delivery ledger, e.g. `pendingAssistantFinals`, that records final payloads before any visible Telegram final text or attachment is sent and uses stable turn/final identity to make repeated `assistant_final` handoffs idempotent.
- Change `assistant_final` IPC handling so the broker durably accepts a final and replies quickly, instead of keeping the client request open until all Telegram delivery steps finish.
- Add a broker-side delivery/retry loop that processes pending assistant finals in FIFO order and resumes retryable work after broker startup, broker takeover, and retry windows.
- Track progress for visible delivery phases so retries skip already-completed work:
  - activity completion / typing stop where relevant;
  - preview clear/edit/send state;
  - deterministic final text chunks and text identity/hash;
  - first chunk edited or sent;
  - remaining sent chunk indexes and Telegram message IDs where useful;
  - sent attachment indexes and terminal attachment outcomes where applicable.
- Persist progress after each successful visible Telegram step so the retry window that can duplicate output is minimized.
- Preserve explicit terminal outcomes for deterministic non-retryable Telegram delivery errors so poisoned finals do not block later finals forever.
- Keep successful final delivery and terminal failure as the only conditions that move the turn to completed broker state and remove the pending final ledger entry.
- Add focused regression coverage for long final chunk retry, IPC timeout/slow delivery acceptance, attachment-after-text retry, retry_after ordering, and broker reload/resume behavior where practical.

## Codebase grounding

Likely runtime touchpoints:

- `src/shared/types.ts` — add durable broker-state types for pending assistant final deliveries and progress.
- `src/shared/config.ts` — add any final-delivery retry/backoff timing constants if needed.
- `src/extension.ts` — replace synchronous `handleAssistantFinal()` delivery with durable acceptance plus broker delivery orchestration; start/retry pending final delivery from broker startup/heartbeat paths without growing the file past 1,000 lines.
- `src/broker/` — add a cohesive module such as `src/broker/finals.ts` for final ledger acceptance, FIFO selection, progress persistence, and delivery state transitions.
- `src/client/final-delivery.ts` — shrink or adapt the client-side retry queue so it only covers broker-acceptance failures; avoid keeping client IPC open for Telegram delivery.
- `src/telegram/previews.ts` — split preview/live streaming concerns from durable final text delivery, or expose narrow helpers so final chunk delivery can be driven from persisted broker progress.
- `src/telegram/attachments.ts` — make outbound attachment delivery cooperate with per-attachment progress so retrying an attachment does not resend final text.
- `scripts/check-pairing-and-format.ts`, a new focused check script, or existing activity checks — add deterministic tests for the ledger/progress behavior.
- `dev/ARCHITECTURE.md` and `docs.md` — update if implementation changes the documented final-delivery ownership, ledger schema, or retry behavior.

## Acceptance Criteria

- The broker persists an assistant-final delivery record before sending any final text chunk or attachment to Telegram.
- `assistant_final` IPC returns after durable broker acceptance; slow Telegram final delivery, `retry_after`, long chunking, or attachment upload does not by itself cause the client to enqueue a duplicate final.
- If the broker receives a repeated `assistant_final` handoff for a turn/final that is already pending, delivering, delivered, or terminal, it acknowledges or reconciles that handoff by stable identity without creating a second ledger entry or resending already-visible output.
- Long final text split into multiple Telegram chunks resumes from stored progress after a retryable failure and does not resend chunks already recorded as delivered.
- If final text delivery succeeds and a later attachment fails retryably, retry resumes with the attachment phase and does not resend final text.
- Telegram `retry_after` during any final delivery phase delays the oldest pending final and prevents newer finals from bypassing it.
- Broker restart or broker takeover reloads pending final records and resumes retryable final delivery in FIFO order from recorded progress.
- Deterministic non-retryable Telegram final-delivery failures record a terminal outcome, remove or close the pending ledger entry, mark the broker turn completed, and allow later finals to proceed.
- Broker final-delivery completion state is not updated merely because the broker accepted the final; broker-side turn completion for final delivery is recorded only after delivered or explicit terminal outcome.
- Existing preview behavior for short finals, long finals, error/aborted turns, route/thread preservation, and final-preview deduplication remains intact.
- Existing local/client consumed-turn dedupe remains distinct from broker final-delivery completion and still prevents re-executing a Telegram-originated turn while final delivery is pending or retrying.
- No TypeScript source file exceeds the 1,000-line guardrail; new final-delivery policy lives in a cohesive module rather than expanding `src/extension.ts` substantially.

## Preserved Behavior and Neighboring Requirements

- Preserve `SyRS-final-delivery-fifo-retry`: final responses remain retryable in FIFO order until delivered or terminal.
- Preserve `SyRS-final-preview-deduplication`: previews, final chunks, fallback sends, and attachment notifications must not duplicate visible output.
- Preserve `SyRS-telegram-retry-after`: retry_after is a control signal; do not fall back, immediately retry, or let newer finals bypass the delayed final.
- Preserve `SyRS-topic-routes-per-session`: every send/edit/delete/upload remains scoped to the original route and `message_thread_id`.
- Preserve `SyRS-telegram-text-method-contracts`: non-empty text, chunking below Telegram limits, and draft/message method constraints still apply.
- Preserve `SyRS-explicit-artifact-return`: queued outbound attachments still travel with the associated assistant reply or produce a visible failure report; this task changes retry/progress semantics, not the explicit pi attachment intent rule.
- Preserve attachment safety and photo/document rules; this task changes delivery retry/progress semantics, not outbound path authorization or media method contracts.

## Out of Scope

- Redesigning activity rendering except where activity completion must be recorded as part of final delivery progress.
- Changing Telegram turn creation, authorization, pairing, topic setup, or session selection semantics.
- Adding multi-user access control or a hosted relay.
- Guaranteeing mathematically perfect exactly-once delivery across a crash that occurs after Telegram accepts a send but before local progress is persisted; the goal is practical idempotent resume with persisted progress after every acknowledged visible step.
- Reworking inbound media groups, update offset handling, or unrelated broker durability issues.

## Validation

Run `npm run check` and add focused regression coverage for the new final-delivery ledger. At minimum, cover or explicitly inspect these cases:

1. A long final has chunks 0 and 1 recorded as sent, chunk 2 fails retryably, and retry sends only chunk 2+.
2. A final text phase completes, attachment 0 fails retryably, and retry sends attachment 0 without resending final text; a terminal attachment failure is reported visibly with the associated assistant reply rather than silently dropping the queued artifact.
3. Broker acceptance returns before simulated slow Telegram delivery completes, and client retry logic does not enqueue a duplicate final.
4. A repeated `assistant_final` handoff after ambiguous IPC timeout, lost IPC response, or broker restart/takeover does not create a second ledger entry or resend already-recorded visible output.
5. A retry_after during final delivery keeps the oldest final pending and blocks newer finals until the retry window clears.
6. A terminal Telegram error marks the final terminal/completed and allows later queued finals to proceed.
7. A broker reload/takeover with a persisted pending final resumes from recorded progress.
8. A duplicate or redelivered Telegram turn whose assistant final is still pending/retrying is not re-executed locally and does not create an additional broker final-delivery ledger entry.

Use unit-style tests around the final-delivery module where possible, with Telegram calls represented by deterministic fakes. Keep integration-level checks for route/thread preservation, chunk sizing, and existing activity/final rendering expectations.

## Pre-edit impact preview

- Blast radius: shared broker state schema, broker final delivery, client final handoff, preview finalization, attachment send retry, and validation scripts.
- Main risks: accidentally marking turns completed before Telegram delivery, resending already-visible chunks, bypassing FIFO on retry_after, losing route/thread context, or growing `src/extension.ts` past the project guardrail.
- Expected architecture impact: this should close the documented assistant-final durability migration gap by making final delivery a first-class broker-state concern.

## Decisions

- Planning decision: implement the clean fix rather than only increasing IPC timeout. Timeout changes may be useful as a mitigation, but they do not solve partial visible output, broker turnover, or attachment retry duplication.
- Planning decision: the durable ledger should be broker-owned because the broker owns Telegram delivery, route context, retry_after handling, and broker turnover recovery.
- 2026-04-25: Implemented a broker-owned pendingAssistantFinals ledger in BrokerState. assistant_final IPC now persists a final delivery record and returns after durable acceptance; broker delivery resumes from persisted text chunk and attachment progress, treats repeated assistant_final handoffs as idempotent by turn ID, and records completion only after delivered or terminal outcome. Final delivery uses raw Telegram calls so retry_after can be recorded on the ledger instead of blocking client IPC.
- 2026-04-25: Updated architecture from assistant-final durability migration gap to current-state broker ledger. Added focused final-delivery checks for duplicate handoff idempotency, chunk resume, attachment retry without text resend, and retry_after FIFO blocking. Validation passes with npm run check.
- 2026-04-25: Review found active final delivery could continue after broker shutdown/takeover and deleteMessage retry_after could be swallowed. Added final-ledger start/stop fencing with abort signals so stopped brokers do not continue beyond an in-flight visible step, and propagated retry_after from preview delete fallback before sending a replacement chunk. Added checks for broker-stop fencing and delete retry_after behavior.
- 2026-04-25: Second review found preview message IDs were only in memory and lease loss could allow an old broker to overlap a new broker. Added BrokerState.assistantPreviewMessages for visible preview message refs, final ledger fallback to durable preview refs after restart, broker-active lease checks before visible delivery steps, and retry-aware preview clearing. Expanded final-delivery checks for durable preview finalization and clear-preview retry_after.
- 2026-04-25: Third review found pending turns could be redelivered after final handoff and fallback sends needed broker-active checks between visible calls. Assistant-final acceptance now removes the corresponding pending turn while leaving broker completion pending until delivery/terminal outcome; turn_consumed no longer marks broker completion when a final ledger entry is pending; retryPendingTurns skips turns with pending finals. Added broker-active checks before fallback sends/edits/uploads.
