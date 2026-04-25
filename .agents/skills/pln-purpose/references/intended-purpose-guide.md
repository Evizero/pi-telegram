# Writing an Intended Purpose

Reference for drafting `dev/INTENDED_PURPOSE.md`. Read this before writing or revising.

The intended purpose is a **decision-making instrument** and an **alignment anchor**. Its job is to let someone — developer, agent, reviewer, future maintainer — take a proposed feature or requirement and answer "does this belong?" with a clear yes or no. It is the root of the traceability chain: if a proposed stakeholder requirement does not serve the intended purpose, it is out of scope.

It is also one of the main ways a repository preserves human intent for later agent work. In the AI age, the purpose document must carry enough of the product's motivating problem, governing thesis, and conceptual model that later work stays aligned with what the human actually cares about rather than drifting toward a thinner proxy.

It is not a feature list, a requirements document, a business case, an architecture document, marketing copy, or an aspirational statement. It describes the product's identity. It changes rarely because identity is more stable than features. The intended purpose is the document that says no.

The intended purpose is also not a changelog.
It should read as the current coherent product identity, even when that identity emerged through pivots or corrections.
If the product changed direction, revise the purpose toward the present settled thesis instead of layering historical exceptions around the old framing.
Preserve rejected alternatives and pivot reasoning only when they help explain the current boundary, and put that context in traceability, deferred scope, rationale-like prose, or a short named rejection of the obvious adjacent product.

---

## Truth-seeking

This workflow is not a branding exercise.
Its job is to discover the most defensible account of what the product is for.
That means actively looking for evidence that sharpens, weakens, or falsifies the current framing.

When drafting or materially revising an intended purpose, do one or more web research passes unless the user explicitly forbids browsing.
Use it to answer questions the repository alone cannot answer well:

- Is the claimed failure mode visibly real outside this repository?
- What durable operating conditions make the problem real?
- What adjacent tools or product categories will readers confuse this with?
- What user complaints, postmortems, or public writeups reveal the real pain?
- What evidence cuts against the current thesis?

Truth discipline rules:
- Prefer primary sources, technical documentation, regulations, public issue threads, case studies, operator writeups, credible market data, and concrete examples over generic category pages or marketing copy.
- Treat research as a challenge function, not a decoration function.
- Keep three buckets distinct in your own notes and in any user-facing summary: sourced fact, inference from evidence, unresolved hypothesis.
- If the evidence is thin, contradictory, or mostly anecdotal, say that plainly.
- If outside evidence conflicts with the user's current wording, surface the conflict instead of smoothing it over.
- When external research materially informs the draft, include a `References` section containing only external sources that actually shaped the document.
- Do not list repository-local markdown files, requirement registries, architecture docs, or other in-repo artifacts in `References`. Those belong in `Traceability` or in the drafting context.

For regulated domains, verify the current official source before relying on remembered guidance.
Regulations, standards status, agency guidance, and submission expectations change.
Use primary or near-primary sources such as regulators, standards organizations, notified-body guidance, and official framework documents before drafting strong claims about intended use, intended purpose, classification, labeling, validation, or quality-system duties.

---

## Voice

The target voice is a clear-eyed engineer explaining a design thesis to a smart peer.

Declarative — state what is, not what might be. Present tense, active voice.
Specific — concrete nouns, named users, named problems. If you can swap in a different product name and the document still works, specificity is missing.
Bounded — every positive claim paired with a real boundary.
Short — the core statement should fit in two to four sentences and be restatable from memory.
Grounded — strong claims anchored in observed workflow reality, domain constraints, or source material.
Calm — design note, not launch memo. No promotional rhythm.

Avoid: "robust," "seamless," "innovative," "state-of-the-art," "revolutionary," "transformative," "finally solves."
Avoid hedge words: "may be used to," "can help," "is designed to."

If the prose sounds like it could appear on a marketing website, rewrite toward shorter sentences, concrete nouns, and direct causal claims.

---

## Writing rules

**Primary quality rule:** every paragraph should either orient the reader toward a judgment — what belongs, what does not, why this approach — or resolve a tension that makes the product non-obvious. Paragraphs that merely inform without orienting are padding.

