/**
 * Manual verification gate for the Parallel result envelope (ADR-0001).
 *
 * Issues ONE real research run through the application's own request builder
 * and parser, dumps the raw envelope, times the run, and checks the returned
 * rows against the entity-type and predicate vocabularies.
 *
 * This is deliberately not a test: it calls the real API and costs a run. A
 * recorded fixture would only prove that the fixture agrees with the parser,
 * which is the question this script exists to answer properly.
 *
 *   node --experimental-strip-types scripts/verify-parallel-envelope.ts
 */
import { readFileSync, writeFileSync } from "node:fs";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match) process.env[match[1]] = match[2];
}

const { createRun, pollRun } = await import("../lib/parallel.ts");
const { ENTITY_TYPES } = await import("../lib/types.ts");
const { PREDICATES } = await import("../lib/predicates.ts");

const API = "https://api.parallel.ai/v1/tasks/runs";
const OUT = process.env.PROBE_OUT ?? "parallel-envelope.json";
const CEILING_MS = 5 * 60 * 1000;
const key = process.env.PARALLEL_API_KEY!;

const started = Date.now();
const runId = await createRun("Stripe", "company", "https://stripe.com");
console.log(`run_id=${runId}`);

let status: Record<string, unknown> = {};
let elapsed = 0;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const res = await fetch(`${API}/${runId}`, { headers: { "x-api-key": key } });
  status = await res.json();
  elapsed = Date.now() - started;
  console.log(`  ${(elapsed / 1000).toFixed(0)}s status=${status.status}`);
  if (["completed", "failed", "cancelled"].includes(String(status.status))) break;
  if (elapsed > 15 * 60 * 1000) throw new Error("run did not settle within 15 minutes");
}

const resultRes = await fetch(`${API}/${runId}/result`, { headers: { "x-api-key": key } });
const result = await resultRes.json();
writeFileSync(OUT, JSON.stringify({ elapsedMs: elapsed, status, result }, null, 2));

console.log(`\nraw envelope written to ${OUT}`);
console.log(`status keys: ${Object.keys(status).join(", ")}`);
console.log(`result keys: ${Object.keys(result).join(", ")}`);
console.log(`status carries an inline result: ${status.result !== undefined}`);

const poll = await pollRun(runId);
console.log(`\nparser state: ${poll.state}`);
if (poll.state !== "complete") process.exit(1);

const rows = poll.entities;
const badTypes = rows.filter((row) => !ENTITY_TYPES.includes(row.type));
const badPredicates = rows.filter((row) => !(PREDICATES as readonly string[]).includes(row.predicate));
const missingEvidence = rows.filter((row) => !row.source_url?.trim() || !row.excerpt?.trim());

console.log(`entities extracted: ${rows.length}`);
console.log(`types outside vocabulary: ${badTypes.length}`);
console.log(`predicates outside vocabulary: ${badPredicates.length}`);
console.log(`rows missing a source URL or excerpt: ${missingEvidence.length}`);
console.log(`latency: ${(elapsed / 1000).toFixed(1)}s against a ${CEILING_MS / 1000}s ceiling`);
for (const row of rows) {
  console.log(`  ${row.type.padEnd(10)} ${row.predicate.padEnd(16)} ${row.name}`);
}

// Zero entities here is the failure this gate exists to catch: it is
// indistinguishable downstream from research that genuinely found nothing.
if (!rows.length || badTypes.length || badPredicates.length || missingEvidence.length) {
  process.exit(1);
}
