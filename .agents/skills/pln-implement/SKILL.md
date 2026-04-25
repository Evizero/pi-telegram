---
name: pln-implement
description: Execute a task from dev/tasks by grounding the work in the current codebase, making the necessary changes, and keeping the task artifact truthful as implementation progresses. Use when the user wants to work on a specific task, choose an active or ready task to implement, drive an implementation loop until the work is ready for close-out, or asks to finalize or commit completed tracked work unless they clearly want only a checkpoint or WIP commit.
---

# Implement

## Quick Start
Default workflow:
1. Identify the task to work on. If the user has not named one, inspect the current task list and agree on the right active or ready task first.
2. Load `pln task context <slug>` and read the bundled context. This is the canonical context-loading surface for implementation work and includes intended purpose, active definitions, requirement inventories, architecture, the task, and directly traced requirement detail in one place.
3. Assess whether the task is still fresh enough to implement as written by checking the bundled context against the current codebase, traced requirements, architecture, and any linked verification-case planning context surfaced for directly traced SyRS.
4. If the task is untraced or the bundle reveals likely nearby interactions, inspect the relevant requirement records directly before coding.
5. Ground your understanding in the codebase. The task defines scope, but the code often reveals how that scope should actually be implemented. Make sure you understand the relevant code patterns, interfaces, and existing implementations before you start coding.
6. If the task is directionally right but stale, refresh the task body and decisions before broad coding, or return the work to planning if the gap is larger than a local implementation clarification.
7. For cross-cutting or risky work, give a brief pre-edit impact preview before broad edits so the expected files, planning-artifact touchpoints, validations, and risks are explicit.
8. Implement the task and write good behavioral tests. Good tests should provide proof or at least high confidence things work as intended (not how it was implemented), and they should also cover important edge cases and failure conditions rather than just the happy path.
7. Make sure tests, formatting, and lints pass.
8. Start a read-only `explorer` review subagent pinned to `gpt-5.5` with high reasoning, or to `Opus 4.6` with high reasoning only when `gpt-5.5` is genuinely unavailable in the current environment, and have it review the current tree or diff. The prompt must include the exact scope under review, what unrelated worktree changes to ignore unless directly relevant, concrete review criteria covering bugs, regressions, requirement mismatches, missing tests, and edge cases, and a strict output contract of either `Findings:` with file references or exactly `No findings. ...`, and it should avoid `fork_context: true` by default.
9. If the work involved a merge, conflict resolution, cherry-pick, or manual transplant from another branch, make the review read the original commit diff(s) that were supposed to land as well as the final merged tree/diff so it can check that the intended changes and behaviors were actually preserved in the unified result.
10. If the review reports findings, fix them, rerun the relevant validations, and then start a fresh review subagent on the updated tree.
11. If the review replies without a concrete `Findings:` block or `No findings. ...` verdict, treat that as a review failure rather than a clean pass. retry once with a narrower prompt, exact file scope, `gpt-5.5` with high reasoning, or `Opus 4.6` with high reasoning only when `gpt-5.5` is genuinely unavailable in the current environment, and no `fork_context`, and keep task status truthful if the review transport still fails.
11. For merge-aware review, keep repeating the merge-review loop until the latest review run, performed after your latest fixes, reports no findings about preservation of the source branch behavior in the merged result.
12. Only treat the review loop as complete when the most recent review run, performed after your latest code or task changes, reports no findings. Fixing the findings from an earlier review is not enough by itself.
13. Compare against the task objective, acceptance criteria, and traced requirements one more time to confirm the work is genuinely ready for close-out rather than just partially implemented and it doesn't conflict with other requirements.
14. Update task body, decisions, and status as reality becomes clearer.
15. If that comparison or task update causes further changes, rerun the review loop again until the latest review run is clean and the work is genuinely ready for close-out.
16. Make sure the task is up to date with the implementation and reflects any important discoveries or decisions.
17. If the user asked for implementation work, stop at the implementation stage by default. Do not autonomously switch into close-out just because the work now looks done. Only move into the next stage when the user explicitly asks for it or strongly implies that next-stage transition with specific direction.

