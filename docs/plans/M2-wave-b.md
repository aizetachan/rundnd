# M2 Wave B — Profile Research, Hybrids & Eval Harness

**Milestone:** M2 Wave B (after Wave A close).
**Status:** 🟡 Plan written, sub-commits starting.
**Authority:** ROADMAP §10.2–10.6. Wave A retro (`docs/retros/M2.md`) lists this as deferred.
**Goal:** the conductor at `/sz` can research ANY anime/manga the player names — not just Bebop or Solo Leveling — by spawning a research subagent that produces a fully-typed Profile. Hybrid campaigns ("Bebop + Solo Leveling as a space gate-hunter drama") work end-to-end. The Path A vs Path B decision rule from ROADMAP §10.6 ships against real ground-truth YAMLs.

---

## 1. Context — what's there

Wave A shipped the onboarding loop. The conductor lets the player commit fields, propose canonicality mode, and finalize → handoff. But:
- Only **two** profiles exist as YAML fixtures (`evals/golden/profiles/cowboy_bebop.yaml`, `solo_leveling.yaml`).
- The conductor has no way to dynamically generate a Profile when the player names something else (Hunter x Hunter, Frieren, Hellsing, etc.). It just leans on the LLM's pre-trained knowledge → no `Profile.ip_mechanics`, no structured `canonical_dna`, Director loses tone anchors.
- No hybrid synthesizer — `Campaign.profile_refs: ["a", "b"]` is the schema, but nothing produces a coherent `active_ip` synthesis at handoff.
- No `searchProfileLibrary` tool — conductor can't even find the two profiles that DO exist.

Wave B closes those four gaps.

---

## 2. Scope

### In scope (this plan)

- **`searchProfileLibrary` tool** — Algolia-backed lookup over the `profiles` Firestore collection. Conductor's first move when the player names an IP.
- **Profile research subagent** — produces a typed `Profile` (matching the existing `src/lib/types/profile.ts` schema) from a media reference.
  - **Path A — scrapers + parse**: AniList GraphQL (titles, IDs, franchise graph) + Fandom wiki (fluff text) → LLM structured-output parse.
  - **Path B — LLM-only**: Claude Opus 4.7 + extended thinking + native `web_search` tool → direct structured output.
  - Both paths emit the same `AnimeResearchOutput` Zod schema; downstream consumes a uniform shape.
- **AniList franchise-graph disambiguation** — when "Naruto" matches both Naruto + Naruto Shippuden + Boruto, surface options to the conductor; the conductor asks the player.
- **`spawnSubagent` conductor tool** — wires research into the SZ flow.
- **Hybrid `active_ip` synthesizer agent** — when `profile_refs.length > 1`, generate a coherent `active_ip` synthesis at handoff (replaces the single-profile shortcut Wave A used).
- **Profile generation eval harness** (`evals/profile-generation/`) — runs both paths against ground-truth YAMLs (the two existing + a few we backfill from the v3 source). Scores DNA delta, trope agreement, voice card quality. Decision rule: Path B within tolerance → ship Path B alone; else keep Path A.

### Out of scope at Wave B

- AniList write-back (we only read).
- Profile editing UI (admin / debug tool — defer to M3+).
- Multi-language profile research (English-only at first ship).
- Profile versioning / re-research on schema bumps (M3+ — `profiles.version` field already there; bumper script lands later).
- Custom (player-authored from scratch) profiles — covered by hybrid + manual override at M2 wave A; full custom is M3.

---

## 3. Sub-commits

### Sub 1 — Foundations (research types + dir scaffold)

**Files:**
- `src/lib/research/index.ts` — barrel.
- `src/lib/research/types.ts` — `AnimeResearchOutput` (matches v3 shape used in profiles), `FranchiseCandidate`, `ResearchPath` (`"a" | "b"`), `ResearchTelemetry`.
- `src/lib/types/profile-disambiguation.ts` — Zod schemas for the candidate-list the conductor presents.
- `evals/profile-generation/` directory + `README.md`.

No runtime behavior. Pure scaffolding.

### Sub 2 — `searchProfileLibrary` tool + Algolia profiles index

**Files:**
- `src/lib/algolia/profile-index.ts` — `indexProfile(profile)`, `searchProfiles(query, limit)`. Index name `profiles`.
- `src/lib/tools/sz/search-profile-library.ts` — sixth SZ tool. Conductor calls it before research; if a hit ≥0.7 score, suggest commit instead of research (faster + cached).
- `scripts/configure-algolia-profile-index.ts` — script equivalent to `configure-algolia-index.ts`. One-shot config + backfill of existing profiles (Bebop, Solo Leveling).
- `apphosting.yaml` — no new secrets needed (reuses Algolia keys).
- Tests + index registration (tools/all.ts).

After this sub, the conductor can find Bebop and Solo Leveling without research.

### Sub 3 — Path B: LLM-only researcher (Claude Opus 4.7 + web_search)

**Files:**
- `src/lib/agents/profile-researcher-b.ts` — Anthropic SDK + `web_search` tool. Returns `AnimeResearchOutput`.
- `src/lib/research/normalize.ts` — converts `AnimeResearchOutput` → full `Profile` (the Zod schema downstream actually consumes). Fills `profile_refs`-style metadata, default DNA from heuristics, etc.
- `src/lib/agents/index.ts` — re-export.

Path B alone is the **viable shippable path** — depends on Anthropic API only (no new infrastructure).

### Sub 4 — `spawnSubagent` conductor tool + Path B wiring

**Files:**
- `src/lib/tools/sz/spawn-subagent.ts` — seventh + final SZ tool from ROADMAP §10.1. Type union: `"research" | "disambiguation" | "hybrid_synthesis"`.
- Conductor system prompt update: "Before researching, always call `searchProfileLibrary`. Only spawn research if no library hit. After research, present the result for player ratification before `commitField`."
- The new profile, on ratification, is written to `profiles/{slug}` AND indexed in Algolia.