Write in paragraphs. This is a prose document, not a checklist. Headings give the argument shape; content under them should read like connected thought.

Default to prose for argument, motivation, and synthesis. Use short lists when they make categories, exclusions, or named distinctions easier to scan.

Keep the prose sharp: present tense, active voice, concrete nouns, short sentences, one idea per sentence, measurable or falsifiable wording. Put each sentence on its own line for editability.

Write from reality to thesis:
1. what is happening in the world today
2. what keeps going wrong
3. what durable constraint makes that a real problem
4. what product approach follows from that

If a claim could not be disproved, the wording is too soft.

Preserve persuasive or explanatory prose when it is doing real alignment work. Do not strip away motivation, worldview, or conceptual distinctions just because they are not schema-shaped. Do not abstract away the named artifacts, workflow stages, or source-backed examples that make the thesis understandable.

Common formatting moves:
- opening paragraph followed by a short list of concrete examples
- identity paragraph followed by a short "not this" list
- conceptual-model paragraph followed by a compact named set
- scope-boundary list followed by a short synthesis paragraph

---

## Research loop

Run this loop before you lock the document shape:

1. Form the first internal hypothesis from repository context.
2. Search the web for external grounding and counterevidence.
3. Compare the repository story with the external story.
4. Rewrite the thesis toward the most defensible version.
5. Tell the user where the grounding is strong, weak, or contradictory.

Useful search angles:
- category terms for the product and near-neighbor products
- recurring user complaints or failure modes
- regulations, standards, or compliance constraints that shape the space
- postmortems, migration stories, and "why we built X" writeups
- operational constraints that are unlikely to disappear
- obvious substitutes, competitors, or adjacent product framings

Questions the research should answer:
- What problem is actually recurring in the world, not just in one team's local story?
- What common framing would cause a new contributor or agent to build the wrong product?
- What evidence suggests the proposed insight is necessary?
- What facts make the problem durable instead of temporary?
- What loopholes appear in the current purpose if a skeptical reader pushes on it?

Do not dump a literature review into `dev/INTENDED_PURPOSE.md`.
Use the research to sharpen the claims, choose boundaries, and name the wrong-product readings.
If an external fact matters enough to carry argumentative weight, summarize or cite it honestly when discussing the draft with the user.

When authoritative human wording matters to the purpose, do not hide it in paraphrase only.
Keep the normalized purpose prose as the normative record, and preserve the raw wording in `Traceability` as informative basis for later interpretation.
If purpose-level promotion is not yet settled, preserve the wording and record a durable planning handoff rather than normalizing it prematurely.
When prior purpose text is wrong or stale, replace it with the current truth instead of appending corrective caveats that make the product identity feel patched together.

---

## Quoting and references

Default to paraphrase.
The intended purpose should read like an argument grounded by evidence, not like a scrapbook of excerpts.

Use a direct quote only when the exact wording matters, for example:
- a regulatory or standards phrase that constrains scope
- a public claim whose wording is itself important
- a practitioner complaint or observation whose language reveals the real failure mode

Quoting rules:
- Keep quotes short.
- Introduce why the quote matters instead of dropping it in raw.
- Attribute the quote immediately in prose or with a nearby citation marker.
- Do not stack multiple long quotes where synthesis should do the work.

When the document uses external research materially, add a `References` section near the end.
That section is for external sources only: websites, standards, regulations, papers, public reports, technical documentation, public issue threads, or other outside material.
Do not include `dev/INTENDED_PURPOSE.md`, `dev/ARCHITECTURE.md`, local requirement files, or other repo documents there.
Those are project-internal grounding artifacts, not external references.

Recommended practice:
- In the prose, mention the source compactly when it carries argumentative weight.
- Prefer Markdown footnotes for sentence-level citations.
- Put the footnote marker at the end of the supported sentence or sentence group: `This workflow fails because operators lose the authoritative record at handoff.[^handoff-study]`
- When two or more sources support the same sentence, stack the markers at the end: `...at handoff.[^handoff-study][^ops-report]`
- When a whole paragraph relies on the same source set, cite the last sentence of that paragraph rather than every sentence.
- In `References`, list the source name, document or page title, organization or author when useful, date when known, and URL or identifier.
- If a standard or norm is cited, include the formal designation.
- Only include sources you actually used.

