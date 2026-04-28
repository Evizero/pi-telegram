---
title: "Telegram activity can stop flushing while an earlier flush is in flight"
type: "bug"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["fix-overlapping-telegram-activity"]
---
User report (2026-04-28, transcribed voice note): Telegram sometimes stops receiving activity/output updates during a busy run with multiple thinking/tool steps, then catches up only when the run finishes and the final message is sent.

## Investigation findings

This does not look like the older typing-startup bottleneck that was closed by `prevent-telegram-activity-batching`. I found a different head-of-line bug in `src/broker/activity.ts`.

### Likely failure path

1. `ActivityRenderer.scheduleFlush()` stores a timer handle in `state.flushTimer` and later calls `flush(activityId)`.
2. `ActivityRenderer.flush()` clears `state.flushTimer` only after it confirms there is no existing in-flight flush.
3. If a second timer fires while `this.flushes.get(activityId)` already exists, `flush()` returns the existing promise early at line 207 and never clears `state.flushTimer`.
4. That leaves `state.flushTimer` stuck truthy even though the timer has already fired.
5. Subsequent `handleUpdate()` calls keep appending activity lines, but `scheduleFlush()` refuses to schedule another flush because it only checks `if (!state || state.flushTimer) return`.
6. The accumulated activity is then only pushed when turn shutdown/final-delivery paths call `complete()` / `completeActivity()`, which matches the user-visible symptom: no live Telegram updates, then a burst at the end.

### Code evidence

- `src/broker/activity.ts:205-216`
  - `flush()` returns early on an existing in-flight flush before clearing `state.flushTimer`.
- `src/broker/activity.ts:347-350`
  - `scheduleFlush()` blocks any new timer whenever `state.flushTimer` is truthy.

### Why this can happen in real runs

A busy turn can easily produce new activity while a previous Telegram `sendMessage` or `editMessageText` is still in flight, especially under Telegram retry/backoff or slower network conditions. Once one overlapping timer hits the early-return path, visible activity flushing can stall for the rest of the turn.

## Likely fix direction

- Decouple timer bookkeeping from the in-flight flush promise so a timer that fires during an existing flush cannot leave `flushTimer` stale.
- After an in-flight flush finishes, ensure any activity that arrived during that flush schedules or performs another flush.
- Add regression coverage where `doFlush()` is intentionally blocked while more `handleUpdate()` calls arrive; the renderer should still emit another flush after the first one resolves instead of batching until final completion.

## Notes

Related archived inbox/task: `telegram-activity-can-batch` / `prevent-telegram-activity-batching`. This looks like a new or previously untested batching path, not the same typing-startup issue.


## Reproduction evidence (2026-04-28)

I reproduced this locally against the current `ActivityRenderer` implementation by compiling the repo and running a small harness that:

1. posts one activity update so the debounced timer starts,
2. blocks the first Telegram `sendMessage` flush in flight,
3. posts a second activity update and waits for its timer to fire while the first flush is still unresolved,
4. releases the first flush, then posts a third update.

Observed state from the harness:

- after the overlapping timer fired: `flushTimerTruthy: true`, `inFlightFlush: true`, `callCount: 1`
- after the first flush resolved: `flushTimerTruthy: true`, `inFlightFlush: false`, `callCount: 1`
- after a third update and another full debounce interval: still `callCount: 1` and no second Telegram send/edit occurred

The rendered Telegram text from that only completed flush contained just the first line (`one.ts`), while later lines remained buffered in renderer state. That demonstrates the renderer can get stuck with a stale `flushTimer` and stop live flushing until some later completion path forces another flush.

This moves the suspected cause from plausible to confirmed reproducible behavior.
