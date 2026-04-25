---
title: "Implement Telegram /reload with route reattachment"
status: "done"
priority: 2
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: ""
labels: ["telegram-command", "reload", "lifecycle", "routing"]
traces_to: ["SyRS-telegram-reload-command", "SyRS-reload-reattach-route", "SyRS-reload-intent-recovery", "SyRS-register-session-route", "SyRS-topic-routes-per-session", "SyRS-offline-without-deleting-state", "SyRS-selector-selection-durability"]
source_inbox: "telegram-reload-should-reload"
branch: "task/implement-telegram-reload-with-route"
---
## Objective

Implement Telegram `/reload` as a remote control command that performs pi's runtime reload for the target session and then reattaches that session to the same Telegram chat/topic or selector route so the operator can continue there.

This task turns the source inbox idea into an implementation slice. It should preserve the bridge's continuity model: reload is a temporary runtime replacement, not an explicit Telegram disconnect or a new pi session route.

## Requirement trace

Primary new requirements:

- `SyRS-telegram-reload-command` — Telegram `/reload` is an authorized routed command, not an agent turn, and busy-session reload is queued to a safe follow-up boundary.
- `SyRS-reload-reattach-route` — the reloaded logical pi session reconnects to the same valid Telegram route or selector choice.
- `SyRS-reload-intent-recovery` — broker-persisted reload handoff state survives the reload boundary until reported or terminal.

Important neighboring requirements to preserve:

- `SyRS-register-session-route` — repeated registration should reuse route state instead of creating duplicate routes.
- `SyRS-topic-routes-per-session` — chat/thread route identity must stay correct for replies, activity, previews, finals, uploads, and typing actions.
- `SyRS-offline-without-deleting-state` — reload shutdown should mark liveness offline without deleting durable route/pending state.
- `SyRS-selector-selection-durability` — selector-mode session choices are in scope for this slice because “continue there” must remain true when `/reload` is issued from selector mode and the broker turns over.

## Scope

- Add Telegram `/reload` handling in the broker command path after authorization and route resolution, before normal turn creation.
- Route the command to the selected/routed target session over IPC.
- Persist a broker-scoped reload intent keyed by logical session id before invoking reload, including source chat id, source `message_thread_id`, route id/session id, request timestamp, and enough state to consume/report it at most once.
- Bridge from client IPC into a pi registered command that owns `ctx.reload()`, because pi only exposes reload through `ExtensionCommandContext`.
- Queue busy-session reload as follow-up work at a safe boundary rather than interrupting current tool/final delivery state.
- Treat reload as terminal in the command handler: after `await ctx.reload()`, return without using old session-bound `ctx` or captured `pi` state.
- Reconnect automatically on `session_start` after reload and complete the pending broker reload intent by reporting success or actionable failure to the original chat/thread when possible.
- Ensure the same logical pi session re-registers against the same broker route after reload instead of receiving a new Telegram route/topic.
- Persist selector-mode session selections in broker-scoped state so selector-mode `/reload` can continue in the same private chat after broker turnover until the selection expires, changes, or becomes invalid.
- Update user-facing command help/README/BotFather command list if `/reload` becomes a supported Telegram command.

## Design decisions for implementation

- **Logical session identity:** use a stable logical pi session identity for broker registration and route reuse, likely `ctx.sessionManager.getSessionId()`. Keep runtime instance identifiers separate for owner IDs, leases, heartbeat liveness, and IPC socket filenames.
- **Reload intent storage:** store reload intents in durable broker state, not only in client memory. The broker already owns route/session state and can persist the intent before acknowledging the Telegram update.
- **Reload completion:** consume pending reload intents during successful registration/heartbeat of the same logical session after route ensure. Send completion to the stored source chat/thread and delete or terminally mark the intent. If the client IPC request fails before reload begins, remove or terminally mark the intent and report the failure immediately.
- **Busy behavior:** queue reload to run after current active work reaches a follow-up boundary. Do not abort active work and do not run reload in the middle of active final/preview/attachment delivery.
- **Selector mode:** implement durable selector choices as part of this slice. Selector-mode reload must not silently lose `/use` selection across broker turnover.

## Recommended command bridge

Use pi's documented reload pattern:

1. Register an internal pi command, for example `/telegram-reload-runtime`, whose handler receives `ExtensionCommandContext` and calls `ctx.reload()`.
2. Add a client IPC message, for example `reload_runtime`, that queues that command via `pi.sendUserMessage('/telegram-reload-runtime', { deliverAs: 'followUp' })` when the session is busy. If the session is idle, immediate command delivery is acceptable only if it still goes through the command-context path.
3. Have Telegram `/reload` persist the broker reload intent and send that IPC request rather than creating a `PendingTelegramTurn`.
4. In `registerSession()` / `heartbeatSession()` after route ensure, detect and consume any pending reload intent for the logical session, then report success to the initiating Telegram route.

