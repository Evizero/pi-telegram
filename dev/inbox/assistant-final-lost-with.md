---
title: "Assistant final lost with fetch failed while bridge stayed connected"
type: "bug"
created: "2026-04-26"
author: "Christof Salis"
status: "planned"
planned_as: ["keep-telegram-finals-pending-across-pi"]
---
Source: Telegram report on 2026-04-26:

> unrelated new inbox item: right now your last message did not arrive in telegram. telegram just got "fetch failed" the last activity t saw i read package.json

Follow-up detail:

> it is still connected though and further message like this one arrive there again. investigate this bug

Observed behavior:
- A previous assistant final response after planning silent notifications did not arrive in Telegram.
- Telegram instead showed only `fetch failed`.
- The last visible activity before the failure was reading `package.json`.
- The Telegram bridge remained connected and subsequent Telegram messages still arrived and routed correctly.

Initial hypothesis to investigate:
- A transient Telegram/API/network or broker handoff failure may have surfaced as a final user-visible `fetch failed` rather than preserving/retrying the assistant final until delivery.
- Need determine whether the failure occurred in assistant-final handoff, broker final ledger delivery, preview/finalization, or the Telegram API call path.


Investigation notes on 2026-04-26:
- Current broker state has no `pendingAssistantFinals` and no `assistantPreviewMessages`, so the missing final is not currently queued for retry in durable broker state.
- Broker state does show recent completed turn IDs, which suggests the broker considered the relevant final-delivery work complete rather than pending.
- Code path likely involved:
  - `src/pi/hooks.ts` `agent_end` extracts `{ text, stopReason, errorMessage }` via `extractAssistantText(...)` and sends all three to the broker as `assistant_final`.
  - `src/broker/finals.ts` `AssistantFinalDeliveryLedger.deliver()` checks `entry.stopReason === "error"` before considering `entry.text` and sends `entry.errorMessage || "Telegram bridge: pi failed while processing the request."`.
  - Therefore, if pi reported `stopReason: "error"` with `errorMessage: "fetch failed"`, Telegram would receive exactly `fetch failed` even if the local UI eventually showed or retained assistant text.
- Telegram API send failures named `fetch failed` should normally be retryable in `AssistantFinalDeliveryLedger.process()`, not visibly delivered as the message body. Seeing `fetch failed` as Telegram text therefore points more strongly to the pi/assistant error-message path than the Telegram-send failure path.
- This area lacks a focused regression case for an assistant final payload that contains both text and `stopReason: "error"` / `errorMessage`; current behavior prioritizes the error message and discards the text for Telegram delivery.

Possible fix direction:
- Decide whether assistant text should be delivered when present even if `stopReason === "error"`, perhaps with a short failure suffix, instead of replacing it with the raw error message.
- At minimum, avoid exposing low-context raw errors like `fetch failed` as the entire Telegram final when useful assistant text exists or was previewed.
- Add regression coverage around `AssistantFinalDeliveryLedger.deliver()` for error finals with text, error finals without text, and retryable Telegram `fetch failed` send failures to keep these cases distinct.


Additional user clarification on 2026-04-26:
- In pi, the turn looked normal: the user saw the normal assistant message and no error.
- Only Telegram showed `fetch failed` instead of the normal final.

Updated interpretation:
- This makes a pure visible pi failure less likely, but it does not rule out hidden assistant metadata such as `stopReason: "error"` / `errorMessage: "fetch failed"` being present alongside normal text in the final message object.
- The current broker final-delivery logic would still discard `entry.text` whenever `entry.stopReason === "error"`, so a payload containing both normal text and an error flag would reproduce exactly this user-visible split: pi shows useful text while Telegram shows only the raw error message.
- A focused fix should prefer useful assistant text when present, and only use the raw error fallback when no final text is available. The regression test should assert that `stopReason: "error"` with non-empty `text` delivers the text, not just `errorMessage`.


Additional user clarification on 2026-04-26:
- The same Telegram-only final replacement sometimes appears as `terminated` or similar instead of `fetch failed`.
- This is another low-context raw stop/error reason shown in Telegram while the local pi session may look normal.

