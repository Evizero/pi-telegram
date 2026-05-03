# Writing architecture in `pln`

Read this guide before creating or substantially revising architecture in a `pln` project.

This guide is opinionated.
It is not trying to teach generic enterprise-architecture paperwork.
It is trying to help humans and coding agents write architecture documents that are:

- downstream of intended purpose and requirements
- normative enough to guide future work
- grounded enough to stay truthful
- explicit about provenance, traceability, and quality goals
- useful inside a repository-centered, agent-first workflow

It draws on lessons from practical architecture work, ISO/IEC/IEEE 42010-style architecture descriptions, quality-attribute thinking, C4-style diagram discipline, and the strongest parts of Clean Architecture such as dependency direction and “the architecture should scream the product.”

It does **not** ask you to cargo-cult concentric circles, invent fake abstraction layers, or turn architecture into a second requirements spec.

---

# 1. What architecture is for in `pln`

Architecture in `pln` is the repository's **structural contract**.
It explains how justified behavior is organized, what boundaries matter, what invariants future work should preserve, and where important responsibilities live.
For agent-first implementation, the usual unit of architecture is an architecture-significant responsibility group, software item, subsystem, service, workflow family, or dependency boundary — not every function, class, private helper, or file.

A strong architecture document should help a human or agent answer questions like:

- What are the major architecture-significant responsibility groups or software items?
- What does each block own?
- What must not leak across those boundaries?
- What internal and external interfaces or data/control flows matter?
- What quality goals shape the design?
- What dependency direction is intended?
- What runtime flows matter most?
- What provenance and traceability links are architecturally important?
- What decisions were made, and what tradeoffs follow from them?
- Where in the repository does this architecture live concretely?

The document should make future change safer.
If it cannot help someone decide where a change belongs, what must remain true, and what would break if they violated a boundary, it is too weak.

---

# 2. The architecture should scream the product

This is one of the most important rules in this guide.

A good architecture document should make the product's conceptual structure obvious before it makes implementation tools obvious.
It should **scream the product**, not the tooling.

For `pln`, that means the architecture should scream things like:

- repository-local planning as the source of truth
- traceability from purpose to requirements to work
- provenance and authorship as preserved project memory
- deterministic CLI-owned structured artifact updates
- agent-guided workflows that reload planning context instead of drifting

It should **not** primarily scream things like:

- argparse
- JSON
- markdown
- symlink creation
- package resources
- file-copy mechanics

Those things matter.
But they are supporting mechanisms.
They are not the conceptual center of the system.

A useful test:

> If the architecture document would still make equal sense for some unrelated CLI that also uses argparse, JSON, and markdown, it is probably screaming tools instead of product.

---

# 3. Architecture is downstream

Architecture comes after:

1. `dev/INTENDED_PURPOSE.md`
2. relevant stakeholder requirements
3. relevant system requirements

That is not bureaucracy.
It is what prevents architecture from becoming a hidden product-definition document.

Architecture may introduce:

- decomposition choices
- module boundaries
- interface shapes
- dependency direction
- storage strategies
- runtime coordination patterns
- quality-driven tradeoffs
- migration structure

Architecture must **not** silently introduce:

- new stakeholder promises
- new product scope
- new system behavior that has no requirement basis
- implementation tasks disguised as architecture

Useful litmus test:

> If a sentence reads like a stakeholder promise or a formal system “shall” statement, it probably belongs in StRS or SyRS, not in architecture.

If the purpose or requirement basis is still weak:

- do **not** patch over the gap with architecture prose
- do **not** pretend a design preference is now a requirement
- do **not** bless a vague architecture draft just to keep momentum going

Instead:

- refine intended purpose
- refine StRS
- refine SyRS
- capture unresolved design thoughts in the inbox or task notes until the basis is real

---

# 4. Architecture is a normative design document

In `pln`, architecture should usually be written as a **normative design contract**, not as a passive retrospective description of whatever the code happens to do.

The live nominated main architecture document should describe the **current intended architecture**.
Resolved refactors should be folded into that current normative structure instead of preserved as ordinary history.
Git history, archived tasks, and decision records carry how the project got there; architecture carries the design contract future work should preserve or revise deliberately.

