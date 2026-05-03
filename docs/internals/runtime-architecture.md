# Runtime architecture

`pi-telegram` is a local-first pi extension. Telegram is the remote control surface; pi sessions remain the execution authority. The runtime is organized so one connected pi process polls Telegram and brokers work to any connected sessions through local IPC.

For the normative architecture contract, see [`../../dev/ARCHITECTURE.md`](../../dev/ARCHITECTURE.md). This page is a current implementation map for maintainers and agents.

## Top-level shape

```text
index.ts
  -> src/bootstrap.ts                 lightweight pi-visible surface
       -> dynamic import src/extension.ts only when needed
            -> broker/*               polling, routing, command handling, broker state
            -> client/*               local session registration, turn lifecycle, final handoff
            -> pi/*                   pi command/tool/event boundary modules
            -> telegram/*             Bot API, previews, attachments, retry, temp files
            -> shared/*               config, paths, IPC, formatting, small contracts
```

`index.ts` should stay tiny. New runtime behavior should not be added there.

## Lazy bootstrap

`src/bootstrap.ts` eagerly registers:

- `/telegram-setup`
- `/telegram-topic-setup`
- `/telegram-connect`
- `/telegram-disconnect`
- `/telegram-status`
- `/telegram-broker-status`
- the `telegram_attach` tool schema and prompt guidance
- lightweight pi event hooks for later delegation

The heavy runtime is loaded through one memoized dynamic import when:

- a Telegram pi command needs runtime behavior;
- `telegram_attach` is executed;
- a session-replacement handoff exists during `session_start`;
- an already-loaded runtime needs event hooks for connected behavior.

Ordinary pi startup with no Telegram use should not start polling, IPC servers, broker heartbeats, timers, webhook deletion, or Telegram network calls.

## Runtime composition root

`src/extension.ts` exposes `createTelegramRuntime(pi)`. It wires together broker, client, pi, Telegram, IPC, config, activity, final delivery, and diagnostics dependencies.

Keep this file as a composition root. If a cohesive policy starts growing there, move it to the owning folder rather than creating another god file.

Current important composition objects include:

- `ClientRuntimeHost` from `src/client/runtime-host.ts`
- `RetryAwareTelegramTurnFinalizer` from `src/client/retry-aware-finalization.ts`
- `ClientAssistantFinalHandoff` from `src/client/final-handoff.ts`
- `AssistantFinalDeliveryLedger` from `src/broker/finals.ts`
- `TelegramCommandRouter` from `src/broker/commands.ts`
- `ActivityReporter` and `ActivityRenderer` from `src/broker/activity.ts`
- broker heartbeat, lease, update, route/session, outbox, and registration helpers under `src/broker/`

## Broker role

One connected extension process owns the broker lease and becomes the broker. The broker:

- deletes webhooks and long-polls Telegram with `getUpdates`;
- authenticates pairing and authorized user/chat;
- batches media groups;
- routes messages, commands, and callbacks;
- owns shared durable broker state;
- creates/reuses routes and topics;
- dispatches pending turns to client sessions through local IPC;
- receives activity and final-delivery handoffs from clients;
- retries pending turns, assistant finals, route cleanup, queued-control finalization, and cleanup outbox jobs;
- marks sessions offline and unregisters them after explicit disconnect or expired reconnect grace.

Key broker files:

| File | Responsibility |
| --- | --- |
| `src/broker/updates.ts` | Polling, webhook deletion, update authorization, pairing, media groups, offset durability. |
| `src/broker/commands.ts` | Telegram command/callback routing and session-control orchestration. |
| `src/broker/lease.ts` | File-based broker election and lease renewal classification. |
| `src/broker/heartbeat.ts` | Broker heartbeat cycle and contention diagnostics. |
| `src/broker/session-registration.ts` | Register/re-register sessions and coordinate routes. |
| `src/broker/sessions.ts` | Offline/unregister lifecycle and route cleanup intent. |
| `src/broker/activity.ts` | Activity collection/rendering to Telegram. |
| `src/broker/finals.ts` | Durable assistant-final ledger and FIFO delivery. |
| `src/broker/telegram-outbox.ts` | Retryable cleanup-oriented Telegram side effects. |
| `src/broker/model-command.ts` | `/model` command and picker orchestration. |
| `src/broker/git-command.ts` | `/git` menu and repository controls. |
| `src/broker/queued-turn-control-handler.ts` | Queued follow-up steer/cancel callback lifecycle. |

## Client role

Every connected pi session has a client runtime. A client:

