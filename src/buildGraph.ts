// Step 4: assemble the final graph.json from normalized tools + resolutions
// (or raw candidates alone with --heuristic-only, for the early checkpoint
// before the LLM pass has run).

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, OUTPUT_DIR, RESOLVE_MODEL, SCOPE } from "./config.ts";
import type {
  CandidatesFile,
  Graph,
  GraphEdge,
  GraphNode,
  GraphRequiredField,
  NormalizedTool,
  Resolution,
  ResolutionsFile,
} from "./types.ts";

const HEURISTIC_ONLY = process.argv.includes("--heuristic-only");

function resolutionsFromCandidatesOnly(candidatesFile: CandidatesFile): Resolution[] {
  // Fallback path used when no LLM resolutions exist yet: trust only the
  // single best heuristic candidate per field, and only when it's reasonably
  // confident — otherwise mark user_input. This is intentionally more
  // conservative than the LLM pass since nothing has verified these picks.
  return candidatesFile.fields.map((f) => {
    const top = f.candidates[0];
    if (top && top.score >= 0.7) {
      return {
        toolSlug: f.toolSlug,
        toolkit: f.toolkit,
        field: f.field,
        decision: "precursor",
        chosen: [{ producerTool: top.producerTool, outputField: top.outputField, confidence: top.score, source: "heuristic" }],
        rationale: `Heuristic-only mode: top candidate via ${top.method}.`,
      };
    }
    return {
      toolSlug: f.toolSlug,
      toolkit: f.toolkit,
      field: f.field,
      decision: "user_input",
      chosen: [],
      rationale: "Heuristic-only mode: no confident candidate.",
    };
  });
}

export function buildGraph(
  tools: NormalizedTool[],
  candidatesFile: CandidatesFile,
  resolutions: Resolution[],
  meta: { resolveModel?: string } = {},
): Graph {
  const toolsBySlug = new Map(tools.map((t) => [t.slug, t]));
  const candidatesByKey = new Map(candidatesFile.fields.map((f) => [`${f.toolSlug}::${f.field}`, f]));
  const resByKey = new Map(resolutions.map((r) => [`${r.toolSlug}::${r.field}`, r]));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const userInputFields: Graph["userInputFields"] = [];
  let edgeSeq = 0;

  for (const tool of tools) {
    const requiredFields: GraphRequiredField[] = [];
    for (const f of tool.inputFields) {
      const cand = candidatesByKey.get(`${tool.slug}::${f.name}`);
      const res = resByKey.get(`${tool.slug}::${f.name}`);
      const precursors = (res?.chosen ?? []).map((c) => ({
        producerTool: c.producerTool,
        outputField: c.outputField,
        confidence: c.confidence,
        source: c.source,
      }));
      const userInput = !res || res.decision === "user_input" || precursors.length === 0;

      requiredFields.push({
        field: f.name,
        type: f.type,
        description: f.description || cand?.description,
        precursors,
        userInput,
      });

      for (const p of precursors) {
        edgeSeq++;
        edges.push({
          id: `e${edgeSeq}`,
          from: p.producerTool,
          to: tool.slug,
          field: f.name,
          outputField: p.outputField,
          confidence: p.confidence,
          source: p.source,
          rationale: res?.rationale,
        });
      }
      if (userInput) {
        userInputFields.push({
          tool: tool.slug,
          field: f.name,
          description: f.description,
          reason: res?.rationale ?? "No candidate producer identified.",
        });
      }
    }

    nodes.push({
      id: tool.slug,
      toolkit: tool.toolkit,
      name: tool.name,
      description: tool.description,
      requiredFields,
      fullyResolvable: requiredFields.length > 0 && requiredFields.every((f) => f.precursors.length > 0),
      hasUserInputFields: requiredFields.some((f) => f.userInput),
    });
  }

  // Drop edges pointing at producer tools outside this graph's node set
  // (can happen if a candidate's producer got filtered out of scope elsewhere).
  const nodeIds = new Set(nodes.map((n) => n.id));
  const validEdges = edges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      toolkits: [...new Set(tools.map((t) => t.toolkit))],
      toolCount: tools.length,
      edgeCount: validEdges.length,
      scope: SCOPE,
      pipelineVersion: "v1",
      resolveModel: meta.resolveModel,
    },
    nodes,
    edges: validEdges,
    userInputFields,
  };
}

export async function main() {
  const normPath = path.join(CACHE_DIR, "normalized", `${SCOPE}.json`);
  const candidatesPath = path.join(OUTPUT_DIR, "candidates.json");
  const tools: NormalizedTool[] = JSON.parse(await readFile(normPath, "utf-8"));
  const candidatesFile: CandidatesFile = JSON.parse(await readFile(candidatesPath, "utf-8"));

  let resolutions: Resolution[];
  let resolveModel: string | undefined;
  if (HEURISTIC_ONLY) {
    console.log("[build-graph] --heuristic-only: skipping resolutions.json");
    resolutions = resolutionsFromCandidatesOnly(candidatesFile);
  } else {
    const resPath = path.join(OUTPUT_DIR, "resolutions.json");
    const resFile: ResolutionsFile = JSON.parse(await readFile(resPath, "utf-8"));
    resolutions = resFile.resolutions;
    resolveModel = resFile.meta.model;
  }

  const graph = buildGraph(tools, candidatesFile, resolutions, { resolveModel: resolveModel ?? RESOLVE_MODEL });
  await mkdir(OUTPUT_DIR, { recursive: true });
  const outPath = path.join(OUTPUT_DIR, "graph.json");
  await writeFile(outPath, JSON.stringify(graph, null, 2), "utf-8");

  const fullyResolvable = graph.nodes.filter((n) => n.fullyResolvable).length;
  console.log(
    `[build-graph] wrote ${outPath}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${fullyResolvable} fully-resolvable nodes, ${graph.userInputFields.length} user-input fields`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