That does **not** mean you should ignore reality.
It means:

- use the codebase as evidence and constraint
- identify what the architecture is supposed to be
- notice where code and architecture differ
- make that divergence explicit instead of silently ratifying accidental structure

Good architecture writing says:

- what the system is expected to look like now
- what implementation already realizes that expectation
- where unresolved migration or debt still affects current implementation decisions

Bad architecture writing says:

- “here is whatever the code does today, therefore that must be the architecture”
- “here is a chronological refactor diary, therefore future work can infer the current architecture from it”

Use code to **ground** architecture.
Do not let accidental code shape define architecture by default.

---

# 5. Document mode is mandatory

Every architecture document should declare its mode.
Do not blend modes invisibly.

Use one or more of these, clearly labeled:

## 5.1 Architecture contract
The intended structural rules, ownership boundaries, invariants, dependency direction, and design decisions that future work is expected to preserve or revise deliberately.

## 5.2 Current-state clarification
A description of what already exists, used when the main goal is to make reality legible.
This is appropriate when the code is ahead of the docs and the team needs orientation before making deeper changes.

## 5.3 Migration architecture
Used when the current and desired structures both matter and the seam between them must be documented explicitly.
Migration and refactor notes should be rare, clearly labeled, and temporary: keep them only while an unresolved transition materially affects current implementation decisions.

## 5.4 Mixed mode
Sometimes a document must contain all three.
If so, separate them clearly.
Do **not** blur them into one voice.

Good:

- “Architecture contract” section
- “Implemented behavior” or “Current state” section
- “Migration notes” section

Bad:

- alternating between “the system is” and “the system should become” without saying which is which

This separation is not optional.
Mode ambiguity makes architecture misleading.

---

# 6. What architecture is — and is not

## 6.1 Architecture is

- the major structural decomposition of the system
- ownership boundaries
- dependency direction
- runtime coordination of important flows
- quality goals and the consequences they create
- provenance and traceability structure when those matter to review and operation
- key architectural decisions and their rationale
- explicit invariants
- risks, debt, and migration seams
- a map from architectural concepts to real code and repository locations

## 6.2 Architecture is not

- a feature list
- a stakeholder requirements document
- a system requirements document
- a task backlog
- an implementation diary
- a function-by-function walkthrough
- a roadmap wishlist
- a compliance theater document with no decision value

## 6.3 Common category mistakes

### Requirement disguised as architecture
Bad:
- “The system shall support JSON export for all planning artifacts.”

Better:
- architecture explains how output responsibilities are organized and what boundaries keep structured output consistent

Important nuance:
- if a future implementation could satisfy the current SyRS while still making materially different choices about interface contracts, auth or session behavior, state transitions, failure behavior, or operator-visible runtime behavior, the gap is usually missing requirement coverage rather than missing architecture prose

### Task disguised as architecture
Bad:
- “Next split diagnostics into three modules and add tests.”

Better:
- architecture explains the target module boundary and the migration seam; tasks carry the actual implementation work

### Code tour disguised as architecture
Bad:
- “A calls B, then B calls C, then C calls D...”

Better:
- explain the flow at the level needed to show participation, invariants, failure paths, and boundary consequences

### Tool-centric architecture
Bad:
- an architecture document centered on parser choice, serialization format, or package mechanics before explaining the product model

Better:
- explain the planning model, traceability model, provenance model, and ownership boundaries first; only then explain the supporting mechanisms

---

# 7. Voice and writing posture

The best architecture docs sound like they were written by someone who understands the system and is willing to make distinctions.

## 7.1 Declarative
Use direct statements.
Avoid fog words like:

- “leverages”
- “robust”
- “scalable”
- “clean”
- “designed to”

Those usually substitute attitude for information.

## 7.2 Specific
Name real modules, directories, boundaries, invariants, and concerns.
Say `src/pln/cli.py` when the actual file matters.
Say “ancestor project resolution within the current git subtree” when that is the real rule.