Do not call `ctx.reload()` directly from ordinary event hooks, tool handlers, broker polling code, or client IPC handlers; those do not have `ExtensionCommandContext`.

## Codebase grounding

Likely touchpoints:

- `src/broker/commands.ts`
  - add `/reload` command branch;
  - keep paired-user/route/offline checks;
  - persist reload intent before dispatching client IPC;
  - do not fall through to ordinary turn creation;
  - update help text;
  - move `selectedSessionByChat` into broker-scoped durable state or a broker-state-backed helper.
- `src/extension.ts`
  - add client IPC handling for reload request;
  - add broker-state fields/helpers for reload intents and durable selector choices, or extract cohesive helpers if the composition root grows too much;
  - consume pending reload intents on registration/heartbeat after route ensure;
  - separate stable logical session identity from runtime/socket identity so route reuse survives extension reload.
- `src/pi/hooks.ts`
  - register the internal reload command using `ExtensionCommandContext` typing if the command belongs with other pi command registration.
- `src/client/session-registration.ts`
  - ensure session registration uses the stable logical pi session identity across extension reloads, while IPC sockets remain runtime-instance-specific.
- `src/shared/types.ts`
  - add typed broker-state structures for reload intents and durable selector choices.
- `README.md`
  - document Telegram `/reload` in supported commands/BotFather command list if implemented.
- `dev/ARCHITECTURE.md`
  - keep the session identity/reload boundary consistent with the architecture notes added for this plan.

## Preserved behavior and constraints

- Existing `/telegram-connect`, `/telegram-disconnect`, `/sessions`, `/use`, `/status`, `/model`, `/compact`, `/follow`, and `/stop` behavior must not regress.
- Explicit disconnect/unregister may remove routes/topics; reload must not.
- Telegram update offsets must advance only after the `/reload` update is durably handled or durably queued.
- Telegram replies and status messages must preserve `message_thread_id` for topic-routed chats.
- Retry-aware Telegram behavior must remain intact; do not treat rate limits as formatting or reload failures.
- Existing activity, preview, final, media group, and attachment flows should be unaffected except for temporary offline/reconnect behavior during reload.
- Do not expose local shell/workspace authority through Telegram as part of this command; `/reload` is a runtime-control command only.
- Do not make Telegram `/reload` available to unauthorized users or unrouted chats.

## Acceptance Criteria

- Sending `/reload` from the paired user in a valid routed topic/chat or selected selector chat persists a broker reload intent and queues/starts pi runtime reload for that logical session.
- The same command from an unauthorized user, unrouted chat, or offline session receives clear rejection text and does not create an agent turn.
- If the target session is busy, reload is queued as follow-up after active work reaches a safe boundary; it does not corrupt active Telegram turn, preview, final delivery, or attachment handling.
- The reload command is executed through a pi registered command or equivalent command-context path that has access to `ctx.reload()`.
- No code after `await ctx.reload()` relies on stale old `ctx`, `pi`, `sessionManager`, or in-memory runtime state.
- After reload, the logical session automatically reconnects to Telegram and reuses the initiating route/chat/thread or selector-mode selection when still valid.
- Reload does not create duplicate private topics, forum topics, or selector routes for the same logical pi session.
- Selector-mode selected session state survives broker turnover until it expires, changes, or becomes invalid.
- Reload completion or failure is reported to the original Telegram route when possible, and reload intents are consumed at most once.
- Existing route/pending-turn durable state is preserved across reload shutdown; explicit disconnect semantics remain unchanged.
- Telegram command help and README/BotFather command list include `/reload` if the command is supported.

## Out of Scope

- Do not implement arbitrary Telegram command passthrough to pi.
- Do not add a remote shell, file browser, package manager, or general admin command surface.
- Do not redesign broker election beyond what is necessary for reload continuity.
- Do not move pi execution or workspace authority into Telegram.
- Do not solve unrelated final-delivery or media-group durability gaps except where the reload command would directly regress them.

## Validation

- Run `npm run check`.
- Add focused automated coverage if practical for:
  - Telegram `/reload` command dispatch persists intent and does not create a normal pending turn;
  - reload IPC queues/starts the internal pi command;
  - route reuse after re-registration with stable logical session id;
  - reload intent consumed at most once;
  - unauthorized/unrouted/offline rejection paths;
  - busy-session reload queued as follow-up;
  - selector-mode selection survives broker turnover or expiry/invalidity rules.
- If no test harness is introduced, validate by inspection against the code paths above and record the inspection explicitly in task decisions before close-out.

