# Getting started

This guide describes the current user-facing workflow for installing, pairing, connecting, routing, and using `pi-telegram`.

## 1. Install

From Git:

```bash
pi install git:github.com/badlogic/pi-telegram
```

For one pi invocation:

```bash
pi -e git:github.com/badlogic/pi-telegram
```

The package entrypoint is lazy. Installing the extension registers pi-visible commands and the `telegram_attach` tool, but the heavy Telegram broker/client runtime is not imported or started until Telegram is invoked or a valid session-replacement handoff needs recovery.

## 2. Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather).
2. Run `/newbot`.
3. Choose a bot name and username.
4. Copy the bot token.

Optional: set Telegram command autocomplete in BotFather with the command list shown in [`../README.md`](../README.md).

## 3. Configure and pair

In pi:

```text
/telegram-setup
```

Paste the bot token when prompted. The setup flow validates the bot token with Telegram, stores local config, and shows an attended 4-digit PIN with a 5-minute pairing window.

In Telegram, open the bot DM and send either:

```text
<PIN>
```

or:

```text
/start <PIN>
```

The first Telegram user who sends the valid current PIN becomes the allowed user. Updates from other users fail closed. Repeated wrong PIN attempts end the pairing window and require rerunning `/telegram-setup`.

## 4. Connect pi sessions

In each pi session that should be reachable from Telegram:

```text
/telegram-connect
```

One connected session becomes the broker that polls Telegram. Other connected sessions register with that broker through local IPC and get their own route/topic.

Useful local status commands:

```text
/telegram-status
/telegram-broker-status
```

To disconnect the current session:

```text
/telegram-disconnect
```

An explicit disconnect unregisters the session, hides local status, and cleans up the session's Telegram view/topic where applicable.

## 5. Choose a routing mode

`pi-telegram` supports multiple connected sessions. A route is a temporary Telegram view into a connected pi session, not the durable pi session history.

In automatic mode, the bridge uses per-session bot/private topics when Telegram supports them and falls back to selector-style routing when topics are unavailable or disabled by config.

### Selector-style fallback routing

In a bot DM or configured selector chat:

```text
/sessions
/use <number>
```

The selected session receives later unrouted messages for a bounded selection window. Use `/sessions` again if a session disappears, reconnects, or several sessions have similar names.

### Forum-supergroup topic routing

To use a Telegram forum supergroup as the topic home:

1. Add the bot to a forum supergroup.
2. Make the bot an admin with topic-management permissions.
3. In pi, run:

   ```text
   /telegram-topic-setup
   ```

4. From the paired Telegram account, send this inside the forum supergroup:

   ```text
   /topicsetup
   ```

The broker switches routing config to that group and creates/updates per-session topics. If topic setup fails, the previous routing config is restored where possible and orphaned topic cleanup is recorded for retry.

## 6. Send work from Telegram

- A normal Telegram message becomes pi user input for the selected session.
- If the session is idle, it starts a turn.
- If the session is busy or already has queued work, the message queues as follow-up work by default.
- `/follow <message>` explicitly queues follow-up work.
- `/steer <message>` explicitly steers the active turn when still valid.
- Eligible queued follow-ups may show `Steer now` and `Cancel` buttons.
- `stop` or `/stop` aborts active work and clears eligible queued work.

Telegram-originated input is marked with a `[telegram]` prefix before entering pi so local context can distinguish it from native terminal input.

## 7. Observe progress and finals

While pi works, the bridge sends activity updates and typing indicators through the session route. Activity rendering is debounced, but underlying activity history is preserved.

Assistant text is delivered to Telegram as final reply text, not as streamed assistant preview text. Long final replies are split below Telegram's 4096-character text limit. The broker persists final-delivery progress so retryable Telegram errors resume from recorded chunks/attachments instead of intentionally resending earlier visible output.

## 8. Exchange files

### Inbound Telegram files

Telegram photos, albums, and documents are downloaded into private local session temp storage:

```text
~/.pi/agent/tmp/telegram/<session-id>
```

Downloaded files are untrusted. Prompts include local file paths, and inbound images may be forwarded as image inputs where size/policy allows.

Hosted Bot API downloads are capped at 20 MB. File paths from Telegram are optional, so missing `file_path` is a handled error rather than an assumption.

### Outbound local files

If you ask pi to create or send a file back, the assistant must call `telegram_attach` during the active Telegram turn. Mentioning a local path in text is not enough.

Current outbound guardrails:

- max 10 attachments per turn;
- max 50 MB per local attachment;
- allowed paths are the session workspace and bridge temp directory;
- obvious secret paths such as `.env`, SSH keys, and cloud credential directories are blocked;
- likely photos under Telegram's photo limit use `sendPhoto`; non-photos and photo-contract failures use `sendDocument`.

## 9. Disconnect and cleanup expectations

- `/telegram-disconnect` or Telegram `/disconnect` explicitly unregisters a session and removes its route/topic.
- Normal terminal shutdown should unregister and clean up unless a successful native session replacement handoff is underway.
- Heartbeat or IPC loss first marks a session offline, then preserves its route during a bounded reconnect grace window.
- If reconnect grace expires, the broker unregisters the session and records route/topic cleanup work.
- Temporary Telegram topics are views over connected sessions; native pi history remains local and can be resumed separately.

## Troubleshooting

### Bot says to pair first

Run `/telegram-setup` in pi and send the current PIN in the bot DM. Old PIN messages and stale setup windows are rejected.

### `getUpdates` conflicts or polling fails

The broker deletes webhooks before long polling. If Telegram still reports a webhook conflict, inspect bot webhook settings and rerun `/telegram-connect`; the bridge should retry webhook deletion before polling.

### No session selected

Send `/sessions`, then `/use <number>`, or send the message inside the session topic if topic routing is configured.

### The selected session is offline

The session may have closed, lost heartbeat, or exceeded reconnect grace. Reconnect from pi with `/telegram-connect`, then choose it again from Telegram if needed.

### File upload is rejected

Check that the file is inside the workspace or bridge temp directory, is a regular file, is below 50 MB, and is not under a secret-looking path.

### Telegram activity or finals lag

Telegram `retry_after` is honored. During rate-limit windows, the bridge should wait instead of falling back, retrying immediately, or advancing update/final state incorrectly.