## 7.3 Honest
Do not hide debt.
Do not pretend migration seams do not exist.
Do not silently describe the architecture you wish you had if the implementation differs materially.

## 7.4 Bounded
State what the architecture does **not** do.
Boundaries are often more useful than positive descriptions.

---

# 8. Before you write

Before drafting or revising architecture, read:

1. `dev/INTENDED_PURPOSE.md`
2. relevant stakeholder requirements
3. relevant system requirements
4. the nominated main architecture document reported by `pln architecture show`; if that command is unavailable in an older checkout, use `dev/ARCHITECTURE.md`
5. relevant linked side architecture documents when the main document delegates detail to them
6. the relevant code paths, tests, tasks, and workflow assets

The nominated main architecture document should remain a substantive high-level architecture contract. It may link side architecture documents, but it should not degrade into a pure index. If you move or split architecture material, update the nomination with `pln architecture update --path <project-relative-file>` when the main document path changes.

Then answer these questions.

## 8.1 What is driving this architecture work?
Examples:

- the codebase needs explicit boundaries
- a new requirement family needs a design home
- repeated implementation drift shows missing architectural guidance
- a migration is underway and needs an explicit target shape
- the system is coherent but not legible yet

## 8.2 What concerns must this document answer?
Examples:

- traceability
- provenance
- determinism
- inspectability
- safety
- dependency direction
- ownership boundaries
- migration safety

## 8.3 What mode is this document in?
State whether it is contract, current-state clarification, migration architecture, or a clearly separated mix.

## 8.4 Does this belong in architecture at all?
If the content is primarily:

- product identity → intended purpose
- stakeholder need → StRS
- formal system behavior → SyRS
- implementation steps → task
- unresolved source material → inbox

then stop and write in the right place.

---

# 9. Architectural drivers must be explicit

Architecture without explicit drivers is just taste.

Every architecture document should name:

- the relevant purpose and requirement basis
- the most important stakeholder concerns
- the top quality goals shaping the design

Keep the list short.
If every concern is top priority, none of them are.

Examples of strong `pln`-style architectural drivers:

- deterministic artifact rewrites
- explicit traceability and provenance
- repo-native inspectability for humans and agents
- safe mutation of CLI-owned structure
- low runtime dependency footprint
- clear module ownership and limited cross-family coupling

---

# 10. Quality goals are mandatory

Do not leave quality goals implicit.
Name them.
Then connect architectural choices back to them.

Weak:
- maintainable
- scalable
- robust

Stronger:
- structured artifacts must be rewritten deterministically so diffs remain reviewable
- mutation flows must not leave partial structured writes behind
- repository state must remain inspectable by both humans and automations
- project resolution must behave consistently from nested working directories
- provenance links must be stored explicitly rather than reconstructed from prose

For most architecture docs, naming the top **3 to 6** quality goals is enough.

---

# 11. Use quality scenarios when a quality goal materially shapes the design

A quality scenario makes the architecture more concrete and reviewable.
Use a few strong ones rather than many weak ones.

Examples:

- When an agent runs `pln task update` from a nested subdirectory, the system should resolve the active project consistently and surface a notice if the mutation writes through an ancestor project.
- When a structured artifact is rewritten, the write path should preserve UTF-8 encoding, stable formatting, and atomic replacement so the resulting diff stays reviewable and the artifact is never left half-written.
- When diagnostics analyze project state, they should derive results from stored repository artifacts rather than from a hidden parallel cache, so trace and provenance analysis reflects what is actually versioned.

A good architecture document normally needs at least **one or two** scenarios if quality goals are doing real work.

---

# 12. Traceability and provenance are architectural when they matter to review and alignment

Many systems only need to document the requirement chain.
`pln` often needs more.

The guide should push you to think in terms of two related chains.

## 12.1 Primary requirement chain
Usually something like:

`INTENDED_PURPOSE.md` → StRS → SyRS → Git-backed archive memory

## 12.2 Provenance chain
This includes links such as:

- requirement source basis
- inbox-to-task lineage
- `source_inbox`
- `planned_as`
- authorship / attribution
- archived work memory
- decision history

