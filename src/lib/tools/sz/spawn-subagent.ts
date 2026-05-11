import { runProfileResearcherA } from "@/lib/agents/profile-researcher-a";
import { runProfileResearcherB } from "@/lib/agents/profile-researcher-b";
import { indexProfile } from "@/lib/algolia/profile-index";
import { env } from "@/lib/env";
import { COL } from "@/lib/firestore";
import { normalizeAnimeResearchOutput, searchFranchise } from "@/lib/research";
import type { AnimeResearchOutput, ResearchTelemetry } from "@/lib/research";
import { FieldValue } from "firebase-admin/firestore";
import { z } from "zod";
import { registerTool } from "../registry";
import { appendConductorToolCall } from "./_history";

/**
 * Conductor's escalation lever (per ROADMAP §10.1). Spawns a heavy
 * subagent for work the conductor itself shouldn't do inline:
 *
 *   - "research" → profile researcher (Path B at this milestone).
 *     The conductor calls it once `searchProfileLibrary` returned
 *     no strong match. The result is persisted as a `profiles/{slug}`
 *     doc + indexed in Algolia, and returned to the conductor for
 *     player ratification. Player confirms → conductor calls
 *     commit_field({ field: "profile_refs", value: [slug] }).
 *
 *   - "disambiguation" → AniList franchise-graph candidate listing.
 *     Stub at sub 4; lands in sub 5.
 *
 *   - "hybrid_synthesis" → coherent active_ip authoring for hybrid
 *     campaigns. Stub at sub 4; lands in sub 8.
 *
 * Cost note: research costs $0.50–1.50 per call. The conductor's
 * system prompt instructs it to call `searchProfileLibrary` first —
 * a strong-match hit short-circuits to commit-by-slug, free.
 */
const SubagentType = z.enum(["research", "disambiguation", "hybrid_synthesis"]);

const InputSchema = z.object({
  type: SubagentType,
  /** Player's reference for the IP. Used by every subagent type. */
  query: z.string().min(1),
  /** Optional disambiguation choice — when the conductor already ran
   *  disambiguation in a prior turn, the player picked an AniList id,
   *  and now research should target that exact entry. */
  selected_anilist_id: z.number().int().optional(),
});

const OutputSchema = z.object({
  ok: z.boolean(),
  type: SubagentType,
  /** When type=research and the run succeeded: the slug the conductor
   *  should propose committing. Null on failure. */
  slug: z.string().nullable(),
  /** Human-facing summary the conductor surfaces to the player.
   *  E.g. "Researched 'Hunter x Hunter' — 148-episode 2011 anime,
   *  power_distribution T6→T9, slow_burn_romance: false…" */
  summary: z.string(),
  /** Wall-clock + cost telemetry the eval harness consumes. */
  telemetry: z.object({
    wall_ms: z.number().int(),
    cost_usd: z.number(),
    research_confidence: z.number().min(0).max(1).nullable(),
  }),
});

