# Multi-Session Telegram Broker Specification

Status: Draft v1 (TypeScript/pi extension implementation)

Purpose: Define a refactor of `pi-telegram` from a single-session Telegram bridge into a multi-session Telegram babysitter where one active pi extension instance acts as the elected Telegram broker and every connected pi session gets a distinct Telegram topic.

Last verified against Telegram Bot API docs: 2026-04-24.

## 1. Problem Statement

`pi-telegram` currently lets one pi session connect to one Telegram bot. That works for a single project, but it fails for the target use case: leaving the computer while multiple pi sessions are running in different projects and monitoring/steering all of them from Telegram.

The current implementation has one extension instance per pi process, and each instance can call `/telegram-connect`. If several sessions use the same bot token, they all compete for the same Telegram update stream. Telegram long polling is a single-consumer queue in practice: an update is confirmed once `getUpdates` is called with an offset greater than that update id. A multi-session design must ensure only one process owns `getUpdates` for a bot token.

This system solves three operational problems:

- Remote monitoring: see active pi sessions while away from the computer.
- Remote steering: send prompts, follow-ups, `stop`, `/status`, `/compact`, and `/model` to a specific session.
- Session discovery: avoid remembering which Telegram bot or bot token maps to which pi session.

Important boundary:

- This system is a Telegram transport and routing layer for pi sessions.
- This system does not replace pi's agent loop, session storage, tool execution, model management, or permission model.
- This system does not make one Telegram bot have multiple identities. The bot identity is global; per-session clarity comes from Telegram topics and message text.

## 2. Goals and Non-Goals

### 2.1 Goals

1. One Telegram bot token must support multiple active pi sessions.
2. Exactly one active pi extension instance must own Telegram polling for a given bot token at a time.
3. The broker role must run inside an ordinary pi extension instance; no always-running external daemon is required.
4. If the current broker dies, another active pi extension instance must be able to take over after a bounded lease timeout.
5. Each connected pi session must have a stable Telegram routing target.
6. When Telegram private-chat topics are available, each pi session must be represented by one Telegram topic named after the project/session.
7. When private-chat topics are not available, the implementation must provide a documented fallback rather than silently misrouting messages.
8. Telegram messages in a session topic must route to exactly one pi session.
9. pi replies, previews, typing indicators, and attachments must be sent back to the same Telegram topic or fallback route.
10. A Telegram user must be able to list active sessions, inspect status, stop an active run, compact a session, change the active model, and disconnect a session.
11. The implementation must preserve current single-session capabilities: text prompts, images, files, albums, `stop`, `/status`, `/compact`, streaming previews, and `telegram_attach`.
12. The implementation must avoid update loss across broker failover by committing Telegram offsets only after routing work has completed or been durably queued.

### 2.2 Non-Goals

1. The system will not create separate classic Telegram DM chats for each session using one bot. Telegram private chat with one bot/user is one chat; topics provide separation.
2. The v1 system will not require managed bots or create new bot tokens automatically. Managed bots may be future work.
3. The v1 system will not expose a public network service. All IPC must be local to the machine.
4. The v1 system will not support multiple human Telegram users controlling the same bot unless explicitly enabled in a future configuration profile.
5. The v1 system will not synchronize pi sessions across machines. Failover only happens among live pi processes on the same machine and same user account.
6. The v1 system will not provide guaranteed exactly-once delivery. It targets at-least-once inbound delivery with duplicate suppression by Telegram `update_id` and broker message ids.
7. The v1 system will not attempt to rename the Telegram bot per project/session. Topic names and messages carry project/session identity.
8. The v1 system will not persist full Telegram message history beyond the minimal routing and deduplication state needed for correct operation.

## 3. System Overview

### 3.1 Main Components

1. **Pi Extension Instance**
   - The code loaded into every pi process.
   - Registers pi commands, pi tools, and pi event handlers.
   - Contains both client logic and broker-capable logic.

2. **Broker Leader**
   - The one Pi Extension Instance currently elected to own Telegram API polling.
   - Calls `getUpdates`, `deleteWebhook`, Telegram send/edit/upload APIs, topic APIs, and file download APIs.
   - Maintains the authoritative in-memory routing table while it holds the lease.

3. **Session Client**
   - The per-pi-session side of the extension.
   - Registers its local pi session with the Broker Leader.
   - Receives routed Telegram turns from the Broker Leader and calls `pi.sendUserMessage` in its own process.
   - Sends assistant streaming updates, final replies, errors, status, and attachment queue events back to the Broker Leader.

4. **Leader Election Store**
   - A small filesystem-backed lease under `~/.pi/agent/telegram-broker/`.
   - Prevents two brokers from polling the same bot for longer than the election race window.
   - Contains a lease file, shared broker state, and per-session registration snapshots.

5. **Local IPC Transport**
   - Local-only communication between the Broker Leader and Session Clients.
   - Preferred transport: Unix domain sockets on macOS/Linux.
   - Acceptable fallback: loopback HTTP server bound to `127.0.0.1` with a random bearer token.

6. **Telegram API Client**
   - Thin wrapper around Telegram Bot API HTTP methods.
   - Normalizes Telegram API failures into named errors.
   - Handles JSON, multipart uploads, file downloads, and `retry_after` rate limit parameters.

7. **Telegram Router**
   - Maps inbound Telegram updates to `session_id` by `chat_id` + `message_thread_id` when topics are enabled.
   - Maps outbound session events to Telegram send/edit operations.
   - Owns fallback behavior when topic mode is unavailable.

### 3.2 Abstraction Layers

The implementation should be organized into modules matching these layers:

```text
index.ts                         pi extension entrypoint
src/config.ts                    config loading, validation, migration
src/election.ts                  lease acquisition, heartbeat, failover
src/ipc.ts                       local IPC server/client and message schemas
src/broker.ts                    broker lifecycle and Telegram update loop
src/router.ts                    Telegram update routing and session registry operations
src/telegram-api.ts              Telegram API wrapper
src/session-client.ts            per-session pi integration
src/pi-session.ts                project/session metadata extraction
src/files.ts                     download/upload/temp path helpers
src/format.ts                    topic names, message chunks, status text
src/types.ts                     shared domain types
```

A single-file implementation is allowed only for exploratory prototyping. The production refactor should split modules because the broker/client/election concerns are independent.

### 3.3 External Dependencies

1. **Telegram Bot API**
   - Auth: bot token.
   - Failure characteristics: network failures, 4xx validation errors, 401 invalid token, 403 blocked bot, 409 webhook/polling conflict, 429 rate limits with `retry_after`, transient 5xx.
   - Important constraints: `getUpdates` and webhook are mutually exclusive; update offsets confirm messages.

2. **pi Extension API**
   - Used for commands, tools, event hooks, `pi.sendUserMessage`, `ctx.abort`, `ctx.compact`, status UI, and model/session metadata.
   - Failure characteristics: stale extension instance after reload/session replacement, unavailable UI in non-interactive modes, errors from `sendUserMessage` when called during streaming without delivery mode.

3. **Filesystem**
   - Stores config, lease, broker state, per-session registration snapshots, temp Telegram files, and Unix socket paths.
   - Failure characteristics: permissions, stale lock files, partial writes, deleted directories, disk full.

4. **Git executable (optional)**
   - Used to derive project display metadata: repository root, branch, remote, short HEAD.
   - Failure characteristics: not a git repo, executable missing, slow command.

## 4. Core Domain Model

### 4.1 TelegramConfig

User-controlled and setup-time config stored in `~/.pi/agent/telegram.json` or a migrated replacement path.

Fields:

- `version` (integer, required)
  - Current value: `2`.
- `bot_token` (string, required after setup)
  - Secret. Must never be logged.
