# M2 — Session Zero: Implementation Plan

**Milestone:** M2 (after M0.5 close).
**Status:** 🟡 In progress — sub-commit 1 starting.
**Authority:** ROADMAP §10 ("Session Zero"). Read that section before implementing — this plan is the working decomposition, not the spec.
**Goal:** new player → guided onboarding conversation → playable opening scene with a fully-specified character + world. Replaces the current auto-seed ("Bebop — Red Entry") that M1 used as a stand-in.
**Acceptance (per ROADMAP §10):** new user completes SZ in under 15 minutes, receives a playable opening scene, redo + resume both work, OpeningStatePackage validates against Zod, 80% of SZ starts finish (PostHog).

---

## 1. Context — what's already there

This is M2 in a codebase that has shipped M0, M1, M0.5. The bones exist:

- **Profile schema** — `src/lib/types/profile.ts`. v4 re-architected (3-group structure: identification, ip_mechanics, canonical tonal). Matches the ROADMAP §10.5 spec.
- **Campaign schema** — `src/lib/types/campaign.ts`. `profile_refs: string[]` (single-source or hybrid), `settings.active_dna`, `active_composition`, `world_state`, `overrides`.
- **DNA / Composition** — `src/lib/types/{dna,composition}.ts`. 24+13 axes defined.
- **Agents infra** — `src/lib/agents/`. Director, Chronicler, Validator, etc. all on Claude Agent SDK + Mastra. Adding a `session-zero-conductor` agent slots into the same shape.
- **MCP tool registry** — `src/lib/tools/`. Conductor's tools register here.
- **Firestore data layer** — campaigns, profiles, characters subcollections all live. SZ state goes into a new subcollection.
- **Auth + budget gates** — same flow as turns. Conductor calls go through budget.

What's NOT there:
- `session-zero-conductor.ts` agent.
- `HandoffCompiler` agent.
- `OpeningStatePackage` Zod schema.
- `/sz` route + UI.
- `/api/session-zero` streaming endpoint.
- Profile research subagents (Path A AniList scrapers + Path B LLM + web_search).
- Profile generation eval harness (M2.6).
- Hybrid `active_ip` synthesizer.

---

## 2. Scope decisions — what M2 covers vs. defers

ROADMAP §10 is the full target. This plan ships M2 in **two waves** to keep each commit auditable:

### Wave A — "playable Session Zero" (the core)

The thinnest path that removes the auto-seed and gives the player real onboarding:

