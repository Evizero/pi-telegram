---
title: "Telegram placeholder for hidden thinking traces"
type: "observation"
created: "2026-04-25"
author: "Christof Salis"
status: "open"
planned_as: []
---
Source note from user (2026-04-25):

> sometimes pi doesnt surface thinking traces, probably because openai doesnt seend any content with it. in pi it just says working .. wihth a spinner. in telegram however it can cause multiple lines of just <brain> thinking.. eventhough in pi it doesnt write anything in the history.

Question to investigate:

- Would Telegram mirroring be nicer if hidden/empty thinking activity used a transient "<emoji> working ..." placeholder that is not persisted, unless pi also exposes a visible thinking trace in history?
- If pi surfaces a real visible thinking trace, keep the current "<brain> title" logic.

Potential symptom:

- Empty OpenAI reasoning/thinking deltas may produce repeated Telegram lines that look like brain/thinking traces even though pi itself only shows a spinner and does not write corresponding trace content to history.


## Initial investigation (2026-04-25)

Code path found:

- `src/pi/hooks.ts` mirrors every `thinking_start`, `thinking_delta`, and `thinking_end` from `message_update` into an activity update.
- `thinkingActivityLine(false, undefined)` in `src/broker/activity.ts` renders as `*🧠 thinking ...`; `thinkingActivityLine(true, undefined)` renders as `🧠 thinking ...`.
- `getThinkingTitleFromEvent()` only derives a title from actual thinking text in the event partial/content. Empty OpenAI reasoning-summary events therefore produce no title and fall back to `thinking ...`.
- `ActivityRenderer.handleUpdate()` coalesces consecutive active brain lines, but it leaves one completed `🧠 thinking ...` line per thinking block. If hidden/empty reasoning blocks occur around other activity, multiple completed brain placeholder lines can remain.
- `getMessageText()` extracts text blocks only, so these empty thinking events do not affect assistant previews/finals; the noisy Telegram activity entry is separate from pi history rendering.

Likely cause:

- OpenAI Responses streaming can emit a reasoning output item and `thinking_start` before any reasoning-summary text exists. If no summary text arrives, pi may only show its own working spinner and avoid a visible history trace, while this extension has already rendered/persisted a Telegram activity line.

Candidate behavior to evaluate when promoted:

- Treat untitled/empty thinking events as a transient `working ...` activity state instead of a durable `🧠 thinking ...` line.
- Promote that transient state to the current brain/title logic only after visible thinking content/title exists, or when the final pi-visible assistant message contains a non-empty thinking block.
- Ensure this does not regress providers that stream visible thinking deltas where the title arrives after `thinking_start`.


## Follow-up UI note (2026-04-25)

User clarified that the transient working placeholder should still be bold and include an emoji. Candidate labels to evaluate:

- `*⚙️ working ...` / rendered bold as `⚙️ working ...` for generic background work.
- `*⏳ working ...` for waiting/in-progress state.
- `*✨ working ...` for lightweight agent activity without implying visible reasoning.
- `*🔄 working ...` for a live updating placeholder.

Design preference emerging: hidden/empty thinking should still visibly reassure the Telegram user that the agent is active, but it should not imply a persisted visible thinking trace unless pi exposes one.


## UI preference update (2026-04-25)

User preference: use the hourglass variant for the transient hidden/empty-thinking placeholder. Proposed active rendering: `*⏳ working ...`, displayed bold in Telegram while active, and removed/replaced instead of persisted unless a real pi-visible thinking trace appears.
