---
title: "pi-telegram slows pi startup when not connected"
type: "bug"
created: "2026-04-30"
author: "Christof Stocker"
status: "planned"
planned_as: ["lazy-load-inactive-telegram-runtime"]
---
User noticed pi startup got noticeably slower and asked whether pi-telegram is doing work even when not invoked. Investigation on 2026-04-30 found the extension is loaded by pi at startup by design, and `index.ts` immediately imports `src/extension.ts`; that module imports the full broker/client/telegram/pi graph. A simple local jiti profile showed ~1.7s warm / ~3.1s first-run import time, while the extension factory was ~2ms and `session_start` without a replacement handoff was ~2ms. The import graph from `index.ts` reaches all 74 TS files (~10.4k LOC). Runtime startup work without invoking Telegram appears limited to registering 6 commands, 1 tool, 11 event handlers, reading config, applying broker scope, and ensuring private directories. No Telegram network polling, broker heartbeat, IPC server, or timers start unless `/telegram-connect`, setup, or a session-replacement handoff triggers connection. Suspected regression source: eager module import/TypeScript/Jiti load cost after modularization, not active Telegram polling.


## Lazy-loading feasibility deep dive (2026-04-30)

Follow-up question: whether it is feasible to make startup more lazy so pi-telegram does less work when installed but not actually invoked.

### Feasibility conclusion

It appears feasible and worthwhile. The startup regression is dominated by eager TypeScript/Jiti module loading, not by live Telegram behavior. A lazy bootstrap/facade can keep pi-visible commands, the `telegram_attach` tool, and minimal event hooks registered at startup while deferring the heavy broker/client/Telegram runtime import until the first operation that actually needs Telegram state.

Expected benefit based on local profiling:

- current eager path imports all runtime modules from `index.ts` and measures roughly 1.6–1.8s on warm local profiles, with one first-run profile around 3.1s;
- a throwaway lazy-bootstrap prototype that only registered a tiny command/tool/hook facade and imported TypeBox measured roughly 70–155ms import time and ~0.3ms factory time;
- therefore the likely normal pi startup savings are on the order of ~1.5s+ on this machine, with the cost shifted to first `/telegram-connect`, setup, or handoff restoration.

### Current eager shape

Current startup path:

```text
index.ts
  -> src/extension.ts
     -> imports broker/client/telegram/pi/shared runtime graph
```

The import graph from `index.ts` reaches all 74 TypeScript files in the package, about 10.4k LOC. `src/extension.ts` is the composition root and imports broker polling, commands, session cleanup, final delivery, Telegram API helpers, client runtime, pi hook registrars, setup, status formatting, and more before the user invokes any Telegram command.

Observed local profile shape:

```text
import full extension: ~1.6-1.8s warm, ~3.1s first-run profile
extension factory:     ~2ms
session_start path:    ~2ms when no replacement handoff is present
```

This means most visible startup cost is import/transform/module evaluation. The extension is not starting Telegram polling, broker heartbeat, IPC servers, typing timers, or network calls on ordinary unconnected startup.

### Proposed lazy architecture

Introduce a tiny eager bootstrap facade and move the heavy current composition root behind a memoized dynamic import.

Potential file shape:

```text
index.ts
src/bootstrap.ts                  # tiny eager pi extension facade
src/runtime/extension-runtime.ts   # heavy runtime/controller extracted from current src/extension.ts
src/runtime/types.ts               # narrow runtime facade contracts if needed
```

`index.ts` would import only `src/bootstrap.ts`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerTelegramBootstrap } from "./src/bootstrap.js";

export default function (pi: ExtensionAPI) {
  registerTelegramBootstrap(pi);
}
```

`src/bootstrap.ts` would own registration of visible pi surfaces. It should avoid importing broker/client/telegram runtime modules. It may import TypeBox, or use a narrow schema literal if pi accepts that safely.

Sketch:

```ts
let runtimePromise: Promise<TelegramRuntime> | undefined;

