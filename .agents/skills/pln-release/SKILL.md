---
name: pln-release
description: Prepare repository-local releases from a curated changelog and project release policy. Use when the user asks to prepare a release, choose a version bump, finalize CHANGELOG.md, tag a release, create release notes, decide SemVer impact, or validate whether Unreleased entries are ready to release.
---

# Release

Read [release-workflow.md](references/release-workflow.md) before preparing any release.

## Quick Start
Default workflow:
1. Confirm the user is asking for release preparation, version selection, changelog finalization, release notes, or tagging rather than ordinary close-out. If implementation work is still in progress, hand back to implementation or close-out first.
2. Read `CHANGELOG.md` and identify the current `[Unreleased]` entries. If there is no changelog and the project appears to use this workflow, create a small conventional top-level `CHANGELOG.md` rather than inventing release notes from git log alone.
3. Identify the project's declared versioned or released surface before recommending a version or tag. Use project-local policy when it exists in intended purpose, README, pyproject/package metadata, release docs, task decisions, or other explicit project guidance.
4. Classify each unreleased entry by category, affected surface, compatibility impact, migration need, and release impact. Stop for clarification if an entry is vague enough that the version or tag basis cannot be explained.
5. Apply SemVer only when the declared surface is software/API-like. For research, documentation, report, data, model, knowledge-base, or mixed outputs, choose the project-local snapshot, date, milestone, or tag policy instead of forcing MAJOR/MINOR/PATCH.
6. Recommend the release impact from the highest-impact unreleased entry. Make breaking changes explicit and explain the basis for any MAJOR, MINOR, PATCH, snapshot, date, milestone, or no-release recommendation.
7. When the user confirms finalization, move the relevant `[Unreleased]` entries under a dated release heading, reset `[Unreleased]`, update applicable version sources, run project validation, commit the finalized release state, and then create an annotated git tag that points at that commit.
8. Stop after release preparation by default. Do not push tags, publish packages, or create hosted GitHub releases unless the user explicitly asks for that next step.

## Instructions
- Treat the changelog as curated release evidence, not as a raw git-log dump.
- Do not infer authoritative release notes solely from commit subjects. Use task, inbox, archived work, documentation breadcrumbs, and git history as review inputs, but keep human-readable `CHANGELOG.md` prose as the release-note artifact.
- Keep `CHANGELOG.md` conventional and sparse:
  - keep `[Unreleased]` above dated release headings;
  - render only category headings that have entries;
  - use these category names when entries exist: `Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Documentation`, `Research`.
- Make breaking changes impossible to miss. Use a `Breaking` section or an explicit breaking marker in the affected entry, and include migration guidance when the project can state it.
- Preserve enough version-basis detail in each relevant entry to explain the release decision later: affected surface, user-visible behavior, compatibility impact, migration need, security relevance, documentation/research significance, and whether the entry has SemVer impact.
- Identify the release policy before bumping:
  - SemVer fits software packages, CLIs, libraries, public APIs, protocols, schemas, and other software/API-like surfaces when the project declares or clearly uses that policy.
  - Snapshot, date, milestone, report, data/model, or project-specific tags may fit research, documentation, knowledge-base, technical-file, and mixed-output repositories.
  - Pre-1.0 software may still use SemVer, but the project policy should explain how breaking changes are treated before `1.0.0`.
- If the project has multiple released surfaces, classify entries against the relevant surface instead of assuming one repository-wide bump covers everything.
- If release policy is missing or contradictory, stop and ask whether to write or plan project-local release-policy guidance rather than silently choosing a versioning model.
- For SemVer releases, use the highest applicable impact:
  - breaking public-surface compatibility requires a MAJOR bump;
  - backward-compatible public capability requires a MINOR bump;
  - backward-compatible fixes normally require a PATCH bump;
  - documentation or research entries may be release-notable without changing the SemVer bump when they do not affect the declared software surface.
- For non-SemVer releases, explain the selected tag or heading from the project policy, for example date, milestone, dataset version, report revision, or snapshot tag.
- Before finalizing a release, inspect for ambiguity:
  - no vague entries such as "misc cleanup" when those entries could affect compatibility;
  - no hidden breaking changes buried under `Changed` or `Fixed`;
  - no populated category headings left empty after moving entries;
  - no stale `[Unreleased]` entries accidentally swept into the release without review.
- When updating version sources, change only files the project actually treats as version sources, such as `pyproject.toml`, package metadata, docs, manifests, or generated policy files. Do not invent a version registry for projects that use tag-only or date-based releases.
- Run the project's normal validation before tagging. Read project-local validation policy from task instructions, `AGENTS.md`, README, CI configuration, release documentation, package metadata, or explicit user direction instead of assuming one universal command set.
- Create an annotated tag only after the changelog and version sources reflect the final release state, validation has passed, and that finalized state is committed. Use `vX.Y.Z` for SemVer software releases unless the project has declared a different tag format.
- Keep release finalization separate from ordinary task close-out. `pln-close` maintains `[Unreleased]`; this skill finalizes releases.

## Gotchas
- Do not hard-code `pln`'s own CLI/package surface as the universal release surface for every repository.
- Do not force research, documentation, reports, datasets, models, or knowledge snapshots into MAJOR/MINOR/PATCH unless the project declares SemVer for that surface.
- Do not tag before validation, before the changelog and version sources are in their final state, or before the finalized release state is committed.
- Do not leave breaking changes only in prose under `Changed`; make them explicit.
- Do not create hosted releases, upload artifacts, push tags, or publish packages without explicit user direction.

## Validation
Before finishing:
- Confirm `CHANGELOG.md` was inspected and `[Unreleased]` entries were classified.
- Confirm the project release surface and versioning or tagging policy were identified from project-local evidence or explicitly clarified with the user.
- Confirm SemVer was used only for software/API-like surfaces where it fits the project policy.
- Confirm non-software release-notable entries were either mapped to the project-local non-SemVer policy or explicitly marked as having no SemVer impact.
- Confirm breaking changes, migration notes, and compatibility impact are visible enough to justify the version basis.
- Confirm the finalized changelog uses only populated category headings from the approved vocabulary.
- Confirm applicable version sources were updated, or that the project uses tag-only/snapshot releases and no version source update was needed.
- Confirm validation ran successfully before any tag was created, or state clearly why tagging is not yet complete.
- Confirm any created release tag is annotated and points at the committed finalized release state.
