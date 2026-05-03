---
name: pln-close
description: Close out implemented work by checking task and requirement alignment, tightening traceability, updating unreleased changelog evidence when release-notable, updating task and commit hygiene, and preparing the work for archive. Use when implementation is substantially done and the user wants to confirm the planning system matches reality, finalize trace links, close a task cleanly, prepare completed tracked work for commit, decide whether work belongs in CHANGELOG.md, or otherwise wrap up finished work rather than making only a checkpoint or WIP commit.
---

# Close

## Quick Start
Default workflow:
1. Read the task file and its current status.
2. Read `pln strs summary` and `pln syrs summary` so the broader requirement space is visible while closing, and use `list` if you need full statements in view.
3. Read the traced SyRS entries, including any linked verification cases surfaced in task or SyRS context, any nearby imposed upstream requirements or linked source references they depend on when relevant, and `dev/ARCHITECTURE.md`.
4. Read active project-local definitions when the task, requirements, or implementation use project-specific terminology whose meaning could affect closure judgment.
5. Inspect the diff, changed files, and if asked or necessary recent commits that belong to the task.
6. If the work arrived through a merge, conflict resolution, cherry-pick, or manual transplant, inspect the original commit diff(s) that were intended to land and compare them against the merged result so closure does not miss dropped or altered changes.
7. Read current `pln task --help` output before any lifecycle mutation.
8. Check whether the implementation really matches the task objective, traced requirements, architecture boundaries, and any relevant active definitions.
9. Tighten or argue traceability links when implementation revealed missing, incorrect, or incomplete planning connections.
10. Check task decisions, commit references, changelog impact, and closure hygiene.
11. Decide whether the completed work is release-notable. If it is, update `CHANGELOG.md` under `[Unreleased]` with enough release-impact context for later version or tag decisions; if it is not, make that no-changelog decision explicit when it could otherwise be ambiguous.
12. Run or heed `pln hygiene` when provenance-sensitive work is in scope; the current CLI already warns on imposed requirements that are missing rationale or linked captured references.
13. If the work is truly ready, move it through `done`, commit the final live task state when close-out changed the task artifact, archive it, and then commit the archive cleanup.
14. If the user asked for close-out work, stop at the close-out stage by default. If closure finds a gap that belongs in planning or implementation, call for that handoff explicitly, but do not autonomously switch into the next stage unless the user explicitly asks for it or strongly implies that next-stage transition with specific direction.

## Instructions
- Treat this as post-implementation conformance and closure work, not ordinary code review.
- Finish the close-out stage cleanly and stop by default instead of sliding back into planning or implementation on generic momentum, agent initiative, or an "obvious next step" alone.
- Assume the implementation skill already owned the implement → self-review → fix loop. Your job is to make sure the planning system matches what was actually built.
- Review against the task's stated contract first.
- Use traced SyRS to check that the implemented behavior still matches the intended system behavior.
- If linked verification cases are present, use them to check the intended verification coverage shape and traceability, but do not treat them as recorded objective evidence or automatic proof that a requirement is actually verified.
- Do not treat locator-free verification cases or missing locator targets as close-out defects by themselves. They are maturity states: evidence location not yet planned, or planned location not yet discoverable. Only create or update concrete locators when real verification artifacts or genuinely planned evidence locations exist; do not add placeholder locator files to make close-out look clean.
- When traced requirements or their nearby upstream requirements are imposed, read their linked captured references when present and verify the implemented behavior still satisfies that governing basis.
- Treat linked captured-reference wording as informative interpretive basis for closure judgment, not as replacement normative requirement text.
- Treat `pln hygiene` as the shipped diagnostic backstop for provenance-sensitive closure work, especially when imposed requirements may be missing rationale or linked captured references.
- If a linked captured reference is superseded, invalid, or missing, call that out explicitly before closure instead of silently treating the chain as healthy.
- If close-out exposes a clearly emphasized human directive that appears authoritative but is not yet anchored upstream, preserve that wording through captured-reference or durable planning-handoff paths and send it back to planning explicitly instead of silently closing over the gap.
- Check for boundary violations against the architecture doc.
- Treat `dev/ARCHITECTURE.md` as the architectural contract and planning record for how the system should be organized. If implementation drifted from that contract, call it out explicitly instead of treating the drift as automatically acceptable.
- Do not approve vague success. Make the closure judgment explicit about what aligns, what does not, and what remains uncertain.
- If the task wording, acceptance criteria, or traced requirements are too vague to close responsibly, say so and recommend planning clarification instead of pretending the work is cleanly done.
- Tighten traceability where the implementation made the right links more obvious.
- Use the compact requirement summary inventories as a cheap cross-check for nearby requirements that may have been affected, constrained, or should now be linked more explicitly.
- If implementation exposed a real upstream gap, contradiction, or missing requirement, call that out explicitly. Create or recommend follow-up planning work rather than silently rewriting history to make the trace graph look cleaner than it really was.
- If you create a new follow-up inbox item from your own closure analysis, treat it as agent-originated and use a stable agent identity for `--author`; if you are capturing a follow-up the user attributes to someone else, use that explicit or clearly implied third-party author, and ask if authorship is still ambiguous.
- Check whether the task should trace to additional or different SyRS, and whether any current links should be removed or narrowed.
- Check that important implementation decisions were recorded in the task rather than living only in code or commit diffs.
- Check whether the work is release-notable before archive. Release-notable work includes user-visible CLI behavior, public API or schema changes, breaking compatibility, migration requirements, security changes, significant documentation changes, and significant research/report/data/model/knowledge outputs. Ordinary internal-only refactors, test-only maintenance, tiny cleanup, and minor documentation corrections are not automatically changelog-worthy.
- When release-notable work exists, update the top-level `CHANGELOG.md` under `[Unreleased]` before archive. Use only populated category headings from `Breaking`, `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Documentation`, and `Research`; do not leave empty template headings.
- Preserve release-impact context in changelog entries while task context is fresh: affected surface, compatibility impact, SemVer impact when the project uses SemVer for that surface, migration need, security relevance, documentation or research significance, and whether a notable non-software change has no SemVer impact.
- Make breaking changes explicit in a `Breaking` section or with an explicit breaking marker. Do not bury breaking compatibility under `Changed` or `Fixed`.
- Do not finalize a release, choose the final version, update release headings, tag, publish, or push from close-out unless the user explicitly asks for release finalization. `pln-close` maintains `[Unreleased]`; `pln-release` finalizes versions and tags later.
- Check commit hygiene on a meta level: when the team expects IDs or task references in commit messages, verify that the relevant commits point back to the right task or requirement context.
- When close-out follows a merge or conflict resolution, do not review only the resulting tree state; compare the intended source commit diff(s) to the merged outcome so dropped hunks or partially preserved behavior are caught before closure.
- If merge-aware review still reports preservation findings, return the work to implementation/review rather than closing it; closure requires that the merge-preservation review loop has reached a no-findings state.
- Read current `pln task --help` output before status or archive actions so the skill follows the live command surface.
- Treat user requests to finalize, wrap up, or commit completed tracked work as a strong cue to perform closure before the commit unless the user clearly wants only a checkpoint or WIP commit.
- If documentation or project knowledge may need curation, leave clear task decisions or follow-up context for the dedicated `pln-documentation` workflow, but do not update documentation/knowledge directly as an automatic close-out action.
- If the work is genuinely ready, update task status first. If close-out changed the live task body, decisions, or status, commit that final live task state before running `pln task archive`, then archive it with the CLI and commit the resulting archive cleanup separately.

