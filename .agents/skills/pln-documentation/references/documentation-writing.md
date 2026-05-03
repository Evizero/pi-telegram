# Documentation and knowledge writing

Documentation curation is not naive summarization. It is editorial maintenance of durable project memory: the project should accumulate useful knowledge instead of forcing future agents to rediscover it from chat logs, `/tmp` files, archived tasks, or scattered decisions.

## Follow the project shape

Before editing, discover existing conventions:

- README and docs tree layout;
- project-specific documentation frameworks or hosted-doc tooling;
- architecture and planning document style;
- generated vs handwritten regions;
- user-owned special sections or strong style preferences;
- existing knowledge/research pages, indexes, logs, or glossary conventions.

If conventions exist, follow them. If none exist, prefer boring Markdown under a repository-root `docs/` folder by default. Use `docs/knowledge/` for domain or research knowledge, not as the entire documentation tree. Put project/code documentation beside it in better-named sibling areas such as `docs/internals/`, `docs/guides/`, `docs/project/`, or project-specific equivalents. Root-level files under `docs/` are appropriate for high-level maps, overview pages, or start-here material. Do not impose Obsidian, wiki links, hosted-doc tooling, or a large directory scheme unless the project already uses it or the user asks for it.

Avoid awkward nested names such as `docs/documentation/`. Choose names that say what the reader gets: internals, guides, concepts, project, operations, protocols, knowledge, or the project’s own terminology.

## Create a useful baseline when none exists

A curation session should be capable of producing a real knowledge base from a mature backlog, not just a list of links. When no documentation/knowledge structure exists, create the smallest structure that lets future humans and agents navigate accumulated knowledge.

A conservative Markdown baseline is:

```text
docs/
  index.md                 # start here: map high-level docs and knowledge areas
  overview.md              # optional very high-level product/project overview
  knowledge/               # domain/research knowledge, not project/code docs
    index.md               # compact domain-knowledge map for agents/humans
    topics/
      <topic>.md           # current synthesis and deep dives
    log.md                 # short curation/change log when history matters
  internals/               # project/code internals that are not obvious from files alone
    <flow-or-subsystem>.md
  guides/                  # user/developer/operator guides when the project needs them
```

Adapt names to the project. `internals/`, `guides/`, and `project/` are examples, not mandatory folders. Prefer names that describe the content; do not create `docs/documentation/`. If the project already has a hosted-doc framework, put equivalent pages into that framework instead of creating a parallel tree.

Minimum useful page roles:

- **Index/map** — compact enough to fit in context; lists major topics, important source pages, authoritative artifacts, current gaps, and where to inspect next.
- **Domain knowledge topic/deep-dive page** — durable synthesis for a recurring domain concept, research area, source-backed finding cluster, or product concern.
- **Project/code internals page** — distilled overview of complex project behavior that is hard to infer by reading one file, such as multi-file runtime flows, state transitions, data lifecycles, extension seams, configuration resolution, or cross-component responsibilities.
- **Guide page** — task-oriented user, developer, or operator guidance when the project needs it.
- **Source/provenance links** — links to `pln ref`, inbox, task, external identifiers, or source files rather than copying raw material wholesale.
- **Log/history note** — short record of meaningful curation changes, supersession, or restructuring when it helps explain how knowledge evolved.

Use ordinary Markdown links to repository paths by default. Wiki-style links may be tolerated when the project already uses a wiki/Obsidian convention, but the knowledge base must remain readable in plain Git/editor views.

## Preserve authority boundaries

Keep layers distinct:

- **Inbox** is raw/pre-planning capture and research breadcrumbs.
- **References** preserve durable source basis, directive text, or source/finding notes.
- **Knowledge/docs pages** are readable synthesis and search surfaces.
- **StRS/SyRS** are authoritative requirements.
- **Architecture** is the authoritative design contract downstream of requirements.
- **Tasks** are implementation work records.
- **Verification/evidence** is objective evidence or planned evidence context.

Knowledge pages may summarize and link authoritative artifacts, but they do not create obligations by themselves. If curation reveals that requirements or architecture are wrong or missing, either update them only under the appropriate planning rules or record a planning handoff instead of silently changing project authority through a docs page.

## Use compiled-knowledge patterns carefully

Compiled Markdown knowledge-base patterns are useful because they treat project knowledge as a persistent, compounding artifact rather than something re-synthesized from scratch in every session. The useful structural idea is a source layer, a curated synthesis layer, project-specific instructions/schema, a compact index, and review/lint loops. Adapt that pattern without creating a competing source of truth.

Useful patterns:

- **Raw/source layer**: captured references, source files, pasted transcripts, PDFs or external-source metadata, inbox research sections.
- **Compiled synthesis layer**: topic pages, concept pages, project-knowledge pages, indexes, comparison tables, timelines, and historical notes.
- **Schema/guidance layer**: this skill, project AGENTS guidance, and project-specific docs conventions.
- **Index**: a compact map that helps humans and agents choose the right page quickly.
- **Log**: a short record of meaningful knowledge-base changes when the change history itself matters.
- **Review/lint loop**: periodic checks for contradictions, stale claims, missing source links, broken links, duplication, and orphaned pages.

Avoid turning every source into a separate page if a topic page plus source links is clearer. Avoid turning one topic page into an unbounded dump of every task that ever mentioned the topic. Links alone are not a curated knowledge base; there must be synthesis pages that explain what the project currently knows, why, and what remains unresolved.

## Choose page types intentionally

Common durable homes:

- **Domain topic page** — current synthesis for a recurring domain concept, research area, or product concern; usually under `docs/knowledge/` when using the default structure.
- **Deep-dive article** — a longer topic page for a research-heavy, flow-heavy, or conceptually difficult area; it should still start from a clear current summary and link to sources.
- **Project/code internals page** — zoomed-out explanation of behavior that spans files, classes, commands, artifacts, or runtime phases and is not obvious from reading one file.
- **Guide page** — task-oriented user, developer, or operator guidance, grounded in implemented behavior.
- **Source page/reference** — source identity, retrieval details, relevant findings, claim boundaries, and access notes.
- **Index page** — context-sized map of topics, sources, current pages, and where to inspect next.
- **Decision/history section** — why knowledge changed, what superseded what, and which tasks/requirements were affected.
- **Architecture section** — normative design contract; edit only when the change is justified by planning/implementation reality.
- **Research gap section** — unresolved questions that future work should check before relying on the synthesis.

Good structure helps answer:

- What do we currently believe or do?
- Why do we believe it?
- Which sources or project artifacts support it?
- What changed or was superseded?
- What remains uncertain?
- Which future work should read this first?

## Preserve the red thread

A good page should not read like concatenated task notes. Maintain a red thread:

1. Start with the current best understanding or purpose of the page.
2. Put the most useful summary first; move detail into sections or child pages.
3. Link to authoritative requirements/architecture when they define obligations.
4. Summarize source-backed knowledge in concise sections.
5. Keep superseded or historical material in clearly labeled context.
6. Put unresolved gaps where future work can see them.
7. Link source artifacts and task/inbox provenance without forcing readers through every raw artifact first.

If new information makes the old structure confusing, restructure. Split, merge, rename, or reframe pages when doing so improves future readability and searchability. Prefer a topic hierarchy and summary style over one giant page: broad pages should summarize and link to deep dives rather than contain every detail.

## Handle current, historical, superseded, and contradictory knowledge

Do not silently delete old knowledge just because a newer source or implementation replaced it. Instead:

- state the current best understanding;
- explain what was superseded and by what;
- preserve old values/sources when they explain historical implementation or planning decisions;
- distinguish contradiction from uncertainty;
- avoid presenting mutually inconsistent facts as if both are current;
- link to tasks/inbox items that explain the pivot when useful.

A historical note should be short and purposeful. Preserve why the old claim mattered, not every old paragraph.

## Avoid append-only decay

Good curation may require restructuring:

- move findings to a better page;
- merge duplicate explanations;
- split overloaded pages;
- add indexes or cross-links;
- replace stale summaries with current synthesis;
- preserve superseded material in a historical note instead of erasing it;
- remove prose that only repeats source artifacts without adding project understanding.

Avoid two bad extremes:

- **Lossy cleanup**: deleting old references, uncertainty, or rejected findings that still explain project history.
- **Raw accumulation**: appending every new task summary until the docs become harder to use than the original artifacts.

## Curate research splash zones

Research done for one task can have a larger splash zone than the immediate implementation. Preserve reusable findings, assumptions, numbers, source identities, rejected directions, and unresolved gaps when they are likely to help future tasks.

Examples of useful splash-zone knowledge:

- source measurements or ranges that did not enter the current implementation but may bound future modeling;
- papers or datasets that were considered but rejected for clear reasons;
- domain concepts a later task should understand before coding;
- uncertainty about values or mechanisms that should be rechecked before higher-rigor use;
- distinctions between visual/diagnostic/implementation artifacts and source truth.

Do not force splash-zone material into requirements or architecture unless planning promotes it. Put it in a knowledge/research page or reference/finding note with clear status.

## Respect implementation reality without making docs a code tour

When curating code/project documentation, prefer material that gives a coding expert or agent a distilled view they would not easily get by reading a few source files. The goal is zoomed-out understanding of complex aspects, not redundant function-level narration.

Valuable project/code documentation often covers:

- multi-file or multi-class sequences where the reader would otherwise have to mentally trace the flow;
- runtime lifecycles, state machines, artifact lifecycles, or command dispatch paths;
- dataflow between registries, markdown/frontmatter files, JSON stores, generated outputs, and CLI views;
- ownership boundaries, extension seams, invariants, and failure modes;
- configuration, environment, plugin, or integration behavior that spans modules;
- diagrams, sequence charts, tables, or trace examples when they clarify the overview.

Avoid documenting what the code already makes obvious:

- function-by-function restatements;
- docstring-like summaries of simple functions;
- file tours that list every helper without explaining the larger shape;
- examples that drift out of sync without adding conceptual value.

It is fine to name functions, classes, files, and commands as anchors. The point is not to avoid code names; the point is to use them to explain the larger flow, responsibility split, or non-obvious interaction.

When curating code/project documentation:

- read code and tests when needed;
- use task decisions to understand pivots;
- update docs to match implemented behavior;
- avoid inventing behavior that code does not implement;
- keep architecture normative rather than a diary of edits.

If code and architecture disagree, document the mismatch as a planning/architecture issue rather than hiding it in explanatory docs.

## Write for future agents and humans

Future readers should be able to consult project knowledge before repeating research. Prefer:

- stable headings and predictable terms;
- overview paragraphs before details;
- links to source artifacts and related requirements/tasks;
- short tables for source comparisons or current-vs-historical values;
- explicit uncertainty and follow-up gaps;
- concise synthesis over long copied excerpts;
- cross-links between related topics and deep dives;
- enough context for a fresh agent to know what to open next.

The goal is durable, searchable, readable project memory. If a new session is asked to build a knowledge base from many archived items, a high-quality result should emerge through repeated curation and review passes: map the backlog, create an index, write topic/deep-dive pages, fill source gaps, let reviewers criticize missing structure or weak research, then restructure until the knowledge base works as a whole.
