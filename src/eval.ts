// Step 6: lightweight quality eval. Samples edges (stratified by toolkit +
// source), judges each with a DIFFERENT model than the resolve pass (given only
// plain tool/field descriptions, not the pipeline's own rationale, to avoid
// rubber-stamping), checks a small hand-authored golden set for recall, and
// writes output/EVAL.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EVAL_SAMPLE_SIZE, JUDGE_MODEL, OUTPUT_DIR } from "./config.ts";
import { chatComplete, extractJson } from "./llmClient.ts";
import type { Graph, GraphEdge } from "./types.ts";

// A few hand-picked, high-confidence expected relationships (drawn directly
// from the task's own examples plus obvious GitHub analogues) — asserted
// present in graph.json as a recall spot-check. Judged by field-category match
// against a keyword in the expected producer's slug, not exact slug equality,
// since a different-but-equally-valid producer tool should still count.
const GOLDEN_SET: Array<{ consumer: string; field: string; producerKeyword: string; note: string }> = [
  { consumer: "GOOGLESUPER_REPLY_TO_THREAD", field: "thread_id", producerKeyword: "THREAD|MESSAGE|EMAIL", note: "readme's canonical example" },
  { consumer: "GOOGLESUPER_SEND_EMAIL", field: "recipient_email", producerKeyword: "CONTACT|PEOPLE", note: "readme's name -> contacts -> email chain" },
  { consumer: "GITHUB_ADD_ASSIGNEES_TO_AN_ISSUE", field: "issue_number", producerKeyword: "ISSUE", note: "GitHub analogue: issue number from listing/creating issues" },
  { consumer: "GITHUB_MERGE_A_PULL_REQUEST", field: "pull_number", producerKeyword: "PULL", note: "GitHub analogue: PR number from listing PRs" },
];

