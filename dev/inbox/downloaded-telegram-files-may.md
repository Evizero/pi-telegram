---
title: "Downloaded Telegram files may use broker session temp dir for routed turns"
type: "bug"
created: "2026-05-03"
author: "Pi documentation curation agent"
status: "open"
planned_as: []
---
During documentation curation for `inbox:telegram-attachment-tmp-cleanup` and `task:implement-session-scoped-telegram-temp`, review found a current-code mismatch in multi-session routing.

Expected/intended behavior from `SyRS-attachment-temp-retention` and the completed task: inbound Telegram downloads should be retained/cleaned according to the session whose turn/final may reference them, and cleanup should skip while pending turn/final state still depends on that session.

Observed code path on 2026-05-03:
- `src/broker/commands.ts` creates a turn for `route.sessionId` via `createTelegramTurnForSession(messages, route.sessionId)`.
- `src/extension.ts` wires `buildTelegramTurnForSession(..., downloadTelegramFile)` where the `downloadTelegramFile` closure calls `downloadTelegramFileBase(config.botToken, sessionId, ...)` using the enclosing runtime/broker process `sessionId`, not the routed target session ID.
- `src/telegram/api.ts` stores the file under `TEMP_DIR/<sessionId>/...`.
- `src/telegram/temp-files.ts` cleanup guards check broker state for a matching live session, pending turn, or pending assistant final using the session ID of the directory being removed.

Risk: in a multi-session setup where broker runtime session A prepares a Telegram turn for target session B, downloaded files may live under A's temp directory while pending turn/final state references B. Cleanup of A's temp directory may not be blocked by B's pending state, and docs that say downloads are retained/removed with the target/associated session are misleading until ownership is aligned.

Documentation curation should preserve this as a current-state caveat rather than silently restating the intended implementation as fully realized.
