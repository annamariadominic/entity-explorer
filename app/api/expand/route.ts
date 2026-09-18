import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";
import { createRun } from "@/lib/parallel";

export async function POST(req: Request) {
  try {
    const { entityId } = await req.json();
    if (!entityId) {
      return NextResponse.json({ error: "entityId required" }, { status: 400 });
    }

    const db = serverClient();
    const { data: entity, error } = await db
      .from("entities")
      .select("id, exploration_id, canonical_name, type, canonical_url, expanded_at")
      .eq("id", entityId)
      .single();
    if (error || !entity) {
      return NextResponse.json({ error: "Entity not found" }, { status: 404 });
    }

    // An expansion already in flight should not spawn a second run.
    const { data: active } = await db
      .from("runs")
      .select("id")
      .eq("entity_id", entityId)
      .eq("status", "pending")
      .limit(1);
    if (active?.length) {
      return NextResponse.json({ runId: active[0].id, reused: true });
    }

    const parallelRunId = await createRun(
      entity.canonical_name,
      entity.type,
      entity.canonical_url,
    );

    const { data: run, error: runError } = await db
      .from("runs")
      .insert({
        exploration_id: entity.exploration_id,
        entity_id: entity.id,
        parallel_run_id: parallelRunId,
      })
      .select("id")
      .single();
    if (runError) throw new Error(runError.message);

    return NextResponse.json({ runId: run.id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
