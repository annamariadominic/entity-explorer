-- Atomic entity resolution. Normalization happens in TypeScript (lib/normalize.ts)
-- and the normalized forms are passed in, so there is exactly one implementation
-- of the rules. This function owns only the *resolution order* and the race.
--
-- Order: canonical_url -> normalized_name+type -> alias -> create.
-- Name is checked before alias deliberately: a canonical name is stronger
-- evidence than a recorded variant, so when both could match, name wins.

create or replace function resolve_entity(
  p_exploration_id uuid,
  p_canonical_name text,
  p_normalized_name text,
  p_type entity_type,
  p_canonical_url text default null,
  p_description text default null
)
returns table (entity_id uuid, outcome text)
language plpgsql
as $$
declare
  v_id uuid;
  v_outcome text;
  v_existing_name text;
begin
  -- 1. identifier match
  if p_canonical_url is not null then
    select id into v_id from entities
      where exploration_id = p_exploration_id and canonical_url = p_canonical_url
      limit 1;
    if found then v_outcome := 'matched_by_identifier'; end if;
  end if;

  -- 2. canonical name match
  if v_id is null then
    select id into v_id from entities
      where exploration_id = p_exploration_id
        and normalized_name = p_normalized_name
        and type = p_type
      limit 1;
    if found then v_outcome := 'matched_by_name'; end if;
  end if;

  -- 3. alias match
  if v_id is null then
    select a.entity_id into v_id from entity_aliases a
      join entities e on e.id = a.entity_id
      where a.exploration_id = p_exploration_id
        and a.alias_normalized = p_normalized_name
        and e.type = p_type
      limit 1;
    if found then v_outcome := 'matched_by_alias'; end if;
  end if;

  -- 4. create, losing gracefully to a concurrent expansion that got there first
  if v_id is null then
    begin
      insert into entities (exploration_id, canonical_name, normalized_name, type, canonical_url, description)
      values (p_exploration_id, p_canonical_name, p_normalized_name, p_type, p_canonical_url, p_description)
      returning id into v_id;
      v_outcome := 'created';
    exception when unique_violation then
      -- Either unique index could have fired. Re-read both ways.
      select id into v_id from entities
        where exploration_id = p_exploration_id
          and normalized_name = p_normalized_name
          and type = p_type
        limit 1;
      if v_id is null and p_canonical_url is not null then
        select id into v_id from entities
          where exploration_id = p_exploration_id and canonical_url = p_canonical_url
          limit 1;
      end if;
      v_outcome := 'matched_by_race';
      if v_id is null then
        raise exception 'resolve_entity: lost race but could not re-resolve % (%)', p_canonical_name, p_type;
      end if;
    end;
  end if;

  -- Backfill a canonical_url discovered later for an entity first seen without one.
  if p_canonical_url is not null and v_outcome <> 'created' then
    update entities set canonical_url = p_canonical_url
      where id = v_id and canonical_url is null;
  end if;

  -- Record the surface form only when it differs from the canonical name, and
  -- never when it would collide with another entity's canonical name (that is
  -- the ambiguous reassignment case, which we skip rather than guess at).
  select canonical_name into v_existing_name from entities where id = v_id;
  if v_existing_name is distinct from p_canonical_name then
    insert into entity_aliases (exploration_id, entity_id, alias_raw, alias_normalized)
    select p_exploration_id, v_id, p_canonical_name, p_normalized_name
    where not exists (
      select 1 from entities
      where exploration_id = p_exploration_id
        and normalized_name = p_normalized_name
        and type = p_type
        and id <> v_id
    )
    on conflict (exploration_id, alias_normalized) do nothing;
  end if;

  return query select v_id, v_outcome;
end;
$$;

-- Relationship upsert with evidence accumulation. Direction is already
-- canonicalized by the caller, so the inverse of an existing edge lands here
-- as the same (source, target, predicate) triple and appends evidence instead
-- of creating a twin.
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
