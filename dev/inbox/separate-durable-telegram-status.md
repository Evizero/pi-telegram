---
title: "Separate durable Telegram status from event diagnostics"
type: "request"
created: "2026-05-03"
author: "Christof Salis"
status: "planned"
planned_as: ["separate-durable-telegram-footer"]
---
User noticed brief pi-telegram footer/statusbar messages and suggested the footer should show the overall durable Telegram bridge status only. Event-like status/errors should instead be printed to history/displayed like the Telegram /status-style diagnostic surface, and perhaps use notify when appropriate.

Source context from discussion:
- Current code reuses ctx.ui.setStatus("telegram", ...) both for durable connection/broker status and transient error/diagnostic details.
- Poll-loop errors intentionally flash in status and then clear after retry delay.
- User preference: durable status in footer; event-like information should go to history and maybe notification rather than replacing durable status.

Follow-up technical finding: pi.sendMessage creates a CustomMessageEntry/custom message, and custom messages are converted to LLM user messages in session context. Therefore using pi.sendMessage({ display: true }, { triggerTurn: false }) is not just display/history; it can pollute future LLM context. For event diagnostics that should not influence the agent, prefer ctx.ui.notify, durable status/widget surfaces, or a non-context persistence/display mechanism rather than sendMessage.

Grounded planning note: use the same user-facing mechanism as `/telegram-status`, not pi.sendMessage. In the current bootstrap command registration, `/telegram-status` calls `ctx.ui.notify(..., "info")` after loading runtime and setting latest context (`src/bootstrap.ts:154-160`). `/telegram-broker-status` also uses `ctx.ui.notify(..., "info")` (`src/bootstrap.ts:163-172`). The older split command module has the same pattern (`src/pi/commands.ts:70-86`).

Implication for the eventual plan:
- Durable footer/statusbar should be limited to `updateStatus`/`telegramStatusText` durable states (`src/extension.ts:343-355`, `src/shared/ui-status.ts:15-35`).
- Event-like diagnostics should be routed to `ctx.ui.notify(message, severity)` like `/telegram-status`, not through `pi.sendMessage`. `notify` is documented as a fire-and-forget extension UI request (`docs/rpc.md` notify/setStatus sections) and does not create a session custom message.
- Existing `createPiDiagnosticReporter` currently does three different things: `statusDetail` updates footer, `notify` calls `ctx.ui.notify`, and `display` calls `pi.sendMessage({ customType: "telegram_diagnostic", display: true }, { triggerTurn: false })` (`src/pi/diagnostics.ts:20-28`). Planning should consider replacing/removing the `display` path for diagnostics because custom messages enter LLM context.
- `updateStatus(ctx, error)` and `statusDetail` are the main surfaces to eliminate or narrow; raw error/detail strings should not replace durable footer text.

Open planning question: whether all event diagnostics should notify, or whether low-severity/retryable background events should be suppressed/deduped while only user-actionable or repeated/terminal failures notify.
