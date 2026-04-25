---
name: pln-inbox
description: Capture raw ideas, bugs, observations, regressions, friction notes, and unexpected behavior into dev/inbox with minimal friction. Use when the user reports something they noticed, describes a bug or odd behavior, mentions usability friction, or shares an observation discovered during implementation, debugging, review, or testing, including cases where they also want another action such as fixing it. Also use when the user wants to jot something down quickly, triage a thought before planning, or preserve a bug/idea without doing full requirements work yet. Also use when user wants to brainstorm larger changes or rewrites.
---

# Inbox

## Quick Start
Default workflow:
1. Decide whether this is ordinary capture or a spec-shaped brainstorming session. Ordinary capture is the default.
2. Use ordinary capture for cheap notes, bugs, observations, rough ideas, and small requests.
3. Use the spec-shaped path only when the user is seriously iterating on a larger feature, refactor, interface redesign, or architectural change and wants the thinking preserved as a durable working document.
4. Read the current `pln inbox --help` output before mutating inbox items so the skill follows the live CLI surface.
5. Create or update inbox metadata through the CLI so metadata/frontmatter stays CLI-owned.
6. If the item is spec-shaped, load [references/spec-writing.md](references/spec-writing.md), [references/section-guide.md](references/section-guide.md), and [references/review-checklist.md](references/review-checklist.md), then edit the inbox body directly with normal document editing tools instead of trying to manage a long spec body through repeated `pln inbox update --body` replacements.
7. If the user makes a clearly emphasized human directive that appears authoritative and whose exact wording would be costly to lose, preserve that wording promptly as a captured reference even at inbox stage, but keep that as a narrow exception rather than the new default for ordinary capture.
8. If you can produce a cheap reproducer for a claimed bug or strange behavior, you may create temporary proof that demonstrates the failure and link the evidence in the inbox item. Do not leave failing tests enabled in the committed test suite during inbox capture; preserve the repro as notes, skipped test code, or a separate artifact until the item is promoted into planning and implementation work.
9. Optionally show the item or the open inbox list.

Prefer speed over completeness for ordinary capture. The inbox is for capture first, not full planning by default.

