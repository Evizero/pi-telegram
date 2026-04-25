---
title: "Final delivery retry queue should preserve FIFO and terminal failures"
type: "bug"
created: "2026-04-25"
author: "telegram-voice"
status: "planned"
planned_as: ["fix-final-delivery-retry-ordering-and"]
---
Source: Telegram voice note transcribed as: “Read the inbox item skill and create inbox items accordingly.”

Review finding: final delivery retry handling can both bypass FIFO and poison the queue. Failed older finals can be requeued without stopping replay of newer finals, and permanent non-retryable failures can block later finals indefinitely.

Evidence:
- `src/extension.ts` `retryPendingAssistantFinals()` only stops replay when `pendingAssistantFinalRetryAtMs` is set.
- `sendAssistantFinalToBroker()` requeues failures without clearly classifying terminal non-retryable outcomes.

Requirement: `SyRS-final-delivery-fifo-retry`.

Fix direction: classify retryable vs terminal final delivery failures; stop replay after any failed/requeued older final; drop/report terminal failures so later FIFO items can proceed.
