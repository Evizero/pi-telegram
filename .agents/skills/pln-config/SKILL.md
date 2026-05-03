---
name: pln-config
description: Use when working on optional configuration management, governed development guidance, shared controlled-item inspection, opt-in SOUP governance, project-owned SOUP helper scripts, dependency monitoring, update-impact analysis, audit evidence, or batched configuration-governance workflows.
---

# Configuration Governance

Bundled asset paths in this skill, such as `assets/discover.py`, are relative to this `SKILL.md`; `dev/scripts/soup/` paths are project-owned files in the target repository.

Use this skill when the user wants to:
- enable or inspect repository-local configuration management
- register or inspect controlled items through `pln config`
- govern authoritative development guidance documents or companion policy files
- understand which tracked documents belong to the governed configuration set
- enable or inspect the SOUP subsystem that plugs into the shared config-management layer
- create or adapt project-owned SOUP helper scripts under `dev/scripts/soup/`
- preserve SOUP review requests, review artifacts, or decision evidence
- run update-analysis or audit workflows for selected SOUP items
- reason about batched SOUP analysis or audit over a selected item set

## Shared model

When configuration management is enabled, the shared workspace is:
- `dev/CONFIG_MANAGEMENT.json`
- `dev/CONFIG_ITEMS.json`

Treat `dev/CONFIG_ITEMS.json` as the shared controlled-item registry.
Use `pln config list` and `pln config show` as the normal inspection surfaces for what the repo is governing.
Use `pln hygiene` to surface malformed governed configuration state instead of hand-inspecting JSON first.

The point of tracking a document or governed item here is that it should become visible, inspectable, and structurally checkable.
If a document is tracked, the operator should be able to see:
- that it is part of the governed set
- which file path is authoritative
- whether a machine-readable companion policy belongs with it
- which managed surfaces are declared in scope when that metadata exists

## Development guidance

Use `item_type = development-guidance` when a repository-local document is meant to be an authoritative guide for a specific development-governance scope.

The metadata contract is not arbitrary.
Use:
- `guidance_scope`
- `guidance_path`
- `policy_required`
- `policy_path` when `policy_required` is `true`
- optional `managed_surface_selectors`

Working rules:
1. Keep `guidance_path` and `policy_path` repo-relative and inside the repository. There is no special folder requirement.
2. Treat `guidance_scope` as the unique identity of the guidance family inside `development-guidance` items.
3. Use `policy_required: false` when prose alone is enough for now.
4. Use `policy_required: true` only when a downstream workflow genuinely consumes a machine-readable companion file.
5. Remember the current boundary: this shared layer governs registration, inspection, and structural diagnostics first. It does not by itself enforce the content of the tracked guide.

Typical development-guidance workflow:
1. Enable config management with `pln config enable` if the project has not opted in yet.
2. Register the guide with `pln config add ... --item-type development-guidance --metadata ...`.
3. Use `pln config list` to confirm the tracked document set is obvious from normal text output.
4. Use `pln config show <id>` when you need the specific guide path, policy path, and managed-surface selectors.
5. Use `pln hygiene` when tracked guidance is behaving oddly or inspection output suggests malformed registry state.

## SOUP subsystem

SOUP is a subsystem that plugs into the shared configuration-management model rather than replacing it.

When SOUP is enabled, the SOUP-specific workspace is:
- `dev/SOUP_CONFIG.json`
- `dev/SOUP_ITEMS.json`
- `dev/soup/requests/`
- `dev/soup/reviews/`
- `dev/soup/decisions/`
- `dev/soup/evidence/`
- `dev/scripts/soup/`

Treat `dev/CONFIG_ITEMS.json` as the shared controlled-item identity registry when configuration management is enabled; SOUP items mirror there instead of owning a competing identity store.
Treat `dev/SOUP_ITEMS.json` as the SOUP-specific operational record for discovery, monitoring, selected-candidate state, and decision linkage.
Treat `dev/soup/*.md` artifacts as preserved evidence and decision context.
Treat `dev/scripts/soup/` as project-owned automation, even when the files were scaffolded from bundled templates.

## Helper-script posture

`pln` does not hard-code every dependency ecosystem.
Instead, it provides a stable seam so the agent can write repository-specific helpers that match the real manifests, lockfiles, bundlers, vendored code, generated SDKs, or packaged outputs in this repo.

For cold-start setup after `pln soup enable`:
- read `dev/scripts/soup/README.md` first
- customize `dev/scripts/soup/discover.py` before the other helper templates
- keep the JSON stdin/stdout contract stable because that is how `pln` hands structured work to project-owned helpers
- run `pln soup sync` as the first validation step before treating monitor or review flows as wired up

The scaffolded templates are starting points:
- [assets/discover.py](assets/discover.py)
- [assets/monitor.py](assets/monitor.py)
- [assets/analyze_update.py](assets/analyze_update.py)
- [assets/inspect_source.py](assets/inspect_source.py)

Adapt them to the current repository instead of treating them as finished logic.

## Working rules