- `bot_username` (string, optional)
  - From `getMe.username`.
- `bot_id` (number, optional)
  - From `getMe.id`.
- `allowed_user_id` (number, optional until paired)
  - Telegram user id allowed to control sessions.
- `allowed_chat_id` (number, optional until paired)
  - Private chat id for the allowed user, usually same numeric id as the user for normal private chats.
- `topics_enabled` (boolean, optional)
  - From `getMe.has_topics_enabled`.
- `users_can_create_topics` (boolean, optional)
  - From `getMe.allows_users_to_create_topics`.
- `fallback_mode` (string enum, optional)
  - One of `"single_chat_selector"`, `"forum_supergroup"`, `"disabled"`.
  - Default: `"single_chat_selector"`.
- `fallback_supergroup_chat_id` (number|string, optional)
  - Required only when `fallback_mode = "forum_supergroup"`.

Nullability:

- `bot_token` may be absent before setup.
- `allowed_user_id` and `allowed_chat_id` may be absent before pairing.
- All other optional fields may be absent and are refreshed by setup/connect.

### 4.2 BrokerLease

Filesystem-backed leadership lease.

Fields:

- `schema_version` (integer, required)
  - Current value: `1`.
- `owner_id` (string, required)
  - Unique id for the extension instance that owns the lease.
- `pid` (integer, required)
  - OS process id of the owner.
- `started_at_ms` (integer, required)
  - Unix epoch milliseconds when owner instance started.
- `lease_epoch` (integer, required)
  - Monotonically increasing leadership epoch.
- `socket_path` (string, required if Unix socket transport)
  - Local broker IPC endpoint.
- `http_port` (integer, required if loopback HTTP transport)
  - Local broker IPC endpoint.
- `auth_token_hash` (string, required)
  - Hash of the local IPC bearer token. The raw token must not be stored in logs.
- `lease_until_ms` (integer, required)
  - Time after which clients may attempt takeover.
- `updated_at_ms` (integer, required)
  - Last heartbeat write time.
- `bot_id` (number, optional)
  - Bot id for sanity checks.

Nullability:

- Exactly one endpoint representation must be present: `socket_path` or `http_port`.

### 4.3 BrokerState

Shared durable state used by the current and future Broker Leaders.

Fields:

- `schema_version` (integer, required)
  - Current value: `1`.
- `last_processed_update_id` (integer, optional)
  - Highest Telegram update id fully processed or durably queued.
- `recent_update_ids` (array of integers, required)
  - Ring buffer for duplicate suppression. Default empty.
- `sessions` (map of string to SessionRegistration, required)
  - Keyed by `session_id`.
- `routes` (array of TelegramRoute, required)
  - Reverse mapping from Telegram chat/thread to session.
- `created_at_ms` (integer, required)
- `updated_at_ms` (integer, required)

Important nuance:

- `last_processed_update_id` must be advanced only after route handling has completed or after a durable IPC delivery record has been written. Advancing it before handling can lose messages on crash.

### 4.4 SessionRegistration

Persistent snapshot of one pi session connected to Telegram.

Fields:

- `session_id` (string, required)
  - Stable id for this extension instance/pi session connection.
- `owner_id` (string, required)
  - Extension instance id currently serving this session client.
- `pid` (integer, required)
  - pi process id.
- `pi_session_file` (string, optional)
  - Current pi session file path if available.
- `pi_session_name` (string, optional)
  - `pi.getSessionName()` if set.
- `cwd` (string, required)
  - pi current working directory.
- `project_name` (string, required)
  - Human-readable project name.
- `git_root` (string, optional)
- `git_branch` (string, optional)
- `git_head` (string, optional)
  - Short commit hash if available.
- `model` (string, optional)
  - `provider/id` if a model is selected.
- `topic_name` (string, required)
  - Human-readable Telegram topic or selector name.
- `status` (string enum, required)
  - One of `"connecting"`, `"idle"`, `"busy"`, `"offline"`, `"disconnecting"`, `"error"`.
- `active_turn_id` (string, optional)
- `queued_turn_count` (integer, required)
  - Default: `0`.
- `last_heartbeat_ms` (integer, required)
- `connected_at_ms` (integer, required)
- `last_error` (SessionError, optional)
- `capabilities` (ClientCapabilities, required)
- `client_endpoint` (ClientEndpoint, required)

Nullability:

- Git fields are optional because non-git directories must work.
- `active_turn_id` is present only while a Telegram-originated turn is active in that pi session.

### 4.5 TelegramRoute

Mapping from Telegram chat/thread to one pi session.

Fields:

- `route_id` (string, required)
  - Stable key derived from chat id and message thread id.
- `session_id` (string, required)
- `chat_id` (number|string, required)
- `message_thread_id` (integer, optional)
  - Required in topic mode.
  - Absent in single-chat selector fallback.
- `route_mode` (string enum, required)
  - One of `"private_topic"`, `"forum_supergroup_topic"`, `"single_chat_selector"`.
- `topic_name` (string, required)
- `created_by_broker` (boolean, required)
- `created_at_ms` (integer, required)
- `updated_at_ms` (integer, required)

Stable route key:

```text
if message_thread_id exists:
  route_id = `${chat_id}:${message_thread_id}`
else:
  route_id = `${chat_id}:default`
```

### 4.6 TelegramInboundMessage

Normalized inbound Telegram message after broker parsing.

Fields:

- `update_id` (integer, required)
- `message_id` (integer, required)
- `chat_id` (number|string, required)
- `message_thread_id` (integer, optional)
- `from_user_id` (number, required)
- `is_topic_message` (boolean, required)
- `text` (string, optional)
- `caption` (string, optional)
- `media_group_id` (string, optional)
- `telegram_files` (array of TelegramFileRef, required)
- `received_at_ms` (integer, required)
- `raw_update` (object, optional)
  - Optional debug capture. Must not be enabled by default.

### 4.7 PendingTelegramTurn

A user turn routed from Telegram to a pi session.

Fields:

- `turn_id` (string, required)
- `session_id` (string, required)
- `chat_id` (number|string, required)
- `message_thread_id` (integer, optional)
- `reply_to_message_id` (integer, required)
- `source_update_ids` (array of integers, required)
- `content` (array of pi content blocks, required)
- `history_text` (string, required)
- `downloaded_files` (array of DownloadedTelegramFile, required)
- `queued_attachments` (array of QueuedAttachment, required)
- `state` (string enum, required)
  - One of `"queued"`, `"delivered"`, `"active"`, `"completed"`, `"aborted"`, `"failed"`.
- `created_at_ms` (integer, required)
- `updated_at_ms` (integer, required)

### 4.8 ClientToBrokerMessage

IPC message sent from a Session Client to the Broker Leader.

Fields:

- `id` (string, required)
- `type` (string enum, required)
  - See Section 8.2.
- `session_id` (string, required for session-specific messages)
- `lease_epoch` (integer, optional)
  - Included when the sender knows the current broker epoch.
- `payload` (object, required)
- `sent_at_ms` (integer, required)

### 4.9 BrokerToClientMessage

IPC message sent from the Broker Leader to a Session Client.

Fields:

- `id` (string, required)
- `type` (string enum, required)
  - See Section 8.2.
- `session_id` (string, required)
- `payload` (object, required)
- `sent_at_ms` (integer, required)

### 4.10 Normalization Rules

- `project_name` derivation:
  1. If git root exists, use basename of git root.
  2. Else use basename of `cwd`.
  3. Trim whitespace.
  4. If empty, use `"pi-session"`.
