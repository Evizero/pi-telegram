---
title: "simplify telegram reliability orchestration ownership and lifecycle"
type: "request"
created: "2026-04-26"
author: "OpenAI Codex"
status: "planned"
planned_as: ["simplify-telegram-reliability"]
---
# Telegram reliability slice cleanup / simplification capture

## Why this note exists

This inbox item captures a design-level concern that emerged while implementing and reviewing the Telegram retry/finalization/disconnect reliability work. The code is not being characterized as random slop, but it is showing signs of architectural strain. The concern is that continuing with patch-by-patch fixes in the current shape is likely to push the implementation from "careful but complex reliability code" into brittle workaround-heavy code.

This note preserves the reasoning behind that assessment, the specific structural smells observed, and a proposed cleanup direction that aims to recover a simpler, leaner ownership model.

## Current assessment of the codebase slice

### Summary judgment

Current state of this slice:
- not hopeless slop
- not obviously duct-tape in the usual sense
- not currently elegant / lean / simple either
- best described as careful, heavily tested, somewhat overgrown reliability code

The strongest parts right now are:
- there is real modular intent rather than one giant god file for all runtime logic
- there is substantial regression coverage protecting the behavior
- the work has generally tried to preserve explicit invariants rather than hide symptoms
- the implementation does have a coherent underlying model around broker durability, client execution, previews, retries, and final delivery

The main concern is not that the code is unserious. The concern is that this area has become a high-complexity orchestration surface with too many overlapping states and ownership boundaries.

### Practical quality rating from the current investigation

- code quality: medium-to-high
- architectural cleanliness: medium
- robustness intent: high
- complexity risk: high
- slop factor: low-to-medium, but rising if work continues through more local patches instead of consolidation

## What this assessment is based on

This note is based on the recent implementation/review cycle for the Telegram finalization / retry / disconnect work, including repeated read-only reviews and follow-up fixes across:
- retry-aware finalization
- preview lifecycle and preview reuse
- broker final durability and FIFO delivery
- disconnect request processing
- shutdown handoff behavior
- offline cleanup policy
- stale connection ownership
- client-side pending-final replay files
- route rehoming for pending turns

The assessment comes from both direct code inspection and the repeated pattern of review findings: many fixes were individually reasonable, but the fixes increasingly landed as additional branch conditions and cross-component recovery rules rather than as simplifications of one small underlying model.

## Main structural concerns

### 1. Too many overlapping state machines and ownership layers

This slice currently coordinates many partially overlapping state concepts:
- active Telegram turn
- deferred retry-aware final state
- awaiting-final-handoff state
- queued Telegram turns
- manual compaction queue state
- broker `pendingTurns`
- broker `pendingAssistantFinals`
- broker `assistantPreviewMessages`
- client retry queue for assistant finals
- client-side `client-pending-finals` disk files
- disconnect request files
- session connection ownership via connection nonce / connection start time

The issue is not just that many states exist. The issue is that correctness depends on interactions between them across multiple modules, which makes the system behave like a distributed state machine spread across client, broker, preview, final-delivery, and lifecycle code.

### 2. `src/extension.ts` is carrying too much policy

This file is serving as more than a wiring entrypoint. It currently acts as a major orchestrator for:
- session registration / heartbeat / stale-connection ownership
- broker IPC dispatch
- client IPC sending with retry/fallback behavior
- disconnect request coordination
- client pending-final persistence and replay coordination
- preview-clear routing
- active-turn / deferred-turn / awaiting-final orchestration
- startup/reconnect/shutdown policy

That concentration is one of the clearest signals that the architecture has become strained. Even if the code in the file is careful, it is now the place where too many policies meet.

### 3. Recovery branches are accumulating faster than simplifications

The recent work added many rules of the form:
- preserve preview state in some failures but not others
- defer retryable finals only when there is no useful assistant text
- keep route in some offline cases but not others
- clear preview refs only under certain route-change conditions
- reject stale session work for some message classes but preserve durable state for others
- replay pending durable files only if identity metadata matches certain conditions

