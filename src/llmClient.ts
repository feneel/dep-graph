// Thin wrapper around OpenRouter's OpenAI-compatible chat completions endpoint.
// No SDK dependency needed — used by both resolve.ts (bulk field resolution)
// and eval.ts (independent judge pass), with different models for each.

import { OPENROUTER_BASE_URL } from "./config.ts";

export class LlmError extends Error {}

/** Call the model and return raw text content, retrying transient failures. */
export async function chatComplete(
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  opts: { retries?: number; temperature?: number } = {},
): Promise<string> {
  const { retries = 3, temperature = 0.1 } = opts;
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new LlmError("OPENROUTER_API_KEY not set");

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new LlmError(`OpenRouter ${res.status}: ${body.slice(0, 500)}`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        error?: { message?: string };
      };
      if (data.error) throw new LlmError(`OpenRouter error: ${data.error.message}`);
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new LlmError("Empty response content");
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoffMs = 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new LlmError(String(lastErr));
}

/** Extract the first {...} JSON object from a string (models sometimes wrap in prose/fences despite instructions). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new LlmError(`Could not parse JSON from: ${trimmed.slice(0, 200)}`);
  }
}
