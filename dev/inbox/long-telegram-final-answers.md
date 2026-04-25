---
title: "Long Telegram final answers can duplicate"
type: "bug"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["implement-durable-idempotent-final"]
---
Telegram voice note on 2026-04-25 reported that longer agent answers still regularly arrive duplicated in Telegram after long runs with lots of activity; sometimes the same final response appears more than twice.

Transcribed source wording:

> I still regularly especially for longer agent answers get duplicated responses from the agent after he's a long run with lots of activity and in the end the agent message arrives sometimes even more than two times. Do we have this already fixed? There's an open inbox item for this.

Triage note: there is an archived planned/done item `final-delivery-retry-queue` that fixed FIFO retry ordering and terminal failures, plus requirements around `SyRS-final-preview-deduplication` and `SyRS-final-delivery-fifo-retry`. There is no live inbox item specifically tracking the still-observed duplicate visible final responses for long activity-heavy runs as of this capture.


## Deep-dive findings — 2026-04-25

Likely root cause: final delivery is not idempotent after partial visible Telegram output. Long final answers are chunked; `PreviewManager.finalizeChunked()` can edit/send the first chunk and then deletes preview state before sending remaining chunks. If a later chunk, attachment, IPC response, broker persistence, network call, or rate-limit-delayed operation fails before `completedTurnIds` is persisted, a later retry re-enters final delivery without a per-chunk progress ledger and can send the final from the beginning again. Repeated partial failures can produce more than two visible copies.

Strong amplifier: client-to-broker IPC has a hard 5 second timeout (`src/shared/ipc.ts`), while the broker handles `assistant_final` synchronously and does activity completion, preview finalization, long final chunk sends, attachments, and persistence before replying. Long activity-heavy runs and Telegram retry windows can keep the broker busy beyond the IPC timeout; the client then treats the final as retryable while the broker may still be delivering it.

Why the previous archived `final-delivery-retry-queue` task is insufficient: it fixed FIFO retry ordering and terminal-failure classification for the in-memory client retry queue, but it did not add a broker-owned durable final-delivery ledger or chunk/attachment progress tracking. The architecture already documents assistant-final persistence/progress as a migration gap.

Fix direction: make assistant final delivery broker-owned, durable, and idempotent. On `assistant_final`, persist a pending final ledger entry and return IPC success after durable acceptance, then deliver from a broker retry loop that records text/chunk/attachment progress and resumes from the first unsent item. A smaller mitigation would increase/remove the IPC timeout for `assistant_final` and keep in-memory chunk progress until all chunks/attachments succeed, but that would not solve broker turnover or restart cases.

Secondary lower-confidence path: multiple `message_start` events for the same turn can cause `PreviewManager.messageStart()` to finalize an existing preview before the true final, potentially making pre-final text visible and then repeated by the final; investigate after the idempotent final-delivery gap.
