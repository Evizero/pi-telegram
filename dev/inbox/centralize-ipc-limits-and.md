---
title: "Centralize IPC limits and decouple them from attachment sizes"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["centralize-local-ipc-limits"]
---
Code-quality audit finding from 2026-04-28.

`src/shared/ipc.ts:38` hardcodes the IPC request timeout as `5000`, and `src/shared/ipc.ts:81` uses `MAX_FILE_BYTES * 2` as the JSON IPC body cap. This couples local IPC envelopes to Telegram attachment limits and hides timeout/body-size policy in implementation details.

Suggested planning direction: introduce explicit constants such as `IPC_REQUEST_TIMEOUT_MS` and `MAX_IPC_BODY_BYTES`, with focused checks for timeout and oversized IPC bodies.



## Deep-dive update (2026-04-30)

Still current. `src/shared/ipc.ts` still hardcodes the request timeout as `timeout: 5000` in `postIpc()`, and `readRequest()` still caps JSON IPC bodies with `MAX_FILE_BYTES * 2`. `src/shared/config.ts` does not define IPC-specific timeout or body-size policy constants. The cleanup should still introduce explicit IPC policy constants such as `IPC_REQUEST_TIMEOUT_MS` and `MAX_IPC_BODY_BYTES`, decoupled from Telegram attachment-size limits.
