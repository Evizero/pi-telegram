---
title: "Lazy-load inactive Telegram runtime"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["startup", "lazy-loading", "architecture"]
traces_to: ["SyRS-lazy-inactive-runtime", "SyRS-mirror-current-turn-on-connect", "SyRS-session-replacement-route-continuity", "SyRS-explicit-artifact-return", "SyRS-outbound-attachment-safety", "SyRS-runtime-validation-check"]
source_inbox: "pi-telegram-slows-pi"
branch: "task/lazy-load-inactive-telegram-runtime"
---
## Objective

Reduce ordinary pi startup overhead when pi-telegram is installed but not connected by replacing the eager full-runtime import path with a tiny bootstrap facade that registers the pi-visible extension surface and demand-loads the broker/client/Telegram runtime only when needed.

The intended outcome is that normal pi startup no longer pays the ~1.6s+ Jiti/TypeScript import cost from the full runtime graph, while explicit Telegram use and recovery flows preserve current behavior.

## Scope

Implement a lazy startup architecture for the extension:

- keep `index.ts` tiny and make it import only a lightweight bootstrap module;
- add a bootstrap facade that eagerly registers Telegram commands, the `telegram_attach` tool definition, prompt suffix guidance, and minimal pi event/lifecycle sentinels;
- move or wrap the current `src/extension.ts` composition root as a runtime controller that bootstrap can load through one memoized dynamic import;
- ensure invoking `/telegram-setup`, `/telegram-topic-setup`, `/telegram-connect`, `/telegram-disconnect`, `/telegram-status`, `/telegram-broker-status`, or executing `telegram_attach` loads and delegates to the runtime where behavior requires it;
- keep unloaded event hooks cheap and no-op unless runtime has already loaded or a valid session-replacement handoff sentinel requires recovery;
- add a cheap startup/handoff check so `/new`, `/resume`, or `/fork` replacement continuity still loads runtime when a matching handoff exists;
- ensure lazy loading during mid-turn `/telegram-connect` initializes runtime from the current command context so current activity/final mirroring still works.

## Preserved behavior

Do not regress these existing runtime contracts:

- no Telegram polling, webhook deletion, broker heartbeat, IPC server, timers, or network work should start on ordinary unconnected startup;
- command names and `telegram_attach` remain registered at startup;
- `/telegram-connect` during an active local turn still mirrors the current activity and final response to Telegram;
- session-replacement handoff for `/new`, `/resume`, and `/fork` still preserves Telegram reachability when the replacement runtime starts successfully;
- `telegram_attach` still only succeeds for an active Telegram turn, applies existing outbound path/secret checks, and sends attachments with the associated assistant reply;
- connected/runtime-loaded shutdown still unregisters or preserves routes according to existing lifecycle rules, while never-loaded shutdown does not load runtime just to clean up nonexistent state;
- no external daemon, hosted relay, inbound endpoint, or new always-on background process is introduced.

## Codebase grounding

Likely touchpoints:

- `index.ts` — switch entrypoint to the bootstrap facade only;
- new `src/bootstrap.ts` or equivalent — eager registration and lazy-load policy;
- `src/extension.ts` and/or new `src/runtime/extension-runtime.ts` — convert the current composition root into a controller/factory that does not re-register pi commands/tools/hooks after bootstrap;
- `src/pi/commands.ts`, `src/pi/hooks.ts`, `src/pi/attachments.ts`, `src/pi/lifecycle.ts`, `src/pi/prompt.ts` — expose callable handler/controller seams instead of only direct registrars where needed;
- session-replacement helpers under `src/client/` / `src/pi/lifecycle.ts` — provide a cheap handoff sentinel path that does not import the full runtime on normal startup;
- behavior/profile harnesses under the existing validation setup — add checks for unloaded startup and lazy-load triggers.

## Acceptance criteria

