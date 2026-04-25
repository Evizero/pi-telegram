# Native Scenario Planning Format

This reference describes how to think through user groups, scenario inputs, and jobs before running native UX tests. Good scenario planning produces better, more diverse test coverage.

## Why capture this first?

Without this context, test scenarios tend to cluster around the obvious happy path. Explicit user-group and scenario planning forces you to think about the full diversity of users and tasks, which surfaces UX issues that power-user testing misses.

## Native shape

```markdown
# [Product] UX Planning Notes

[1-2 sentence summary of what the product does.]

---

## 1. Execution surfaces

[If the product has multiple CLIs, surfaces, or access points, describe them here and how they relate. This helps scenario designers know which surface to test.]

---

## 2. User groups

For each distinct user type:

### 2.N [Group name]

Examples:
- [specific example person/role]
- [another example]

#### Common use cases
- [concrete task they'd do frequently]
- [another frequent task]

#### Uncommon but valuable use cases
- [something they'd do rarely but that really matters when they do]
```

In native `pln` mode, this material should end up in:

- `dev/USE.json` for canonical user-group and scenario records
- `dev/usability/sources/` for raw scenario notes or manual mapping provenance when needed

## What makes good user groups

**Diversity matters more than completeness.** Five genuinely different user types beat fifteen variations of the same power user.

Dimensions to vary across groups:
- **Domain expertise** — expert in the subject matter vs. newcomer
- **CLI comfort** — power user vs. "I just need this one thing"
- **Task frequency** — daily user vs. once-a-quarter
- **Task complexity** — quick lookup vs. multi-week project
- **Organizational role** — individual contributor vs. team lead vs. support function

Example from litrev (a literature review CLI):
- ML researchers (domain expert, CLI comfortable, frequent, complex tasks)
- PhD students entering a field (domain newcomer, moderate CLI, occasional, exploratory)
- Casual scholarly searchers (not domain-specific, low CLI investment, one-off, simple)
- Librarians (domain expert in search, high standards for reproducibility, moderate CLI)
- Systematic review teams (formal process, multi-step workflows, compliance needs)
- Drug discovery teams (specific domain vocabulary, extraction-heavy workflows)
- Research engineers (CLI power users, automation/scripting, JSON output consumers)

## What makes good scenarios within a group

**Concrete and goal-oriented.** Not "use the search command" but "find papers comparing treatment A vs treatment B for a hospital committee decision."

**Distinguish common from uncommon.** Common use cases should be frictionless. Uncommon-but-valuable use cases justify the tool's architecture — they're the reason it's not just a simple script.

**Include the user's language.** Write use cases in the words a real user would use, not the CLI's internal vocabulary. A clinician says "what's the evidence for this treatment" not "execute a provider-aware discovery query."

## Jobs to be done (cross-cutting)

After user groups, list the common jobs that span multiple groups:

```markdown
## 3. Common jobs-to-be-done

### 3.1 Quick lookup
- find a thing by ID, name, or identifier
- get details for a known item
- answer a yes/no factual question

### 3.2 Exploration
- understand the shape of a space
- find landmarks and important items
- learn what terms/vocabulary to use

### 3.3 Collection building
- gather items into a set
- organize by topic or criteria
- deduplicate across sources

### 3.4 Structured workflow
- apply criteria or rules to a set
- extract structured data
- generate a report or summary

### 3.5 Monitoring
- rerun a saved process
- detect changes since last run
- maintain a living/evolving collection
```

## Domain-specific examples

Include realistic prompts/intents that should feel natural:

```markdown
## 5. Domain-specific examples

### [Domain A]
- "What are the main recent directions in [topic]?"
- "Find papers by [author] on [subject]"
- "Extract [field1], [field2], and [field3] from the included papers"

### [Domain B]
- "What is the evidence for [intervention] in [population]?"
- "Compare [thing A] vs [thing B] across [dimension]"
```

## Maturity model

A useful addition is a simple maturity model showing how users progress:

```markdown
## 7. Maturity model

### Level 1: Quick task
"Help me do one thing."

### Level 2: Guided exploration
"Help me understand this space and refine my question."

### Level 3: Structured workflow
"Help me run a reproducible, auditable process."

### Level 4: Living operations
"Help me keep this current and comparable over time."
```

The key product question: can users move upward through these levels without restarting their work?

## How this informs native UX records

Each test scenario should map to:
- a specific user group
- a specific goal
- a maturity level

When creating native usability records, preserve that mapping directly in the scenario and user-group records rather than leaving it in a standalone side document.

Good test coverage means:
- At least 2-3 different user groups represented
- At least 2 different maturity levels
- Different parts of the CLI exercised (not all testing the same command)
- At least one scenario where the user hits a wall (tests error UX)