If those relationships materially affect planning quality, reviewability, compliance, or agent alignment, they are **architectural**, not incidental metadata.

Do not hide them.
Document them explicitly.

---

# 13. Constraints, boundaries, and invariants

## 13.1 Constraints
A constraint is something the architecture must obey whether the team likes it or not.

Examples:

- runtime uses only the Python standard library
- structured records are CLI-owned
- the filesystem is the repository-local source of truth
- project resolution must work from ordinary subdirectories
- removed legacy schema fields are rejected rather than translated forward

## 13.2 Boundaries
Boundaries define what belongs where and what must not leak.
Examples:

- parser wiring belongs in `cli.py`
- command-family behavior belongs in `commands/`
- reusable low-level logic belongs in `core/`
- requirements justify behavior
- tasks carry implementation steps
- architecture explains structure and decisions

## 13.3 Invariants
A strong architecture document should name the small number of invariants future work must preserve.

Examples for `pln`-style systems:

- structured artifacts are mutated through CLI-owned paths
- traceability and provenance links are stored explicitly, not inferred from prose
- parser wiring stays centralized
- diagnostics analyze stored repository artifacts directly
- workflow guidance reinforces CLI-owned structure rather than replacing it

These are more useful than vague “principles.”
They tell future work what must remain true.

---

# 14. Decomposition and dependency direction

## 14.1 Describe meaningful building blocks
Prefer a few meaningful responsibility groups or software items over exhaustive file inventory.
The main decomposition section should answer:

- what each block owns
- what must not leak across the boundary
- what invariants it preserves
- what other blocks it may depend on
- what internal or external interfaces are architecture-significant
- what data, control, or lifecycle flows cross the boundary
- which repository paths realize the block or interface

You can keep a file map later in a repository-mapping section.
Do not let the main decomposition section become a repo tour.

## 14.2 Explain dependency direction
Do not just say “layered architecture.”
Explain what should depend on what, and why.

For `pln`, a useful way to think about this is:

- more inward / policy-like concerns:
  - planning model
  - lifecycle semantics
  - traceability and provenance rules
  - ownership boundaries
  - diagnostics semantics

- more outward / mechanism-like concerns:
  - CLI parsing
  - frontmatter rendering
  - file rewrite mechanics
  - packaged skill install plumbing
  - output formatting

Important nuance:

- repository-local files are not “just details” for `pln`; they are part of product identity
- but the specific mechanics of how those files are rendered, parsed, and copied are still more detail-like than the planning model itself

## 14.3 Allowed exceptions
If dependency exceptions exist, document when they are acceptable.
A good exception rule explains:

- why the exception exists
- what invariant it preserves
- why a more generic helper layer would be worse or less clear

## 14.4 Architecture-significant level of detail
Plan and document at the level that changes future implementation decisions.
For ordinary `pln` projects, that usually means responsibility groups, software items, subsystems, command families, workflow families, storage boundaries, important interfaces, runtime flows, dependency rules, and repository mapping.

Do **not** make architecture a mandatory function/class inventory.
Avoid exhaustive function, class, method, private-helper, or line-by-line design unless that detail is itself architecture-significant because it is safety-critical, interface-critical, generated from code, externally reviewed, or the only practical way to preserve a boundary.

Use concrete examples without dropping to noise:

- for a Flutter app, say whether the architecture uses BLoC, which BLoCs are architecture-significant, what each owns, how they communicate, and why that pattern was chosen
- for a CLI, say which command families own which artifact lifecycles, where parsing stops and command behavior begins, and which shared helpers preserve cross-cutting invariants
- for a data pipeline, say which stages own ingestion, normalization, validation, storage, and review, and which flows or failure paths must remain explicit

A future implementation agent should be able to learn the system's opinionated organization quickly, decide where a change belongs, and preserve important boundaries without first reverse-engineering every class or helper.

---

# 15. Runtime scenarios

Pick the few flows that matter architecturally.
Do **not** narrate every command.

A strong scenario usually answers:

- where it starts
- which major components participate
- what important checks or decisions happen
- what failure paths matter
- what artifacts or state are affected
- what architectural property the flow illustrates

