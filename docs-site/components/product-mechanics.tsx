"use client";

import {
  type Edge,
  type EdgeProps,
  getSmoothStepPath,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
} from "@xyflow/react";
import { useEffect, useMemo, useState } from "react";

import { FlowCanvas } from "./flow-canvas";

type SourceNodeData = {
  accent: string;
  body: string;
  items: string[];
  title: string;
};

type StageNodeData = {
  body: string;
  index: number;
  title: string;
};

type OutputNodeData = {
  accent: string;
  body: string;
  path: string;
  tags: string[];
  title: string;
};

type SourceNode = Node<SourceNodeData, "source">;
type StageNode = Node<StageNodeData, "stage">;
type OutputNode = Node<OutputNodeData, "output">;
type FlowNode = SourceNode | StageNode | OutputNode;

const SOURCE_W = 210;
const SOURCE_H = 220;
const STAGE_W = 360;
const STAGE_H = 120;
const OUTPUT_W = 340;
const OUTPUT_H = 248;

const ROW_SOURCES_Y = 80;
const ROW_STAGE_START_Y = 380;
const STAGE_GAP = 30;
const ROW_OUTPUTS_Y = 1030;

const STAGE_CENTER_X = 460;
const STAGE_X = STAGE_CENTER_X - STAGE_W / 2;

const SOURCE_GAP_X = 24;
const SOURCES_TOTAL = SOURCE_W * 4 + SOURCE_GAP_X * 3;
const SOURCES_START_X = STAGE_CENTER_X - SOURCES_TOTAL / 2;

const OUTPUT_GAP_X = 180;
const OUTPUTS_TOTAL = OUTPUT_W * 2 + OUTPUT_GAP_X;
const OUTPUTS_START_X = STAGE_CENTER_X - OUTPUTS_TOTAL / 2;

const EDGE_STROKE = "#94a3b8";

const sourceData: SourceNodeData[] = [
  {
    title: "Databases",
    body: "Schemas, keys, row counts, query history.",
    items: ["PostgreSQL", "Snowflake", "BigQuery", "Athena", "MongoDB", "& more"],
    accent: "#3b82f6",
  },
  {
    title: "BI tools",
    body: "Dashboards, questions, explores, usage, and trusted examples.",
    items: ["Metabase", "Looker", "Sigma"],
    accent: "#f97316",
  },
  {
    title: "Modeling code",
    body: "Existing metrics, dimensions, models, joins, and entities.",
    items: ["dbt", "LookML", "MetricFlow"],
    accent: "#f59e0b",
  },
  {
    title: "Docs and notes",
    body: "Policies, caveats, team definitions, and analyst context.",
    items: ["Notion", "Google Drive", "Any text"],
    accent: "#10b981",
  },
];

const stageData: Omit<StageNodeData, "index">[] = [
  {
    title: "Source connectors",
    body: "Read each configured system in its native shape.",
  },
  {
    title: "Context builder",
    body: "Turn source evidence into proposed context updates.",
  },
  {
    title: "Reconciliation",
    body: "Reconcile new evidence with the context that already exists.",
  },
  {
    title: "Validation",
    body: "Check references and semantics before agents rely on them.",
  },
];

const outputData: OutputNodeData[] = [
  {
    title: "Wiki",
    path: "wiki/*.md",
    tags: ["free-form", "auto-maintained"],
    body: "Definitions, caveats, policies, analyst notes, and business language that agents can search.",
    accent: "#10b981",
  },
  {
    title: "Semantic layer",
    path: "semantic-layer/*.yaml",
    tags: ["structured", "executable", "auto-maintained"],
    body: "Metrics, joins, tables, dimensions, filters, and segments that ktx can validate and compile into SQL.",
    accent: "#3b82f6",
  },
];