function ensureRuntime(ctx?: ExtensionContext): Promise<TelegramRuntime> {
  runtimePromise ??= import("./runtime/extension-runtime.js")
    .then((module) => module.createTelegramRuntime(pi));
  return runtimePromise.then(async (runtime) => {
    if (ctx) await runtime.observeContext(ctx);
    return runtime;
  });
}
```

Startup facade remains responsible for registering:

- `/telegram-setup`
- `/telegram-topic-setup`
- `/telegram-connect`
- `/telegram-disconnect`
- `/telegram-status`
- `/telegram-broker-status`
- `telegram_attach`
- minimal lifecycle and agent event hooks
- prompt suffix injection

But most handlers should either no-op while runtime is unloaded or call `ensureRuntime()` before doing real work.

### What should stay eager

1. Command names and descriptions
   - pi should still show Telegram commands immediately.
   - command handlers can lazy-load runtime when invoked.

2. `telegram_attach` tool definition
   - the tool should remain visible to the agent because the system prompt mentions it.
   - execution can lazy-load runtime and then delegate validation/queueing.
   - if runtime is not connected to an active Telegram turn, it should preserve current behavior and fail clearly.

3. Prompt suffix hook
   - the Telegram trust-boundary and attachment instructions are currently injected into every turn.
   - this can be kept in bootstrap with a local string constant to avoid importing `shared/config.ts`.
   - future planning may separately decide whether this prompt suffix should itself be conditional, but that is not required for startup laziness.

4. Thin event hooks
   - bootstrap should register the same event names pi expects, but handlers can be cheap:
     - if runtime is unloaded and the event does not require Telegram recovery, return immediately;
     - if runtime is loaded, delegate to runtime;
     - if the event is a special recovery trigger, load runtime.

### What should be deferred

Defer importing and constructing:

- broker update polling and command router modules;
- broker lease/session/final/outbox/activity machinery;
- client runtime host and turn lifecycle machinery;
- Telegram API, retry, setup, preview, attachment delivery, typing, temp-file code;
- full `shared/types.ts` and other cross-runtime policy modules where they are not needed by bootstrap;
- current `src/extension.ts` composition root or its replacement runtime controller.

### Runtime facade contract

The heavy runtime should become a controller with methods bootstrap can call rather than a second pi registrar. Avoid dynamically calling the current `registerTelegramExtension(pi)` after bootstrap, because that would duplicate command/hook/tool registration.

Candidate runtime interface:

```ts
interface TelegramRuntime {
  onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
  onSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void>;
  onModelSelect(event: ModelSelectEvent, ctx: ExtensionContext): Promise<void>;
  onAgentStart(event: AgentStartEvent, ctx: ExtensionContext): Promise<void>;
  onBeforeAgentStart(event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined>;
  onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): Promise<void>;
  onInput(event: InputEvent): Promise<InputEventResult | undefined>;
  onMessageStart(event: MessageStartEvent): Promise<void>;
  onMessageUpdate(event: MessageUpdateEvent): Promise<void>;
  onToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined>;
  onToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined>;
  commandSetup(args: string, ctx: ExtensionCommandContext): Promise<void>;
  commandTopicSetup(args: string, ctx: ExtensionCommandContext): Promise<void>;
  commandConnect(args: string, ctx: ExtensionCommandContext): Promise<void>;
  commandDisconnect(args: string, ctx: ExtensionCommandContext): Promise<void>;
  commandStatus(args: string, ctx: ExtensionCommandContext): Promise<void>;
  commandBrokerStatus(args: string, ctx: ExtensionCommandContext): Promise<void>;
  executeTelegramAttach(toolCallId: string, params: { paths: string[] }, ctx: ExtensionContext): Promise<AgentToolResult>;
  isLoadedConnected?(): boolean;
}
```

The exact shape can be smaller if bootstrap delegates grouped handlers, but the important design point is that registration is eager and runtime behavior is lazy.

### Special cases and risks

#### Mid-turn `/telegram-connect`

Current invariant: `/telegram-connect` during a busy turn should start mirroring current activity and the final response to Telegram.

Risk: if the heavy runtime was not loaded during `agent_start`, it did not observe the active turn start and did not store current abort/finalization state.

Mitigation: when lazy-loading from `/telegram-connect`, initialize runtime from the command context:

- set latest context;
- read config and apply broker scope;
- create the client runtime host;
- if `!ctx.isIdle()`, treat the current local turn as active enough for mirroring:
  - set current abort callback to `ctx.abort()`;
  - after route registration, call the existing `ensureCurrentTurnMirroredToTelegram(ctx, "Telegram connected during an active pi turn; mirroring from this point on.")` path or equivalent;
  - ensure `agent_end` is delegated after runtime is loaded so final delivery happens.

The bootstrap `agent_end` hook must delegate if runtime has loaded since the turn began. This is feasible because pi event hooks are registered eagerly in bootstrap; only their implementation is lazy.

#### Session replacement handoff

Current invariant: connected routes may be carried through `/new`, `/resume`, or `/fork` by a bounded handoff.

Risk: if the replacement session starts with runtime unloaded, it may miss a handoff and fail to reconnect Telegram reachability.

Mitigation: on `session_start` with reason `new`, `resume`, or `fork`, bootstrap performs a cheap handoff sentinel check before deciding to stay unloaded. This check should avoid importing the full runtime if no handoff exists.

Options:

- create a tiny `src/bootstrap-handoff.ts` helper that reads only config path / handoff directory names and checks for plausibly matching handoff files;
- or keep a minimal handoff detector in bootstrap using Node fs/path/os only.

If a matching handoff may exist, load runtime and delegate `onSessionStart`. Normal `startup` and `reload` should remain unloaded unless another condition requires runtime.

#### Shutdown cleanup

If runtime was never loaded, `session_shutdown` should no-op. If runtime is loaded, bootstrap delegates shutdown so current cleanup behavior remains intact: unregister route, preserve replacement handoff where appropriate, stop client server, stop broker, clear timers.

Risk: if bootstrap partially loads runtime during shutdown just to clean up, it might create work that did not exist. Do not do that. Only delegate shutdown when runtime was already loaded.

#### `telegram_attach`

Risk: the tool is visible even when runtime is unloaded. Execution must not silently succeed without an active Telegram turn.

Mitigation: tool execution lazy-loads runtime and delegates to the current attachment validation/queueing logic. If there is no active Telegram turn, return the existing clear error (`telegram_attach can only be used while replying to an active Telegram turn`). This may pay the lazy import cost on mistaken tool use, which is acceptable.

#### Prompt suffix overhead

The current prompt suffix is always added even when Telegram is not connected. Lazy startup does not need to change this, but it remains an always-on per-turn behavior. If future UX wants less prompt noise, that should be handled as a separate requirement because it changes agent instructions, not just startup cost.

#### TypeBox overhead

The bootstrap still needs a parameter schema for `telegram_attach`. Importing TypeBox alone measured roughly 70–90ms in one local profile. This is much smaller than importing the full graph. If pi accepts a TypeBox-compatible literal schema without importing TypeBox, startup may get even cheaper, but that should be verified against pi's tool validation expectations before relying on it.

### Refactor strategy

Recommended staged implementation:

1. Add `src/bootstrap.ts` and move command/tool/hook registration there.
2. Convert current `src/extension.ts` composition root into a runtime controller factory, or create `src/runtime/extension-runtime.ts` and move the current composition root there incrementally.
3. Preserve current behavior by having bootstrap eagerly load runtime initially behind a feature flag or temporary compatibility path, then flip to true lazy once tests pass.
4. Replace pi hook registrars that currently register directly with either:
   - bootstrap-owned wrappers that call runtime methods, or
   - reusable handler functions that runtime exposes and bootstrap delegates to.
5. Add a cheap session-replacement handoff sentinel path.
6. Add profiling/behavior checks that prove startup does not import the heavy graph.
7. Run `npm run check` and targeted manual smoke tests with real pi startup.

### Acceptance checks / behavior checks to add

- Import graph check: importing `index.ts` should not import `src/runtime/extension-runtime.ts`, broker modules, client runtime host, or Telegram API modules.
- Startup no-side-effect check: `session_start` with reason `startup` and no handoff should not create broker/client IPC servers, start timers, or call Telegram.
- Command lazy-load check: invoking `/telegram-connect` loads runtime and performs existing connect behavior.
- Mid-turn connect check: invoking `/telegram-connect` while `ctx.isIdle() === false` mirrors current activity/final as before.
- Shutdown no-op check: if runtime never loaded, shutdown performs no broker/client cleanup work and does not load runtime.
- Shutdown connected check: if runtime loaded/connected, shutdown still unregisters/cleans up as before.
- Session replacement handoff check: replacement `session_start` loads runtime only when a matching handoff exists and preserves route continuity.
- Attachment tool check: tool is registered at startup; execution without active Telegram turn fails clearly; execution during Telegram turn queues attachments.
- Existing behavior suite: `npm run check` remains required.

### Architectural impact

This is an architectural seam change, not only a micro-optimization. `dev/ARCHITECTURE.md` would need an update if implemented:

- `index.ts` should depend only on the eager bootstrap facade;
- bootstrap owns pi surface registration and lazy-load policy;
- heavy runtime composition remains the owner of broker/client/Telegram behavior;
- runtime must not register duplicate pi surfaces after lazy load;
- no external broker daemon or local-first authority boundaries change.

The architecture should explicitly document that pi-telegram is installed as an extension but its Telegram runtime is demand-loaded, except for minimal command/tool/prompt/lifecycle sentinels.

### Non-goals

- Do not introduce an external daemon or hosted relay.
- Do not start Telegram polling at ordinary pi startup.
- Do not remove command/tool availability from pi startup.
- Do not change pairing, authorization, routing, retry, or delivery semantics as part of the lazy-loading refactor.
- Do not silently weaken `telegram_attach` safety checks.

### Open questions

- Does pi's tool schema validation require an actual TypeBox object created by the TypeBox library, or can bootstrap use a static JSON-schema-compatible literal to avoid importing TypeBox?
- Is there a stable, cheap way to detect matching session-replacement handoffs without importing current `client/session-replacement.ts` and its shared dependencies?
- Should the prompt suffix remain unconditional, or should a future separate task make it conditional on runtime connection / Telegram-origin prompts?
- Should lazy-loading be guarded by a config/debug flag for one release to compare startup and runtime behavior safely?
