# Requirements Writing Guide

Read this guide before writing or revising stakeholder requirements or system requirements.

This guide is written for `pln`'s actual planning model:
- intended purpose is prose in `dev/INTENDED_PURPOSE.md`
- inbox items are lightweight captured source material
- stakeholder requirements (`StRS`) are structured records managed through the CLI
- system requirements (`SyRS`) are structured records managed through the CLI
- tasks are markdown files with structured metadata and freeform body text

This is **not** a guide to writing a full standalone requirements specification document with every possible business-governance section. It keeps the formal discipline that is still useful in `pln` and removes the parts that do not map well to the product's current workflow.

This guide assumes the writer is not acting as a scribe. Good planning work sharpens vague input, preserves important source context, separates mixed layers, and refuses to hide contradictions behind polished but empty wording.

---

# 1. Requirement Layers in `pln`

A planning session should keep the layers clean.

## 1.1 Intended purpose

`dev/INTENDED_PURPOSE.md` answers:
- what the product is
- who it is for
- what problem it solves
- where it stops

This is the root of the traceability chain.

Use intended purpose when the product identity, scope boundary, or target user is still unclear.
Use intended purpose, not stakeholder requirements, when a clearly emphasized human directive is really defining what the product is, where it stops, or what enduring philosophy later work must preserve.
Use stakeholder requirements when that strong human direction expresses a stakeholder-visible need, preserved behavior, workflow expectation, or constraint the system must satisfy.

## 1.2 Inbox and other source material

Inbox items and other source material capture raw input such as:
- ideas
- bugs
- observations
- meeting notes
- user feedback
- legal or policy excerpts
- contradictory wants
- vague or abstract needs

Source material is often:
- incomplete
- contradictory
- over-specific in the wrong places
- under-specified in the important places
- not yet something the team wants to implement
- shaped like a draft spec, design note, or pseudo-requirement even though it is still just source material

That is fine. Source material exists so it can be interpreted and normalized later.
A spec-shaped inbox document is still source material until planning rewrites the coherent parts into the correct downstream artifacts.
If source material contains a clearly authoritative human directive whose exact wording would be costly to lose, capture that wording promptly as a reference even before the final normalized intended-purpose or requirement text is settled.

## 1.3 Stakeholder requirements (`StRS`)

Stakeholder requirements capture:
- what users, customers, operators, or the business need
- why it matters
- what outcome or capability would count as success from their perspective

Stakeholder requirements are **validated**.

They should be understandable to a stakeholder, not only to an implementer.

## 1.4 System requirements (`SyRS`)

System requirements capture:
- implementable system or software behavior derived from stakeholder requirements
- constraints and expected behavior the product must exhibit
- the concrete system layer that implementation work will target

In `pln`, `SyRS` is the implementable **system/software behavior** layer.
For software-only products, this often plays the role some organizations would call **software requirements**.

System requirements are **verified**.

## 1.5 Architecture and design

Architecture and design explain:
- how the system is organized
- which modules, services, interfaces, or patterns are used
- where responsibilities live

Architecture is not the same thing as a requirement.

## 1.6 Tasks

Tasks capture:
- planned implementation work
- concrete codebase targets
- execution notes and acceptance context

Tasks are below requirements in the chain.
A task should not need to invent its own upstream requirement rationale.

---

# 2. Formal vs Descriptive Content

Not every useful planning statement is a requirement.

## 2.1 Descriptive content

Descriptive content explains or preserves things such as:
- context
- background
- examples
- stakeholder descriptions
- source excerpts
- contradictions
- scope notes
- rationale around why a requirement might exist

Descriptive content is useful, but it is not itself a formal requirement record.

In `pln`, descriptive content usually belongs in:
- `dev/INTENDED_PURPOSE.md`
- inbox items
- cited source material
- task or inbox body markdown
- architecture prose

## 2.2 Formal requirement content

Formal requirement content states a binding need or behavior that should later be validated or verified.

Formal requirements should:
- use clear mandatory language such as `shall`
- live in the correct requirement layer
- be written so they can be checked later
- avoid carrying large amounts of explanatory prose inside the statement itself

In `pln`, formal requirement content belongs in:
- stakeholder requirement records (`StRS`)
- system requirement records (`SyRS`)

## 2.3 Mixed content

Some planning situations contain both descriptive and formal content.
For example:
- an inbox item may contain raw quotes plus a normalized requirement candidate
- a task body may contain rationale plus acceptance context
- a legal excerpt may be source material for a stakeholder requirement without being a stakeholder requirement verbatim

In these cases, preserve the distinction. Do not blur descriptive source material into a falsely polished requirement statement.

# 3. Working from Source Material

A planning agent often starts from imperfect source material rather than from a clean requirement.

## 3.1 Treat source material as input, not truth

An inbox item, transcript excerpt, support complaint, legal excerpt, or interview note may be:
- accurate but incomplete
- important but badly phrased
- useful even when contradictory with another source
- worth preserving even if the final requirement takes a different shape

Do not copy source material into a requirement mechanically.
Interpret it.

## 3.2 Normalize explicitly

When source material becomes a requirement, decide:
- what underlying need it reveals
- which stakeholder or user it belongs to
- whether it belongs in StRS, SyRS, architecture, or task planning
- which details are true requirements vs. incidental wording

If you leave out or normalize something important, be aware that you are making a judgment call.

## 3.3 Not every source item becomes a requirement