1. Start from the repository's real dependency and packaging layout, not from generic ecosystem assumptions.
2. Keep helper output deterministic JSON so `pln soup` commands and later agents can consume it reliably.
3. Default transient upstream staging, clones, downloads, and unpacked artifacts to temp space outside the repository unless a helper is deliberately preserving bounded evidence.
4. When retained proof-of-work matters, prefer a deterministic zip bundle under `dev/soup/evidence/`, strip obvious scratch bulk before bundling, and preserve only a stable bundle name in review metadata rather than a temp path.
5. Review-oriented helpers should surface prepared temp-workspace inspection paths, preserved bundle paths when available, and explicit unresolved states instead of making the agent rediscover those seams from scratch.
6. Preserve the distinction between:
   - discovered candidates
   - governed SOUP items
   - monitored state
   - selected candidate version
   - preserved review evidence
   - preserved decisions
7. Do not claim a helper or audit proves a package is safe. Preserve bounded findings, scope, rationale, and residual uncertainty honestly.
8. Prefer explicit operator selection for deep review or batched work. Do not silently fan out expensive cloning or source-inspection work.

## Typical SOUP workflow

1. Enable SOUP with `pln soup enable` if the project has not opted in yet.
2. Read `dev/scripts/soup/README.md` for the repo-local helper contract.
3. Adapt `dev/scripts/soup/discover.py` first so discovery matches this repository.
4. Run `pln soup sync` to discover or refresh candidate components and validate the helper seam.
5. Adapt or inspect the remaining `dev/scripts/soup/` helpers as needed for monitoring or deeper review workflows.
6. Curate the governed set with `pln soup promote`, `pln soup add`, `pln soup ignore`, or `pln soup retire`.
7. Run `pln soup monitor` to refresh update and advisory state.
8. Use `pln soup list`, `pln soup show`, and `pln soup summary` to identify items needing attention.
9. If a specific update or audit is warranted, set or replace a selected candidate with `pln soup set-candidate`.
10. Create explicit review work with `pln soup request-review`.
11. Preserve results with `pln soup add-review` and `pln soup decide`.

## Executing a preserved single-item review request

When the operator asks a fresh agent to "pick a SOUP item requested for review and perform analysis",
do not improvise from chat memory alone.

1. Start from the canonical preserved request inventory under `dev/soup/requests/` and open one actionable single-item request.
2. If there is no actionable single-item request, or the available request is explicitly batched, stop cleanly and route to explicit request creation or selection or the batched workflow below.
3. Extract the exact `requested_versions` and `candidate_versions` bindings for the selected item from that request before running helpers.
4. Load the governed-item context with `pln soup show <item-id>` so current version, selected candidate, monitoring state, and prior evidence are visible.
5. Determine whether the request should be handled as lighter `analysis`, baseline `audit`, or update `audit` from preserved audit lineage and the request-bound target version rather than from vague intuition.
6. Pass the request-bound target versions explicitly into helper payloads such as `from_version`, `to_version`, `version`, `audited_from_version`, and `requested_target_version`; do not rely on helper defaults when the request targets a specific reviewed version.
7. For a baseline audit, use the repo-owned helpers and normal agent investigation to review the actual published or otherwise reviewed package or codebase as broadly as practical, including suspicious-code review, testing posture, maintenance activity, vulnerability or advisory checks, and residual uncertainty.
8. For an update audit, use the repo-owned helpers to gather real comparison inputs from the authoritative currently audited version to the preserved requested review target version, then inspect actual source or released-artifact changes when practical instead of relying on changelog summaries alone.
9. Treat helper outputs as preparation, not verdicts. Use prepared temp-workspace paths, preserved bundle paths, project URLs, release files, changelogs, and normal agent investigation to determine what changed and what remains uncertain.
10. When bounded proof-of-work is worth retaining, preserve it under `dev/soup/evidence/` and record only stable bundle names in the review artifact.
11. Preserve the actual review with `pln soup add-review`, including audit-basis, audited-from, reviewed-source-basis, code-or-diff-review status, and assurance-signal metadata when the work is an audit, then preserve the outcome with `pln soup decide`.

## Batched workflows

When the user wants to review several items at once:
1. Start from an explicit selected set from `pln soup list --needs-attention`, `pln soup summary`, or an item list supplied by the user.
2. Preserve that work set first with `pln soup request-review --mode analysis|audit ...`.
3. If helper work is needed, run the relevant project-owned helper per selected item.
4. If agent fan-out is justified, keep it explicit and cost-aware. One subagent per selected item is usually enough.
5. Reduce results back into preserved review artifacts and then record decisions. Do not leave the outcome as transient parallel chatter only.

## Evidence quality

For meaningful SOUP reviews, preserve:
- audit basis when the review is an audit
- authoritative audited-from version when the review is an update audit
- exact reviewed version
- requested review target version when relevant
- selected candidate version when relevant
- reviewed source or artifact basis
- scope
- method
- whether real code or diff review occurred
- assurance signals checked
- findings state
- concise findings summary
- project-specific impact
- residual uncertainty
- related source references or tasks when they materially support the review

For decisions, preserve:
- the decision itself
- the current and candidate version context
- the supporting review slugs
- rationale
- follow-up work when applicable
