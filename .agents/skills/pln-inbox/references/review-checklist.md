# Spec Review Checklist

Run through this checklist before delivering a spec. Every "no" is a gap to fix or an explicit
decision to document.

## Structural Completeness

- [ ] Problem statement explains WHY, not just WHAT
- [ ] Non-goals section exists and is substantive (not just "everything else")
- [ ] System overview names every component with consistent terminology
- [ ] Every component mentioned in overview appears in at least one behavioral section
- [ ] External dependencies are listed with their failure characteristics

## Domain Model

- [ ] Every entity has named fields with types
- [ ] Required vs optional is specified for every field
- [ ] Nullability rules are explicit
- [ ] Normalization rules cover every string comparison and identifier derivation
- [ ] Stable identifiers section specifies what's used for keys, logs, and display

## Configuration

- [ ] Every config field has its default stated inline
- [ ] Every config field has validation rules
- [ ] Dynamic vs restart-required reload behavior is specified per field
- [ ] Environment variable indirection rules are specified where applicable
- [ ] A cheat-sheet / summary table exists for quick reference
- [ ] Startup validation is specified (what's checked before work begins)

## State and Behavior

- [ ] Every stateful component has an explicit state enum
- [ ] Every state transition has a named trigger
- [ ] No state is implied — if it exists in the pseudocode, it's in the state enum
- [ ] Concurrency limits are specified with formulas, not just prose
- [ ] Retry backoff formula is explicit (not "exponential backoff" — the actual formula)
- [ ] Sorting/priority rules are explicit and stable (tie-breakers specified)

## Error Handling

- [ ] Every error has a named category
- [ ] Recovery behavior is specified per error class (not "handle gracefully")
- [ ] Restart recovery describes what state is lost and how the system rebuilds
- [ ] Operator intervention points are documented

## Integration Contracts

- [ ] Every external API has required operations listed
- [ ] Protocol sequences include actual message transcripts (JSON, not just descriptions)
- [ ] Compatibility profile sets expectations for strictness
- [ ] Timeout values are specified for every operation
- [ ] Pagination rules are specified where applicable
- [ ] Approval/policy handling is documented
- [ ] Error categories are named for each integration
- [ ] Error mapping from raw errors to normalized categories exists
- [ ] Normalization from external format to domain model is specified

## Observability

- [ ] Logging conventions specify required context fields
- [ ] Runtime snapshot shape is defined (if applicable)
- [ ] Metrics/accounting rules distinguish cumulative vs per-session, absolute vs delta
- [ ] Optional API endpoints have JSON response schemas (actual shapes, not descriptions)
- [ ] Status surfaces are documented as observability-only (not required for correctness)

## Security

- [ ] Trust boundary is explicit
- [ ] Safety invariants are numbered and labeled by importance
- [ ] Secret handling rules prevent accidental logging
- [ ] Path/filesystem safety rules are specified (if applicable)

## Implementation Bridge

- [ ] Reference algorithms exist for all core flows
- [ ] Pseudocode uses domain model field names consistently
- [ ] Pseudocode shows error handling, not just happy path
- [ ] Test matrix has one testable assertion per bullet
- [ ] Test matrix covers edge cases, not just happy paths
- [ ] Test matrix specifies conformance levels
- [ ] Implementation checklist exists with conformance levels
- [ ] Deferred work is listed as explicit TODOs with rationale

## Writing Quality

- [ ] No vague phrases ("handle appropriately", "robust", "flexible", "graceful")
- [ ] Every "should" is intentional (not a weasel word for "must")
- [ ] Component names are used consistently throughout (no synonyms)
- [ ] Section cross-references are accurate
- [ ] Examples are illustrative, not exhaustive
