-- Entity Graph Explorer — exploration-scoped canonical graph.
-- Everything is scoped by exploration_id: no entity or relationship is shared
-- across explorations in v1.

create extension if not exists pgcrypto;

create type entity_type as enum ('company', 'person', 'technology');

create type predicate as enum (
  'founded_by',
  'acquired',
  'works_at',
  'subsidiary_of',
  'built_by',
  'invested_in',
  'partnered_with',
  'competes_with',
  'uses_technology',
  'related_to'
);

create type run_status as enum ('pending', 'complete', 'failed');

create table explorations (
  id uuid primary key default gen_random_uuid(),
  seed_query text not null,
  seed_entity_id uuid,
  created_at timestamptz not null default now()
);

create table entities (
  id uuid primary key default gen_random_uuid(),
  exploration_id uuid not null references explorations(id) on delete cascade,
  canonical_name text not null,
  normalized_name text not null,
  type entity_type not null,
  canonical_url text,          -- already normalized (no scheme/www/trailing slash)
  description text,
  expanded_at timestamptz,
  created_at timestamptz not null default now()
);

-- Convergence is enforced here, not in application code. Two concurrent
-- expansions that discover the same entity collide on one of these indexes.
create unique index entities_name_key
  on entities (exploration_id, normalized_name, type);

create unique index entities_url_key
  on entities (exploration_id, canonical_url)
  where canonical_url is not null;

create table entity_aliases (
  id uuid primary key default gen_random_uuid(),
  exploration_id uuid not null references explorations(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  alias_raw text not null,
  alias_normalized text not null,
  created_at timestamptz not null default now()
);

-- One alias can never point at two entities within an exploration.
create unique index entity_aliases_key
  on entity_aliases (exploration_id, alias_normalized);

create table relationships (
  id uuid primary key default gen_random_uuid(),
  exploration_id uuid not null references explorations(id) on delete cascade,
  source_id uuid not null references entities(id) on delete cascade,
  target_id uuid not null references entities(id) on delete cascade,
  predicate predicate not null,
  created_at timestamptz not null default now(),
  constraint relationships_no_self_edge check (source_id <> target_id)
);

-- Direction is canonicalized before insert (see lib/predicates.ts), so the
-- inverse of an existing edge collapses onto it rather than creating a twin.
create unique index relationships_key
  on relationships (exploration_id, source_id, target_id, predicate);

create table relationship_evidence (
  id uuid primary key default gen_random_uuid(),
  relationship_id uuid not null references relationships(id) on delete cascade,
  source_url text not null,
  excerpt text not null,
  run_id uuid,
  created_at timestamptz not null default now()
);

-- Same source saying the same thing twice is not new evidence.
create unique index relationship_evidence_key
  on relationship_evidence (relationship_id, source_url, excerpt);

create table runs (
  id uuid primary key default gen_random_uuid(),
  exploration_id uuid not null references explorations(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  parallel_run_id text,
  status run_status not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index runs_entity_idx on runs (entity_id, created_at desc);
create index entities_exploration_idx on entities (exploration_id);
create index relationships_exploration_idx on relationships (exploration_id);
create index relationship_evidence_rel_idx on relationship_evidence (relationship_id);

alter table explorations
  add constraint explorations_seed_entity_fk
  foreign key (seed_entity_id) references entities(id) on delete set null;