Updated investigation implication:
- The bug is probably broader than one network error string. Telegram final delivery may be exposing raw `stopReason` / `errorMessage` metadata or bridge fallback text in place of useful assistant text.
- Regression coverage should include multiple low-context error/stop strings such as `fetch failed` and `terminated`, and assert that non-empty assistant final text wins over raw error metadata for Telegram delivery.


Deep-dive investigation on 2026-04-26:

Evidence from code inspection:
- `pi-agent-core` emits `agent_end` for every assistant loop termination, including transient provider errors whose assistant message has `stopReason: "error"` and an `errorMessage` such as `fetch failed` or `terminated`.
- `pi-coding-agent` auto-retry is implemented one layer above that event. In `AgentSession._processAgentEvent()`, extension handlers are invoked before session-level retry handling. The retry detector explicitly treats `fetch failed` and `terminated` as retryable transient errors.
- `src/pi/hooks.ts` handles every `agent_end` immediately. If an active Telegram turn exists, it extracts the last assistant message and calls `sendAssistantFinalToBroker(...)`, then marks the turn completed locally and clears `activeTelegramTurn`.
- `src/broker/finals.ts` then gives `stopReason === "error"` precedence over `entry.text`, clears any preview, sends `entry.errorMessage` as the Telegram final, and marks the final complete. That explains why broker state later has no `pendingAssistantFinals` / `assistantPreviewMessages` for the failed turn.

Most likely root cause:
- The Telegram bridge treats the first transient `agent_end` error as the final answer before pi's built-in auto-retry has a chance to run. The local pi UI/session can then retry and eventually show a normal assistant answer, but the bridge has already sent `fetch failed` / `terminated` to Telegram, cleared the active Telegram turn, and completed the broker final. The successful retry response is no longer associated with the Telegram turn, so Telegram never receives it.

Secondary contributing behavior:
- Even without auto-retry, if a final assistant message contains useful text plus `stopReason: "error"`, the final ledger currently discards the text and sends only the raw error string. This can lose partial useful answers and makes low-context provider/transport strings visible as the whole Telegram final.

Less likely but still possible causes reviewed:
- Telegram Bot API send failure: unlikely for this observed symptom because a failed `sendMessage`/`editMessageText` in `AssistantFinalDeliveryLedger.process()` normally leaves the final pending for retry; it does not turn the transport error into message text unless the error came from the assistant payload itself.
- Markdown parse fallback: unlikely because Markdown failures retry as plain text, and `retry_after` is propagated. It would not manufacture `fetch failed`/`terminated`.
- Broker failover or IPC handoff ambiguity: possible for lost finals generally, but less consistent here because the exact low-context string reached Telegram and the broker had no pending final afterwards, indicating the broker accepted and completed a final payload.
- Preview manager loss: possible for preview/final mismatches generally, but the observed `fetch failed` text points to explicit error-final delivery after preview clearing, not a preview flush failure.
- Route/session cleanup or disconnect: less likely because the bridge stayed connected and later messages routed correctly. Cleanup can delete pending final state for a session, but it would not explain delivery of exactly `fetch failed` as a Telegram message.
- Activity renderer failure: unlikely because activity messages are separate, best-effort status rendering; the final replacement happens in assistant final delivery.

Fix direction to plan:
- Make Telegram final delivery retry-aware with respect to pi's agent-level auto-retry. The bridge should not finalize/complete a Telegram turn on a retryable assistant provider error that pi will auto-retry. It should keep the Telegram turn active or defer final handoff until retry success/final failure is known.
- If extension APIs do not expose `auto_retry_start`/`auto_retry_end`, the bridge can conservatively recognize the same retryable error strings (`fetch failed`, `terminated`, 429/5xx/network/timeout/etc.) at `agent_end` and hold the turn instead of sending that raw error immediately, with a safe fallback for non-retryable errors.
- Change final text selection so non-empty assistant text wins over raw `errorMessage` for Telegram, optionally appending a concise error note, while error-only finals still send a clear failure message.
- Add regression tests for: retryable `agent_end` should not complete Telegram final prematurely; `stopReason: error` with non-empty text should deliver text; error-only finals still notify; Telegram API `fetch failed` during send remains retryable pending state; successful retry after a transient first error is the Telegram-visible final.