Each individual rule can be justified. The problem is that the total system becomes hard to reason about because the happy-path model is no longer small.

### 4. Dual durability is a major smell

The current behavior uses meaningful durability in both:
- broker state
- client-side persisted pending-final files

This split ownership is one of the biggest drivers of complexity. It forces careful handling of replay, stale identity, disconnect timing, and replacement-client behavior. It also makes it harder to say with confidence where the source of truth is at a given moment.

### 5. Preview behavior is carrying too much correctness burden

Preview handling has had to absorb logic around:
- visible progress UI
- preview reuse across retries
- durable message identity for failover
- stale preview recovery after uncertain delete results
- preview rehome/invalidation when a route changes
- detachment when preview becomes final
- delete behavior differences for retryable vs permanent Telegram failures

This makes preview handling more central to correctness than is ideal for what should be best-effort UI state.

## Working diagnosis

The code does not primarily need more local fixes. It needs a simpler model with clearer ownership boundaries.

The most important problem is not one specific bug. It is that the current design is trying to achieve all of the following at once:
- retry-aware Telegram-visible final correctness
- crash/restart durability
- broker failover safety
- stale-client suppression
- preview preservation / reuse
- route rehome / cleanup correctness
- disconnect/offline cleanup correctness

while still allowing multiple fallback paths for handoff and replay.

That combination is what is creating a workaround-heavy feel even though the code is not careless.

## Proposed cleanup direction

### High-level design goal

Recover a leaner architecture by enforcing:
- one source of truth per durable concern
- one explicit state machine per lifecycle
- broker-owned durability
- client-owned execution only
- previews treated as best-effort or shallowly durable, not as a core correctness mechanism
- stale connections as terminally superseded rather than partially salvageable

### Desired ownership model

#### Turns
Broker should own durable turn state.
- If a Telegram turn exists durably, broker owns it.
- Client executes it but should not also be a long-term durable source of truth for the same turn.

#### Finals
Broker should ideally own durable final state as early as possible.
- Client-side durable final replay should be minimized or removed if broker-owned handoff can replace it.
- If client-side durability remains necessary, it should have a very strict, narrow contract rather than acting as a second broad durability system.

#### Previews
Broker should own durable preview identity if preview reuse is needed at all.
- Preview correctness should not be allowed to complicate final correctness indefinitely.
- Prefer a model where preview reuse is shallow and disposable.

#### Session connection ownership
Session ownership should be explicitly broker-authoritative.
- The broker decides which connection is current.
- Any superseded connection should lose the ability to mutate broker-visible turn state.
- Stale clients should stand down immediately and deterministically.

## Suggested simplification principles

### 1. Replace many flags with a small explicit client state machine

Instead of many overlapping booleans / nullable fields, move toward a small client turn lifecycle such as:
- idle
- running turn
- waiting for retry resolution
- waiting for broker final acknowledgment

This would replace scattered coordination among active turn state, deferred final state, awaiting-final state, and parts of abort logic.

### 2. Reduce broker delivery lifecycle to one turn-level delivery model

Move toward one broker-side lifecycle per Telegram turn that covers:
- pending turn
- running preview
- pending final
- completed / abandoned

The point is to reduce independent state bags for turns, previews, and final delivery that can drift apart.

### 3. Shrink `extension.ts` aggressively

Refactor policy out into focused modules such as:
- client session connection / stale-ownership policy
- client final handoff / retry-aware finalization
- broker session cleanup policy
- broker preview lifecycle / preview-store policy
- broker turn replay / route-rehome behavior

`extension.ts` should mostly instantiate dependencies and route events / IPC. It should not remain the primary place where lifecycle policy accumulates.

### 4. Eliminate or sharply narrow dual durability

Best-case cleanup direction:
- broker is the only durable owner of finals
- client may have an in-memory retry buffer, but not an open-ended second durable queue

If client durability must exist, its contract should be explicit and narrow:
- one ownership rule
- one claim/replay path
- one handoff direction
- no ambiguous shared responsibility with broker state

### 5. Make previews best-effort where possible