- Conductor agent + 5 of 7 tools (defer `searchProfileLibrary` and `spawnSubagent` to Wave B).
- `/sz` route with chat UI (mirrors the gameplay turn UI's streaming SSE pattern).
- HandoffCompiler agent → `OpeningStatePackage` Zod schema.
- Resume mid-SZ (state persists, return shows "continue"). Abandonment + redo.
- Provisional → authoritative memory transition (`session_zero` category, `provisional` flag).
- Single canonical profile only (Cowboy Bebop fixture used today). No hybrid, no custom, no research.
- Acceptance: a new sign-in flows through SZ instead of auto-seed and lands on `/play` with a `Campaign` whose `active_dna`, `active_composition`, `world_state`, and `character.sheet` are all conductor-authored, not seed-canned.

### Wave B — "research + hybrids" (the v3-parity layer)

- Profile research subagents (Path A scrapers + Path B LLM-only with web_search).
- AniList franchise-graph disambiguation (`@alist/sdk` or direct GraphQL).
- Profile generation eval (`M2.6` harness scoring Path A vs Path B against v3 ground-truth YAMLs).
- Hybrid + custom profile authoring — `active_ip` synthesis, `hybrid_synthesis_notes`.
- Canonicality modes (full_cast / replaced_protagonist / npcs_only / inspired) wired into WorldBuilder.
- `searchProfileLibrary` tool (semantic lookup against `profiles` Firestore collection).

Wave B is also M2 per ROADMAP, but Wave A is the demonstrable user-visible outcome. Ship Wave A; revisit Wave B when there's data on Wave A's UX.

### Out of scope at M2 (per ROADMAP §10.8)

- Post-handoff character-sheet edit forms — edits happen in-fiction via WorldBuilder.
- Multi-protagonist campaigns.
- Session Zero analytics dashboard (PostHog tracking is fine; no UI on top).

---

## 3. Wave A — sub-commits

### Sub 1 — Foundations (this commit)

**Files:**
- `src/lib/types/session-zero.ts` — `CharacterDraft`, `SessionZeroState`, `SessionZeroPhase`, `OpeningStatePackage`, `HandoffStatus`. All Zod schemas; downstream consumes types.
- `src/lib/firestore/schemas/sessionZero.ts` — `FirestoreSessionZero` (the persisted form).
- `src/lib/firestore/paths.ts` — add `CAMPAIGN_SUB.sessionZero` (single doc per campaign).
- `firestore.indexes.json` — add the `(ownerUid, sessionZero.phase)` composite if needed for "campaigns awaiting SZ" queries.

No runtime behavior change — pure scaffolding. Tests added as the schemas grow consumers.

### Sub 2 — Conductor agent skeleton

**Files:**
- `src/lib/agents/session-zero-conductor.ts` — agent on Claude Agent SDK + Opus 4.7 + extended thinking. Same shape as `key-animator.ts` — system prompt, tools list (5 of 7), Mastra stream wrapper.
- `src/lib/tools/sz/{propose-character-option,commit-field,ask-clarifying-question,finalize-session-zero,propose-canonicality-mode}.ts` — five tools. Each follows the existing tool-registry pattern (Zod input/output, `ctx.firestore` writes to the SZ doc).
- `src/lib/agents/index.ts` — re-export.
- `src/lib/tools/all.ts` — register the new tools.

Conductor talks to itself via stdout for unit tests; real wiring lands in sub 3.

### Sub 3 — `/sz` route + streaming endpoint

**Files:**
- `src/app/(app)/sz/page.tsx` — Next.js route, chat UI (mirrors `/campaigns/[id]/play`). Loads existing SZ state from Firestore on mount; streams new turns into the same SSE protocol.
- `src/app/api/session-zero/route.ts` — POST handler. Mirrors `/api/turns`: auth → budget gate → load SZ state → call conductor → stream back.
- Middleware (already protects `/sz`, already in `src/middleware.ts`).
- The campaigns list page (`src/app/(app)/campaigns/page.tsx`) gets a "+ Start a new campaign" CTA pointing to `/sz`.

After this sub, a sign-in user can hit "+ Start a new campaign," chat with the conductor (5 tools), and have the SZ doc fill up. No handoff yet.

### Sub 4 — HandoffCompiler + first gameplay turn

**Files:**
- `src/lib/agents/handoff-compiler.ts` — thinking-tier agent. Consumes the SZ doc → emits a fully-typed `OpeningStatePackage`.
- `src/lib/types/opening-state-package.ts` — Zod schema (already partially scoped in sub 1).
- `finalizeSessionZero` tool now triggers HandoffCompiler, writes the Campaign + Character + initial ContextBlocks to Firestore, then redirects the UI to `/campaigns/<id>/play`.
- Provisional memory writes during SZ (`category: 'session_zero'`, flag: `'provisional'`); HandoffCompiler emits authoritative replacements on success.

After this sub, the loop closes: SZ → handoff → first gameplay turn.

### Sub 5 — Resume / abandon / redo

**Files:**
- `src/app/(app)/campaigns/page.tsx` — surfaces unfinished SZ states ("Continue Session Zero").
- `src/app/(app)/sz/[campaignId]/page.tsx` (rename — was `/sz/page.tsx`) — resumes a specific draft.
- `redo` action on a campaign whose first gameplay turn hasn't fired yet. Marks prior SZ artifacts superseded.
- 14-day archive cron (out of scope for M2 first ship; tracked as M2.5 follow-up).

### Sub 6 — Cut over from auto-seed

**Files:**
- `src/lib/seed/ensure-seeded.ts` — remove the Bebop auto-seed. New users land on `/sz` with no campaigns instead.
- Keep `seedBebopCampaign` as a CLI-invoked script for dev debugging (delete-the-campaign + reseed).
- `firestore.indexes.json` — verify the indexes the new query patterns need.
- `docs/retros/M2.md` — written at close.

---

## 4. Schemas to write in sub 1

```ts
// src/lib/types/session-zero.ts (sketch)

export const SessionZeroPhase = z.enum([
  "not_started",
  "in_progress",
  "ready_for_handoff",
  "handoff_in_progress",
  "complete",
  "abandoned",
]);

export const CharacterDraft = z.object({
  name: z.string().nullable(),
  concept: z.string().nullable(),
  power_tier: PowerTier.nullable(),
  abilities: z.array(...).default([]),
  appearance: z.string().nullable(),
  personality: z.string().nullable(),
  backstory: z.string().nullable(),
  voice_notes: z.string().nullable(),
});

export const SessionZeroState = z.object({
  campaignId: z.string(),       // campaigns/{id} parent doc
  ownerUid: z.string(),
  phase: SessionZeroPhase,
  profile_refs: z.array(z.string()).default([]),
  canonicality_mode: z.enum(["full_cast", "replaced_protagonist", "npcs_only", "inspired"]).nullable(),
  character_draft: CharacterDraft,
  conversation_history: z.array(...).default([]),  // full transcript of conductor turns
  starting_location: z.string().nullable(),
  starting_situation: z.string().nullable(),
  hard_requirements_met: z.boolean().default(false),
  blocking_issues: z.array(z.string()).default([]),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export const OpeningStatePackage = z.object({
  // ROADMAP §10.7 full shape — package_metadata, readiness, player_character,
  // opening_situation, world_context, opening_cast, canon_rules,
  // director_inputs, animation_inputs, hard_constraints, soft_targets,
  // uncertainties, relationship_graph, contradictions_summary, orphan_facts.
  // ~300 LOC of Zod when fully fleshed.
});
```

---

## 5. Risks

- **Conductor latency.** Agent SDK with extended thinking on Opus 4.7 adds wall-clock time per turn. ROADMAP §10.1 targets 5–15 turns / <10 min. If a single turn averages 30s+, UX falls apart. Mitigation: stream partials aggressively, run consultants async, only block on `commitField` writes.
- **Resume flow correctness.** The conductor needs to read the full `conversation_history` on every turn (no Mastra session continuity across requests in M2 first ship — we re-prime each turn). That's expensive in tokens. Mitigation: cache via the Anthropic API's prompt-caching headers; the system prompt + history is the cacheable prefix.
- **Provisional → authoritative transition.** On a botched handoff, partial provisional writes can pollute memory. Mitigation: HandoffCompiler runs in a Firestore transaction that either applies all authoritative writes + deletes all provisional ones, or rolls back.
- **Wave B research path.** AniList rate limits + Fandom anti-scraping policies are unstable. Defer entirely; lean on a stable single profile (Bebop) for Wave A's tests so M2 isn't blocked on external APIs.
- **Cost.** A 10-turn SZ on Opus 4.7 with extended thinking is ~$0.20–0.50 per session. Visible in the budget UI; user opts in. Free-tier policy is M9 (Stripe).

---

## 6. Definition of Done (Wave A)

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` verdes.
- [ ] App desplegada en Firebase App Hosting con rollout en verde.
- [ ] New user → `/campaigns` → "+ Start a new campaign" → `/sz` → chat → handoff → `/campaigns/<id>/play`.
- [ ] Resume works: tab close mid-SZ → return → conversation continues.
- [ ] Redo works once before first gameplay turn; prior SZ artifacts marked superseded.
- [ ] OpeningStatePackage validates against Zod for at least one full SZ run.
- [ ] Subagent audit of the commit stack with no critical findings.
- [ ] `docs/retros/M2.md` written.

Wave B has its own DoD; not blocking Wave A.

---

## 7. Lo que viene después (Wave B teaser)

Wave B unlocks profile research + hybrids. The shape:
- `src/lib/agents/profile-researcher.ts` (Path B) + `src/lib/research/anilist.ts` + `src/lib/research/fandom.ts` (Path A).
- `evals/profile-generation/` harness — runs both paths over v3 YAMLs, scores, picks winner.
- `Conductor.spawnSubagent('anime_research', ...)` is the call-site.
- `src/lib/agents/active-ip-synthesizer.ts` for hybrids.
- `searchProfileLibrary` tool wired against the Firestore `profiles` collection (with Algolia for fuzzy match on title).

Wave B will get its own `docs/plans/M2-wave-b.md` when Wave A ships.