Preferred Markdown pattern:

```md
Teams keep parallel intake channels because partners and customers cannot all adopt the same portal.[^multi-channel]
That condition is durable enough that the product should reduce reconciliation work rather than assume channel unification.[^multi-channel]

## References

[^multi-channel]: Jane Smith, "Why B2B Orders Still Arrive Through Email and Spreadsheets", Ops Journal, 2024, https://example.com/article
```

Use one reusable footnote id per source.
If an exact quote is necessary, quote briefly in prose and attach the footnote to that quoted sentence.
Keep the argumentative sentence readable even without opening the footnote.

Example reference entries:
- `U.S. Food and Drug Administration, Clinical Decision Support Software: Guidance for Industry and Food and Drug Administration Staff, 2022, https://...`
- `ISO 14971:2019, Medical devices — Application of risk management to medical devices`
- `GitHub Docs, "About CODEOWNERS", https://...`

Use `Traceability` for local downstream artifacts this purpose anchors.
Use `References` for external material that helped establish what is true about the world.

When a clearly emphasized human directive defines product identity, scope boundary, or enduring philosophy, that directive belongs at the intended-purpose layer rather than being forced into stakeholder requirements by default.
Preserve the raw wording promptly through `Traceability` as informative basis so later planning and implementation can recover the human nuance behind the normalized purpose prose.
Keep those upstream authoritative-source links distinct from the downstream requirements, architecture, and tasks the purpose anchors.
`References` still stays external-only.

---

## North-star orientation

Every intended purpose should open with enough orientation that the reader can understand why the product exists and what direction shapes the rest of the document. This is not optional front matter — it is one of the main ways a repository preserves human intent for later human and agent work. It should also help resist the model's default pull toward the average public-data version of the product.

The orientation usually includes one or more of:
- **motivating failure mode** — what keeps going wrong, and why existing approaches fail
- **governing thesis** — the non-obvious belief or principle the product is built on
- **conceptual model** — the important distinctions or categories future work must keep clear
- **grounding context** — the durable facts that make the argument trustworthy

For simple products, this may be a few sentences. For thesis-heavy products, it may deserve explicit sections.

**Calibration target:** after the first two sections, a reader should understand:
- the world before the product
- the recurring failure
- why common defaults are not enough
- the governing insight
- the conceptual distinctions that follow from that insight

When the opening is working well, it teaches the reader how to think about the product, not just what it contains.

### Opening skeleton

Before drafting a thesis-heavy opening, identify these elements:

1. **world before the product** — what people currently do or work around
2. **recurring failure** — what keeps going wrong
3. **grounded basis** — what durable fact or constraint makes that failure real
4. **governing insight** — what non-obvious principle follows
5. **conceptual distinctions** — what layers or categories later work must preserve
6. **obvious adjacent version** — the average version the model is likely to drift toward
7. **wrong-product readings** — the most plausible incorrect interpretations

If the skeleton is weak, the prose usually becomes generic.

---

## Section formatting

Different sections want different shapes:

| Section | Form | Job |
|---|---|---|
| Motivation | Prose | Argue. Short list only for naming failure modes or scattered sources. |
| The insight | Prose | Synthesize. Compact list only for naming a small set of distinctions. |
| Conceptual model | Prose + list | Name distinctions. Prose setup, then a short named set. |
| Product | Prose | Define. Core description in prose; exclusion list when boundaries matter. |
| Intended users | Prose or list | Classify. Prose when simple; list for distinct user groups. |
| Use environment | Prose or list | Classify. Name actual operating conditions. |
| Scope boundaries | List + prose | Exclude. Short exclusion list plus synthesizing paragraph. |
| Assumptions | Brief prose or list | Preconditions. Keep compact. |
| Traceability | Short list or compact prose | Anchor. Downstream artifacts plus any upstream authoritative-source basis preserved for interpretation. |
| References | Short list | Ground. External sources only when they materially shaped the document. |
| Deferred scope | Short list | Items out of scope. Use `[OUT-OF-SCOPE]` tags. |

