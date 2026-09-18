"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphNode, GraphPayload, NodeState } from "@/lib/types";

const ForceGraph2D = dynamic(() => import("react-force-graph-2d"), { ssr: false });

const TYPE_COLOR: Record<string, string> = {
  company: "#3b82f6",
  person: "#f59e0b",
  technology: "#10b981",
};

type Props = {
  graph: GraphPayload;
  nodeStates: Record<string, NodeState>;
  highlighted: Set<string>;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  onNodeClick: (node: GraphNode) => void;
  onEdgeClick: (edge: GraphEdge) => void;
};

export default function GraphCanvas(props: Props) {
  const { graph, nodeStates, highlighted, selectedNodeId, selectedEdgeId } = props;
  const wrapper = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // react-force-graph mutates the objects it is given, so hand it copies keyed
  // off the payload rather than the payload's own arrays.
  const data = useMemo(
    () => ({
      nodes: graph.nodes.map((n) => ({ ...n })),
      links: graph.edges.map((e) => ({ ...e })),
    }),
    [graph],
  );

  return (
    <div ref={wrapper} className="h-full w-full">
      <ForceGraph2D
        width={size.width}
        height={size.height}
        graphData={data}
        cooldownTicks={120}
        linkColor={(link: any) =>
          link.id === selectedEdgeId ? "#111827" : "rgba(107,114,128,0.45)"
        }
        linkWidth={(link: any) =>
          link.id === selectedEdgeId ? 3 : Math.min(1 + (link.evidenceCount ?? 1) * 0.6, 4)
        }
        linkDirectionalArrowLength={4}
        linkDirectionalArrowRelPos={0.98}
        onLinkClick={(link: any) => props.onEdgeClick(link as GraphEdge)}
        onNodeClick={(node: any) => props.onNodeClick(node as GraphNode)}
        nodeCanvasObject={(node: any, ctx, globalScale) => {
          const state = nodeStates[node.id] ?? "idle";
          const radius = node.isSeed ? 8 : 6;

          if (highlighted.has(node.id)) {
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 5, 0, 2 * Math.PI);
            ctx.fillStyle = "rgba(59,130,246,0.25)";
            ctx.fill();
          }

          ctx.beginPath();
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
          ctx.fillStyle = state === "failed" ? "#ef4444" : TYPE_COLOR[node.type] ?? "#6b7280";
          ctx.fill();

          if (node.id === selectedNodeId) {
            ctx.lineWidth = 2;
            ctx.strokeStyle = "#111827";
            ctx.stroke();
          }

          // Unexpanded nodes read as "there is more here". The ring sits
          // outside the node rather than on its edge so that selecting a node
          // cannot disguise whether it has been researched — the one state
          // where the two used to look identical.
          if (!node.expanded && state !== "loading") {
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 3, 0, 2 * Math.PI);
            ctx.setLineDash([2, 2]);
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = "#6b7280";
            ctx.stroke();
            ctx.setLineDash([]);
          }

          if (state === "loading") {
            ctx.beginPath();
            ctx.arc(node.x, node.y, radius + 4, 0, 2 * Math.PI * ((Date.now() % 1000) / 1000));
            ctx.strokeStyle = "#3b82f6";
            ctx.lineWidth = 2;
            ctx.stroke();
          }

          const fontSize = Math.max(10 / globalScale, 3);
          ctx.font = `${fontSize}px ui-sans-serif, system-ui`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillStyle = "#111827";
          const label =
            node.aliasCount > 0 ? `${node.name}  ·${node.aliasCount + 1} names` : node.name;
          ctx.fillText(label, node.x, node.y + radius + 2);
        }}
        nodePointerAreaPaint={(node: any, color, ctx) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, 10, 0, 2 * Math.PI);
          ctx.fill();
        }}
      />
    </div>
  );
}
