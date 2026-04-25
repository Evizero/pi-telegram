# Task Writing Guide

Read this guide before drafting or substantially revising a task body.

This guide is written for `pln`'s task model:
- tasks are markdown-first artifacts under `dev/tasks/`
- frontmatter is CLI-owned
- the body is prose-first and should stay useful to humans and agents
- tasks can start lean, but they should become concrete enough to support implementation without forcing a fresh planning pass

This is not a rigid template and not a second requirements specification.
Its purpose is to help you write task bodies that are light when work is still emerging and explicit when work is ready to execute.

---

# 1. What a task is for

A task is the bridge from requirements to implementation.
It should make an implementation slice executable without forcing the implementation agent to rediscover the whole plan from scratch.

A good task is not just:
- a reminder that something should happen
- a copy of the upstream requirement text
- a code-tour transcript
- a mini architecture document
- a step-by-step script unless the work truly needs that level of prescription

A good task tells the next implementer what outcome matters, what boundaries matter, and how to tell whether the work is done.

---

# 2. Task maturity levels

Not every task needs the same depth.
Write the lightest task body that still preserves the truth.

## 2.1 Capture-level task

A capture-level task is acceptable when the work should not be lost but the exact implementation shape is still forming.
It should usually provide:
- a specific title
- a truthful objective
- known trace links when they exist
- enough context that the work will still be understandable later

This kind of task can stay lean.
It is not yet a promise that implementation can begin immediately.

## 2.2 Ready-to-implement task

A ready task should be concrete enough that an implementation agent can begin without silently re-planning the slice.
It should usually answer:
- what outcome is expected
- what behavior matters most
- what must remain true while implementing
- what is out of scope
- what code areas or interfaces are likely involved when that is already known
- how validation should work

If the task still requires first-pass scope discovery, requirement-conflict analysis, or basic boundary reconstruction, it is not ready enough yet.

## 2.3 Active task

An active task should stay truthful as implementation reality changes.
If discoveries change the scope, preserved behavior, likely code placement, or validation shape, update the task body and decisions rather than leaving the task frozen in an outdated earlier understanding.

## 2.4 Closeable task

A task approaching closure should let a reviewer understand what was attempted, what mattered, and why the work is ready to close.
Acceptance shape, key decisions, and any important tradeoffs should be visible without reconstructing them from code diffs alone.

---

# 3. What every good task should make clear

A strong task body usually makes these things clear when they matter:

## 3.1 Objective

State the expected outcome, not only the edits you expect someone to make.

Bad:
- `Edit diagnostics.py and add warnings.`

Better:
- `Make hygiene distinguish stale ready work from stale active work without changing unrelated diagnostics semantics.`

## 3.2 Preserved behavior

Say what must not regress.
This is often the difference between a useful task and a vague one.
Examples:
- existing command semantics remain stable
- archive behavior stays unchanged
- structured output shape stays backward-compatible
- nearby diagnostics remain unaffected

## 3.3 Nearby constraints and interactions

Carry forward the important constraints the implementation should not have to rediscover.
Examples:
- relevant traced requirements
- architectural boundaries
- neighboring requirements that could be affected
- known non-goals

If the task touches verification planning, carry forward whether linked verification cases are only planned-coverage records, where blocker or stale-link states must remain visible, and whether requirement status must stay a separate human judgment.

## 3.4 Codebase grounding

When the task is mature enough, point toward the real codebase.
Do not write a full code walkthrough.
Just give enough grounding that implementation can begin intelligently.
Examples:
- likely files or modules
- relevant command families
- helper layers that should own the change
- tests likely to change

## 3.5 Validation

State how the work should be checked.
Prefer concrete validation expectations over vague phrases like `add tests`.
Examples:
- targeted CLI tests
- bundled-skill validation script
- path-scoped regression tests

When verification planning is in scope, validation should explicitly check the distinction between planned coverage links, recorded objective evidence, and human-set verification judgment instead of assuming that linked cases alone prove the requirement.
- full suite only if the risk or breadth justifies it

## 3.6 Authority gaps and source basis

Do not leave clearly authoritative human directives stranded only in task prose.
If a user statement is really setting product identity, scope, stakeholder-visible behavior, or another enduring constraint, that authority belongs upstream in intended purpose or stakeholder requirements.

