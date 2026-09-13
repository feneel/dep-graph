// Runs the full pipeline end-to-end: fetch -> match -> resolve -> build-graph -> viz -> eval.
// Scope (--subset / --full) is read by config.ts from process.argv directly, so
// each stage module picks it up automatically — this file just sequences them.
// Every stage is also runnable standalone via its own `npm run <stage>` script,
// so a partial/failed run can always resume from wherever it left off.

import { SCOPE } from "./config.ts";
import { main as fetchMain } from "./fetchTools.ts";
import { main as matchMain } from "./match.ts";
import { main as resolveMain } from "./resolve.ts";
import { main as buildGraphMain } from "./buildGraph.ts";
import { main as vizMain } from "./buildViz.ts";
import { main as evalMain } from "./eval.ts";

async function run(label: string, fn: () => Promise<void>) {
  const start = Date.now();
  console.log(`\n=== ${label} ===`);
  await fn();
  console.log(`=== ${label} done in ${((Date.now() - start) / 1000).toFixed(1)}s ===`);
}

async function main() {
  console.log(`Running full pipeline, scope=${SCOPE}`);
  await run("fetch + normalize", fetchMain);
  await run("match", matchMain);
  await run("resolve", resolveMain);
  await run("build-graph", buildGraphMain);
  await run("viz", vizMain);
  await run("eval", evalMain);
  console.log("\nPipeline complete. See output/graph.html and output/EVAL.md");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
