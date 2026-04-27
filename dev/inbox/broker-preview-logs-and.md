---
title: "Broker preview logs and client display look buggy"
type: "bug"
created: "2026-04-25"
author: "Christof Salis"
status: "rejected"
planned_as: []
---
User observed the broker pi session showing repeated Telegram preview update failures:

```text
[pi-telegram] Telegram preview update failed: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message
[pi-telegram] Telegram preview update failed: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message
```

They also noticed the broker seemed to have ~4 clients aside from itself, displayed in a buggy way, and asked to investigate how messages are printed in the broker pi session.


Investigation on 2026-04-25:
- The repeated broker-session warning came from `PreviewManager.flush()` letting Telegram `editMessageText` "message is not modified" errors propagate into `handleFlushError()`, which printed them via `console.warn`.
- `docs.md` says to treat this Telegram response as success.
- Local broker state also showed stale offline duplicate `pi-telegram · main` sessions alongside currently online sessions; `/sessions` listed every stored session despite the "Active" heading, making old disconnected clients appear in the list.
- Implemented fixes in this session: preview edit no-op errors are treated as success and update `lastSentText`; `/sessions` and `/use <number>` now hide long-offline sessions, sort active sessions, and add a short session-id suffix only when visible names collide.
- Validation: `npm run check` passed.


## Deep-dive triage (2026-04-27)

Status: already fixed / stale as an open inbox item. Current code treats Telegram `message is not modified` preview edits as success in `src/telegram/previews.ts` and updates `lastSentText` on no-op edits. `/sessions` and `/use` now call `listableSessions()` in `src/broker/commands.ts`, hiding long-offline sessions, sorting visible sessions, and only adding session-id suffixes when names collide. The item body already records the implementation and `npm run check` result from 2026-04-25, so no remaining open inbox action was found.

Rejected reason: Already fixed; current preview/session-list code implements the recorded investigation notes.
