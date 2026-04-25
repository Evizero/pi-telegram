---
title: "Telegram reload should be automatic without laptop access"
type: "bug"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["remove-unsupported-telegram-reload"]
---
User reported that `/telegram-reload-runtime rel_02949e8f31c022b5` was surfaced/pasted instead of the reload happening automatically.

Concern: Telegram-triggered reload must work when the user only has Telegram access and cannot type an internal pi command on the laptop.

Questions to investigate:

- Can the extension invoke reload directly from the Telegram command path instead of emitting `/telegram-reload-runtime ...` as a follow-up user message?
- If direct command invocation is not available, can a tool call or another runtime hook perform reload safely?
- Why did the internal command become visible/actionable to the user instead of being executed automatically?
- Preserve route reattachment and reload intent behavior while avoiding any workflow that requires laptop access.


## Deep dive (2026-04-25)

Findings:

- The current Telegram `/reload` path reaches `TelegramCommandRouter`, creates a durable reload intent, and posts client IPC `reload_runtime` to the target session.
- Client-side `clientReloadRuntime()` queues or dispatches the reload intent. Dispatch currently calls `pi.sendUserMessage(`/telegram-reload-runtime ${intentId}`, { deliverAs: "followUp" })`.
- The internal command `telegram-reload-runtime` is registered in `src/pi/hooks.ts` and its handler has access to `ExtensionCommandContext.reload()`. That is the only public pi API surface found that can run `ctx.reload()`.
- Pi docs state command handlers have `ctx.reload()`, while tools and ordinary extension contexts do not. Tools explicitly cannot call `ctx.reload()` directly.
- In the installed pi runtime, `AgentSession.sendUserMessage()` calls `prompt()` with `expandPromptTemplates: false`. Command execution is gated by that flag, so extension-injected `pi.sendUserMessage("/telegram-reload-runtime ...")` skips extension command handling and becomes a literal user/LLM message instead of executing the command.
- Queued steering/follow-up paths also reject extension commands when called through the public steer/followUp helpers. This means a tool-call workaround that queues a slash command is not a reliable automatic reload path in the current pi runtime.

Conclusion:

- This cannot be solved robustly as a Telegram-only tool call with the current public pi extension API. A tool gets `ExtensionContext`, not `ExtensionCommandContext`, and cannot call `reload()`.
- The current internal-command follow-up design is therefore flawed for the product requirement: it can surface `/telegram-reload-runtime <intent>` to the user/agent and may require laptop/local intervention, which violates remote-only Telegram reload.

Likely fix direction:

1. Prefer an upstream/API fix in pi: expose a safe reload action outside command handlers, e.g. `pi.reload()` or `ctx.reload()` on `ExtensionContext`, or expose a command execution API that executes extension commands intentionally from extension code without turning them into user prompts.
2. Then change `clientReloadRuntime()` to call that direct reload action after marking the reload intent started, rather than `pi.sendUserMessage()`.
3. Keep the durable reload intent state machine and route reattachment logic; only replace the local reload trigger mechanism.
4. Until pi exposes such an API, treat Telegram `/reload` as not truly implemented for users who only have Telegram access.

Non-solution notes:

- Registering another LLM tool does not help unless pi also exposes reload to tool contexts.
- Re-injecting `/telegram-reload-runtime` as a user/follow-up message is the behavior that caused the bug.
- Relying on a previously captured command context would be stale/unsafe after reload and is explicitly warned against in the pi docs.