Good candidates in `pln`-style systems:

- project resolution
- requirement mutation and validation
- inbox-to-task planning
- diagnostics over live repository state
- bundled skill installation and activation
- archive / close-out flow

---

# 16. Section types

Architecture documents often mix several kinds of content.
Keep them distinct so the reader does not have to guess what kind of claim is being made.

## 16.1 Contract content
This states the intended boundary, invariant, dependency rule, ownership rule, or architectural decision.
Read this as normative.

Use it for:

- structural boundaries
- dependency direction
- invariants
- quality goals
- architectural decisions

## 16.2 Descriptive or grounding content
This explains the system shape, participating components, or concrete repository mapping.
Use it to ground the architecture in reality without letting it become a code tour.

Use it for:

- building-block descriptions
- runtime scenarios
- repository mapping
- examples that make the contract easier to apply

## 16.3 Risk or migration content
This explains debt, instability, temporary exceptions, or transitions between architectural states.
It should be explicit and blunt.

Use it for:

- migration seams
- overloaded modules
- temporary exceptions
- unresolved tensions
- planned boundary changes not yet fully realized

Do not hide migration content inside contract prose.
Label it.
Remove or fold it into the current intended architecture once the transition is resolved.

---

# 17. Cross-cutting concepts

Use this section for concepts that constrain multiple building blocks.

Examples:

- deterministic writes
- identifier strategy
- structured output versus raw export
- narrow frontmatter parsing
- selective strictness around malformed artifacts
- alignment nudges
- provenance and authorship
- diagnostics based on stored relationships rather than prose inference
- risk-control placement when risk affects decomposition or interfaces
- SOUP dependency classes, trust/support assumptions, and external responsibility boundaries when SOUP governance is enabled

If a concept appears in multiple modules and affects how the whole system stays coherent, it probably belongs here.

## 17.1 Risk and SOUP boundaries
Architecture may summarize risk and SOUP concerns when they shape structure, interfaces, dependency direction, external assumptions, or review posture.
Keep that summary at architecture level.

Good architecture-level content:

- where risk controls are realized in the software structure
- which boundaries segregate safety-relevant behavior from less critical behavior
- which external or SOUP dependency classes are trusted, isolated, monitored, or replaceable
- what support, performance, availability, or update assumptions constrain safe operation
- links to the owning risk, SOUP, verification, or evidence artifacts when those artifacts exist

Do not duplicate detailed records owned elsewhere:

- detailed hazard, cause, mitigation, and use-error reasoning belongs in `pln risk` artifacts and risk workflow outputs when the project uses them
- detailed SOUP inventory, monitoring state, review requests, reviews, decisions, and evidence belong in `pln soup` artifacts and workflow outputs when SOUP governance is enabled
- verification-case state and objective evidence belong in the verification and evidence surfaces that own them

Architecture should explain why these concerns affect design and where they live structurally.
It should not become a second risk file, a second SOUP inventory, or a generated evidence bundle pasted into prose.

---

# 18. Decisions and rationale

Architecture should record real decisions, not slogans.

A good decision entry includes:

- **Context** — what tension or problem existed
- **Decision** — what was chosen
- **Why** — why this option was chosen over alternatives
- **Consequences** — what this enables, constrains, or makes more expensive later

Weak:
- “We use clean architecture.”

Stronger:
- explain the actual separation, the dependency direction it preserves, the product behavior it protects, and the tradeoff it creates

If the team uses ADRs, summarize and link them.
If not, the architecture doc itself can serve as the architecture-level decision record.

---

# 19. Migration notes and architectural pressure points

If the system is in transition, say so.
Do not hide that inside otherwise-normative prose.

Use this section for:

- migration seams
- known duplication
- overloaded modules
- temporary exceptions
- pressure points where the architecture is being stretched
- planned direction that is not yet fully realized

Keep these notes exceptional and temporary.
They are appropriate while unresolved transitions affect current implementation decisions.
Once the transition is complete, rewrite the live architecture as the current intended design and rely on Git history, archived tasks, and decision records for the historical path.