Some source items should remain:
- inbox items
- rejected ideas
- supporting rationale
- examples of stakeholder pain
- external context
- cited standards, legal text, or policy excerpts kept as source references rather than copied into requirement statements

A requirement should express the stable planning decision, not the whole messy path that led there.
Requirement records are the current baseline.
They should state the need or behavior the project now stands behind, as if that were the clean plan from the beginning.
Do not make the statement narrate pivots, concessions, or earlier mistaken assumptions.
Capture that history only when it helps interpret the current decision, using rationale, source links, captured references, deprecated records, or surrounding planning context.

When prior planning was wrong or incomplete, revise the requirement toward the current truth instead of layering exceptions around the old framing.

## 3.4 Contradictions are informative

Contradictory source material often signals one of these:
- different stakeholder groups have different needs
- the product scope boundary is unclear
- the problem is not well understood yet
- one source is describing a solution preference rather than a true need

Do not hide contradictions by writing a vague requirement that pleases nobody.

---

# 4. Requirement Attributes to Think About

A good requirement in `pln` may not expose every attribute through the current CLI in exactly the same way, but the planning judgment should still consider them.

## 4.1 Core conceptual attributes

For any requirement, think about:
- **identity** — what distinct requirement is this?
- **statement** — what is the requirement itself?
- **rationale** — why does it exist?
- **stakeholder or source basis** — whose need or which source material justifies it?
- **importance** — how important is it relative to other work?
- **method** — how will it be validated or verified?
- **criteria** — what would count as enough evidence?
- **status** — how mature is it?
- **traceability** — what is above and below it in the planning chain?

## 4.2 Layer-specific emphasis

For stakeholder requirements, place extra weight on:
- stakeholder linkage
- source basis
- validation method and criteria
- whether the requirement reflects real stakeholder-visible value

For system requirements, place extra weight on:
- upstream StRS IDs
- acceptance criteria
- verification method
- whether the requirement is concrete enough for implementation planning

## 4.3 Acceptance criteria should describe evidence

Acceptance criteria exist to guide validation or verification.
They should describe what evidence would count, not restate the requirement in different words.

If the criteria could be generated by rephrasing the statement, they are not adding value.

Weak (StRS):
- Statement: `Teams shall be able to trace project work from purpose through requirements to tasks.`
- Criteria: `Teams can trace project work from purpose through requirements to tasks.`

Stronger:
- Criteria: `Inspect the project records to confirm a reviewer can follow a legible chain from at least one intended-purpose concern through a stakeholder requirement, a derived system requirement, and an implementation task without the chain breaking or requiring external context to interpret.`

Weak (SyRS):
- Statement: `The system shall reject unknown stakeholder IDs.`
- Criteria: `Unknown stakeholder IDs are rejected.`

Stronger:
- Criteria: `Adding a requirement with a stakeholder ID absent from the registry fails with an actionable error naming the unknown ID.`

Good criteria often name concrete inputs, expected outputs, or observable conditions that a reviewer could check directly.

## 4.4 Companion metadata: label, origin, and source basis

`pln` requirement records now carry companion metadata that helps later planning, implementation, and review understand not just what the requirement says, but how resistant it is to ordinary change and what source basis supports it.

Think about these fields distinctly:
- **priority** — relative scheduling importance compared with other work
- **origin** — authority weight and change resistance
- **label** — ultra-condensed statement handle for compact inventories
- **sources.references** — validated captured verbatim source artifacts
- **sources.inbox** — validated inbox items preserved as planning input
- **sources.refs** — freeform external pointers or notes that are not inbox items and not captured references

Priority and authority are not the same thing.
A low-priority imposed requirement can still be harder to weaken than a high-priority derived requirement.

### Origin values

Use the four origin values deliberately:
- **imposed** — a human stakeholder or external authority stated this directly; treat it as non-negotiable in ordinary planning and preserve the governing basis clearly
- **derived** — the requirement was normalized or inferred from upstream needs or source material; this is the default
- **assumed** — the requirement depends on an unvalidated assumption about users, context, or operating conditions; make the assumption explicit
- **self-derived** — the requirement reflects a locally chosen practice with no clear upstream demand; scrutinize it for gold-plating risk

Origin, rationale, and sources each do a different job:
- origin records the machine-readable authority weight
- rationale explains why the requirement exists and why that authority matters
- sources preserve the upstream material or pointers that justify the requirement

When an imposed requirement is grounded in verbatim governing text, preserve that text as a captured reference and write the requirement statement as the normalized shall-language interpretation.
The captured reference preserves the exact words as informative interpretive basis; the intended-purpose or requirement statement remains the normative project record.
If you are creating the requirement through a CLI flow that already supports inline directive capture, such as `pln strs add --directive ...`, use that flow to preserve the governing text and citation metadata at creation time instead of planning to backfill the captured reference later.
Treat `pln hygiene` as a shipped diagnostic backstop for this provenance work: it already warns when imposed requirements are missing rationale or missing linked captured references, so unresolved provenance gaps should not stay invisible after authoring.
For derived requirements, the rationale should explain the derivation logic.
For assumed requirements, the rationale and criteria should make the assumption testable.
For self-derived requirements, the rationale should explain why the practice is necessary despite having no stronger upstream basis.

## 4.5 Stable semantic requirement IDs

Requirement IDs are stable semantic handles, not disposable sequence numbers.
For new `StRS` and `SyRS` records, choose the suffix explicitly and treat it as frozen after creation.