## Instructions
- Focus this skill on implementation workflow, not on prescribing coding technique. The important question is what to implement, how it fits the codebase, and how to keep `pln` artifacts aligned with reality while you do it.
- Finish the implementation stage cleanly and stop by default instead of sliding into close-out on generic momentum, agent initiative, or an "obvious next step" alone.
- If the task is bug-shaped, call that out explicitly. Prefer a failing automated regression test as the first implementation proof when practical. If a stable regression test is not yet practical, say that plainly before treating the fix as adequately proven.
- Start by making sure you are working on the right task. If several tasks are plausible, inspect the open task set and choose explicitly instead of drifting into arbitrary work.
- Treat the task as the implementation scope anchor.
- Start from `pln task context <slug>` as the default implementation briefing surface, then drill into individual files or requirement records when the bundled view reveals uncertainty, nearby coupling, or a likely planning gap.
- When project-specific terminology matters, treat active definitions loaded through task context or `pln defs show` as the authoritative meaning source instead of inferring that meaning from surrounding prose.
- Treat the requirements traced directly by the task and `dev/ARCHITECTURE.md` as the primary detailed constraints for implementation.
- When direct SyRS context includes linked verification cases, treat them as planned coverage context only. They help show intended verification shape and traceability, but they are not objective evidence and they do not by themselves prove `SyRS.status=verified`.
- Treat locator-free verification cases as legitimate planned verification intent whose evidence location is not yet planned. Treat missing locator targets as planned evidence locations that are not yet discoverable. Do not create placeholder locator files during implementation merely to make planning or status output cleaner.
- When traced or nearby requirements are imposed, or when they carry linked captured references, treat them as harder change boundaries than ordinary derived planning decisions.
- If implementation would change behavior governed by imposed requirements, read the linked captured-reference basis first when it exists and call out any apparent weakening or reinterpretation before proceeding.
- When linked captured references are relevant, treat their wording as informative interpretive basis for the constraint, not as replacement normative requirement text.
- When origin, rationale, or linked-reference provenance is part of the change, run and heed `pln hygiene`; the current CLI already warns on imposed requirements that are missing rationale or linked captured references.
- Treat `dev/ARCHITECTURE.md` as the design-and-boundary contract for the repository, not as a mere description of whatever the code happens to do today. If the code and architecture disagree, make the mismatch explicit and resolve it deliberately instead of silently following drift.
- The default pattern is: compact whole-project requirement awareness through `pln strs summary` and `pln syrs summary`, full detail for the requirements directly relevant to the task.
- Ground understanding in the code before assuming the task body already tells you every implementation detail. Tasks often define the objective and acceptance shape, while the codebase reveals file placement, existing patterns, interfaces, and edge conditions.
- If the compact summary map or the code reveals a likely interaction the task did not mention, inspect the relevant requirement details in full and document the planning gap and resulting decisions instead of silently compensating for it.
- Do not assume a task marked `ready` or revisited in `active` state is fresh enough to implement. Check whether its objective, constraints, preserved behavior, and acceptance shape still match the current requirements, architecture, and codebase.
- Do not treat a task in `ready` or `active` status as implementation-ready unless it traces to at least one SyRS. If such a task still lacks a SyRS trace, call that out explicitly as a planning gap and stop implementation work instead of proceeding silently.
- If the task is directionally right but stale, refresh the task artifact before coding so the implementation record stays truthful.
- If the gap is really a planning gap rather than a local implementation clarification, stop and return the work to planning instead of silently improvising new scope.
- If implementation reveals a newly stated or newly clarified human non-negotiable that is not yet anchored upstream, do not treat the transient session context alone as sufficient authority. Preserve the wording through captured-reference or durable planning-handoff paths and call it out as a planning gap before relying on it as long-term project truth.
- For cross-cutting or risky work, provide a short pre-edit impact preview that names the likely code areas, likely planning artifacts to touch, the intended validation scope, and the main uncertainties. Keep the preview lightweight; its purpose is to make blast radius and execution intent explicit, not to create a second task inside the conversation.
- If the missing detail is local, implementation-level, and can be resolved by understanding the existing code and architecture, proceed and record the decision in the task when it matters.
- Read current `pln task --help`, `pln strs --help`, and `pln syrs --help` output before mutating task metadata or drilling into requirement details so the skill follows the live command surface.
- Update task metadata through `pln task update`, not by editing frontmatter manually.
- A clean review means a fresh review run over the current tree after the latest code, test, or task changes. Do not infer a clean review just because you fixed the findings from an earlier review run.
- When the work being reviewed came through a merge or manual conflict resolution, tell the reviewer which commit diff(s) were meant to land and ask it to compare those intended changes and behaviors against the merged result rather than reviewing only the final tree in isolation.
- Treat merge-aware review as its own review loop: after each merge-preservation finding, fix the issue, rerun validations, and launch another merge-aware review that again checks the source diff(s) against the merged outcome.
- After every meaningful fix batch prompted by review findings, rerun the relevant validations and launch another review subagent. The last review-related state before you declare the task ready should normally be a review run that itself reports no findings.
- Prefer a read-only `explorer` agent for review-only passes instead of a worker.
- Treat a reviewer response without a concrete findings verdict as a tooling failure, not as a clean review.
- If the first review attempt does not return `Findings:` or `No findings. ...`, retry once with a narrower prompt, narrower scope, and explicit file ownership before declaring the review loop blocked.
- Wait for the active review subagent to finish before declaring the review loop complete, and close completed review agents once their result has been captured.
- If implementation exposed a real planning gap, contradiction, or missing requirement link, note it explicitly instead of compensating silently in code.
- Never edit or add requirements unless asked by the user. If user interaction reveals the intent to change requirements, point that out explicitly and write down decisions in the task such that later planning work can consider whether the requirement should actually be updated.
- Record non-obvious implementation decisions with `pln task decide` right away.
- If the task still contains placeholder or stale body content, replace or refine it when implementation understanding becomes concrete enough to improve the task artifact.
- If implementation discoveries materially change scope, preserved behavior, code placement, or validation expectations, update the task body so later review does not depend on reconstructing those changes from code diffs alone.
- Keep the task artifact truthful and up to date.
- If the user explicitly asks to finalize, wrap up, close out, or commit completed tracked work, or otherwise strongly implies that specific close-out transition, treat that as next-stage direction toward close-out rather than as a pure git action. A plain request to commit can still mean checkpoint or WIP and is not enough by itself.
- Before making a completion-oriented commit for tracked work, load the pln-close skill and make task status, decisions, traceability, and archive readiness truthful unless the user clearly wants only a checkpoint or WIP commit.
- Do not assume archive and final task edits collapse into one commit. If close-out changes the live task artifact, the archive model may require one commit for the final live task state and a follow-up commit after `pln task archive` deletes the file.
- When the code and task are genuinely ready for close-out, do not switch stages on your own. Load the pln-close skill only when the user explicitly asks for close-out or strongly implies that next-stage transition with specific completion-oriented direction.

