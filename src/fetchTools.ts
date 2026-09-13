// Step 1: fetch raw tool catalogs from Composio (cached to disk), then normalize
// them into flattened FieldSpec[] form (cached separately). Re-running this script
// is free once .cache/raw/<toolkit>.json exists for a given toolkit.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Composio } from "@composio/core";
import { CACHE_DIR, FETCH_LIMIT, SCOPE, TOOLKITS, toolkitFilter } from "./config.ts";
import { normalizeTool } from "./normalize.ts";
import type { NormalizedTool, RawTool, Toolkit } from "./types.ts";

async function fetchRaw(toolkit: Toolkit): Promise<RawTool[]> {
  const cachePath = path.join(CACHE_DIR, "raw", `${toolkit}.json`);
  try {
    const cached = await readFile(cachePath, "utf-8");
    console.log(`[fetch] ${toolkit}: using cache (${cachePath})`);
    return JSON.parse(cached) as RawTool[];
  } catch {
    // fall through to fetch
  }
  console.log(`[fetch] ${toolkit}: calling Composio API...`);
  const composio = new Composio();
  const tools = (await composio.tools.getRawComposioTools({
    toolkits: [toolkit],
    limit: FETCH_LIMIT,
  })) as unknown as RawTool[];
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(tools, null, 2), "utf-8");
  console.log(`[fetch] ${toolkit}: fetched ${tools.length} tools, cached to ${cachePath}`);
  return tools;
}

export async function loadNormalizedTools(): Promise<NormalizedTool[]> {
  const all: NormalizedTool[] = [];
  for (const toolkit of TOOLKITS) {
    const raw = await fetchRaw(toolkit);
    const filter = toolkitFilter(toolkit);
    const filtered = filter ? raw.filter((t) => filter.test(t.slug)) : raw;
    console.log(
      `[normalize] ${toolkit}: ${filtered.length}/${raw.length} tools in scope (${SCOPE})`,
    );
    for (const t of filtered) {
      try {
        all.push(normalizeTool(t));
      } catch (err) {
        console.warn(`[normalize] skipping ${t.slug}: ${(err as Error).message}`);
      }
    }
  }
  return all;
}

export async function main() {
  const normalized = await loadNormalizedTools();
  const cachePath = path.join(CACHE_DIR, "normalized", `${SCOPE}.json`);
  await mkdir(path.dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(normalized, null, 2), "utf-8");
  console.log(`[normalize] wrote ${normalized.length} normalized tools to ${cachePath}`);
  const withReq = normalized.filter((t) => t.inputFields.length > 0).length;
  const thinOutput = normalized.filter((t) => t.outputSchemaThin).length;
  console.log(
    `[normalize] ${withReq} tools have >=1 required field; ${thinOutput} tools have thin/empty output schemas`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
