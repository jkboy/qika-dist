# Evidence Contract Reference

This reference defines the interoperable audit record. It is an output contract, not a required reasoning method.

## Manifest shape

```text
schema_version   Contract format version; currently "1.0".
task             Question, as-of boundary, and risk level.
entities         Exact subjects whose identity matters.
relations        Version, derivation, replacement, or comparison links.
claims           Decision-bearing factual or recommendation claims.
evidence         Sources linked to claims with scope and lineage.
negative_searches
                  Search coverage for negative claims.
reviews          Independent semantic checks; required for strict publishable decisions.
decision         Requested publication state and critical claim roots.
```

Unknown extra fields are allowed so stronger methods can preserve richer evidence.

## Entity identity

Each entity declares `required_identity_fields`. The validator checks those paths under `identity`; the task decides which fields matter. Do not require a version for an unversioned person, but do require revision and release date for a version-sensitive model or software artifact.

A verified entity needs at least one evidence record. Identity evidence should point to the owner or an immutable artifact when possible.

## Relations and time

A `derived_from`, `retargeted_from`, or `supersedes` relation records `effective_date` and evidence. Other relations, such as comparisons, may omit the date. If a derived entity predates its claimed base, the temporal relation must have a later, evidenced effective date; repository creation time alone neither proves nor disproves a later retarget.

The validator catches impossible recorded dates. Semantic review decides whether the relation evidence actually proves the relation.

## Claims and dependencies

Claim statuses:

- `verified`: factual claim directly established within its declared scope.
- `supported`: recommendation or synthesis whose prerequisites are verified.
- `unknown`: insufficient evidence.
- `conflicted`: material sources disagree.
- `refuted`: evidence contradicts the claim.

`depends_on` forms a directed graph. A publishable decision includes the dependency closure of every critical root. Every claim in that closure must be `verified` or `supported`; cycles are invalid.

`min_independent_lineages` is determined by the claim, not by model capability. A canonical identity may need one primary lineage; a claim of community consensus needs multiple genuinely independent lineages.

## Evidence

Evidence links itself to claims through `claim_links`, each with a `stance` of `supports`, `refutes`, or `context`. A claim also lists `evidence_ids`; both directions must agree.

`lineage_group` identifies common provenance. Forks, mirrors, copied benchmarks, the same author, or repositories deriving the result from one upstream report belong to one group unless independence is demonstrated.

`scope` records applicability such as entity, version, date, hardware, workload, jurisdiction, or population. Omit irrelevant dimensions; do not silently generalize them.

`locator` is a line, section, API field, commit path, or other precise location. `excerpt_or_digest` preserves the supporting text or content identity. These fields make semantic review reproducible without forcing a report format.

Evidence provenance takes one of three forms:

- `url` — a source fetched directly. It must be the bare URL that was actually requested; annotations belong in `locator`, not inside the URL.
- `url` + `retrieved_via` — content obtained through a different transport URL (for example a GitHub file obtained via a codeload tarball). `retrieved_via` records the URL actually requested; `url` remains the canonical citation.
- `local_command` (with optional canonical `url`) — evidence produced by local execution, such as running a test suite or reading locally installed files. `local_command` records the command that was executed; a failing run is still legitimate evidence. When `local_command` is present, `url` is optional and serves only as a canonical pointer. **It must be the verbatim command as executed** (pick one representative command); summaries, translations, or pseudo-commands are not auditable — structural validation rejects prose-style commands (standalone CJK tokens) and the session cross-check matches by exact substring. Perform local file forensics via bash (`cat`/`grep`/`sed`/`python -c`); evidence gathered through structured read tools is not captured by the cross-check.

Session cross-check (`--session`) verifies `retrieved_via`/`url` against the commands actually run in the session, and `local_command` against executed commands. Citing a fetch or run that never happened is reported by id.

### Session provenance (`session_file`)

A manifest may outlive the session that built it (follow-up questions, re-verification, added scope). Each evidence record may carry `session_file` — the absolute path of the session log in which the fetch/run actually happened. **This field is stamped by the settle audit after a record passes the cross-check; do not author or edit it by hand.** During cross-check, a record with `session_file` pointing to a different session is verified against that session's log instead of the current one, so legitimately inherited evidence no longer reads as "never requested". Forging the field does not help: the referenced log must actually contain the command. If the provenance log is missing or unreadable, the record is reported as unverifiable (not as fabrication) and its claims fall back to provisional unless re-fetched.

## Negative claims

A negative claim requires a `negative_searches` entry describing queries, source classes checked, time boundary, and limitations. This establishes search scope, not universal nonexistence. The final wording must remain within that scope.

## Strict semantic review

A strict publishable decision requires a review marked `independent: true` and `status: pass` that covers the complete decision claim closure. “Independent” means a fresh verification pass that reopens primary evidence and tests scope/entailment; restating the researcher's confidence is not a review.

A reviewer may use any method. It should prioritize identity mismatch, unsupported citations, source lineage, scope expansion, unresolved dependencies, and counterexamples.

## Validator boundary

The validator checks structure, references, dependency closure, date order, lineage counts, negative-search presence, and strict-review coverage. It cannot prove that a source is truthful or that an excerpt entails a claim. A passing manifest is necessary, not sufficient, for semantic correctness.
