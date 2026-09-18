import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";
import type { GraphPayload } from "@/lib/types";

export async function GET(req: Request) {
  const explorationId = new URL(req.url).searchParams.get("explorationId");
  if (!explorationId) {
    return NextResponse.json({ error: "explorationId required" }, { status: 400 });
  }

  try {
    const db = serverClient();

    const [exploration, entities, relationships, aliases] = await Promise.all([
      db.from("explorations").select("seed_entity_id").eq("id", explorationId).single(),
      db
        .from("entities")
        .select("id, canonical_name, type, expanded_at")
        .eq("exploration_id", explorationId),
      db
        .from("relationships")
        .select("id, source_id, target_id, predicate")
        .eq("exploration_id", explorationId),
      db.from("entity_aliases").select("entity_id").eq("exploration_id", explorationId),
    ]);

    const aliasCounts = new Map<string, number>();
    for (const row of aliases.data ?? []) {
      aliasCounts.set(row.entity_id, (aliasCounts.get(row.entity_id) ?? 0) + 1);
    }

    // Evidence rows carry no exploration id, so they have to be fetched by
    // relationship: selecting them unfiltered reads every exploration's rows
    // and is silently truncated at PostgREST's default row limit, which shows
    // up as edges rendered thin with an evidence count of zero.
    const relationshipIds = (relationships.data ?? []).map((r) => r.id);
    const evidence = relationshipIds.length
      ? await db
          .from("relationship_evidence")
          .select("relationship_id")
          .in("relationship_id", relationshipIds)
      : { data: [] as { relationship_id: string }[] };

    const evidenceCounts = new Map<string, number>();
    for (const row of evidence.data ?? []) {
      evidenceCounts.set(
        row.relationship_id,
        (evidenceCounts.get(row.relationship_id) ?? 0) + 1,
      );
    }

    const seedEntityId = exploration.data?.seed_entity_id ?? null;

    const payload: GraphPayload = {
      explorationId,
      seedEntityId,
      nodes: (entities.data ?? []).map((e) => ({
        id: e.id,
        name: e.canonical_name,
        type: e.type,
        aliasCount: aliasCounts.get(e.id) ?? 0,
        expanded: Boolean(e.expanded_at),
        isSeed: e.id === seedEntityId,
      })),
      edges: (relationships.data ?? []).map((r) => ({
        id: r.id,
        source: r.source_id,
        target: r.target_id,
        predicate: r.predicate,
        evidenceCount: evidenceCounts.get(r.id) ?? 0,
      })),
    };

    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