- `topic_name` derivation:
  1. Start with `project_name`.
  2. Append ` · ${git_branch}` when branch exists.
  3. Append ` · ${short_session_name}` when session name exists and is not redundant.
  4. Collapse whitespace to single spaces.
  5. Remove Telegram-control-problematic newlines and tabs.
  6. Truncate to 128 Unicode scalar values.
  7. If truncating, preserve a stable suffix: `… ${short_hash(session_id, 6)}`.
- `session_id` derivation:
  - Generate once per extension instance registration with random 128-bit entropy, prefixed `pis_`.
  - Persist in the per-session snapshot for reconnects within the same pi process.
  - Do not derive solely from `cwd`, because two pi sessions can run in one project.
- String comparisons for command names:
  - `trim`, then lowercase.
- Telegram command routing:
  - Commands in a session topic apply to that topic/session unless explicitly global.
  - Global commands in the default chat apply to the broker/session selector.

## 5. Configuration Specification

### 5.1 Config Sources and Precedence

Highest precedence first:

1. Extension command arguments for a single operation.
2. Environment variables.
3. `~/.pi/agent/telegram-broker/config.json`.
4. Migrated values from existing `~/.pi/agent/telegram.json`.
5. Built-in defaults.

The implementation must migrate existing `telegram.json` without deleting it. On first v2 startup, write a v2-compatible config and preserve unknown legacy fields in a `legacy` object or ignore them with a warning.

### 5.2 Config Fields

- `telegram.bot_token` (string)
  - Default: absent.
  - Validation: non-empty token-like string after trim.
  - Secret: yes.
  - Environment: `PI_TELEGRAM_BOT_TOKEN` may supply value.
  - Reload: restart broker required.

- `telegram.allowed_user_id` (number)
  - Default: absent until pairing.
  - Validation: positive integer, safe JavaScript integer.
  - Reload: dynamic.

- `telegram.allowed_chat_id` (number|string)
  - Default: absent until pairing.
  - Validation: Telegram chat id number or string username for fallback supergroup.
  - Reload: dynamic.

- `telegram.pairing_code_hash` (string)
  - Default: absent.
  - Validation: generated locally by `/telegram-setup`; single-use; expires via `telegram.pairing_expires_at_ms`.
  - Reload: dynamic.

- `telegram.pairing_expires_at_ms` (integer)
  - Default: absent.
  - Validation: future Unix epoch milliseconds while pairing is open.
  - Reload: dynamic.

- `telegram.topic_mode` (string enum)
  - Default: `"auto"`.
  - Values: `"auto"`, `"private_topics"`, `"forum_supergroup"`, `"single_chat_selector"`, `"disabled"`.
  - Validation: exact enum.
  - Reload: broker restart recommended; dynamic reload may apply only to new sessions.

- `telegram.fallback_supergroup_chat_id` (number|string)
  - Default: absent.
  - Required when `topic_mode = "forum_supergroup"`.
  - Reload: broker restart recommended.

- `broker.lease_duration_ms` (integer)
  - Default: `10000`.
  - Validation: `>= 3000` and `<= 60000`.
  - Reload: dynamic by next heartbeat.

- `broker.heartbeat_interval_ms` (integer)
  - Default: `2000`.
  - Validation: `>= 500` and `< broker.lease_duration_ms / 2`.
  - Reload: dynamic.

- `broker.election_jitter_ms` (integer)
  - Default: `500`.
  - Validation: `>= 0` and `<= 5000`.
  - Reload: dynamic.

- `broker.state_dir` (string)
  - Default: `~/.pi/agent/telegram-broker`.
  - Validation: absolute path or `~`-prefixed path after expansion.
  - Reload: restart required.

- `ipc.transport` (string enum)
  - Default: `"unix"` on non-Windows, `"http"` on Windows.
  - Values: `"unix"`, `"http"`.
  - Validation: exact enum.
  - Reload: restart required.

- `ipc.request_timeout_ms` (integer)
  - Default: `5000`.
  - Validation: `>= 1000` and `<= 60000`.
  - Reload: dynamic.

- `telegram.poll_timeout_seconds` (integer)
  - Default: `30`.
  - Validation: `>= 1` and `<= 50`.
  - Reload: dynamic.

- `telegram.poll_limit` (integer)
  - Default: `25`.
  - Validation: `>= 1` and `<= 100`.
  - Reload: dynamic.

- `telegram.preview_throttle_ms` (integer)
  - Default: `750`.
  - Validation: `>= 250` and `<= 5000`.
  - Reload: dynamic.

- `telegram.max_attachments_per_turn` (integer)
  - Default: `10`.
  - Validation: `>= 0` and `<= 20`.
  - Reload: dynamic.

- `telegram.media_group_debounce_ms` (integer)
  - Default: `1200`.
  - Validation: `>= 300` and `<= 5000`.
  - Reload: dynamic.

- `telegram.max_message_length` (integer)
  - Default: `4096`.
  - Validation: `>= 1000` and `<= 4096`.
  - Reload: dynamic.

- `security.allow_remote_ipc` (boolean)
  - Default: `false`.
  - Validation: must remain `false` for core conformance.
  - Reload: restart required.

- `security.attachment_roots` (array of strings)
  - Default: `["cwd", "telegram_tmp"]`.
  - Validation: values are either symbolic roots (`"cwd"`, `"telegram_tmp"`) or absolute paths.
  - Reload: dynamic.
  - Behavior: `telegram_attach` may send only regular files under one of these roots unless `security.unrestricted_attachments` is true.

- `security.unrestricted_attachments` (boolean)
  - Default: `false`.
  - Validation: boolean.
  - Reload: dynamic.
  - Behavior: when true, `telegram_attach` may send any regular file readable by the pi process.

- `security.sensitive_path_denylist` (array of strings)
  - Default: `[".env", ".env.*", ".ssh/**", ".aws/**", "id_rsa", "id_ed25519"]`.
  - Validation: glob-like patterns matched against basename and normalized path.
  - Reload: dynamic.

- `telegram.max_inbound_file_bytes` (integer)
  - Default: `52428800` (50 MiB).
  - Validation: `>= 0` and `<= 2147483648`.
  - Reload: dynamic.

- `telegram.max_outbound_attachment_bytes` (integer)
  - Default: `52428800` (50 MiB).
  - Validation: `>= 0` and `<= 2147483648`.
  - Reload: dynamic.

- `debug.log_raw_updates` (boolean)
  - Default: `false`.
  - Validation: boolean.
  - Reload: dynamic.
  - Security: when true, logs may contain user message text and file metadata; bot token still must be redacted.

### 5.3 Startup Validation

Before becoming broker, validate:

1. `telegram.bot_token` exists.
2. `getMe` succeeds.
3. Bot id and username are recorded.
4. If `topic_mode = private_topics`, `getMe.has_topics_enabled` must be true.
5. If `topic_mode = forum_supergroup`, `fallback_supergroup_chat_id` must exist.
6. State directory is creatable and writable.
7. IPC endpoint path/port is available.

A Session Client may start without a bot token, but `/telegram-connect` must prompt setup or report a clear config error.

### 5.4 Config Cheat Sheet

This table is intentionally redundant.

