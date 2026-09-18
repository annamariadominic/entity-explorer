/**
 * Manual verification of the seed-to-graph path (issue #4).
 *
 * Drives the same routes the page drives — POST /api/explorations, then poll
 * GET /api/runs/:id — and then confirms what landed in the database rather
 * than trusting the rendering. A graph can render from rows written wrongly,
 * and a run that never closes looks identical to one that did until the next
 * expansion behaves strangely, so the run row's status and completion
 * timestamp are checked explicitly.
 *
 * Needs the dev server running. Costs one real research run.
 *
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/verify-seed-path.ts [seed name] [company|person|technology]
 */
import { serverClient } from "../lib/supabase.ts";
import type { GraphEdge, GraphNode, GraphPayload } from "../lib/types.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
/**
 * The app gives up on a run after 5 minutes (app/api/runs/[runId]/route.ts),
 * marking it failed. Waiting a minute past that lets the app's own ceiling be
 * the thing that fires, so a hang here is reported as a hang rather than as a
 * run that failed to complete.
 */
const WAIT_MS = 6 * 60 * 1000;
const seed = process.argv[2] ?? "Anthropic";
const seedType = process.argv[3] ?? "company";

const failures: string[] = [];
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const startRes = await fetch(`${BASE}/api/explorations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: seed, type: seedType }),
});
const start = await startRes.json();
if (!startRes.ok) throw new Error(`could not start: ${start.error}`);
console.log(`exploration=${start.explorationId}\nseedEntity=${start.seedEntityId}\nrun=${start.runId}\n`);

const db = serverClient();

console.log("Research starts on the named subject");
const { data: seedRow } = await db
  .from("entities")
  .select("canonical_name, type, exploration_id")
  .eq("id", start.seedEntityId)
  .single();
check("seed entity carries the typed name", seedRow?.canonical_name === seed, seedRow?.canonical_name);
check("seed entity carries the chosen type", seedRow?.type === seedType, seedRow?.type);

// The page sets the seed to "loading" off this response and renders it before
// any research has come back, so the row and the pending run must both exist
// the moment the POST returns.
const { data: pendingRun } = await db
  .from("runs")
  .select("status, entity_id")
  .eq("id", start.runId)
  .single();
check("a pending run exists for the seed as soon as the request returns",
  pendingRun?.status === "pending" && pendingRun.entity_id === start.seedEntityId,
  pendingRun?.status);

console.log("\nResearch completes");
const started = Date.now();
let settled: { status?: string; error?: string; empty?: boolean } = {};
let timedOut = false;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  settled = await (await fetch(`${BASE}/api/runs/${start.runId}`)).json();
  if (settled.status !== "pending") break;
  if (Date.now() - started > WAIT_MS) {
    timedOut = true;
    break;
  }
}
check(
  "the run settled rather than hanging",
  !timedOut,
  timedOut ? `still pending after ${WAIT_MS / 1000}s` : `${((Date.now() - started) / 1000).toFixed(0)}s`,
);
check(
  "the run completed",
  settled.status === "complete",
  `${settled.status ?? "no status"}${settled.error ? `: ${settled.error}` : ""}`,
);
check("the run is not an empty leaf", settled.empty !== true);

console.log("\nRows are present in the database");
const explorationId = start.explorationId;
const [{ data: entities }, { data: relationships }, { data: run }, { data: exploration }] = await Promise.all([
  db.from("entities").select("id, canonical_name, type, expanded_at").eq("exploration_id", explorationId),
  db.from("relationships").select("id, source_id, target_id, predicate").eq("exploration_id", explorationId),
  db.from("runs").select("status, completed_at, error").eq("id", start.runId).single(),
  db.from("explorations").select("seed_entity_id").eq("id", explorationId).single(),
]);
const relationshipIds = (relationships ?? []).map((r) => r.id);
const evidence = relationshipIds.length
  ? (
      await db
        .from("relationship_evidence")
        .select("relationship_id, source_url, excerpt")
        .in("relationship_id", relationshipIds)
    ).data
  : [];

check("entity rows written", (entities?.length ?? 0) > 1, `${entities?.length ?? 0} entities`);
check("relationship rows written", relationshipIds.length > 0, `${relationshipIds.length} relationships`);
check("evidence rows written", (evidence?.length ?? 0) > 0, `${evidence?.length ?? 0} evidence rows`);
check("every evidence row has a source URL and excerpt",
  (evidence ?? []).every((e) => e.source_url?.trim() && e.excerpt?.trim()));
check("every relationship has at least one evidence row",
  relationshipIds.every((id) => (evidence ?? []).some((e) => e.relationship_id === id)));
check("the exploration records its seed entity", exploration?.seed_entity_id === start.seedEntityId);
check("the seed is marked expanded", Boolean(entities?.find((e) => e.id === start.seedEntityId)?.expanded_at));

console.log("\nThe run row closes");
check("run row status is complete", run?.status === "complete", run?.status);
check("run row carries a completion timestamp", Boolean(run?.completed_at), run?.completed_at ?? "null");

console.log("\nThe graph payload renders the seed and its neighbours");
const graph: GraphPayload = await (await fetch(`${BASE}/api/graph?explorationId=${explorationId}`)).json();
check("graph returns the seed plus neighbours", graph.nodes.length > 1, `${graph.nodes.length} nodes`);
check("graph returns edges, not a cluster of dots", graph.edges.length > 0, `${graph.edges.length} edges`);
check("exactly one node is flagged as the seed",
  graph.nodes.filter((n: GraphNode) => n.isSeed).length === 1);
check("every edge connects two returned nodes",
  graph.edges.every((e: GraphEdge) =>
    graph.nodes.some((n: GraphNode) => n.id === e.source) &&
    graph.nodes.some((n: GraphNode) => n.id === e.target)));
check("every edge carries evidence for the panel",
  graph.edges.every((e: GraphEdge) => e.evidenceCount > 0));
// Without this, a seed sitting isolated beside eight unrelated edges would
// satisfy every count above.
check("the seed is an endpoint of at least one relationship",
  graph.edges.some((e: GraphEdge) => e.source === start.seedEntityId || e.target === start.seedEntityId),
  `${graph.edges.filter((e: GraphEdge) => e.source === start.seedEntityId || e.target === start.seedEntityId).length} of ${graph.edges.length} edges touch the seed`);

const types = new Set(graph.nodes.map((n: GraphNode) => n.type));
console.log(`\nentity types present: ${[...types].join(", ")}`);
console.log(`predicates present: ${[...new Set(graph.edges.map((e: GraphEdge) => e.predicate))].join(", ")}`);
console.log(`\nexploration id for the browser check: ${explorationId}`);

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
