/**
 * Ingest-seam tests (issue #5), run against the real Supabase project.
 *
 * The seam is `ingestRun`: the highest point that is still deterministic. It
 * takes rows that have already been parsed out of a research response, so
 * nothing here depends on upstream latency or on what a research call happens
 * to return today, while everything below it — resolution order, the alias
 * rules, edge canonicalisation, the uniqueness constraints that convergence
 * relies on — is the real thing rather than a stand-in.
 *
 * Assertions are on externally observable outcomes: which entity a name
 * resolved to, what the resolution reported, and how many rows exist. They
 * should survive a rewrite of `resolve_entity`'s internals as long as its
 * resolution order and outcomes are preserved.
 *
 * Each test makes its own exploration and deletes it afterwards. Every table
 * cascades from the exploration row, so one delete is the whole cleanup.
 *
 *   npm run test:db
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { serverClient } from "../../supabase.ts";
import { ingestRun, resolveEntity } from "../../ingest.ts";
import type { DiscoveredEntity, EntityType } from "../../types.ts";

const configured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);
const skip = configured ? false : "needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY";
const db = configured ? serverClient() : (null as never);

type Subject = {
  explorationId: string;
  subjectId: string;
  subjectType: EntityType;
  subjectUrl: string | null;
};

/** A fresh exploration whose seed is the subject being expanded. */
async function seed(
  t: TestContext,
  name: string,
  type: EntityType = "company",
  url: string | null = null,
): Promise<Subject> {
  const { data, error } = await db
    .from("explorations")
    .insert({ seed_query: name })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  t.after(async () => {
    await db.from("explorations").delete().eq("id", data.id);
  });

  const { entityId } = await resolveEntity(db, data.id, name, type, url);
  await db.from("explorations").update({ seed_entity_id: entityId }).eq("id", data.id);
  return { explorationId: data.id, subjectId: entityId, subjectType: type, subjectUrl: url };
}

/** One row as a research response would carry it, before it hit the database. */
function row(over: Partial<DiscoveredEntity> & { name: string }): DiscoveredEntity {
  return {
    type: "company",
    predicate: "partnered_with",
    source_url: "https://source.test/a",
    excerpt: "An excerpt naming both parties.",
    ...over,
  };
}

/** Ingest `rows` as if `subject` had just been expanded. */
function ingest(subject: Subject, rows: DiscoveredEntity[]) {
  return ingestRun(
    db,
    subject.explorationId,
    subject.subjectId,
    subject.subjectType,
    subject.subjectUrl,
    randomUUID(),
    rows,
  );
}

async function entityIds(explorationId: string) {
  const { data } = await db.from("entities").select("id").eq("exploration_id", explorationId);
  return (data ?? []).map((e) => e.id as string);
}

async function relationships(explorationId: string) {
  const { data } = await db
    .from("relationships")
    .select("id, source_id, target_id, predicate")
    .eq("exploration_id", explorationId);
  return data ?? [];
}

async function evidenceFor(relationshipId: string) {
  const { data } = await db
    .from("relationship_evidence")
    .select("source_url, excerpt")
    .eq("relationship_id", relationshipId);
  return data ?? [];
}

test("a variant name discovered in a second expansion resolves to the first entity", { skip }, async (t) => {
  const subject = await seed(t, "Acme Robotics");

  const first = await ingest(subject, [row({ name: "Helio Dynamics, Inc." })]);
  const second = await ingest(subject, [
    row({ name: "Helio Dynamics", predicate: "competes_with", source_url: "https://source.test/b" }),
  ]);

  assert.equal(first[0].outcome, "created");
  assert.equal(second[0].outcome, "matched_by_name");
  assert.equal(second[0].entityId, first[0].entityId);

  // Subject plus one neighbour: the variant did not become a second node.
  assert.equal((await entityIds(subject.explorationId)).length, 2);

  // The badge on the node counts these rows, so the merge has to be visible
  // here and not only in what resolution reported.
  const { data: aliases } = await db
    .from("entity_aliases")
    .select("alias_raw")
    .eq("entity_id", first[0].entityId);
  assert.deepEqual((aliases ?? []).map((a) => a.alias_raw), ["Helio Dynamics"]);
});

test("a row naming the subject itself resolves onto it and produces no edge", { skip }, async (t) => {
  const subject = await seed(t, "Acme Robotics");

  const reports = await ingest(subject, [row({ name: "Acme Robotics Inc.", predicate: "related_to" })]);

  assert.equal(reports[0].entityId, subject.subjectId);
  assert.equal(reports[0].outcome, "matched_by_name");
  assert.deepEqual(await relationships(subject.explorationId), []);
});

test("the same relationship from two sources is one relationship with two excerpts", { skip }, async (t) => {
  const subject = await seed(t, "Acme Robotics");

  await ingest(subject, [
    row({ name: "Helio Dynamics", source_url: "https://source.test/one", excerpt: "First source." }),
  ]);
  await ingest(subject, [
    row({ name: "Helio Dynamics", source_url: "https://source.test/two", excerpt: "Second source." }),
  ]);

  const edges = await relationships(subject.explorationId);
  assert.equal(edges.length, 1);
  const evidence = await evidenceFor(edges[0].id);
  assert.equal(evidence.length, 2);
  assert.deepEqual(
    evidence.map((e) => e.source_url).sort(),
    ["https://source.test/one", "https://source.test/two"],
  );
});

