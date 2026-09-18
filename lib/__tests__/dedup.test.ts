import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeName, normalizeUrl } from "../normalize.ts";
import { canonicalizeEdge, coercePredicate } from "../predicates.ts";

test("legal suffixes and punctuation collapse to one key", () => {
  const forms = ["Stripe", "Stripe, Inc.", "stripe inc", "Stripe Inc", "  Stripe  "];
  const keys = new Set(forms.map(normalizeName));
  assert.equal(keys.size, 1, [...keys].join(" | "));
  assert.equal([...keys][0], "stripe");
});

test("stacked suffixes strip repeatedly", () => {
  assert.equal(normalizeName("Foo Group Holdings Ltd"), "foo");
  assert.equal(normalizeName("The Kroger Co."), "kroger");
});

test("ampersands and diacritics normalize", () => {
  assert.equal(normalizeName("Ben & Jerry's"), "ben and jerry");
  assert.equal(normalizeName("Nestlé S.A."), "nestle");
});

test("distinct entities stay distinct", () => {
  assert.notEqual(normalizeName("Meta"), normalizeName("Meta Platforms"));
});

test("url normalization collapses scheme, www, slash and query", () => {
  const forms = [
    "https://www.stripe.com/",
    "http://stripe.com",
    "stripe.com/",
    "https://stripe.com?ref=x#top",
  ];
  const keys = new Set(forms.map(normalizeUrl));
  assert.equal(keys.size, 1);
  assert.equal([...keys][0], "stripe.com");
  assert.equal(normalizeUrl("not a url"), null);
  assert.equal(normalizeUrl(""), null);
});

test("unknown predicates coerce rather than drop", () => {
  assert.equal(coercePredicate("Acquired"), "acquired");
  assert.equal(coercePredicate("was-mentored-by"), "related_to");
  assert.equal(coercePredicate("competes with"), "competes_with");
});

test("symmetric predicates collapse regardless of discovery order", () => {
  const a = { id: "aaa", type: "company" as const };
  const b = { id: "bbb", type: "company" as const };
  const forward = canonicalizeEdge(a, b, "competes_with");
  const reverse = canonicalizeEdge(b, a, "competes_with");
  assert.deepEqual(forward, reverse);
});

test("expanding a founder produces the same edge as expanding the company", () => {
  const company = { id: "co", type: "company" as const };
  const person = { id: "pe", type: "person" as const };
  // Discovered by expanding the company: "Stripe founded_by Patrick".
  const fromCompany = canonicalizeEdge(company, person, "founded_by");
  // Discovered by expanding the person, which reads backwards.
  const fromPerson = canonicalizeEdge(person, company, "founded_by");
  assert.deepEqual(fromCompany, fromPerson);
  assert.equal(fromCompany.sourceId, "co");
});

test("works_at flips to person -> company", () => {
  const company = { id: "co", type: "company" as const };
  const person = { id: "pe", type: "person" as const };
  const edge = canonicalizeEdge(company, person, "works_at");
  assert.equal(edge.sourceId, "pe");
  assert.equal(edge.targetId, "co");
});
