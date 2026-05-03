# pi-telegram documentation

This directory is the current documentation baseline for `pi-telegram`. It is written for users, maintainers, and coding agents that need a compact map before changing the bridge.

## Start here

- [Getting started](getting-started.md) — install, configure, pair, connect, route sessions, exchange files, and troubleshoot first-run issues.
- [Telegram command reference](telegram-commands.md) — Telegram-side commands and controls.
- [Maintenance guide](maintenance.md) — repository shape, validation, planning workflow, and safe change rules.

## Internals

- [Runtime architecture](internals/runtime-architecture.md) — lazy bootstrap, runtime composition, broker/client split, pi hooks, Telegram boundary, and module ownership.
- [Activity rendering](internals/activity-rendering.md) — Telegram activity rows, thinking/tool presentation, final-ordering cleanup, and renderer recovery behavior.
- [State and reliability](internals/state-and-reliability.md) — durable files, broker lease/state, pending turns, assistant finals, outbox jobs, route cleanup, retry windows, and recovery behavior.

## Authoritative project records

These files remain authority for scope, requirements, and API constraints. The docs summarize them; they do not replace them.

- [`../dev/INTENDED_PURPOSE.md`](../dev/INTENDED_PURPOSE.md) — product purpose and scope boundaries.
- [`../dev/ARCHITECTURE.md`](../dev/ARCHITECTURE.md) — normative architecture contract and current-state clarifications.
- [`../dev/STAKEHOLDER_REQUIREMENTS.json`](../dev/STAKEHOLDER_REQUIREMENTS.json) — stakeholder requirements.
- [`../dev/SYSTEM_REQUIREMENTS.json`](../dev/SYSTEM_REQUIREMENTS.json) — implementable system requirements.
- [`../docs.md`](../docs.md) — project-local Telegram Bot API guidance.
- [`../AGENTS.md`](../AGENTS.md) — repository instructions for coding agents.

## Current red thread

`pi-telegram` exists to preserve continuity of control over local pi sessions from a phone. The code should keep these boundaries clear:

1. **Telegram is the remote control surface.** It carries messages, controls, files, activity, and final replies.
2. **pi remains the execution authority.** Shell access, workspace mutation, credentials, model/session state, and agent execution remain local.
3. **The broker is extension-owned.** One connected pi process polls Telegram and owns shared state; no external daemon, hosted relay, or inbound workstation endpoint is part of the normal design.
4. **Durable state protects continuity.** Pending turns, assistant finals, selected routes, media groups, cleanup work, and retry windows are explicit broker-state concerns.
5. **Telegram API constraints are design constraints.** `retry_after`, webhook/polling exclusivity, update offsets, file limits, text limits, topic IDs, media groups, and callback handling are part of the runtime contract.
6. **Busy-turn intent is explicit.** Ordinary busy messages queue as follow-ups; `/steer` and eligible buttons provide urgent correction; cancel controls withdraw still-queued follow-ups.

## Current gaps and places to inspect first

- Behavior and architecture are more current than old release-facing docs; prefer the docs in this directory plus `dev/ARCHITECTURE.md` when in doubt.
- Requirement records are still in draft/ready statuses even though many implementation tasks are archived as done. Do not infer release readiness from requirement status alone.
- If a future docs update changes obligations or architecture, use `pln` planning workflows rather than silently making docs the new authority.
