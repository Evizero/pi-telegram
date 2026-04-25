---
name: pln-purpose
description: Lead an interactive intended-purpose writing session for dev/INTENDED_PURPOSE.md and revise that document cleanly over time. Use when the project is fresh or pretty much new and there is no dev/INTENDED_PURPOSE.md yet, or when the user wants to define what the product is, sharpen scope boundaries, clarify who it serves, or improve an existing intended-purpose draft.
---

# Purpose

## Principles

1. **Orientation, not information.** Every paragraph must orient the reader toward a judgment about what belongs or resolve a tension that makes the product non-obvious. If a paragraph merely informs without changing how the reader thinks, cut it. This is the primary quality rule.

2. **Constructive adversary.** Challenge vague wording, propose sharper alternatives, refuse to bless text that could describe a different product. Do not take dictation.

3. **Earned voice.** The document should sound like a clear-eyed engineer explaining a design thesis to a smart peer — confident, direct, grounded, calm. Not promotional, not bureaucratic, not hedge-worded.

4. **Alignment instrument.** The intended purpose is not just a scope filter. It is one of the primary ways human intent survives into later agent work across sessions, contributors, and time. It is the acceptance criterion for requirements themselves and the root of the traceability chain. If a proposed requirement does not serve the purpose, it is out of scope regardless of who proposed it. Preserve what the human actually cares about strongly enough that later work stays aligned with it rather than drifting toward a thinner proxy.

5. **Truth-seeking over affirmation.** Do not treat the user's current framing as something to decorate. Use web research to strengthen, challenge, or falsify the draft understanding. Separate sourced facts, informed inferences, and unresolved hypotheses. If the available evidence weakens the current thesis, say so plainly.

## Quick Start
1. Read `dev/INTENDED_PURPOSE.md` if it exists.
2. Determine whether the user wants to define, revise, or just inspect the intended purpose.
3. If writing, revising, or reviewing, read `references/intended-purpose-guide.md` before proceeding.
4. Read any documents that provide relevant context: README, existing requirements, code.
5. Run a web research pass unless the user explicitly forbids browsing. Search for the product category, adjacent tools, user complaints, durable constraints, market or regulatory realities, and real-world examples that either support or challenge the draft thesis.
6. Form an informed hypothesis about the product's purpose, users, and boundaries from the repository context plus the research pass. Present that hypothesis for the user to react to, correct, or sharpen — do not open with broad questions.
7. Refine through conversation until the core purpose, intended users, use environment, scope boundaries, and north-star orientation are clear.
8. For thesis-heavy products, extract the opening skeleton before drafting: world before the product, recurring failure, grounded basis, governing insight, conceptual distinctions, obvious adjacent version, wrong-product readings to reject.
9. Draft or revise the document section by section. Write the prose directly.
10. If the user asked for intended-purpose work, stop at the intended-purpose stage by default. Do not autonomously switch into planning because of generic momentum, agent initiative, or just because requirements, architecture, or tasks now seem like the obvious next step. Only move into the next stage when the user explicitly asks for it or strongly implies that next-stage transition with specific direction.

## Instructions