After this sub, a player saying "I want to play Frieren" gets a real research-backed Profile.

### Sub 5 — AniList franchise-graph disambiguation

**Files:**
- `src/lib/research/anilist.ts` — minimal GraphQL client (no SDK). Title search → candidate franchise nodes (SEQUEL/PREQUEL collapse, SPIN_OFF/ALTERNATIVE surface).
- Disambiguation step inside the spawnSubagent("research") flow: if AniList returns multiple distinct entries, the subagent's first message back is "options" not a final Profile, conductor surfaces choice to player.
- Tests with real AniList responses cassetted.

After this sub, the disambiguation shape from §10.2 is honored.

### Sub 6 — Path A: AniList + Fandom scrapers + LLM parse

**Files:**
- `src/lib/research/fandom.ts` — single-page scrape with conservative rate limits + cached responses.
- `src/lib/agents/profile-researcher-a.ts` — orchestrator: AniList metadata + Fandom prose → LLM parse pass → `AnimeResearchOutput`.
- Path A is gated behind a flag (`AIDM_PROFILE_RESEARCH_PATH=a|b|both`); Path B is the default until eval decides.

### Sub 7 — Profile generation eval harness (M2.6)

**Files:**
- `evals/profile-generation/run.ts` — runs both paths over ground-truth YAMLs.
- `evals/profile-generation/score.ts` — DNA delta, trope agreement, power-distribution delta, stat-mapping correctness, Gemini-as-judge for voice cards + visual style (rubric 1–5).
- `evals/profile-generation/ground-truth/` — copies of `cowboy_bebop.yaml`, `solo_leveling.yaml` + 2 more we author by hand (Frieren, Hunter x Hunter — small enough to be representative).
- Decision rule encoded: ship Path B alone if DNA delta < 10 summed, trope disagreements < 3, stat mapping correct, judge scores within 0.3.
- `pnpm evals:profile-generation` script.

After this sub, the §10.6 rule actually evaluates against data.

### Sub 8 — Hybrid `active_ip` synthesizer

**Files:**
- `src/lib/agents/active-ip-synthesizer.ts` — agent that takes 2+ Profile objects + the conductor's narrative intent ("space opera gate hunter drama") → coherent `active_ip` text + blended `active_dna` defaults + `hybrid_synthesis_notes`.
- HandoffCompiler integration: when `profile_refs.length > 1`, run the synthesizer; otherwise use the single profile's canonical DNA verbatim.
- Tests with the Bebop+SL example from ROADMAP §10.3.

### Sub 9 — Cutover + retro

**Files:**
- Conductor system prompt: switch from "single profile mode" to "research-first mode."
- Update `proposeCharacterOption` to use the live profile when one is committed (not just the static fixture).
- Manual smoke test: pick a third IP not in fixtures (Frieren), complete SZ, verify the OpeningStatePackage uses the researched profile.
- `docs/retros/M2-wave-b.md`.

---

## 4. Risks

- **Cost.** Path B uses Opus 4.7 + extended thinking + web_search — easily $0.50–1.50 per research call. Mitigation: cache by slug (`profiles/{slug}` doc is the cache); the second player asking for the same IP gets it free.
- **AniList rate limits + Fandom anti-scraping.** Path A is fragile against external services. Mitigation: Path A is gated, eval-driven — if Path B is good enough we delete Path A.
- **Hallucination in Path B.** LLM-only research may invent NPCs, abilities, episodes. Mitigation: web_search tool is required (model card forces tool use); the eval harness measures hallucination rate against ground truth.
- **Disambiguation UX.** A title like "Bleach" maps to anime + manga + films + Burn the Witch + Thousand-Year Blood War; surfacing all of those breaks the chat flow. Mitigation: surface top 3 by AniList popularity; collapse anime+manga of the same canon by default.
- **Hybrid synthesizer over-creative.** "Bebop + Solo Leveling" could produce something that's neither — losing both source's tone. Mitigation: synthesizer is gated behind player confirmation ("here's the synthesis — accept or refine?"), not a one-shot.
- **Schema drift from v3.** `Profile` schema in `src/lib/types/profile.ts` may have differences from v3's `AnimeResearchOutput`. Mitigation: `normalize.ts` is the explicit conversion; eval YAMLs use the v4 schema as ground truth.

---

## 5. Acceptance (Wave B DoD)

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint` verdes.
- [ ] App desplegada con rollout en verde.
- [ ] Player names a third IP (e.g. Frieren) at `/sz` → conductor calls `searchProfileLibrary` → no hit → spawns research → research returns within 60s → conductor presents result → player ratifies → profile is written to Firestore + indexed in Algolia → handoff produces an OpeningStatePackage with the researched profile's DNA defaults.
- [ ] Hybrid case: player names two IPs → handoff runs the synthesizer → `OpeningStatePackage` includes `hybrid_synthesis_notes`.
- [ ] Eval harness runs `pnpm evals:profile-generation` and prints a Path A vs B comparison table.
- [ ] Subagent audit on each sub-commit. Findings addressed.
- [ ] `docs/retros/M2-wave-b.md` written with decision (ship Path A+B both, or B alone).

---

## 6. What's after Wave B

- M2.5 — billing substrate (Stripe via Clerk Billing → Firebase Auth bridge).
- M3 — campaign export / replay-from-artifact, custom profile authoring UI.
- M4 — embedder + Vector Search activation. Embeddings populated, `search_memory` upgrades to semantic.
- M5+ — ProductionAgent (image generation), portrait UI, animation_inputs consumed.

This plan does not touch any of those.
