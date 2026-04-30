import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "@mariozechner/jiti";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const jiti = createJiti(join(repoRoot, "profile-startup.mjs"));
const handlers = new Map();
const commands = [];
const tools = [];

const pi = {
  on(name, handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
  registerCommand(name, spec) {
    commands.push([name, spec]);
  },
  registerTool(spec) {
    tools.push(spec);
  },
  sendMessage() {},
  sendUserMessage() {},
  getSessionName() {
    return "profile-session";
  },
  setModel() {},
};

const ctx = {
  cwd: repoRoot,
  ui: { theme: {}, setStatus() {}, notify() {} },
  sessionManager: {
    getSessionId() {
      return "profile-session-id";
    },
    getSessionFile() {
      return join(repoRoot, ".pi", "session.json");
    },
  },
  isIdle() {
    return true;
  },
  abort() {},
};

const t0 = performance.now();
const extensionDefault = await jiti.import(join(repoRoot, "index.ts"), { default: true });
const t1 = performance.now();
extensionDefault(pi);
const t2 = performance.now();
for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
const t3 = performance.now();

console.log(JSON.stringify({
  importMs: +(t1 - t0).toFixed(1),
  factoryMs: +(t2 - t1).toFixed(1),
  sessionStartMs: +(t3 - t2).toFixed(1),
  handlers: Object.fromEntries([...handlers].map(([key, value]) => [key, value.length])),
  commands: commands.map(([name]) => name),
  tools: tools.map((tool) => tool.name),
}, null, 2));
