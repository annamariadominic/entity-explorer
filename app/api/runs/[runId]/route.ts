import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";
import { pollRun } from "@/lib/parallel";
import { ingestRun } from "@/lib/ingest";

/** Runs that outlive this are marked failed rather than polled forever. */
const CEILING_MS = 3 * 60 * 1000;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ runId: string }> },
) {
  const { runId } = await ctx.params;
  const db = serverClient();

  try {
    const { data: run, error } = await db
      .from("runs")
      .select("id, exploration_id, entity_id, parallel_run_id, status, error, created_at")
      .eq("id", runId)
      .single();
    if (error || !run) {
      return NextResponse.json({ error: "Run not found" }, { status: 404 });
    }

    if (run.status !== "pending") {
      return NextResponse.json({ status: run.status, error: run.error, resolutions: [] });
    }

    if (Date.now() - new Date(run.created_at).getTime() > CEILING_MS) {
      return fail(db, run.id, "Research timed out after 3 minutes.");
    }

    const poll = await pollRun(run.parallel_run_id!);
    if (poll.state === "pending") {
      return NextResponse.json({ status: "pending", resolutions: [] });
    }
    if (poll.state === "failed") {
      return fail(db, run.id, poll.error);
    }

    const { data: subject } = await db
      .from("entities")
      .select("id, type")
      .eq("id", run.entity_id)
      .single();
    if (!subject) return fail(db, run.id, "Subject entity disappeared.");

    const resolutions = await ingestRun(
      db,
      run.exploration_id,
      subject.id,
      subject.type,
      run.id,
      poll.entities,
    );

    await db
      .from("entities")
      .update({ expanded_at: new Date().toISOString() })
      .eq("id", run.entity_id);

    await db
      .from("runs")
      .update({ status: "complete", completed_at: new Date().toISOString() })
      .eq("id", run.id);

    return NextResponse.json({
      status: "complete",
      // Zero discovered entities is an empty leaf, not a failure.
      empty: resolutions.length === 0,
      resolutions,
    });
  } catch (err) {
    return fail(db, runId, err instanceof Error ? err.message : "Unexpected error");
  }
}

async function fail(
  db: ReturnType<typeof serverClient>,
  runId: string,
  error: string,
) {
  await db
    .from("runs")
    .update({ status: "failed", error, completed_at: new Date().toISOString() })
    .eq("id", runId);
  return NextResponse.json({ status: "failed", error, resolutions: [] });
}
