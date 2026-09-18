import type { EntityType } from "./types";

export const PREDICATES = [
  "founded_by",
  "acquired",
  "works_at",
  "subsidiary_of",
  "built_by",
  "invested_in",
  "partnered_with",
  "competes_with",
  "uses_technology",
  "related_to",
] as const;

export type Predicate = (typeof PREDICATES)[number];

const PREDICATE_SET = new Set<string>(PREDICATES);

/** Anything the model invents becomes related_to rather than being dropped. */
export function coercePredicate(raw: string): Predicate {
  const key = raw?.toLowerCase().trim().replace(/[\s-]+/g, "_");
  return PREDICATE_SET.has(key) ? (key as Predicate) : "related_to";
}

/**
 * Predicates whose two endpoints are the same real-world fact read either way.
 * "A competes_with B" and "B competes_with A" must land on one row.
 */
const SYMMETRIC = new Set<Predicate>(["partnered_with", "competes_with", "related_to"]);

/**
 * For these, the entity types tell us which way the edge must point. The
 * research prompt asks for `<expanded entity> <predicate> <neighbor>`, but
 * expanding the *other* end of an existing edge naturally produces the
 * inverse reading — e.g. expanding a founder yields "Person founded_by Company".
 * Flipping by type signature collapses that onto the existing row.
 */
const DIRECTED: Partial<Record<Predicate, { source: EntityType[]; target: EntityType[] }>> = {
  founded_by: { source: ["company", "technology"], target: ["person"] },
  works_at: { source: ["person"], target: ["company"] },
  built_by: { source: ["technology"], target: ["company", "person"] },
  uses_technology: { source: ["company", "person", "technology"], target: ["technology"] },
};

export type EdgeEndpoint = { id: string; type: EntityType };

/**
 * Returns the edge in its canonical direction so the DB uniqueness key does
 * the deduplication for us.
 *
 * Known gap: `acquired`, `invested_in` and `subsidiary_of` connect two
 * companies, so types cannot tell us which way round the model meant. Those
 * rely on the prompt convention alone, and expanding both ends can still
 * produce a pair of opposing edges. Resolving that needs a direction field or
 * an inverse vocabulary — deliberately out of scope for v1.
 */
export function canonicalizeEdge(
  source: EdgeEndpoint,
  target: EdgeEndpoint,
  predicate: Predicate,
): { sourceId: string; targetId: string; predicate: Predicate } {
  if (SYMMETRIC.has(predicate)) {
    // Stable ordering by id: both readings produce the same tuple.
    const [a, b] = source.id < target.id ? [source, target] : [target, source];
    return { sourceId: a.id, targetId: b.id, predicate };
  }

  const signature = DIRECTED[predicate];
  if (signature) {
    const forwardOk =
      signature.source.includes(source.type) && signature.target.includes(target.type);
    const reverseOk =
      signature.source.includes(target.type) && signature.target.includes(source.type);
    // Only flip when the reverse reading is valid and the forward one is not.
    if (!forwardOk && reverseOk) {
      return { sourceId: target.id, targetId: source.id, predicate };
    }
  }

  return { sourceId: source.id, targetId: target.id, predicate };
}