---

## Document form

The document should read like an argument. A strong default shape:

1. **Motivation** — the world before the product, the recurring failure, the pressure
2. **Conceptual model** — key distinctions the reader must understand early (when they exist)
3. **Product** — what it is and the operating principle that defines it
4. **Intended users** — who it is actually for
5. **Use environment** — where, in what setting, under what conditions
6. **Scope boundaries** — where it stops and what it is not
7. **Assumptions and dependencies** — what must hold
8. **Traceability** — what downstream documents this anchors and any upstream authoritative-source basis kept as informative interpretation context
9. **References** — external sources that materially grounded the draft
10. **Deferred scope** — things intentionally noted but outside current product identity

Drop sections that would only say "not applicable." Merge when prose is stronger. Split when the argument is clearer. Not every heading needs the same level — use nested subsections when they help.

```markdown
---
version: 0.1
status: draft
last_updated: <YYYY-MM-DD>
---

# Intended Purpose

## Motivation
<What keeps going wrong? What real context makes that durable? What thesis follows?>

## Product
<What it is and how it works at the operating-principle level.>

## Intended users
<Who it is for. Name real roles.>

## Use environment
<Where and under what conditions it is used.>

## Scope boundaries
<What it is not. Where expectations should stop.>

## Traceability
- Upstream authoritative-source basis: <captured reference or source note when wording fidelity matters>
- Downstream anchors: <requirements, architecture, tasks, or other local artifacts this purpose informs>

## References
- <External source actually used>

## Deferred scope
- [OUT-OF-SCOPE] <topic> — <short note>
```

---

## Depth calibration

### Element-level examples

**Weak grounding:**
```md
This is a major industry problem that badly needs fixing.
```

**Strong grounding:**
```md
The team already maintains three intake channels because customers and partners cannot all adopt the same portal.
That condition is unlikely to disappear, so the product has to reduce reconciliation work instead of assuming channel unification.
```

**Weak insight:**
```md
This product helps teams stay aligned.
```

**Strong insight:**
```md
The hard part is not collecting more order data.
It is deciding which record is authoritative at the moment work happens.
The product works by distinguishing operational records from reporting views instead of letting them collapse into each other.
```

**Weak conceptual model:**
```md
The product has dashboards, queues, and reports.
```

**Strong conceptual model:**
```md
Requests, operational jobs, and customer-facing history are different kinds of records.
They answer different questions and should not be treated as interchangeable.
If those categories blur together, operators lose both queue clarity and auditability.
```

The stronger versions explain the tension, the grounding basis, the principle, and why the distinction matters.

When possible, strengthen the grounding with evidence beyond the local repo.
For example, a stronger draft may name a regulatory constraint, a public migration failure, an observed operator complaint pattern, or a durable market condition that matches the repository's own story.
If you cannot find that evidence, do not fake certainty.

### Paragraph level

**Too thin (motivation):**

```md
Teams need better tools for managing technical documentation.
Current approaches are fragmented and manual.
This product helps teams keep their documentation organized.
```

Three sentences, zero orientation. Could describe a wiki, a CMS, or a knowledge base.

**Right depth (motivation):**

```md
Engineering teams that maintain both product code and technical documentation in the same repository face a specific failure: the documentation drifts from the code silently.
API references describe endpoints that were renamed.
Architecture docs name modules that were merged two quarters ago.
The drift is invisible until someone new tries to onboard or an auditor asks for current records.

The problem is not missing tooling.
It is that documentation and code have no shared notion of staleness.
A code change that invalidates a doc page produces no signal.
```

**Too thin (product identity):**

```md
A CLI tool that helps developers manage documentation alongside code.
It integrates with git and supports multiple output formats.
```

Features without identity. Nothing distinguishes it.

**Right depth (product identity):**

```md
`docwatch` is a CLI that detects when code changes invalidate documentation in the same repository and surfaces those invalidations before they reach readers.
It does not generate documentation, host documentation, or replace a docs-as-code build pipeline.
It watches for drift between code and docs that already exist.
```

