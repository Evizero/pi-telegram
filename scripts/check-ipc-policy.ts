import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { IPC_REQUEST_TIMEOUT_MS, MAX_IPC_BODY_BYTES } from "../src/shared/ipc-policy.js";

const repoRoot = process.cwd();
const ipcSource = readFileSync(join(repoRoot, "src/shared/ipc.ts"), "utf8");

assert.equal(IPC_REQUEST_TIMEOUT_MS, 5000, "IPC request timeout value must remain 5000 ms");
assert.equal(MAX_IPC_BODY_BYTES, 100 * 1024 * 1024, "IPC JSON body cap must remain 100 MiB");
assert.match(ipcSource, /timeout:\s*IPC_REQUEST_TIMEOUT_MS\b/, "IPC requests should use the named timeout policy constant");
assert.match(ipcSource, /size\s*>\s*MAX_IPC_BODY_BYTES\b/, "IPC body reads should use the named body-size policy constant");
assert.doesNotMatch(ipcSource, /timeout:\s*5000\b/, "IPC timeout policy should not be hidden as an inline literal");
assert.doesNotMatch(ipcSource, /MAX_FILE_BYTES/, "IPC body limits should not depend on attachment file-size policy");
assert.doesNotMatch(ipcSource, /MAX_FILE_BYTES\s*\*\s*2/, "IPC body limits should not be derived from attachment file-size policy");

console.log("IPC policy checks passed");
