-- Confirms a migration landed completely. A partially-applied migration
-- otherwise surfaces later as an opaque runtime error.
-- Every row must report ok = true.

with expected(kind, name) as (
  values
    ('table', 'explorations'),
    ('table', 'entities'),
    ('table', 'entity_aliases'),
    ('table', 'relationships'),
    ('table', 'relationship_evidence'),
    ('table', 'runs'),
    ('enum',  'entity_type'),
    ('enum',  'predicate'),
    ('enum',  'run_status'),
    ('function', 'resolve_entity'),
    ('function', 'upsert_relationship'),
    ('unique_index', 'entities_name_key'),
    ('unique_index', 'entities_url_key'),
    ('unique_index', 'entity_aliases_key'),
    ('unique_index', 'relationships_key'),
    ('unique_index', 'relationship_evidence_key')
)
select
  e.kind,
  e.name,
  case e.kind
    when 'table' then exists (
      select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = e.name and c.relkind = 'r'
    )
    when 'enum' then exists (
      select 1 from pg_type t
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typname = e.name and t.typtype = 'e'
    )
    when 'function' then exists (
      select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = e.name
    )
    when 'unique_index' then exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = e.name and i.indisunique
    )
  end as ok
from expected e
order by e.kind, e.name;
