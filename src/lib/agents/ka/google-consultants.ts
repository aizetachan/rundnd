/**
 * Consultant adapters for Google-KA (M3.5 sub 3). Mirrors the
 * Anthropic-KA `agents:` Agent SDK surface as Gemini Function
 * Declarations, so when Gemini decides it needs a thinking-tier
 * verdict (OutcomeJudge, Validator, Pacing, Combat, ScaleSelector,
 * MemoryRanker, Recap) it can call the same Sonnet 4.6 / Haiku
 * surface Anthropic-KA uses — just through Function Calling instead
 * of Agent SDK's spawn primitive.
 *
 * Each consultant lives behind an underscore-prefixed function name
 * (`_consult_*`) so Gemini can disambiguate consultant invocations
 * from MCP tool calls.
 */
import { judgeOutcome } from "@/lib/agents/outcome-judge";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { resolveCombat } from "../combat-agent";
import { rankMemories } from "../memory-ranker";
import { advisePacing } from "../pacing-agent";
import { produceRecap } from "../recap-agent";
import { selectScale } from "../scale-selector-agent";
import { validateOutcome } from "../validator";

interface ConsultantSpec {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
}

/**
 * The seven KA consultants. `name` is what Gemini emits in
 * functionCalls; `schema` is the consultant's input shape.
 */
const CONSULTANTS: ConsultantSpec[] = [
  {
    name: "_consult_outcome_judge",
    description:
      "Decides whether the player's action succeeds, at what cost, and how consequentially. Returns mechanical truth (success_level, DC, narrative_weight, consequence, cost, rationale). Call BEFORE narrating consequences of a consequential action.",
    schema: z.object({
      intent: z.unknown(),
      playerMessage: z.string(),
      characterSummary: z.unknown().optional(),
      situation: z.string().optional(),
      arcState: z.unknown().optional(),
      activeConsequences: z.array(z.string()).optional(),
      validatorCorrection: z.string().optional(),
    }),
  },
  {
    name: "_consult_validator",
    description:
      "Reviews an OutcomeJudge verdict for consistency against canon, character capability, composition mode, and player overrides. Call after OJ when a verdict seems off. Returns {valid, correction}.",
    schema: z.object({
      verdict: z.unknown(),
      canon: z.array(z.string()).optional(),
      overrides: z.array(z.string()).optional(),
    }),
  },
  {
    name: "_consult_pacing",
    description:
      "Advises on beat rhythm — should this beat escalate, hold, release, pivot, set up, pay off, or detour? Returns {directive, toneTarget, escalationTarget, rationale}.",
    schema: z.object({
      sceneSummary: z.string().optional(),
      currentTension: z.number().optional(),
      arcPhase: z.string().optional(),
      recentBeats: z.array(z.string()).optional(),
    }),
  },
  {
    name: "_consult_combat",
    description:
      "For COMBAT intents — resolves hit/miss/damage/facts/status/resource-cost BEFORE you narrate, so you narrate facts rather than inventing mechanics. Returns {resolution, damage, facts}.",
    schema: z.object({
      intent: z.unknown(),
      attackerSummary: z.unknown().optional(),
      defenderSummary: z.unknown().optional(),
      situation: z.string().optional(),
    }),
  },
  {
    name: "_consult_scale_selector",
    description:
      "For combat exchanges — returns the effective composition mode (standard | blended | op_dominant | not_applicable) based on attacker/defender tier gap. Consult when tier differential is wide enough to reframe stakes onto cost vs survival.",
    schema: z.object({
      attackerTier: z.string().optional(),
      defenderTier: z.string().optional(),
      compositionMode: z.string().optional(),
    }),
  },
  {
    name: "_consult_memory_ranker",
    description:
      "Rerank semantic memory candidates by scene relevance when raw retrieval returns more than 3 hits. Returns a ranked list with relevance scores.",
    schema: z.object({
      candidates: z.array(z.unknown()),
      sceneContext: z.string().optional(),
    }),
  },
  {
    name: "_consult_recap",
    description:
      "First turn of a session only — produces a short in-character recap of last session's cliffhanger + active threads.",
    schema: z.object({
      lastSessionSummary: z.string().optional(),
      activeThreads: z.array(z.string()).optional(),
    }),
  },
];

export function buildGoogleKaConsultantDeclarations(): FunctionDeclaration[] {
  const out: FunctionDeclaration[] = [];
  for (const c of CONSULTANTS) {
    let parametersJsonSchema: unknown;
    try {
      parametersJsonSchema = z.toJSONSchema(c.schema);
    } catch {
      continue;
    }
    out.push({
      name: c.name,
      description: c.description,
      parametersJsonSchema,
    });
  }
  return out;
}

/**
 * Dispatch a Gemini-emitted consultant call to the matching
 * thinking/fast-tier agent. Returns the agent's structured output
 * as a plain object Gemini can consume as a functionResponse.
 */
export async function executeConsultantCall(
  name: string,
  args: Record<string, unknown> | undefined,
  modelContext: CampaignProviderConfig,
): Promise<Record<string, unknown>> {
  try {
    const deps = { modelContext };
    const payload = (args ?? {}) as never;
    switch (name) {
      case "_consult_outcome_judge": {
        const out = await judgeOutcome(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      case "_consult_validator": {
        const out = await validateOutcome(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      case "_consult_pacing": {
        const out = await advisePacing(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      case "_consult_combat": {
        const out = await resolveCombat(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      case "_consult_scale_selector": {
        const out = await selectScale(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      case "_consult_memory_ranker": {
        const out = await rankMemories(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      case "_consult_recap": {
        const out = await produceRecap(payload, deps);
        return { ok: true, result: out as Record<string, unknown> };
      }
      default:
        return { ok: false, error: `unknown consultant: ${name}` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * True when `name` looks like a consultant call (prefix `_consult_`).
 * Used by the dispatcher in `google.ts` to route between tool calls
 * (via `executeFunctionCall`) and consultant calls (via
 * `executeConsultantCall`).
 */
export function isConsultantCall(name: string): boolean {
  return name.startsWith("_consult_");
}