The model is:
- **ID** — stable identity handle such as `StRS-repo-cli-interface`
- **label** — editable compact reading aid
- **statement** — authoritative requirement text

Good semantic ID suffix rules:
- derive the suffix after the statement is finalized
- keep it short, legible, and distinct from nearby requirements
- preserve the main action, object, or constraint rather than every detail
- prefer semantic distinctness over extreme brevity
- avoid baking the family prefix into the suffix

Useful abbreviation examples:
- `repo`
- `cli`
- `ctx`
- `diag`
- `impl`
- `instr`
- `subdir`

Use examples such as repo, cli, ctx, diag, impl, instr, and subdir as style guidance rather than a whitelist.
These examples are style guidance, not a whitelist.
Shorten obvious technical words when the result stays immediately understandable.

When two suffix candidates collide, ask first whether the requirement should update an existing record rather than create a duplicate.
If the requirement is genuinely distinct, prefer semantic disambiguation over numeric suffixes.

Weak:
- `traceability`
- `cli`
- `repo-2`

Stronger:
- `trace-purpose-to-task`
- `cli-discovery-help`
- `repo-cli-interface`

## 4.6 Label writing rules

A good label is an ultra-condensed form of the statement, usually about 4-5 words.
It is not a title, topic, or category.

The test:
- a reader who has not just seen the requirement should be able to roughly reconstruct the statement from the label

Useful rules:
- derive the label after the statement text is finalized
- compress the statement rather than renaming it
- keep the verb or action visible
- keep the key object, outcome, or constraint visible
- use natural shorthand such as `reqs`, `repo`, or `CLI` when it preserves meaning
- do not start the label with `The system shall` or `Teams shall`

Bad labels:
- `Repository-versioned planning`
- `End-to-end traceability`
- `Command discoverability`

Stronger labels:
- `Keep planning versioned in repo`
- `Trace purpose through reqs to tasks`
- `Discover commands via help output`

## 4.7 Reference citation conventions

When you preserve a captured reference, fill the citation fields consistently enough that another reviewer can recognize and relocate the source.

Useful conventions:
- **EU regulations and directives**: authority like `EU MDR 2017/745`; section like `Annex I, GSPR 17.1`
- **International standards**: authority like `IEC 62304`; section like the standard's own clause hierarchy
- **Guidance documents**: authority should name the issuing body or document family; section should name the exact subsection when available
- **Internal directives or design guides**: authority should identify the directing person, team, or document; edition can capture revision or meeting/version context when useful

The captured reference should hold the exact words.
The requirement statement should hold the normalized requirement.
The rationale should explain the interpretation.
When inline directive capture is available in the CLI, treat it as the preferred path for imposed governing text because it keeps the requirement and its captured basis linked from the start.

# 5. Shared Rules for Writing Any Requirement

These rules apply to both stakeholder requirements and system requirements.

## 5.1 Characteristics of a well-formed requirement

A good requirement should be:
- **necessary** — it captures a real need, behavior, or constraint that matters
- **singular** — it states one coherent topic
- **unambiguous** — it should not require guesswork to interpret
- **feasible** — it should be realistic for the product and team
- **checkable** — it should admit validation or verification
- **traceable** — it should connect cleanly to its upstream and downstream context
- **complete enough for its layer** — it should contain enough information for its layer without pretending to be a lower or higher layer artifact
- **correct for its layer** — it should belong in StRS, SyRS, architecture, task planning, or source material for a defensible reason

These qualities are not decorations. They are a quick way to catch weak requirements before they enter the planning chain.

## 5.2 Basic syntax pattern

Many requirements become clearer if you think in terms of:
- **condition** — when or under what circumstances the requirement applies
- **subject** — who or what must do something
- **action** — what must be done
- **object or outcome** — what is acted on or what result is expected
- **constraint or criteria** — what limits, quality, or measurable expectation matters

Not every requirement needs every component written explicitly, but this pattern is a useful check when a statement feels muddy.

## 5.3 Use "shall" for mandatory requirements

Prefer one clear shall statement per requirement.

Good:
- `Researchers shall be able to trace each task to the system requirements it implements.`
- `The system shall reject unknown stakeholder requirement IDs when creating system requirements.`

Avoid weaker language when the item is intended to be binding:
- should
- may
- can
- supports
- handles efficiently
- is user-friendly

## 5.4 One topic per requirement

A requirement should state one coherent capability, constraint, or quality factor.

Split a requirement if it actually says:
- capability A and capability B
- normal behavior and exception behavior that should be checked independently
- multiple unrelated quality expectations

Merge only when the statements are inseparable and would be meaningless apart.

A common compound pattern at the system layer is a single statement that enumerates every behavior of a command family separated by commas or conjunctions.
If the statement reads like a feature list, it is almost certainly several requirements.
Each listed behavior that could be verified independently should be its own SyRS.

Bad:
- `The system shall support inbox list, show, update, reject, and archive operations with unique slug-prefix resolution, body replacement or append semantics, rejection reason recording, and archive eligibility enforcement.`

That is at least four independently verifiable behaviors in one statement.

Better as separate requirements:
- `The system shall resolve inbox items by unique slug prefix across live and archived locations.`
- `The system shall support body replacement and append semantics for inbox updates.`
- `The system shall record a rejection reason when an inbox item is rejected.`
- `The system shall enforce archive eligibility based on live inbox-task linkage.`

## 5.5 Be clear and unambiguous

A good requirement should not need a follow-up translation layer.

