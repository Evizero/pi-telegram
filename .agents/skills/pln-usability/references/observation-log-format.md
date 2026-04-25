# Observation Log Format

Every UX test agent writes its findings in this format. The format is designed for usability analysis: it captures not just what happened but why the user made each choice.

## File location

Raw observation logs live at:

- `dev/usability/evidence/rounds/<round>/<number>-<slug>/ux_observation.md`

Examples:

- `dev/usability/evidence/rounds/01-initial/01-first-time-onboarding/ux_observation.md`
- `dev/usability/evidence/rounds/02-post-help-text-fix/01-retest-task-context/ux_observation.md`

If the user later asks to clean or archive the round, this file may be moved to the round root and renamed to `<number>-<slug>.md` after the full raw round has been zipped into a system temporary directory outside the repo. That temp archive is short-term preservation unless the user asks for a durable archive destination.

## Full structure

```markdown
# {{Descriptive Title}}

## Persona
[Who you are, what you know, what you're trying to do. 2-3 sentences max.]

## Session Log

### Step 1: [intent in a few words]
- **Motivation:** [the thinking that led to this step]
- **Command:** `[exact command]`
- **Expected:** [what you thought would happen]
- **Actual:** [what happened]
- **Reaction:** [your reaction as a first-time user]

### Step 2: [intent]
- **Motivation:** [...]
- **Command:** `[...]`
- **Expected:** [...]
- **Actual:** [...]
- **Reaction:** [...]

[...continue for all steps...]

## Accomplishments
[Bulleted list of what you actually achieved toward your original goal]

## Frustrations & Friction Points
[Numbered list. Each item has a severity tag and specific description.]

1. **Short label (HIGH):** What went wrong, what you expected instead, impact on your task
2. **Short label (MEDIUM):** ...
3. **Short label (LOW):** ...

## Delights & Good UX
[Numbered list of things that worked well]

## Suggestions
[Numbered list of concrete, actionable improvements]

## Overall Assessment
[2-3 paragraphs covering:]
- Would you use this tool again?
- How far did you get toward your original goal?
- Key strengths and key gaps
- Numeric scores if helpful
```

## Step format rules

- Every step uses `- **Label:**` bullet format
- `Motivation` is always the first bullet
- `Command` is the exact command run, backtick-wrapped
- `Expected` is what a first-time user would reasonably expect
- `Actual` should be concise and summarize verbose output
- `Reaction` must be specific and honest

## When a step has multiple commands

If a step involves trying the same thing multiple ways, group them as retries inside the same step:

```markdown
### Step 14: Create extraction schema (trial and error)
- **Motivation:** Need to define what fields to extract from papers, but no idea what format the schema file should be in.
- **Command:** `litrev extract --schema-file schema.json ...`
- **Expected:** Schema accepted
- **Actual:** Error: field type "text" not valid
- **Reaction:** Unhelpful; didn't tell me what is valid

- **Command (retry):** Changed type to "string", reran
- **Actual:** Error showing valid types: string | number | boolean | date | enum | array | object
- **Reaction:** Now I know the valid types, but this should have been shown on the first error

- **Command (retry 2):** Fixed all types, reran
- **Actual:** Success
- **Reaction:** Relief, but frustrated it took 3 tries
```

## Severity guidelines

- `HIGH` blocks the user's goal entirely, causes data loss, or makes a core feature unusable
- `MEDIUM` slows the user down significantly, requires workarounds, or makes a feature confusing
- `LOW` is a minor annoyance or a small convenience gap
