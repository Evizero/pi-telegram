---
title: "Rework validation suite around reusable fixtures and behavior domains"
type: "request"
created: "2026-04-28"
author: "Christof Stocker"
status: "planned"
planned_as: ["stabilize-behavior-check-harness"]
---
Source: Telegram voice note transcribed on 2026-04-28. The user clarified that the earlier audit was too micro-detail oriented and asked to zoom out across files to judge whether the codebase is becoming incoherent, duplicated, divergent, or duct-taped together, and whether a cleanup is needed.

Capture: the validation suite has very large script files (`check-telegram-command-routing.ts` at 1337 lines, `check-session-route-cleanup.ts` at 1140 lines) plus manual check discovery in `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json`.

Concern: tests mirror the same accretion pattern as runtime code. Big scenario scripts make it difficult to identify conventions, reuse setup, or add coverage without copying fixtures and casts.

Desired cleanup direction: split tests by behavior domain, extract typed broker/client/Telegram fixtures, and use a single manifest or auto-discovery path so compiled checks and executed checks cannot diverge.



## Simplification pass note (2026-04-28)

Related simplification: tests should mirror the future bounded contexts rather than the current sprawl. Extract typed fixtures for broker/client/Telegram behaviors and use one manifest or auto-discovery so compiled checks and executed checks cannot diverge.


## Testing setup assessment note (2026-04-29)

Prompt: after asking what the next big cleanup/refactor should be, the user asked whether the project has a good testing setup and then asked to preserve a detailed inbox item.

Current assessment: the project has meaningful behavioral checks, but the test architecture is not yet a good maintainable setup. `npm run check` currently runs `tsc --noEmit` followed by `scripts/run-activity-check.mjs`; that runner compiles the source and check scripts through `tsconfig.activity-check.json`, then executes each generated `scripts/check-*.js` file in a hard-coded order.

What is working well:
- The suite is not just a smoke test. It contains real assertions across important bridge behavior.
- Existing checks cover major reliability areas: activity rendering, final delivery ledger behavior, preview cleanup, client turn delivery and abort, final handoff, retry-aware finalization, runtime pi hooks, manual compaction queueing, Telegram command routing, model picker behavior, Telegram IO policy, Telegram text reply contracts, session route cleanup, temp cleanup, security/setup/attachment handling, and session replacement handoff.
- The required project validation command (`npm run check`) passed locally on 2026-04-29.
- TypeScript checking is integrated into the validation path.

What is weak or risky:
- There is no standard test runner such as `node:test`, Vitest, or Jest, so checks rely on ad hoc script execution and hand-written assertion functions.
- Test discovery is duplicated: `scripts/run-activity-check.mjs` manually lists executed check scripts while `tsconfig.activity-check.json` manually lists compiled check scripts. Adding a check requires updating both, which can let compiled coverage and executed coverage drift.
- The `check:activity` npm script name is misleading because it runs the whole behavioral suite, not just activity checks.
- Several check files have become oversized scenario bundles, mirroring the runtime accretion pattern they are meant to guard against. Current local line counts included approximately:
  - `scripts/check-telegram-command-routing.ts` — 1364 lines
  - `scripts/check-session-route-cleanup.ts` — 1327 lines
  - `scripts/check-final-delivery.ts` — 770 lines
  - `scripts/check-runtime-pi-hooks.ts` — 710 lines
- Fixtures and fakes are scattered through large scripts instead of being reusable, typed harness modules.
- Weak typing in tests (`as any`, `as never`, broad ad hoc fixture shapes) makes it easier for tests to keep passing while production interfaces drift.
- Large check scripts make it hard to identify the behavior domain under test, reuse setup, or add focused coverage before risky runtime refactors.

Desired cleanup direction:
- Treat this as the next major cleanup before deeper runtime architecture changes such as a durable Telegram side-effect outbox or a shared turn/final lifecycle state machine.
- Split oversized check scripts by behavior domain rather than by historical accumulation.
- Extract reusable typed fixtures/fakes for broker state, session registration, client IPC, Telegram API calls, route/topic cleanup, command/callback routing, final delivery/retry behavior, and pi hook lifecycle.
- Replace duplicated discovery with one source of truth: either a manifest consumed by both compilation and execution, or auto-discovery of `scripts/check-*.ts` with a clear opt-out/ordering mechanism where ordering is genuinely needed.
- Rename validation scripts so their names describe the actual scope, for example `check:behavior` instead of `check:activity`.
- Preserve the simple local command contract: `npm run check` remains the required validation entrypoint.
- Avoid losing existing behavioral coverage while reshaping the harness. The first acceptance criterion should be that all currently executed checks still execute after the refactor.