## PLN commit-message conventions
These rules are PLN-specific close-out guidance. Use the general commit-message skill for evidence checks, coherent-slice selection, subject quality, split plans, and approval requirements.
The PLN init/upgrade meta-commit guide does not govern ordinary task close-out or archive lifecycle commits; use this section for those cases.

Commit type rules:

1. If the commit changes runtime behavior, use the normal runtime type such as `feat:`, `fix:`, `refactor:`, or `test:`. Supporting PLN artifacts may ride with that commit when they belong to the same coherent change.
2. If the commit changes only the meaningful PLN planning record under `dev/`, use `docs(pln): ...`.
3. If the commit only performs mechanical PLN lifecycle upkeep after the exact live state is already recoverable from Git history, use `chore(pln): ...`.
4. If the slice mixes unrelated runtime, planning, or archive work, split it.

Close-out examples:

- `docs(pln): close <topic> task`
- `chore(pln): archive <topic> task`
- `chore(pln): archive completed <theme> tasks`

Related archive deletions, such as a just-closed task and its linked source inbox item, may share one `chore(pln): ...` commit when they have the same truthful lifecycle reason. Do not bundle unrelated worktree changes into that archive cleanup commit.

## Gotchas
- This is not just "do the tests pass?" Passing validation is necessary but not sufficient for clean closure.
- Do not silently add traceability links when the right connection is still debatable.
- Do not archive work that still depends on unstated assumptions, missing requirement links, or unresolved architecture drift.
- Do not turn close-out into documentation curation; preserve breadcrumbs and let `pln-documentation` own the actual docs/knowledge update.
- Do not treat every documentation change as changelog-worthy; only record documentation work that is release-notable enough for future users or maintainers to see in release notes.
- Do not turn close-out into release finalization; preserve `[Unreleased]` evidence and let `pln-release` own version, release heading, and tag decisions.
- A closure pass that cannot explain its recommendation is not finished.

## Validation
Before finishing:
- Confirm you read the task body and current status.
- Confirm each acceptance criterion is addressed strongly enough to support closure.
- Confirm the traced SyRS still match the implemented behavior.
- Confirm imposed requirements, including nearby upstream imposed basis when relevant, and their linked captured references were checked explicitly.
- Confirm linked captured-reference wording was treated as informative basis for interpretation rather than as replacement normative text.
- Confirm `pln hygiene` was run or heeded when provenance-sensitive work could trigger shipped warnings about missing rationale or linked captured references.
- Confirm any newly surfaced authoritative human directive that is still unanchored upstream was called out as a planning handoff instead of being silently folded into closure judgment.
- Confirm the broader requirement map does not reveal an obvious missing, conflicting, or now-relevant neighboring requirement that closure should call out.
- Confirm architecture constraints were checked.
- Confirm traceability gaps, changes, or uncertainties were either resolved or explicitly called out.
- Confirm important implementation decisions are preserved in the task when they matter for future understanding.
- Confirm documentation/knowledge follow-up context is preserved when needed, without performing automatic documentation curation during close-out.
- Confirm changelog impact was considered, `CHANGELOG.md` was updated under `[Unreleased]` for release-notable work, and any no-changelog-needed decision is explicit when the choice could be ambiguous.
- Confirm changelog entries use populated headings from the approved category vocabulary and include breaking, compatibility, migration, security, documentation, research, and SemVer or release-impact context when relevant.
- Confirm close-out did not finalize a release, update a final release heading, create a tag, push, publish, or otherwise perform `pln-release` work unless the user explicitly requested that release step.
- Confirm commit/reference hygiene was checked at the level expected by the project.
- If close-out followed a merge or conflict resolution, confirm the intended source commit diff(s) were compared against the merged outcome and that merge-aware review reached a no-findings state before closure.
- Confirm your recommendation is explicit: close and archive, return to implementation, or send back to planning.
- Confirm the task lifecycle update happened if the work was closed.