Avoid vague terms such as:
- appropriate
- sufficient
- efficient
- robust
- scalable
- intuitive
- flexible
- user-friendly
- fast

If you must describe quality, say what that quality means in observable terms.

## 5.6 Make it checkable

A requirement should be written so a later reviewer can ask:
- is this satisfied or not?
- how would we validate or verify it?
- what evidence would count?

That does not mean every requirement needs a number in the statement, but it does mean it should point toward a real evaluation path.

A common disguise is a statement that uses the capability pattern ("shall be able to") but describes an ongoing quality aspiration rather than a discrete capability or observable outcome.

Bad:
- `Teams shall be able to keep agent work anchored in product purpose throughout execution.`

"Anchored" is not something a stakeholder does or observes at a point in time.
This is a design goal, not a checkable requirement.

Better:
- `Coding agents shall re-read current product purpose and active task context before making planning decisions.`

If the aspiration is real but resists a single checkable statement, it may be a design goal that belongs in intended purpose while the concrete capabilities that serve it become separate requirements.

## 5.7 Keep terminology consistent

Use the same term to mean the same thing throughout the planning chain.

If the product says:
- stakeholder requirement
- system requirement
- task
- inbox item
- archive

then do not switch terms casually inside requirements unless the distinction matters.

When a term could be interpreted in more than one way, define or clarify it in the surrounding planning material instead of hoping the reader will infer the intended meaning.

Also distinguish:
- the **source author** of a note, quote, or law excerpt
- the **stakeholder** whose need is being represented

Those are often related, but they are not always the same thing.

## 5.8 Prefer active voice and direct language

Prefer direct active constructions when possible.

Good:
- `The system shall reject unknown stakeholder requirement IDs.`
- `Users shall be able to capture a raw idea quickly.`

Weaker:
- `It shall be possible for users to capture a raw idea quickly.`
- `Support for rejecting unknown stakeholder requirement IDs shall be provided.`

Active voice usually makes requirements shorter, clearer, and easier to test.

## 5.9 Do not hide design decisions in requirement wording

Requirements should not smuggle in architecture unless that architecture choice itself carries stakeholder-visible value or is a deliberate system-level constraint.

Bad examples:
- `The system shall use PostgreSQL for requirement storage.`
- `The platform shall call module X before module Y.`
- `The system shall use a microservice architecture.`

Those are usually design choices, not requirements.

## 5.10 Avoid negative requirements unless necessary

Prefer stating what the product, user, or system **shall do** rather than only what it shall not do.

Negative wording is sometimes necessary, especially for safety, integrity, or constraint statements, but use it carefully.
A purely negative requirement can hide the real expected behavior.

Better:
- `The system shall reject unknown stakeholder requirement IDs.`

Weaker:
- `The system shall not accept invalid IDs.`

If you do use negative wording, make sure the prohibited condition is precise and still leaves the expected behavior understandable.

## 5.11 Avoid duplication

Before writing a new requirement, check whether the idea is already captured by:
- an existing StRS
- an existing SyRS
- a refinement of an existing requirement

Revise a requirement when the new information sharpens or clarifies it.
Create a new requirement only when the need or behavior is meaningfully distinct.

## 5.12 Preserve traceability

Requirements should remain connected to:
- intended purpose above them
- source material when relevant
- downstream derived requirements or tasks

If a lower-layer artifact has no defensible upstream basis, the chain is weak.

## 5.13 Keep rationale out of the statement

The statement says what is required.
The rationale field says why.
That division matters for requirement evolution: the statement remains the clean current requirement, while rationale can explain why this requirement replaced, narrowed, rejected, or clarified an earlier idea.

If the statement contains editorial language, motivation, or justification, move that content to the rationale.

Bad:
- `Teams shall create requirements through the CLI instead of hand-editing fragile structured records.`

The word "fragile" and the "instead of" clause are rationale, not requirement.

Better:
- Statement: `Teams shall create requirements through the CLI.`
- Rationale: `Structured records are fragile under hand-editing; a CLI write path keeps metadata consistent.`

---

# 6. Stakeholder Requirements (`StRS`)

## 6.1 What a stakeholder requirement is

A stakeholder requirement expresses a stakeholder-visible need, outcome, or constraint.
It should answer some version of:
- what does this person or group need from the product?
- why does it matter?
- what successful outcome would they recognize?

Stakeholder requirements are not design notes.
They are not implementation steps.
They are not code tasks.

## 6.2 The core test

A draft is probably a stakeholder requirement if:
- it could be implemented in more than one technical way
- a stakeholder would understand and care about it directly
- it expresses value, outcome, or business/user need rather than design

If not, it may belong in SyRS, architecture, or task planning instead.

## 6.3 What belongs in StRS

Common good StRS content includes:
- user-visible capabilities
- business outcomes
- operator needs
- compliance expectations visible at stakeholder level
- usability expectations
- accessibility expectations
- context-of-use driven requirements
- service expectations stated from the stakeholder point of view

Examples:
- `Teams shall manage planning artifacts in git.`
- `Project leads shall be able to understand which implemented work satisfies which approved requirements.`
- `First-time users shall be able to discover the correct command surface through CLI help and normal trial-and-error.`
- `Users with low CLI familiarity shall be able to complete a basic capture-to-task workflow without reading source code.`

## 6.4 What does not belong in StRS

These usually belong elsewhere:
- database tables
- programming languages
- internal API shapes
- module boundaries
- framework choices
- exact call ordering between internal components
- deployment topology
- implementation-only test strategies