const nodes: FlowNode[] = [
  ...sourceData.map<SourceNode>((source, index) => ({
    id: `source-${index}`,
    type: "source",
    position: {
      x: SOURCES_START_X + index * (SOURCE_W + SOURCE_GAP_X),
      y: ROW_SOURCES_Y,
    },
    data: source,
    draggable: false,
    selectable: false,
  })),
  ...stageData.map<StageNode>((stage, index) => ({
    id: `stage-${index}`,
    type: "stage",
    position: {
      x: STAGE_X,
      y: ROW_STAGE_START_Y + index * (STAGE_H + STAGE_GAP),
    },
    data: { ...stage, index: index + 1 },
    draggable: false,
    selectable: false,
  })),
  ...outputData.map<OutputNode>((output, index) => ({
    id: `output-${index}`,
    type: "output",
    position: {
      x: OUTPUTS_START_X + index * (OUTPUT_W + OUTPUT_GAP_X),
      y: ROW_OUTPUTS_Y,
    },
    data: output,
    draggable: false,
    selectable: false,
  })),
];

const REF_EDGE_STROKE = "#64748b";

const flowEdges = [
  ...sourceData.map((_, index) => ({
    id: `e-source-${index}-stage-0`,
    source: `source-${index}`,
    target: "stage-0",
  })),
  ...stageData.slice(0, -1).map((_, index) => ({
    id: `e-stage-${index}-stage-${index + 1}`,
    source: `stage-${index}`,
    target: `stage-${index + 1}`,
  })),
  ...outputData.map((_, index) => ({
    id: `e-stage-3-output-${index}`,
    source: "stage-3",
    target: `output-${index}`,
  })),
].map((edge) => ({
  ...edge,
  type: "smoothstep" as const,
  style: { stroke: EDGE_STROKE, strokeWidth: 1.5 },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: EDGE_STROKE,
    width: 16,
    height: 16,
  },
}));

const refsEdge = {
  id: "e-output-refs",
  source: "output-0",
  sourceHandle: "right",
  target: "output-1",
  targetHandle: "left",
  type: "straight" as const,
  label: "references",
  labelBgPadding: [6, 3] as [number, number],
  labelBgBorderRadius: 4,
  labelStyle: {
    fontSize: 15,
    fontWeight: 500,
    fill: "var(--color-fd-muted-foreground)",
  },
  labelBgStyle: {
    fill: "var(--color-fd-background)",
    stroke: "var(--color-fd-border)",
    strokeWidth: 1,
  },
  style: {
    stroke: REF_EDGE_STROKE,
    strokeWidth: 1.25,
    strokeDasharray: "4 4",
  },
  markerStart: {
    type: MarkerType.ArrowClosed,
    color: REF_EDGE_STROKE,
    width: 14,
    height: 14,
  },
  markerEnd: {
    type: MarkerType.ArrowClosed,
    color: REF_EDGE_STROKE,
    width: 14,
    height: 14,
  },
};