## Instructions
- Keep capture cheap. The inbox exists so ideas are not lost before they can be interpreted later.
- Keep ordinary capture cheap. Do not route every brainstorm through a heavy spec-writing workflow.
- Inbox items have no traceability requirement at capture time.
- Do not force requirements language here.
- Do not normalize a rough thought into a polished requirement during capture.
- Preserve uncertainty, contradictory observations, rough reproduction notes, and source excerpts when they matter.
- If the user clearly marks part of the discussion as non-negotiable, preserved behavior, or "this has to work this way," distinguish that fixed directive from nearby brainstorming instead of flattening the whole note into one authority level.
- When such a directive is clearly authoritative and its exact wording matters, preserve the raw wording promptly as a captured reference even before intended-purpose or stakeholder-requirement promotion is fully settled.
- When you do that at inbox stage, also leave a durable planning handoff in repository artifacts so the preserved wording does not remain detached source text; the captured wording is temporary basis pending promotion into intended purpose or stakeholder requirements.
- If the wording is strong but it is still ambiguous whether the user is setting enduring project direction or merely thinking out loud, keep capture lightweight, preserve the wording as source context, and hand that ambiguity to planning instead of silently promoting it.
- If the user is clearly using the session to think through a larger change and wants that thinking to survive compaction or later sessions, it is valid to use an inbox item as a spec-shaped working document instead of a short note.
- Even when the inbox body becomes spec-shaped, it is still inbox-stage source material and pre-planning working context, not a substitute for stakeholder requirements, system requirements, architecture, or a ready task.
- For that spec-shaped path, start by creating or updating the inbox item through `pln inbox` so slug, type, status, author, and frontmatter stay CLI-owned.
- For that spec-shaped path, edit the inbox body directly with normal document editing tools. Treat the markdown body as the working spec document; do not hand-edit frontmatter.
- When the body becomes a working spec, load [references/spec-writing.md](references/spec-writing.md) first and use [references/section-guide.md](references/section-guide.md) and [references/review-checklist.md](references/review-checklist.md) as supporting guidance.
- Use that copied spec-writing guidance to shape durable brainstorming source material, not to force full planning ceremony into the inbox stage.
- Do not pretend every spec-shaped inbox item is fully mature on day one. It can start rough and become more structured over time.
- Prefer `request` for spec-shaped work about a desired change; keep `idea` for intentionally rougher exploration.
- Use `bug` for broken behavior or regressions that need to be preserved and investigated.
- Use `observation` for notes, findings, reproduced behavior, or source material that should be preserved without implying a requested change yet.
- Use `request` when the user is describing a desired change, improvement, or new capability.
- Use `idea` for rougher thoughts that are not yet a specific request.
- If an older inbox item still carries legacy `feature` metadata, preserve ordinary workflows and retag it to `request` when that is the clearer current type.
- Keep the title specific enough to be distinguishable in a list.
- Put screenshots, logs, meeting notes, source quotes, or reproduction notes into the body when available.
- If one note actually contains several unrelated issues, split it only when that materially improves later retrieval or planning. Do not over-structure by default.
- If the user is continuing triage on an existing item, update it through the CLI.
- If they want to add notes without replacing earlier context, prefer append-style updates rather than overwriting the body.
- For short inbox notes, CLI append and replace flows are still fine. For long spec-shaped inbox documents, prefer direct body edits for section-level revisions rather than replacing the whole body through the CLI.
- Determine `author` explicitly before creating a new inbox item; do not rely on the CLI default and do not let it vary accidentally.
- If the note's substance clearly comes from the user, pass `--author` using the best-known human attribution: use an explicitly named third-party author when the user gives one, use that third party when it is clearly implied, and if a third-party author seems likely but is not clear enough, ask for clarification. Otherwise resolve local git identity with `git config --get user.name`, falling back to `git config --get user.email`.
- If the agent independently decided to create the inbox item from its own review, analysis, or initiative, pass `--author` as a stable agent identity.
- Do not use the runtime/model name as the author for a user-originated note.
- If they decide the item should become work, move to the planning workflow rather than inventing requirement links or implementation scope inside the inbox item.
- If a spec-shaped inbox document solidifies into authoritative planning decisions, move that settled content into the planning workflow instead of leaving the long-term project contract only inside inbox prose.
- If the conversation reveals that the current inbox type is misleading, correct it explicitly instead of silently leaving misleading metadata behind.

## Gotchas
- Inbox capture is intentionally cheap. Do not over-structure it.
- Do not turn every brainstorm, request, or bug note into a full spec.
- Do not hand-edit frontmatter in `dev/inbox/*.md`; use `pln inbox` commands.
- Do not mistake a spec-shaped inbox document for an authoritative planning artifact; move settled requirements, architecture, and implementation work into the planning workflow deliberately.
- Do not use `pln inbox update --body` for large section-by-section rewrites of a spec-shaped inbox document when a direct body edit is the safer tool.
- Do not invent `traces_to` links at capture time unless the user already knows them confidently.
- Keep titles user-meaningful; avoid generic labels like `idea` or `bug` by themselves.
- A capture item can be valuable even when it is contradictory, speculative, or eventually rejected later.

## Validation
Before finishing:
- Confirm whether the session used ordinary capture or the spec-shaped brainstorming path.
- Confirm the created slug or resolved slug.
- Confirm the stored type and status.
- Confirm the body preserves the important source context the user wanted to keep.
- If the user asked to preserve existing notes, verify append mode was used instead of body replacement.
- If the item is spec-shaped, confirm metadata/frontmatter remained CLI-owned and the body became or remained the working spec document.
- If clearly authoritative human wording was captured as a narrow exception, confirm the exact wording was preserved and the result points back into planning rather than remaining detached preserved text.
