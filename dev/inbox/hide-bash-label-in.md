---
title: "Polish Telegram activity labels"
type: "request"
created: "2026-04-25"
author: "Christof Salis"
status: "planned"
planned_as: ["polish-telegram-activity-rendering"]
---
User preference from chat on 2026-04-25:

> for bash tool calls in telegram i like the laptop emoji but remove the "bash" next to it, just do the command the emoji makes it obvious its a bash

Desired behavior: Telegram activity rendering should keep the laptop emoji for bash tool calls but omit the visible `bash` label so the command itself follows the emoji.


## Read/write emoji idea (2026-04-25)

User asked to also change read and write tool activity to use special emojis and requested ideas for those. Candidate direction: keep this planned together with the hidden-thinking `working ...` cleanup so Telegram activity rendering is polished in one small UI pass.


## Emoji decision (2026-04-25)

User chose `📖` for read activity and `✏️` for write activity. Intended examples:

- `📖 src/broker/activity.ts`
- `✏️ src/broker/activity.ts`

Keep bash as `💻 <command>` without the visible `bash` label.


## Pencil spacing note (2026-04-25)

User noticed the pencil renders awkwardly in Telegram and appears to need extra spacing after it. When implementing label-less activity rows such as write, evaluate either explicit non-breaking spacing in the Telegram HTML renderer or a more stable pencil-like glyph while preserving the intended visual meaning.


## Final label decision update (2026-04-25)

User changed the tool-label direction:

- bash should render as `💻 $ <command>`: keep the laptop emoji, omit the word `bash`, and insert `$` before the command.
- read should keep a visible label: `📖 read <path>`.
- write should use memo and keep a visible label: `📝 write <path>`.
- edit should also keep a visible label after the emoji: likely `📝 edit <path>` unless implementation finds a better paired edit glyph.

This supersedes the earlier idea to omit `read`/`write` labels.
