import { ENTITY_TYPES, type DiscoveredEntity, type EntityType } from "./types.ts";
import { PREDICATES } from "./predicates.ts";

const API = "https://api.parallel.ai/v1/tasks/runs";
const PROCESSOR = "base";

function apiKey(): string {
  const key = process.env.PARALLEL_API_KEY;
  if (!key) throw new Error("Missing PARALLEL_API_KEY in .env.local");
  return key;
}

const OUTPUT_SCHEMA = {
  type: "json",
  json_schema: {
    type: "object",
    properties: {
      entities: {
        type: "array",
        description: "Up to 8 entities directly related to the subject.",
        items: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "The entity's most commonly used full name.",
            },
            type: { type: "string", enum: ENTITY_TYPES },
            canonical_url: {
              type: "string",
              description:
                "Official homepage, or authoritative profile URL. Empty string if unknown.",
            },
            predicate: {
              type: "string",
              enum: PREDICATES,
              description:
                "The relationship, read as '<SUBJECT> <predicate> <this entity>'.",
            },
            source_url: {
              type: "string",
              description: "URL of the page supporting this relationship.",
            },
            excerpt: {
              type: "string",
              description:
                "A verbatim sentence from that page stating the relationship.",
            },
          },
          required: ["name", "type", "predicate", "source_url", "excerpt"],
        },
      },
    },
    required: ["entities"],
  },
} as const;

function buildInput(name: string, type: EntityType, url: string | null): string {
  return [
    `Research the ${type} "${name}"${url ? ` (${url})` : ""}.`,
    `Identify up to 8 of its most significant directly-related entities:`,
    `companies, people, and technologies.`,
    ``,
    `Each relationship must read as "<${name}> <predicate> <related entity>".`,
    `For example, for a company founded by someone, return that person with`,
    `predicate "founded_by". Choose the closest predicate from the allowed list.`,
    ``,
    `Every entity must include a source_url and a verbatim excerpt from that`,
    `page that states the relationship. Omit any relationship you cannot`,
    `support with a real citation. Use each entity's full canonical name`,
    `(e.g. "Stripe, Inc." rather than "Stripe" if that is how the source`,
    `names it).`,
  ].join("\n");
}

export async function createRun(
  name: string,
  type: EntityType,
  url: string | null,
): Promise<string> {
  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": apiKey(), "Content-Type": "application/json" },
    body: JSON.stringify({
      processor: PROCESSOR,
      input: buildInput(name, type, url),
      task_spec: { output_schema: OUTPUT_SCHEMA },
    }),
  });

  if (!res.ok) {
    throw new Error(`Parallel create failed (${res.status}): ${await res.text()}`);
  }
  const body = await res.json();
  if (!body.run_id) throw new Error("Parallel create returned no run_id");
  return body.run_id as string;
}

export type RunPoll =
  | { state: "pending" }
  | { state: "failed"; error: string }
  | { state: "complete"; entities: DiscoveredEntity[] };

export async function pollRun(runId: string): Promise<RunPoll> {
  const res = await fetch(`${API}/${runId}`, {
    headers: { "x-api-key": apiKey() },
    cache: "no-store",
  });
  if (!res.ok) {
    return { state: "failed", error: `Parallel poll failed (${res.status})` };
  }

  const body = await res.json();
  const status = String(body.status ?? "");

  if (status === "failed" || status === "cancelled") {
    return {
      state: "failed",
      error: JSON.stringify(body.errors ?? body.error ?? status).slice(0, 500),
    };
  }
  if (status !== "completed") return { state: "pending" };

  // Verified against a real run (ADR-0001): the status response carries no
  // `result` key at any point, so the second request is the only path, not a
  // fallback. The `??` stays in case a future version inlines the result.
  const result = body.result ?? (await fetchResult(runId));
  return { state: "complete", entities: extractEntities(result) };
}

async function fetchResult(runId: string): Promise<unknown> {
  const res = await fetch(`${API}/${runId}/result`, {
    headers: { "x-api-key": apiKey() },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Parallel result failed (${res.status})`);
  return res.json();
}

/**
 * The docs describe the result envelope loosely and it has moved between
 * versions, so walk the plausible shapes rather than pinning one. Anything
 * unrecognised yields zero entities, which the app treats as an empty leaf
 * rather than an error.
 *
 * A real run (ADR-0001) puts the rows at `output.content.entities`, with
 * `content` already parsed rather than a JSON string. `output.basis[].field`
 * holds the *string* "entities", which the Array.isArray check skips. The walk
 * is kept because one observed run does not make the shape stable, and it
 * costs nothing once it matches.
 */
function extractEntities(result: unknown): DiscoveredEntity[] {
  const seen = new Set<unknown>();
  const stack: unknown[] = [result];

  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.entities)) {
      const rows = obj.entities.filter(isDiscoveredEntity);
      if (rows.length) return rows;
    }

    // `content` may arrive as a JSON string rather than a parsed object.
    if (typeof obj.content === "string") {
      try {
        stack.push(JSON.parse(obj.content));
      } catch {
        /* not JSON; ignore */
      }
    }

    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") stack.push(value);
    }
  }

  return [];
}

function isDiscoveredEntity(row: unknown): row is DiscoveredEntity {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    typeof r.name === "string" &&
    r.name.trim().length > 0 &&
    typeof r.source_url === "string" &&
    r.source_url.trim().length > 0 &&
    typeof r.excerpt === "string" &&
    r.excerpt.trim().length > 0
  );
}
