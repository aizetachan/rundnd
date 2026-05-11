/**
 * Translate the AIDM tool registry into Gemini Function Declarations.
 * Companion to `src/lib/agents/ka/google.ts` — M3.5 sub 2 wires the
 * mid-turn tool-call loop into Google-KA so Gemini gains parity with
 * Anthropic's MCP-mounted memory + entity surface.
 *
 * Architecture:
 *   - Each tool's Zod inputSchema is converted to JSON Schema via Zod's
 *     `z.toJSONSchema()`; Gemini accepts that under `parametersJsonSchema`.
 *   - Tool name is the canonical AIDM tool name (e.g. "search_memory") —
 *     same identifier Gemini emits in functionCalls and we invoke via
 *     the registry.
 *   - Only KA layers are surfaced (ambient/working/episodic/semantic/
 *     voice/arc/critical/entities). The conductor-only session_zero
 *     layer is excluded.
 *
 * The companion `executeFunctionCall` helper invokes a tool by the
 * Gemini-emitted name + args and returns the result for inclusion in
 * the next round of `contents`.
 */
import { type AidmToolContext, type AidmToolLayer, invokeTool, listTools } from "@/lib/tools";
import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";

const KA_LAYERS: ReadonlySet<AidmToolLayer> = new Set([
  "ambient",
  "working",
  "episodic",
  "semantic",
  "voice",
  "arc",
  "critical",
  "entities",
]);

/**
 * Build the Function Declarations array for Gemini's `tools` config.
 * Returns one declaration per registered KA-layer tool. Gemini reads
 * `name`, `description`, and `parametersJsonSchema` to decide when /
 * how to call each.
 */
export function buildGoogleKaFunctionDeclarations(): FunctionDeclaration[] {
  const declarations: FunctionDeclaration[] = [];
  for (const spec of listTools()) {
    if (!KA_LAYERS.has(spec.layer)) continue;
    let parametersJsonSchema: unknown;
    try {
      parametersJsonSchema = z.toJSONSchema(spec.inputSchema);
    } catch {
      // Some Zod schemas can't be expressed in JSON Schema (e.g. refinements).
      // Skip those — Gemini will simply not see the tool. Logging via the
      // tool registry would be too noisy here; the registry test would
      // catch regressions if we depended on the failing tool.
      continue;
    }
    declarations.push({
      name: spec.name,
      description: spec.description,
      parametersJsonSchema,
    });
  }
  return declarations;
}

/**
 * Invoke a single function call emitted by Gemini. Result is returned
 * as a JSON-serializable object that the caller wraps in a Part for
 * the next round of `contents`.
 *
 * Errors are caught and surfaced as `{ error: "..." }` so the model
 * sees the failure and can adapt — same shape Anthropic's Agent SDK
 * uses for failed tool calls.
 */
export async function executeFunctionCall(
  name: string,
  args: Record<string, unknown> | undefined,
  ctx: AidmToolContext,
): Promise<Record<string, unknown>> {
  try {
    const result = await invokeTool(name, args ?? {}, ctx);
    return { ok: true, result: result as Record<string, unknown> };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