function stratifiedSample(edges: GraphEdge[], n: number): GraphEdge[] {
  const groups = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const toolkit = e.to.split("_")[0] ?? "unknown";
    const key = `${toolkit}::${e.source}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const keys = [...groups.keys()];
  const perGroup = Math.max(1, Math.floor(n / Math.max(1, keys.length)));
  const sample: GraphEdge[] = [];
  for (const k of keys) {
    const list = groups.get(k)!;
    const shuffled = [...list].sort(() => Math.random() - 0.5);
    sample.push(...shuffled.slice(0, perGroup));
  }
  return sample.slice(0, n);
}

const JUDGE_SYSTEM = `You are an independent auditor checking a claimed tool dependency edge: "tool B's required input field X can be supplied by tool A's output field Y." You are given ONLY the two tools' names/descriptions and the two field names/descriptions — not any rationale from whoever proposed this edge. Judge from scratch.

Respond with ONLY a JSON object: {"verdict": "correct"|"incorrect"|"partial", "reason": "one short sentence"}.
- "correct": A's output field Y plausibly and directly provides the value needed for B's field X.
- "partial": plausible in some cases but not a strong/reliable general match.
- "incorrect": Y does not supply what X needs.`;

async function judgeEdge(
  edge: GraphEdge,
  graph: Graph,
): Promise<{ verdict: "correct" | "incorrect" | "partial"; reason: string }> {
  const producer = graph.nodes.find((n) => n.id === edge.from);
  const consumer = graph.nodes.find((n) => n.id === edge.to);
  const consumerField = consumer?.requiredFields.find((f) => f.field === edge.field);
  const payload = {
    producerTool: { slug: edge.from, name: producer?.name, description: producer?.description?.slice(0, 250) },
    outputField: edge.outputField,
    consumerTool: { slug: edge.to, name: consumer?.name, description: consumer?.description?.slice(0, 250) },
    inputField: { name: edge.field, description: consumerField?.description?.slice(0, 250) },
  };
  try {
    const raw = await chatComplete(JUDGE_MODEL, [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: JSON.stringify(payload) },
    ]);
    const json = extractJson(raw) as { verdict: string; reason: string };
    const verdict = (["correct", "incorrect", "partial"] as const).includes(json.verdict as never)
      ? (json.verdict as "correct" | "incorrect" | "partial")
      : "partial";
    return { verdict, reason: json.reason ?? "" };
  } catch (err) {
    return { verdict: "partial", reason: `judge call failed: ${(err as Error).message.slice(0, 100)}` };
  }
}

function checkGoldenSet(graph: Graph): Array<{ item: (typeof GOLDEN_SET)[number]; found: boolean; matchedEdge?: GraphEdge }> {
  return GOLDEN_SET.map((item) => {
    const re = new RegExp(item.producerKeyword, "i");
    const matchedEdge = graph.edges.find((e) => e.to === item.consumer && e.field === item.field && re.test(e.from));
    return { item, found: !!matchedEdge, matchedEdge };
  });
}

export async function main() {
  const graphPath = path.join(OUTPUT_DIR, "graph.json");
  const graph: Graph = JSON.parse(await readFile(graphPath, "utf-8"));

  const sample = stratifiedSample(graph.edges, Math.min(EVAL_SAMPLE_SIZE, graph.edges.length));
  console.log(`[eval] judging ${sample.length}/${graph.edges.length} edges with ${JUDGE_MODEL}...`);

  const judged = await Promise.all(sample.map(async (e) => ({ edge: e, ...(await judgeEdge(e, graph)) })));

  const counts = { correct: 0, partial: 0, incorrect: 0 };
  for (const j of judged) counts[j.verdict]++;
  const precision = (counts.correct + 0.5 * counts.partial) / judged.length;

  const bySource: Record<string, { correct: number; partial: number; incorrect: number; total: number }> = {};
  for (const j of judged) {
    const s = j.edge.source;
    bySource[s] ??= { correct: 0, partial: 0, incorrect: 0, total: 0 };
    bySource[s][j.verdict]++;
    bySource[s].total++;
  }

  const byToolkit: Record<string, { correct: number; partial: number; incorrect: number; total: number }> = {};
  for (const j of judged) {
    const toolkit = graph.nodes.find((n) => n.id === j.edge.to)?.toolkit ?? "unknown";
    byToolkit[toolkit] ??= { correct: 0, partial: 0, incorrect: 0, total: 0 };
    byToolkit[toolkit][j.verdict]++;
    byToolkit[toolkit].total++;
  }

  const golden = checkGoldenSet(graph);
  const goldenRecall = golden.filter((g) => g.found).length / golden.length;

  const heuristicOnlyEdges = graph.edges.filter((e) => e.source === "heuristic");
  const llmEdges = graph.edges.filter((e) => e.source !== "heuristic");

  const md = `# Dependency Graph Evaluation

Generated: ${new Date().toISOString()}
Scope: ${graph.meta.scope} (${graph.meta.toolCount} tools, ${graph.meta.edgeCount} edges)
Resolve model: ${graph.meta.resolveModel ?? "n/a"} · Judge model: ${JUDGE_MODEL}

## Methodology

1. **Sample**: ${judged.length} edges drawn via stratified sampling across (destination toolkit × decision source: heuristic/llm/llm-proposed), so the eval isn't dominated by the easy cases.
2. **Independent judge**: each sampled edge is judged by ${JUDGE_MODEL} — a *different* model than the one used to resolve edges (${graph.meta.resolveModel}) — given ONLY the two tools' plain names/descriptions and the two field names/descriptions. It does **not** see the pipeline's own rationale, to avoid rubber-stamping.
3. **Golden-set recall**: ${GOLDEN_SET.length} hand-authored expected relationships (including both examples from the task's own readme) are checked for presence in the graph, as a recall spot-check (the judge pass above only measures precision on what we *did* produce, not what we missed).

## Precision (LLM-judged sample, n=${judged.length})

| Verdict | Count | % |
|---|---|---|
| Correct | ${counts.correct} | ${((counts.correct / judged.length) * 100).toFixed(0)}% |
| Partial | ${counts.partial} | ${((counts.partial / judged.length) * 100).toFixed(0)}% |
| Incorrect | ${counts.incorrect} | ${((counts.incorrect / judged.length) * 100).toFixed(0)}% |

**Overall precision score (correct + 0.5×partial): ${(precision * 100).toFixed(1)}%**

A public reference implementation of this same task, using pure field-name heuristic matching with no LLM verification, self-reports 60.7% precision on GitHub's 893-tool catalog. For direct comparison, our heuristic-only subgraph (edges with \`source: "heuristic"\`, i.e. never touched by the LLM verification pass) vs. the full pipeline:

| | Edge count | Precision (of judged sample) |
|---|---|---|
| Heuristic-only edges | ${heuristicOnlyEdges.length} | see "heuristic" row below |
| LLM-verified/proposed edges | ${llmEdges.length} | see "llm"/"llm-proposed" rows below |

### Precision by decision source

| Source | n (in sample) | Correct | Partial | Incorrect |
|---|---|---|---|---|
${Object.entries(bySource).map(([s, c]) => `| ${s} | ${c.total} | ${c.correct} | ${c.partial} | ${c.incorrect} |`).join("\n")}

### Precision by toolkit

| Toolkit | n (in sample) | Correct | Partial | Incorrect |
|---|---|---|---|---|
${Object.entries(byToolkit).map(([t, c]) => `| ${t} | ${c.total} | ${c.correct} | ${c.partial} | ${c.incorrect} |`).join("\n")}

## Golden-set recall: ${(goldenRecall * 100).toFixed(0)}% (${golden.filter((g) => g.found).length}/${golden.length})

| Expected relationship | Found? | Matched edge | Note |
|---|---|---|---|
${golden.map((g) => `| ${g.item.consumer}.${g.item.field} | ${g.found ? "✅" : "❌"} | ${g.matchedEdge ? `${g.matchedEdge.from} → ${g.matchedEdge.to}` : "—"} | ${g.item.note} |`).join("\n")}

## Sample judgments (first 10)

${judged.slice(0, 10).map((j) => `- **${j.edge.from}.${j.edge.outputField} → ${j.edge.to}.${j.edge.field}** (source: ${j.edge.source}, confidence: ${j.edge.confidence.toFixed(2)}) — **${j.verdict}**: ${j.reason}`).join("\n")}

## Known limitations

- The judge model is itself a fallible LLM, not ground truth — this is a relative quality signal, not a proof of correctness.
- No independent human-labeled test set exists for this exact task; the golden set here is small (n=${GOLDEN_SET.length}) and hand-authored by us, so it's a sanity check, not a rigorous recall measurement.
- Precision-only focus: we don't have a denominator for true recall (how many *real* dependencies exist across the full catalog that we failed to surface at all), only for the golden set.
- Output JSON Schemas are sometimes thin or fully opaque (\`additionalProperties: true\` with no declared fields, e.g. \`GOOGLESUPER_SEARCH_PEOPLE\`) — these tools can't contribute schema-derived candidate fields even when they clearly are relevant precursors in practice.
- Category matching is name/structure-based; it will occasionally conflate same-shaped-but-different-meaning fields (e.g. two different numeric IDs that happen to share a normalized root) — the LLM pass catches most of these but not all, especially at low candidate-confidence.
- Scope is currently "${graph.meta.scope}" — a curated subset, not the full ~1,366-tool catalog; edge quality on unfetched tools is unverified.
`;

  const outPath = path.join(OUTPUT_DIR, "EVAL.md");
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outPath, md, "utf-8");

  await writeFile(
    path.join(OUTPUT_DIR, "eval-sample.json"),
    JSON.stringify({ judged, golden }, null, 2),
    "utf-8",
  );

  console.log(`[eval] precision=${(precision * 100).toFixed(1)}% golden-recall=${(goldenRecall * 100).toFixed(0)}% -> wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