### Multi-section progression

This fictional example shows how a strong opening builds a mental model across sections. Each paragraph changes how the reader thinks. None merely restates what the product contains.

```md
## Motivation

Incident postmortems are a solved problem at the ceremony level.
Most teams have a template, a review cadence, and an archive.
The problem is downstream.

Lessons identified in postmortems rarely flow back into the systems they describe.
A postmortem names a contributing cause — "the retry budget was shared across tenants" — and recommends a fix.
The fix may or may not get prioritized.
The architectural constraint that made the failure possible stays undocumented in the system's own records.
Six months later, a different team reintroduces the same pattern because nothing in the repository told them not to.

The failure is not that teams forget to write postmortems.
The failure is that postmortems exist in a document archive disconnected from the code, architecture, and operational runbooks they are actually about.

## The Insight

The useful unit in a postmortem is not the narrative.
It is the lesson: a specific claim about system behavior, a constraint that should be preserved, or an operational pattern that should change.
Those lessons have natural homes:

- architecture constraints belong in architecture documentation
- operational patterns belong in runbooks
- monitoring gaps belong in observability requirements
- code-level guardrails belong near the code

A postmortem that stays whole in an archive is a write-once artifact.
A postmortem whose lessons are decomposed and routed to their natural homes becomes a live input to the systems it describes.

## Product

`pmflow` is a CLI that takes incident postmortem documents and helps teams decompose their lessons into traced, routable records that link back to the systems, repositories, and runbooks they affect.
It is not a postmortem template, a writing tool, or an incident management platform.
It assumes the postmortem already exists.
Its job starts after the retrospective ends.
```

What each section does:
- **Motivation** names a concrete, durable failure and explains why the existing ceremony is insufficient.
- **The Insight** identifies the real unit of value, then uses a short list to show where those units belong.
- **Product** is three sentences of identity followed by three sentences of boundary.

### Fragment-level examples

Weak:
```md
People need a better way to handle incoming requests.
```

Strong:
```md
Customer orders arrive through email, spreadsheets, and a legacy portal.
Operations staff reconcile them manually, which creates avoidable delays and contradictory order status.
By the time a warehouse worker acts, nobody is fully confident which source is current.
```

Weak:
```md
Platform that enables teams to collaborate more effectively on data pipelines.
```

Strong:
```md
Internal service that schedules, runs, and monitors batch data pipelines defined as Python DAGs. Operators see run status, logs, and retry controls. It does not provide a notebook environment, ad-hoc query interface, or data catalog.
```

Weak (medical):
```md
Software that assists clinicians by prioritizing chest X-rays for review.
```

Strong:
```md
Standalone software (SaMD) that flags adult chest X-rays for expedited clinician review when image features suggest pneumothorax. Advisory only — it does not render a diagnosis or replace clinical judgement. Intended for radiology reading rooms and emergency department triage. Excludes pediatric imaging, CT, and non-thoracic radiographs.
```

---

## Quality tests

Apply after drafting.

**Decision test.** Take three real feature proposals. Can the document answer "does this belong?" with a clear yes or no?

**Recitation test.** Can someone restate the core identity from memory after reading it twice?

**Swap test.** Replace the product name with a competitor's. Is the document still true? If yes, specificity is missing.

**Decomposition test.** Can you derive three to five plausible stakeholder requirements from it?

**Survival test.** Would this document help make a scope decision six months from now?

**North-star test.** Could a new contributor explain the recurring failure mode and the governing principle, not just what the product does?

**Current-truth test.** Does the document read like the product identity the project now believes in, or like a record of how the project changed its mind?

**Grounding test.** Are the strong claims tied to observed reality rather than enthusiasm?

**Research honesty test.** Could a reader tell which important claims are externally grounded, which are inferred, and which are still hypotheses?

**Challenge test.** Did the drafting process actively look for loopholes, adjacent-product drift, and contradictory evidence, or did it only search for support?

**References test.** If a `References` section exists, does it contain only external sources that materially informed the draft, with local repo artifacts kept out?

