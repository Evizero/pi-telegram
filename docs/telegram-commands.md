# Telegram command reference

Most commands are accepted only from the paired Telegram user in an authorized chat/route. The special `/topicsetup` setup command is handled before normal route authorization so the paired user can authorize a new forum supergroup. In multi-session mode, commands either operate globally or on the selected/routed pi session.

## Global commands

| Command | Purpose |
| --- | --- |
| `/sessions` | List connected or recently visible pi sessions. |
| `/use <number-or-session-id>` | Select a session for selector-mode routing. |
| `/broker` | Show broker process/epoch/session summary. |
| `/help` or `/start` | Show command help when no session route is selected. |
| `/topicsetup` | Special command sent in a Telegram forum supergroup to use that group for per-session topics. |

`/topicsetup` is handled before normal routing. It must be sent by the paired user in a forum supergroup where the bot has topic-management permissions.

## Session-scoped commands

These require a selected route/topic or selector-mode session.

| Command | Purpose |
| --- | --- |
| plain message | Send input to pi; queues as follow-up when busy. |
| `/follow <message>` | Queue explicit follow-up work. |
| `/steer <message>` | Send urgent active-turn steering when valid. |
| `stop` or `/stop` | Abort active work and clear eligible queued work/queued compaction. |
| `/status` | Query selected session status through local IPC. |
| `/compact` | Start or queue manual compaction for the selected session. |
| `/model` | Open model controls or show model selection help. |
| `/model list [filter]` | List available local models, optionally filtered. |
| `/model <selector-or-number>` | Set the selected session model using an exact selector or current picker number. |
| `/git` | Open read-only Git status/diffstat controls. |
| `/disconnect` | Disconnect the selected pi session from Telegram and clean up its route/topic. |
| `/help` or `/start` | Show session command help. |

## Busy-session behavior

When the selected pi session is already busy:

1. A normal Telegram message is persisted as a pending turn and delivered to the client as follow-up work.
2. `/follow <message>` does the same explicitly.
3. `/steer <message>` attempts active-turn steering instead of follow-up queueing.
4. If the client says a follow-up is queued and can still be steered, the broker may show inline `Steer now` and `Cancel` controls.
5. When a queued follow-up starts, is cancelled, is converted to steering, expires, or stops being actionable, visible buttons should be removed or finalized where Telegram editing allows it.

This protects accidental mobile notes from hijacking active work while preserving an explicit urgent-correction path.

## Manual compaction

`/compact` is a session control, not a fake user message.

- If the selected session is idle and has no earlier queued Telegram work, compaction starts immediately.
- If the selected session is busy or has earlier queued work, compaction is stored as an ordered operation.
- Later ordinary messages and `/follow` turns remain behind that compaction barrier until compaction completes or fails.
- Repeated `/compact` requests coalesce when there is already a queued or running Telegram compaction operation for the selected session.
- `/steer` remains the urgent active-turn correction path and is not blocked behind the compaction barrier.

## Model controls

`/model` operates on the selected local pi session through IPC. It preserves exact provider/model identity, including cases where multiple providers expose the same model IDs.

The model picker uses compact inline callback tokens. The full provider/model data stays in broker state rather than in Telegram callback data.

## Git controls

`/git` opens read-only repository controls for the selected local workspace. Current controls include compact status and diffstat views. They execute bounded local Git inspections without creating a pi agent turn.

## Callback-button safety

Inline buttons are authorized by paired user and chat, then resolved through broker state. Stale, expired, malformed, or route-mismatched callbacks fail closed. The bridge still answers callback queries where possible so Telegram clients stop showing spinner state.

## Command results and long text

Command/control result text is split below Telegram's message-size limit. Long results should deliver every chunk rather than silently dropping overflow.

## Unsupported commands

Telegram-triggered runtime reload is intentionally unsupported. The bridge does not expose a Telegram `/reload` command because pi's runtime reload surface is not safely available to ordinary extension contexts without risking command text being injected as user conversation content.
