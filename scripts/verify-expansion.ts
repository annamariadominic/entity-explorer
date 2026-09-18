/**
 * Manual verification of expansion, deduplication and convergence (issue #5).
 *
 * Drives the same routes the page drives — POST /api/explorations, POST
 * /api/expand, GET /api/runs/:id, GET /api/graph — against real research
 * output, then checks what landed in the database. The ingest-seam tests
 * (`npm run test:db`) prove the rules; this proves they hold on rows a real
 * research call produced, which is the thing a fixture cannot show.
 *
 * Two neighbours are expanded at the same time and polled together, so
 * out-of-order settling is exercised rather than assumed. Deduplication is
 * confirmed in all three places it has to agree: the alias row in the
 * database, the outcome the run endpoint reported, and the alias count in the
 * graph payload the node renders from.
 *
 * Needs the dev server running. Costs three real research runs.
 *
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/verify-expansion.ts [seed name] [company|person|technology]
 */
import { serverClient } from "../lib/supabase.ts";
import { normalizeName } from "../lib/normalize.ts";
import type { GraphNode, GraphPayload, ResolutionOutcome } from "../lib/types.ts";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
/** The app fails a run at five minutes; a minute past that reports a hang as a hang. */
const WAIT_MS = 6 * 60 * 1000;
/**
 * The seed matters, and not only for how dense the neighbourhood is. The
 * deduplication checks need a shared third entity to come back under a name
 * that is not the one its node carries, and the research prompt asks for full
 * canonical names, so a seed already written in its fullest form tends to be
 * echoed back verbatim: seeding "Apple Inc." re-surfaced it from both
 * expansions and deduplicated correctly, but produced no alias row to confirm
 * it by. Seeding the short form of a company that sources usually write with
 * a legal suffix gives the variant that the alias row and the badge exist to
 * show. A sparse seed leaves the checks with nothing to look at at all.
 */
const seed = process.argv[2] ?? "Stripe";
const seedType = process.argv[3] ?? "company";

const db = serverClient();
const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

type Resolution = { name: string; entityId: string; outcome: ResolutionOutcome };
type Settled = { status?: string; error?: string; empty?: boolean; resolutions?: Resolution[] };

async function graphOf(explorationId: string): Promise<GraphPayload> {
  return (await fetch(`${BASE}/api/graph?explorationId=${explorationId}`)).json();
}

/** Polls one run to completion the way the page does, and keeps what it reported. */
async function settle(runId: string): Promise<Settled> {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const body: Settled = await (await fetch(`${BASE}/api/runs/${runId}`)).json();
    if (body.status !== "pending") return body;
    if (Date.now() - started > WAIT_MS) return { status: "pending" };
  }
}

async function runCount(entityId: string) {
  const { data } = await db.from("runs").select("id").eq("entity_id", entityId);
  return data?.length ?? 0;
}

// ---------------------------------------------------------------- seed

