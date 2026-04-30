---
title: "Harden durable JSON boundary recovery"
status: "done"
priority: 2
created: "2026-04-30"
updated: "2026-04-30"
author: "Christof Stocker"
assignee: ""
labels: ["reliability", "durability"]
traces_to: ["SyRS-durable-json-invalid-state", "SyRS-durable-maintenance-file-isolation", "SyRS-final-delivery-fifo-retry", "SyRS-session-replacement-route-continuity", "SyRS-broker-lease-loss-standdown"]
source_inbox: "durable-json-read-failures"
branch: "task/harden-durable-json-boundary-recovery"
---
## Objective

Harden durable JSON boundary recovery so corrupt or schema-invalid local runtime state is visible and non-destructive, while independent recovery records continue to be processed.

The original inbox claim is already fixed for raw reads: `readJson()` returns `undefined` only for `ENOENT` and throws malformed JSON or filesystem read errors, with `scripts/check-durable-json-loading.ts` covering that behavior. This task starts from the remaining reliability gap found during the deep dive: parsed-but-invalid records and per-file maintenance failures can still be discarded silently or block unrelated durable recovery work.

## Scope

Implement explicit invalid durable-state handling at the runtime persistence boundaries that affect continuity:

- broker/config/lease/state reads should keep the current fail-closed behavior for malformed or unreadable JSON and add enough path/context for diagnostics;
- schema validation should prevent parsed-but-invalid durable records from being treated as absent or from driving lifecycle behavior with missing required fields;
- per-file maintenance scans for pending finals, disconnect requests, and session-replacement handoffs should isolate malformed, unreadable, and schema-invalid records so one bad record does not prevent later valid records from being processed;
- invalid records should remain available for diagnosis unless an existing lifecycle-specific rule has clearly classified the record as safe to discard.

## Codebase Grounding

Likely touchpoints:

- `src/shared/utils.ts` and `scripts/check-durable-json-loading.ts` for contextual JSON read errors and baseline missing-vs-invalid behavior.
- `src/client/final-handoff.ts` for pending client final files, including merge/persist and broker-side processing of pending-final files.
- `src/extension.ts` for broker state load, main broker lease reads, disconnect request reads, and disconnect-request directory processing.
- `src/client/session-replacement.ts` for session replacement handoff scanning and validation.
- `src/broker/lease.ts` for takeover-lock invalid-state handling during acquisition/renewal.
- Existing behavior-check scripts near final handoff, disconnect requests, replacement handoff, broker renewal contention, and durable JSON loading.

## Preserved Behavior

- Missing durable files still mean absence where that is currently expected, such as first-run config/state initialization or no pending record.
- Malformed JSON and filesystem read errors must continue to fail closed rather than being treated as empty state.
- Broker lease fencing and stale-broker stand-down semantics remain unchanged.
- Assistant final FIFO retry semantics remain unchanged for valid records.
- Explicit disconnect, session replacement handoff, and cleanup flows keep their existing route/session lifecycle semantics for valid records.
- Do not weaken private file permissions or atomic write behavior.

## Acceptance Criteria

- Missing, valid, malformed, directory, and permission/read-error durable JSON cases are covered with path/context expectations where errors are reported.
- A malformed, unreadable, or schema-invalid broker `state.json`, Telegram config file, or main broker lease file is treated as invalid durable state and is not overwritten or replaced by default/new state during startup/connect/election paths.
- A malformed, unreadable, or schema-invalid pending-final file is not silently deleted and does not prevent another valid pending-final file from being processed.
- A malformed, unreadable, or schema-invalid disconnect-request file does not prevent another valid disconnect request from being processed.
- A malformed, unreadable, or schema-invalid session-replacement handoff does not prevent a later valid matching handoff from being found or consumed.
- A malformed, unreadable, or schema-invalid takeover-lock record is reported as an invalid coordination artifact rather than being treated as an empty stale takeover lock.

## Out of Scope

- Do not design a full schema-migration framework for historical durable state.
- Do not change the on-disk JSON format unless a minimal version/shape check requires it.
- Do not add user-facing repair commands in this slice.
- Do not change Telegram retry_after, final-delivery ledger ordering, queued compaction, or session lifecycle semantics except where invalid durable files currently interfere with them.

## Validation

Run `npm run check`. Add or update focused behavior checks in the existing `scripts/check-*.ts` suite for durable JSON loading, client final handoff, disconnect requests, session replacement handoff, and broker renewal/takeover-lock behavior.

## Decisions

- 2026-04-30: Implemented invalid durable JSON handling as explicit boundary validation rather than a migration framework: readJson now wraps non-missing read/parse errors with path context, central broker/config/lease reads validate required shape before use, per-file pending-final/disconnect/replacement scans catch and report invalid files while continuing with valid files, and invalid files are preserved unless an existing lifecycle rule safely discards a valid stale/no-work record.
- 2026-04-30: Review-driven hardening expanded central broker-state validation to nested records that can affect polling, media-group replay, final delivery, outbox jobs, controls, selectors, and manual compaction; config loading now validates each raw artifact and alias before normalizing only defined values so partial user config does not erase broker config and invalid aliases cannot be masked.
