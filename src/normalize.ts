// Tokenization, semantic categorization, and JSON-Schema flattening shared by
// fetchTools.ts (normalization step) and match.ts (heuristic candidate generation).

import type { FieldSpec, JSONSchemaLike, NormalizedTool, RawTool, Toolkit } from "./types.ts";
import { MAX_OUTPUT_FIELD_DEPTH } from "./config.ts";

// Fields that are Composio-managed plumbing, not agent/user-resolvable data.
// Excluded from candidate generation entirely (as both inputs and outputs).
const META_FIELD_RE =
  /^(connected_account_id|connectedAccountId|entity_id|entityId|auth_config_id|api_key|access_token|refresh_token|client_id|client_secret)$/i;

// Catches conditional-requirement prose like "at least one of 'to', 'cc', or
// 'bcc' must be provided" that JSON-Schema's required[] can't express.
const CONDITIONAL_REQUIRED_RE = /at least one of|must be provided|is required unless|one of the following (?:is|must)/i;

// Suffix -> semantic bucket. Longest/most specific patterns first.
const SUFFIX_PATTERNS: Array<{ re: RegExp; bucket: string }> = [
  { re: /_?ids?$/i, bucket: "id" },
  { re: /_?numbers?$/i, bucket: "number" },
  { re: /_?names?$/i, bucket: "name" },
  { re: /_?emails?$/i, bucket: "email" },
  { re: /_?urls?$/i, bucket: "url" },
  { re: /_?uris?$/i, bucket: "url" },
  { re: /_?keys?$/i, bucket: "key" },
  { re: /_?tokens?$/i, bucket: "token" },
  { re: /_?shas?$/i, bucket: "sha" },
  { re: /_?logins?$/i, bucket: "login" },
  { re: /_?usernames?$/i, bucket: "login" },
  { re: /_?branch(es)?$/i, bucket: "branch" },
  { re: /_?paths?$/i, bucket: "path" },
  { re: /_?slugs?$/i, bucket: "slug" },
  { re: /_?dates?$/i, bucket: "date" },
  { re: /_?times?$/i, bucket: "date" },
];

/** Split camelCase/snake_case/kebab-case into lowercase word tokens. */
export function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
}