| Field | Default | Restart? |
| --- | --- | --- |
| `telegram.bot_token` | absent | broker restart |
| `telegram.allowed_user_id` | absent | no |
| `telegram.allowed_chat_id` | absent | no |
| `telegram.pairing_code_hash` | absent | no |
| `telegram.pairing_expires_at_ms` | absent | no |
| `telegram.topic_mode` | `auto` | recommended |
| `telegram.fallback_supergroup_chat_id` | absent | recommended |
| `broker.lease_duration_ms` | `10000` | no |
| `broker.heartbeat_interval_ms` | `2000` | no |
| `broker.election_jitter_ms` | `500` | no |
| `broker.state_dir` | `~/.pi/agent/telegram-broker` | yes |
| `ipc.transport` | platform default | yes |
| `ipc.request_timeout_ms` | `5000` | no |
| `telegram.poll_timeout_seconds` | `30` | no |
| `telegram.poll_limit` | `25` | no |
| `telegram.preview_throttle_ms` | `750` | no |
| `telegram.max_attachments_per_turn` | `10` | no |
| `telegram.media_group_debounce_ms` | `1200` | no |
| `telegram.max_message_length` | `4096` | no |
| `security.allow_remote_ipc` | `false` | yes |
| `security.attachment_roots` | `["cwd", "telegram_tmp"]` | no |
| `security.unrestricted_attachments` | `false` | no |
| `security.sensitive_path_denylist` | common secret paths | no |
| `telegram.max_inbound_file_bytes` | `52428800` | no |
| `telegram.max_outbound_attachment_bytes` | `52428800` | no |
| `debug.log_raw_updates` | `false` | no |

## 6. State and Lifecycle

### 6.1 Extension Instance States

- `uninitialized`: extension loaded but session_start not completed.
- `disconnected`: no Telegram session client active.
- `client_starting`: local client endpoint starting.
- `client_registered`: registered with a broker.
- `broker_candidate`: checking lease and trying election.
- `broker_active`: owns lease and Telegram polling.
- `broker_stopping`: relinquishing lease and stopping polling.
- `error`: unrecoverable local startup error.

Transitions:

- `session_start` moves `uninitialized -> disconnected`.
- `/telegram-connect` moves `disconnected -> client_starting`.
- Broker available moves `client_starting -> client_registered`.
- No broker or stale lease moves `client_starting -> broker_candidate`.
- Lease acquired moves `broker_candidate -> broker_active` and also registers the local session.
- Lease lost moves `broker_active -> client_starting`.
- `/telegram-disconnect` moves active client states to `disconnected`.
- `session_shutdown` moves any state to shutdown cleanup.

### 6.2 Broker States

- `starting`: lease acquired; IPC and Telegram validation in progress.
- `polling`: actively long polling Telegram.
- `degraded`: running but a recoverable subsystem is failing.
- `handover`: lease is expiring or being voluntarily released.
- `stopped`: no longer broker.

Transition triggers:

- `lease_acquired`: `starting`.
- `telegram_ready`: `starting -> polling`.
- `telegram_error_recoverable`: `polling -> degraded`.
- `telegram_recovered`: `degraded -> polling`.
- `lease_renew_failed`: `polling|degraded -> handover`.
- `shutdown`: any state -> `stopped`.

### 6.3 SessionRegistration States

- `connecting`: registration received but route not established.
- `idle`: route established and pi session idle.
- `busy`: session has active pi turn.
- `offline`: client heartbeat stale or IPC failed.
- `disconnecting`: client requested disconnect.
- `error`: client is connected but cannot process routed turns.

Transition triggers:

- `register_session`: absent -> `connecting`.
- `route_ready`: `connecting -> idle`.
- `client_agent_start`: `idle -> busy`.
- `client_agent_end`: `busy -> idle`.
- `client_heartbeat_stale`: any non-disconnecting state -> `offline`.
- `client_heartbeat_resumed`: `offline -> idle|busy` based on payload.
- `disconnect_session`: any state -> `disconnecting`, then remove or `offline`.

### 6.4 Turn States

- `queued`: broker accepted inbound Telegram message and created a turn.
- `delivered`: turn sent to Session Client over IPC.
- `active`: Session Client reported pi `agent_start` for the turn.
- `completed`: final response sent to Telegram.
- `aborted`: session was stopped by Telegram or pi abort.
- `failed`: routing, IPC, pi, or Telegram send failed.

Important nuance:

- `delivered` does not mean the pi model has started. It means the Session Client accepted the turn request and will call `pi.sendUserMessage`.

## 7. Core Behavior

### 7.1 `/telegram-connect`

Preconditions:

- Extension is loaded in a pi session.
- User has configured or can configure a Telegram bot token.

Behavior:

1. Load and validate config.
2. If no bot token exists and UI exists, prompt for setup.
3. Start the local Session Client endpoint.
4. Read current BrokerLease.
5. If a live broker exists, register with it.
6. If no live broker exists, enter election and try to become Broker Leader.
7. Register local session with the chosen broker.
8. Broker creates or reuses a Telegram route.
9. Broker sends a connection message to that route.
10. Extension status shows `telegram connected` or `telegram broker`.

Postconditions:

- The pi session has a `session_id` and Telegram route.
- If this instance is leader, it is polling Telegram.
- If this instance is client-only, it is heartbeat-connected to the leader.

### 7.2 Leader Election

The election must use an atomic filesystem operation. Acceptable approaches:

- Create a lock directory with exclusive `mkdir`.
- Use a lockfile library that performs atomic create/rename semantics.

The implementation must not use a plain read-then-write check without atomicity.

Election rules:

1. A lease is live when `Date.now() < lease_until_ms` and the owner process appears alive.
2. A lease is stale when `Date.now() >= lease_until_ms` or the owner process does not exist.
3. A candidate must wait random jitter in `[0, election_jitter_ms]` before trying to acquire a stale lease.
4. On successful acquisition, candidate increments `lease_epoch` from previous state or starts at `1`.
5. Broker heartbeats must renew `lease_until_ms = now + lease_duration_ms` every `heartbeat_interval_ms`.
6. If a leader cannot renew the lease twice consecutively, it must stop Telegram polling.

### 7.3 Session Registration and Route Creation

Broker registration behavior:

1. Validate IPC auth.
2. Validate `SessionRegistration` required fields.
3. Insert or update `sessions[session_id]`.
4. Determine route mode:
   - `private_topic` if bot `has_topics_enabled` and topic mode allows it.
   - `forum_supergroup_topic` if configured.
   - `single_chat_selector` otherwise.
5. For topic modes, call `createForumTopic` if no existing route exists.
6. Store `message_thread_id` from the returned forum topic.
7. Send a connection notice to the route.
8. Return route info to Session Client.

Route reuse:

- If the same `session_id` reconnects and has an existing route, reuse the route.
- If a new `session_id` appears for the same project, create a new route unless a user explicitly requested reuse.

Topic rename:

- On heartbeat, if derived `topic_name` changes because branch/session name changed, broker may call `editForumTopic`.
- Rename throttling: at most once per route per 60 seconds.

### 7.4 Inbound Telegram Routing

For each update:

1. Normalize update into `TelegramInboundMessage` if it contains a supported private/group message.
2. Ignore messages from bots.
3. If no allowed user is paired, accept pairing only when the message contains the active local pairing code generated by `/telegram-setup`; then record `allowed_user_id` and `allowed_chat_id` and clear the pairing code.
4. Reject messages from any other user. Send at most one short unauthorized reply per user/chat per cooldown window; otherwise ignore silently.
5. If message is a global command, handle globally.
6. Else derive `route_id` from `chat_id` and `message_thread_id`.
7. Look up `TelegramRoute`.
8. If route exists and session is online, deliver to that session.
9. If route exists but session is offline, reply that the session is offline and include `/sessions` hint.
10. If no route exists and fallback selector has an active selected session, route to selected session.
11. If no route exists and no selected session, reply with `/sessions` hint.
12. Mark update as processed only after the route action completes or failure response is sent.

### 7.5 Media Groups

Media group behavior must match current single-session behavior while becoming route-aware.

Rules:

- Group key: `${chat_id}:${message_thread_id ?? "default"}:${media_group_id}`.
- Debounce interval: `telegram.media_group_debounce_ms`.
- All messages in one group must route to the same session.
- If a media group straddles broker failover, duplicate handling is acceptable; loss is not.

### 7.6 Session Client Turn Delivery