test("an identical row ingested twice adds no second evidence row", { skip }, async (t) => {
  const subject = await seed(t, "Acme Robotics");
  const identical = row({ name: "Helio Dynamics", source_url: "https://source.test/one", excerpt: "Same words." });

  await ingest(subject, [identical]);
  await ingest(subject, [identical]);

  const edges = await relationships(subject.explorationId);
  assert.equal(edges.length, 1);
  assert.equal((await evidenceFor(edges[0].id)).length, 1);
});

test("expanding the far end of a type-directed edge collapses onto it", { skip }, async (t) => {
  const company = await seed(t, "Acme Robotics", "company");

  // Expanding the company reads "Acme Robotics founded_by Dana Okafor".
  const [founder] = await ingest(company, [
    row({ name: "Dana Okafor", type: "person", predicate: "founded_by", source_url: "https://source.test/one" }),
  ]);

  // Expanding the founder produces the inverse reading of the same fact.
  const person: Subject = {
    explorationId: company.explorationId,
    subjectId: founder.entityId,
    subjectType: "person",
    subjectUrl: null,
  };
  await ingest(person, [
    row({ name: "Acme Robotics", type: "company", predicate: "founded_by", source_url: "https://source.test/two" }),
  ]);

  const edges = await relationships(company.explorationId);
  assert.equal(edges.length, 1, "the inverse reading should not have twinned the edge");
  assert.equal(edges[0].source_id, company.subjectId);
  assert.equal(edges[0].target_id, founder.entityId);
  assert.equal((await evidenceFor(edges[0].id)).length, 2);
});

test("two concurrent expansions discovering the same entity converge on one row", { skip }, async (t) => {
  const first = await seed(t, "Acme Robotics");
  const { entityId: secondSubjectId } = await resolveEntity(
    db,
    first.explorationId,
    "Borealis Systems",
    "company",
    null,
  );
  const second: Subject = { ...first, subjectId: secondSubjectId };

  const [a, b] = await Promise.all([
    ingest(first, [row({ name: "Nimbus Compute", source_url: "https://source.test/one" })]),
    ingest(second, [row({ name: "Nimbus Compute", source_url: "https://source.test/two" })]),
  ]);

  assert.equal(a[0].entityId, b[0].entityId, "the racing expansions landed on different entities");

  // Three subjects-and-neighbours, not four: convergence is enforced by the
  // uniqueness constraint, so whichever call loses the race re-reads.
  assert.equal((await entityIds(first.explorationId)).length, 3);

  const outcomes = [a[0].outcome, b[0].outcome].sort();
  assert.equal(outcomes[0], "created");
  assert.ok(
    ["matched_by_name", "matched_by_race"].includes(outcomes[1]),
    `loser reported ${outcomes[1]}`,
  );

  // Each expansion still got its own edge to the shared entity.
  assert.equal((await relationships(first.explorationId)).length, 2);
});

test("genuinely distinct entities stay distinct", { skip }, async (t) => {
  const subject = await seed(t, "Acme Robotics");

  const reports = await ingest(subject, [
    row({ name: "Helio Dynamics" }),
    row({ name: "Borealis Systems" }),
  ]);

  assert.notEqual(reports[0].entityId, reports[1].entityId);
  assert.deepEqual(reports.map((r) => r.outcome), ["created", "created"]);
  assert.equal((await entityIds(subject.explorationId)).length, 3);
  assert.equal((await relationships(subject.explorationId)).length, 2);
});

test("a neighbour handed the subject's own URL does not resolve onto the subject", { skip }, async (t) => {
  // The shape that lost four entities in a real exploration: expanding Apple
  // Inc., the research returned Ronald Wayne and Gemini carrying apple.com as
  // their canonical_url, and the identifier match filed both as aliases of
  // Apple. A URL equal to the subject's says nothing about a neighbour.
  const subject = await seed(t, "Apple Inc.", "company", "https://www.apple.com/");

  const reports = await ingest(subject, [
    row({ name: "Ronald Wayne", type: "person", predicate: "founded_by", canonical_url: "https://apple.com" }),
    row({ name: "Gemini", type: "technology", predicate: "uses_technology", canonical_url: "apple.com/" }),
  ]);

  for (const report of reports) {
    assert.equal(report.outcome, "created", `${report.name} was absorbed by the subject`);
    assert.notEqual(report.entityId, subject.subjectId);
  }

  assert.equal((await entityIds(subject.explorationId)).length, 3);
  assert.equal((await relationships(subject.explorationId)).length, 2);

  // Nothing was filed as another name for the subject.
  const { data: aliases } = await db
    .from("entity_aliases")
    .select("alias_raw")
    .eq("entity_id", subject.subjectId);
  assert.deepEqual(aliases ?? [], []);
});
