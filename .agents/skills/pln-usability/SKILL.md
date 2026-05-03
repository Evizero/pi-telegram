---
name: pln-usability
description: Native `pln` usability testing of CLIs with simulated first-time users. Identifies the CLI, captures user groups and scenarios, runs scenario agents that discover the tool through `--help` and trial-and-error, synthesizes findings, and keeps native usability records aligned. Use when asked to "UX test", "usability test", "simulate a user", "run a use scenario", or "test the CLI experience" in a `pln` repo.
---

# CLI Usability Testing

Bundled resource paths in this skill, such as `templates/agent-prompt.md`, `references/rounds-and-synthesis.md`, and `scripts/cleanup_round.py`, are relative to this `SKILL.md`; `.agents/skills/pln-usability/...` examples refer to the repository-local installed copy, not `dev/`.

Test CLI usability by spawning strong general-purpose sub-agents that role-play as first-time users. Each agent discovers the tool through `--help` and experimentation, not source-code reading.

This skill assumes a native `pln` repository with usability records under `dev/usability/`. Durable evidence lives under `dev/usability/evidence/`, and direct scenario or manual-mapping provenance lives under `dev/usability/sources/`.

## Quick Start

Default flow:

1. Identify the CLI entrypoint and verify `<cli> --help` works.
2. Capture or refresh user groups and scenarios through `pln use`. If you need to preserve raw scenario input or manual mapping notes, save them under `dev/usability/sources/` first.
3. Create the round through `pln ux add round --title "<round title>" ...` and use the returned round id as the canonical directory name under `dev/usability/evidence/rounds/<round-id>/`.
4. Run 3-5 scenario agents covering different personas and workflow depths.
5. Write or refine `ux_report.md` inside that CLI-owned round directory.
6. Refresh the canonical round record with `pln ux update round <round-id>`.
7. Stop by default after synthesis and discuss which findings, if any, should be promoted into inbox-backed usability findings.
7. If the user wants cleanup before commit, prefer the helper script at `.agents/skills/pln-usability/scripts/cleanup_round.py` to archive the raw round to a system temp location outside the repo and flatten the round in place.

Use this skill whenever all of the following are true:

- the repo has `dev/` and `pln` resolves it as the project root
- `pln ux --help` works

## Native Homes

- Use specification: `dev/USE.json`
- Risk analysis: `dev/RISK.json`
- Curated promoted findings: `dev/inbox/*.md` with usability provenance
- Direct scenario inputs and manual mapping notes: `dev/usability/sources/`
- Raw and cleaned round evidence: `dev/usability/evidence/rounds/<round-id>/`

## Native Contract

- Canonical native UX evidence is the round report plus scenario-local observation logs under `dev/usability/evidence/`.
- Promoted usability findings are optional planning artifacts, not an automatically populated second evidence store.

## Utility Scripts

### cleanup_round.py

Preferred helper for round cleanup and commit hygiene.

Round example:

```bash
python3 -B .agents/skills/pln-usability/scripts/cleanup_round.py dev/usability/evidence/rounds/<round-id>
```

Useful flags:

- `--dry-run` — preview archive path and flattening actions without changing anything
- `--temp-root <dir>` — override the system temp location used for the archive; it must still be outside the repository

## Phase 1: Identify the CLI Under Test

Before anything else, figure out what CLI commands are available and how to invoke them.

1. Inspect the project's likely CLI entry sources: `package.json` bin entries, workspace scripts, `pyproject.toml`, `setup.py`, `Cargo.toml`, `Makefile`, `bin/`, shell scripts, install docs, and build outputs.
2. Determine the invocation pattern, for example `pnpm litrev`, `npx my-tool`, `./bin/cli`, `python -m tool`, or `cargo run --bin tool --`.
3. If the project has multiple CLIs, clarify with the user whether to test one or all of them.
4. Verify the CLI is built and runnable with `<cli> --help`.

## Phase 2: Capture User Context

Before spawning test agents, think through who would use this CLI and what they are trying to accomplish.

Good scenario design is:

- diverse across user types, not just power users
- concrete about goals
- aware of quick tasks and deeper workflows
- honest about maturity levels

1. Review existing `pln use list user-group` and `pln use list scenario` output first.
2. If the user gave a direct scenario, persist that raw scenario input under `dev/usability/sources/` before or while creating canonical native records.
3. If you need manual mapping because the scenario does not identify the right user group or scenario linkages, write a markdown note under `dev/usability/sources/` that captures:
   - intended user identity
   - workflow goal
   - relevant use-environment or context-of-use detail
   - the chosen native linkage
