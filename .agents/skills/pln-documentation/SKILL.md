---
name: pln-documentation
description: Curate and update repository-local documentation and project knowledge from completed planning, research, implementation, and source artifacts. Use when the user asks to consolidate documentation, update docs or knowledge, process documentation backlog, curate research findings, make project documentation current, or run `pln documentation`; do not use for ordinary inbox capture, normal implementation, planning, or close-out except to preserve breadcrumbs for later curation.
---

# Documentation curation

Documentation curation is a dedicated project-memory phase. It turns completed work, research breadcrumbs, implementation pivots, source records, and changed project files into durable, readable, searchable documentation and knowledge without making normal inbox/planning/implementation/close-out sessions do that work inline.

## Quick Start
1. Orient to authority and project shape: read `dev/INTENDED_PURPOSE.md`, locate the nominated main architecture document with `pln architecture show` when available (falling back to `dev/ARCHITECTURE.md` in older checkouts), read compact requirement summaries when useful, existing README/docs/knowledge pages, generated sections, handwritten sections, and project-specific docs tooling.
2. Run `pln documentation status` and `pln documentation list` to find pending curation inputs.
3. Inspect inputs with `pln documentation show <input>` and, for tracked files, `pln documentation diff <input>`. Follow links into references, code, tests, evidence, architecture, related inbox/tasks, and source files when needed; the CLI surfaces breadcrumbs but does not limit your reading.
4. Classify the session scenario and load only the references needed for that scenario:
   - status/triage only: no reference is required unless you start editing;
   - actual docs/knowledge writing or restructuring: read `references/documentation-writing.md`;
   - architecture-document restructuring or architecture prose edits: also read the shared architecture-writing guide at `.agents/skills/pln-plan/references/architecture-writing.md` (or the equivalent bundled `pln-plan/references/architecture-writing.md` path in the source tree);
   - research-heavy, external-source, transcript, provenance, or source-gap work: read `references/research-provenance.md`;
   - review pass: read `references/review-checklist.md` plus whichever writing/provenance/architecture reference matches the edited content.
5. For each input or small related batch, build a curation packet: source artifacts, lifecycle role, reusable knowledge, likely documentation impact, and authority boundary.
6. Curate deliberately. Decide whether to update an existing page, create/split/merge pages, add or refresh an index/log, preserve historical notes, record uncertainty, perform source lookup, defer, or ignore.
7. Run the required end-of-phase review before marking anything `done`. For substantive docs/knowledge edits, use a read-only review subagent with a strict `Findings:` / `No findings. ...` verdict.
8. Only after the latest review after the latest changes is clean, record decisions with `pln documentation decide <input> --decision ...` and mark processed inputs with `pln documentation update <input> --status done`.

## Scenario guidance

### Status or triage only
Use this when the user asks what documentation work is pending or what changed. Run `status`, `list`, and targeted `show`/`diff`. Do not load writing/provenance references or edit docs unless the session turns into actual curation. If you only classify an input as deferred/ignored, record the reason through the CLI.

### Actual curation and writing
Use this when docs or knowledge pages will change. Read `references/documentation-writing.md` before editing. Do not merely summarize task/inbox bodies. Extract reusable knowledge, source context, unresolved gaps, historical meaning, and future-implementation value into the right durable place. If the project has no documentation/knowledge structure yet, establish a small Markdown baseline under `docs/` by default: root-level high-level docs or indexes, `docs/knowledge/` for domain/research knowledge, and sibling folders with better names such as `internals/`, `guides/`, or `project/` for project/code documentation.

### Architecture document curation
Architecture prose is documentation-like, but it is also a planning authority layer. Before moving, splitting, merging, or substantively editing architecture documents, read the shared architecture-writing guide from `pln-plan` and locate the nominated main architecture document with `pln architecture show`. You may restructure architecture into a substantive main architecture document plus linked side documents when that improves readability, but the nominated main document must remain task-context-loadable, contain high-level architecture contract content, and stay consistent with intended purpose, StRS, SyRS, tasks, and implementation reality. If the main architecture path changes, update it with `pln architecture update --path <project-relative-file>`. If curation reveals requirement drift, missing architecture authority, or a conflict between architecture and implementation, record a planning handoff instead of silently resolving the authority gap as ordinary docs cleanup.

### Build or rebuild a knowledge base
Use this when the user asks to “build a knowledge base,” “consolidate documentation,” or process a large backlog of archived items. This is a deep curation session, not a quick cleanup. Read `references/documentation-writing.md`; also read `references/research-provenance.md` if the backlog is research-heavy. Expect multiple passes: first map existing docs and backlog themes, then create or refine an index, topic/deep-dive pages, source/provenance links, historical/supersession notes, and gaps. Reviews should be allowed to find missing topics, weak structure, insufficient source checking, or places where the knowledge base should be restructured as a whole.

