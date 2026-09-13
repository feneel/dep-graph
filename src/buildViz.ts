// Step 5: inline output/graph.json into the vis-network HTML template, producing
// a single self-contained output/graph.html that opens standalone via file://.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { OUTPUT_DIR } from "./config.ts";
import type { Graph } from "./types.ts";

export async function main() {
  const graphPath = path.join(OUTPUT_DIR, "graph.json");
  const graph: Graph = JSON.parse(await readFile(graphPath, "utf-8"));
  const templatePath = path.join("src", "viz", "template.html");
  const template = await readFile(templatePath, "utf-8");

  const metaLine = `${graph.meta.toolCount} tools · ${graph.meta.edgeCount} edges · scope: ${graph.meta.scope}`;

  const html = template
    .replace("__GRAPH_DATA__", JSON.stringify(graph))
    .replace("__META_LINE__", metaLine);

  const outPath = path.join(OUTPUT_DIR, "graph.html");
  await writeFile(outPath, html, "utf-8");
  console.log(`[viz] wrote ${outPath} (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
