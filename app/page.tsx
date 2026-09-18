"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import GraphCanvas from "@/components/GraphCanvas";
import {
  ENTITY_TYPES,
  type EntityType,
  type Evidence,
  type GraphEdge,
  type GraphNode,
  type GraphPayload,
  type NodeState,
} from "@/lib/types";

const POLL_MS = 2000;
const HIGHLIGHT_MS = 2500;

type PendingRun = { runId: string; entityId: string };

export default function Home() {
  const [seed, setSeed] = useState("");
  const [seedType, setSeedType] = useState<EntityType>("company");
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [nodeStates, setNodeStates] = useState<Record<string, NodeState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<GraphEdge | null>(null);
  const [evidence, setEvidence] = useState<Evidence[] | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const pending = useRef<PendingRun[]>([]);
  const explorationId = graph?.explorationId ?? null;

  const refreshGraph = useCallback(async (id: string) => {
    const res = await fetch(`/api/graph?explorationId=${id}`);
    if (res.ok) setGraph(await res.json());
  }, []);

  const flash = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setHighlighted((prev) => new Set([...prev, ...ids]));
    setTimeout(() => {
      setHighlighted((prev) => {
        const next = new Set(prev);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, HIGHLIGHT_MS);
  }, []);

  // One interval drives every in-flight run, so several expansions can be
  // outstanding at once and resolve out of order.
  useEffect(() => {
    if (!explorationId) return;
    const timer = setInterval(async () => {
      if (!pending.current.length) return;

      const settled: string[] = [];
      let changed = false;

      for (const run of [...pending.current]) {
        const res = await fetch(`/api/runs/${run.runId}`);
        if (!res.ok) continue;
        const body = await res.json();
        if (body.status === "pending") continue;

        settled.push(run.runId);
        changed = true;

        if (body.status === "failed") {
          setNodeStates((s) => ({ ...s, [run.entityId]: "failed" }));
          setErrors((e) => ({ ...e, [run.entityId]: body.error ?? "Research failed." }));
          continue;
        }

        setNodeStates((s) => ({
          ...s,
          [run.entityId]: body.empty ? "empty" : "complete",
        }));

        const created = (body.resolutions ?? [])
          .filter((r: { outcome: string }) => r.outcome === "created")
          .map((r: { entityId: string }) => r.entityId);
        flash(created);

        const merged = (body.resolutions ?? []).filter(
          (r: { outcome: string }) => r.outcome !== "created",
        ).length;
        if (merged > 0) {
          setBanner(`${merged} discovered ${merged === 1 ? "entity" : "entities"} resolved to existing nodes`);
          setTimeout(() => setBanner(null), 4000);
        }
      }

      pending.current = pending.current.filter((r) => !settled.includes(r.runId));
      if (changed) await refreshGraph(explorationId);
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [explorationId, refreshGraph, flash]);

  async function startExploration(e: React.FormEvent) {
    e.preventDefault();
    if (!seed.trim() || starting) return;
    setStarting(true);
    setBanner(null);

    try {
      const res = await fetch("/api/explorations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: seed, type: seedType }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not start exploration.");

      pending.current = [{ runId: body.runId, entityId: body.seedEntityId }];
      setNodeStates({ [body.seedEntityId]: "loading" });
      setErrors({});
      setSelectedNode(null);
      setSelectedEdge(null);
      setEvidence(null);
      await refreshGraph(body.explorationId);
    } catch (err) {
      setBanner(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setStarting(false);
    }
  }

  async function expand(entityId: string) {
    setNodeStates((s) => ({ ...s, [entityId]: "loading" }));
    setErrors((e) => {
      const next = { ...e };
      delete next[entityId];
      return next;
    });

    const res = await fetch("/api/expand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityId }),
    });
    const body = await res.json();
    if (!res.ok) {
      setNodeStates((s) => ({ ...s, [entityId]: "failed" }));
      setErrors((e) => ({ ...e, [entityId]: body.error ?? "Could not start research." }));
      return;
    }
    pending.current = [...pending.current, { runId: body.runId, entityId }];
  }

  function onNodeClick(node: GraphNode) {
    setSelectedNode(node);
    setSelectedEdge(null);
    setEvidence(null);
    // Already-expanded nodes select rather than re-research.
    if (!node.expanded && nodeStates[node.id] !== "loading") expand(node.id);
  }

  async function onEdgeClick(edge: GraphEdge) {
    setSelectedEdge(edge);
    setSelectedNode(null);
    setEvidence(null);
    const res = await fetch(`/api/edges/${edge.id}/evidence`);
    if (res.ok) setEvidence((await res.json()).evidence);
  }

  const nodeById = (id: string) => graph?.nodes.find((n) => n.id === id);

  return (
    <main className="flex h-screen flex-col bg-neutral-50 text-neutral-900">
      <header className="border-b border-neutral-200 bg-white px-6 py-4">
        <form onSubmit={startExploration} className="flex items-center gap-3">
          <h1 className="mr-2 text-sm font-semibold tracking-tight">Entity Graph Explorer</h1>
          <input
            value={seed}
            onChange={(e) => setSeed(e.target.value)}
            placeholder="Stripe, Ada Lovelace, Kubernetes…"
            className="w-72 rounded border border-neutral-300 px-3 py-1.5 text-sm outline-none focus:border-neutral-900"
          />
          <select
            value={seedType}
            onChange={(e) => setSeedType(e.target.value as EntityType)}
            className="rounded border border-neutral-300 px-2 py-1.5 text-sm"
          >
            {ENTITY_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <button
            type="submit"
            disabled={starting}
            className="rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {starting ? "Starting…" : "Explore"}
          </button>
          {banner && <span className="text-sm text-neutral-600">{banner}</span>}
        </form>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {graph ? (
            <GraphCanvas
              graph={graph}
              nodeStates={nodeStates}
              highlighted={highlighted}
              selectedNodeId={selectedNode?.id ?? null}
              selectedEdgeId={selectedEdge?.id ?? null}
              onNodeClick={onNodeClick}
              onEdgeClick={onEdgeClick}
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              Enter an entity to begin. Click any unexpanded node to research it.
            </div>
          )}
        </div>

        <aside className="w-96 shrink-0 overflow-y-auto border-l border-neutral-200 bg-white p-5">
          {selectedEdge && (
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">Relationship</p>
              <p className="mt-1 text-sm font-medium">
                {nodeById(selectedEdge.source)?.name}{" "}
                <span className="text-neutral-500">{selectedEdge.predicate.replace(/_/g, " ")}</span>{" "}
                {nodeById(selectedEdge.target)?.name}
              </p>
              <p className="mt-4 text-xs uppercase tracking-wide text-neutral-500">
                Evidence {evidence ? `(${evidence.length})` : ""}
              </p>
              {evidence === null && <p className="mt-2 text-sm text-neutral-500">Loading…</p>}
              {evidence?.map((item) => (
                <figure key={item.id} className="mt-3 rounded border border-neutral-200 p-3">
                  <blockquote className="text-sm leading-relaxed text-neutral-800">
                    “{item.excerpt}”
                  </blockquote>
                  <figcaption className="mt-2 truncate text-xs">
                    <a
                      href={item.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-600 underline"
                    >
                      {item.sourceUrl}
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
          )}

          {selectedNode && (
            <div>
              <p className="text-xs uppercase tracking-wide text-neutral-500">
                {selectedNode.type}
              </p>
              <p className="mt-1 text-lg font-medium">{selectedNode.name}</p>
              {selectedNode.aliasCount > 0 && (
                <p className="mt-2 rounded bg-blue-50 px-2 py-1 text-xs text-blue-800">
                  Also discovered under {selectedNode.aliasCount} other{" "}
                  {selectedNode.aliasCount === 1 ? "name" : "names"} — deduplicated to this node.
                </p>
              )}
              <p className="mt-3 text-sm text-neutral-600">
                {stateLabel(nodeStates[selectedNode.id] ?? (selectedNode.expanded ? "complete" : "idle"))}
              </p>
              {errors[selectedNode.id] && (
                <div className="mt-3">
                  <p className="text-sm text-red-600">{errors[selectedNode.id]}</p>
                  <button
                    onClick={() => expand(selectedNode.id)}
                    className="mt-2 rounded border border-neutral-300 px-3 py-1 text-sm"
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          )}

          {!selectedEdge && !selectedNode && (
            <p className="text-sm text-neutral-500">
              Click a node to expand it, or an edge to see the sources behind it.
            </p>
          )}
        </aside>
      </div>
    </main>
  );
}

function stateLabel(state: NodeState) {
  switch (state) {
    case "loading":
      return "Researching…";
    case "complete":
      return "Expanded.";
    case "empty":
      return "No relationships found.";
    case "failed":
      return "Research failed.";
    default:
      return "Not yet researched — click the node to expand it.";
  }
}
