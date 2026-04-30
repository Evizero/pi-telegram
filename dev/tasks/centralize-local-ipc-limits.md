---
title: "Centralize local IPC limits"
status: "done"
priority: 3
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: "agent"
labels: ["refactor", "ipc", "shared"]
traces_to: ["SyRS-shared-boundary-ownership", "SyRS-runtime-validation-check"]
source_inbox: "centralize-ipc-limits-and"
branch: "task/centralize-local-ipc-limits"
---
## Objective

Make local IPC transport limits explicit IPC-owned policy instead of hidden literals or attachment-size-derived expressions.

The intended outcome is a behavior-preserving cleanup: maintainers should be able to see the IPC request timeout and JSON body cap as IPC policy, and changing Telegram attachment/file limits should not appear to change local IPC envelope limits.

## Implementation summary

Implemented as a narrow IPC policy surface:

- Added `src/shared/ipc-policy.ts` with:
  - `IPC_REQUEST_TIMEOUT_MS = 5000`
  - `MAX_IPC_BODY_BYTES = 100 * 1024 * 1024`
- Updated `src/shared/ipc.ts` so `postIpc()` uses `IPC_REQUEST_TIMEOUT_MS` and `readRequest()` uses `MAX_IPC_BODY_BYTES`.
- Removed the `src/shared/ipc.ts` import of `MAX_FILE_BYTES`; IPC transport no longer depends on attachment file-size policy.
- Added `scripts/check-ipc-policy.ts`, discovered and executed by the behavior-check harness, to preserve the values and reject reintroduced inline timeout or `MAX_FILE_BYTES`-derived IPC body limits.

## Preserved behavior

- Request timeout remains 5 seconds.
- Local IPC JSON body cap remains 100 MiB.
- IPC envelope/response JSON shape, authentication behavior, socket paths, error text, and HTTP method behavior are unchanged.
- Telegram upload/download limits, `telegram_attach` safety checks, Bot API method contracts, lazy inactive startup behavior, broker/client handoff behavior, and durable JSON shape are unchanged.

## Acceptance Criteria

- [x] `src/shared/ipc.ts` no longer imports `MAX_FILE_BYTES` or derives IPC body limits from attachment/file policy.
- [x] IPC request timeout and IPC JSON body-size cap are named constants in an IPC-owned policy surface.
- [x] Numeric values are preserved: timeout remains `5000` ms and the body cap remains `100 * 1024 * 1024` bytes.
- [x] A focused behavior/static check fails if the IPC transport reintroduces the hidden `timeout: 5000` literal or `MAX_FILE_BYTES * 2` body cap expression instead of the IPC-owned constants.
- [x] Existing checks still compile and run through `npm run check`.

## Out of Scope

- Do not tune timeout duration or body-size cap values in this slice.
- Do not redesign local IPC protocol, auth, error classification, retry behavior, or request/response schemas.
- Do not change Telegram attachment limits or outbound attachment path safety.
- Do not combine this with semantic TTL splitting, bounded recent-id utilities, or Telegram API error-classification cleanup.

## Validation

- `npm run check` passed.
- Inspection confirms `src/shared/ipc.ts` no longer imports `src/shared/file-policy.ts` and depends on IPC-owned policy constants for IPC limits.

## Decisions

- 2026-04-30: Implemented IPC limits as narrow shared IPC policy in src/shared/ipc-policy.ts so src/shared/ipc.ts keeps current 5000 ms timeout and 100 MiB body cap without importing attachment file-size policy; added scripts/check-ipc-policy.ts to enforce values and guard against inline timeout or MAX_FILE_BYTES-derived IPC body limits.
