import { COL } from "@/lib/firestore";
import type { z } from "zod";
import { AidmAuthError, type AidmToolContext, type AidmToolSpec } from "./types";

/**
 * Runtime registration of every tool the system exposes. Tools are registered
 * once at module load (via `registerTools`) and looked up by name when KA or
 * a Mastra step needs them.
 *
 * Why flat + global instead of passed-around: the MCP server factories need
 * the same list the Mastra tool registry does, and circular-import gymnastics
 * to share a non-global registry hurt more than this does.
 */

const tools = new Map<string, AidmToolSpec>();

export function registerTool<TInput extends z.ZodTypeAny, TOutput extends z.ZodTypeAny>(
  spec: AidmToolSpec<TInput, TOutput>,
): AidmToolSpec<TInput, TOutput> {
  if (tools.has(spec.name)) {
    throw new Error(`Duplicate tool registration: ${spec.name}`);
  }
  tools.set(spec.name, spec as unknown as AidmToolSpec);
  return spec;
}

export function getTool(name: string): AidmToolSpec | undefined {
  return tools.get(name);
}

export function listTools(): AidmToolSpec[] {
  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listToolsByLayer(layer: AidmToolSpec["layer"]): AidmToolSpec[] {
  return listTools().filter((t) => t.layer === layer);
}

export function clearRegistryForTesting(): void {
  tools.clear();
}

/**
 * Authorize a campaign access. Throws AidmAuthError if the campaign
 * does not exist, was soft-deleted, or is not owned by the caller.
 * Returns the campaign doc data on success.
 */
export async function authorizeCampaignAccess(
  ctx: Pick<AidmToolContext, "campaignId" | "userId" | "firestore">,
): Promise<{
  id: string;
  ownerUid: string;
  userId: string;
  name: string;
  phase: string;
  profileRefs: unknown;
  settings: unknown;
  createdAt: unknown;
  deletedAt: unknown;
}> {
  if (!ctx.firestore) throw new AidmAuthError();
  const snap = await ctx.firestore.collection(COL.campaigns).doc(ctx.campaignId).get();
  if (!snap.exists) throw new AidmAuthError();
  const data = snap.data();
  if (!data || data.ownerUid !== ctx.userId || data.deletedAt !== null) {
    throw new AidmAuthError();
  }
  return {
    id: snap.id,
    ownerUid: data.ownerUid,
    // Backwards-compat alias for callers that still expect `userId`. New
    // code should read `ownerUid`. The two fields hold the same value.
    userId: data.ownerUid,
    name: data.name,
    phase: data.phase,
    profileRefs: data.profileRefs,
    settings: data.settings,
    createdAt: data.createdAt,
    deletedAt: data.deletedAt,
  };
}

/**
 * Invoke a tool by name with full validation + auth + span wrapping.
 * Returns the validated output. Throws AidmAuthError on auth failure,
 * ZodError on schema violation, or whatever the tool itself throws.
 *
 * This is what Mastra workflow steps call. It is also what the MCP server
 * factory wraps into `SdkMcpToolDefinition` handlers so KA's tool calls go
 * through the same auth + validation path.
 */
export async function invokeTool(
  name: string,
  rawInput: unknown,
  ctx: AidmToolContext,
): Promise<unknown> {
  const spec = tools.get(name);
  if (!spec) throw new Error(`Unknown tool: ${name}`);

  const input = spec.inputSchema.parse(rawInput);
  await authorizeCampaignAccess(ctx);

  const span = ctx.trace?.span({
    name: `tool:${spec.name}`,
    input,
    metadata: { layer: spec.layer },
  });

  const start = Date.now();
  const logMeta = { ...ctx.logContext, tool: spec.name, layer: spec.layer };
  try {
    const rawOutput = await spec.execute(input, ctx);
    const output = spec.outputSchema.parse(rawOutput);
    span?.end({ output });
    ctx.logger?.("info", "tool: ok", {
      ...logMeta,
      durationMs: Date.now() - start,
    });
    return output;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    span?.end({ metadata: { error: errMsg } });
    ctx.logger?.("warn", "tool: failed", {
      ...logMeta,
      durationMs: Date.now() - start,
      error: errMsg,
    });
    throw err;
  }
}
