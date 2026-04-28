---
title: "Implement session-scoped Telegram temp attachment cleanup"
status: "done"
priority: 2
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: ""
labels: []
traces_to: ["SyRS-attachment-temp-retention"]
source_inbox: "telegram-attachment-tmp-cleanup"
branch: "task/implement-session-scoped-telegram-temp"
---
## Objective

Bound retention of downloaded Telegram attachments by session lifecycle. Preserve per-session temp files while an active turn, bounded reconnect grace, or retryable Telegram delivery state may still need them; clean the session temp directory after authoritative session end or conservative orphan expiry; and do not tie cleanup to generic broker shutdown or broker takeover.

## Planning context

This task implements `SyRS-attachment-temp-retention` from the source observation `dev/inbox/telegram-attachment-tmp-cleanup.md`. Existing route cleanup already distinguishes explicit disconnect and real session death from ordinary broker turnover. The temp-file lifecycle should follow the same boundary so attachment inputs do not disappear during failover or active-session recovery, while stale per-session temp data does not accumulate indefinitely.

## Pre-edit impact preview

- Likely code touchpoints: `src/telegram/api.ts`, `src/extension.ts`, `src/broker/sessions.ts`, `src/broker/updates.ts`, `src/shared/config.ts`, and likely a small helper module for session temp cleanup/sweeping.
- Likely planning/doc touchpoints: `dev/ARCHITECTURE.md`, `README.md`, and possibly `docs.md` if the implemented retention policy becomes part of the normative bridge contract.
- Main risks: deleting files still needed by an in-flight or reconnectable session, or leaving orphaned temp dirs because cleanup only runs on the happy path.

## Codebase grounding

- `src/telegram/api.ts` currently downloads inbound files into `TEMP_DIR/<sessionId>/...` and sets private permissions, but does not define retention or cleanup.
- `src/extension.ts` owns session start/shutdown, broker turnover, stale client stand-down, and the distinction between route-scoped disconnect/shutdown versus generic `stopBroker()`.
- `src/broker/sessions.ts` already encodes session-unregister and reconnect-grace cleanup semantics that should stay aligned with temp-dir cleanup timing.
- `src/broker/updates.ts` owns stale-session expiry behavior after reconnect grace and may need to trigger the same temp-dir cleanup path when a session is declared gone.
- `src/client/attachment-path.ts` allows outbound `telegram_attach` uploads from the bridge temp root; keep that allowlist behavior compatible with any temp-dir cleanup timing.

## Acceptance Criteria

- Inbound Telegram downloads continue to land under private `TEMP_DIR/<sessionId>/` paths.
- Generic broker shutdown, lease loss, or broker takeover does not delete temp directories for sessions that are still live or still within bounded reconnect grace.
- Explicit `/telegram-disconnect`, Telegram `/disconnect`, and normal `session_shutdown` remove only the ended session temp directory after dependent Telegram turn/final state is no longer needed.
- Reconnect before grace expiry preserves the session temp directory; failing to reconnect by grace expiry removes it alongside the stale session cleanup path.
- Stale orphaned temp directories with no live session and no pending broker delivery state are eventually removed by a conservative TTL sweep without touching unrelated active session directories.
- Busy-turn steering, `/follow`, media-group preparation, final FIFO retry, and outbound `telegram_attach` allowlist behavior do not regress.

## Out of scope

- Do not implement `/new`, `/resume`, or fork-specific temp-dir handoff in this slice; if those flows later preserve Telegram continuity, plan their temp-dir semantics explicitly.
- Do not redesign outbound attachment-root policy beyond what is needed to keep bridge-temp uploads working.
- Do not delete workspace-generated artifacts outside the bridge temp root.

## Validation

Add focused regression coverage or executable checks for explicit disconnect cleanup, normal shutdown cleanup, reconnect-within-grace preservation, cleanup-after-grace expiry, stale orphan TTL cleanup, and the negative case where generic broker shutdown/failover leaves active-session temp data intact. Run `npm run check` before close-out.

## Decisions

- 2026-04-28: Planning review reported no findings for SyRS-attachment-temp-retention and this ready task; architecture update can be handled in the implementation slice when the concrete retention mechanism lands.
- 2026-04-28: Implemented session-scoped temp retention with a dedicated Telegram temp-file helper, broker-wired cleanup callbacks on unregister/offline transitions, and a broker-heartbeat orphan sweeper; temp deletion is blocked while a live session, pending turn, or pending assistant final still references the session.
- 2026-04-28: Added executable coverage for direct temp-helper behavior plus integration paths for unregister cleanup, offline cleanup after grace, offline preservation when pending work remains, and old-orphan sweeping; npm run check passed and the latest implementation review reported no findings.
- 2026-04-28: Close-out check confirmed the implementation satisfies the task acceptance criteria, SyRS-attachment-temp-retention, current architecture boundaries, and pln hygiene; latest review reported no findings.
