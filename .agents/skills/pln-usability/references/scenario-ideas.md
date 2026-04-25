# Scenario Design Guide

How to design diverse, useful test scenarios for any CLI. Includes a concrete example matrix from the litrev project.

## Dimensions to vary

Every scenario is defined by three choices:

1. **Persona** — who is using the CLI, what do they already know
2. **Goal** — what concrete task are they trying to accomplish
3. **Depth** — how far through the CLI's capability surface does the task go

Good coverage means varying all three, not just one.

## Depth categories

| Depth | Description | Example |
|---|---|---|
| Quick | One or two commands, ephemeral, no project state | "Look up a thing and print details" |
| Medium | 3-5 commands, may create state but not a full workflow | "Search, collect, organize" |
| Deep | Full multi-step workflow, stateful, multiple artifacts | "Plan, execute, screen, extract, report" |
| Specialist | Uses niche features (graph, monitoring, scripting) | "Track changes over time, consume JSON output" |

## Persona archetypes (adapt to your CLI's domain)

| Archetype | CLI comfort | Domain expertise | Task style |
|---|---|---|---|
| Power user | High | High | Complex workflows, scripting |
| Domain expert, CLI newcomer | Low | High | Knows what they want, unsure how to ask |
| Technical generalist | High | Low | Comfortable with CLIs but new to this domain |
| Occasional user | Low | Low | Just needs one thing, won't read docs |
| Integrator / scripter | High | Medium | Wants JSON output, automation, pipelines |
| Evaluator | Medium | Medium | Trying to decide whether to adopt the tool |

## Example: litrev scenario matrix

litrev has three CLI surfaces: `litrev` (main workflow), `litrev-pubmed`, `litrev-arxiv`, `litrev-semantic-scholar`.

### Quick (discovery-focused)

| Persona | Goal | CLI | Provider |
|---|---|---|---|
| Curious software engineer | Find 3-5 papers on a topic, read abstracts | `litrev` | Any |
| Science journalist | Identify top authors in a hot area | `litrev` | S2 |
| PhD student entering a field | Find landmark papers and main threads | `litrev` | PubMed + S2 |

### Medium (corpus-building)

| Persona | Goal | CLI | Provider |
|---|---|---|---|
| ML researcher | Build a reading corpus of evaluation papers | `litrev` | arXiv + S2 |
| Clinician preparing journal club | Collect 10-15 papers on a treatment | `litrev` | PubMed |
| Librarian | Design and compare two query formulations | `litrev` | PubMed |

### Deep (full review workflow)

| Persona | Goal | CLI | Provider |
|---|---|---|---|
| Evidence synthesis team | Mini systematic review on a clinical question | `litrev` | PubMed |
| Medical informaticist | Extract structured prevalence data | `litrev` | PubMed |
| HTA analyst | Evidence table comparing two interventions | `litrev` | PubMed |

### Specialist

| Persona | Goal | CLI | Provider |
|---|---|---|---|
| Pharmacovigilance reviewer | Search for adverse event case reports | `litrev` | PubMed |
| Research engineer | Script a reproducible search, consume JSON | `litrev` | Any |
| Biotech analyst | Track a competitor via author search | `litrev` | S2 |

### Provider-native CLIs

| Persona | Goal | CLI |
|---|---|---|
| PubMed power user | Fielded search with MeSH terms | `litrev-pubmed` |
| arXiv daily reader | Find today's papers in a category | `litrev-arxiv` |
| Citation graph explorer | Trace citations 2 hops from a seed paper | `litrev-semantic-scholar` |

## Designing scenarios for a new CLI

1. Run `<cli> --help` to understand the command surface
2. Identify the main workflow (what sequence of commands accomplishes the core task?)
3. Identify specialist features (what's off the main path but still user-facing?)
4. Map the project's user groups to persona archetypes
5. For each persona, write a concrete goal in their language (not CLI vocabulary)
6. Assign depth based on what the goal naturally requires
7. Check diversity: do your scenarios cover different commands, personas, and depths?

## Anti-patterns in scenario design

- **All power users** — misses the biggest UX issues (discoverability, error messages)
- **All happy path** — misses error handling, edge cases, recovery
- **All same depth** — tests one layer thoroughly, ignores the rest
- **Generic goals** — "test the search feature" tells you nothing; "find papers comparing drug A vs drug B for a safety committee" does
- **Same commands** — five scenarios all testing `search` doesn't cover `screen`, `extract`, `report`
