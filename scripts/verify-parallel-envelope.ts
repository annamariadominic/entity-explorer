/**
 * Manual verification gate for the Parallel result envelope (ADR-0001).
 *
 * Issues ONE real research run, dumps the raw envelope, times it, and checks
 * the rows against the entity-type and predicate vocabularies. Crucially it
 * compares the rows the API returned against the rows the parser kept: the
 * parser silently drops rows with no source URL or excerpt, and a completed
 * run whose rows were all dropped presents downstream as an empty leaf.
 *
 * This is deliberately not a test: it calls the real API and costs a run. A
 * recorded fixture would only prove that the fixture agrees with the parser,
 * which is the question this script exists to answer properly.
 *
 *   node --env-file=.env.local --experimental-strip-types \
 *     scripts/verify-parallel-envelope.ts
 */
import { writeFileSync } from "node:fs";
import { createRun, pollRun } from "../lib/parallel.ts";
import { ENTITY_TYPES } from "../lib/types.ts";
import { PREDICATES } from "../lib/predicates.ts";

const API = "https://api.parallel.ai/v1/tasks/runs";
const OUT = "parallel-envelope.json";
/** The app's own ceiling, from app/api/runs/[runId]/route.ts. */
const CEILING_MS = 5 * 60 * 1000;

const key = process.env.PARALLEL_API_KEY;
if (!key) throw new Error("Missing PARALLEL_API_KEY — pass --env-file=.env.local");

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
  if (elapsed > 3 * CEILING_MS) throw new Error("run never settled");
}

// Fetched raw as well as through pollRun: the parser reports what survived
// validation, and this gate has to see what arrived before it.
const resultRes = await fetch(`${API}/${runId}/result`, { headers: { "x-api-key": key } });
const result = await resultRes.json();
writeFileSync(OUT, JSON.stringify({ elapsedMs: elapsed, status, result }, null, 2));

console.log(`\nraw envelope written to ${OUT}`);
console.log(`status keys: ${Object.keys(status).join(", ")}`);
console.log(`result keys: ${Object.keys(result).join(", ")}`);
console.log(`status carries an inline result: ${status.result !== undefined}`);

// The app ignores these; they are how the API reports that it rewrote the
// declared schema (ADR-0001).
for (const warning of (status.warnings as { type: string; message: string }[]) ?? []) {
  console.log(`warning [${warning.type}]: ${warning.message}`);
}

const returned: unknown[] = result?.output?.content?.entities ?? [];
const poll = await pollRun(runId);
console.log(`\nparser state: ${poll.state}`);
if (poll.state !== "complete") process.exit(1);

const kept = poll.entities;
const discarded = returned.length - kept.length;
const badTypes = kept.filter((row) => !ENTITY_TYPES.includes(row.type));
const badPredicates = kept.filter(
  (row) => !(PREDICATES as readonly string[]).includes(row.predicate),
);

console.log(`entities returned by the API: ${returned.length}`);
console.log(`entities kept by the parser:  ${kept.length}`);
console.log(`discarded for missing source URL or excerpt: ${discarded}`);
console.log(`types outside vocabulary: ${badTypes.length}`);
console.log(`predicates outside vocabulary: ${badPredicates.length}`);
console.log(`latency: ${(elapsed / 1000).toFixed(1)}s against the app's ${CEILING_MS / 1000}s ceiling`);
for (const row of kept) {
  console.log(`  ${row.type.padEnd(10)} ${row.predicate.padEnd(16)} ${row.name}`);
}

const failures = [
  !returned.length && "the API returned no entities",
  !kept.length && "the parser kept no entities — a completed run would present as an empty leaf",
  discarded > 0 && `${discarded} returned rows were discarded by validation`,
  badTypes.length && `${badTypes.length} types outside the vocabulary`,
  badPredicates.length && `${badPredicates.length} predicates outside the vocabulary`,
  elapsed > CEILING_MS && `run outlived the app's ceiling by ${((elapsed - CEILING_MS) / 1000).toFixed(0)}s`,
].filter(Boolean);

if (failures.length) {
  console.error(`\nFAILED:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nPASSED");