**Alignment test.** Does the document preserve what the human actually cares about strongly enough that later agent work would not drift toward a thinner proxy?

### Opening-section rubric

Check the first one or two sections:
- Does it explain a recurring failure mode, not just a need?
- Does it make clear why common defaults are insufficient?
- Does it state a governing insight, not just a description?
- Does each paragraph quickly increase understanding?
- Does the formatting help the reader see distinctions?
- Does it sound calm and exact rather than promotional?

---

## Versioning

The intended purpose should be versioned. Changes are major events — they can invalidate downstream requirements, architecture, and tasks. Update version and date on every change. Do not treat a purpose change as silent prose cleanup if it materially changes identity or scope.

---

## Appendix A — Medical device extension

If the product is or may be a medical device, add sections making the intended medical purpose explicit.
The core guidance above still applies, but the document must become more bounded because intended purpose can drive device status, classification, evidence, labeling, risk management, verification, validation, and change control.

If applicable, consider setting `domain: medical` and `jurisdictions: [EU, US, ...]` in frontmatter.

Under EU MDR, intended purpose can act as a binding scope claim tied to manufacturer-supplied information such as labeling, instructions for use, promotional or sales material, and clinical evaluation.
Under FDA-style thinking, intended use can be informed by objective intent, including labeling, claims, product design, and circumstances of distribution.
Make boundaries precise enough that downstream compliance work is not built on ambiguity.
Do not rely on memory for these claims; verify the current official sources for the jurisdiction and date in scope.

For cross-jurisdiction products, keep one canonical master statement unless the actual product scope differs by jurisdiction.
Map that statement to the jurisdictional terms instead of duplicating the same prose under EU and US headings.
If the EU intended purpose and FDA intended use or indications wording diverge, document the delta explicitly in a jurisdiction-specific note and trace it to the relevant label, submission, or regulatory rationale.
Do not create parallel near-identical sections that future edits can accidentally desynchronize.

Medical intended-purpose prose should usually distinguish:
- **Intended purpose / intended use:** the claimed clinical job of the product.
- **Indications for use:** the disease, condition, clinical aim, patient population, and use scenario.
- **Device description / operating principle:** how the product performs the job at a level needed to understand scope, without becoming architecture.

Do not let those collapse into one vague statement.
A vague statement such as "assists clinicians in diagnosis" is not enough for medical software.
It leaves the disease state, patient population, intended user, input modality, output type, care setting, workflow role, decision impact, and exclusions unstated.

### A1. Intended medical purpose or indications
State the indication, condition, clinical aim, patient population, and the kind of decision or workflow step the product supports.
For software, also state whether each relevant software function has a medical purpose on its own, drives or influences another device, or is non-device support functionality.

### A2. Patient population
State the target population, subgroups, and explicit exclusions.
Include age range, clinical condition, anatomy, care pathway, or data-source limits when those affect safety, evidence, or scope.

### A3. Decision impact and role
State whether the system is advisory, assistive, triage/prioritization, measurement, monitoring, diagnostic, therapeutic, device-driving, or autonomous.
State whether it is standalone, embedded in another product, or part of a platform with both medical and non-medical functions.
Name whether the output may be used as the sole basis for a clinical decision or only together with professional judgment and other clinical information.

### A4. Inputs, outputs, and use environment
State the input data and prerequisites that bound the claim: modality, file type, source system, data quality, compatible devices, user-entered data, model inputs, or validated acquisition conditions.
State the output type: alert, score, probability, measurement, finding support, ranked option set, recommendation, notification, report text, visualization, or control signal.
State the intended users and use environment: clinical role, training level, lay or professional status, care setting, urgency, hardware, network, cloud/on-prem, and interoperability assumptions.

Keep this at purpose level.
If a detail is needed only to implement or test the product, move it downstream to requirements, architecture, risk, verification, or validation.

### A5. Exclusions, limitations, and foreseeable misuse
State realistic off-label patterns that shape boundaries and later risk work.
Call out excluded populations, modalities, settings, urgency levels, autonomous use, sole-basis diagnosis or treatment, unsupervised lay use, unsupported upstream systems, or data-quality conditions when they matter.
Do not hide limitations in later risk files if they are part of the product identity.