### Conversation
- Treat this skill as intended-purpose work, not downstream planning. Finish the intended-purpose stage cleanly and stop by default instead of sliding into requirements, architecture, or tasks on generic momentum, agent initiative, or an "obvious next step" alone.
- Do not interview the user. Read the available context — code, README, existing docs, conversation history — and form a hypothesis first. Present it as a concrete draft position the user can agree with, correct, or be pedantic about. "From the code and README, this looks like X because Y — is that right, or is the real motivation different?" is better than "What problem does this solve?"
- When the user corrects or sharpens a point, reflect back the improved version immediately so they can confirm or push further. Make it easy for them to say "yes" or "no, more like this."
- When you need to explore boundaries, offer concrete candidate positions rather than open-ended questions. "Should this be understood as X and explicitly not Y?" is better than "What are the scope boundaries?"
- Use comparisons to known products or tools to sharpen understanding. The comparison should reflect your actual current understanding, not be strategically simplified. If you already see the differences, say so: "This looks like Linear in that it tracks work items, but the differences seem to be X, Y, Z — is that the right picture?" If you genuinely do not yet see the distinction, a simpler comparison like "So this is basically Linear but in the repo?" is honest and will draw out a useful correction. Either way, comparisons give the user something concrete to react to.
- If the user is uncertain, propose candidate wording and ask them to choose or refine.
- Scale orientation depth to the product. Simple products need a short opening. Thesis-heavy products may need explicit `Motivation`, `The insight`, or `Conceptual model` sections.
- If grounding is still thin, say so plainly and frame it as hypothesis.
- Preserve persuasive or explanatory prose when it is doing real alignment work. Do not flatten a product's motivating thesis, grounded context, worldview, or conceptual distinctions into sterile generic statements when those ideas guide later work.
- Treat the intended purpose as the current product identity, not a history of how the project discovered that identity. If the product has pivoted, revise the purpose so it states the settled present thesis cleanly; preserve pivot history only when it helps interpret the current identity, scope boundary, or rejected adjacent product.
- When a clearly emphasized human directive defines product identity, scope boundaries, motivating orientation, or enduring philosophy, treat that directive as intended-purpose material rather than forcing it down into stakeholder requirements only.
- Preserve the raw wording of such purpose-level directives promptly through the intended purpose document's `Traceability` section as informative basis while keeping `References` reserved for external sources.
- Keep upstream authoritative-source links in `Traceability` distinct from the downstream requirements, architecture, and tasks the purpose anchors.
- If a directive may belong at the purpose layer but that placement is not yet settled, record a durable planning handoff instead of normalizing the point without preserved source basis.
- Keep architecture and implementation details out of the purpose document. Capture them in deferred scope or inbox for later.
- Keep a firm boundary between conceptual model and architecture. It is valid for purpose to explain how to think about the product; it is not the place to prescribe module boundaries or runtime structure.
- If the project already has requirements, make sure the revised purpose still supports them. Material purpose changes are major events that may require downstream review.
- When the existing file still contains scaffold markers, replace them rather than layering notes around them.
- Keep good hierarchical hygiene. Do not shoehorn architecture, requirements, or implementation notes into the purpose document.

### Research and truth discipline
- Use web search early when drafting or materially revising intended purpose. The point is not trend-spotting. The point is to find reality that either supports or weakens the emerging thesis.
- Prioritize evidence that exposes actual operating conditions: primary sources, technical docs, regulations, case studies, postmortems, public issue threads, practitioner writeups, credible market data, and firsthand accounts of workflow pain.
- Search for both support and challenge. Look for counterexamples, competing tools, failed adjacent approaches, user complaints, adoption barriers, and constraints that make the problem harder than the current draft admits.
- Distinguish three classes explicitly in your reasoning and summaries: sourced fact, inference from sources, and unresolved hypothesis.
- When external research materially informs the draft, include a `References` section in `dev/INTENDED_PURPOSE.md` for external sources only.
- Do not list repository-local files in `References`. Local planning artifacts belong in `Traceability`, surrounding prose, or the drafting context, not in the external-source list.
- Prefer paraphrase. Quote only when exact wording matters, and keep quotations short and clearly attributed.
- Prefer Markdown footnotes for sentence-level source references when the document uses external evidence.
- Put the footnote marker at the end of the supported sentence or sentence group.
- Every direct quote or externally grounded claim that matters to the thesis should be traceable to a concrete external source entry.
- If the repository framing and outside evidence diverge, say so. Do not silently resolve the conflict in favor of the more flattering or more familiar story.
- Use research to sharpen the product's distinct identity, not to force it toward the average public-data version of the category.
- When a strong external claim matters to the draft, cite or summarize the supporting source instead of presenting it as obvious truth.
- When research is thin, noisy, or contradictory, say that plainly and keep the language appropriately provisional.
- If browsing is unavailable or disallowed, say so explicitly and treat the result as less grounded.