export const spawnSubagentTool = registerTool({
  name: "spawn_subagent",
  description:
    "Spawn a heavy subagent for work that requires more than chat (research, franchise disambiguation, hybrid synthesis). Use sparingly — research costs $0.50+ per call. ALWAYS call search_profile_library first.",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("spawn_subagent: ctx.firestore not provided");
    }

    const start = Date.now();

    if (input.type === "research") {
      // Path dispatch — see env.ts comment on AIDM_PROFILE_RESEARCH_PATH.
      // "b" (default): single Path B call. "a": single Path A call.
      // "both": run both in parallel; persist Path B's output (the
      // higher-cost path is treated as authoritative until the eval
      // harness decides otherwise), keep Path A's telemetry on the
      // tool result for comparison. Lands in the conductor's
      // tool_calls history; the eval harness reads it later.
      const path = env.AIDM_PROFILE_RESEARCH_PATH;
      let output: AnimeResearchOutput;
      let telemetry: ResearchTelemetry;
      let pathATelemetry: ResearchTelemetry | undefined;

      if (path === "a") {
        const a = await runProfileResearcherA({
          query: input.query,
          selectedAnilistId: input.selected_anilist_id,
        });
        output = a.output;
        telemetry = a.telemetry;
      } else if (path === "both") {
        // allSettled (not all): a synchronous throw from either path
        // (e.g. missing API key) shouldn't tank the other. We persist
        // Path B's output as authoritative when both succeed; if Path B
        // failed and Path A succeeded, we still surface failure to the
        // conductor (better than persisting an unvalidated Path A
        // result silently).
        const [aSettled, bSettled] = await Promise.allSettled([
          runProfileResearcherA({
            query: input.query,
            selectedAnilistId: input.selected_anilist_id,
          }),
          runProfileResearcherB({
            query: input.query,
            selectedAnilistId: input.selected_anilist_id,
          }),
        ]);
        if (bSettled.status !== "fulfilled") {
          throw bSettled.reason instanceof Error
            ? bSettled.reason
            : new Error(String(bSettled.reason));
        }
        output = bSettled.value.output;
        telemetry = bSettled.value.telemetry;
        if (aSettled.status === "fulfilled") {
          pathATelemetry = aSettled.value.telemetry;
        }
      } else {
        const b = await runProfileResearcherB({
          query: input.query,
          selectedAnilistId: input.selected_anilist_id,
        });
        output = b.output;
        telemetry = b.telemetry;
      }

      // Confidence floor: 0 means the researcher gave up (FALLBACK
      // sentinel). Don't persist that — let the conductor explain to
      // the player and try a different query.
      const confidence = telemetry.research_confidence ?? null;
      if (confidence === null || confidence < 0.3) {
        const result = {
          ok: false as const,
          type: input.type,
          slug: null,
          summary: `Research couldn't gather enough info on "${input.query}" with confidence. ${
            output.research_notes ?? ""
          }`.trim(),
          telemetry: {
            wall_ms: Date.now() - start,
            cost_usd: telemetry.cost_usd,
            research_confidence: confidence,
          },
        };
        await appendConductorToolCall({
          firestore: ctx.firestore,
          campaignId: ctx.campaignId,
          toolName: "spawn_subagent",
          args: input,
          result,
        });
        return result;
      }

      const { profile, slug } = normalizeAnimeResearchOutput(output);

      // Persist Profile to Firestore. Slug as doc id keeps the upsert
      // race-free (same shape register-npc et al use).
      await ctx.firestore.collection(COL.profiles).doc(slug).set(
        {
          slug,
          title: output.title,
          mediaType: output.media_type,
          content: profile,
          version: 1,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      // Index in Algolia so future search_profile_library calls find it.
      const directorBrief = output.director_personality.slice(0, 280);
      await indexProfile({
        objectID: slug,
        slug,
        title: output.title,
        alternate_titles: output.alternate_titles,
        media_type: output.media_type,
        status: output.status,
        brief: directorBrief,
        anilist_id: output.anilist_id ?? null,
        profile_id: profile.id,
      });

      const summary = [
        `Researched "${output.title}" (${output.media_type}, ${output.status})`,
        `Power distribution: ${output.ip_mechanics.power_distribution.peak_tier} → ${output.ip_mechanics.power_distribution.floor_tier} (${output.ip_mechanics.power_distribution.gradient})`,
        `Combat: ${output.ip_mechanics.combat_style}`,
        output.research_notes ? `Notes: ${output.research_notes}` : "",
      ]
        .filter(Boolean)
        .join(". ");

      const result = {
        ok: true as const,
        type: input.type,
        slug,
        summary,
        telemetry: {
          wall_ms: Date.now() - start,
          cost_usd: telemetry.cost_usd,
          research_confidence: confidence,
        },
        // Path A telemetry rides on the tool result for the eval
        // harness when path=both. Not part of the Zod output schema —
        // strict() isn't on, so the extra prop survives serialization
        // into conversation_history.tool_calls.
        ...(pathATelemetry ? { path_a_telemetry: pathATelemetry } : {}),
      };
      await appendConductorToolCall({
        firestore: ctx.firestore,
        campaignId: ctx.campaignId,
        toolName: "spawn_subagent",
        args: input,
        result,
      });
      return result;
    }

    if (input.type === "disambiguation") {
      // AniList franchise-graph lookup. Returns up to 6 candidates with
      // SEQUEL/PREQUEL chains collapsed (canonical-first) and SPIN_OFF/
      // ALTERNATIVE surfaced as distinct. Caller (conductor) presents
      // them as a numbered list and asks the player to pick. The
      // player's pick comes back in a future spawn_subagent call as
      // `selected_anilist_id`, paired with type="research".
      let candidates: import("@/lib/research").FranchiseCandidate[] = [];
      let summary: string;
      try {
        candidates = await searchFranchise(input.query, 6);
        summary = candidates.length
          ? `Found ${candidates.length} candidate(s) for "${input.query}". Present them to the player + collect a pick before researching.`
          : `AniList returned no matches for "${input.query}". Conductor should ask the player to clarify or rephrase.`;
      } catch (err) {
        summary = `AniList lookup failed: ${
          err instanceof Error ? err.message : String(err)
        }. Conductor can fall back to research-without-disambiguation (the LLM picks).`;
      }
      const result = {
        ok: candidates.length > 0,
        type: input.type,
        slug: null,
        summary,
        telemetry: {
          wall_ms: Date.now() - start,
          cost_usd: 0,
          research_confidence: null,
        },
        // The candidates field isn't part of the Zod output schema —
        // exposed via conversation_history's tool_call.result so the
        // UI can render them. Adding it as an extra property is OK
        // because Zod's strict() isn't on this output schema.
        candidates,
      };
      await appendConductorToolCall({
        firestore: ctx.firestore,
        campaignId: ctx.campaignId,
        toolName: "spawn_subagent",
        args: input,
        result,
      });
      return result;
    }

    // Stub for sub 8 (hybrid_synthesis).
    const result = {
      ok: false as const,
      type: input.type,
      slug: null,
      summary: `${input.type} subagent not yet implemented (planned for sub 8). The conductor should fall back to in-chat alternatives.`,
      telemetry: {
        wall_ms: Date.now() - start,
        cost_usd: 0,
        research_confidence: null,
      },
    };
    await appendConductorToolCall({
      firestore: ctx.firestore,
      campaignId: ctx.campaignId,
      toolName: "spawn_subagent",
      args: input,
      result,
    });
    return result;
  },
});
