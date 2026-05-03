# Documentation curation review checklist

Before marking inputs `done`, run the required end-of-phase review described in `SKILL.md`. For substantive documentation edits, this should be a read-only review subagent with a strict `Findings:` / `No findings. ...` verdict.

## Input coverage

- Relevant active and archived inbox/task breadcrumbs were considered.
- Registered paths were inspected at the right revision or diff scope.
- The review checks related references, architecture, requirements, code/tests, evidence, or source files when the curation depends on them.
- Important implementation pivots, task decisions, and source findings are not stranded only in task/inbox prose.
- Research splash-zone material that future work should reuse was either curated, explicitly deferred, or intentionally left in source artifacts with a reason.

## Truthfulness and authority boundaries

- Documentation reflects implemented reality, current planning decisions, and known uncertainty.
- Curated synthesis does not silently override StRS, SyRS, or architecture authority.
- Any architecture-contract change is deliberate, justified, and reviewed as planning-sensitive work.
- Knowledge pages are clearly synthesis/search surfaces unless planning explicitly promoted content into requirements or architecture.
- Contradictions between code, docs, requirements, architecture, or source findings are surfaced rather than smoothed over.

## Knowledge structure and red thread

- The chosen home makes sense: existing page, new topic/deep-dive page, index, log, historical note, source/reference record, or defer/ignore.
- If no documentation structure existed, the curation created a small useful `docs/`-rooted Markdown baseline or explicitly justified why not.
- The default structure keeps domain/research knowledge under a distinct `knowledge/` area and puts project/code docs in better-named sibling areas such as internals, guides, or project-specific equivalents rather than a vague nested documentation folder.
- If a documentation framework or project convention already existed, the curation used it rather than creating a parallel structure.
- Root-level docs files, if added, are high-level maps or overview/start-here material.
- Docs remain searchable and readable.
- Pages have a clear current-best-understanding thread rather than concatenated task summaries.
- The knowledge base has synthesis pages, not merely a pile of links to tasks/inbox/source artifacts.
- Redundant explanations were merged or linked.
- Overloaded pages were split or restructured when needed.
- Index/log pages, if present, are concise navigation aids rather than duplicate knowledge dumps.
- Cross-links connect related topics, deep dives, sources, and authoritative artifacts where helpful.
- Handwritten/user-owned sections and project conventions were respected.
- Broken links or obsolete paths introduced during curation were fixed.

## Current, historical, and superseded knowledge

- Superseded findings explain what replaced them and why, or remain clearly historical.
- Older values/sources are preserved when they explain past implementation or planning decisions.
- Current claims are not mixed with historical claims in a way that misleads future readers.
- Unresolved gaps are explicit and easy for future work to find.
- Rejected sources or directions are recorded when forgetting them would cause duplicated research.

## Provenance

- Source identities are preserved for research-heavy claims.
- Retrieval state is clear enough: mentioned, search hit, metadata checked, read/extracted, planning basis, verified, superseded, or rejected when the distinction matters.
- Ephemeral search/chat references are replaced or qualified with durable source detail where possible.
- Server-side or externally supplied research is described honestly instead of overclaiming local verification.
- Copyright-sensitive source text is paraphrased or quoted only in short, attributed excerpts when appropriate.
- Claim strength or evidence grade is clear for important findings.

## Future usefulness

- A future agent can consult the curated docs/knowledge before repeating the same research.
- A new session asked to build or extend the knowledge base would know where to start from the index/map.
- The curation points to remaining source gaps or questions that still require lookup.
- Project/code docs focus on non-obvious cross-file behavior, flows, lifecycles, invariants, and integration seams rather than redundant function-level restatement.
- The page structure helps future implementation understand why decisions were made, not just what files changed.
- The docs avoid both lossy cleanup and append-only decay.
- Review criticism was allowed to trigger further source lookup or larger restructuring when the knowledge base did not work as a whole.

## State updates

- Non-obvious outcomes have `pln documentation decide` entries.
- Deferred or ignored inputs have a reason.
- Inputs are marked `done` only after the documentation outcome is complete and reviewed.
- The latest review happened after the latest documentation changes; fixing findings from an earlier review is not enough by itself.
- Tiny no-change checklist-only reviews have an explicit decision note explaining why no documentation edit was needed.
