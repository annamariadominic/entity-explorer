import { NextResponse } from "next/server";
import { serverClient } from "@/lib/supabase";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ edgeId: string }> },
) {
  const { edgeId } = await ctx.params;
  try {
    const db = serverClient();
    const { data, error } = await db
      .from("relationship_evidence")
      .select("id, source_url, excerpt")
      .eq("relationship_id", edgeId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);

    return NextResponse.json({
      evidence: (data ?? []).map((row) => ({
        id: row.id,
        sourceUrl: row.source_url,
        excerpt: row.excerpt,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unexpected error" },
      { status: 500 },
    );
  }
}
