# Entity Graph Explorer

Enter a company, person, or technology. The app researches it with the Parallel
Task API and renders an interactive graph. Clicking an unexpanded node researches
it; clicking an edge shows the sources and excerpts behind that relationship.

## Setup

1. Fill in `.env.local`:

   ```
   NEXT_PUBLIC_SUPABASE_URL=
   NEXT_PUBLIC_SUPABASE_ANON_KEY=
   SUPABASE_SERVICE_ROLE_KEY=
   PARALLEL_API_KEY=
   ```

2. Run both migrations against the Supabase project, in order, via the SQL editor
   or `supabase db push`:

   - `supabase/migrations/0001_init.sql`
   - `supabase/migrations/0002_resolve.sql`

3. `npm run dev`

## How deduplication works

Deduplication is deterministic — no embeddings, no LLM adjudicator. Ambiguous
matches deliberately stay separate rather than risk a bad automatic merge.

**Normalization** (`lib/normalize.ts`) lowercases, strips diacritics, punctuation,
possessives and stacked legal suffixes, and rejoins acronyms so `Nestlé S.A.`
and `Nestle` collapse to one key. URLs lose scheme, `www.`, trailing slash and
query string.

**Resolution order** (`resolve_entity` in `0002_resolve.sql`), scoped to one
exploration:

1. canonical URL exact match
2. normalized name + type exact match
3. alias match
4. create

Name is checked before alias on purpose: a canonical name is stronger evidence
than a recorded variant. A surface name is stored as an alias only when it
differs from the canonical name, and never when it would collide with another
entity's canonical name.

**Convergence is enforced in Postgres**, not application code. Two concurrent
expansions that discover the same entity collide on
`unique(exploration_id, normalized_name, type)`; the loser catches the
`unique_violation` and re-reads, so both converge on one node.

**Relationships** dedupe on `(exploration_id, source_id, target_id, predicate)`
with evidence accumulating in a child table — the same fact from two sources
becomes two excerpts on one edge, not two edges. Edge direction is canonicalized
first (`lib/predicates.ts`) so that expanding the far end of an existing edge
collapses onto it instead of creating a twin.

Run `npm test` for the normalization and edge-canonicalization tests.

## Scope

v1 is exploration-scoped: each seed creates a fresh exploration and nothing is
shared across explorations. Global canonicalization, fuzzy/LLM resolution,
shareable URLs and re-research are deliberately out of scope.

### Known gaps

- `acquired`, `invested_in` and `subsidiary_of` connect two companies, so entity
  types cannot tell us which way the model meant the edge to point. Expanding
  both ends can still produce a pair of opposing edges. Fixing it needs a
  direction field or inverse predicates in the vocabulary.
- The exploration id lives in client state only; a refresh loses the graph
  (the rows remain in Supabase).