### A6. Evidence, claims, and traceability
Do not put free-floating performance claims such as "highly accurate," "reduces misses," "improves outcomes," "saves time," or "works across all scanners" in the master purpose statement.
If a claim is identity-defining, qualify it and link it to evidence, validation, labeling, or other controlled source material through `Traceability` or `References`.

For regulated medical products, `Traceability` may need to name downstream anchors such as:
- classification rationale or regulatory status memo
- risk management file or hazard analysis
- user needs and software/system requirements
- architecture or interface specifications
- verification and validation plans or reports
- clinical evaluation or performance evidence
- labeling, instructions for use, website claims, and promotional-claim controls
- cybersecurity and interoperability documentation
- change-impact assessment procedure

Use `References` only for external sources that materially ground the document.
Use `Traceability` for local records, QMS documents, requirements, risk files, evidence, and human source basis.

### Elicitation prompts
- What is the medical indication or purpose?
- What is the intended patient population, including exclusions?
- Is the decision impact advisory or autonomous? In what clinical context?
- Is the software standalone or embedded in another device?
- What input data, output type, user role, care setting, and workflow step bound the claim?
- Which foreseeable off-label uses must be rejected in the purpose, not merely handled later?
- Which claims require evidence or labeling consistency before they can appear in purpose text?

### Downstream readiness checks
- **14971:** Are misuse patterns and assumptions explicit enough to scope hazard analysis?
- **62366-1:** Are users, environments, and functions specific enough to seed usability definitions?
- **62304:** Does the purpose describe the software role and decision impact?
- **Labeling/claims:** Would label, IFU, sales, website, and demo wording stay inside this purpose?
- **Change control:** Can a later reviewer tell which changes alter intended purpose, indication, population, user, setting, data source, output type, or decision role?
- **Evidence:** Are clinical, analytical, and software validation claims scoped to the stated population, data, users, and use environment?

---

## Appendix B — Quality-management tool extension

If the product supports ISO 13485, medical-device production, quality-management processes, or similar regulated operations, add sections making supported processes and compliance boundaries explicit.
The product may be non-device software and still be QMS-relevant.
Its intended use should be clear enough to support risk-based assurance, validation, access control, auditability, change control, and fit-for-use decisions.

If applicable, consider setting `domain: qm` in frontmatter.

### B1. Supported processes
State which quality processes are in scope.
Examples include design control, document control, requirements management, risk management, verification and validation, complaint handling, CAPA, supplier control, production automation, release management, training, audit evidence, or post-market surveillance.
Name the actual process, not just the general compliance regime.

### B2. Compliance constraints
State constraints that shape product identity at a high level.
These may include traceability, approval state, revision control, electronic records, audit trails, separation of draft and approved records, evidence retention, data integrity, or controlled change impact.
Keep implementation mechanisms out of purpose unless the mechanism is itself part of the product identity.

### B3. Non-device and borderline boundaries
If the software is not intended to diagnose, treat, mitigate, prevent, monitor, or otherwise perform a medical purpose, say so explicitly when that boundary matters.
For platforms with mixed functions, assess and describe functions separately enough that a medical-device module is not blurred with administrative, display, transfer, scheduling, billing, QMS, or reporting functionality.
If the result should be a regulatory-status or intended-function statement rather than a device intended-purpose statement, say that in the document instead of forcing medical-device wording.

### B4. Assurance and lifecycle traceability
State what downstream records must stay aligned with the intended use.
For QMS tools, likely anchors include user needs, process requirements, risk-based assurance rationale, validation evidence, access-control assumptions, audit-log expectations, configuration records, data-retention rules, training assumptions, and change-impact assessment.

### Elicitation prompts
- Which regulated or quality-management processes does this product support?
- Who are the intended users: QA, RA, manufacturing, service, management, or mixed?
- What compliance constraints are essential enough to shape product identity?
- Is the software a medical device, non-device QMS software, production software, or a platform with mixed functions?
- What records, decisions, approvals, or evidence will users rely on the system to preserve?
- Which downstream validation or assurance records must stay aligned with the intended use?