## 6.5 Stakeholder requirements are validated

Stakeholder requirements are about whether the requirement is the right one.
They should be **validated**, not verified.

Validation asks questions like:
- does this reflect a real stakeholder need?
- would stakeholders agree this requirement matters?
- would satisfying this requirement actually solve the stated problem?
- is the stated outcome meaningful in real use?

In the evolving `pln` model, think in terms of:
- validation method
- validation criteria

Use the current CLI surface to capture the closest available fields.
Always read current `--help` output rather than assuming exact field names from memory.

## 6.6 Strong StRS patterns

Good forms include:

### Outcome requirement
- `[Stakeholder] shall achieve [outcome] under [meaningful condition].`

Example:
- `Maintainers shall keep planning artifacts versioned with the code they govern.`

### Capability requirement
- `[Stakeholder] shall be able to [do something valuable] [under context or constraint].`

Example:
- `Planning agents shall be able to identify whether a proposed task already has upstream requirement coverage.`

### Quality-in-use requirement
- `[User group] shall be able to [task] with [effectiveness, efficiency, safety, accessibility, or confidence expectation].`

Example:
- `First-time users shall be able to discover the right command family for capture, planning, and implementation through command help and command names alone.`

### Compliance or trust requirement at stakeholder level
- `[Stakeholder or organization] shall [maintain/demonstrate/provide] [stakeholder-visible compliance or trust property].`

Example:
- `The organization shall preserve a traceable planning chain from intended purpose through implementation tasks.`

## 6.7 Technical approaches can sometimes belong in StRS

A technical approach can be part of a stakeholder requirement when the approach itself carries stakeholder-visible value.

Good examples:
- the technical choice is part of trust, compliance, or user experience
- the approach is part of the value proposition
- stakeholders would notice if that approach were absent

Examples:
- `Users shall benefit from AI-assisted review that reduces time spent on repetitive triage.`
- `Stakeholders shall be able to audit planning history directly in git.`

Ask: would the stakeholder notice or care if this specific technical approach were absent or replaced by a different one?
If yes, the approach is part of the stakeholder need.
If the stakeholder would be satisfied regardless of the mechanism, the mechanism belongs in SyRS.

Bad examples:
- `The system shall use SQLite.`
- `The product shall use Kubernetes.`
- `The app shall implement a React frontend.`

## 6.8 Usability, accessibility, and context of use belong here when they express stakeholder need

This matters for future usability-testing and should not be cut away.

Stakeholder requirements may legitimately cover:
- user tasks and goals
- context of use
- accessibility needs
- quality in use
- confidence, clarity, and recoverability in important workflows
- user-visible response expectations

Examples:
- `Occasional users shall be able to capture a raw idea without learning the full planning model first.`
- `Users shall be able to recover from entering the wrong command family by following help output and actionable error messages.`
- `Users shall be able to distinguish source capture from task creation without needing prior knowledge of the repository internals.`

## 6.9 Red flags for StRS

Revise if the draft:
- prescribes implementation instead of stakeholder outcome
- sounds like a task ticket
- names internal modules or storage mechanisms
- is so abstract that no one could tell whether it was satisfied
- bundles several unrelated needs together
- copies raw source wording without clarifying what the actual need is

---

# 7. System Requirements (`SyRS`)

## 7.1 Before writing SyRS

Before drafting or revising a system requirement, check:
- the upstream stakeholder requirement is real and stable enough to derive from
- you are writing implementable system/software behavior rather than architecture or task instructions
- you can name a plausible verification path
- you know which requirement families are relevant in this area and which are still only implicit in architecture, code, or older plan notes
- you know whether the requirement is mainly about functional behavior, interface behavior, data/input-output behavior, auth or security behavior, state or lifecycle behavior, failure/degraded behavior, operational behavior, or another category that still needs explicit coverage

You do not need a giant formal SyRS document for every change, but you do need enough discipline that downstream implementation and review are not guessing.

## 7.2 What a system requirement is

A system requirement expresses implementable system or software behavior derived from stakeholder requirements.
It should answer:
- what must the product do or enforce?
- what behavior must exist for the stakeholder requirement to be satisfied?
- what concrete system-level checks would prove it works?

In `pln`, SyRS is the middle layer between stakeholder needs and implementation tasks.

A single stakeholder requirement often derives several system requirements.
System requirements should be fine-grained enough that each one states one verifiable behavior.

For software-only products, SyRS may function as the effective software requirements baseline for implementation planning, verification, and reconstruction-grade planning.
Write them so that important runtime behavior is not left only in architecture prose, code, or legacy plan notes by accident.
If a future implementation could satisfy the current SyRS while still choosing a materially different auth/session model, interface contract, lifecycle model, failure behavior, or operator-facing runtime behavior, the requirement set is probably under-specified.

## 7.3 System requirements are verified

System requirements are about proving the product behaves as required.
They should be **verified**, not validated.

Verification asks questions like:
- does the system behave as specified?
- can this behavior be tested, analyzed, demonstrated, or inspected?
- is the expected behavior specific enough to implement and check?

## 7.4 What belongs in SyRS

Common good SyRS content includes:
- functional behavior
- traceability behavior
- interface behavior
- input/output and data-format behavior
- auth, identity, session, and security behavior
- privacy and secret-handling behavior
- state, lifecycle, and revocation behavior
- failure, degraded-mode, recovery, and fail-closed behavior
- persistence, retention, and data-definition behavior
- operational constraints at system level
- setup, install, upgrade, backup, and maintenance behavior when the system must provide it
- performance expectations that the system must meet
- usability-related system behavior
- observability, audit, and evidence-producing behavior
- maintenance or revalidation behavior when changes must trigger explicit checks
- imposed or regulatory behavior when applicable