4. Create or refresh native user-group and scenario records with `pln use add` or `pln use update`.
5. When the evidence clearly reveals a new or revised analyzed use error, update `USE.json` deliberately instead of treating every friction note as a use error.
6. If you cannot infer the required native linkage without guessing, stop and tell the user exactly which mapping detail is missing.

## Phase 3: Run Simulated Users

### Determine the round

Every test session belongs to a round.

- If the user specifies context, use that, for example `02-post-help-text-fix`
- If it is the first round, use `01-initial`
- If no label is obvious, use the date

Check `dev/usability/evidence/rounds/` for existing rounds, choose the next round title, and create the round with the CLI:

```bash
pln ux add round --title "<round-title>"
```

Use the returned round id, for example `round-01-initial`, as the canonical round directory name.

### Pick scenarios

Unless otherwise specified, pick scenarios that cover:

- different user types
- different workflow depths
- different CLI capabilities
- different providers or backends if applicable

### Spawn agents

For each scenario, tell the agent to read the [agent prompt template](templates/agent-prompt.md) and provide its variables.

```text
Read the prompt template at <absolute-path>/.agents/skills/pln-usability/templates/agent-prompt.md and follow its instructions.

Your variables:
- PERSONA: <filled in>
- GOAL: <filled in>
- CLI_ENTRY: <filled in>
- SCALE_NOTE: <filled in>
- SCENARIO_DIR: <absolute-path>/dev/usability/evidence/rounds/<round-id>/<number>-<slug>
- TITLE: <short descriptive title>
```

Spawn as a strong general-purpose sub-agent with enough turn budget to complete the scenario without truncation.

### Essential principles

- Do not spoil the experience. Do not hint at commands beyond the starting `--help`.
- Agents must not read repository files. They can read files the CLI itself creates.
- Agents should make mistakes and recover naturally.
- Scale down workloads to reduce cost.
- If the user already gave a specific scenario, do not force a separate use-case generation step.
- Treat `{{SCENARIO_DIR}}/workspace` as a hard isolation boundary. If the CLI appears to bind itself to parent-repo state instead of that workspace, call it out explicitly in the observation log and round synthesis.

## Phase 4: Interpret Results

Look for patterns such as recurring friction, one-off confusion, workflow dead-ends, strong delight signals, and help-text gaps.

## Phase 5: Synthesize and Track

After the scenario agents complete, write a round synthesis report and keep the authoritative record aligned.

See [rounds-and-synthesis.md](references/rounds-and-synthesis.md) for the detailed format.

- Write `ux_report.md` to `dev/usability/evidence/rounds/<round-id>/ux_report.md`.
- Refresh the native round record with `pln ux update round <round-id>`.
- By default, stop after synthesis and ask which findings should be promoted into inbox-backed usability findings.
- If the user clearly wants automation, promote only the selected findings with `pln ux add finding`, preserving source round, evidence path, and relevant scenario/use-error/risk provenance.

After the initial synthesis, investigate the codebase to understand the real implementation context and then refine the findings and recommendations accordingly.

## Phase 6: Commit Hygiene and Round Cleanup

If the user asks to commit, or asks whether the round is ready to commit, and the commit would include any raw `workspace/` content, stop and ask whether they want to keep the raw workspaces in git or flatten the round first.

If any raw workspace contains its own `.git/` directory, do not keep that raw workspace in git. Clean or archive the round first.

If the user explicitly asks to clean up a round, prefer the helper script:

```bash
python3 -B .agents/skills/pln-usability/scripts/cleanup_round.py <round-dir>
```

`<round-dir>` should normally be `dev/usability/evidence/rounds/<round-id>`.

The helper script archives the full raw round first, then flattens numbered scenario directories in place. If cleanup fails after archiving, restore from the zip and retry.
For native `pln` rounds, if any native usability record links to scenario-local files beyond `ux_observation.md`, the helper preserves those referenced artifacts under `dev/usability/evidence/rounds/<round-id>/linked-evidence/` and rewrites the native `raw_evidence` links so cleanup does not leave broken evidence pointers.
Promoted usability findings are separate: if any finding in that round uses `usability_evidence_path` that points into a scenario-local directory, do not flatten the round until you either preserve that file under a durable round-level location such as `linked-evidence/` and run `pln ux update finding --evidence-path ...`, or decide to keep the raw round layout in git.