## Decisions

- 2026-04-25: Plan chooses broker-state reload intents rather than client-only state so the broker can durably handle the Telegram update before reload and can consume/report the intent after registration.
- 2026-04-25: Plan chooses follow-up queueing for busy-session reload, not immediate abort or mid-turn reload.
- 2026-04-25: Selector-mode durability is in scope because /reload should let the user continue in the same Telegram conversation without manual reselecting after broker turnover.
- 2026-04-25: Implementation uses pi's sessionManager.getSessionId() as the stable logical session id and ownerId-based client socket filenames as runtime instance identity, so broker routes can survive runtime reload while IPC endpoints change per extension instance.
- 2026-04-25: Implementation persists selector-mode /use selections in BrokerState.selectorSelections keyed by chat id with the existing 30-minute TTL, replacing process-local selectedSessionByChat state.
- 2026-04-25: Implementation queues Telegram-triggered reload through client IPC reload_runtime, which calls pi.sendUserMessage('/telegram-reload-runtime', { deliverAs: 'followUp' }); the registered pi command then calls ctx.reload() and returns without using stale context.
- 2026-04-25: Implementation marks reload intents as reloading from the internal command before calling ctx.reload(), and completion only consumes intents when a different runtime owner re-registers the same logical session.
- 2026-04-25: Implementation orders Telegram reload behind any active or already queued Telegram turns in the client queue before dispatching the internal reload command.
- 2026-04-25: Implementation reuses an existing selector-mode route when a valid durable selector selection exists for the logical session, even if config allowedChatId is temporarily unavailable after turnover.
- 2026-04-25: Implementation treats an existing queued or reloading intent for the session as in-progress instead of overwriting it, making duplicate/redelivered /reload commands idempotent.
- 2026-04-25: Implementation reports ctx.reload() failures back to the broker through reload_failed so the intent is cleared and the original Telegram route is notified when reload does not start successfully.
- 2026-04-25: Implementation treats confirmed ctx.reload() failures as reportable reload failures, but an unconfirmed reload_started handoff failure leaves the durable intent queued/accepted for retry because the broker may already have accepted the transition.
- 2026-04-25: Implementation sends reload_started and reload_failed through a broker-control IPC helper that retries against the current live broker lease when the cached broker socket is stale.
- 2026-04-25: Implementation retries the client reload_runtime handoff for an existing queued reload intent instead of treating queued state as terminally in progress, so redelivered /reload can recover from broker failover before client dispatch.
- 2026-04-25: Implementation treats pending assistant-final retry delivery as a reload safe-boundary blocker; queued reload dispatch waits until final retry state is clear.
- 2026-04-25: Validation completed with npm run check, pln hygiene, and read-only review; no focused automated test harness exists in this repository yet, so behavior was validated by typecheck and inspection/review.
- 2026-04-25: Implementation keeps reload behind any Telegram turns that are queued before the active turn reaches a safe boundary by increasing queued reload boundary counts when additional turns are queued.
- 2026-04-25: Implementation retries any durable queued reload intent on later registration or heartbeat and deduplicates locally dispatched internal reload commands by intent id, so queued intents can recover if client memory is lost before the safe boundary.
- 2026-04-25: Implementation keeps reload intents durable until the completion Telegram message is sent successfully; failed completion reporting leaves the intent for heartbeat retry instead of deleting it early.
- 2026-04-25: Implementation clears local reload-command deduplication when reload_failed is attempted, allowing durable queued-intent retry if pre-start failure reporting cannot reach the broker.
- 2026-04-25: Implementation does not send reload_failed if reload_started IPC fails before confirmation, because the broker may have accepted the state transition; the local dedup marker is cleared so the durable queued intent can retry instead.
- 2026-04-25: Implementation now constrains forum-topic route fallback by both chat id and message_thread_id so Telegram /reload cannot route across chats with colliding thread ids.
- 2026-04-25: Implementation adds an accepted reload-intent state owned by a runtime owner id; heartbeat retry does not redispatch accepted intents to the same owner, avoiding duplicate safe-boundary reload commands while still allowing retry after owner turnover.
- 2026-04-25: Implementation preserves existing queued/accepted reload intents on transient reload_runtime IPC retry failure instead of deleting them, so broker-failover or stale-socket recovery can retry on later registration or heartbeat.
- 2026-04-25: Implementation records failed reload reporting in durable intent state and only deletes that intent after the failure notification is sent successfully; heartbeat or registration retries unsent failure notifications.
- 2026-04-25: Implementation creates or refreshes a single_chat_selector route when /use persists a selector selection, so subsequent routed commands such as /reload resolve in that selected chat.
