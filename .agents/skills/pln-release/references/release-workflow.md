# Release Workflow Guide

Use this guide with the `pln-release` skill when preparing a repository release.

## Artifact roles

- `CHANGELOG.md` is the human-readable release-history artifact.
- `[Unreleased]` holds curated release-notable changes collected during close-out.
- Dated release headings preserve what shipped in a finalized release.
- The project-local release policy determines whether the next release is a SemVer version, date/snapshot tag, milestone tag, report revision, dataset/model version, or another declared form.
- Git history, tasks, inbox items, and archived planning records are review inputs; they are not a replacement for curated changelog prose.

## Changelog shape

Keep the top-level changelog small and conventional:

```md
# Changelog

## [Unreleased]

### Added
- Added a release-notable capability. Impact: minor for the declared software surface.

## [0.1.0] - 2026-05-03

### Added
- Initial release.
```

Render only headings that contain entries. Do not leave empty `Added`, `Fixed`, or other category headings as a template.

Allowed category headings when they have entries:

- `Breaking`
- `Added`
- `Changed`
- `Deprecated`
- `Removed`
- `Fixed`
- `Security`
- `Documentation`
- `Research`

Use `Documentation` only for documentation changes that are worth release-note visibility. Use `Research` for release-notable experiments, reports, findings, methods, datasets, or other research outputs.

## Entry quality

A good release entry is concise but decision-useful. When relevant, include:

- affected surface, such as CLI command, library API, schema, report, dataset, model, docs, or knowledge base;
- compatibility impact;
- migration need;
- security relevance;
- documentation or research significance;
- SemVer impact or explicit no-SemVer-impact note.

Avoid vague entries such as "cleanup", "misc fixes", or "updates" when the change might affect users or release policy.

## Version or tag basis

Start with the project's declared release surface.

For SemVer software surfaces:

- `MAJOR` for incompatible public-surface changes;
- `MINOR` for backward-compatible public capability;
- `PATCH` for backward-compatible fixes;
- no SemVer bump from documentation or research entries unless the project policy says those entries affect the software release surface.

For non-SemVer surfaces, follow project policy:

- date or snapshot tags for evolving research or knowledge bases;
- milestone tags for curated project states;
- report revisions for report-oriented outputs;
- dataset/model versions for data or model artifacts;
- project-specific tags for mixed outputs.

If policy is absent, contradictory, or too vague to explain the release decision, stop and ask for clarification or plan release-policy documentation before tagging.

## Finalization checklist

Before creating an annotated tag:

1. Review all `[Unreleased]` entries.
2. Split or clarify vague entries.
3. Surface hidden breaking changes under `Breaking` or with an explicit marker.
4. Choose the version or tag basis from the highest-impact entry and project policy.
5. Move released entries under a dated heading.
6. Reset `[Unreleased]` to an empty placeholder without empty category headings.
7. Update applicable project version sources, if any.
8. Run project validation.
9. Commit the finalized release state.
10. Create the annotated tag only after that commit exists, so the tag points at the changelog and version-source state that was validated.

Do not push tags, publish packages, upload artifacts, or create hosted release records unless the user explicitly asks for that deployment step.