console.log(`Seeding "${seed}" (${seedType})`);
const startRes = await fetch(`${BASE}/api/explorations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ query: seed, type: seedType }),
});
const start = await startRes.json();
if (!startRes.ok) throw new Error(`could not start: ${start.error}`);
const explorationId: string = start.explorationId;
const seedEntityId: string = start.seedEntityId;
console.log(`exploration=${explorationId}\nseedEntity=${seedEntityId}\n`);

const seedRun = await settle(start.runId);
check("the seed run completed", seedRun.status === "complete", seedRun.error ?? seedRun.status);
if (seedRun.status !== "complete") {
  console.error("\nCannot verify expansion without a seeded graph.");
  process.exit(1);
}

let graph = await graphOf(explorationId);
const seedNode = graph.nodes.find((n) => n.id === seedEntityId)!;
check("the seed is marked expanded in the payload the node renders from", seedNode.expanded);
check(
  "its neighbours are marked unexpanded",
  graph.nodes.filter((n) => n.id !== seedEntityId).every((n) => !n.expanded),
  `${graph.nodes.length - 1} neighbours`,
);

// ------------------------------------------- clicking an expanded node

console.log("\nClicking an already-expanded node selects rather than researching");
const runsBefore = await runCount(seedEntityId);
const reclick = await fetch(`${BASE}/api/expand`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ entityId: seedEntityId }),
});
const reclickBody = await reclick.json();
check("expanding an expanded entity is refused rather than erroring", reclick.ok, String(reclick.status));
check("the refusal is reported as alreadyExpanded", reclickBody.alreadyExpanded === true, JSON.stringify(reclickBody));
check("no runId is handed back to poll", !reclickBody.runId);
check("no second run was created", (await runCount(seedEntityId)) === runsBefore, `${runsBefore} runs`);

// ------------------------------------------- two expansions at once

const targets = graph.nodes.filter((n) => n.id !== seedEntityId).slice(0, 2);
if (targets.length < 2) {
  console.error("\nSeed returned fewer than two neighbours; nothing to expand concurrently.");
  process.exit(1);
}
console.log(`\nExpanding two neighbours at once: ${targets.map((t) => t.name).join(" and ")}`);

const started = await Promise.all(
  targets.map(async (node) => {
    const res = await fetch(`${BASE}/api/expand`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId: node.id }),
    });
    return { node, ok: res.ok, body: await res.json() };
  }),
);
for (const { node, ok, body } of started) {
  check(`clicking unexpanded "${node.name}" begins research`, ok && Boolean(body.runId), body.error ?? "");
}
const pendingStatuses = await Promise.all(
  started.map(async ({ body }) => {
    const { data } = await db.from("runs").select("status").eq("id", body.runId).single();
    return data?.status;
  }),
);
check("both runs are pending at once", pendingStatuses.every((s) => s === "pending"), pendingStatuses.join(", "));

const nodesBefore = graph.nodes.length;
const order: string[] = [];
const settledRuns = await Promise.all(
  started.map(async ({ node, body }) => {
    const result = await settle(body.runId);
    order.push(node.name);
    return { node, result };
  }),
);
console.log(`  settled in the order: ${order.join(", ")}`);
for (const { node, result } of settledRuns) {
  check(`"${node.name}" settled`, result.status === "complete", result.error ?? result.status);
}

graph = await graphOf(explorationId);
check("the graph grew", graph.nodes.length > nodesBefore, `${nodesBefore} -> ${graph.nodes.length} nodes`);
for (const { node } of settledRuns) {
  const attached = graph.edges.filter((e) => e.source === node.id || e.target === node.id).length;
  check(`"${node.name}" attached to the graph`, attached > 0, `${attached} edges`);
  check(
    `"${node.name}" is now marked expanded`,
    Boolean(graph.nodes.find((n) => n.id === node.id)?.expanded),
  );
}

// ------------------------------------------- deduplication

console.log("\nDeduplication is visible in all three places");
const resolutions = settledRuns.flatMap((r) => r.result.resolutions ?? []);
const reused = resolutions.filter((r) => r.outcome !== "created");
check(
  "an expansion re-surfaced an entity the graph already had",
  reused.length > 0,
  reused.map((r) => `${r.name}:${r.outcome}`).join(", ") || "no reuse in this run",
);

const { data: aliasRows } = await db
  .from("entity_aliases")
  .select("entity_id, alias_raw, alias_normalized")
  .eq("exploration_id", explorationId);
const byId = new Map(graph.nodes.map((n) => [n.id, n]));

// A variant name is reuse where the surface name is not the canonical one:
// exactly the case the alias row and the badge exist to show.
const variants = reused.filter((r) => byId.get(r.entityId) && byId.get(r.entityId)!.name !== r.name);
check(
  "one of them arrived under a name the node is not called",
  variants.length > 0,
  variants.map((r) => `"${r.name}" -> "${byId.get(r.entityId)!.name}"`).join(", ") ||
    "every re-surfaced entity came back under its canonical name; try a seed whose full form sources vary on",
);

for (const variant of variants) {
  const node = byId.get(variant.entityId)!;
  const alias = (aliasRows ?? []).find(
    (a) => a.entity_id === variant.entityId && a.alias_normalized === normalizeName(variant.name),
  );
  check(`  alias row records "${variant.name}" against "${node.name}"`, Boolean(alias));
  check(`  the run endpoint reported it as a match`, variant.outcome !== "created", variant.outcome);
  check(`  the node's alias count includes it`, node.aliasCount > 0, `${node.aliasCount} aliases`);
}

