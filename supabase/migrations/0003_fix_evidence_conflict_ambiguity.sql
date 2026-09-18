-- `upsert_relationship` declares `returns table (relationship_id uuid, ...)`,
-- which puts a plpgsql variable named `relationship_id` in scope for the whole
-- body. The evidence insert's ON CONFLICT clause then cannot tell that
-- variable from `relationship_evidence.relationship_id`, and Postgres refuses
-- the statement:
--
--   column reference "relationship_id" is ambiguous
--
-- The insert's own column list is fine — it resolves against the target table —
-- so the failure is confined to the conflict-target inference.
--
-- `#variable_conflict use_column` resolves such a collision in favour of the
-- column, which is what every ambiguous reference in this body wants. The
-- alternative, renaming the OUT columns, would change the function's return
-- contract to work around a naming collision that only exists inside it.
--
-- The directive is body-wide, not statement-scoped: anywhere in this function
-- an identifier could mean either, it now means the column. Anything that
-- needs the OUT variable must use a distinct name, which is why the working
-- values here stay `v_`-prefixed.
--
-- The unique index is `relationship_evidence_key`, an index rather than a
-- named constraint, so `on conflict on constraint` is not available here.

create or replace function upsert_relationship(
  p_exploration_id uuid,
  p_source_id uuid,
  p_target_id uuid,
  p_predicate predicate,
  p_source_url text,
  p_excerpt text,
  p_run_id uuid default null
)
returns table (relationship_id uuid, created boolean)
language plpgsql
as $$
#variable_conflict use_column
declare
  v_id uuid;
  v_created boolean := false;
begin
  insert into relationships (exploration_id, source_id, target_id, predicate)
  values (p_exploration_id, p_source_id, p_target_id, p_predicate)
  on conflict (exploration_id, source_id, target_id, predicate) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from relationships
      where exploration_id = p_exploration_id
        and source_id = p_source_id
        and target_id = p_target_id
        and predicate = p_predicate;
  else
    v_created := true;
  end if;

  insert into relationship_evidence (relationship_id, source_url, excerpt, run_id)
  values (v_id, p_source_url, p_excerpt, p_run_id)
  on conflict (relationship_id, source_url, excerpt) do nothing;

  return query select v_id, v_created;
end;
$$;
