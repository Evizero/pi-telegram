---
title: "Polish Telegram activity rendering"
status: "done"
priority: 3
created: "2026-04-25"
updated: "2026-04-25"
author: "Christof Salis"
assignee: "pi-agent"
labels: []
traces_to: ["SyRS-activity-history-rendering"]
source_inbox: "hide-bash-label-in"
branch: "task/polish-telegram-activity-rendering"
---
## Objective

Polish Telegram activity rendering so the mobile activity feed communicates work without noisy or redundant labels.

This task combines three activity-rendering sources:

- `telegram-placeholder-for-hidden`: hidden/empty thinking events currently persist as repeated `🧠 thinking ...` rows even when pi only shows a transient working spinner.
- `hide-bash-label-in`: tool rows should use clearer emojis and labels, especially bash rows where `💻 $` already implies shell execution.
- `telegram-activity-edits-can`: late queued activity for a completed turn can edit the old activity message after the final response, making Telegram timeline order misleading.

Source linkage note: `pln` records `hide-bash-label-in` as the original accepted source inbox; `telegram-placeholder-for-hidden` and `telegram-activity-edits-can` are also linked through their `planned_as` metadata and this task body because this task intentionally resolves these related activity-rendering issues together.

## Desired Telegram activity labels

Use these user-facing rows when a tool call is active and has a useful argument to show:

- hidden/empty thinking: bold transient `⏳ working ...`; do not persist it as completed history unless it is replaced by real visible thinking content.
- bash: `💻 $ <command>`; omit the visible `bash` word, but include the shell prompt marker before the command.
- read: `📖 read <path>`.
- write: `📝 write <path>`.
- edit: `📝 edit <path>` unless implementation finds a clearly better paired edit glyph that still reads well in Telegram.
- keep generic/unrecognized tools on the existing wrench-style fallback, including a visible tool name when that is still the clearest label.

The user initially considered the pencil for write, but chose memo after noticing the pencil renders awkwardly in Telegram. The user also decided read/write/edit should keep their visible labels after the emoji; only bash should hide the tool name.

## Codebase grounding

Likely touchpoints:

- `src/broker/activity.ts`
  - `toolActivityLine()` currently emits string rows as `<emoji> <toolName> <compact args>`.
  - `activityLineToHtml()` currently assumes the second token is a visible name and wraps only the rest in `<code>`.
  - `ActivityRenderer.handleUpdate()` currently matches completed tool rows to active rows using the visible name token.
- `src/pi/hooks.ts`
  - `message_update` currently posts `thinkingActivityLine(..., getThinkingTitleFromEvent(...))` for thinking start/delta/end, even when no title/content exists.

## Implementation notes

- Preserve ordered activity history and debounced Telegram rendering.
- Be careful not to make displayed text the only stable identity for replacing active tool rows on `tool_result`; bash rows no longer include the `bash` name and still need active rows to be marked complete/error correctly.
- Hidden/empty thinking should reassure the user while active, but should not leave durable `🧠 thinking ...` noise when no visible thinking content/title ever arrived.
- If a thinking title/content later appears, promote/replace the transient working row with the normal brain thinking row rather than losing the visible thinking signal.
- Preserve HTML escaping and Telegram parse-mode safety for paths and commands, including the literal `$` prompt marker on bash rows.
- Drain pi-side activity reporting before sending the assistant final so pre-final activity cannot overtake the final response.
- Complete and close broker-side activity state for a turn when its final response is being delivered; late duplicate activity for that closed turn should be ignored instead of editing an old activity message.
- Keep `message_thread_id` and route behavior out of scope; this is only activity text/rendering and turn-activity lifecycle.

## Acceptance criteria