## Gotchas
- Do not start coding before you know which task you are implementing.
- Do not treat the task body as a complete implementation spec when the existing code clearly provides essential context.
- Do not hand-edit task frontmatter.
- Do not leave task status stale after meaningful progress.
- Do not stop right after applying fixes from a review that found problems; rerun review on the updated tree first.
- Do not ask for a merge-resolution review that only inspects the final tree when there is a concrete source diff showing what was supposed to be preserved.
- Do not treat a completion-oriented "commit this" request as purely a git action when the surrounding context strongly implies the tracked work is done; close the task cleanly first unless the user clearly wants a checkpoint or WIP commit.
- Do not record important decisions only in code comments or commit diffs; preserve the reasoning trail in the task.
- Do not silently invent new scope when the task is underspecified.

## Validation
Before finishing:
- Confirm you worked on an explicitly chosen task rather than drifting into untracked implementation.
- Confirm the implementation still matches the task objective and the requirements traced directly by the task.
- Confirm no task in `ready` or `active` status was treated as implementation-ready without at least one SyRS trace, and that any such missing trace was treated as a planning gap instead of being silently bypassed.
- Confirm imposed requirements and linked captured references were treated as stronger constraints when they were relevant to the change.
- Confirm linked captured-reference wording, when relevant, was treated as informative interpretive basis rather than as replacement normative requirement text.
- Confirm the task was fresh enough to implement as written, or that you refreshed it before broad implementation work.
- Confirm any newly surfaced or newly clarified human non-negotiables that were not yet anchored upstream were treated as planning gaps rather than as transient authority.
- Confirm the latest review run happened after the latest implementation changes and returned no findings.
- If the work included a merge or conflict resolution, confirm the latest review also checked the intended source commit diff(s) against the merged result and that this merge-aware review loop ran until no preservation findings remained.
- Confirm the task body and decisions reflect important implementation discoveries.
- Confirm cross-cutting or risky work had an explicit pre-edit impact preview before broad edits.
- Confirm task status reflects reality.
- If a completion-oriented commit or wrap-up happened, confirm the task was either closed and archived or explicitly left open for a stated reason.
- Confirm any important implementation tradeoffs were logged in the task decisions.
