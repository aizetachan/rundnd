import { z } from "zod";

// Env schema grows commit-by-commit. Each integration adds its own fields.
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),

  // --- Firebase (M0.5 migration) ---
  // Server-side Admin SDK. FIREBASE_PROJECT_ID is mandatory; the credential
  // is provided either via GOOGLE_APPLICATION_CREDENTIALS (path to JSON) for
  // local dev, or via Application Default Credentials on Firebase App Hosting.
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_STORAGE_BUCKET: z.string().optional(),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  // Inline credentials for environments that can't use a file path (CI, etc).
  // Mutually exclusive with GOOGLE_APPLICATION_CREDENTIALS.
  FIREBASE_CLIENT_EMAIL: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  // Public client SDK config — replicated under NEXT_PUBLIC_* below.
  NEXT_PUBLIC_FIREBASE_API_KEY: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_APP_ID: z.string().optional(),
  NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: z.string().optional(),

  // --- Algolia (M0.5 migration — replaces tsvector) ---
  // Admin key is server-only; search key is browser-safe.
  ALGOLIA_APP_ID: z.string().optional(),
  ALGOLIA_ADMIN_KEY: z.string().optional(),
  NEXT_PUBLIC_ALGOLIA_APP_ID: z.string().optional(),
  NEXT_PUBLIC_ALGOLIA_SEARCH_KEY: z.string().optional(),

  // --- LLM providers (commit 4) ---
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),

  // --- Observability (commit 5) ---
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),
  LANGFUSE_HOST: z.string().url().default("https://us.cloud.langfuse.com"),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional(),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().url().default("https://us.i.posthog.com"),

  // --- Budget caps (Commit 9) ---
  // Per-user per-minute turn cap — accident-prevention guard, not a
  // business control. Default 6 (roughly 10s between turns — generous
  // for thinking-then-acting; no one is hitting this with good intent).
  // User-configurable spending caps live on `users.daily_cost_cap_usd`;
  // there is deliberately no AIDM_DAILY_COST_CAP_USD (business model
  // is cost-forward + markup, users choose their own ceiling).
  AIDM_TURNS_PER_MINUTE_CAP: z.coerce.number().int().positive().default(6),

  // --- Embeddings (M4 sub 1) ---
  // Selects the backend for `src/lib/embeddings`. `"gemini"` (default)
  // uses Gemini text-embedding-004 via @google/genai. `"none"` skips
  // embedding entirely — callers persist `embedding: null` and the
  // vector-search read path (M4 sub 2) degrades to category + heat
  // ranking. The dispatcher pattern keeps Voyage / OpenAI as future
  // additions without touching the call sites.
  AIDM_EMBEDDING_PROVIDER: z.enum(["gemini", "none"]).default("gemini"),
  AIDM_EMBEDDING_MODEL: z.string().default("text-embedding-004"),

  // --- Profile research path (M2 Wave B sub 6) ---
  // Selects which researcher the conductor's spawn_subagent("research")
  // call dispatches to:
  //   "b"    — Claude Opus 4.7 + extended thinking + native web_search.
  //            Default. One external dependency (Anthropic).
  //   "a"    — AniList GraphQL + Fandom wiki → Sonnet 4.6 parse pass.
  //            Three external dependencies; lower cost.
  //   "both" — run A and B in parallel, persist Path B's output (Path A
  //            becomes telemetry-only). Used by the eval harness +
  //            telemetry comparisons.
  // The ROADMAP §10.6 decision rule eventually retires one path; this
  // var stays load-bearing until then.
  AIDM_PROFILE_RESEARCH_PATH: z.enum(["a", "b", "both"]).default("b"),
});

export type Env = z.infer<typeof envSchema>;

// Lazy validation. Parsing at module import breaks Next.js production builds,
// which import route handlers during page-data collection without runtime env
// set. Instead, validate on first property access — which only happens at
// request time for dynamic routes, long after the build phase.
//
// Note: spread/JSON.stringify/Object.keys on `env` will force a full parse
// via ownKeys. Current codebase has no such callers; if one lands, either
// avoid the spread or expose an explicit load() function.
let cached: Env | undefined;

export const env = new Proxy({} as Env, {
  get(_target, prop) {
    cached ??= envSchema.parse(process.env);
    return cached[prop as keyof Env];
  },
  has(_target, prop) {
    cached ??= envSchema.parse(process.env);
    return prop in cached;
  },
  ownKeys() {
    cached ??= envSchema.parse(process.env);
    return Reflect.ownKeys(cached);
  },
  getOwnPropertyDescriptor(_target, prop) {
    cached ??= envSchema.parse(process.env);
    return Reflect.getOwnPropertyDescriptor(cached, prop);
  },
});

/**
 * Fallback-only model defaults — NOT the global source of truth.
 *
 * In the per-campaign multi-provider world (M1.5 Commit A onwards), the
 * authoritative `{ provider, tier_models }` config lives on each
 * campaign row at `settings.provider` + `settings.tier_models`. The
 * turn workflow reads it via `resolveModelContext` and threads it
 * through every LLM call on the turn.
 *
 * This constant is the narrow fallback for callers that don't have a
 * campaign context:
 *   - `/api/ready` reachability probe (see `pingAnthropic`)
 *   - CLI scripts that don't target a specific campaign
 *   - Tests that don't need per-campaign routing
 *
 * The runtime hot path (router → consultants → KA) must NOT read from
 * here. If you're reaching for `anthropicDefaults` from code that runs
 * during a turn, you've missed the modelContext threading in Commit D —
 * that's a bug, not a convenience.
 *
 * Kept identical to `src/lib/providers/anthropic.ts` ANTHROPIC_DEFAULTS
 * (single source of truth for Anthropic's baseline). If they diverge,
 * fix it here — the providers registry is authoritative.
 */
// Import via a string re-export path so env.ts can be consumed by
// Next's build-time page-data collection without pulling in zod. The
// PROBE_DEFAULT const lives in providers/types alongside its registry
// use; single-source + small enough to duplicate literally if
// providers/types ever grows transitive weight here.
import { PROBE_DEFAULT } from "@/lib/providers/types";

export const anthropicDefaults = {
  probe: PROBE_DEFAULT,
  fast: PROBE_DEFAULT,
  thinking: "claude-sonnet-4-6",
  creative: "claude-opus-4-7",
} as const;
