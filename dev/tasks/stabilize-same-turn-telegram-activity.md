---
title: "Stabilize same-turn Telegram activity message continuity"
status: "done"
priority: 1
created: "2026-05-02"
updated: "2026-05-02"
author: "Christof Salis"
assignee: ""
labels: ["bug", "activity", "telegram", "reliability"]
traces_to: ["SyRS-activity-message-continuity"]
source_inbox: "activity-message-restarts-during"
branch: "task/stabilize-same-turn-telegram-activity"
---
## Objective

Stop Telegram Activity bubbles from restarting or accumulating during one logical active pi turn. A same-turn activity stream should continue in one visible Activity message until a real boundary occurs: final delivery, explicit activity segmentation, an ordinary user-visible interleaving message/control that justifies a new bubble, or terminal cleanup.

This task is planned from `dev/inbox/activity-message-restarts-during.md` and traces to `SyRS-activity-message-continuity`.

## Problem summary

The current renderer creates a fresh Activity Telegram message whenever its activity state lacks `messageId`. Code inspection and temporary repros showed multiple ways `messageId` can be absent while Telegram still shows an old Activity bubble:

- hidden/untitled thinking can leave `state.lines.length === 0`; `doFlush()` calls `deleteMessage(...).catch(() => undefined)` and then clears `state.messageId` even when delete failed or was ambiguous;
- initial activity `sendMessage(...).catch(() => undefined)` can be accepted by Telegram but fail before returning `message_id`, leaving the renderer without the id for a visible message;
- broker/renderer restart or `clearAllTimers()` loses the in-memory `ActivityRenderer.messages` map while the active turn continues and old Telegram Activity messages remain visible.

Successful hidden-thinking delete/recreate explains disappearing/reappearing activity, but screenshots with multiple old Activity bubbles still visible require treating message-id loss and renderer reset as first-class causes.

## Scope

Implement a continuity fix for the visible Telegram Activity message lifecycle:

- preserve same-turn Activity message identity when transient hidden/untitled working rows complete;
- stop discarding a known `messageId` after a failed or ambiguous `deleteMessage`;
- make activity send/delete/edit failures observable enough for future diagnosis without leaking secrets or spamming non-actionable user noise;
- address the broker/renderer reset path so continued activity for a still-active turn does not blindly start another visible Activity bubble when a prior visible Activity message can be known, recovered, or deliberately reconciled;
- update activity behavior checks so the intended same-turn continuity behavior is locked in.

A full solution may persist minimal active Activity render references in broker state, introduce a narrow recovery/reconciliation path, or choose another design that satisfies `SyRS-activity-message-continuity`. If the implementation adds durable activity-render state or changes broker-state ownership semantics, update `dev/ARCHITECTURE.md` in the same slice.

## Codebase grounding

Likely touchpoints:

- `src/broker/activity.ts` — `ActivityRenderer.handleUpdate()`, `doFlush()`, `flush()`, completion, deletion, and timer/reset behavior;
- `src/shared/activity-lines.ts` — active/completed hidden thinking line semantics if the chosen fix changes what becomes visible;
- `src/broker/types.ts` and broker state loading/persistence code — only if preserving Activity message references across broker turnover is the chosen design;
- `src/extension.ts` / broker lifecycle wiring — broker start/stop/reset paths that currently clear renderer state;
- `src/pi/activity.ts` and `src/bootstrap.ts` — activity source behavior only if event emission needs adjustment;
- `scripts/check-activity-rendering.ts` and related behavior-check harness code — regression coverage.

## Acceptance Criteria

- Same-turn untitled/hidden thinking start/end cycles followed by later tool or thinking activity do not produce repeated visible Activity `sendMessage` calls unless a legitimate boundary occurred.
- If an Activity `deleteMessage` fails or is ambiguous, the renderer does not clear the only known `messageId` and then start a new visible Activity bubble for the same logical activity.
- Ambiguous Activity `sendMessage` behavior is handled deliberately: either repeated visible sends are prevented by design, or the remaining irreducible ambiguity is documented, diagnosed, and bounded so it does not create unbounded Activity bubble churn.
- Broker/renderer reset or handoff during an active turn is covered by a regression or explicit design decision. If same-message recovery is feasible from durable state, the new renderer edits/cleans/reconciles the existing Activity message instead of starting over; if not feasible, the task documents the residual limitation and keeps the remaining behavior consistent with `SyRS-activity-message-continuity` as far as Telegram permits.
- Existing required behavior remains intact: activity event history is preserved, Telegram edits are still debounced, final responses remain non-duplicated, `message_thread_id` route context is preserved, `retry_after` is not bypassed, and passive Activity sends stay non-alerting.
- `npm run check` passes.

## Out of Scope

- Do not reintroduce live assistant-text streaming; Activity remains the live supervision surface and final assistant text is delivered only at finalization.
- Do not redesign Telegram route/session ownership, queued-turn controls, or assistant-final delivery beyond what Activity continuity needs.
- Do not add a hosted broker, webhook mode, or external persistence service.
- Do not treat Telegram typing indicators as the primary Activity continuity mechanism; they are advisory side effects.

## Validation

Add or update behavior checks for at least:

1. hidden/untitled thinking-only activity followed by later same-turn activity;
2. failed or ambiguous `deleteMessage` in the empty-state path;
3. ambiguous or failed initial Activity `sendMessage` behavior;
4. broker/renderer reset or restart during an active turn;
5. preservation of existing debouncing/history/final cleanup behavior.

Run `npm run check` before reporting completion.

## Planning notes

The architecture currently separates activity collection from Telegram rendering and treats Activity rendering as debounced/lossy relative to the activity model. This task adds a stronger requirement at the rendering lifecycle level: visible Activity messages should remain coherent for a logical active turn. Architecture only needs an edit if the implementation changes durable broker state or establishes a new recovery/ownership boundary for Activity message references.

## Decisions

- 2026-05-02: Persist active Activity render references in BrokerState.activeActivityMessages (activity id, turn id, route, known message id, ambiguous-send flag, and current lines) so a broker/renderer reset can recover and edit the same visible Telegram Activity message. Treat a failed/ambiguous initial Activity send without a message_id as irreducible for that activity: suppress later repeated sendMessage attempts for the same activity, keep accumulating durable lines, and emit pi diagnostics rather than risking unbounded duplicate Activity bubbles.
- 2026-05-02: A failed Activity delete during final or explicit activity completion now keeps the known message id in renderer/durable state and fails that completion attempt so broker final delivery can retry Activity cleanup instead of marking it complete after losing the only Telegram message reference.
- 2026-05-02: Final implementation keeps ambiguous non-retry send outcomes suppressed without a synthetic retry timer, surfaces real Telegram retry_after through non-auto-retrying Activity calls with durable retryAtMs for send/edit/delete, gates visible Activity side effects on durable state validity, re-arms durable retry refs only after broker persistence is active, and treats terminal Activity-delete failures as Activity cleanup terminal rather than terminal assistant-final delivery.
