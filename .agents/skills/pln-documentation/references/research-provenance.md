# Research provenance

Research-heavy documentation must preserve where knowledge came from, how strongly it is supported, and what the project did with it. The durable record should not depend on chat history, opaque server-side search state, temporary files, or citation tokens from another tool.

## Preserve source identity

When curating findings, keep enough source identity for later lookup:

- captured-reference slug when available;
- repository path for local artifacts;
- title, author, publication year, DOI, PMID, PMCID, arXiv ID, URL, standard number, dataset ID, or tool/version;
- retrieval method, such as literature tool, browser/web search, server-side search reported by the assistant, pasted deep-research report, manual source, local file, subagent, `curl`, package index, or project artifact;
- date or approximate session when it was retrieved/read when available;
- whether the source was opened/read by the agent, only reported by prior conversation, or supplied by the user;
- access/copyright note when it affects whether raw source content can be committed.

Do not rely on ephemeral chat citation tokens, thinking traces, or `/tmp` artifacts as the durable source record.

## Distinguish retrieval state

A source can exist in several states. Preserve the distinction when it affects confidence:

- **mentioned** — source name appeared in chat, task, inbox, or report, but was not looked up in the current durable record;
- **search hit** — found by a query but not read deeply;
- **metadata checked** — title/abstract/identifier checked, but not enough to support detailed claims;
- **read/extracted** — opened and read enough to summarize relevant claims;
- **used as planning basis** — promoted into requirement, architecture, or task rationale;
- **verified in implementation/evidence** — checked against implemented behavior or verification artifacts;
- **superseded/rejected** — displaced, found irrelevant, or intentionally not used.

Do not make a synthesized page sound like every source was fully read if the project record only proves it was mentioned or returned by a search.

## Preserve search method when rigor matters

For lightweight work, a short source list may be enough. For research-heavy, scientific, medical, regulated, or high-impact claims, preserve more of the search protocol:

- research question or objective;
- providers/databases/search engines/tools used;
- exact queries and important filters;
- date searched or approximate session;
- selected hits and why they mattered;
- rejected/non-promising hits and why, when useful;
- full-text availability or access limitations;
- unresolved gaps and what should be rechecked later.

Borrow the spirit of PRISMA-lite transparency without turning every quick lookup into a systematic review.

## Track claim strength, not just source strength

One source may strongly support one claim and weakly support another. When practical, attach confidence/evidence language to the finding:

- direct measurement or official source;
- primary descriptive source;
- secondary synthesis or review;
- database/search hit;
- external deep-research suggestion;
- source-derived inference;
- informed estimate;
- unresolved gap;
- rejected or not applicable.

Use prose or tables; do not invent a registry if the project has not adopted one. The important thing is that future readers can tell which claims are solid and which are placeholders.

## Distinguish findings from source text

Paraphrase and synthesize. Use short quotes only when necessary and preserve attribution. Do not paste long copyrighted passages into project docs unless the source/license and project policy clearly allow it.

For long transcripts, pasted reports, PDFs, or external research output:

- preserve the relevant project-specific substance close to the intended framing when the external resource may disappear;
- avoid copying large third-party passages unnecessarily;
- link or identify the original source when available;
- note when the source was user-supplied, machine-transcribed, or externally generated.

## Handle server-side and external research honestly

Some agent runtimes perform web/search activity outside the local tool log. Conversely, an assistant may report research without leaving durable source detail in the repository.

When curating such material:

- do not infer “no research happened” only from absence of local web tool calls;
- do not infer “research was verified” only from an assistant summary;
- preserve what the project artifact actually says: reported search, pasted report, litrev query, downloaded PDF, opened source, extracted finding, or promoted reference;
- when needed, re-open or re-search sources and record the durable identifiers you verified.

If a prior task says “web research found...” but no durable source identity exists, either fill the gap or state the limitation plainly.

## Track uncertainty and supersession

Record:

- unresolved source gaps;
- conflicting or superseded measurements;
- assumptions or estimates used by implementation;
- rejected sources or reasons when that matters;
- what should be checked again before using the finding for higher-rigor work;
- what newer source, task, or evidence replaced an older claim.

Superseded knowledge should remain findable when it explains historical context, but it must be clearly labeled so it is not mistaken for current best understanding.

## Fill gaps deliberately

The documentation curator may perform additional lookup when breadcrumbs are incomplete. Prefer primary sources or durable project references for claims that will influence requirements, architecture, scientific/medical claims, safety/regulatory reasoning, or substantial implementation choices.

If a prior task says research happened but does not preserve enough source detail, record that limitation rather than making the synthesized documentation look more certain than it is. It is better to write “source mentioned but not re-verified during this curation pass” than to launder an uncertain claim into authoritative prose.

## Link provenance to project use

When a finding matters, connect it to how the project used it:

- source/finding supports a knowledge page only;
- source/finding informed an inbox item;
- source/finding became requirement rationale;
- source/finding shaped architecture;
- source/finding constrained an implementation task;
- source/finding was checked by verification/evidence;
- source/finding was superseded, rejected, or deferred.

This keeps knowledge useful without forcing every source into the requirement chain.