Potential planning split:
1. Harness/discovery slice: remove manual duplicate script lists and make the validation command name accurate.
2. Fixture extraction slice: introduce typed reusable test helpers without changing production behavior.
3. Domain split slice: break the largest check scripts into smaller behavior-focused files using those fixtures.
4. Coverage-hardening slice: add focused checks around risky runtime seams only after the harness is easier to extend.

Non-goals at inbox stage:
- Do not rewrite runtime behavior as part of this cleanup.
- Do not switch to a heavy framework unless planning decides the benefits outweigh keeping the current lightweight script style.
- Do not drop scenario coverage merely to reduce file size.


## Deep-dive grounding and approach trade-offs (2026-04-29)

This item is now spec-shaped source material for later planning, not an implementation task yet. The central question is not whether the project has tests at all; it does. The question is whether the test setup is strong enough to support the next generation of risky refactors without letting behavior regress or making every new check expensive to add.

### Repository evidence

Local inventory on 2026-04-29:

- `package.json` defines:
  - `typecheck`: `tsc --noEmit`
  - `check:activity`: `node scripts/run-activity-check.mjs`
  - `check`: `npm run typecheck && npm run check:activity`
- `scripts/run-activity-check.mjs` compiles a custom TypeScript project into a temp directory, writes a temporary `package.json` with `{"type":"module"}`, symlinks `node_modules`, then runs generated `scripts/check-*.js` files one by one.
- `tsconfig.activity-check.json` extends the main `tsconfig.json`, changes `rootDir` to `.`, enables emit, and manually includes `index.ts`, `src/**/*.ts`, and every check script.
- Current runner and TypeScript include lists both contain 25 check scripts. They are in sync today, but only because two handwritten lists match.
- The 25 `scripts/check-*.ts` files total about 8524 lines.
- Oversized checks are concentrated in four files:
  - `scripts/check-telegram-command-routing.ts` — 1364 lines
  - `scripts/check-session-route-cleanup.ts` — 1327 lines
  - `scripts/check-final-delivery.ts` — 770 lines
  - `scripts/check-runtime-pi-hooks.ts` — 710 lines
- The check scripts and runtime source contain 36 local `as any`, `as never`, or similar escape-hatch casts, mostly in tests and harness code. The concentration is a signal that reusable typed fixtures are missing, not necessarily that production behavior is weak.
- There is no dedicated test helper directory under `scripts/`; fakes for Telegram calls, sessions, broker state, pi contexts, route objects, IPC calls, and activity reporters are defined ad hoc inside individual check files.
- The current suite is behavior-focused and valuable: it exercises retry-after propagation, final delivery ledger progress, preview cleanup, queued controls, route cleanup, temp cleanup, client runtime/turn delivery, pi hook behavior, and security/setup/attachments.

### External tooling facts checked

Primary sources checked on 2026-04-29:

- Node's built-in test runner is stable and exposed through `node:test`; passing `node --test` invokes the CLI runner. Node runs default matching test-file patterns and also supports TypeScript test-file patterns when type stripping is enabled. Source: https://nodejs.org/api/test.html
- Node's test runner executes matching test files as test files, with process-level isolation enabled by default; files do not technically have to import `node:test`, though using `node:test` enables named tests, subtests, mocks, hooks, reporters, and better failure locality. Source: https://nodejs.org/api/test.html
- Node's built-in TypeScript support is lightweight type stripping. It does not perform type checking, ignores `tsconfig.json`, and does not transform settings such as paths or target conversion. Source: https://nodejs.org/api/typescript.html
- Vitest currently documents a normal `npm install -D vitest` setup, `.test.`/`.spec.` file discovery, `vitest run`, watch/filtering/reporting features, and a Node >=20 / Vite >=6 requirement. Source: https://vitest.dev/guide/

Important implication for this repository: raw `node --test` over the existing `.ts` check files is not automatically a drop-in replacement. The source and tests currently import project modules with emitted-JS-style `.js` specifiers, while the source tree contains `.ts` files. The current temp-compile runner sidesteps that by compiling everything before execution. A Node test migration can still compile to temp first, or it can deliberately adjust import-extension strategy, but it should not assume Node type stripping alone will run the current files unchanged.

### Diagnosis

