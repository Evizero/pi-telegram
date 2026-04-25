# Section-by-Section Writing Guide

Detailed guidance for writing each spec section. Reference this while drafting.

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [System Overview](#3-system-overview)
4. [Core Domain Model](#4-core-domain-model)
5. [Configuration Specification](#5-configuration-specification)
6. [State and Lifecycle](#6-state-and-lifecycle)
7. [Core Behavior](#7-core-behavior)
8. [Integration Contracts](#8-integration-contracts)
9. [Observability](#9-observability)
10. [Failure Model and Recovery](#10-failure-model-and-recovery)
11. [Security and Safety](#11-security-and-safety)
12. [Reference Algorithms](#12-reference-algorithms)
13. [Test and Validation Matrix](#13-test-and-validation-matrix)
14. [Implementation Checklist](#14-implementation-checklist)

---

## 1. Problem Statement

**Purpose:** Set the mental model before any details arrive.

**What to write:**
- 1-2 paragraphs on why this system needs to exist.
- What operational problems it solves (bullet list).
- Important boundaries — what this system is and is NOT responsible for.

**What to challenge the user on:**
- "Is this actually a problem worth solving with new software, or can you use an existing tool?"
- "Who experiences this problem? How often?"

**Pattern:** State the boundary early. Example: "Symphony is a scheduler/runner and tracker reader.
Ticket writes are performed by the coding agent."

---

## 2. Goals and Non-Goals

**Purpose:** Prevent scope creep before implementation starts.

**Goals should be:**
- Concrete and testable (not "be fast" but "respond within 100ms for cached queries")
- Prioritized or at least ordered by importance
- Achievable in the current version

**Non-goals should be:**
- Things someone might reasonably expect this system to do
- Things the user mentioned but that belong in a future version
- Architectural patterns you're explicitly avoiding

**What to challenge the user on:**
- For every goal: "Is this required for v1 or is it a nice-to-have?"
- For missing non-goals: "What about X? I could see someone assuming this system does X."
- "Are you sure you don't need [common feature in this domain]? If not, say so explicitly."

---

## 3. System Overview

**Purpose:** Name all components and their relationships before diving into details.

**Structure:**
- **Main Components** — Numbered list. Each component gets a name, 1-2 line description, and its
  responsibility boundary. Use the same names consistently throughout the entire spec.
- **Abstraction Layers** — How the system is organized vertically. This tells an implementing agent
  how to structure modules/packages.
- **External Dependencies** — Everything outside the system boundary. APIs, filesystems, executables,
  auth providers.

**What to challenge the user on:**
- "Is component X really separate from Y, or are they the same thing with two names?"
- "What happens if external dependency Z is unavailable?"

---

## 4. Core Domain Model

**Purpose:** Define every entity before describing any behavior. An agent builds types first.

**Two categories of entities — include both:**

1. **Business domain entities** — The things the system operates on (issues, users, messages, etc.)
2. **Runtime state structures** — The internal state the system maintains while running (scheduler
   state, session metadata, retry queues, aggregate counters). These are just as important as
   business entities — they define the data structures the implementing agent must build.

**For each entity, specify:**
- Entity name (as a subsection header, e.g., `#### 4.1.3 Service Config`)
- Every field using the standard field format (see below)
- Nullability rules
- Derived fields and how they're computed

**Standard field format** — Use this consistently for every field in every entity:

```markdown
#### 4.1.5 Run Attempt

One execution attempt for one issue.

Fields (logical):

- `issue_id`
- `issue_identifier`
- `attempt` (integer or null, `null` for first run, `>=1` for retries/continuation)
- `workspace_path`
- `started_at`
- `status`
- `error` (optional)
```

For config fields with more metadata, use the nested bullet format:

```markdown
- `turn_timeout_ms` (integer)
  - Default: `3600000` (1 hour)
- `stall_timeout_ms` (integer)
  - Default: `300000` (5 minutes)
  - If `<= 0`, stall detection is disabled.
```

**After entities, specify:**
- **Stable Identifiers** — Which fields are used as map keys, log context, human display
- **Normalization Rules** — Every string comparison, derivation, or transformation as an explicit
  algorithm. "Compare after trim + lowercase." "Replace characters not in [A-Za-z0-9._-] with _."

**What to challenge the user on:**
- "You mentioned X has a 'status' — what are the possible values?"
- "Is this field ever null? When?"
- "How do you compare these two values — case-sensitive? trimmed?"
- "What's the unique key for this entity?"
- "What state does the system track at runtime? What's in the scheduler's state bag?"
- "What metadata do you need for debugging a live session?"

---

## 5. Configuration Specification

**Purpose:** Every knob the system exposes, with no ambiguity about defaults or validation.

**For each config field, state ALL of these inline:**
- Field path (e.g., `tracker.api_key`)
- Type
- Default value
- Validation rules
- Whether changes require restart or apply dynamically
- Environment variable indirection rules (if applicable)

**Include:**
- **Source Precedence** — Where config comes from and in what priority order.
- **Dynamic Reload Semantics** — What happens when config changes at runtime. Which fields are
  hot-reloadable? What happens on invalid reload?
- **Dispatch/Startup Validation** — What's checked before the system starts accepting work.
- **Cheat Sheet** — A flat summary table of all config fields. Label it "intentionally redundant."
  This exists because agents read sections in isolation.

**What to challenge the user on:**
- "What's the default for X?" (if they haven't said)
- "What happens if someone sets X to a negative number? Zero? Empty string?"
- "Does changing X take effect immediately or require restart?"

---

## 6. State and Lifecycle

**Purpose:** Make every state explicit. Implied states are implemented wrong.

**For stateful components:**
- **State Enum** — List every possible state with a description.
- **Lifecycle Phases** — Ordered list of phases an entity passes through.
- **Transition Triggers** — What causes each state change. List every trigger.
- **Transition Rules** — For each trigger, what state changes happen and what side effects occur.

**Important:** Distinguish between different state domains. Example: "Issue Orchestration States"
(internal claim states) vs "Tracker States" (external issue states like Todo, In Progress). These
are different things and must not be conflated.

**What to challenge the user on:**
- "You said it goes from A to B — can it ever go back to A?"
- "What state is it in between X and Y? Is there a preparing/initializing phase?"
- "Can this be in two states at once? What about race conditions?"

---

## 7. Core Behavior

**Purpose:** The main behavioral contracts. This is usually the largest section.

**Organize by subsystem or major flow.** Each subsection should cover:
- The algorithm or process (step by step)
- Preconditions and postconditions
- Error handling at each step
- Concurrency rules if applicable

**Common subsections (adapt to the system's domain):**

For a daemon/scheduler: main loop, candidate selection, dispatch, retry/backoff, reconciliation.
For a request handler: routing, validation, processing pipeline, response construction.
For a CLI tool: argument parsing, execution phases, output formatting.
For a data pipeline: ingestion, transformation stages, output/sink, checkpointing.
For a library/SDK: public API contract, lifecycle management, resource cleanup.

The right decomposition follows the system's natural flow — don't force a scheduler shape onto a
request handler.

**What to challenge the user on:**
- "What order do these steps happen in? Does order matter?"
- "What happens if step 3 fails — do you undo steps 1 and 2?"
- "How many of these can run concurrently? What's the limit?"
- "You said 'retry on failure' — how many times? What backoff? What's the max?"

---

## 8. Integration Contracts

**Purpose:** Exact protocol for interacting with external systems. This is often the largest
section in the spec — in a well-specified system it can exceed 1,000 words per integration.

**Give each integration its own subsection** (e.g., 8.1 Agent Runner, 8.2 Issue Tracker). For each:

- **Launch / Connection Contract** — How the integration is started. Command, auth, transport.
- **Required Operations** — What API calls / messages the system must support.
- **Protocol Sequence** — Step-by-step message ordering with actual JSON transcripts. Not
  descriptions of messages — the literal payloads. Label as illustrative where appropriate.
- **Streaming / Event Handling** — If the protocol is streaming, specify completion conditions,
  line framing, buffering rules, and how stdout/stderr are separated.
- **Approval / Policy Handling** — How the system responds to approval requests, tool calls,
  user-input-required signals. Document the implementation's policy choice.
- **Normalization** — How external data maps to the domain model.
- **Timeouts** — Name and specify every timeout with defaults.
- **Error Categories** — Named error types for every failure mode.
- **Error Mapping** — How raw errors map to the normalized error categories.

**Start with a compatibility profile** that sets expectations for strictness:

```markdown
Compatibility profile:
- The normative contract is message ordering, required behaviors, and logical fields.
- Exact JSON field names may vary across compatible versions.
- Implementations should tolerate equivalent payload shapes.
```

**What to challenge the user on:**
- "Walk me through the exact message sequence — what's sent first, what's the response?"
- "What happens if the remote side sends something unexpected?"
- "What's the pagination model? What's the page size?"
- "What timeout is appropriate for this API call?"
- "How does the system handle approval/confirmation requests — auto-approve, fail, surface?"

---

## 9. Observability

**Purpose:** How operators see what the system is doing. This section is often surprisingly large
(~1,000 words in well-specified systems) because it covers logging, metrics, dashboards, and APIs.

**Subsections to cover:**

- **Logging Conventions** — Required context fields for structured logs (e.g., `issue_id`,
  `session_id`). Message formatting rules. What to log at each level.
- **Runtime Snapshot / Monitoring** — If the system exposes its state for monitoring, specify the
  shape. What fields are in a snapshot? What error modes does the snapshot API have?
- **Metrics and Accounting** — Token usage rules, runtime accounting, rate-limit tracking. Be
  specific about what's cumulative vs per-session, absolute vs delta.
- **Optional Status Surfaces** — Dashboard, TUI, HTTP API. If optional, say so. If the system has
  an API, spec it fully:
  - Every endpoint with method, path, and purpose
  - JSON response schemas (show the actual shape, not just descriptions)
  - Error response format
  - Design notes (read-only except for operational triggers, etc.)
- **Humanized Summaries** — If raw events are summarized for humans, specify that they're
  observability-only and must not affect orchestrator logic.

**What to challenge the user on:**
- "What does an operator need to see to debug a stuck session?"
- "How do you know if the system is healthy without looking at code?"
- "If you add an API, what endpoints do you actually need? Don't over-spec."

---

## 10. Failure Model and Recovery

**Purpose:** Every failure mode named, categorized, and assigned a recovery behavior.

**Structure:**
- **Failure Classes** — Numbered categories (Config, Workspace, Session, Network, Observability).
  Under each, list specific failure modes.
- **Recovery Behavior** — For each class, what the system does. Be specific: "skip dispatch for
  this tick" not "handle gracefully."
- **Partial State Recovery** — What happens on restart. What state is lost? How does the system
  recover without persistent storage (if applicable)?
- **Operator Intervention Points** — How a human can fix things without touching code.

**What to challenge the user on:**
- "You listed 3 failure modes — I can think of 2 more. What about X and Y?"
- "You said 'retry' — but what if it keeps failing? Is there a circuit breaker?"
- "After a restart, how does the system know what was running before?"

---

## 11. Security and Safety

**Purpose:** Explicit trust boundaries and invariants.

**Include:**
- **Trust Boundary** — What's trusted, what's not. Is input from users/APIs/files trusted?
- **Safety Invariants** — The non-negotiable rules. Number them. Label the most critical one.
  Example: "Invariant 1: Agent runs only inside the per-issue workspace path."
- **Secret Handling** — How secrets flow through the system. What's logged, what's not.
- **Hardening Guidance** — For implementors who want to go further.

**What to challenge the user on:**
- "What if someone puts malicious content in [external input]?"
- "Can this secret accidentally appear in logs?"
- "What's the blast radius if this component is compromised?"

---

## 12. Reference Algorithms

**Purpose:** Bridge between spec prose and real code. Pseudocode precise enough to transliterate.

**Pseudocode style guide — use this format consistently:**

```text
function start_service():
  configure_logging()

  state = {
    poll_interval_ms: get_config_poll_interval_ms(),
    running: {},
    claimed: set(),
    retry_attempts: {}
  }

  validation = validate_dispatch_config()
  if validation is not ok:
    log_validation_error(validation)
    fail_startup(validation)

  startup_cleanup()
  schedule_tick(delay_ms=0)
  event_loop(state)
```

**Style rules:**
- `function name(params):` declarations
- State is passed explicitly and returned: `state = do_thing(state)`
- Inline error handling: `if X failed:` → immediate consequence
- Use exact field names from the domain model (section 4)
- Cross-reference between algorithms: `dispatch_issue()` called from `on_tick()`
- Show the data being set on state objects (exact field assignments)
- Standard control flow: `for X in Y:`, `while true:`, `if/else`, `break`
- No language-specific constructs (no `async/await`, no `try/catch`, no generics)

**Cover at minimum one algorithm for each core flow in the system.**

For a daemon/scheduler (the Symphony exemplar covers all of these):
- Service startup (config validation, cleanup, scheduling)
- Main loop / tick (reconcile, validate, fetch, sort, dispatch)
- Dispatch one item (spawn worker, initialize state entry, claim)
- Worker/task lifecycle (workspace setup, prompt building, execution loop, cleanup)
- Exit handling (update totals, schedule retry or release)
- Retry timer handling (re-fetch, re-check eligibility, dispatch or release)

For other system types, find the equivalent set:
- Request handler: request lifecycle, middleware chain, error response construction.
- CLI tool: argument resolution, main execution, output/reporting.
- Data pipeline: ingestion loop, transform stage, checkpoint/recovery.

The goal: someone reading just the algorithms section should be able to implement the core system,
referring back to earlier sections only for entity definitions and config details.

---

## 13. Test and Validation Matrix

**Purpose:** Every behavioral requirement restated as a testable assertion. An agent generates
test cases directly from these bullets. This section is often ~1,000 words because it covers
every meaningful behavior, including edge cases.

**Structure by conformance level:**
- **Core Conformance** — Required for all implementations.
- **Extension Conformance** — Required only if the optional feature is shipped.
- **Real Integration Profile** — Environment-dependent checks.

**Group by subsystem** (matching earlier sections). Each bullet is one testable assertion.

**Rules for writing assertions:**
- Each bullet must be independently testable
- Be concrete and specific — name the exact values, states, and outcomes

**Calibration examples — right level of specificity:**

```markdown
### Config and Parsing
- Missing workflow file returns typed error
- `tracker.api_key` works (including `$VAR` indirection)
- Per-state concurrency override map normalizes state names and ignores invalid values

### Dispatch and Reconciliation
- `Todo` issue with non-terminal blockers is not eligible
- `Todo` issue with terminal blockers is eligible
- Normal worker exit schedules a short continuation retry (attempt 1)
- Retry backoff cap uses configured `agent.max_retry_backoff_ms`
- Slot exhaustion requeues retries with explicit error reason

### Protocol Client
- Partial JSON lines are buffered until newline
- Non-JSON stderr lines are logged but do not crash parsing
- Unsupported dynamic tool calls are rejected without stalling the session
- If optional `linear_graphql` tool is implemented: valid inputs execute against configured auth
```

Not: "Retries work correctly" or "Config parsing is robust"

**Include edge cases, not just happy paths.** For every feature, ask: what's the weird case?

---

## 14. Implementation Checklist

**Purpose:** Definition of done. The agent checks boxes when it's finished.

**Organize by conformance level** (matching section 13).

This section is intentionally redundant with the test matrix. The test matrix says "verify X works."
The checklist says "X is implemented." Same information, different frame — one for testing, one for
tracking completion. Explain this to the implementing agent:

```markdown
This section is intentionally redundant with the test matrix so an implementing agent can track
completion independently of test authoring.
```

**Include:**
- Required for Conformance (must-ship)
- Recommended Extensions (ship if chosen)
- Operational Validation (pre-production checks)
- Future Work / TODOs (explicitly deferred items with brief rationale)