- Empty/untitled thinking events render as a bold active `⏳ working ...` placeholder and do not accumulate completed `🧠 thinking ...` rows.
- Thinking events with visible title/content still render with the existing brain/thinking behavior.
- Bash activity rows show the laptop emoji, a `$` prompt marker, and the command without the visible `bash` label.
- Read activity rows show `📖 read <path>`.
- Write activity rows show `📝 write <path>`.
- Edit activity rows show `📝 edit <path>` or another planned edit glyph if chosen during implementation and recorded in the task decisions.
- Generic tool rows still remain understandable and keep their existing fallback semantics.
- Completion/error handling still updates the corresponding active row instead of appending misleading duplicates.
- Activity queued before `agent_end` is drained before the assistant final is sent to the broker.
- Once a turn's activity is completed for final delivery, late activity updates for that same turn do not edit the old activity message after the final response.

## Validation

Add or run focused validation that exercises the changed activity behavior, not only TypeScript typechecking. Expected coverage:

- formatting examples for bash, read, write, edit, and generic tool rows;
- Telegram HTML escaping for commands/paths containing `<`, `>`, `&`, and the literal `$` prompt marker;
- hidden/empty thinking start/end does not leave completed `🧠 thinking ...` rows;
- hidden thinking is promoted/replaced when visible thinking title/content arrives;
- bash completion and error updates still match the active bash row even though the visible `bash` label is absent;
- reporter/renderer ordering around final delivery, proving that draining plus completed-turn guards prevent activity edits after the final response.

Use the lightest practical focused test or executable assertion approach for this repository; do not introduce broad test infrastructure just for this slice. `npm run check` must pass after the implementation.

## Out of scope

- Redesigning the whole activity transport model unless needed locally for stable row identity.
- Changing assistant final/preview rendering.
- Changing Telegram routing, topic selection, or typing-loop behavior.
- Adding broad test infrastructure beyond focused coverage for the behaviors listed above.

## Decisions

- 2026-04-25: User finalized tool labels: bash renders as `💻 $ <command>` with no visible `bash`; read renders as `📖 read <path>`; write renders as `📝 write <path>`; edit should keep a visible `edit` label after an emoji, defaulting to `📝 edit <path>`.
- 2026-04-25: Implemented activity polish in src/broker/activity.ts with focused executable validation in scripts/check-activity-rendering.ts wired into npm run check. Chose to keep activity rows as strings but added renderer-side key derivation so label-less bash rows still match completion/error updates.
- 2026-04-25: Integrated related handoff bug telegram-activity-edits-can into the same activity rendering slice. Added ActivityReporter.flush() and ActivityRenderer.complete(turnId), drain activity before assistant final delivery, close completed turn activity state, and ignore late duplicate activity updates for closed turn IDs so old activity messages are not edited after finals.
- 2026-04-25: Review found two hidden-thinking edge cases. Fixed hidden-only turns by deleting the transient activity message when the activity model becomes empty, and fixed interleaved hidden deltas by treating any active visible thinking row as superseding untitled working placeholders until thinking end completes it.
- 2026-04-25: Second review found stale working promotion and in-flight close races. Fixed visible thinking completion to replace earlier active working rows even when tool rows interleave, and rechecked closed-turn state after the asynchronous typing-loop await before mutating renderer state.
- 2026-04-25: Third review found finalization and interleaved-delta edges. Fixed complete(turnId) to close first, remove transient working rows, and complete active thinking before the final activity flush; moved stopTypingLoop after complete() so any in-flight late activity typing loop is stopped; updated active visible thinking deltas to update an earlier active brain row even when tool rows interleave.
- 2026-04-25: Fourth review found in-flight finalization and validation portability issues. Fixed complete(turnId) to wait for any existing flush and then perform a fresh corrected flush after cleanup, changed typing-loop startup to register a pending loop before the initial await and made stopTypingLoop delete pending starts, and replaced shell-specific check:activity wiring with a cross-platform Node runner.
- 2026-04-25: Fifth review found the activity check temp output lacked ESM package scope. Updated scripts/run-activity-check.mjs to write a temporary package.json with type=module into the compiled output directory before executing the emitted check script.