Examples:
- `The system shall reject unknown stakeholder requirement IDs when creating system requirements.`
- `The system shall show downstream task trace context when displaying a stakeholder requirement.`
- `The system shall preserve structured requirement records through atomic file replacement.`

## 7.5 What does not belong in SyRS

These usually belong in architecture, design, or code:
- exact internal module sequencing
- chosen framework or library without requirement justification
- storage engine choice unless it is itself a real system constraint
- implementation-specific helper names
- detailed coding instructions

## 7.6 Strong SyRS patterns

### Functional behavior
- `The system shall [perform behavior] when [condition].`

Example:
- `The system shall warn when a system requirement traces to a deprecated stakeholder requirement.`

### Constraint or rule enforcement
- `The system shall prevent [invalid condition] by [observable behavior].`

Example:
- `The system shall prevent tasks from tracing to unknown system requirement IDs.`

### Interface behavior
- `The system shall expose [interface behavior] with [observable expectation].`

Example:
- `The system shall expose stakeholder requirement details in both human-readable and machine-readable output modes where supported.`

### Performance or operational behavior
- `The system shall [complete/respond/preserve] [behavior] within [checkable condition].`

Use numbers when they matter and are justified.

## 7.7 Common SyRS categories

A useful check is whether the requirement belongs to one of these concrete system/software categories:

- functional behavior
- interface and boundary behavior
- input/output and data-format behavior
- auth, identity, session, and security behavior
- privacy and secret-handling behavior
- state and lifecycle behavior
- failure, degraded-mode, recovery, and fail-closed behavior
- traceability behavior
- data integrity behavior
- operational behavior
- setup, installation, upgrade, backup, restore, or maintenance behavior
- performance behavior
- resource-limit behavior
- observability, audit, and evidence behavior
- usability-supporting system behavior
- maintenance, change-impact, and revalidation behavior
- imposed or regulatory behavior

This is not a mandatory taxonomy.
It is a thinking aid.
The goal is not to force one requirement into every category.
The goal is to make omission deliberate rather than accidental.

## 7.8 Requirement coverage sweep

A strong SyRS set is not only a collection of well-phrased individual requirements.
It is also a sufficiently complete map of the system behaviors that matter.

Before declaring an area done, deliberately sweep the requirement space and ask:
- which requirement families matter here?
- which of those families are already captured in SyRS?
- which are currently represented only in architecture prose, code, or old plan notes?
- which omissions are genuine non-applicability, and which are just questions no one asked yet?

This is especially important in systems with rich runtime contracts.
It is easy to write the interesting governance, trust, or domain concepts first and then stop before concrete interface, session, failure, persistence, or operational behavior is specified tightly enough.

Useful coverage questions include:
- **Functional behavior:** what must the system actually do in this area?
- **Interfaces and boundaries:** what behavior is required at API, protocol, CLI, UI, browser, vessel, service, storage, or external-system boundaries?
- **Inputs and outputs:** what formats, validation rules, transformations, or output guarantees matter?
- **Auth, identity, and session behavior:** how is trust established, continued, revoked, refreshed, or denied?
- **Privacy and secret handling:** what data or credentials must be protected, redacted, withheld, or scoped?
- **State and lifecycle:** what states exist, how do they transition, what expires, what can be resumed, and what must be revoked?
- **Failure and degraded behavior:** what happens when backends, sessions, providers, or dependencies fail or become unavailable, and what must fail closed?
- **Persistence and data definition:** what records, schemas, retention rules, or stored relationships must remain true?
- **Operational behavior:** what setup, install, upgrade, backup, restore, monitoring, or maintenance behavior matters to operators?
- **Usability-supporting behavior:** what system-visible behavior supports correct use, actionable diagnostics, or safe recovery?
- **Performance and resource behavior:** what timing, throughput, size, concurrency, or quota behavior matters?
- **Observability and evidence:** what logging, audit, trace, export, or evidence behavior is required?
- **Maintenance and revalidation:** when changes occur, what rechecks, migrations, or revalidation behavior must happen?
- **Imposed or regulatory behavior:** what behavior is required because an external authority, safety rule, or compliance basis demands it?

Coverage is about noticing absence.
If one of these areas matters and the current answer lives only in architecture prose, code, or a legacy planning note, that is usually a sign that new or refined SyRS may be needed.

Examples of coverage gaps that often hide in architecture or code:
- a web vessel is described as "session-mediated" but the chosen requirement-level behavior around code exchange, server-managed cookie session, revocation, and websocket trust establishment is never specified
- an approval flow is described architecturally, but the allowed state transitions, expiry, and operator-visible outcomes are not specified
- a backend integration exists, but the system's required behavior when that backend is unavailable or stale is only implied by the implementation
- an operator workflow depends on setup, backup, restore, or upgrade behavior that is never captured as explicit SyRS

## 7.9 Interface requirements are first-class SyRS

Interfaces are not secondary details. When a requirement is really about how the system exchanges information or behavior across a boundary, write it as an explicit system requirement.

Think about:
- who or what is on the other side of the interface
- direction of interaction
- expected inputs or outputs
- observable error handling
- security and performance expectations that matter at the interface boundary

