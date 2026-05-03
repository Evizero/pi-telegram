# Telegram activity rendering

Telegram activity is live feedback for a routed pi turn. It helps the remote operator see that the local session is thinking or using tools, but it is not the authoritative session history and it must not make hidden provider internals look like durable transcript content.

Source code anchors:

- `src/bootstrap.ts` registers the lightweight always-present pi event hooks used by the package entrypoint; after the runtime is loaded, these hooks post activity and finalization updates for the active Telegram-routed turn.
- `src/pi/activity.ts` contains the split hook implementation for the non-bootstrap runtime-registration path and mirrors the same active-turn thinking/tool events.
- `src/shared/activity-lines.ts` defines activity row text, compact argument extraction, and Telegram HTML formatting.
- `src/broker/activity.ts` stores, debounces, renders, completes, and recovers activity messages.
- `src/broker/finals.ts` completes activity before visible final-delivery steps.
- `scripts/check-activity-rendering.ts` exercises the expected row formatting, escaping, completion, cleanup, retry, and stale-update behavior.

## Flow

1. pi hooks listen for assistant `message_update`, `tool_call`, and `tool_result` events while a Telegram-routed turn is active. The active turn can originate from Telegram, or from a local interactive turn that is mirrored to Telegram after a route is connected or `/telegram-connect` attaches during busy work.
2. The client-side `ActivityReporter` serializes activity updates over local IPC so event order is preserved even though Telegram rendering is debounced.
3. The broker-side `ActivityRenderer` keeps a per-turn activity message model, starts the route-scoped typing loop, persists active activity refs in broker state, and sends or edits Telegram messages after the throttle window.
4. The assistant-final ledger calls activity completion before stopping the typing loop and before sending final text or attachments, so stale pre-final activity does not edit an old message after the final answer.

Telegram activity sends use the same route/thread context as the turn. Rendering can lag or retry around Telegram limits, but the collected activity meaning should remain ordered and recoverable.

## Current row semantics

Activity rows are stored internally as simple strings. A leading `*` means the row is active and renders bold in Telegram. Completed rows remove the leading marker.

| Source event | Active row example | Current behavior |
| --- | --- | --- |
| Hidden or untitled thinking | `⏳ working ...` | Transient reassurance only. It is removed when no visible thinking content appears, rather than leaving completed `🧠 thinking ...` noise in activity history. |
| Visible thinking title/content | `🧠 <title>` | Promotes or replaces the transient working row and can remain as completed visible thinking activity. |
| Bash tool call | `💻 $ <command>` | Uses a laptop and shell prompt marker, omits the visible `bash` word, and shows the compact command immediately. |
| Read tool call | `📖 read <path>` | Keeps a readable tool label plus compact path. |
| Write/edit tool call | `📝 write <path>` / `📝 edit <path>` | Uses the memo glyph with an explicit label so write and edit remain distinguishable. |
| Other tool call | `🔧 <tool> <compact args>` | Falls back to the generic tool row with a visible tool name. |
| Tool error | `❌ ...` | Replaces the matching active row's icon where possible instead of appending an avoidable duplicate. |

Details such as commands and paths are compacted and rendered as Telegram HTML `<code>` with escaping for `<`, `>`, and `&`. Activity messages show the latest rows and collapse older ones with an “earlier” count when the model grows beyond the visible window.

## Replacement and completion rules

Rendered text is not the only identity for active-row replacement. Bash hides the `bash` word, so the renderer derives a stable tool key from `💻 $ ...` and `❌ $ ...` rows. Tool completion and error updates use that key to replace the active row instead of appending misleading duplicates.

Thinking rows have a separate lifecycle:

- active hidden thinking is represented as `⏳ working ...`;
- visible thinking replaces earlier active working rows, even when tool rows interleave;
- hidden thinking completion removes active working placeholders;
- final activity completion removes transient working rows and completes any active visible thinking/tool rows before the final answer is delivered.

Once a turn or activity ID is completed, late duplicate activity updates for that turn are ignored. This prevents a completed turn's old activity message from being edited after the assistant final or after a later follow-up starts.

## Reliability notes

Activity message references live in broker state while active. The renderer persists before ambiguous sends, records unknown message IDs when needed, honors Telegram `retry_after`, re-arms recovered retry timers, and deletes empty transient activity messages when cleanup succeeds. If route/session validity changes before a flush, the durable ref is discarded rather than rendering activity into the wrong Telegram view.

Activity is intentionally separate from assistant previews and finals. Hidden thinking placeholders do not affect final text extraction, and final delivery remains broker-owned through the assistant-final ledger.

## Provenance and supersession

This page curates the 2026-04-25 activity-rendering backlog around:

- `inbox:activity-labels-should-show`
- `task:improve-telegram-activity-labels-for`
- `inbox:hide-bash-label-in`
- `inbox:telegram-placeholder-for-hidden`
- `inbox:telegram-activity-edits-can`
- `task:polish-telegram-activity-rendering`

Two early directions were superseded by later implementation decisions:

- The first fallback idea was to show untitled thinking as `🧠 thinking ...`. Hidden/empty provider thinking now uses transient `⏳ working ...` instead, because it reassures the Telegram user without pretending that pi recorded a visible thinking trace.
- The first bash/read/write idea explored removing more visible tool labels. The final labels keep only bash label-less as `💻 $ <command>`, while read/write/edit keep explicit labels as `📖 read <path>`, `📝 write <path>`, and `📝 edit <path>`.
