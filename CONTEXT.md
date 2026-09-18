# Context

The vocabulary of the Entity Graph Explorer. Use these terms exactly; several of
them are near-synonyms in ordinary speech but mean distinct things here.

## Core concepts

**Exploration** — one user's session of research, rooted at a single seed. It is
the scope boundary for everything: entities, aliases, relationships and runs all
belong to exactly one exploration and are never shared across explorations.
Prefer this term over "graph" when referring to the stored data; "graph" refers
to the rendered visualisation.

**Seed** — the entity a user typed to start an exploration, and the first node in
it. The exploration records both the raw seed query and the entity it resolved
to.

**Entity** — one real-world thing in an exploration: a company, a person, or a
technology. An entity is the canonical record; the various names it was
discovered under are its aliases. Rendered as a node.

**Entity type** — one of `company`, `person`, `technology`. Type participates in
identity: two entities with the same normalized name but different types are
deliberately kept distinct.

**Canonical name** — the entity's display name, taken from the first discovery
that created it.

**Normalized name** — the canonical name reduced to a comparison key:
lowercased, stripped of diacritics, punctuation, possessives and stacked legal
suffixes, with acronyms rejoined. Not shown to users. Together with type it
forms the entity's primary identity key.

**Alias** — a surface name an entity was discovered under that differs from its
canonical name. Aliases are what make deduplication visible: a node's alias count
is the number of other names the same entity was found under. An alias is never
allowed to point at two entities within one exploration.

**Canonical URL** — an optional authoritative URL for an entity, normalized by
stripping scheme, `www.`, trailing slash and query string. When present it is the
strongest identity signal, stronger than name matching.

## Resolution

**Resolution** — the act of deciding which existing entity a newly discovered
name refers to, or creating one if it refers to none. Resolution is deterministic
and scoped to a single exploration. Use this term rather than "matching" or
"lookup".

**Resolution order** — canonical URL, then normalized name plus type, then alias,
then create. Name is checked before alias deliberately: a canonical name is
stronger evidence than a recorded variant.

**Resolution outcome** — what resolution decided, reported back to the client:
`created`, `matched_by_identifier`, `matched_by_name`, `matched_by_alias`, or
`matched_by_race`. These are the vocabulary for describing what happened to a
discovered entity.

**Deduplication** — the overall behaviour that two discoveries of the same
real-world thing land on one entity. It is the outcome; resolution is the
mechanism. Avoid "merge": nothing is merged after the fact, because entities
converge at write time and no two rows ever coexist to be combined.

**Convergence** — two concurrent expansions discovering the same entity arriving
at one row. Enforced by database uniqueness constraints rather than application
logic; the loser of the race catches the violation and re-reads.

## Relationships and evidence

**Relationship** — a typed, directed connection between two entities in an
exploration. Rendered as an edge. Identified by exploration, source entity,
target entity and predicate, so the same fact discovered twice does not produce
two relationships.

**Predicate** — the relationship's label, drawn from a small closed vocabulary.
Anything outside it is coerced to `related_to` rather than dropped.

**Source entity / target entity** — a relationship's two endpoints. Distinct from
**source** in the citation sense below; when ambiguity is possible, say "source
entity" or "source URL" rather than bare "source".

**Direction canonicalisation** — rewriting a relationship so that equivalent
readings collapse onto one row: symmetric predicates are ordered by entity id,
and type-directed predicates are flipped when the reverse reading is the valid
one. Without it, expanding the far end of an existing edge would create a twin.

**Evidence** — a citation supporting a relationship: a source URL and a verbatim
excerpt from that page. A relationship accumulates evidence, so discovering the
same fact from a second source adds an excerpt rather than an edge. A
relationship with no evidence is not stored.

## Research

**Research** — the act of calling the Parallel Task API to discover what an
entity is related to. Always one hop: one subject in, its immediate neighbours
out.

**Run** — one research call and its lifecycle. A run belongs to an exploration
and a subject entity, holds the upstream run identifier, and is `pending`,
`complete` or `failed`. Runs are asynchronous: the client polls them, and several
can be outstanding at once and resolve out of order.

**Expansion** — researching an entity that is already in the graph, to discover
its neighbours. An entity that has been expanded records when. Clicking an
already-expanded node selects it rather than researching it again.

**Ingest** — turning one completed run's results into rows: resolving each
discovered entity, then canonicalising and upserting each relationship with its
evidence. Resolution happens first so edges are always drawn between canonical
entities.

**Empty leaf** — an entity whose research completed but returned no
relationships. This is a valid result, not a failure, and is presented
differently from one.

## Terms to avoid

- **"Graph"** for the stored data — say exploration. Graph means the rendering.
- **"Merge"** for deduplication — nothing is combined after the fact. Say
  resolution, or say two discoveries resolved to one entity.
- **"Duplicate"** for an alias — an alias is a variant name that resolved
  correctly. A duplicate is the bug where it did not.
- **"Node" / "edge"** when referring to persisted rows — those are entities and
  relationships. Node and edge are the rendered forms.
- **"Source"** unqualified where both senses are in play — say source entity or
  source URL.