/** Very small singularizer — good enough for matching, not linguistically complete. */
function singularize(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/**
 * Classify a field into a semantic bucket used as the inverted-index key, e.g.
 * "thread_id" -> "id:thread", bare "id" nested under "threads[]" -> "id:thread",
 * "recipient_email" -> "email:recipient" (root kept for a same-toolkit tiebreak
 * bonus, category matching itself only needs the bucket, root is informational).
 */
function inferRootFromParent(parentPath: string[]): string {
  if (parentPath.length === 0) return "generic";
  const parent = parentPath[parentPath.length - 1]!.replace(/\[\]$/, "");
  return singularize(splitWords(parent).join("_")) || "generic";
}

// Some APIs (notably Google's People/Gmail contact objects) express these as a
// compound where the bucket word isn't the trailing token, e.g. "emailAddresses"
// (bucket word in the middle, not a suffix) — SUFFIX_PATTERNS' end-anchored
// regexes miss those. Catch them by token containment instead, anywhere in the word.
const CONTAINS_TOKEN_BUCKETS: Array<{ tokens: Set<string>; bucket: string }> = [
  { tokens: new Set(["email", "emails"]), bucket: "email" },
  { tokens: new Set(["login", "logins", "username", "usernames"]), bucket: "login" },
  { tokens: new Set(["sha", "shas"]), bucket: "sha" },
];
const FILLER_TOKENS = new Set(["address", "addresses", "value", "values", "primary", "of", "the"]);

export function classifyCategory(fieldName: string, parentPath: string[]): { bucket: string; root: string } {
  const tokens = splitWords(fieldName);
  const joined = tokens.join("_");

  for (const { re, bucket } of SUFFIX_PATTERNS) {
    if (re.test(joined)) {
      const rootTokens = tokens.slice(0, -1);
      let root = rootTokens.length > 0 ? singularize(rootTokens.join("_")) : "";
      // Bare "id"/"number"/etc with no root: infer from the nearest enclosing
      // path segment, e.g. threads[].id -> root "thread".
      if (!root) root = inferRootFromParent(parentPath);
      return { bucket, root: root || "generic" };
    }
  }

  for (const { tokens: bucketTokens, bucket } of CONTAINS_TOKEN_BUCKETS) {
    if (tokens.some((t) => bucketTokens.has(t))) {
      const rootTokens = tokens.filter((t) => !bucketTokens.has(t) && !FILLER_TOKENS.has(t));
      const root = rootTokens.length > 0 ? singularize(rootTokens.join("_")) : inferRootFromParent(parentPath);
      return { bucket, root: root || "generic" };
    }
  }

  // No suffix matched a bucket — fall back to plain text bucket.
  return { bucket: "text", root: singularize(joined) || "generic" };
}

export function categoryKey(bucket: string, root: string): string {
  return `${bucket}:${root}`;
}

// For these buckets, the value is unambiguous on its own — an email is an email
// whether the field is called "recipient_email" or "connection.emailAddress".
// Root only matters for disambiguating buckets like "id"/"number"/"name" (an
// issue id and a repo id are not interchangeable). matchKey() is what indexing
// and candidate lookup use; categoryKey() (bucket:root) is kept on FieldSpec for
// readability/debugging.
const ROOT_AGNOSTIC_BUCKETS = new Set([
  "email",
  "login",
  "sha",
  "url",
  "branch",
  "date",
  "token",
  "key",
  "slug",
  "path",
]);

export function matchKey(category: string): string {
  const [bucket] = category.split(":");
  return bucket && ROOT_AGNOSTIC_BUCKETS.has(bucket) ? bucket : category;
}

/** Resolve a local "#/$defs/Name" ref against the schema's own $defs. */
function resolveRef(ref: string, defs: Record<string, JSONSchemaLike> | undefined): JSONSchemaLike | null {
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  if (!m || !defs) return null;
  return defs[m[1]!] ?? null;
}

/**
 * Flatten a JSON Schema into FieldSpec[]. Used for both input parameters
 * (shallow — just top-level required properties) and output parameters
 * (deep — walks into `data`, resolving $refs, depth-capped).
 */
function flattenSchema(
  schema: JSONSchemaLike,
  opts: {
    defs?: Record<string, JSONSchemaLike>;
    pathPrefix: string[];
    requiredSet: Set<string> | null; // null = don't mark required (used for output fields)
    maxDepth: number;
    visited?: Set<string>;
  },
): FieldSpec[] {
  const { defs, pathPrefix, requiredSet, maxDepth } = opts;
  let visited = opts.visited ?? new Set<string>();
  if (maxDepth < 0 || !schema) return [];

  let resolved = schema;
  if (schema.$ref) {
    const target = resolveRef(schema.$ref, defs);
    if (!target || visited.has(schema.$ref)) return [];
    visited = new Set(visited);
    visited.add(schema.$ref);
    resolved = target;
  }

  if (resolved.type === "array" && resolved.items) {
    return flattenSchema(resolved.items, {
      defs,
      pathPrefix: [...pathPrefix.slice(0, -1), `${pathPrefix[pathPrefix.length - 1] ?? "item"}[]`],
      requiredSet,
      maxDepth,
      visited,
    });
  }

  const props = resolved.properties;
  if (!props) return [];

  const out: FieldSpec[] = [];
  for (const [key, propSchema] of Object.entries(props)) {
    if (META_FIELD_RE.test(key)) continue;
    const path = [...pathPrefix, key];
    // Composio schemas sometimes express "at least one of to/cc/bcc must be
    // provided" as prose rather than JSON-Schema `required[]` (since it's a
    // conditional OR, not a strict AND). Treat those as required too, so
    // multi-hop dependencies riding on such fields (e.g. resolving a
    // recipient's email) aren't silently skipped.
    const conditionallyRequired = CONDITIONAL_REQUIRED_RE.test(propSchema.description ?? "");
    const isRequired = requiredSet ? requiredSet.has(key) || conditionallyRequired : false;
    let resolvedProp = propSchema;
    if (propSchema.$ref) {
      const target = resolveRef(propSchema.$ref, defs);
      if (target) resolvedProp = { ...target, description: propSchema.description ?? target.description };
    }
    const type = resolvedProp.type ?? (resolvedProp.properties ? "object" : "string");
    const { bucket, root } = classifyCategory(key, pathPrefix);

    out.push({
      path: path.join("."),
      name: key,
      type: Array.isArray(type) ? type.join("|") : String(type),
      description: propSchema.description ?? resolvedProp.description ?? "",
      required: isRequired,
      category: categoryKey(bucket, root),
    });

    // Recurse into nested objects/arrays-of-objects for more candidate fields.
    if (maxDepth > 0 && (resolvedProp.properties || (resolvedProp.type === "array" && resolvedProp.items))) {
      out.push(
        ...flattenSchema(resolvedProp, {
          defs,
          pathPrefix: path,
          requiredSet: null,
          maxDepth: maxDepth - 1,
          visited,
        }),
      );
    }
  }
  return out;
}

export function normalizeTool(raw: RawTool): NormalizedTool {
  const toolkit = raw.toolkit.slug as Toolkit;
  const inputSchema = raw.inputParameters ?? {};
  const requiredSet = new Set(inputSchema.required ?? []);
  const inputFieldsAll = flattenSchema(inputSchema, {
    defs: inputSchema.$defs,
    pathPrefix: [],
    requiredSet,
    maxDepth: 0, // inputs: only top-level params matter for "what does this tool need"
  });
  const inputFields = inputFieldsAll.filter((f) => f.required);

  const outputSchema = raw.outputParameters ?? {};
  // The real payload lives under `data` (wrapper convention: {data, error, successful}).
  const dataSchema = outputSchema.properties?.data;
  let outputFields: FieldSpec[] = [];
  if (dataSchema) {
    outputFields = flattenSchema(dataSchema, {
      defs: outputSchema.$defs,
      pathPrefix: ["data"],
      requiredSet: null,
      maxDepth: MAX_OUTPUT_FIELD_DEPTH,
    });
  }

  return {
    slug: raw.slug,
    toolkit,
    name: raw.name,
    description: raw.description ?? "",
    inputFields,
    outputFields,
    outputSchemaThin: outputFields.length === 0,
  };
}
