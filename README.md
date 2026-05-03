# pi-telegram

`pi-telegram` is a pi extension that lets one paired Telegram user supervise and control local pi sessions from a phone while the actual agent work, shell access, credentials, and workspace state stay on the computer running pi.

Use it when you want to leave the laptop but keep watching long agent runs, queue follow-up instructions, steer urgent corrections, stop work, and receive final answers or generated artifacts in Telegram.

## Current capabilities

- Connect one or more local pi sessions to one Telegram bot.
- Elect one connected session as the local broker; other sessions register through local IPC.
- Pair exactly one Telegram user with an attended PIN.
- Route per-session Telegram traffic through private topics, forum-supergroup topics, or selector mode.
- Mirror activity during active turns, including mid-turn `/telegram-connect`.
- Queue ordinary busy-session Telegram messages as follow-up work by default.
- Support explicit `/steer`, `/follow`, `/stop`, `/compact`, `/model`, `/git`, `/sessions`, `/use`, and `/disconnect` controls.
- Deliver assistant finals through a broker-owned durable retry ledger so long/chunked replies and attachments can survive Telegram retry windows or broker turnover without intentional duplication.
- Exchange files with local path and secret guards; generated artifacts must be explicitly queued with the `telegram_attach` tool.
- Lazy-load the heavy Telegram runtime so simply installing the extension does not start polling or IPC until Telegram is invoked or a valid handoff is recovered.

## Install

From Git:

```bash
pi install git:github.com/Evizero/pi-telegram
```

For a single pi run:

```bash
pi -e git:github.com/Evizero/pi-telegram
```

## Quick start

1. Create a Telegram bot with [@BotFather](https://t.me/BotFather) and copy the bot token.
2. In pi, run:

   ```text
   /telegram-setup
   ```

3. Paste the token when prompted.
4. In Telegram, open the bot DM and send the 4-digit PIN shown by pi within 5 minutes. `/start <PIN>` also works.
5. In each pi session you want reachable from Telegram, run:

   ```text
   /telegram-connect
   ```

6. Send Telegram messages to the bot. Use `/sessions` and `/use <number>` when several sessions are connected in selector mode.

Optional BotFather command list:

```text
start - Show help or pair with a PIN
help - Show available commands
sessions - List active pi sessions
use - Select a pi session in selector mode
status - Show selected session status
git - Show read-only repository status and diffstat tools
model - Show or change the selected session model
compact - Compact the selected session context
follow - Queue a follow-up for after active work
steer - Steer active work with an urgent correction
stop - Stop the active run
disconnect - Disconnect the selected pi session
broker - Show Telegram broker status
topicsetup - Use this forum group for per-session topics
```

## pi commands

```text
/telegram-setup          Configure the bot token and attended pairing PIN
/telegram-connect        Connect this pi session to Telegram
/telegram-disconnect     Disconnect this pi session and remove its route/topic
/telegram-status         Show local bridge status
/telegram-broker-status  Show broker lease/session/update status
/telegram-topic-setup    Show instructions for Telegram /topicsetup
```

## Telegram usage highlights

- **Normal message:** sends input to the selected pi session. If that session is busy, the message queues as follow-up work.
- **`/follow <message>`:** explicitly queues follow-up work.
- **`/steer <message>`:** explicitly steers the active turn when still valid.
- **Queued follow-up buttons:** eligible busy-session follow-ups may show `Steer now` and `Cancel` buttons.
- **`/compact`:** starts immediately when idle; otherwise queues an ordered manual-compaction barrier before later follow-ups.
- **`/git`:** opens read-only status/diffstat controls for the selected local workspace.
- **`/model`:** opens or applies model-selection controls for the selected session.
- **`/disconnect`:** disconnects the selected pi session and cleans up its Telegram view.

## Files and attachments

Inbound Telegram files are downloaded under:

```text
~/.pi/agent/tmp/telegram/<session-id>
```

Generated or local files are sent back only when pi explicitly calls the
`telegram_attach` tool during an active Telegram turn. The attachment guard
canonicalizes paths, allows workspace files and bridge temp files, limits each
file to 50 MB, limits a reply to 10 attachments, and blocks obvious secret paths
such as `.env`, SSH keys, and common cloud/Kubernetes credential locations.

## Runtime files

```text
~/.pi/agent/telegram.json                    Bot config and pairing state
~/.pi/agent/telegram-broker[/bot-<botId>]/   Broker lease, token, IPC, state, handoff records
~/.pi/agent/tmp/telegram/<session-id>/       Downloaded Telegram attachments
```

Keep these private. Do not commit or share token-bearing files.

## Developer workflow

```bash
npm install
npm run check
```

`npm run check` runs TypeScript typechecking and the behavior-check suite under `scripts/check-*.ts`.

## Documentation

Start here:

- [Documentation index](docs/index.md)
- [Getting started](docs/getting-started.md)
- [Telegram command reference](docs/telegram-commands.md)
- [Runtime architecture](docs/internals/runtime-architecture.md)
- [State and reliability](docs/internals/state-and-reliability.md)
- [Maintenance guide](docs/maintenance.md)
- [Telegram Bot API notes](docs/telegram-bot-api.md)

## Scope boundaries

`pi-telegram` is not a hosted relay, a public webhook service, a remote IDE, a multi-user collaboration product, or a general-purpose Telegram bot framework. Telegram is the control surface; pi remains the execution authority.

## License

MIT