When Session Client receives `deliver_turn`:

1. If local pi is idle, call `pi.sendUserMessage(turn.content)` immediately.
2. If local pi is busy, enqueue the turn locally and acknowledge `accepted_queued`.
3. If `deliver_turn` arrives while streaming and implementation chooses direct pi queueing, it must call `pi.sendUserMessage(..., { deliverAs: "followUp" })` or maintain a local queue and send after `agent_end`.
4. Report `turn_state_changed` to broker.

The Session Client owns its local active turn and `telegram_attach` queue. The Broker owns Telegram send operations.

### 7.7 Streaming Previews

Current behavior should be preserved but route-aware.

Rules:

- Session Client listens to pi `message_update` for assistant messages belonging to an active Telegram turn.
- It sends `assistant_preview` IPC messages to Broker with `turn_id` and text.
- Broker throttles sends per route using `telegram.preview_throttle_ms`.
- Broker tries `sendMessageDraft` first unless marked unsupported.
- If `sendMessageDraft` fails with unsupported method/permission, Broker falls back to `sendMessage` + `editMessageText`.
- Preview state is keyed by `turn_id`, not global process state.

### 7.8 Final Replies and Attachments

On pi `agent_end` for a Telegram turn:

1. Session Client extracts final assistant text and stop reason.
2. Session Client sends `assistant_final` to Broker with text, stop reason, error message, and queued attachments.
3. Broker finalizes any preview.
4. Broker sends final text chunks if needed.
5. Broker uploads queued attachments to the same route.
6. Broker marks turn completed or failed.

Attachment rules:

- `telegram_attach` is valid only for the Session Client's active Telegram turn.
- File paths must be local regular files in the Session Client process.
- Session Client may either upload file bytes through IPC or ask Broker to read the path if all sessions are on same machine. Core conformance uses file paths because all sessions are same user/machine.
- Broker must include `message_thread_id` on `sendPhoto` and `sendDocument` in topic modes.

### 7.9 Telegram Commands

Session-scoped commands:

- `/status`: status for current route/session.
- `/stop` or `stop`: abort active turn for current route/session.
- `/compact`: trigger compaction in current route/session if idle.
- `/model`: show current model and a short numbered list of available models for current route/session.
- `/model list [filter]`: list available models for current route/session, optionally filtered by case-insensitive substring.
- `/model <selector>`: switch current route/session to a model by exact `provider/id`, by number from the last model list shown in that route, or by unique case-insensitive substring.
- `/disconnect`: detach current route/session from Telegram.
- `/help`: route-specific help.

Global commands:

- `/sessions`: list active sessions.
- `/use <number|session_id>`: select active session in single-chat fallback mode.
- `/broker`: show broker owner, epoch, health.
- `/help`: global help when not in a session route.

Command routing rule:

- In a topic route, unqualified commands are session-scoped.
- In the default/private non-topic chat, commands are global unless a selector session is active.

Model command rules:

- `/model` without arguments must not invoke pi's interactive model picker. Telegram has no TUI selector. It returns text with the current model and a numbered list.
- Model lists must be built from models available to the target Session Client, not from the Broker Leader. The Broker Leader may be a different pi process with different dynamic provider state.
- `/model <number>` resolves against the last model list sent in the same Telegram route. The list cache is route-local and expires after 30 minutes.
- `/model <provider>/<id>` uses exact provider and model id matching.
- `/model <substring>` is accepted only when it matches exactly one available model across `provider/id` and display name. Ambiguous selectors must return a short match list and make no change.
- Model changes are allowed while the session is busy. The change applies to future provider requests; an already in-flight provider request may continue on the previous model.
- If the user is switching because of a rate limit, the expected workflow is `/model <selector>` and, if the active request is stuck or already failed, `/stop` followed by a follow-up prompt.
- A successful switch must report both previous and new model.
- If `pi.setModel(model)` returns false because auth is unavailable, the command must report `Model auth unavailable` and make no route/session state change.

### 7.10 Broker Failover

When a broker dies:

1. Heartbeat stops.
2. Clients observe lease expiration or IPC failures.
3. Clients wait jitter and attempt election.
4. New leader starts broker IPC and Telegram polling.
5. New leader loads `BrokerState`.
6. Clients register with new leader.
7. New leader resumes `getUpdates` at `last_processed_update_id + 1`.
8. Existing routes are reused.
9. Offline sessions remain listed for a grace period, default 5 minutes, then hidden unless `show_offline` is requested.

Important nuance:

- If the old leader was also controlling its own pi session and the process died, that session is offline. Another broker cannot continue that pi agent turn.

## 8. Integration Contracts

### 8.1 Telegram Bot API Contract

Compatibility profile:

- The normative contract is the Telegram Bot API as documented by Telegram.
- Implementations must tolerate optional fields missing when irrelevant.
- Implementations must handle Telegram 4xx/5xx errors by normalized category, not by exact English text only.

Required operations:

- `getMe`
- `deleteWebhook`
- `getUpdates`
- `sendMessage`
- `editMessageText`
- `sendMessageDraft`
- `sendChatAction`
- `getFile`
- file download via `https://api.telegram.org/file/bot<TOKEN>/<file_path>`
- `sendPhoto`
- `sendDocument`
- `createForumTopic` when topic mode is used
- `editForumTopic` when topic rename is implemented

Illustrative `getUpdates` call:

```json
{
  "method": "getUpdates",
  "body": {
    "offset": 12346,
    "limit": 25,
    "timeout": 30,
    "allowed_updates": ["message", "edited_message"]
  }
}
```

Illustrative topic send:

```json
{
  "method": "sendMessage",
  "body": {
    "chat_id": 123456789,
    "message_thread_id": 42,
    "text": "Connected to pi-telegram · main"
  }
}
```

Telegram references:

- Telegram documents that `getUpdates` confirms updates when offset is higher than an update id, and that `getUpdates` does not work while a webhook is set: https://core.telegram.org/bots/api#getupdates
- Telegram documents `has_topics_enabled` and `allows_users_to_create_topics` on `User` returned by `getMe`: https://core.telegram.org/bots/api#user
- Telegram documents `createForumTopic` for forum supergroup chats or private chats with users, with topic names 1-128 characters: https://core.telegram.org/bots/api#createforumtopic
- Telegram Bot API changelog records private-chat topic support and managed bots additions: https://core.telegram.org/bots/api-changelog

Timeouts:

- Telegram API non-poll request timeout: `30000` ms.
- Long poll timeout: `telegram.poll_timeout_seconds` plus HTTP client slack of `5000` ms.
- File download timeout: `120000` ms.
- Upload timeout: `120000` ms.

Error categories:

- `telegram_invalid_token`: `401` or invalid `getMe` response.
- `telegram_unauthorized_user`: inbound user mismatch.
- `telegram_webhook_conflict`: `getUpdates` fails because webhook is set or conflict occurs.
- `telegram_rate_limited`: `429` with optional `retry_after`.
- `telegram_topics_unavailable`: create/send with topic fails due to no forum/private topic support.
- `telegram_topic_not_found`: message thread invalid/deleted.
- `telegram_send_failed`: send/edit/upload failed after retries.
- `telegram_file_download_failed`: `getFile` or file URL failed.
- `telegram_network_error`: fetch/connectivity failure.
- `telegram_api_error`: uncategorized non-ok API response.

### 8.2 Local IPC Contract

Compatibility profile:

- IPC is private to the local machine and current user.
- Message schemas must be versioned.
- Unknown message types must receive an `unsupported_message_type` error response.
- Unknown fields must be ignored for forward compatibility.

Transport:

- Unix socket path default: `~/.pi/agent/telegram-broker/broker.sock`.
- Loopback HTTP default: random available port on `127.0.0.1`.
- Every request must include local bearer token authentication.

