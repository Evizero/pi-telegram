# Rounds and Synthesis

UX testing is iterative. You ship fixes between rounds and re-test to verify improvements. This reference covers how to organize rounds, synthesize findings, and track progress in the native `pln` usability workspace.

## Directory structure

### Raw round layout

```text
dev/usability/
├── sources/
└── evidence/
    └── rounds/
        ├── round-01-initial/
        │   ├── ux_report.md
        │   ├── 01-first-time-onboarding/
        │   │   ├── ux_observation.md
        │   │   └── workspace/
        │   └── 02-follow-task-context/
        │       ├── ux_observation.md
        │       └── workspace/
        └── ...
```

Each scenario is a directory under `rounds/<round>/` containing `ux_observation.md` and `workspace/`. The `SCENARIO_DIR` variable points to this directory.

### Cleaned round layout

If the user explicitly asks to clean or archive a round, first zip the full raw round into a system temporary directory outside the repository, then flatten the round in the working tree. Treat that temp zip as short-term preservation; if the user wants a durable archive, ask for a long-term destination outside the repo.

```text
dev/usability/evidence/rounds/
└── round-01-initial/
    ├── ux_report.md
    ├── 01-first-time-onboarding.md
    └── 02-follow-task-context.md
```

This keeps the round searchable and commit-friendly while preserving the full raw evidence in the archive stored outside the repo.

## Round naming

Use round titles that are easy to read and let the CLI derive the canonical round id:

- `01-initial` for the first round
- `02-post-help-text-fix` for a retest after a help-text change
- `03-provider-native-clis` for a round focused on multiple entrypoints
- `04-new-help-text` for another targeted iteration

The CLI stores those rounds under ids such as `round-01-initial`.

## ux_report.md

After all scenarios in a round complete, write a synthesis report. This is not a copy-paste of individual scenario reports; it is a cross-scenario analysis.

```markdown
# Round {{NUMBER}}: {{LABEL}}

**Date:** {{DATE}}
**CLI version/commit:** {{VERSION or SHORT SHA}}
**Scenarios run:** {{COUNT}}
**Personas:** {{LIST}}

## Key Findings

Group by theme, not by scenario. Each finding should cite which scenarios exhibited it.

### 1. {{Theme name}}
**Severity:** HIGH / MEDIUM / LOW
**Seen in:** Scenarios 01, 03
**Description:** [Cross-scenario pattern]
**Evidence:** [Key quotes from scenario reports]
**Recommendation:** [Specific fix]

### 2. {{Theme name}}
...

## What Worked Well
[Patterns of good UX observed across scenarios]

## Metrics (if applicable)

| Metric | Value | Notes |
|---|---|---|
| Scenarios completed to goal | 2/3 | Scenario 03 hit a dead-end |
| Average steps to first useful output | 4 | Searching is discoverable |
| Workflow dead-ends encountered | 2 | Uncertain screening, schema docs |

## Comparison to Previous Round (if not first round)

| Issue from Round {{N-1}} | Status | Notes |
|---|---|---|
| Extraction lacks abstract access | FIXED | Agent successfully extracted data |
| Schema file format undocumented | PARTIAL | Help text improved, but still no example |
| No way to resolve uncertain screening | OPEN | Still no CLI command |

## Recommendations for Next Round
- [What to fix before next round]
- [New scenarios to add]
- [Personas not yet tested]
```

## Native tracking

- The longitudinal evidence record lives in `dev/USE.json`, canonical round evidence under `dev/usability/evidence/rounds/`, and curated promoted findings in `dev/inbox/` when the user chooses to promote them.
- `ux_report.md` is the canonical round synthesis artifact in the evidence-first model.
- Promoted findings are optional follow-up artifacts, not a mirror of every report entry.

## When to start a new round

Start a new round when:

- you shipped fixes from the previous round and want to verify them
- you added new CLI features and want to test discoverability
- you want coverage for a different user group or workflow depth
- enough time has passed that a fresh baseline is valuable

## Round sizing

- 3 to 5 scenarios per round is a good target
- mix retests with new coverage
- include at least one scenario per round that exercises a user group or workflow you have not tested before

## RITE approach

For fast iteration, you can fix issues between individual scenarios within a round rather than only between rounds. If scenario 01 reveals a critical issue and the fix is small and safe, fix it before running scenario 02. Document those changes in `ux_report.md` under a `Mid-round fixes` section.

## Commit hygiene and cleanup

Raw scenario workspaces are useful, but often poor commit material. They add generated clutter, make git history noisy, and reduce repo-wide search quality.

If a user wants to commit and the staged or intended changes include `dev/usability/evidence/rounds/<round>/**/workspace/`, pause and ask whether they want to:

1. keep the raw workspaces in git, or
2. clean or archive the round first

Do not silently choose for them.

If any raw workspace contains its own `.git/` directory because the scenario had to run `git init`, do not keep that raw workspace in git. Clean or archive the round first.

If the user asks to clean up a round, prefer the helper script:

```bash
python3 -B .agents/skills/pln-usability/scripts/cleanup_round.py dev/usability/evidence/rounds/<round>
```

Optional flags:

- `--dry-run` to preview actions without changing the round
- `--temp-root <dir>` to override the system temp location with another directory outside the repository

If you cannot use the helper script, use this manual workflow:

1. Choose a system temporary directory outside the repository.
2. Treat the temp zip as short-term preservation; if the user wants durable retention, ask for a long-term destination outside the repo.
3. Check for archive-name collisions first.
4. Zip the entire round directory into the chosen temp path.
5. Delete each scenario's `workspace/` directory.
6. Move each `ux_observation.md` to the round root and rename it to `<scenario-dir-name>.md`.
7. Before deleting any other scenario-local files, check whether promoted findings from that round use `usability_evidence_path` values that point into those scenario directories. If they do, preserve those files under a durable round-level location such as `linked-evidence/` and update the finding links with `pln ux update finding --evidence-path ...`, or stop and keep the raw round layout.
8. Delete any remaining scenario-local files after moving `ux_observation.md`, then remove the scenario directories.
9. Leave unrelated round-level directories alone unless the user explicitly asks for a different cleanup policy.
10. Tell the user the full archive path after cleanup.

After cleanup, the working tree contains the durable markdown artifacts while the system-temp archive preserves the raw round for later inspection. For native rounds, if native usability records already link to scenario-local evidence files, preserve those linked files under `dev/usability/evidence/rounds/<round>/linked-evidence/` and rewrite the native `raw_evidence` metadata links rather than leaving broken pointers after cleanup. Promoted findings need the same care for `usability_evidence_path`: cleanup is only safe once those links either point at durable round-level files or the raw round is intentionally kept. If flattening fails or is interrupted after the zip is written, restore from that zip before retrying.

Reserve `01-`, `02-`, and similar prefixes at the round root for scenario directories during raw investigation and for flattened scenario markdown files after cleanup. Use non-numbered names for unrelated round-level directories or notes such as `screenshots/` or `notes.md`.
