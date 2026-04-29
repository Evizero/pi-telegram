---
title: "Reduce duplicated test discovery and weak test typing"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["tighten-behavior-check-fixture-typing"]
---
Code-quality audit finding from 2026-04-28.

`commonjs scripts/run-activity-check.mjs` manually lists every check script while `tsconfig.activity-check.json` also has to include the same files. Several checks use `as any` / `as never` fixtures, and production code also has small `any` leaks in `src/client/info.ts:76` and `src/shared/ui-status.ts:4`.

Suggested planning direction: use one test manifest or auto-discover `scripts/check-*.ts`, extract typed test harness helpers, and derive production callback/theme types from the pi extension API types.


## Investigation update — 2026-04-29

The original discovery-drift concern is now resolved by the archived `stabilize-behavior-check-harness` task: `scripts/run-behavior-check.mjs` discovers sorted root-level `scripts/check-*.ts` files, generates `tsconfig.behavior-check.generated.json`, compiles exactly that discovered set plus package sources, executes the emitted checks, and removes the generated config. The old `check:activity` / `tsconfig.activity-check.json` setup is gone.

The remaining valid scope is type-safety and fixture cleanup, not another discovery rewrite:

- `npm run check` is still the required validation entrypoint and currently passes.
- Root behavior checks are now domain-organized enough to avoid another broad split in this task, with the notable remaining large but focused files `scripts/check-telegram-queued-controls.ts` (876 lines), `scripts/check-final-delivery.ts` (770), and `scripts/check-runtime-pi-hooks.ts` (710).
- Broad casts remain concentrated in test harnesses: `scripts/check-runtime-pi-hooks.ts`, `scripts/check-client-runtime-host.ts`, `scripts/check-client-turn-delivery.ts`, `scripts/check-callback-updates.ts`, `scripts/check-broker-background.ts`, `scripts/check-client-info.ts`, and the two new session runtime-update check files.
- Production `any` leaks remain in `src/client/info.ts` (`clientSetModel` callback model parameter) and `src/shared/ui-status.ts` (`theme`), both likely replaceable with exported pi package types (`Model<Api>` from `@mariozechner/pi-ai` and `Theme` from `@mariozechner/pi-coding-agent`).
- Runtime-update tests duplicate dependency stubs for `createRuntimeUpdateHandlers`; a typed support builder for `RuntimeUpdateDeps` would remove `commandRouter ... as any/as never` patterns and keep scenario-specific overrides readable.
- Pi-hook tests duplicate partial `ExtensionAPI`, `ExtensionContext`, and `RuntimePiHooksDeps` fixtures; typed support helpers can reduce `any` payload plumbing while keeping event payloads and assertions explicit.

Replanned direction: create a focused ready task for behavior-check typing and production API type leaks. Do not move behavior checks out of `scripts/`, do not change the discovery runner, and do not split more files unless a small helper extraction requires it.
