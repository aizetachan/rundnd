import { searchProfiles } from "@/lib/algolia/profile-index";
import { z } from "zod";
import { registerTool } from "../registry";
import { appendConductorToolCall } from "./_history";

/**
 * Conductor's lookup tool: before spawning a research subagent, check
 * whether the named IP already exists in the profiles library. Hits
 * with score ≥ 0.7 are good enough for the conductor to suggest
 * commit-by-slug instead of research; lower scores fall through to
 * the research path (sub 4).
 *
 * Per ROADMAP §10.1, this is the conductor's `searchProfileLibrary`
 * tool. The actual decision (use library hit vs research) is the
 * conductor's call — this tool just returns the candidates.
 */
const InputSchema = z.object({
  /** What the player named — title, alternate title, oblique reference. */
  query: z.string().min(1),
  /** Max hits to return. Conductor typically asks for 3-5. */
  limit: z.number().int().min(1).max(8).default(5),
});

const ProfileHit = z.object({
  slug: z.string(),
  title: z.string(),
  alternate_titles: z.array(z.string()),
  media_type: z.string(),
  brief: z.string().nullable(),
  anilist_id: z.number().nullable(),
  score: z.number().min(0).max(1),
});

const OutputSchema = z.object({
  hits: z.array(ProfileHit),
  /** Convenience flag — true when the top hit's score is high enough that
   *  the conductor should propose commit-by-slug rather than research. */
  has_strong_match: z.boolean(),
});

const STRONG_MATCH_THRESHOLD = 0.7;

export const searchProfileLibraryTool = registerTool({
  name: "search_profile_library",
  description:
    "Look up Profiles already in the library by title / alternate title / oblique reference. Call this before spawn_subagent('research'). If `has_strong_match` is true, propose committing the top hit's slug instead of researching from scratch — same result for the player, far cheaper for us.",
  layer: "session_zero",
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  execute: async (input, ctx) => {
    if (!ctx.firestore) {
      throw new Error("search_profile_library: ctx.firestore not provided");
    }
    const hits = await searchProfiles(input.query, input.limit);
    const result = {
      hits,
      has_strong_match: hits.length > 0 && (hits[0]?.score ?? 0) >= STRONG_MATCH_THRESHOLD,
    };
    await appendConductorToolCall({
      firestore: ctx.firestore,
      campaignId: ctx.campaignId,
      toolName: "search_profile_library",
      args: input,
      result,
    });
    return result;
  },
});
