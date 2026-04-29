---
title: "Stabilize behavior check harness discovery"
status: "done"
priority: 2
created: "2026-04-29"
updated: "2026-04-29"
author: "Christof Stocker"
assignee: ""
labels: ["validation", "tests", "maintenance"]
traces_to: ["SyRS-runtime-validation-check", "SyRS-behavior-check-discovery"]
source_inbox: "rework-validation-suite-around"
branch: "task/stabilize-behavior-check-harness"
---
## Objective

Make the existing behavior-check harness use one synchronized discovery path for compilation and execution while preserving the current behavioral coverage and the stable `npm run check` entrypoint.

## Scope

- Replace the duplicated handwritten check-script inventory in `scripts/run-activity-check.mjs` and `tsconfig.activity-check.json` with one source of truth, automatic discovery, or an explicit mismatch guard.
- Rename the npm script that runs the whole behavior suite from the misleading `check:activity` name to a scope-accurate behavior-check name, while keeping `npm run check` as the required validation command.
- Preserve the current temp-compile execution model unless a smaller local simplification proves safe.
- Ensure every currently executed `scripts/check-*.ts` behavior check still compiles and runs.

## Codebase grounding

Likely touchpoints:
- `package.json`
- `scripts/run-behavior-check.mjs` (renamed from `scripts/run-activity-check.mjs` during implementation)
- `tsconfig.behavior-check.json` (renamed from `tsconfig.activity-check.json` during implementation)
- possibly a small generated temporary tsconfig if that keeps compile and execution inputs aligned
- `AGENTS.md` only if the required validation wording needs to mention the renamed lower-level script

Current source facts from the inbox item:
- 25 `scripts/check-*.ts` files are currently compiled and executed.
- The runner and TypeScript config each manually list those checks before this slice.
- Existing checks import source modules through the compile-to-temp flow, so raw TypeScript runner changes are out of scope unless proven locally.

## Implementation notes

- Chosen path: auto-discovery. The behavior runner discovers `scripts/check-*.ts` files at runtime, sorts them deterministically, generates a temporary TypeScript project that includes exactly those discovered checks plus package source files, compiles into a temp directory, and executes the emitted `.js` checks from the same discovered list.
- The static `tsconfig.behavior-check.json` keeps only shared behavior-check compiler settings and package source inclusion; it no longer contains a handwritten check inventory.
- The generated tsconfig is deleted in a `finally` block so the repository is not left with temporary validation files after success or failure.
- The lower-level npm script is now `check:behavior`; `npm run check` remains the stable required entrypoint and still runs typechecking before behavior checks.

## Preserved behavior

- `npm run check` remains the required validation command.
- `npm run check` continues to run package typechecking before behavior checks.
- Existing behavior checks must not be deleted, weakened, or silently skipped.
- Runtime source behavior should not change in this slice.

## Acceptance criteria

- Running `npm run check` passes.
- The behavior-check runner output shows that the same 25 existing check scripts still execute after the refactor.
- Adding or detecting an unregistered `scripts/check-*.ts` file cannot result in a check being compiled but not executed, or executed without being compiled, without an explicit failing diagnostic.
- The lower-level npm script name accurately describes the behavior suite scope.
- The implementation notes explain whether the chosen path is manifest-based, auto-discovered, or mismatch-guard based.

## Out of scope

- Migrating to Vitest, Jest, or Node `node:test`.
- Extracting shared typed fixtures from large check scripts.
- Splitting the oversized check files.
- Changing broker/client/Telegram/pi runtime behavior.

## Decisions

- 2026-04-29: Implement the harness slice by keeping the existing temp-compile execution model and moving behavior-check inventory into runner-owned auto-discovery of `scripts/check-*.ts`. The runner will generate the temporary tsconfig used for compilation, so compile and execution sets share one source of truth without introducing a standard test runner yet.
- 2026-04-29: Rename the runner and behavior-check TypeScript config to match the suite scope (`scripts/run-behavior-check.mjs` and `tsconfig.behavior-check.json`) while keeping the package-level required entrypoint `npm run check` unchanged.
