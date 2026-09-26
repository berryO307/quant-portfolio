"use client";

import { useEffect, useRef } from "react";
import { ReactFlow, Background, BackgroundVariant, Controls, useReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { nodeTypes, ARCHITECTURE_NODES } from "./nodes";
import { edgeTypes, ARCHITECTURE_EDGES, ArrowMarkerDefs } from "./edges";
import { useSidebarExpanded } from "@/lib/sidebarState";

// Matches Sidebar.tsx's own `duration-200` on its width transition — the
// canvas's container doesn't finish resizing until that transition ends,
// so re-fitting any earlier just re-fits against the OLD (mid-animation)
// width and gets immediately stale as the sidebar keeps moving.
const SIDEBAR_TRANSITION_MS = 200;

/*
 * Re-centers/re-scales the diagram to the canvas's new width once the
 * sidebar finishes expanding or collapsing. React Flow's own internal
 * ResizeObserver keeps the canvas's coordinate system correct as its
 * container resizes, but it deliberately does NOT move the camera —
 * without this, toggling the sidebar left the diagram's existing pan/zoom
 * exactly where it was, just with more or less canvas revealed/hidden on
 * one side, instead of re-fitting to the space actually available now.
 *
 * A plain child of <ReactFlow>, not a prop on it — useReactFlow() needs
 * the provider context ReactFlow sets up for its own children.
 */
function FitViewOnSidebarToggle() {
  const expanded = useSidebarExpanded();
  const { fitView } = useReactFlow();
  // Skip the very first run (mount) — fitView already runs once via the
  // `fitView` prop on <ReactFlow> itself; re-doing it here too would just
  // be a redundant, unanimated snap on initial load.
  const isFirstRun = useRef(true);

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }

    const timer = window.setTimeout(() => {
      fitView({ duration: 200 });
    }, SIDEBAR_TRANSITION_MS);

    return () => window.clearTimeout(timer);
  }, [expanded, fitView]);

  return null;
}

/*
 * Static, presentational architecture diagram, rendered as a React Flow
 * canvas. Nothing here fetches, polls or subscribes — every value in
 * nodes.tsx/edges.tsx is literal copy.
 *
 * This replaces a hand-rolled scale-transform + scroll-to-zoom + manually
 * measured SVG connectors implementation, which broke (misaligned/
 * overlapping cards) at non-100% zoom because it fought CSS layout instead
 * of using a real canvas coordinate system. React Flow owns pan/zoom/node-
 * measurement/edge-anchoring natively, so none of that manual machinery —
 * or its failure modes — exists any more:
 *  - <Background variant="dots" /> replaces the old .tf-dot-grid CSS.
 *  - <Controls /> replaces the hand-built −/+/fit/% control (bottom-left
 *    by default, and — unlike the old one, which needed a document.body
 *    portal and then careful absolute-positioning to avoid the sidebar —
 *    it's naturally scoped to this canvas element, which only ever
 *    occupies the space to the right of the sidebar).
 *  - Cards are custom node types (nodes.tsx); connectors are a custom edge
 *    type (edges.tsx) that ports the original dashed-flow + travelling-
 *    packet-dot + numbered-badge rendering onto React Flow's own
 *    already-transformed edge SVG layer, so no manual
 *    getBoundingClientRect()/ResizeObserver measuring is needed to keep
 *    edges attached to cards.
 */

export function ArchitectureView() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header — sticky, outside the React Flow canvas. Trimmed vertical
          padding (py-4 -> py-2, title 19px -> 17px): this page's own React
          Flow canvas gets whatever height is left after this header, so
          every pixel shaved here is a pixel fitView can use to zoom the
          diagram in further — chrome, not diagram content, so shrinking it
          doesn't touch the "not by changing font sizes" constraint on the
          card layout itself. */}
      <header className="sticky top-0 z-30 shrink-0 border-b border-border bg-background">
        {/* No mx-auto — centering here added blank space to the left on
            wide viewports; left-aligned (still capped at 1600px) instead,
            matching the real left edge. */}
        <div className="max-w-[1600px] px-2 py-2">
          <h1 className="text-[19px] font-semibold text-foreground">
            System Architecture <span className="font-normal text-muted-foreground">(L2 Market Data Gateway)</span>
          </h1>
          <p className="mt-0.5 font-mono text-[12px] text-dim">
            Hyperliquid → C++ gateway → Node relay → Next.js viewer
          </p>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {/* Arrowhead <marker> defs for the edges' track layer — a separate
            zero-size <svg>, not inlined per-edge, since an SVG <marker>
            must live in <defs> once and be referenced by id; putting it in
            each edge's own tiny <svg> would just redefine (and fight) the
            same ids repeatedly. */}
        <ArrowMarkerDefs />
        <ReactFlow
          nodes={ARCHITECTURE_NODES}
          edges={ARCHITECTURE_EDGES}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.04 }}
          minZoom={0.1}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable
          proOptions={{ hideAttribution: true }}
        >
          {/* --rf-grid-dot (globals.css): a dedicated, explicitly-tuned-
              per-theme color — not var(--border) (nearly invisible against
              the page background in both themes) and not a color-mix()
              against --foreground (looked fine in dark mode but still
              washed out in light mode, since a mix percentage doesn't
              guarantee a contrast ratio). size=1.6/gap=24 (spec: "must be
              clearly visible, not barely-there") — larger than React
              Flow's own 1px default, which read as barely-there against
              this page's busy card content. */}
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} color="var(--rf-grid-dot)" />
          {/* Colors come from this app's own tokens (globals.css sets the
              --xy-controls-* variables React Flow reads, right below
              --xy-controls-button-background-color-default etc.) rather
              than React Flow's built-in light-only defaults, so this
              follows the app's dark/light theme automatically instead of
              needing a separate dark override here. */}
          <Controls showInteractive={false} orientation="horizontal" position="bottom-left" />
          <FitViewOnSidebarToggle />
        </ReactFlow>
      </div>
    </div>
  );
}
