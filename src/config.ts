// Central config for the dependency-graph pipeline.
// Flip SCOPE between "subset" and "full" to control how much of each toolkit is processed.
// Everything downstream (fetch/match/resolve/graph/eval) reads from here.

export type Scope = "subset" | "full";

// Which scope to run. Overridable via CLI flag in orchestrate.ts (--subset / --full).
export const SCOPE: Scope = (process.argv.includes("--full") ? "full" : "subset") as Scope;

export const TOOLKITS = ["googlesuper", "github"] as const;
export type Toolkit = (typeof TOOLKITS)[number];

// Curated subset filters (regex over tool slug), used when SCOPE === "subset".
// Chosen to cover the exact kinds of precursor chains the task describes:
// Gmail (thread/message lookups), Calendar (event lookups), Contacts (name -> email
// resolution), Issues/PRs/Repos/Collaborators on GitHub (number/sha/username lookups).
// Note: googlesuper slugs are verb-first (e.g. GOOGLESUPER_SEND_EMAIL,
// GOOGLESUPER_LIST_THREADS) with no per-app prefix, so we match keywords
// anywhere in the slug rather than anchoring at the start. Verified against
// the real catalog: 77/474 googlesuper tools, 179/894 github tools match.
export const SUBSET_FILTERS: Record<Toolkit, RegExp> = {
  googlesuper: /MESSAGE|THREAD|LABEL|DRAFT|EMAIL|CALENDAR|EVENT|CONTACT|PEOPLE|SEND|REPLY/i,
  github: /ISSUE|PULL_REQUEST|PULL|COLLABORATOR|LABEL|COMMENT|BRANCH|COMMIT/i,
};

export function toolkitFilter(toolkit: Toolkit): RegExp | null {
  return SCOPE === "subset" ? SUBSET_FILTERS[toolkit] : null;
}

// Fetch limit per toolkit call (Composio API page size cap).
export const FETCH_LIMIT = 1000;

// --- LLM resolve config ---
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
// Fast/cheap model for the bulk per-tool resolve pass.
export const RESOLVE_MODEL = "google/gemini-2.5-flash";
// A different model for the independent eval judge pass, to reduce correlated bias.
export const JUDGE_MODEL = "openai/gpt-4o-mini";

export const RESOLVE_CONCURRENCY = 8;
export const PROMPT_VERSION = "v1";

// Max heuristic candidates kept per required field before/alongside the LLM pass.
export const MAX_CANDIDATES_PER_FIELD = 8;

// Depth cap when flattening nested output JSON Schemas (data.a.b.c...).
export const MAX_OUTPUT_FIELD_DEPTH = 3;

// Eval sample size (edges).
export const EVAL_SAMPLE_SIZE = 48;

export const CACHE_DIR = ".cache";
export const OUTPUT_DIR = "output";