Common envelope:

```json
{
  "schema_version": 1,
  "id": "msg_01",
  "type": "register_session",
  "session_id": "pis_abc",
  "payload": {},
  "sent_at_ms": 1777070000000
}
```

Response envelope:

```json
{
  "schema_version": 1,
  "id": "msg_01",
  "ok": true,
  "payload": {},
  "error": null,
  "sent_at_ms": 1777070000010
}
```

Error response envelope:

```json
{
  "schema_version": 1,
  "id": "msg_01",
  "ok": false,
  "payload": null,
  "error": {
    "code": "session_not_found",
    "message": "Session is not registered"
  },
  "sent_at_ms": 1777070000010
}
```

Client to Broker message types:

- `register_session`
  - Payload: `SessionRegistration` without route fields if unknown.
  - Response: `TelegramRoute` and broker metadata.
- `heartbeat_session`
  - Payload: session status, active turn, queued count, model, git/session metadata.
  - Response: possibly updated route and broker commands.
- `turn_state_changed`
  - Payload: `turn_id`, old state, new state, optional error.
- `assistant_preview`
  - Payload: `turn_id`, text.
- `assistant_final`
  - Payload: `turn_id`, text, stop reason, error message, queued attachments.
- `model_list_result`
  - Payload: command id, current model, available model summaries, optional filter, route-local list token.
- `model_set_result`
  - Payload: command id, previous model, new model, selector, success boolean, optional error.
- `session_command_result`
  - Payload: command id, result text, error.
- `disconnect_session`
  - Payload: reason.

Broker to Client message types:

- `deliver_turn`
  - Payload: `PendingTelegramTurn`.
- `abort_turn`
  - Payload: `turn_id` or `active`.
- `compact_session`
  - Payload: command id, optional custom instructions.
- `query_status`
  - Payload: command id.
- `query_models`
  - Payload: command id, optional filter, maximum result count.
- `set_model`
  - Payload: command id, selector, optional route-local list token.
- `shutdown_client_route`
  - Payload: reason.

IPC timeout behavior:

- Request timeout: `ipc.request_timeout_ms`.
- Heartbeat interval from client to broker: `3000` ms default.
- Session considered offline after no heartbeat for `15000` ms by default.

IPC error categories:

- `ipc_auth_failed`
- `ipc_broker_unreachable`
- `ipc_client_unreachable`
- `ipc_timeout`
- `ipc_schema_invalid`
- `unsupported_message_type`
- `session_not_found`
- `broker_epoch_mismatch`
- `model_catalog_unavailable`
- `model_not_found`
- `model_selector_ambiguous`
- `model_list_expired`
- `model_auth_unavailable`
- `model_switch_failed`

### 8.3 pi Extension API Contract

Required commands registered in every pi session:

- `/telegram-setup`
- `/telegram-connect`
- `/telegram-disconnect`
- `/telegram-status`
- `/telegram-broker-status`

Required tool:

- `telegram_attach`

Required event hooks:

- `session_start`: load config, initialize status, capture initial model catalog from `ctx.modelRegistry.getAvailable()` and current `ctx.model`.
- `session_shutdown`: unregister, stop client endpoint, stop broker if leader.
- `model_select`: update Session Client model snapshot and notify Broker Leader through the next heartbeat.
- `before_agent_start`: append Telegram system prompt guidance for Telegram-originated turns.
- `agent_start`: mark Session Client busy.
- `message_start`: initialize preview state for Telegram-originated assistant message.
- `message_update`: send preview IPC event.
- `agent_end`: send final IPC event and maybe process queued turns.

Model handling:

- The Session Client must resolve `/model` requests locally using its latest model snapshot.
- The model snapshot must contain `provider`, `id`, `name`, `input`, `reasoning`, and auth availability according to `ctx.modelRegistry.getAvailable()`.
- To change models, the Session Client calls `pi.setModel(model)` with the resolved model object.
- If the model catalog is unavailable, the Session Client must return `model_catalog_unavailable` rather than asking the Broker Leader to guess.

Policy handling:

- The extension must not auto-approve pi tool calls. It only transports user messages and assistant outputs.
- Telegram `stop` maps to `ctx.abort()` in the target Session Client.

## 9. Observability

### 9.1 pi UI Status

Each extension instance must set a status key `telegram`.

Client-only examples:

- `telegram disconnected`
- `telegram connecting`
- `telegram connected pi-telegram · main`
- `telegram offline broker unreachable`

Broker examples:

- `telegram broker 3 sessions`
- `telegram broker degraded rate limited 12s`
- `telegram broker handover`

### 9.2 Telegram Status Output

`/sessions` output must include:

```text
Active pi sessions
1. pi-telegram · main — busy — 1 queued
2. backend-api · auth-refactor — idle
3. docs-site · main — offline 2m

Use /use 1 in selector mode, or open the session topic.
```

Session `/status` output must include:

```text
Project: pi-telegram
CWD: /Users/csto/Documents/Development/pi-telegram
Branch: main
Session: investigate extension
Model: openai/gpt-5.1-codex
State: busy
Queued: 1
Broker: pid 12345 epoch 7
Context: 42.1%/200k
Usage: ↑12.4k ↓2.1k
```

### 9.3 Structured Logs

Every log entry should include:

- `component`: `broker`, `client`, `election`, `telegram-api`, `ipc`, `router`.
- `owner_id`.
- `session_id` when applicable.
- `lease_epoch` when applicable.
- `chat_id` when applicable.
- `message_thread_id` when applicable.
- `update_id` when applicable.
- `turn_id` when applicable.

Secret handling:

- Bot token must be redacted as `<redacted-token>`.
- IPC bearer token must never be logged.
- Raw update logging disabled by default.

### 9.4 Runtime Snapshot

`/telegram-broker-status` must show a local UI notification with at least:

```json
{
  "is_broker": true,
  "owner_id": "own_abc",
  "lease_epoch": 7,
  "lease_until_ms": 1777070010000,
  "sessions_total": 3,
  "sessions_online": 2,
  "last_processed_update_id": 12345,
  "telegram_poll_state": "polling",
  "last_error": null
}
```

Optional local debug endpoint may expose the same snapshot over IPC but must require local auth.

## 10. Failure Model and Recovery

### 10.1 Config Failures

- `config_missing_token`
  - Recovery: prompt setup if UI exists; otherwise show command error.
- `config_invalid_token`
  - Recovery: do not broker; prompt reconfiguration.
- `config_topic_mode_unavailable`
  - Recovery: fall back according to configured fallback mode or refuse connect if `disabled`.
- `config_state_dir_unwritable`
  - Recovery: fail connect with exact path and OS error.

### 10.2 Election Failures

- `lease_stale_but_locked`
  - Recovery: wait jitter and retry; do not start Telegram polling.
- `lease_renew_failed`
  - Recovery: stop polling after two consecutive failures, enter client reconnect.
- `split_brain_detected`
  - Recovery: instance with lower `lease_epoch` or failed lease ownership check stops polling immediately.

### 10.3 Telegram Failures

- `telegram_network_error`
  - Recovery: retry with backoff `min(1000 * 2^attempt, 30000)` ms.
- `telegram_rate_limited`
  - Recovery: sleep `retry_after` seconds when provided; otherwise use network backoff.
- `telegram_topics_unavailable`
  - Recovery: switch to fallback mode for new routes and notify user.
- `telegram_topic_not_found`
  - Recovery: recreate topic for session and update route.
- `telegram_send_failed`
  - Recovery: retry up to 3 times for transient errors, then mark turn failed and log.

### 10.4 IPC Failures

- `ipc_broker_unreachable`
  - Recovery: client checks lease; if stale, attempts election; otherwise retries.
