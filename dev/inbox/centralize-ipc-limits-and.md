---
title: "Centralize IPC limits and decouple them from attachment sizes"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "open"
planned_as: []
---
Code-quality audit finding from 2026-04-28.

`src/shared/ipc.ts:38` hardcodes the IPC request timeout as `5000`, and `src/shared/ipc.ts:81` uses `MAX_FILE_BYTES * 2` as the JSON IPC body cap. This couples local IPC envelopes to Telegram attachment limits and hides timeout/body-size policy in implementation details.

Suggested planning direction: introduce explicit constants such as `IPC_REQUEST_TIMEOUT_MS` and `MAX_IPC_BODY_BYTES`, with focused checks for timeout and oversized IPC bodies.
