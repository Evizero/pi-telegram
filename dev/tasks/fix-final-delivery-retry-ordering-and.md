---
title: "Fix final delivery retry ordering and terminal failures"
status: "done"
priority: 2
created: "2026-04-25"
updated: "2026-04-25"
author: "telegram-voice"
assignee: "pi-agent"
labels: ["telegram", "delivery", "retry"]
traces_to: ["SyRS-final-delivery-fifo-retry", "SyRS-telegram-retry-after"]
source_inbox: "final-delivery-retry-queue"
branch: "task/fix-final-delivery-retry-ordering-and"
---
## Objective

Fix assistant-final retry handling so queued final responses preserve FIFO order and cannot be blocked forever by a permanent non-retryable delivery failure.

The immediate bug is in the current in-process client-to-broker final queue, not the larger documented migration gap for persisted final-delivery ledgers across broker process loss.
This task should improve current runtime correctness while staying compatible with the future durable final-ledger architecture.

## Source

Planned from inbox item `final-delivery-retry-queue`.

The review finding was that final delivery retry handling can both bypass FIFO and poison the queue:

- failed older finals can be requeued without stopping replay of newer finals;
- permanent non-retryable failures can be requeued indefinitely and block later finals.

## Requirements

Primary trace:

- `SyRS-final-delivery-fifo-retry` — final responses remain retryable in FIFO order until successful Telegram delivery or explicit non-retryable terminal outcome.

Related constraint:

- `SyRS-telegram-retry-after` — Telegram `retry_after` must delay retry without bypassing older queued work.

Preserve nearby behavior from:

- `SyRS-final-preview-deduplication` — do not duplicate preview text, final chunks, or attachment notifications while changing retry behavior.

## Codebase grounding

Likely touchpoints:

- `src/extension.ts`
  - `pendingAssistantFinals`
  - `pendingAssistantFinalRetryAtMs`
  - `queuePendingAssistantFinal(...)`
  - `sendAssistantFinalToBroker(...)`
  - `retryPendingAssistantFinals(...)`
  - `handleAssistantFinal(...)`
- `src/pi/hooks.ts` is relevant because it marks local Telegram turns complete after producing an assistant final; preserve that local dedupe behavior.
- `src/telegram/api.ts` may be useful for Telegram error classification helpers.
- `src/shared/types.ts` may need a small type if terminal final outcomes are represented explicitly.
- A new cohesive helper module is likely preferable if the fix needs meaningful new control-flow or classification logic, because `src/extension.ts` is already about 991 lines and close to the 1,000-line guardrail.

Current behavior to inspect:

- `retryPendingAssistantFinals()` drains the queue and only stops replay when `pendingAssistantFinalRetryAtMs` is set.
- `sendAssistantFinalToBroker()` can requeue a failed item for non-`retry_after` broker/Telegram failures without telling the caller whether replay should stop.
- terminal non-retryable final-delivery outcomes are not clearly recorded or reported.

## Implementation constraints

- Preserve FIFO: once an older final fails and remains retryable, newer finals must stay behind it.
- Preserve `retry_after`: when Telegram supplies a retry window, do not treat it as terminal and do not let later finals bypass the delayed item.
- Add an explicit terminal path for deterministic non-retryable final-delivery failures so one poisoned item cannot block all later finals forever.
- Treat broker/IPC transport failures and unknown failures as retryable unless the code can prove they are terminal; do not classify every non-`retry_after` error as terminal.
- Only explicitly classified deterministic Telegram delivery failures, such as invalid/deleted chat or unrecoverable route/message-thread errors, should become terminal outcomes in this slice.
- Distinguish local turn-completion dedupe from broker final-delivery completion: the client may still remember a local turn as completed once the assistant final is produced so redelivered turns do not re-execute, while broker-side completion or terminal recording must wait for Telegram delivery or explicit terminal failure.
- Do not broaden this task into durable cross-process persistence of assistant-final payloads; that remains the architecture migration gap for a later task.
- Do not rewrite preview/chunking behavior except as needed to preserve no-duplicate final delivery semantics.
- Keep `src/extension.ts` under the 1,000-line guardrail. Because it is already about 991 lines, any meaningful new classification or replay logic should be extracted to a cohesive helper/module rather than added inline.

## Acceptance criteria

- A failed older final that is still retryable prevents replay/delivery of newer queued finals until it is retried or reaches a terminal outcome.
- Telegram `retry_after` during final delivery sets a retry delay and preserves FIFO ordering behind the delayed final.
- A deterministic non-retryable Telegram delivery failure is converted into an explicit terminal outcome, removed from the retry queue, and does not permanently block later finals.
- Broker/IPC transport failures and unknown final-delivery errors remain retryable and keep later finals queued behind the failed older final.
- Successful final delivery still removes the corresponding pending final and does not duplicate already-finalized preview text or attachment notifications.
- Existing local completed-turn dedupe remains compatible with pending final retry and terminal outcomes; redelivered turns should not re-execute merely because Telegram final delivery is still pending.
- The implementation records or reports terminal final failure enough for later inspection/debugging without leaking secrets.

## Validation

- Run `npm run check`.
- Run `pln hygiene` after task/planning updates.
- Add focused regression coverage if a practical test harness is introduced in this slice; otherwise perform code inspection against the acceptance criteria and document the inspected paths in the implementation summary.
- Exercise or reason through these cases explicitly:
  1. first queued final gets Telegram `retry_after`, second queued final remains queued behind it;
  2. first queued final hits transient broker/IPC failure without `retry_after`, second queued final remains queued behind it;
  3. first queued final reaches terminal non-retryable failure, second queued final can proceed;
  4. successful final delivery still clears pending state once and does not duplicate preview chunks.

## Out of scope

- Persisting assistant-final payloads across broker process loss.
- Persisting selector-mode `/use` selections.
- Fixing disconnect lifecycle, route identity, token-file permissions, outbound credential filtering, setup `getMe`, `sendPhoto` fallback, or typing-loop retry overlap.
- Changing user-facing command semantics unrelated to assistant-final retry.

## Decisions

- 2026-04-25: Extracted assistant-final queue state and terminal Telegram delivery classification into src/client/final-delivery.ts so src/extension.ts stays below the 1,000-line guardrail. Broker/IPC and unknown errors remain retryable; only explicitly classified Telegram delivery errors are terminal, and local completed-turn dedupe remains separate from broker final completion.
- 2026-04-25: Kept queued finals visible while a retry attempt is in flight: AssistantFinalRetryQueue now tracks the head attempt without draining the queue, so newly produced finals defer behind the older item and retryable failures remain at the head. Validation passed with npm run check, pln hygiene, and a clean review subagent pass.
- 2026-04-25: Close-out checked the implementation against SyRS-final-delivery-fifo-retry, SyRS-telegram-retry-after, SyRS-final-preview-deduplication, and dev/ARCHITECTURE.md. Acceptance is satisfied by the in-memory FIFO retry queue, conservative terminal Telegram classification, retry_after delay preservation, local completed-turn dedupe preservation, terminal broker completion recording, and extension.ts staying below 1,000 lines. Updated architecture repository mapping for src/client/final-delivery.ts.
