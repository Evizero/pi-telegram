---
title: "Telegram /reload should reload and reattach session route"
type: "idea"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["implement-telegram-reload-with-route"]
---
Source: Telegram message on 2026-04-25.

Idea: explore whether Telegram can support a `/reload` command that does what pi's normal `/reload` does, then reattaches the reloaded pi session to the existing Telegram chat/topic/session route so the remote operator can continue in the same Telegram conversation.

Desired outcome: after triggering reload from Telegram, the user should not have to manually reconnect, reselect, or move to a new chat/topic just to continue supervising the same session.

Open questions for planning:

- What exactly does normal `/reload` do in pi, and is it available to extensions as a command/action?
- Does reload restart the extension process, the pi session, or only reload extension/package code?
- Which durable state is needed to reattach to the same Telegram route after reload?
- Should `/reload` be allowed only from an already routed session chat/topic?
- What should happen to active/queued Telegram turns while reload is happening?
- How should errors be reported if reload succeeds locally but reattachment fails?


## Deep dive notes — 2026-04-25

Investigated pi reload semantics, Telegram command constraints, and current bridge code.

### Key findings

- pi exposes `ctx.reload()` only on `ExtensionCommandContext`, i.e. from registered pi command handlers, not ordinary event handlers or tool handlers. The docs say it emits `session_shutdown`, reloads resources, then emits `session_start` with reason `reload`; code after `await ctx.reload()` still runs in the old extension frame and should treat reload as terminal.
- Telegram `/reload` can be implemented as an ordinary Telegram command: Telegram commands are just text messages beginning with `/`, may be advertised through BotFather or `setMyCommands`, and received updates do not prove that a command is valid or authorized, so the bridge must keep its existing authorization and route checks.
- Current bridge code cannot simply call normal pi `/reload` from Telegram command dispatch. `TelegramCommandRouter` runs in broker polling code and communicates with clients by IPC; the client IPC handler currently has only the latest `ExtensionContext`, not an `ExtensionCommandContext`.
- A clean bridge from Telegram into pi reload is to add a pi extension command such as `/telegram-reload-runtime` whose handler owns `ctx.reload()`, and have the Telegram `/reload` command ask the target client to enqueue that command with `pi.sendUserMessage("/telegram-reload-runtime", { deliverAs: "followUp" })` or immediate delivery when idle. This follows pi's documented `reload-runtime.ts` example pattern for reaching command-only APIs from non-command contexts.
- The largest reliability blocker is route identity across reload. `src/extension.ts` currently initializes `sessionId = randomId("pis")` when the extension factory loads. Because reload tears down and recreates the extension runtime, reconnecting after reload would get a new session id; `ensureRouteForSession()` reuses routes by `registration.sessionId`, so a new id can create a duplicate route/topic instead of reattaching.
- Reattachment should therefore separate logical session identity from process/socket identity. Use a stable logical session id derived from the pi session (`ctx.sessionManager.getSessionId()` when persisted, or a persisted extension custom entry/state for fallback) for `SessionRegistration.sessionId` and route lookup, while using `ownerId` or a separate instance id for IPC socket filenames.
- Auto-reattach should be one-shot and durable across the reload itself. Before calling `ctx.reload()`, record a reload intent containing the logical session id and source route/chat/thread (for example via `pi.appendEntry("telegram_reload_intent", ...)` or a private broker-scoped state file). On `session_start` with reason `reload`, detect the latest pending intent, call existing `connectTelegram(ctx, false)`, and send a completion/failure message to the same route if possible; then append/record the intent as consumed.
- Existing `session_shutdown` behavior is compatible in principle: it marks the session offline and preserves durable routes/pending turns. That is the right distinction for reload, but only works for route reuse if logical session id remains stable.
- Selector-mode private-chat routing has a separate continuity gap. `selectedSessionByChat` in `src/broker/commands.ts` is process memory only, and architecture already calls this out under `SyRS-selector-selection-durability`. A Telegram `/reload` that promises “continue there” should either depend on fixing durable selector selections first, or include a narrow reload-specific selection restoration for the source chat.

### Recommended implementation shape

1. Introduce a stable client/session identity helper in client/session lifecycle code, likely backed by `ctx.sessionManager.getSessionId()` plus an explicit fallback for ephemeral sessions.
2. Split logical session id from runtime instance/socket id in `src/extension.ts` so reload updates the existing broker session registration and route instead of creating a new route.
3. Add an internal client IPC message, e.g. `reload_runtime`, handled by the target client.
4. Add a registered pi command, e.g. `telegram-reload-runtime`, that stores a one-shot reload intent, calls `await ctx.reload()`, and returns immediately.
5. Have client IPC enqueue that command rather than trying to call reload from IPC/event context directly.
6. Add Telegram `/reload` handling in `src/broker/commands.ts` after route/session authorization and before ordinary turn creation; it should reject offline sessions and preserve `message_thread_id` in status replies.
7. In `session_start` after reload, consume the pending intent, call the existing `connectTelegram()`, and send “Reload complete; reattached to this Telegram route.” to the original chat/thread.
8. Make selector-mode continuation durable or explicitly scope the first implementation to topic-routed chats until `SyRS-selector-selection-durability` is implemented.

### Reliability constraints to carry into planning

- Do not advance Telegram update offsets before the `/reload` command is durably handled/queued.
- Avoid reload while an active Telegram turn is mid-final unless behavior is explicit; safest first slice is idle-only or follow-up queued after the active turn.
- Treat reload as terminal in the command handler; do not use old `ctx` or captured session-bound state after `ctx.reload()`.
- Preserve durable broker routes and pending turns; reload should be closer to offline/reconnect than explicit disconnect/unregister.
- Report clearly if reload succeeds but reattach fails, preferably locally and, when possible, in the original Telegram route.