The project has good behavioral intent and a useful regression net, but the harness shape is a maintainability liability.

The current setup is strongest when a maintainer already knows which file to edit and can tolerate large scenario scripts. It is weakest when a future agent needs to add a small focused regression check, discover whether a behavior is already covered, or refactor a runtime boundary with confidence. The suite's organization currently repeats the same problem the runtime cleanup is trying to solve: correct local pieces, weak global shape.

The most important distinction: do not start by chasing coverage metrics. Start by making the existing checks easier to discover, execute, split, and extend without losing behavior.

### Candidate approaches

#### Approach A — Keep the custom runner, but add one manifest and shared fixtures

Shape:
- Keep compiling checks with `tsconfig.activity-check.json` or an equivalent generated config.
- Replace the duplicated runner/include lists with one `scripts/checks-manifest.*` source of truth, or generate the compile include list from discovered `scripts/check-*.ts` files.
- Add typed helper modules under something like `scripts/check-helpers/` or `scripts/fixtures/`.
- Rename `check:activity` to a scope-accurate name such as `check:behavior`, while keeping `npm run check` as the stable required command.

Pros:
- Lowest migration risk.
- No new test framework dependency.
- Preserves current temp-compile behavior, which already works with emitted `.js` import specifiers.
- Lets the first cleanup focus on real pain: duplicate discovery and untyped fixtures.
- Easy to verify: the same 25 checks should still execute.

Cons:
- Still ad hoc: no native subtest reporting, filtering, hooks, watch mode, or standard test output unless implemented manually.
- Large files can remain large unless a later slice enforces domain splitting.
- Future contributors may still find the setup unfamiliar compared with a standard runner.

Best fit if the immediate goal is a safe first cleanup slice before runtime refactors.

#### Approach B — Adopt Node's built-in `node:test`, still using compile-to-temp

Shape:
- Convert checks to `node:test` files with named `test(...)` cases and optional `describe`/`it` aliases.
- Compile tests to temp JS as today, then run `node --test` against the emitted test files.
- Use `node:assert/strict` as today and gradually adopt `t.mock`, hooks, and test reporters where useful.

Pros:
- No third-party framework dependency.
- Standard runner gives named tests, subtests, hooks, reporters, process-level test-file isolation, and better failure locality.
- Aligns well with the current dependency-light package philosophy.
- Existing assertion style can migrate incrementally.
- Process isolation can reduce accidental shared state between test files.

Cons:
- Requires converting top-level check scripts into named test cases or accepting only file-level pass/fail initially.
- Still needs a compile step unless import extensions and Node TypeScript constraints are deliberately changed.
- Node's built-in TypeScript type stripping does not replace `tsc --noEmit`; type checking must remain a separate validation step.
- Some currently sequential tests may rely on order or timing; process isolation/concurrency settings may need explicit control.

Best fit if the project wants a standard runner without adding Vitest/Vite dependency surface.

#### Approach C — Adopt Vitest

Shape:
- Add Vitest as a dev dependency.
- Move or rename checks into `.test.ts`/`.spec.ts` files and run `vitest run` from `npm run check` after typecheck.
- Use Vitest's watch mode, filtering, mocks, coverage integration if desired, and familiar test structure.

Pros:
- Best developer ergonomics: filtering, watch mode, readable output, test grouping, rich mocks, and common ecosystem familiarity.
- Good fit for TypeScript test authoring without the project's current temp-compile ceremony.
- Easier for future agents and maintainers to infer conventions from common tooling.
- Can make later domain split more natural: one test file per behavior area with shared fixtures.

Cons:
- Adds third-party dev dependency and its transitive dependency surface to a currently lean package.
- Vitest's Vite-centered assumptions may be more tooling than this Node-only extension needs.
- Requires checking Node/version compatibility and ESM/NodeNext behavior carefully.
- Migration could distract from the more important fixture/domain cleanup if done as a big-bang rewrite.

Best fit if maintainability and contributor familiarity are valued more than dependency minimalism.

#### Approach D — Discovery-only first, defer runner choice

Shape:
- Do the smallest possible slice: auto-discover or manifest check scripts, rename `check:activity`, and add a guard that fails if a `scripts/check-*.ts` file is not executed.
- Leave script contents and runner style mostly unchanged.

Pros:
- Very small blast radius.
- Directly fixes the current drift risk.
- Makes later refactors safer because new checks cannot be silently omitted.