- `ipc_client_unreachable`
  - Recovery: broker marks session offline after threshold and reports offline to Telegram.
- `ipc_timeout`
  - Recovery: retry once for idempotent messages; for `deliver_turn`, avoid duplicate by `turn_id`.

### 10.5 pi Session Failures

- `pi_turn_aborted`
  - Recovery: clear preview; reply `Aborted current turn.` when initiated from Telegram.
- `pi_turn_error`
  - Recovery: send error message to route.
- `pi_session_shutdown`
  - Recovery: unregister session or mark offline if graceful unregister fails.
- `pi_reload`
  - Recovery: old instance unregisters; new instance may reconnect with a new `owner_id`.

### 10.6 Restart Recovery

On new broker startup:

1. Load `BrokerState`.
2. Drop routes whose sessions are offline beyond grace period only from active listing, not from stored state.
3. Keep `last_processed_update_id`.
4. Resume polling with `offset = last_processed_update_id + 1`.
5. Accept duplicate updates if Telegram redelivers; suppress by `recent_update_ids`.

## 11. Security and Safety

### 11.1 Self-Use Security Posture

This extension is for personal use. Security controls must be quiet by default and must not turn the extension into a lecture machine.

Required posture:

- Prefer silent hardening over repeated warnings.
- Show setup-time or command-time errors only when the user must take action.
- Do not add confirmation prompts for normal prompt forwarding, `/status`, `/sessions`, `/stop`, or `/compact`.
- Do not implement multi-policy remote control modes in core conformance. Telegram control is full control for the paired user, subject to existing pi permissions and the file-attachment guardrails below.
- Keep safeguards small and mechanical: local pairing code, local-only IPC auth, file permissions, route isolation, attachment root checks, size limits, and token redaction.

Design note:

- The paired Telegram account is treated as the operator. If that account is compromised, this extension cannot distinguish the attacker from the operator. The implementation should not add noisy runtime warnings for that case; it should keep the blast radius bounded through route isolation and attachment limits.

### 11.2 Trust Boundary

Trusted:

- Local pi extension code.
- Current OS user account.
- Local filesystem under `~/.pi/agent`.

Untrusted:

- Telegram message content.
- Telegram file names and MIME types.
- Telegram users other than `allowed_user_id`.
- Raw paths mentioned by the Telegram user.

### 11.3 Safety Invariants

Invariant 1: Only one broker may call `getUpdates` for a bot token at a time.

Invariant 2: Telegram updates from unauthorized users must never reach pi as prompts.

Invariant 3: Bot token and IPC auth token must never be logged or sent to pi model context.

Invariant 4: Downloaded Telegram file names must be sanitized before writing to disk.

Invariant 5: Session-scoped Telegram commands must affect only the route/session from which they were sent.

Invariant 6: `telegram_attach` must only send regular local files explicitly queued during an active Telegram-originated turn.

Invariant 7: IPC must bind only to local machine interfaces in core conformance.

Invariant 8: Pairing must require a local, single-use pairing code; the first Telegram user to message the bot without the code must not become authorized.

Invariant 9: `telegram_attach` must enforce attachment roots, sensitive path denylist, and outbound size limit unless explicitly configured for unrestricted attachments.

### 11.4 Secret Handling

- Store bot token in config file with user-readable permissions only where practical.
- Redact token in all error messages.
- Do not include config file contents in prompts.
- Hash IPC bearer token in lease if a token identifier must be persisted.
- Pass raw IPC token only through process memory or a user-readable protected endpoint file.

### 11.5 Telegram File Safety

- Sanitize Telegram file names with regex `[^a-zA-Z0-9._-]+ -> _`.
- Prefix downloaded files with timestamp and random suffix.
- Store downloads under `~/.pi/agent/tmp/telegram/<session_id>/`.
- Do not execute downloaded files.
- Include local file paths in prompts only as paths for the model to inspect via tools.
- Reject inbound Telegram files larger than `telegram.max_inbound_file_bytes` before download when Telegram provides `file_size`; after download, delete and reject files that exceed the limit.
- Reject outbound `telegram_attach` files larger than `telegram.max_outbound_attachment_bytes`.
- Reject outbound `telegram_attach` paths outside `security.attachment_roots` unless `security.unrestricted_attachments` is true.
- Reject outbound `telegram_attach` paths matching `security.sensitive_path_denylist` unless `security.unrestricted_attachments` is true.

## 12. Reference Algorithms

### 12.1 Connect Session

```text
function telegram_connect(ctx):
  config = load_config()
  if config.telegram.bot_token is absent:
    config = prompt_or_fail_setup(ctx)

  client = start_session_client_endpoint()
  metadata = collect_pi_session_metadata(ctx)
  session = build_session_registration(metadata, client.endpoint)

  broker = find_live_broker()
  if broker exists:
    result = ipc_register_session(broker, session)
    if result ok:
      set_client_registered(result.route)
      return

  election_result = attempt_broker_election()
  if election_result acquired:
    start_broker(election_result.lease)
    result = register_local_session_with_self(session)
    set_broker_active(result.route)
    return

  broker = wait_for_broker_after_election()
  result = ipc_register_session(broker, session)
  set_client_registered(result.route)
```

### 12.2 Broker Poll Loop

```text
function broker_poll_loop(state):
  call deleteWebhook(drop_pending_updates=false)

  while broker_has_valid_lease():
    offset = state.last_processed_update_id + 1 if present else absent
    updates = telegram_get_updates(offset, poll_limit, poll_timeout_seconds)

    for update in updates:
      if update.update_id in state.recent_update_ids:
        state.last_processed_update_id = max(state.last_processed_update_id, update.update_id)
        persist_state(state)
        continue

      result = route_update(update, state)
      if result processed:
        add_recent_update_id(state, update.update_id)
        state.last_processed_update_id = update.update_id
        state.updated_at_ms = now_ms()
        persist_state(state)
      else:
        log route failure
        send_failure_response_if_possible(update)
        add_recent_update_id(state, update.update_id)
        state.last_processed_update_id = update.update_id
        persist_state(state)
```

### 12.3 Route Telegram Update

```text
function route_update(update, state):
  inbound = normalize_update(update)
  if inbound is none:
    return processed

  if inbound.from_user_id is bot:
    return processed

  if config.allowed_user_id is absent:
    if inbound text contains valid active pairing code:
      pair_user(inbound.from_user_id, inbound.chat_id)
      clear_pairing_code()
    else:
      maybe_send_rate_limited_pairing_hint(inbound.chat_id)
      return processed

  if inbound.from_user_id != config.allowed_user_id:
    send_text(inbound.chat_id, inbound.message_thread_id, "This bot is not authorized for your account.")
    return processed

  command = parse_command(inbound.text)
  if command is global:
    handle_global_command(command, inbound, state)
    return processed

  route_id = build_route_id(inbound.chat_id, inbound.message_thread_id)
  route = state.routes[route_id]
  if route is absent:
    handle_unrouted_message(inbound, state)
    return processed

  session = state.sessions[route.session_id]
  if session is absent or session.status == "offline":
    send_text(route.chat_id, route.message_thread_id, "That pi session is offline. Send /sessions to pick another.")
    return processed

  turn = build_pending_turn(inbound, route.session_id)
  response = ipc_deliver_turn(session.client_endpoint, turn)
  if response accepted:
    mark_turn_delivered(turn)
  else:
    send_text(route.chat_id, route.message_thread_id, "Failed to deliver turn: " + response.error.code)
  return processed
```

### 12.4 Broker Heartbeat

