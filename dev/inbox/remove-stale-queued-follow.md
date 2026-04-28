---
title: "Remove stale queued follow-up buttons"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["remove-stale-queued-follow-up-controls"]
---
User asked whether queued follow-up buttons disappear when later messages arrive or whether every queued message leaves stale buttons in Telegram history after there is nothing left to steer.

Current implementation only gives buttons to eligible queued follow-up status messages, not every message. After `Steer now` or `Cancel`, the status message is edited and buttons are removed. However, if the queued follow-up starts normally later or is cleared by broader lifecycle handling, the durable control expires/fails closed but the old visible Telegram buttons may remain in Telegram history. They should not perform dangerous actions, but the UI is stale and misleading.

Capture request: when a queued follow-up starts normally, is stopped/cleared, expires, or otherwise becomes non-actionable without a button press, edit the queued-status message where possible to remove the inline keyboard and replace/update the text with a clear terminal state. Preserve retry_after behavior, route/thread context, and fail-closed semantics; UI cleanup failure must not resurrect or duplicate queued turns.