- starts a local IPC server;
- registers session metadata with the broker;
- heartbeats its active/queued state;
- accepts delivered Telegram turns;
- chooses active/queued/steer behavior;
- owns active turn state, queued follow-ups, manual compaction barriers, abort callbacks, and local turn dedupe;
- hands assistant finals to the broker;
- preserves pre-broker-acceptance final handoff state during ambiguous connection or shutdown races;
- handles route shutdown and session replacement handoff.

Key client files:

| File | Responsibility |
| --- | --- |
| `src/client/runtime-host.ts` | Client IPC server, broker registration, heartbeat, status/model/git IPC handlers. |
| `src/client/runtime.ts` | Execution-side command/turn operations. |
| `src/client/turn-lifecycle.ts` | Active turn, queued turns, manual compaction barrier, abort, dedupe. |
| `src/client/turn-delivery.ts` | Deliver-turn disposition for idle, busy, follow-up, and steering cases. |
| `src/client/manual-compaction.ts` | Client-side manual-compaction queue integration. |
| `src/client/final-handoff.ts` | Client-to-broker assistant-final pre-acceptance protection. |
| `src/client/retry-aware-finalization.ts` | Defers transient provider/assistant errors until stable final outcome. |
| `src/client/session-replacement.ts` | Native `/new`, `/resume`, `/fork` route continuity handoff files. |
| `src/client/attachment-path.ts` | Outbound attachment path allowlist and secret guard. |

## pi integration boundary

`src/pi/*` modules keep pi-facing behavior separate from Telegram mechanics:

- commands and local status notifications;
- `telegram_attach` tool validation/execution;
- prompt suffix guidance;
- local user input mirroring;
- activity and finalization hooks;
- session lifecycle hooks;
- pi-safe diagnostics.

Pi hooks should depend on shared contracts and injected callbacks, not low-level Bot API details or broker persistence policy.

## Telegram boundary

`src/telegram/*` owns Bot API behavior:

| File | Responsibility |
| --- | --- |
| `api.ts` | JSON/multipart Bot API calls and hosted file downloads. |
| `api-errors.ts` | Structured Telegram API errors and retry signal extraction. |
| `retry.ts` | Safe retry-after waiting wrappers. |
| `message-ops.ts` | Shared send/edit/delete/callback operations. |
| `text.ts` | Text reply formatting/chunking helpers. |
| `attachments.ts` | Outbound photo/document selection and fallback. |
| `turns.ts` | Telegram update/message to durable pi turn conversion. |
| `previews.ts` | Legacy/in-flight preview compatibility and final detachment. |
| `typing.ts` | Typing-loop controller. |
| `temp-files.ts` | Session-scoped Telegram download cleanup. |
| `setup.ts` | Bot token setup and pairing prompt flow. |

Feature modules should call these policy helpers instead of parsing Telegram errors or retry behavior locally.

## Shared surfaces

`src/shared/*` is intentionally limited to low-level support and stable cross-boundary contracts:

- `paths.ts` — config/broker/temp paths and bot-scoped broker root configuration;
- `config.ts` / `config-types.ts` — persisted bridge config;
- `ipc.ts`, `ipc-types.ts`, `ipc-policy.ts` — local IPC transport and limits;
- `file-policy.ts` — bridge attachment limits;
- `activity-lines.ts`, `format.ts`, `messages.ts`, `routing.ts`, `pairing.ts`, `ui-status.ts` — reusable presentation and parsing helpers;
- `types.ts` — compatibility re-exports only where still needed.

New broker, client, Telegram, or pi concepts should go to their owning folder first. Avoid expanding broad shared buckets.

## Dependency rules of thumb

- `index.ts` depends only on bootstrap.
- Bootstrap may register pi-visible surfaces and lazy-load runtime; it should not grow broker policy.
- `src/extension.ts` composes heavy runtime modules.
- Broker modules may use Telegram helpers, but should not own multipart/download mechanics.
- Telegram modules should not depend on pi hooks or broker command policy.
- Client modules own local session lifecycle and should not own broker final delivery after broker acceptance.
- Shared modules must not import broker/client/pi/Telegram policy modules.

## Validation anchors

Behavior checks under `scripts/check-*.ts` protect this architecture. Important checks for this page include:

- `scripts/check-lazy-bootstrap.ts`
- `scripts/check-runtime-pi-hooks.ts`
- `scripts/check-client-runtime-host.ts`
- `scripts/check-telegram-command-routing.ts`
- `scripts/check-shared-boundaries.ts`
- `scripts/check-final-delivery.ts`
- `scripts/check-client-final-handoff.ts`
- `scripts/check-session-replacement-handoff.ts`