### What to resolve
These are things you need answers for — not questions to ask the user directly. Form hypotheses from context and present them for reaction.
- The recurring failure this product exists to correct, and why existing approaches are not enough.
- The key insight or thesis behind the product — the non-obvious belief that shapes it.
- What an uninstructed agent would most likely assume this product is, and why that is wrong.
- What matters enough that later planning would be misaligned if it optimized against a narrower proxy.
- The durable facts or operating conditions that make the problem real.
- What external evidence supports the claimed failure mode, and what evidence complicates or contradicts it.
- Which adjacent products or public framings are close enough to hijack the definition if they are not rejected clearly.
- The intended users, the use environment, and where the product stops.
- When the product depends on a conceptual model: the important layers or distinctions, why they must stay separate, and what category mistakes later contributors should avoid.

### Section challenges
When drafting or reviewing each section, apply these rather than relying on generic quality checks:
- **Motivation:** If this could describe three other products, rewrite it. If the failure mode is something everyone already knows, you have not found the real one yet. What outside evidence shows this failure is recurring and durable rather than just locally annoying?
- **The Insight:** If this does not make someone reconsider their default assumption about the product, it is not an insight. If you cannot name the wrong version it argues against, it is not sharp enough. What evidence suggests this insight is necessary, not just elegant?
- **Product:** Could someone restate it from memory? If not, too long. Could someone swap in a different product name? If so, too generic. Which adjacent products or categories must be named and rejected so the definition does not drift?
- **Conceptual model:** If the distinctions would not change how someone makes a scope decision, they are not doing work.
- **Scope boundaries:** Name three features a reasonable person would expect. Are all three addressed — included or excluded with reason?
- **Use environment:** If this could describe any CLI tool or any SaaS product, it is not specific enough. What real-world operating conditions or user constraints from research make this environment specific?

## Gotchas
- Do not turn the purpose into a feature list.
- Do not let every section devolve into bullets. Use lists only when enumerating independent items.
- Do not confuse purpose with requirements, architecture, or implementation.
- Do not flatten a product's motivating thesis or conceptual model into generic statements when those ideas guide later alignment.
- Do not let thesis-heavy sections turn into manifesto or marketing copy. They should explain reality, tension, and approach.
- Do not abstract away named artifacts, workflow stages, or source-backed examples that make the thesis understandable.
- Scope boundaries matter as much as the positive description.
- A vague section is worse than an obviously unfinished one.
- Do not present a public-market stereotype as grounded truth when the evidence is thin or contradictory.
- Do not use web research as decoration. If the sources do not materially sharpen or challenge the purpose, keep searching or say the grounding is weak.
- Do not pad `References` with local repo documents, internal notes, or sources that were not actually used to ground the argument.

## Validation
Before finishing, run the quality tests from `references/intended-purpose-guide.md`, and check:
- The opening explains a real failure mode, states a governing thesis, and leaves the reader oriented — not just informed.
- Three plausible feature proposals could be judged in or out of scope.
- The draft preserves what the human actually cares about strongly enough that later agent work would not drift toward a thinner proxy.
- The obvious adjacent version of the product is visible and rejected clearly enough that an uninstructed agent is less likely to build the wrong thing.
- The strongest external claims in the draft are backed by actual research, and any important contradiction or uncertainty is surfaced rather than buried.
- The writeup is honest about what is sourced fact, what is inference, and what remains hypothesis.
- The writeup reads as the current coherent product identity rather than a patch log of earlier pivots.
- If a `References` section is present, it contains only external sources that materially informed the document, and any quote-worthy wording is attributed cleanly.
- If authoritative human directives shaped the purpose, their raw wording is preserved through `Traceability` as informative basis rather than being misplaced into `References`.
- The prose sounds like a design note, not product copy.
- The document would still help make scope decisions six months from now.
