---
title: "Telegram final notification can appear twice without duplicate message"
type: "bug"
created: "2026-04-28"
author: ""
status: "planned"
planned_as: ["silence-streamed-assistant-preview", "send-assistant-text-only-at-final"]
---
User report (2026-04-28): after an agent finishes, Telegram sometimes appears to notify twice for the final agent message. The final message itself exists only once, but the Telegram client sometimes shows a disappearing/reappearing animation, as if a message was deleted and then appeared again. User suspects this may be unrelated to the activity flush stall and asked whether the bridge does anything like delete/re-send around final delivery.

## Investigation notes (2026-04-28)

Code inspection confirms the bridge can intentionally create the visible Telegram pattern described: a streaming assistant preview is sent as a real Telegram message, then final delivery deletes that preview and sends the final answer as a fresh message. The final message is not duplicated in durable final delivery; the visible animation can be preview deletion plus final send.

Evidence:

- `src/telegram/previews.ts` uses real `sendMessage` for visible previews because `shouldUseDraft()` currently returns false. Preview `sendMessage` bodies do not set `disable_notification`.
- `src/broker/finals.ts` final delivery calls `cleanupPreviewBeforeFinal()`, which detaches a message-mode preview and calls `deleteMessage` before `sendMarkdownMessage()` sends the final text as a new message.
- `scripts/check-final-delivery.ts` has regression coverage expecting the sequence `deleteMessage` for preview message ID 44 followed by `sendMessage` for final text.
- Activity messages are explicitly silent (`disable_notification: true`), but preview and final text sends are not silent.

Initial conclusion: this is likely current designed behavior from preview cleanup/final chronology, not a duplicate final-ledger send. It may still be undesirable UX if Telegram notifies for both the preview and final replacement.

## Deep-dive trace (2026-04-28)

End-to-end code path:

1. `src/pi/hooks.ts` posts `assistant_message_start` on assistant start and `assistant_preview` during assistant text streaming.
2. `src/extension.ts` routes those IPC messages to `PreviewManager.messageStart()` and `PreviewManager.preview()`.
3. `src/telegram/previews.ts` waits `PREVIEW_THROTTLE_MS` (750 ms), then sends a visible preview via `sendMessage` when no preview message exists. Preview send bodies do not include `disable_notification`.
4. At `agent_end`, `src/pi/hooks.ts` prepares and flushes the final, then `RetryAwareTelegramTurnFinalizer` hands it to the broker final ledger.
5. `src/broker/finals.ts` completes activity, stops typing, detaches any preview state, deletes a message-mode preview with `deleteMessage`, and then sends the final text as a new `sendMessage`.
6. `AssistantFinalDeliveryLedger.accept()` is idempotent by turn ID, so repeated final handoff does not create a second delivery job. Sent chunk indexes/message IDs prevent retry from resending already recorded final chunks.

Targeted runtime simulation against the compiled modules confirmed two cases:

- If the preview has already flushed before final delivery, Telegram API calls are:
  - `sendMessage` preview text, `disable_notification` absent
  - `deleteMessage` preview message ID
  - `sendMessage` final text, `disable_notification` absent
- If final delivery happens before the 750 ms preview throttle flushes, Telegram API calls are only:
  - `sendMessage` final text, `disable_notification` absent

Existing regression checks agree:

- `scripts/check-preview-manager.ts` expects preview finalize/replacement to call preview `sendMessage`, then `deleteMessage`, then final reply.
- `scripts/check-final-delivery.ts` expects durable preview cleanup to call `deleteMessage` before final `sendMessage`.
- `node scripts/run-activity-check.mjs` passed after inspection, including final-delivery and preview-manager checks.

Conclusion: the disappearing/reappearing Telegram animation is a confirmed consequence of current preview/final design whenever a visible assistant preview has already been posted. The intermittent nature is explained by the 750 ms preview throttle: short/fast replies skip the visible preview and only send the final; longer replies post a visible preview, then replace it by delete+fresh final send. This does not appear to be duplicate final-ledger delivery.

Open UX question: whether visible assistant preview messages should be silent (`disable_notification: true`), draft-backed, edited into final where safe, or otherwise rendered differently to avoid a second perceived notification/replacement animation.


## Supersession note (2026-04-28)

The initially planned task `silence-streamed-assistant-preview` was rejected before implementation after the project owner changed direction toward not streaming assistant text previews at all. The replacement planned work is `send-assistant-text-only-at-final`, sourced from `stop-streaming-assistant-text`, and it should be treated as the active resolution path for this original double-notification report.