- Importing the package entrypoint through the same Jiti path pi uses does not import the heavy broker/client/Telegram runtime graph on ordinary startup.
- Normal `session_start` with no replacement handoff keeps the runtime unloaded and starts no polling, IPC server, broker heartbeat, timers, webhook deletion, or Telegram network calls.
- Startup still registers the expected six Telegram commands, the `telegram_attach` tool, prompt suffix behavior, and lifecycle/event hooks needed for later delegation.
- First explicit Telegram operation loads the runtime once and delegates to existing behavior without duplicate command/tool/hook registration.
- `/telegram-connect` while `ctx.isIdle() === false` loads runtime, captures enough current context/abort state, and delivers the active turn's final response to Telegram.
- A valid session-replacement handoff causes `session_start` to load runtime and preserve route continuity; absent handoff leaves runtime unloaded.
- `telegram_attach` execution lazy-loads runtime but preserves current active-turn and outbound-file safety errors/behavior.
- Shutdown delegates cleanup only if runtime was already loaded.
- Profiling before/after is recorded in the task or close-out notes, with ordinary startup import time substantially below the current ~1.6s+ warm profile.

## Validation

- Add or update targeted behavior checks for the unloaded startup path, lazy command/tool activation, mid-turn connect, handoff-triggered loading, and shutdown no-op/delegation split.
- Add an import/profile guard or documented local profiling script sufficient to prove the heavy runtime modules are not imported during ordinary startup.
- Run `npm run check` before reporting completion.
- Manually smoke-test a real pi startup if practical, comparing perceived startup latency before and after.

## Out of scope

- Do not change Telegram pairing, authorization, command semantics, routing, retry, delivery, or attachment policy except where necessary to preserve them through lazy loading.
- Do not make the prompt suffix conditional in this slice; that may be planned separately if prompt noise becomes a product concern.
- Do not introduce a separate daemon, hosted relay, worker service, or inbound workstation endpoint.
- Do not optimize TypeBox/schema import away unless it is verified safe against pi's tool registration expectations; it is optional after the main lazy boundary works.

## Pre-edit impact preview

This is a cross-cutting refactor across the extension entrypoint, pi integration registration, lifecycle hooks, and runtime composition. The main risk is loading runtime too late for mid-turn connect or session-replacement handoff, or accidentally registering pi surfaces twice after dynamic import. Keep the change structured around one bootstrap-owned registration surface and one runtime-owned behavior surface, then validate with targeted behavior checks before broad cleanup.

## Decisions

- 2026-04-30: Implemented lazy startup with index.ts pointing at a new bootstrap facade. Bootstrap registers the six Telegram commands, telegram_attach, prompt suffix, and lightweight event hooks eagerly; it demand-loads src/extension.ts via a memoized dynamic import for explicit commands/tool use or matching replacement-handoff recovery.
- 2026-04-30: Refactored src/extension.ts into createTelegramRuntime(pi), returning runtime hook behavior without registering pi surfaces. registerTelegramExtension remains as a compatibility wrapper for tests/callers that need the old eager registration path.
- 2026-04-30: Startup profiling with scripts/profile-startup.mjs after the lazy boundary measured about 230ms warm import, 0.8ms factory, and 0.1ms ordinary session_start on this machine, compared with the earlier ~1.6-1.8s warm full-runtime import profile.
- 2026-04-30: After review, fixed lazy-session initialization to memoize and retry on failure, restored /telegram-broker-status persisted-state fallback, and expanded lazy-bootstrap checks for mid-turn connect abort priming, matching handoff-triggered load, and shutdown no-op/delegation.
- 2026-04-30: After second review, added shutdown-race protection: lazy runtime load/init now aborts command continuation once shutdown starts, and shutdown awaits/cleans any already-started runtime load without starting a new import. Added regression checks for concurrent initialization sharing, init retry after failure, and shutdown during initialization.
- 2026-04-30: Close-out verified the implementation against traced requirements and architecture: lazy bootstrap keeps pi-visible startup surface available, demand-loads runtime for explicit Telegram use or matching handoff recovery, preserves mid-turn connect/attachment/shutdown behavior through targeted checks, and passes npm run check.