Tasks may still carry raw human wording when it helps implementation or later review understand the nuance behind the normalized project record.
When they do, frame that wording as informative basis, not as the authoritative destination of the rule.

If you discover that a task depends on a strong human directive that is not yet anchored upstream:
- call out the planning gap explicitly
- preserve the wording through the appropriate source-basis path
- hand the unresolved authority question back to planning instead of silently turning task prose into project doctrine

## 3.6 Non-goals

Tasks become much more useful when they say what they do not cover.
This helps prevent accidental scope creep.
Examples:
- do not add new lifecycle states
- do not redesign the task schema
- do not revise unrelated requirement records
- do not change archive semantics in this slice

---

# 4. Write outcomes, not implementation scripts

Tasks should normally describe what needs to become true, not prescribe every implementation step.
That keeps the task useful even if the codebase reveals a better local implementation approach.

Use implementation steps only when:
- the sequence really matters
- the user explicitly wants that level of prescription
- the slice is risky enough that execution order itself is part of the task truth

Even then, preserve the outcome, constraints, and non-goals so the task does not become a brittle checklist detached from intent.

---

# 5. Freshness matters

A task can be structurally valid and still be stale.
Do not treat old task prose as authoritative just because it exists in the repository.

Before implementation or when revisiting older work, check whether the task is still fresh against:
- the current intended purpose
- directly traced requirements
- architecture boundaries
- neighboring completed work
- current codebase reality

Signals that a task may need refresh include:
- the task body is still vague for the current phase
- the body still carries placeholder-style thinking
- nearby code or architecture moved since the task was written
- the task would force the implementation agent to redo basic scope discovery
- the task status says `ready` but the body still reads like early capture

If the direction is still right but the wording is stale, refresh the task body.
If the task exposes a larger planning gap, return to planning rather than silently improvising new scope in code.

---

# 6. Pre-edit impact previews

For cross-cutting or risky work, it is often useful to include or at least state a short pre-edit impact preview before broad edits begin.

A pre-edit impact preview is not required for every task.
Use it when it clarifies execution.
Keep it concise.

A useful preview may name:
- likely code touchpoints
- likely planning artifacts to update
- intended validation scope
- the main risks or unknowns

Example:
- Likely code touchpoints: `src/pln/bundled_skills/pln-plan/SKILL.md`, `src/pln/bundled_skills/pln-implement/SKILL.md`
- Likely planning touchpoints: task body refinement, maybe no architecture change
- Validation: bundled-skill validator plus targeted bundled-skill tests
- Main risk: adding ceremony instead of concise guidance

Use this to make blast radius visible, not to create a second task inside the task.

---

# 7. Optional sections that often help

You do not need a rigid template, but these sections are often useful when the task is mature enough to justify them:
- `## Objective`
- `## Scope`
- `## Codebase grounding`
- `## Acceptance Criteria`
- `## Out of Scope`
- `## Validation`
- `## Decisions`

Use sections because they clarify the task, not because a template told you to fill every box.

---

# 8. Common task-writing failure modes

Revise the task if it mostly does one of these:
- repeats upstream requirement text without implementation orientation
- says only what files to edit, not what outcome matters
- omits preserved behavior and non-goals where they matter
- strands authoritative human directives only in task prose
- is marked ready but still requires basic re-planning
- leaves important discoveries only in code diffs or commit messages
- becomes stale while the status still suggests it is current
- confuses architecture, requirements, and implementation notes into one blurry body

---

# 9. Review checklist

Before treating a task as ready or implementation-worthy, ask:
- [ ] Is the outcome clear?
- [ ] Does the task say what must remain true?
- [ ] Are important nearby constraints or interactions visible?
- [ ] Is the task grounded enough in the real codebase for its current maturity?
- [ ] Is validation concrete enough to guide implementation and review?
- [ ] Are non-goals explicit where scope could sprawl?
- [ ] If strong human direction matters here, is the authoritative record upstream rather than stranded only in the task?
- [ ] If raw human wording is included, is it clearly framed as informative basis rather than as replacement normative requirement text?
- [ ] Is the task fresh enough for the current codebase and planning state?
- [ ] If the work is cross-cutting or risky, would a short pre-edit impact preview help?

---

# 10. Final guidance

Write the lightest task body that preserves the truth.
But once a task is meant to guide implementation, it must do more than remind someone that work exists.
A good `pln` task helps an implementation agent start or resume work without silently reconstructing the entire slice from scratch.