This is where the document becomes honest and trustworthy without becoming a refactor diary.

---

# 20. Repository mapping

A repository-native architecture document should end by helping the reader move from design to code.

Useful content:

- which paths implement each building block
- where changes usually belong
- where tests validate key behaviors
- which areas are central vs local details

The reader should be able to answer:

- where do I start?
- what must I preserve?
- what modules own this concern?

---

# 21. Diagrams

Diagrams are optional.
Bad diagrams are worse than no diagrams.

If you include one, it must have:

- a title
- a clear scope
- one abstraction level at a time
- named elements
- labeled relationships
- a legend if notation is not obvious

Good diagrams show:

- major building blocks
- dependency direction
- important runtime scenarios
- the architectural subject, not random implementation fragments

Do not create diagrams that require oral explanation to be meaningful.

---

# 22. Micro-examples

These short examples are meant to make the guide easier to apply in practice.

## 24.1 Product-screaming vs tool-screaming

Bad:
- “The architecture is based on argparse, markdown, JSON registries, and package resources.”

Better:
- “The architecture centers repository-local planning, explicit traceability, provenance, and deterministic CLI-owned artifact updates. Argparse, markdown, JSON, and packaged skill resources are supporting mechanisms that realize those concerns.”

## 24.2 Good provenance framing vs weak provenance framing

Weak:
- “Tasks trace to requirements.”

Better:
- “The planning model preserves both requirement traceability and provenance: requirements link to source basis, inbox-backed tasks record `source_inbox`, inbox items record `planned_as`, and authorship is preserved so later review can see both why work exists and where it came from.”

## 24.3 Good mode separation vs blurred mode separation

Blurred:
- “The system uses X, but should probably move to Y, and this boundary is stable.”

Better:
- **Architecture contract:** “Command parsing remains centralized in `cli.py`.”
- **Implemented behavior:** “The current parser already follows that rule.”
- **Migration note:** “If parser growth continues, helper extraction may be needed without changing ownership of the argparse tree.”

## 24.4 Good boundary statement vs implementation diary

Diary-like:
- “The command calls A, then B, then C, then rewrites the file.”

Better:
- “Mutation flows resolve project context first, validate supplied references, then delegate persistence to shared helpers that preserve deterministic formatting and atomic replacement.”

---

# 23. Anti-patterns

Avoid these repeatedly:

- writing architecture before relevant requirements exist
- using architecture to smuggle in scope changes
- writing architecture as an implementation diary
- writing architecture as a code tour
- writing architecture as a task plan
- listing tools and frameworks before the product structure is clear
- leaving quality goals implicit
- failing to label document mode
- documenting every helper while missing the major building blocks
- describing migration or debt as if it were already-settled architecture
- ignoring provenance when provenance is central to review and alignment

---

# 24. Validation checklist

Before finishing an architecture document, check all of these.

## 24.1 Downstream test
Can you point from the architecture back to intended purpose and relevant requirements?
If not, the architecture may be inventing behavior.
If an important runtime contract exists only in the architecture text and a materially different reimplementation could still satisfy the current SyRS, the requirement layer may still be under-specified.

## 24.2 Product-screaming test
Does the architecture scream the product model more than the implementation tools?
If not, it is centered on mechanism instead of purpose.

## 24.3 Mode test
Did you clearly label whether the document is contract, current-state clarification, migration architecture, or a separated mix?
If not, the document is misleading.

## 24.4 Quality-goal test
Did you name the few quality goals that actually shape the design?
If not, the design drivers are still implicit.

## 24.5 Quality-scenario test
Did you include one or more quality scenarios when quality goals materially shape the structure?
If not, the document may still be too abstract.

## 24.6 Provenance test
If review, quality, or agent alignment depends on source basis, lineage, authorship, or archive memory, did you document the provenance model explicitly?
If not, an important architectural concern is still hidden.

## 24.7 Boundary test
Can the document help someone decide where a change belongs and what must not be violated?
If not, the boundaries are too fuzzy.

## 24.8 Decision test
Are the important design choices and their rationale explicit?
If not, the document explains structure without explaining why.

