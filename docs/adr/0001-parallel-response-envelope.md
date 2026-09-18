# ADR-0001: The Parallel response envelope, verified against real runs

**Status:** accepted · **Date:** 2026-09-18

## Context

`lib/parallel.ts` was written against ambiguous published documentation. It
walks several plausible envelope shapes rather than pinning one, because the
cost of guessing wrong is invisible: an unrecognised envelope yields zero
entities, and the app presents a completed run with zero entities as an
**empty leaf** — a legitimate result. A parser that never matches is therefore
indistinguishable from research that genuinely found nothing.

That ambiguity was resolved by issuing one real run directly against the API,
outside the application, and inspecting what came back.

## The runs

Three runs, all subject "Stripe" (`company`, `https://stripe.com`), processor
`base`, output schema exactly as `OUTPUT_SCHEMA` declares it.

| run_id | latency | entities returned |
| --- | --- | --- |
| `trun_73b8f7a0f9c1465384d1d6295492d97e` | 80s | 8 |
| `trun_73b8f7a0f9c14653a110eb16bdc8001d` | 31s | 3 |
| `trun_73b8f7a0f9c14653bd4aff6d015879d3` | 117s | 6 |

The envelope was identical every time; latency and entity count were not.
The last run's raw envelope is committed at
`docs/adr/0001-parallel-envelope-sample.json` so the claims below are
checkable without spending another run.

## What the API actually returns

`GET /v1/tasks/runs/{run_id}` returns status only:

```
{ run_id, interaction_id, status, is_active, warnings, processor, metadata,
  created_at, modified_at }
```

There is **no `result` key on the status response**, at any point in the
lifecycle. The `body.result ?? fetchResult(runId)` fallback in `pollRun` is not
a rare path — it is the only path, and a second request to
`GET /v1/tasks/runs/{run_id}/result` is always required.

That endpoint returns:

```
{ run: { …the same status object… },
  output: { type: "json", basis: [ { field, citations, reasoning, confidence } ],
            content: { entities: [ … ] } } }
```

`output.content` arrives as a **parsed object**, not a JSON string. The rows sit
at `output.content.entities`. `output.basis` carries per-field reasoning and
citations; its entries have a `field` key whose value is the *string*
`"entities"`, which the parser's `Array.isArray` check correctly ignores.

## Verified against the acceptance criteria

All 8 returned rows, unmodified:

- **Returned vs kept** — the parser discarded **0** of the 6 rows the third
  run returned. This is the criterion worth stating precisely: `extractEntities`
  drops rows failing `isDiscoveredEntity`, so counting only survivors would
  prove nothing. The gate compares `output.content.entities.length` against
  what the parser hands back.
- **Types** — all within `company | person | technology`. Nothing was coerced,
  so no person was silently filed as a company (which would present as a
  deduplication failure when the same person is later discovered correctly
  typed).
- **Predicates** — all within the closed vocabulary (`founded_by`, `acquired`,
  `uses_technology`), so `coercePredicate` never had to fall back. One row in
  the third run came back as `related_to` (Y Combinator), chosen by the model
  from the vocabulary rather than coerced into it. Five of six carried a
  meaningful label.
- **Evidence** — every row carried a non-empty `source_url` and a verbatim
  `excerpt`, so none were discarded by `isDiscoveredEntity` and the evidence
  surface has real content.

## The schema is accepted, but rewritten

`status.warnings` — which the application never reads — carries two entries on
every run:

- `spec_validation_warning`: *"All output schema properties must be required;
  missing properties have been added to 'required'"*, naming `canonical_url`.
  The API rewrites the declared schema rather than rejecting it, so
  `canonical_url` arrives on every row, empty string where unknown.
  `normalizeUrl` already maps that to `null`, so nothing downstream breaks.
- `spec_validation_warning`: the task "may be too complex for base processor",
  7 properties against a recommended 5. The runs nonetheless completed and
  returned well-formed rows.

Neither warning is surfaced in the app. That is tolerable while both are
benign, but it means a future schema rewrite would land silently.

## Decision

1. **Keep the shape-walking parser as written.** The real envelope does not
   defeat it: it reaches `output.content.entities` and extracts all 8 rows. The
   walker is now documented as *verified against* the real shape rather than
   guessing at it, so a future reader knows which branch actually fires.
2. **Raise the polling ceiling from 3 minutes to 5.** Measured latencies spread
   from 31s to 117s across three runs of the *same* subject. The slowest left
   only 63s under the old 3 minute ceiling, which is measured from the `runs`
   row's `created_at`, so app-side latency eats into it too. A run killed at
   the ceiling is reported as a failure, which is a worse outcome than waiting
   longer for one that would have completed.

## Alternatives rejected

- **Pin the parser to `output.content.entities` and delete the walker.** One
  observed run is thin evidence that the shape is stable, and the documented
  ambiguity that motivated the walker has not gone away — only the question of
  whether it currently works. The walker costs nothing on a match.
- **Prove the parser with a recorded fixture instead of a live call.** A fixture
  only demonstrates that the fixture and the parser agree, which is precisely
  the question a live call answers and a fake cannot. The check lives at
  `scripts/verify-parallel-envelope.ts` and issues a real run on each use.
