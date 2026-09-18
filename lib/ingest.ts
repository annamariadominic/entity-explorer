import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeName, normalizeUrl } from "./normalize";
import { canonicalizeEdge, coercePredicate } from "./predicates";
import { ENTITY_TYPES, type DiscoveredEntity, type EntityType, type ResolutionOutcome } from "./types";

export type ResolutionReport = {
  name: string;
  entityId: string;
  outcome: ResolutionOutcome;
};

export async function resolveEntity(
  db: SupabaseClient,
  explorationId: string,
  name: string,
  type: EntityType,
  canonicalUrl: string | null,
): Promise<{ entityId: string; outcome: ResolutionOutcome }> {
  const { data, error } = await db.rpc("resolve_entity", {
    p_exploration_id: explorationId,
    p_canonical_name: name.trim(),
    p_normalized_name: normalizeName(name),
    p_type: type,
    p_canonical_url: normalizeUrl(canonicalUrl),
  });
  if (error) throw new Error(`resolve_entity: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : data;
  return { entityId: row.entity_id as string, outcome: row.outcome as ResolutionOutcome };
}

/**
 * Turns one research run's output into graph rows. Entity resolution happens
 * first so that edges are always drawn between canonical ids — an edge
 * discovered under a variant name attaches to the node the variant resolved to.
 */
export async function ingestRun(
  db: SupabaseClient,
  explorationId: string,
  subjectId: string,
  subjectType: EntityType,
  runId: string,
  discovered: DiscoveredEntity[],
): Promise<ResolutionReport[]> {
  const reports: ResolutionReport[] = [];

  for (const raw of discovered) {
    const type: EntityType = ENTITY_TYPES.includes(raw.type) ? raw.type : "company";
    const normalized = normalizeName(raw.name);
    if (!normalized) continue;

    const { entityId, outcome } = await resolveEntity(
      db,
      explorationId,
      raw.name,
      type,
      raw.canonical_url ?? null,
    );

    // The subject frequently appears in its own results under a variant name.
    // That is a successful dedup, not an edge.
    if (entityId === subjectId) {
      reports.push({ name: raw.name, entityId, outcome });
      continue;
    }

    const edge = canonicalizeEdge(
      { id: subjectId, type: subjectType },
      { id: entityId, type },
      coercePredicate(raw.predicate),
    );

    const { error } = await db.rpc("upsert_relationship", {
      p_exploration_id: explorationId,
      p_source_id: edge.sourceId,
      p_target_id: edge.targetId,
      p_predicate: edge.predicate,
      p_source_url: raw.source_url.trim(),
      p_excerpt: raw.excerpt.trim().slice(0, 1000),
      p_run_id: runId,
    });
    if (error) throw new Error(`upsert_relationship: ${error.message}`);

    reports.push({ name: raw.name, entityId, outcome });
  }

  return reports;
}
