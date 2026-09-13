// Step 3: LLM verification/enrichment pass. One batched call per tool (all its
// required fields at once) to confirm/reject/re-rank heuristic candidates, catch
// semantic matches heuristics miss (e.g. name -> contacts-lookup -> email chains),
// and classify fields with no reliable precursor as user_input. Disk-cached per
// tool so reruns / prompt tweaks don't reprocess unchanged tools.

import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import {
  CACHE_DIR,
  OUTPUT_DIR,
  PROMPT_VERSION,
  RESOLVE_CONCURRENCY,
  RESOLVE_MODEL,
  SCOPE,
} from "./config.ts";
import { extractJson, chatComplete } from "./llmClient.ts";
import { matchKey, splitWords } from "./normalize.ts";
import {
  LlmToolResponseSchema,
  type CandidatesFile,
  type FieldCandidates,
  type NormalizedTool,
  type Resolution,
  type ResolutionsFile,
} from "./types.ts";

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(splitWords(a));
  const tb = new Set(splitWords(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function buildExtraDirectory(
  fields: FieldCandidates[],
  toolkitTools: NormalizedTool[],
  excludeSlugs: Set<string>,
  limit = 15,
): Array<{ slug: string; name: string; description: string }> {
  const needsHelp = fields.some((f) => f.candidates.length === 0 || (f.candidates[0]?.score ?? 0) < 0.6);
  if (!needsHelp) return [];
  const query = fields.map((f) => `${f.field} ${f.description}`).join(" ");
  const scored = toolkitTools
    .filter((t) => !excludeSlugs.has(t.slug))
    .map((t) => ({ t, score: tokenOverlap(query, `${t.name} ${t.description}`) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored.map((x) => ({
    slug: x.t.slug,
    name: x.t.name,
    description: x.t.description.slice(0, 140),
  }));
}

function cacheKeyFor(toolSlug: string, payload: unknown): string {
  const hash = crypto
    .createHash("sha256")
    .update(toolSlug + JSON.stringify(payload) + PROMPT_VERSION)
    .digest("hex")
    .slice(0, 16);
  return hash;
}

const SYSTEM_PROMPT = `You are analyzing Composio tool schemas to build a dependency graph: for each REQUIRED input field of a tool, decide how an autonomous agent would obtain that value before calling the tool.

For each field, choose exactly one decision:
- "confirmed": the top heuristic candidate is a correct precursor (that tool's output field really does supply this input).
- "reranked": a DIFFERENT candidate from the list (not the top one) is the correct precursor — set chosenProducerTool/chosenOutputField to that one.
- "llm_proposed": none of the listed candidates are right, but you know (from the extra tool directory or general knowledge of this toolkit) a specific other tool whose output supplies this field — name it even if it wasn't in the candidate list.
- "user_input": no other tool's output can reliably supply this — it's information only the user/caller would know (e.g. free text body, a name/label they choose, a boolean flag, or an identifier they already have in hand and would not reasonably look up first).
- "rejected": candidates exist but are all wrong, and there's also no better tool you can propose — equivalent to user_input but signals the candidates were specifically bad.

Multi-hop chains matter: e.g. if a field needs an email address but the natural user input is a person's NAME, and there's a contacts/people-search tool in the directory, propose that tool via "llm_proposed" (or "confirmed"/"reranked" if it's already a candidate) rather than "user_input" — resolving through one precursor is better than asking the user for the exact field.

Respond with ONLY a JSON object matching this shape, no prose, no markdown fences:
{"toolSlug": "...", "fields": [{"field": "...", "decision": "confirmed|reranked|llm_proposed|user_input|rejected", "chosenProducerTool": "SLUG_OR_NULL", "chosenOutputField": "path.or.null", "confidence": 0.0-1.0, "rationale": "one short sentence"}]}`;

function buildUserPrompt(
  tool: { slug: string; name: string; description: string },
  fields: FieldCandidates[],
  directory: Array<{ slug: string; name: string; description: string }>,
): string {
  const payload = {
    tool: { slug: tool.slug, name: tool.name, description: tool.description.slice(0, 300) },
    fields: fields.map((f) => ({
      field: f.field,
      description: f.description.slice(0, 300),
      candidates: f.candidates.map((c) => ({
        producerTool: c.producerTool,
        outputField: c.outputField,
        heuristicScore: Math.round(c.score * 100) / 100,
        method: c.method,
      })),
    })),
    otherToolsInThisToolkit: directory,
  };
  return JSON.stringify(payload);
}

export async function resolveAll(
  candidatesFile: CandidatesFile,
  tools: NormalizedTool[],
): Promise<ResolutionsFile> {
  const toolsBySlug = new Map(tools.map((t) => [t.slug, t]));
  const byToolkit = new Map<string, NormalizedTool[]>();
  for (const t of tools) byToolkit.set(t.toolkit, [...(byToolkit.get(t.toolkit) ?? []), t]);

  const fieldsByTool = new Map<string, FieldCandidates[]>();
  for (const f of candidatesFile.fields) {
    fieldsByTool.set(f.toolSlug, [...(fieldsByTool.get(f.toolSlug) ?? []), f]);
  }

  const limit = pLimit(RESOLVE_CONCURRENCY);
  const resolutions: Resolution[] = [];
  let cacheHits = 0;
  let apiCalls = 0;
  let errors = 0;

  const tasks = [...fieldsByTool.entries()].map(([toolSlug, fields]) =>
    limit(async () => {
      const tool = toolsBySlug.get(toolSlug);
      if (!tool) return;
      const toolkitTools = byToolkit.get(tool.toolkit) ?? [];
      const directory = buildExtraDirectory(fields, toolkitTools, new Set([toolSlug]));
      const payload = buildUserPrompt(tool, fields, directory);
      const cacheKey = cacheKeyFor(toolSlug, payload);
      const cachePath = path.join(CACHE_DIR, "resolve", tool.toolkit, `${toolSlug}.${cacheKey}.json`);

      let parsed: ReturnType<typeof LlmToolResponseSchema.parse> | null = null;
      try {
        const cached = await readFile(cachePath, "utf-8");
        parsed = LlmToolResponseSchema.parse(JSON.parse(cached));
        cacheHits++;
      } catch {
        try {
          const raw = await chatComplete(RESOLVE_MODEL, [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: payload },
          ]);
          const json = extractJson(raw);
          parsed = LlmToolResponseSchema.parse(json);
          apiCalls++;
          await mkdir(path.dirname(cachePath), { recursive: true });
          await writeFile(cachePath, JSON.stringify(parsed, null, 2), "utf-8");
        } catch (err) {
          errors++;
          console.warn(`[resolve] ${toolSlug}: LLM call failed (${(err as Error).message.slice(0, 150)}), falling back to heuristic-only`);
        }
      }

      for (const f of fields) {
        const llmDecision = parsed?.fields.find((d) => d.field === f.field);
        resolutions.push(buildResolution(tool, f, llmDecision, toolsBySlug));
      }
    }),
  );

  await Promise.all(tasks);
  console.log(`[resolve] ${cacheHits} cache hits, ${apiCalls} API calls, ${errors} errors`);

  return {
    meta: { generatedAt: new Date().toISOString(), model: RESOLVE_MODEL, promptVersion: PROMPT_VERSION },
    resolutions,
  };
}

function buildResolution(
  tool: NormalizedTool,
  field: FieldCandidates,
  llm: { decision: string; chosenProducerTool?: string | null; chosenOutputField?: string | null; confidence: number; rationale: string } | undefined,
  toolsBySlug: Map<string, NormalizedTool>,
): Resolution {
  const base: Resolution = {
    toolSlug: tool.slug,
    toolkit: tool.toolkit,
    field: field.field,
    decision: "user_input",
    chosen: [],
    rationale: "No LLM decision available; no heuristic candidate strong enough to trust unverified.",
  };

  if (!llm) {
    // Fall back to the top heuristic candidate only if it's high-confidence
    // (exact-name or description-mention) — otherwise default to user_input
    // rather than trust an unverified guess.
    const top = field.candidates[0];
    if (top && top.score >= 0.85) {
      return {
        ...base,
        decision: "precursor",
        chosen: [{ producerTool: top.producerTool, outputField: top.outputField, confidence: top.score, source: "heuristic" }],
        rationale: `LLM unavailable; kept high-confidence heuristic match (${top.method}).`,
      };
    }
    return base;
  }

  if (llm.decision === "user_input" || llm.decision === "rejected") {
    return { ...base, decision: "user_input", rationale: llm.rationale };
  }

  const producerSlug = llm.chosenProducerTool ?? undefined;
  const outputField = llm.chosenOutputField ?? undefined;
  if (!producerSlug || !outputField) {
    return { ...base, decision: "user_input", rationale: `${llm.rationale} (decision=${llm.decision} but no producer named)` };
  }

  const producer = toolsBySlug.get(producerSlug);
  if (!producer) {
    return {
      ...base,
      decision: "user_input",
      rationale: `LLM proposed unknown tool "${producerSlug}" — discarded. ${llm.rationale}`,
    };
  }

  const exact = producer.outputFields.find((f) => f.path.toLowerCase() === outputField.toLowerCase());

  // Fuzzy fallback: the LLM often gets the leaf field name right but misses
  // array nesting (e.g. proposes "data.number" when the real path is
  // "data.pull_requests[].number"). Rather than discard these near-misses,
  // recover the real path via leaf-name or category match, at reduced confidence.
  const leafName = outputField.split(".").pop() ?? outputField;
  const fuzzy = !exact
    ? producer.outputFields.find(
        (f) => f.name.toLowerCase() === leafName.toLowerCase() && matchKey(f.category) === matchKey(field.category),
      ) ?? producer.outputFields.find((f) => f.name.toLowerCase() === leafName.toLowerCase())
    : undefined;

  const match = exact ?? fuzzy;

  if (match || producer.outputSchemaThin) {
    const confidence = exact
      ? llm.confidence
      : fuzzy
        ? Math.min(llm.confidence, 0.75)
        : Math.min(llm.confidence, 0.4);
    return {
      toolSlug: tool.slug,
      toolkit: tool.toolkit,
      field: field.field,
      decision: "precursor",
      chosen: [
        {
          producerTool: producerSlug,
          outputField: match ? match.path : outputField,
          confidence,
          source: llm.decision === "confirmed" ? "heuristic" : llm.decision === "reranked" ? "llm" : "llm-proposed",
        },
      ],
      rationale: fuzzy ? `${llm.rationale} (path auto-corrected from "${outputField}" to "${match!.path}")` : llm.rationale,
      outputSchemaThinCaveat: !match && producer.outputSchemaThin,
    };
  }

  return {
    ...base,
    decision: "user_input",
    rationale: `LLM proposed ${producerSlug}.${outputField} but that field doesn't exist in its output schema — discarded. ${llm.rationale}`,
  };
}

export async function main() {
  const candidatesPath = path.join(OUTPUT_DIR, "candidates.json");
  const normPath = path.join(CACHE_DIR, "normalized", `${SCOPE}.json`);
  const candidatesFile: CandidatesFile = JSON.parse(await readFile(candidatesPath, "utf-8"));
  const tools: NormalizedTool[] = JSON.parse(await readFile(normPath, "utf-8"));
  console.log(`[resolve] resolving ${candidatesFile.fields.length} fields across ${tools.length} tools using ${RESOLVE_MODEL}`);

  const result = await resolveAll(candidatesFile, tools);
  const outPath = path.join(OUTPUT_DIR, "resolutions.json");
  await writeFile(outPath, JSON.stringify(result, null, 2), "utf-8");

  const counts = result.resolutions.reduce<Record<string, number>>((acc, r) => {
    acc[r.decision] = (acc[r.decision] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[resolve] wrote ${outPath}`, counts);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