### Research/source-heavy curation
Use this when inputs mention literature research, web research, server-side/external research, transcripts, pasted reports, PDFs, source URLs, scientific/medical claims, source gaps, or evidence grades. Read `references/research-provenance.md` before writing claims. Fill source gaps deliberately or label them honestly.

### Review
Use this when checking curation output before inputs are marked `done`. The reviewer should read `references/review-checklist.md` and the scenario-specific writing/provenance guide relevant to the changed docs. Vague or non-verdict review output is not a clean review.

## Curation packet

For each input or small related batch, identify:

- **source artifacts** — task, inbox item, captured reference, code/docs path, protocol, evidence, or external source;
- **lifecycle role** — raw idea, research result, planned work, implemented behavior, rejected direction, superseded claim, evidence artifact, or documentation drift;
- **reusable knowledge** — facts, assumptions, source identities, decisions, pivots, numbers, constraints, unresolved gaps, stakeholder context, or historical reasons;
- **documentation impact** — no change, update page, new page, restructure, source lookup, architecture/planning handoff, project/code overview needed, defer, or ignore;
- **authority boundary** — synthesis only, requirement-impacting, architecture-impacting, verification/evidence-impacting, or implementation-only.

## Durable-home choices

Use the existing project documentation shape when it exists. Common outcomes:

- update an existing page when the new knowledge clarifies or supersedes a documented topic;
- create a topic/deep-dive page when accumulated knowledge has a stable theme that future work will consult again;
- create or refresh an index when several pages/artifacts need a compact map for humans and agents;
- add a short log or historical note when it matters that knowledge changed over time;
- create a conservative Markdown baseline when none exists, usually `docs/` with high-level root files, `docs/knowledge/` for domain knowledge, and sibling folders such as `internals/`, `guides/`, or `project/` for other documentation needs;
- split overloaded pages or merge duplicate pages when the red thread is degraded;
- record a planning handoff when curation reveals a real requirement or architecture gap;
- defer when the input is real but depends on unresolved context;
- ignore only when the input/path should not keep surfacing for documentation curation.

## Review and completion loop

For any substantive documentation or knowledge edit, start a separate read-only review subagent. The prompt must include:

- exact files/docs changed;
- curation inputs being processed;
- relevant references to read: always `references/review-checklist.md`, plus `documentation-writing.md` and/or `research-provenance.md` when applicable;
- unrelated worktree changes to ignore unless directly relevant;
- concrete criteria for truthfulness, completeness, source/provenance preservation, authority boundaries, readability, broken links, duplication, and whether each input is safe to mark `done`;
- strict output contract: `Findings:` with concrete issues or exactly `No findings. ...`.

Fix findings and rerun review on the updated docs. The loop is complete only when the latest review run after the latest documentation or state-relevant changes reports no findings. Tiny no-change cases may use checklist self-review instead of a subagent only when a clear `pln documentation decide` note explains why no edit was needed.

## References

Load references conditionally; do not read all of them by default.

- `references/documentation-writing.md` — read before writing, restructuring, splitting/merging, indexing, or otherwise changing docs/knowledge pages.
- `references/research-provenance.md` — read when source identity, research findings, transcripts, external/server-side research, source gaps, uncertainty, or copyright-sensitive material matter.
- `references/review-checklist.md` — read for review passes before marking inputs `done`; reviewers should use this as their primary checklist.

## Gotchas
- Do not treat curated knowledge pages as replacements for StRS, SyRS, or architecture authority.
- Do not reduce the nominated main architecture document to a pure index; it may link side docs, but it must preserve substantive high-level architecture contract content.
- Do not silently delete superseded findings; preserve why they changed or why the old source is no longer preferred.
- Do not run this as an automatic close-out step. Close-out and implementation preserve breadcrumbs; this workflow curates them later.
- Do not let the knowledge base decay into append-only clutter, duplicated claims, unexplained contradictions, or lost references.
- Do not mark inputs `done` until docs/knowledge were actually updated or intentionally left unchanged and the required end-of-phase review is clean.
- Respect project-specific documentation conventions and user-owned handwritten sections.

## Validation
Before finishing:
- Confirm the latest review run happened after the latest documentation changes and returned a concrete clean verdict, or that the input was a tiny no-change case with an explicit decision note and checklist self-review.
- Confirm `pln documentation status` no longer shows inputs you processed unless their content changed during the session.
- Confirm every processed input has a clear decision or note when the outcome is not obvious from the documentation diff.
- Confirm source identities, uncertainty, supersession, and follow-up gaps are preserved for research-heavy material.
- Confirm docs/knowledge pages remain readable, searchable, cross-linked, and structured around a clear red thread rather than becoming raw transcript/task dumps.
- Confirm project/code documentation focuses on distilled overviews of complex cross-file behavior, flows, invariants, and integration seams rather than redundant function-by-function restatement.
- Confirm a project with no prior documentation received a small useful baseline, or that existing documentation conventions were respected.
- Confirm future implementation can find reusable research or project knowledge before repeating the same investigation.