You do not need a giant interface-control-document format in `pln`, but you do need to make interface behavior explicit when it matters.

## 7.10 Architecture invariants are not a substitute for SyRS

Architecture explains structure, decomposition, and chosen design.
It does not replace requirements-level behavioral coverage.

If a future implementation could satisfy the current SyRS while still making materially different choices about:
- interface contracts
- auth or session behavior
- state transitions or revocation semantics
- failure, degraded-mode, or fail-closed behavior
- persistence or data-definition behavior
- operator-facing runtime or maintenance behavior

then the requirements are probably under-specified.

Architecture may say that a vessel is higher-trust, a boundary is mediated, or a component owns a lifecycle concern.
SyRS should still capture the required behavior that makes those statements operationally meaningful.

Do not rely on architecture prose to carry essential runtime contracts by accident.

## 7.11 Usability-related SyRS are still valid SyRS

Usability is not only a stakeholder-level concern. Some usability-related expectations become concrete system behavior.

Examples:
- `The system shall print actionable error messages that name the missing or invalid reference IDs.`
- `The system shall provide `--help` output for each command family.`
- `The system shall preserve task body markdown when metadata-only updates are applied.`

The rule is: once the need becomes concrete system/software behavior, it belongs in SyRS.

## 7.12 Fields and supporting information

In the evolving `pln` model, SyRS should conceptually capture:
- statement
- source StRS IDs
- rationale
- acceptance criteria
- verification method

Linked planned verification coverage belongs in separate first-class verification-case artifacts linked to the SyRS, rather than as a field embedded inside the SyRS record itself.
Those linked verification-case artifacts are planning-only coverage records in this model, not recorded objective evidence and not human-set verification judgment.

Acceptance criteria should be concrete enough to guide implementation and review. Quantitative criteria are good when justified, but enumerated pass/fail conditions are also valid.

Legacy `verification.test_id` values may still appear in older repositories during migration, but they are not the target model for new planning work.

If a requirement is driven by safety, risk, compliance, or another special concern, preserve that basis in the rationale or surrounding planning artifacts even if `pln` does not yet model that concern as a first-class field.

Use the current CLI fields to express these.
Read current `--help` output before mutating records.

## 7.13 Red flags for SyRS

Revise if the draft says things like:
- support
- handle efficiently
- be user friendly
- use PostgreSQL
- call module X before Y
- use framework Z

Also revise if it:
- has no clear upstream StRS basis
- cannot be checked by test, analysis, demonstration, or inspection
- is really an implementation task rather than a requirement
- enumerates multiple independently verifiable behaviors in one statement
- looks polished in isolation while leaving important interface, session, failure, persistence, or operational behavior only in architecture or code

---

# 8. Validation and Verification Methods

These concepts matter enough to keep formal.

## 8.1 Stakeholder requirement validation methods

Stakeholder requirements are validated against real stakeholder need and intended use.
The exact field names exposed by the current CLI may evolve, but the concept should stay stable.

Useful validation methods include:

### Review
Validation through stakeholder, domain, product, or planning review.
Use when the rightness of the requirement is best confirmed through informed human review.

### Manual
Validation through observed use, human assessment, interview evidence, or qualitative review.
Use when a human evaluator can confirm that the requirement reflects real need.

### Summative
Validation through structured user or workflow evaluation.
Especially relevant for usability, quality in use, and end-to-end workflow success.
This matters for future UX-testing integration.

### Clinical
Validation through domain-specific evidence in regulated or evidence-heavy contexts.
Not specific to `pln`, but the concept is valid when stakeholder requirements derive from domain evidence rather than only product opinion.

### Automated
Validation through automated evidence when the thing being validated is still meaningfully stakeholder-facing.
Use carefully. Automation can support stakeholder validation, but it does not replace understanding the need.

## 8.2 System requirement verification methods

System requirements are verified through concrete evidence that the system behaves correctly.

### Test
Use controlled execution to prove the behavior.
Best for concrete system behavior and pass/fail checks.

### Analysis
Use reasoning, modeling, or structured examination of evidence when direct testing is not the best fit.

### Demonstration
Use observed execution with limited instrumentation to show that the behavior is present and useful.

### Inspection
Use careful examination of outputs, files, structures, or static properties.

## 8.3 Choose methods that fit the layer

A requirement method should match the kind of claim being made.

- StRS: is this the right need or outcome?
- SyRS: does the system actually do this?

Do not flatten these into the same mental model.

---

# 9. Traceability

Traceability is one of the main reasons `pln` exists.

## 9.1 Upward traceability

A healthy chain looks like:
- intended purpose anchors StRS
- StRS anchor SyRS
- SyRS anchor tasks

Source material may also inform StRS.
Not all source material needs to become a first-class traced object immediately, but the current storage model should remain intelligible:
- use `sources.references` for captured verbatim governing text
- check that any new semantic ID suffix is explicit, legible, distinct, and still appropriate after the statement is finalized
- use `sources.inbox` for preserved inbox material
- use `sources.refs` for freeform external pointers that are not yet captured artifacts, inbox items, or captured references
- do not duplicate the same inbox item in both `sources.inbox` and `sources.refs`, even if the ref text is a repo-local path like `dev/inbox/<slug>.md (...)`
- when the current CLI supports inline directive capture for an imposed requirement, prefer creating the captured reference during requirement creation instead of leaving the governing text uncaptured

## 9.2 Downward traceability

