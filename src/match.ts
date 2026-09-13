// Step 2: heuristic candidate generation. Builds an inverted index of output
// fields by semantic category, plus a description-mention scan (many Composio
// tool descriptions literally name their precursor action in prose), and scores
// candidate (producerTool, outputField) pairs for every required input field.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CACHE_DIR, MAX_CANDIDATES_PER_FIELD, OUTPUT_DIR, SCOPE } from "./config.ts";
import { matchKey, splitWords } from "./normalize.ts";
import type { CandidatesFile, FieldCandidates, HeuristicCandidate, NormalizedTool } from "./types.ts";

interface ProducerEntry {
  tool: NormalizedTool;
  field: { path: string; name: string; description: string };
}

function buildCategoryIndex(tools: NormalizedTool[]): Map<string, ProducerEntry[]> {
  const index = new Map<string, ProducerEntry[]>();
  for (const tool of tools) {
    for (const f of tool.outputFields) {
      const key = matchKey(f.category);
      const list = index.get(key) ?? [];
      list.push({ tool, field: { path: f.path, name: f.name, description: f.description } });
      index.set(key, list);
    }
  }
  return index;
}

/** Build a lookup from normalized "tool name phrase" tokens -> tool, for description-mention matching. */
function buildNameIndex(tools: NormalizedTool[]): Map<string, NormalizedTool[]> {
  const index = new Map<string, NormalizedTool[]>();
  for (const tool of tools) {
    // Index by the tool's human name lowercased (e.g. "list pending invitations for the
    // authenticated user") so we can substring-match it against other tools' descriptions.
    const key = tool.name.toLowerCase().trim();
    if (key.length < 8) continue; // too short/generic to be a reliable substring match
    const list = index.get(key) ?? [];
    list.push(tool);
    index.set(key, list);
  }
  return index;
}

// A precursor's whole point is to *discover* a value the caller doesn't have yet
// — that's a read/query action (list/get/fetch/search), not a mutation. A tool
// like "create a draft" or "add a label" happening to echo a threadId back in
// its response is a poor candidate: no one calls it purely to learn that id.
const READ_VERB_RE = /^(GET|LIST|FETCH|SEARCH|FIND|RETRIEVE|QUERY|CHECK|VIEW|SHOW|AUTOCOMPLETE)/i;
const WRITE_VERB_RE =
  /^(CREATE|ADD|UPDATE|DELETE|REMOVE|SEND|PATCH|SET|INSERT|PUT|POST|MERGE|CLOSE|OPEN|ARCHIVE|MOVE|COPY|DUPLICATE|BATCH_|BULK_|MODIFY|APPEND|CLEAR|MUTATE|TRANSFER|ACCEPT|REJECT|APPROVE|CANCEL|REPLY|FORWARD|IMPORT|EXPORT|UPLOAD|WATCH|STAR|UNSTAR|LOCK|UNLOCK|BLOCK|UNBLOCK)/i;

function toolIntentBonus(toolSlug: string, toolkit: string): number {
  const verb = toolSlug.slice(toolkit.length + 1); // strip "TOOLKIT_" prefix
  if (READ_VERB_RE.test(verb)) return 0.2;
  if (WRITE_VERB_RE.test(verb)) return -0.25;
  return 0;
}

function tokenOverlap(a: string, b: string): number {
  const ta = new Set(splitWords(a));
  const tb = new Set(splitWords(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(ta.size, tb.size);
}

function scoreCategory(
  toolField: { name: string; description: string; category: string },
  consumerTool: NormalizedTool,
  producer: ProducerEntry,
): HeuristicCandidate {
  let score = 0.5; // base for being in the same category bucket at all
  if (toolField.name.toLowerCase() === producer.field.name.toLowerCase()) score += 0.3;
  score += 0.15 * tokenOverlap(toolField.name, producer.field.name);
  if (producer.tool.toolkit === consumerTool.toolkit) score += 0.05;
  if (producer.tool.outputSchemaThin) score -= 0.2;
  score += toolIntentBonus(producer.tool.slug, producer.tool.toolkit);
  return {
    producerTool: producer.tool.slug,
    outputField: producer.field.path,
    score: Math.max(0, Math.min(1, score)),
    method: toolField.name.toLowerCase() === producer.field.name.toLowerCase() ? "exact-name" : "category-match",
  };
}

/** Scan a field's description for another tool's name mentioned in prose. */
function findDescriptionMentions(
  description: string,
  nameIndex: Map<string, NormalizedTool[]>,
  selfSlug: string,
): HeuristicCandidate[] {
  if (!description) return [];
  const lower = description.toLowerCase();
  const hits: HeuristicCandidate[] = [];
  for (const [namePhrase, tools] of nameIndex) {
    if (!lower.includes(namePhrase)) continue;
    for (const tool of tools) {
      if (tool.slug === selfSlug) continue;
      // We don't know *which* output field is meant from prose alone — point at
      // the tool's most id-like output field as a best guess; the LLM resolve
      // pass (src/resolve.ts) is expected to pin down the exact field.
      const idField =
        tool.outputFields.find((f) => f.category.startsWith("id:")) ?? tool.outputFields[0];
      hits.push({
        producerTool: tool.slug,
        outputField: idField?.path ?? "data",
        score: 0.9, // description explicitly names the action — very high confidence
        method: "description-mention",
      });
    }
  }
  return hits;
}

export function buildCandidates(tools: NormalizedTool[]): FieldCandidates[] {
  const categoryIndex = buildCategoryIndex(tools);
  const nameIndex = buildNameIndex(tools);
  const fields: FieldCandidates[] = [];

  for (const tool of tools) {
    for (const f of tool.inputFields) {
      const byCategory = (categoryIndex.get(matchKey(f.category)) ?? [])
        .filter((p) => p.tool.slug !== tool.slug)
        .map((p) => scoreCategory(f, tool, p));

      const byMention = findDescriptionMentions(f.description, nameIndex, tool.slug);

      const merged = new Map<string, HeuristicCandidate>();
      for (const c of [...byMention, ...byCategory]) {
        const key = `${c.producerTool}::${c.outputField}`;
        const existing = merged.get(key);
        if (!existing || c.score > existing.score) merged.set(key, c);
      }

      const candidates = [...merged.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_CANDIDATES_PER_FIELD);

      fields.push({
        toolSlug: tool.slug,
        toolkit: tool.toolkit,
        field: f.name,
        fieldPath: f.path,
        description: f.description,
        category: f.category,
        candidates,
      });
    }
  }
  return fields;
}

export async function main() {
  const normPath = path.join(CACHE_DIR, "normalized", `${SCOPE}.json`);
  const tools: NormalizedTool[] = JSON.parse(await readFile(normPath, "utf-8"));
  console.log(`[match] loaded ${tools.length} normalized tools from ${normPath}`);

  const fields = buildCandidates(tools);
  const withCandidates = fields.filter((f) => f.candidates.length > 0).length;
  const withMention = fields.filter((f) => f.candidates.some((c) => c.method === "description-mention")).length;
  console.log(
    `[match] ${fields.length} required fields total; ${withCandidates} have >=1 candidate; ${withMention} matched via description-mention`,
  );

  const out: CandidatesFile = {
    meta: {
      generatedAt: new Date().toISOString(),
      toolkits: [...new Set(tools.map((t) => t.toolkit))],
      toolCount: tools.length,
      scope: SCOPE,
    },
    fields,
  };
  const outPath = path.join(OUTPUT_DIR, "candidates.json");
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(outPath, JSON.stringify(out, null, 2), "utf-8");
  console.log(`[match] wrote ${outPath}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