function SourceNodeView({ data }: NodeProps<SourceNode>) {
  return (
    <div
      style={{
        width: SOURCE_W,
        height: SOURCE_H,
        borderTop: `3px solid ${data.accent}`,
      }}
      className="overflow-hidden rounded-md border border-fd-border bg-fd-card px-3.5 py-3 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <p className="text-[19px] font-semibold leading-7 text-fd-foreground">
        {data.title}
      </p>
      <p className="mt-1.5 line-clamp-3 text-[15px] leading-6 text-fd-muted-foreground">
        {data.body}
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {data.items.map((item) => (
          <span
            key={item}
            className="rounded border border-fd-border bg-fd-background px-2 py-0.5 text-[13px] leading-5 text-fd-muted-foreground"
          >
            {item}
          </span>
        ))}
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function StageNodeView({ data }: NodeProps<StageNode>) {
  return (
    <div
      style={{ width: STAGE_W, height: STAGE_H }}
      className="flex items-center gap-3.5 rounded-md border border-cyan-200/20 bg-[#0f1f23] px-4 py-3.5 text-white shadow-sm dark:bg-[#0b181b]"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-cyan-300/95 font-mono text-base font-semibold text-[#0b1c20]">
        {data.index}
      </span>
      <div className="min-w-0">
        <p className="text-[19px] font-semibold leading-7 text-white">
          {data.title}
        </p>
        <p className="mt-1.5 line-clamp-3 text-[15px] leading-6 text-cyan-50/75">
          {data.body}
        </p>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function OutputNodeView({ data }: NodeProps<OutputNode>) {
  return (
    <div
      style={{
        width: OUTPUT_W,
        height: OUTPUT_H,
        borderTop: `3px solid ${data.accent}`,
      }}
      className="overflow-hidden rounded-md border border-fd-border bg-fd-card px-4 py-3.5 shadow-sm"
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        className="!opacity-0"
      />
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        className="!opacity-0"
      />
      <p
        className="font-mono text-[15px] font-semibold tracking-tight"
        style={{ color: data.accent }}
      >
        {data.path}
      </p>
      <p className="mt-1.5 text-[19px] font-semibold leading-7 text-fd-foreground">
        {data.title}
      </p>
      <div className="mt-2 flex flex-nowrap gap-1">
        {data.tags.map((tag) => (
          <span
            key={tag}
            className="whitespace-nowrap rounded border border-fd-border bg-fd-background px-2 py-0.5 text-[13px] leading-5 text-fd-muted-foreground"
          >
            {tag}
          </span>
        ))}
      </div>
      <p className="mt-2.5 line-clamp-3 text-[15px] leading-6 text-fd-muted-foreground">
        {data.body}
      </p>
    </div>
  );
}

const PARTICLES_PER_SOURCE = 2;
const PARTICLE_SPEED_PX_PER_SEC = 130;
const PARTICLE_MIN_DURATION_SEC = 4;

const stageTopY = (i: number) => ROW_STAGE_START_Y + i * (STAGE_H + STAGE_GAP);
const stageBottomY = (i: number) => stageTopY(i) + STAGE_H;

function buildParticlePath(
  sourceIndex: number,
  outputIndex: number,
): { d: string; length: number } {
  const sourceCenterX =
    SOURCES_START_X + sourceIndex * (SOURCE_W + SOURCE_GAP_X) + SOURCE_W / 2;
  const sourceBottomYVal = ROW_SOURCES_Y + SOURCE_H;
  const outputCenterX =
    OUTPUTS_START_X + outputIndex * (OUTPUT_W + OUTPUT_GAP_X) + OUTPUT_W / 2;

  const legs: Array<[number, number, number, number]> = [
    [sourceCenterX, sourceBottomYVal, STAGE_CENTER_X, stageTopY(0)],
    [STAGE_CENTER_X, stageBottomY(0), STAGE_CENTER_X, stageTopY(1)],
    [STAGE_CENTER_X, stageBottomY(1), STAGE_CENTER_X, stageTopY(2)],
    [STAGE_CENTER_X, stageBottomY(2), STAGE_CENTER_X, stageTopY(3)],
    [STAGE_CENTER_X, stageBottomY(3), outputCenterX, ROW_OUTPUTS_Y],
  ];

  const segments = legs.map(([sx, sy, tx, ty]) => {
    const [segment] = getSmoothStepPath({
      sourceX: sx,
      sourceY: sy,
      sourcePosition: Position.Bottom,
      targetX: tx,
      targetY: ty,
      targetPosition: Position.Top,
    });
    return segment;
  });

  let d = segments[0];
  for (let i = 1; i < segments.length; i += 1) {
    d += ` ${segments[i].replace(/^M/, "L")}`;
  }

  const length = legs.reduce(
    (sum, [sx, sy, tx, ty]) => sum + Math.abs(tx - sx) + Math.abs(ty - sy),
    0,
  );

  return { d, length };
}

type ParticleEdgeData = {
  d: string;
  duration: number;
  beginOffset: number;
  color: string;
};

type ParticleEdge = Edge<ParticleEdgeData, "particle">;

function ParticleEdgeView({ id, data }: EdgeProps<ParticleEdge>) {
  if (!data) return null;
  const pathId = `mechanics-particle-path-${id}`;
  return (
    <>
      <path
        id={pathId}
        d={data.d}
        fill="none"
        stroke="none"
        pointerEvents="none"
      />
      <g className="mechanics-particle" style={{ color: data.color }}>
        <circle r={7.5} fill="currentColor" opacity={0.16} />
        <circle r={3.75} fill="currentColor" opacity={0.32} />
        <circle r={2.1} fill="currentColor" />
        <animateMotion
          dur={`${data.duration.toFixed(2)}s`}
          begin={`-${data.beginOffset.toFixed(2)}s`}
          repeatCount="indefinite"
        >
          <mpath href={`#${pathId}`} />
        </animateMotion>
      </g>
    </>
  );
}

const nodeTypes = {
  source: SourceNodeView,
  stage: StageNodeView,
  output: OutputNodeView,
};

const edgeTypes = {
  particle: ParticleEdgeView,
};

const staticEdges = [...flowEdges, refsEdge];

type ParticleSpec = {
  id: string;
  sourceIndex: number;
  outputIndex: number;
};

function makeRandomParticles(perSource: number): ParticleSpec[] {
  const specs: ParticleSpec[] = [];
  for (let sourceIndex = 0; sourceIndex < sourceData.length; sourceIndex += 1) {
    for (let n = 0; n < perSource; n += 1) {
      specs.push({
        id: `particle-${sourceIndex}-${n}`,
        sourceIndex,
        outputIndex: Math.floor(Math.random() * outputData.length),
      });
    }
  }
  return specs;
}

function specToEdge(spec: ParticleSpec): {
  id: string;
  source: string;
  target: string;
  type: "particle";
  data: ParticleEdgeData;
} {
  const { d, length } = buildParticlePath(spec.sourceIndex, spec.outputIndex);
  const duration = Math.max(
    PARTICLE_MIN_DURATION_SEC,
    length / PARTICLE_SPEED_PX_PER_SEC,
  );
  return {
    id: spec.id,
    source: `source-${spec.sourceIndex}`,
    target: `output-${spec.outputIndex}`,
    type: "particle",
    data: {
      d,
      duration,
      beginOffset: Math.random() * duration,
      color: sourceData[spec.sourceIndex].accent,
    },
  };
}

export function ProductMechanics() {
  const [particles, setParticles] = useState<ParticleSpec[]>([]);

  useEffect(() => {
    setParticles(makeRandomParticles(PARTICLES_PER_SOURCE));
  }, []);

  const edges = useMemo(
    () => [...staticEdges, ...particles.map(specToEdge)],
    [particles],
  );

  return (
    <section
      className="not-prose my-12 w-full max-w-full min-w-0 space-y-5"
      aria-labelledby="mechanics-title"
    >
      <div className="max-w-3xl">
        <h2
          id="mechanics-title"
          className="text-xl font-semibold tracking-normal text-fd-foreground sm:text-2xl"
          style={{ fontFamily: "var(--font-display)" }}
        >
          How ingestion works
        </h2>
        <p className="mt-3 text-sm leading-6 text-fd-muted-foreground">
          ktx ingests source evidence, reconciles it with your existing project,
          and produces durable context that agents can search, review, and
          execute.
        </p>
      </div>

      <article
        className="max-w-full min-w-0 overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm"
        aria-label="ktx ingestion flow from source systems to durable context outputs"
      >
        <div className="border-b border-fd-border bg-fd-muted/35 px-5 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-fd-primary">
            Ingestion flow
          </p>
          <h3
            className="mt-1 text-base font-semibold tracking-normal text-fd-foreground sm:text-lg"
            style={{ fontFamily: "var(--font-display)" }}
          >
            From scattered source systems to agent-ready context
          </h3>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-fd-muted-foreground">
            The inputs can be structured systems or loose team knowledge. The
            outputs are the two files agents need: a readable wiki and an
            executable semantic layer.
          </p>
        </div>

        <FlowCanvas
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          canvasStyle={{
            height: "min(1240px, 170vw)",
            minHeight: 720,
          }}
          className="mechanics-canvas"
          fitViewOptions={{ padding: 0.04 }}
          ariaLabel="ktx ingestion flow diagram"
        />
      </article>
      <style>{`
        .mechanics-canvas .mechanics-particle {
          pointer-events: none;
          filter: drop-shadow(0 0 6px currentColor);
        }
        @media (prefers-reduced-motion: reduce) {
          .mechanics-canvas .mechanics-particle {
            display: none;
          }
        }
      `}</style>
    </section>
  );
}