A strong requirement should make it plausible to derive:
- more concrete requirements beneath it
- implementation work beneath that
- review or evidence beneath that

If a requirement cannot guide any downstream work or judgment, it may be too vague.

## 9.3 Source traceability

When a stakeholder requirement comes from:
- inbox material
- legal text
- user feedback
- transcripts
- observations
- support evidence

preserve that connection conceptually even if the exact storage model is still evolving.

This helps answer:
- where did this requirement come from?
- which source was normalized into this requirement?
- what evidence or pain point justified it?

## 9.4 No orphaned lower-layer work

Avoid:
- SyRS with no defensible upstream StRS
- tasks with no defensible upstream SyRS unless explicitly temporary
- duplicate requirements created instead of updating an existing one

---

# 10. Practical Heuristics

Use these quick questions when stuck.

## 10.1 Is this StRS or SyRS?

Ask:
- Would a stakeholder understand and care about this directly?
- Could several technical designs satisfy it?
- Is this describing user/business value rather than internal behavior?

If yes, it is probably StRS.

Ask:
- Is this concrete system/software behavior?
- Would an implementer know more clearly what must be built?
- Could I imagine verifying it by test, analysis, demonstration, or inspection?

If yes, it is probably SyRS.

## 10.2 Is this actually architecture instead?

If the sentence mainly answers:
- which modules
- which framework
- which storage mechanism
- which internal call order
- which design pattern

then it is probably architecture or design, not a requirement.

## 10.3 Is this actually just source material?

If it is:
- contradictory
- emotional
- extremely rough
- quoted from an interview
- copied from a law or ticket
- still unresolved

it may belong in inbox or supporting context first, not directly in a polished requirement.

## 10.4 Split vs merge

Split when:
- two parts could pass or fail independently
- two different stakeholders care about different parts
- one clause is about behavior and the other about quality

Merge when:
- the parts only make sense together
- splitting would create fake precision or repetition

---

# 11. Quick Review Checklist

Before finalizing a requirement, ask:

## For any requirement
- [ ] Is this the right layer?
- [ ] Is it a real requirement rather than source material, architecture, or a task?
- [ ] Does it use clear shall language?
- [ ] Does it cover one coherent topic, not an enumerated feature list?
- [ ] Is it understandable without extra translation?
- [ ] Is it checkable?
- [ ] Does it avoid accidental implementation detail?
- [ ] Is the statement free of rationale, motivation, or editorial language?
- [ ] Does the semantic ID suffix read like a stable compressed handle rather than a random token, and was it derived after the statement was finalized?
- [ ] If the suffix uses abbreviations, are they still immediately understandable?
- [ ] If there was an ID collision risk, did the planner prefer semantic disambiguation over a reflexive numeric suffix?
- [ ] If a label is present, does it read like a compressed statement rather than a topic?
- [ ] Does the chosen origin match the rationale and source basis?
- [ ] If strong human direction is involved, was it placed at the right layer: intended purpose for identity or scope, stakeholder requirement for stakeholder-visible need or constraint?
- [ ] If a directive was judged authoritative, was its raw wording captured promptly rather than left only in chat, inbox prose, or task prose?
- [ ] If origin is imposed, does the requirement carry at least one captured reference preserving the governing basis?
- [ ] When verbatim governing text matters, is the source basis preserved with the right source field?
- [ ] Where exact source wording matters, is it being used as informative basis rather than replacing normalized normative requirement text?
- [ ] Do the acceptance criteria describe concrete evidence rather than rephrasing the statement?
- [ ] Does it duplicate existing requirements, or should an existing one be revised instead?

## For stakeholder requirements
- [ ] Does it express stakeholder-visible need, value, or outcome?
- [ ] Would a stakeholder recognize its importance directly?
- [ ] Is it framed for validation rather than verification?
- [ ] Does it preserve the important meaning of its source material?
- [ ] If a technical approach appears in the statement, would the stakeholder notice if that approach were replaced?
- [ ] If a technical approach appears with imposed origin, is it genuinely stakeholder-imposed rather than agent-recommended?
- [ ] If usability, accessibility, or context of use matters, is that visible here?

## For system requirements
- [ ] Does it derive from one or more real stakeholder requirements?
- [ ] Does it describe implementable system/software behavior?
- [ ] Does it state one verifiable behavior rather than listing a command family's features?
- [ ] Is it framed for verification rather than validation?
- [ ] Are acceptance expectations concrete enough to guide implementation and review?
- [ ] Does it stay out of architecture and coding-instruction territory?
- [ ] For the area in scope, were the relevant requirement families considered explicitly rather than only the most interesting behaviors?
- [ ] Does the current SyRS set leave important system behavior only in architecture, code, or old plan notes?
- [ ] If interface, auth/session, state/lifecycle, failure/degraded behavior, persistence, or operations matter here, are they visible in SyRS rather than only implied elsewhere?
- [ ] Could a fresh implementation satisfy these SyRS while still making materially different behavior choices that would change the product?
- [ ] Where a category is not covered, is that because it is genuinely not applicable rather than because no one asked the question?

---

# 12. Final Guidance

Use the lightest artifact that preserves the truth.

- If the idea is still raw, keep it as source material.
- If the stakeholder need is clear, write or revise StRS.
- If the system behavior is clear, write or revise SyRS.
- If implementation is concrete, create or revise a task.

Do not force everything into the lowest layer too early.
A clean planning chain comes from preserving the distinctions between source material, stakeholder needs, system behavior, architecture, and implementation work.