```text
function broker_heartbeat_loop(lease):
  failures = 0
  while broker_running:
    sleep(heartbeat_interval_ms)
    current = read_lease()
    if current.owner_id != lease.owner_id or current.lease_epoch != lease.lease_epoch:
      stop_polling()
      become_client()
      return

    next = current
    next.lease_until_ms = now_ms() + lease_duration_ms
    next.updated_at_ms = now_ms()
    write_lease_atomically(next)
    if write failed:
      failures = failures + 1
      if failures >= 2:
        stop_polling()
        become_client()
        return
    else:
      failures = 0
```

### 12.5 Session Client Event Flow

```text
function on_deliver_turn(turn):
  if turn.turn_id already seen:
    return accepted_duplicate

  enqueue_local_turn(turn)
  report_turn_state(turn.turn_id, "queued")

  if pi_is_idle():
    start_next_local_turn()

  return accepted

function start_next_local_turn():
  turn = dequeue_local_turn()
  active_turn = turn
  report_turn_state(turn.turn_id, "delivered")
  pi_send_user_message(turn.content)

function on_agent_start(ctx):
  if active_turn exists:
    report_turn_state(active_turn.turn_id, "active")

function on_message_update(message):
  if active_turn exists and message is assistant:
    text = extract_text(message)
    ipc_send_assistant_preview(active_turn.turn_id, text)

function on_agent_end(event):
  if active_turn absent:
    return
  final = extract_final_assistant(event.messages)
  ipc_send_assistant_final(active_turn.turn_id, final.text, final.stop_reason, queued_attachments)
  active_turn = none
  if local_queue not empty:
    start_next_local_turn()
```

## 13. Test and Validation Matrix

### 13.1 Core Conformance: Election and Broker

- Starting one connected pi session creates a lease and starts exactly one broker.
- Starting three connected pi sessions results in one broker and two client-only sessions.
- A live lease prevents another instance from calling `getUpdates`.
- A stale lease can be acquired by another instance after `lease_duration_ms` plus jitter.
- If broker heartbeat write fails twice, broker stops polling.
- If two candidates race, at most one writes the winning lease epoch and starts polling.
- Broker advances `last_processed_update_id` only after route handling completes.
- Broker resumes polling from `last_processed_update_id + 1` after failover.

### 13.2 Core Conformance: Session Routing

- `/telegram-connect` registers a session and creates/reuses a route.
- Two sessions in different projects get different `session_id` values and different routes.
- Two sessions in the same project still get different `session_id` values.
- In topic mode, inbound message with `chat_id` and `message_thread_id` routes to matching session.
- In topic mode, outbound replies include the same `message_thread_id`.
- Message in unknown topic returns `/sessions` guidance instead of routing randomly.
- Offline session route returns offline message and does not call `pi.sendUserMessage`.
- `/stop` in one topic aborts only that topic's session.

### 13.3 Core Conformance: Telegram Features

- `getMe` detects `has_topics_enabled` and records it.
- `createForumTopic` stores returned `message_thread_id`.
- Topic names are truncated to 128 characters with a stable suffix.
- `sendMessageDraft` failure falls back to message edit preview.
- Long final replies are split at or below `4096` characters.
- Media groups are debounced by chat/thread/media group key.
- Telegram attachments are downloaded to sanitized paths.
- `telegram_attach` uploads files to the same route as the active turn.

### 13.4 Core Conformance: IPC

- Broker rejects IPC requests with missing or invalid auth.
- Broker rejects unknown message types with `unsupported_message_type`.
- Client retries broker registration after `ipc_broker_unreachable`.
- Broker marks session offline after heartbeat timeout.
- Duplicate `deliver_turn` with same `turn_id` is not delivered twice to pi.
- IPC request timeout produces typed `ipc_timeout` error.

### 13.5 Core Conformance: Commands

- `/sessions` lists active and recently offline sessions.
- `/status` in topic returns status for that session.
- `/compact` in busy session returns a busy message.
- `/compact` in idle session triggers `ctx.compact` and reports completion/failure.
- `/model` returns current model and a route-local numbered list of available models.
- `/model list sonnet` returns only models whose `provider/id` or display name contains `sonnet` case-insensitively.
- `/model <provider>/<id>` calls `pi.setModel` in the target Session Client, not in the Broker Leader.
- `/model <number>` resolves against the last route-local model list and expires after 30 minutes.
- Ambiguous `/model <substring>` returns candidate matches and does not change the model.
- `/model` while busy reports success when `pi.setModel` succeeds and notes that in-flight provider requests may continue on the previous model.
- `/disconnect` detaches the current session route.
- `/help` in topic shows session-scoped commands.
- `/help` in default chat shows global commands.

### 13.6 Security

- Unauthorized Telegram user message never reaches pi.
- Bot token is redacted from logs and errors.
- IPC bearer token is not logged.
- Downloaded filenames with slashes or shell metacharacters are sanitized.
- Loopback HTTP binds only to `127.0.0.1` unless a non-core unsafe option is explicitly enabled.

### 13.7 Real Integration Profile

- With a real topic-enabled bot, `/telegram-connect` creates a private-chat topic.
- Sending text in that topic reaches the correct pi session.
- Sending an image in that topic reaches pi as text plus image content.
- Asking pi to create and attach a file sends the file back to the same topic.
- Killing the broker pi process causes another connected session to become broker and continue receiving updates.
- Blocking the bot in Telegram produces a clear send failure without crashing broker.

## 14. Implementation Checklist

This section is intentionally redundant with the test matrix so an implementing agent can track completion independently of test authoring.

### 14.1 Required for Core Conformance

- [ ] Split current single-file extension into config, election, IPC, broker, router, Telegram API, session client, and formatting modules.
- [ ] Implement v2 config loading and migration from existing `telegram.json`.
- [ ] Implement atomic lease acquisition and heartbeat renewal.
- [ ] Implement broker failover and stale lease detection.
- [ ] Implement local IPC with auth and versioned message envelopes.
- [ ] Implement session registration and heartbeat.
- [ ] Implement broker-only `getUpdates` loop.
- [ ] Implement route-aware Telegram send/edit/upload/download methods.
- [ ] Add `message_thread_id` and `is_topic_message` to Telegram types.
- [ ] Implement private topic route creation with `createForumTopic`.
- [ ] Implement fallback selector mode.
- [ ] Implement local single-use pairing code instead of first-user pairing.
- [ ] Implement attachment root checks, sensitive path denylist, and inbound/outbound file size limits.
- [ ] Refactor preview state to be keyed by `turn_id`.
- [ ] Refactor attachment queue to be per active Telegram turn.
- [ ] Implement global and session-scoped Telegram commands.
- [ ] Implement Telegram `/model`, `/model list [filter]`, and `/model <selector>` through the target Session Client.
- [ ] Implement route-local model list cache with 30-minute expiry.
- [ ] Implement model snapshot refresh on `session_start`, heartbeat, and `model_select`.
- [ ] Implement structured status and broker status UI.
- [ ] Add tests or test harnesses for election, routing, IPC, and formatting.

### 14.2 Recommended Extensions

- [ ] Implement `editForumTopic` rename throttling.
- [ ] Implement forum supergroup fallback profile.
- [ ] Implement local debug snapshot endpoint over authenticated IPC.
- [ ] Implement route garbage collection for long-offline sessions.
- [ ] Implement richer `/sessions` output with inline keyboard buttons if desired.

### 14.3 Explicit Future Work

- [ ] Managed bots profile: create per-session managed bots from one manager bot.
  - Rationale: powerful but not necessary when private topics work.
- [ ] Multi-human authorization.
  - Rationale: requires ACLs per route and audit behavior.
- [ ] Cross-machine broker.
  - Rationale: requires secure network transport and different trust model.
- [ ] Webhook mode.
  - Rationale: needs public endpoint or tunnel and conflicts with no-extra-process goal.
