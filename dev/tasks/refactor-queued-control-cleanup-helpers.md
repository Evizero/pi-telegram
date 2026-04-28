---
title: "Refactor queued-control cleanup helpers"
status: "done"
priority: 3
created: "2026-04-28"
updated: "2026-04-28"
author: "Christof Stocker"
assignee: ""
labels: []
traces_to: ["SyRS-queued-control-finalization", "SyRS-cancel-queued-followup", "SyRS-queued-followup-steer-control", "SyRS-telegram-retry-after", "SyRS-runtime-validation-check"]
source_inbox: "refactor-queued-control-cleanup"
branch: "task/refactor-queued-control-cleanup-helpers"
---
## Objective

Refactor the queued-follow-up control cleanup implementation so the terminal-state transitions, visible status-message finalization, retry/backoff handling, and status text constants are easier to audit, without changing behavior from the reviewed stale-control and cancel-control work.

This is a maintainability slice for code that is already behaviorally validated. The desired outcome is a clearer ownership boundary for queued-control cleanup policy, not new Telegram UI behavior.

## Scope

- Extract cohesive queued-control helpers from `src/broker/commands.ts` and `src/broker/sessions.ts` into an owning broker module such as `src/broker/queued-controls.ts` when that improves locality.
- Centralize terminal status text constants used for queued controls, including started, cleared, no-longer-waiting, cancelled, steered, and already-handled messages.
- Rename retry/backoff variables so they describe their actual meaning. In particular, avoid names that imply only Telegram 429 rate limiting when the code also covers transient retryable failures.
- Make the queued-control state machine legible in code comments or type-adjacent documentation: `offered`, `converting`, `cancelling`, `converted`, `cancelled`, `expired`, plus `completedText`, `statusMessageFinalizedAtMs`, per-control retry, and broker-wide cleanup retry.
- Reduce focused test boilerplate only where it makes the covered edge cases easier to read, for example by adding small builders for queued-control records and route cleanup fixtures.

## Preserved behavior

- Do not change durable queue authority: the client/runtime remains the authority for whether a queued turn is atomically converted to steer or cancelled.
- Do not change Telegram-visible semantics, callback answers, terminal status text, inline button layout, or route/thread preservation except to remove accidental duplication through constants.
- Do not weaken `retry_after` handling. Broker-wide queued-control cleanup backoff, per-control retry timestamps, transient edit retry behavior, and topic-cleanup ordering must remain intact.
- Do not make visible cleanup a prerequisite for starting, cancelling, steering, or clearing queued work.
- Do not regress existing cancel controls or default busy-message follow-up behavior.

## Codebase grounding

Likely touchpoints:

- `src/broker/commands.ts` — queued-control callback handling, terminalization, visible finalization, pruning, and command-triggered cleanup sweeps.
- `src/broker/sessions.ts` — session/offline/route cleanup paths that mark and finalize queued controls before topic deletion when possible.
- `src/shared/types.ts` — add only clarifying comments or type-adjacent documentation if useful; avoid incompatible state-shape changes.
- `src/extension.ts` — keep composition wiring minimal; only adjust imports/dependencies if helper extraction requires it.
- `scripts/check-telegram-command-routing.ts`, `scripts/check-session-route-cleanup.ts`, and `scripts/check-manual-compaction.ts` — keep behavior coverage while reducing repeated fixture setup where safe.

## Acceptance criteria

- Queued-control terminalization and visible cleanup policy has a clearer single owner or clearly named helper boundary.
- Retry/backoff naming distinguishes generic retry-deferred cleanup from Telegram-only rate limiting.
- Status text literals for queued-control terminal states are centralized enough to prevent drift.
- The control-state lifecycle and cleanup retry fields are documented near the implementation or type definition.
- Existing edge-case coverage remains present for normal start, stop/clear, expiry, missing pending turn, offline/invalid route callbacks, session unregister/offline cleanup, route cleanup before topic deletion, manual-compaction deferred drains, `retry_after`, transient edit failures, and broker-wide cleanup backoff.