// The badge is read straight off the payload, so it has to equal the rows.
const aliasCountsFromRows = new Map<string, number>();
for (const a of aliasRows ?? []) {
  aliasCountsFromRows.set(a.entity_id, (aliasCountsFromRows.get(a.entity_id) ?? 0) + 1);
}
check(
  "every node's alias count equals its stored alias rows",
  graph.nodes.every((n) => n.aliasCount === (aliasCountsFromRows.get(n.id) ?? 0)),
);
const deduped = graph.nodes.filter((n) => n.aliasCount > 0);
check(
  "at least one node reports itself as deduplicated in the panel",
  deduped.length > 0,
  deduped.map((n: GraphNode) => `${n.name} (${n.aliasCount + 1} names)`).join(", ") || "none",
);

// ------------------------------------------- distinct entities stay distinct

console.log("\nDistinct entities were not merged into each other");
const { data: entities } = await db
  .from("entities")
  .select("id, canonical_name, normalized_name, type, canonical_url")
  .eq("exploration_id", explorationId);

const identityKeys = new Set((entities ?? []).map((e) => `${e.normalized_name}|${e.type}`));
check(
  "no two entities share a normalized name and type",
  identityKeys.size === (entities ?? []).length,
  `${identityKeys.size} keys for ${entities?.length ?? 0} entities`,
);

// An alias whose normalized form is another entity's identity key means two
// different things were filed as one. This is the failure that is worse than a
// missed merge, so it is asserted rather than reported.
const hijacked = (aliasRows ?? []).filter((a) => {
  const owner = (entities ?? []).find((e) => e.id === a.entity_id);
  return (entities ?? []).some(
    (e) => e.id !== a.entity_id && e.normalized_name === a.alias_normalized && e.type === owner?.type,
  );
});
check(
  "no alias points at a name another entity already answers to",
  hijacked.length === 0,
  hijacked.map((a) => a.alias_raw).join(", "),
);

console.log("\n  aliases recorded, for eye-checking that none is a different thing:");
for (const a of aliasRows ?? []) {
  console.log(`    "${a.alias_raw}"  ->  ${byId.get(a.entity_id)?.name ?? a.entity_id}`);
}

// ------------------------------------------- edges and evidence

console.log("\nRelationships and evidence");
const { data: rels } = await db
  .from("relationships")
  .select("id, source_id, target_id, predicate")
  .eq("exploration_id", explorationId);
const relIds = (rels ?? []).map((r) => r.id);
const { data: evidence } = await db
  .from("relationship_evidence")
  .select("relationship_id")
  .in("relationship_id", relIds);

const evidenceCounts = new Map<string, number>();
for (const e of evidence ?? []) {
  evidenceCounts.set(e.relationship_id, (evidenceCounts.get(e.relationship_id) ?? 0) + 1);
}
check("every relationship carries evidence", relIds.every((id) => (evidenceCounts.get(id) ?? 0) > 0));
check(
  "no relationship is a self-edge",
  (rels ?? []).every((r) => r.source_id !== r.target_id),
);

const pairs = new Set((rels ?? []).map((r) => `${r.source_id}|${r.target_id}|${r.predicate}`));
const twinned = (rels ?? []).filter((r) => pairs.has(`${r.target_id}|${r.source_id}|${r.predicate}`));
check(
  "no edge exists alongside its own reverse",
  twinned.length === 0,
  twinned.map((r) => r.predicate).join(", "),
);

const accumulated = relIds.filter((id) => (evidenceCounts.get(id) ?? 0) > 1);
console.log(
  `  ${relIds.length} relationships, ${evidence?.length ?? 0} evidence rows, ` +
    `${accumulated.length} relationship(s) supported by more than one source`,
);

console.log(`\nexploration id for the browser check: ${explorationId}`);
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
