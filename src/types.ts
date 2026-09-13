import { z } from "zod";

// ---------- Raw Composio tool (SDK shape, camelCased) ----------
export interface JSONSchemaLike {
  type?: string;
  properties?: Record<string, JSONSchemaLike>;
  required?: string[];
  items?: JSONSchemaLike;
  $ref?: string;
  $defs?: Record<string, JSONSchemaLike>;
  description?: string;
  title?: string;
  enum?: unknown[];
  [key: string]: unknown;
}

export interface RawTool {
  slug: string;
  name: string;
  description: string;
  toolkit: { slug: string; name: string; logo?: string };
  inputParameters: JSONSchemaLike;
  outputParameters: JSONSchemaLike;
  tags?: string[];
  version?: string;
  isDeprecated?: boolean;
  isNoAuth?: boolean;
  scopes?: string[];
}

// ---------- Normalized ----------
export interface FieldSpec {
  path: string; // e.g. "data.repository.owner.login" or top-level "owner"
  name: string; // leaf key, e.g. "login"
  type: string;
  description: string;
  required: boolean; // meaningful only for input fields
  category: string; // e.g. "id:repo", "login:generic", "email", "number:issue"
}

export interface NormalizedTool {
  slug: string;
  toolkit: Toolkit;
  name: string;
  description: string;
  inputFields: FieldSpec[]; // only required ones are kept (we don't need to resolve optional params)
  outputFields: FieldSpec[];
  outputSchemaThin: boolean; // true if output had no usable data fields
}

export type Toolkit = "googlesuper" | "github";

// ---------- Candidates ----------
export interface HeuristicCandidate {
  producerTool: string;
  outputField: string;
  score: number; // 0-1
  method: "exact-name" | "category-match" | "token-overlap" | "description-mention";
}

export interface FieldCandidates {
  toolSlug: string;
  toolkit: Toolkit;
  field: string;
  fieldPath: string;
  description: string;
  category: string;
  candidates: HeuristicCandidate[];
}

export interface CandidatesFile {
  meta: { generatedAt: string; toolkits: string[]; toolCount: number; scope: string };
  fields: FieldCandidates[];
}

// ---------- Resolutions (post-LLM) ----------
export const ResolutionDecision = z.enum([
  "confirmed",
  "rejected",
  "reranked",
  "user_input",
  "llm_proposed",
]);

export const LlmFieldDecisionSchema = z.object({
  field: z.string(),
  decision: ResolutionDecision,
  chosenProducerTool: z.string().optional().nullable(),
  chosenOutputField: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
});
export type LlmFieldDecision = z.infer<typeof LlmFieldDecisionSchema>;

export const LlmToolResponseSchema = z.object({
  toolSlug: z.string(),
  fields: z.array(LlmFieldDecisionSchema),
});
export type LlmToolResponse = z.infer<typeof LlmToolResponseSchema>;

export interface Resolution {
  toolSlug: string;
  toolkit: Toolkit;
  field: string;
  decision: "precursor" | "user_input" | "ambiguous";
  chosen: Array<{
    producerTool: string;
    outputField: string;
    confidence: number;
    source: "heuristic" | "llm" | "llm-proposed";
  }>;
  rationale: string;
  outputSchemaThinCaveat?: boolean;
}

export interface ResolutionsFile {
  meta: { generatedAt: string; model: string; promptVersion: string };
  resolutions: Resolution[];
}

// ---------- Final graph ----------
export interface GraphRequiredField {
  field: string;
  type: string;
  description?: string;
  precursors: Array<{
    producerTool: string;
    outputField: string;
    confidence: number;
    source: string;
  }>;
  userInput: boolean;
}

export interface GraphNode {
  id: string;
  toolkit: Toolkit;
  name: string;
  description: string;
  requiredFields: GraphRequiredField[];
  fullyResolvable: boolean;
  hasUserInputFields: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  field: string;
  outputField: string;
  confidence: number;
  source: string;
  rationale?: string;
}

export interface Graph {
  meta: {
    generatedAt: string;
    toolkits: string[];
    toolCount: number;
    edgeCount: number;
    scope: string;
    pipelineVersion: string;
    resolveModel?: string;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  userInputFields: Array<{ tool: string; field: string; description?: string; reason: string }>;
}