A simpler preview philosophy would be one of:
- purely best-effort previews that may disappear without harming correctness
- or shallow durable reuse that is explicitly abandoned when route ownership changes or state becomes ambiguous

Previews should not be allowed to drive correctness complexity around final delivery.

### 6. Unify disconnect/offline cleanup policy

Cleanup policy should be expressed in one place rather than scattered across:
- disconnect request processing
- offline timeout handling
- final completion behavior
- preview cleanup
- route cleanup
- route rehome behavior

A cleanup planner or equivalent shared policy module should decide:
- whether route is kept or removed
- whether preview refs are retained or cleared
- whether visible previews are deleted immediately or retried
- whether pending turns/finals are preserved
- when topic cleanup is queued

### 7. Make stale-connection handling absolute

Once a newer connection owns a session:
- old connection must not send previews, finals, turn consumption, or mirror updates
- old connection should stop heartbeating
- old connection should stand down and abort any live run it still owns
- broker should not attempt to merge new work from that superseded connection back into durable delivery state

This is a key simplification lever.

## Concrete cleanup / refactor plan worth exploring

### Phase 1: freeze feature patching in this area
Before adding more branchy fixes, stop and consolidate the model.

### Phase 2: write a small architecture note for this slice
Capture:
- who owns turns
- who owns finals
- who owns preview identity
- what happens on retry
- what happens on disconnect / offline timeout
- what happens on stale connection replacement
- what data is durable and who is allowed to mutate it

### Phase 3: refactor by ownership boundary
Potential module split:
- `src/client/session-connection.ts`
- `src/client/final-handoff.ts`
- `src/broker/session-cleanup.ts`
- `src/broker/turn-replay.ts`
- `src/broker/preview-store.ts`
- `src/broker/final-ledger.ts`

### Phase 4: simplify preview semantics
Reduce preview persistence/recovery obligations and make preview invalidation behavior more uniform.

### Phase 5: collapse durability toward the broker
Prefer broker-owned durable replayable final state and minimize client-owned durable recovery state.

## Things that still seem worth preserving from the current work

This note is not arguing for throwing away all recent changes. Several ideas from the current implementation seem sound and worth preserving through refactor:
- retry-aware deferral of transient assistant/provider `agent_end` failures
- rule that useful assistant text wins over low-context raw error metadata
- `/stop` support during deferred retry windows
- FIFO / retry-safe broker final delivery ledger
- strict distinction between Telegram formatting fallback vs generic transport failure

The refactor should keep these behavioral wins while simplifying how the system reaches them.

## Main architectural debt to track explicitly

The highest-value debt items to pay down are:
1. overgrown orchestrator logic in `src/extension.ts`
2. unclear / overlapping ownership of durable final state
3. preview lifecycle carrying too much correctness burden
4. session / connection ownership rules spread across too many paths
5. cleanup policy split across disconnect, offline, final-completion, and route-rehome logic

## Recommended planning follow-up

This should likely move into planning as a refactor / cleanup request rather than only remain an inbox observation. The next planning step should probably:
- decide whether this is an architectural refactor request, a scoped cleanup request, or a broader reliability-slice simplification effort
- define explicit non-goals so the cleanup does not balloon into a rewrite of all Telegram integration logic
- choose the target ownership model for durable turn/final state before more implementation work proceeds in this slice

## Bottom-line captured opinion

The current code is not best described as slop. It is better described as solid but strained. The risk is not low code quality in the ordinary sense; the risk is that continued patch-first evolution in this slice will turn careful reliability code into brittle workaround-heavy code. A consolidation/refactor pass soon could still recover a genuinely leaner, cleaner architecture.



## Human clarification on cleanup goal

Project-owner clarification on 2026-04-26: the main goal is simpler code, less duplication, less reimplementation of parallel almost-the-same features, and generally improved maintainability. Interpret this inbox item primarily as a maintainability and ownership-simplification request, not as a request to add broader reliability behavior or rewrite all Telegram integration logic.

Planning implication: prefer refactors that remove duplicate/parallel mechanisms, clarify one owner per lifecycle concern, and shrink `src/extension.ts` policy surface while preserving existing user-visible reliability requirements.