## Out of scope

- Do not add new queued-control actions or a generic `/cancel <message>` command.
- Do not redesign queued controls into activity rendering or a broader queue-management UI.
- Do not change Telegram route/topic lifecycle behavior beyond preserving existing cleanup semantics.
- Do not split unrelated cancel-control planning or stale-control behavior changes in this refactor.
- Do not do a broad `src/extension.ts` decomposition in this slice.

## Validation

Run:

- `npm run check`
- `pln hygiene`

A focused review should compare pre/post behavior for queued controls, especially retry/backoff and stale-button cleanup paths, rather than only checking formatting.

## Pre-edit impact preview

This should be a small refactor over already-reviewed behavior. The main risk is accidentally changing subtle retry or terminal-state semantics while moving helpers. Keep edits behavior-preserving, prefer targeted extraction/renaming, and re-run the full local check suite before reporting completion.

## Decisions

- 2026-04-28: 2026-04-28: Planning review reported no findings; task is ready as a behavior-preserving maintainability slice for queued-control cleanup helpers.
- 2026-04-28: 2026-04-28: Implementation started. Impact preview: limit edits to queued-control cleanup helpers, command/session cleanup wiring, related type comments, and existing focused test fixtures; preserve Telegram-visible behavior and retry semantics.
- 2026-04-28: 2026-04-28: Implemented behavior-preserving helper extraction: queued-control callback/state helpers moved to src/broker/queued-controls.ts, terminal text constants centralized in src/shared/queued-control-text.ts, session cleanup uses generic deferred retry naming, and type comments document terminal UI cleanup state.
- 2026-04-28: 2026-04-28: Review found that generic turn_consumed cleanup could visibly race in-flight steer/cancel results. Fixed by adding consumed-control terminalization that maps converting/cancelling to converted/cancelled, passing authoritative steered/cancelled text from client runtime, preserving already-finalized same-text controls, and adding command-routing coverage for the in-flight consumed case.
- 2026-04-28: 2026-04-28: Follow-up review found broker-failover consumed controls without explicit final text still needed action-specific terminal text. Updated consumed-control terminalization to infer steered/cancelled text from converting/cancelling status when no text is supplied and expanded command-routing coverage.
- 2026-04-28: 2026-04-28: Final review found transient cleanup edit failures could schedule broker-wide backoff but continue the same sweep. Fixed command-router finalization loops to stop when a transient retry defers cleanup and added regression coverage that a second pending control is not edited during that backoff.
- 2026-04-28: 2026-04-28: Review found two compatibility gaps: missing-pending in-flight controls still used generic already-handled text, and route validation rejected legacy controls without routeId. Updated helper recovery to action-specific steered/cancelled text, reused the route fallback matcher for callback route validation, and expanded command-routing assertions.
- 2026-04-28: 2026-04-28: Review found callback handling under cleanup backoff could still use generic already-handled text for missing in-flight controls. Updated the missing-pending callback branch to reuse action-specific in-flight terminalization and added coverage with broker-wide cleanup backoff active.
- 2026-04-28: 2026-04-28: Review found callback ordering plus pruning could bypass action-specific terminalization for expired in-flight controls during cleanup backoff. Moved missing-pending in-flight handling ahead of expiry/opposite-action responses, preserved in-flight controls during prune so they can terminalize, and covered the expired/backed-off callback path.
- 2026-04-28: 2026-04-28: Review found already_handled convert/cancel callback results could still persist generic text. Converted already_handled steer/cancel outcomes to action-specific terminal text and added failover recovery assertions for both actions.
- 2026-04-28: 2026-04-28: Final focused review reported no findings after latest fixes; implementation is ready for close-out review. Validation passed with npm run check and pln hygiene.
- 2026-04-28: 2026-04-28: Close-out review accepted implementation. Acceptance criteria are covered by targeted command-routing, client-turn, manual-compaction, session-route-cleanup, and full npm run check validation; traced SyRS remain satisfied and final focused review reported no findings where applicable.
