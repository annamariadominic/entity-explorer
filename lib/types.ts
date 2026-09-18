import type { Predicate } from "./predicates";

export type EntityType = "company" | "person" | "technology";
export const ENTITY_TYPES: EntityType[] = ["company", "person", "technology"];

export type ResolutionOutcome =
  | "created"
  | "matched_by_identifier"
  | "matched_by_name"
  | "matched_by_alias"
  | "matched_by_race";

export type NodeState = "idle" | "loading" | "complete" | "failed" | "empty";

export type GraphNode = {
  id: string;
  name: string;
  type: EntityType;
  aliasCount: number;
  expanded: boolean;
  isSeed: boolean;
};

export type GraphEdge = {
  id: string;
  source: string;
  target: string;
  predicate: Predicate;
  evidenceCount: number;
};

export type GraphPayload = {
  explorationId: string;
  seedEntityId: string | null;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type Evidence = {
  id: string;
  sourceUrl: string;
  excerpt: string;
};

/** One row per entity the research returned, before it hit the database. */
export type DiscoveredEntity = {
  name: string;
  type: EntityType;
  canonical_url?: string | null;
  predicate: string;
  source_url: string;
  excerpt: string;
};
