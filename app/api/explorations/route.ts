import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";
import { resolveEntity } from "@/lib/ingest";
import { createRun } from "@/lib/parallel";
import { ENTITY_TYPES, type EntityType } from "@/lib/types";

export async function POST(req: Request) {
  try {
    const { query, type } = await req.json();
    const seedName = String(query ?? "").trim();
    if (!seedName) {
      return NextResponse.json({ error: "Enter an entity name." }, { status: 400 });
    }
    const seedType: EntityType = ENTITY_TYPES.includes(type) ? type : "company";

    const db = serverClient();

    const { data: exploration, error: explorationError } = await db
      .from("explorations")
      .insert({ seed_query: seedName })
      .select("id")
      .single();
    if (explorationError) throw new Error(explorationError.message);

    const { entityId } = await resolveEntity(
      db,
      exploration.id,
      seedName,
      seedType,
      null,
    );

    await db
      .from("explorations")
      .update({ seed_entity_id: entityId })
      .eq("id", exploration.id);

    const parallelRunId = await createRun(seedName, seedType, null);
    const { data: run, error: runError } = await db
      .from("runs")
      .insert({
        exploration_id: exploration.id,
        entity_id: entityId,
        parallel_run_id: parallelRunId,
      })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);

    return NextResponse.json({
      explorationId: exploration.id,
      seedEntityId: entityId,
      runId: run.id,
    });
  } catch (err) {
    return NextResponse.json({ error: message(err) }, { status: 500 });
  }
}

function message(err: unknown) {
  return err instanceof Error ? err.message : "Unexpected error";
}