Cons:
- Does not solve oversized files, scattered fixtures, weak typing, or poor failure locality.
- Could be too small to unblock deeper runtime refactors by itself.

Best fit as a first commit if the team wants a low-risk checkpoint before fixture extraction.

#### Approach E — Fixture/domain refactor first, runner later

Shape:
- Keep the runner exactly as-is initially.
- Extract typed reusable fakes and builders, then split large scripts by behavior domain.
- Revisit Node test or Vitest only once the suite has clearer domain modules.

Pros:
- Attacks the biggest day-to-day authoring pain directly.
- Reduces `as any` / `as never` casts and makes production interface changes more visible.
- Makes any later runner migration easier because tests will already be modular.

Cons:
- Leaves duplicated discovery in place during the hardest refactor.
- Without named tests, split files may still produce coarse failure reporting.
- Risk of moving many assertions without an improved harness safety net.

Best fit if fixture duplication is blocking current work more than runner mechanics.

### Recommended sequencing

The lowest-risk path is not a single framework decision. It is a staged cleanup:

1. **Harness discovery slice.** Create one source of truth for check discovery/execution, rename `check:activity` to a behavior-suite name, and preserve `npm run check` as the stable entrypoint. Acceptance: all 25 existing checks still compile and execute; adding a new `scripts/check-*.ts` either runs automatically or fails loudly until it is intentionally registered.
2. **Typed fixture slice.** Add reusable typed check helpers for the repeated domains: `brokerState`, `sessionRegistration`, `telegramRoute`, `telegramCallRecorder`, `piContext`, `clientRuntimeDeps`, `activityReporter`, and temp workspace helpers. Acceptance: new helpers remove representative `as any`/`as never` casts without weakening assertions.
3. **Domain split slice.** Split the largest checks along behavior boundaries. Suggested cuts:
   - `check-telegram-command-routing.ts`: queued controls, Git controls, model picker callbacks, ordinary command routing.
   - `check-session-route-cleanup.ts`: unregister cleanup, disconnect requests, reconnect grace, pending-turn rehome, topic setup failure/orphan cleanup.
   - `check-final-delivery.ts`: ledger acceptance/dedupe, chunk/attachment progress, preview cleanup failure classes, retry/FIFO behavior, terminal error handling.
   - `check-runtime-pi-hooks.ts`: finalization events, local input mirroring, attachment tool validation, shutdown/replacement lifecycle.
4. **Runner decision slice.** After fixture/domain cleanup, choose whether the custom runner remains sufficient or whether to migrate to Node `node:test` or Vitest. If choosing a standard runner, prefer an incremental migration with one domain first.

### Approach recommendation for later planning

Default recommendation: **Approach A followed by fixture/domain refactor, with Node `node:test` as the likely later runner if standardization is still needed.**

Reasoning:
- This project is an extension package with a lean dependency set. A no-new-dependency first slice is attractive.
- The immediate problem is not assertion expressiveness; `node:assert/strict` is already enough for current checks. The immediate problem is discoverability, duplicate check registration, fixture duplication, large scenario files, and weak typing.
- Node `node:test` is a better later standardization candidate than Vitest if dependency minimalism remains important, but it should probably run emitted JS unless the source import-extension strategy is changed deliberately.
- Vitest remains a valid option if maintainers prefer stronger ergonomics and are comfortable adding dev dependencies, but it should be a conscious choice rather than the default answer to every testing cleanup.

### Success criteria for the eventual task

A later planned task should be considered successful only if:

- `npm run check` remains the required validation command and passes.
- Every currently executed behavioral check still executes after the refactor.
- Discovery has one source of truth or an explicit missing-check guard.
- Test script naming reflects real scope; no more `check:activity` name for the whole suite.
- At least one repeated fixture family is extracted with strong types.
- The largest files begin shrinking because behavior domains move into focused files, not because assertions are deleted.
- The test harness makes it easier to add a regression check for future runtime lifecycle/outbox refactors.

### Risks to avoid

- Do not convert to a framework and call the work done while leaving all large scenario blobs and duplicated fixtures intact.
- Do not chase coverage percentage before the behavior-domain organization is clear.
- Do not delete or merge assertions just to reduce line count.
- Do not rely on Node's TypeScript type stripping as a substitute for `tsc --noEmit`.
- Do not assume raw `.ts` test execution works with the current emitted-JS-style import specifiers without proving it locally.
- Do not make runtime code changes in the same slice unless they are tiny testability seams explicitly justified by the fixture extraction.