## 24.9 Risk test
Did you call out meaningful debt, instability, migration seams, or pressure points?
If not, the architecture may be polished but not useful.

## 24.10 Repository-mapping test
Can a human or agent move from the architecture to real files and directories without guesswork?
If not, the document is not grounded enough for repo-native work.

---

# 25. Review questions

When reviewing architecture text, ask:

- What concern is this section answering?
- Is this architecture, or is it really purpose, requirement, task, or source material?
- Does this section scream product or tools?
- What quality goal does this design choice serve?
- What invariant is being protected?
- What would break if someone ignored this guidance?
- Is provenance documented where it matters?
- Is the document mode explicit?
- What risk or migration seam is still hidden?

---

# 26. Appendix A — Opt-in regulated or safety-relevant profile

If the product is regulated, safety-relevant, medically relevant, or likely to face formal design review, add a stricter regulated/safety-relevant profile to the architecture document.
This profile is **conditional**.
Do not impose IEC 62304-oriented ceremony, risk sections, or SOUP governance on ordinary projects that have not opted into higher rigor.
The ordinary architecture document should stay practical for agentic coding; the regulated profile adds review evidence only when the project's purpose, requirements, risk posture, or user direction justifies it.

## A1. Safety or compliance relevance
Identify:

- safety-relevant components, responsibility groups, subsystems, or software items
- compliance-relevant flows
- critical internal and external interfaces
- safety-relevant data/control flows and lifecycle states
- where risk controls are realized architecturally
- which external systems, services, libraries, or SOUP dependency classes affect safe operation

## A2. Software system and software-item decomposition
For IEC 62304-oriented review, include a view that makes software decomposition inspectable without becoming a full code inventory.
Name the software system, major software items, their responsibilities, relationships, and repository locations.
Where a lower-level software unit matters because it is safety-critical, interface-critical, separately reviewed, or generated from code, include it deliberately and say why that level is architecture-significant.

Do not pre-document every method or helper just to look rigorous.
A concise decomposition that exposes important boundaries is stronger than a stale class catalogue.

## A3. Traceability to requirements, risk controls, and SOUP assumptions
Make it easy to see:

- which requirements drive the architecture
- which software items realize risk controls
- where risk-control verification or validation evidence is expected to attach
- which SOUP dependencies or dependency classes are assumed, isolated, monitored, replaceable, or subject to project SOUP governance
- where architecture links to `pln risk`, `pln soup`, verification, or evidence records instead of duplicating those detailed records

If the architecture introduces linked verification-planning artifacts, also make explicit whether those artifacts are only planned coverage, where blocker or stale states are surfaced, and how they stay distinct from recorded evidence and human-set verification judgment.

## A4. Interface explicitness
For critical interfaces, document:

- direction
- responsibilities on each side
- data, control, and error flows
- failure behavior and fallback behavior
- important assumptions, trust boundaries, timing constraints, and support obligations
- external users, devices, systems, infrastructure, or products that participate in the interface

## A5. Mode separation matters even more
In regulated contexts, do not blur:

- what is architecture contract
- what is implemented behavior
- what is planned migration
- what is still manual or partially enforced
- what is review evidence versus what is planned future evidence

## A6. Architecture verification and review posture
The regulated profile should make it easy to answer:

- what are the major software items and why are they the right decomposition level?
- what are the critical interfaces and flows?
- where do risk controls live?
- what SOUP dependency assumptions constrain safe operation?
- what assumptions constrain safe operation?
- how will architecture consistency be verified or reviewed?
- how does the architecture connect to requirement, risk, SOUP, verification, and evidence structures?

This posture can be inspection-oriented.
It does not require inventing a new `pln` runtime command or evidence schema unless a separate planned task introduces that capability.

---

# Final rule

A great `pln` architecture document is not the one with the most sections.
It is the one that most clearly defines:

- how the product's structure realizes justified behavior
- what the architecture should scream
- what boundaries and invariants must be preserved
- what provenance and traceability links matter
- what quality goals shape the design
- where the architecture lives in the repository
- and what future work must revise deliberately rather than accidentally
