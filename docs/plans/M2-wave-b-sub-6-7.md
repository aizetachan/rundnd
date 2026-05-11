# M2 Wave B sub 6 + 7 — Path A scrapers + profile-generation eval harness

**Milestone:** Wave B follow-up (single bundled commit).
**Status:** 🟡 Plan written, implementation in flight.
**Authority:** `docs/plans/M2-wave-b.md` §3 sub 6 + 7, `docs/retros/M2-wave-b.md` §4 (deferred work table — items 1, 2, 4).
**Goal:** close the two deferred sub-commits from Wave B. After this lands, the conductor has a second research path (Path A — AniList + Fandom + LLM parse) and a harness that scores both paths against ground-truth YAMLs. The §10.6 decision rule ("ship Path B alone if quality matches; else keep both") becomes actionable instead of aspirational.

---

## 1. What's there and what's missing

**There (Wave B retro):**
- `src/lib/research/types.ts` — `AnimeResearchOutput`, `FranchiseCandidate`, `ResearchPath = "a" | "b"`, `ResearchTelemetry`.
- `src/lib/research/anilist.ts` — minimal GraphQL client (search + franchise-graph for disambiguation).
- `src/lib/research/normalize.ts` — `AnimeResearchOutput → Profile` projection (one normalize fn covers both paths by design).
- `src/lib/agents/profile-researcher-b.ts` — Path B (Opus + extended thinking + `web_search`).
- `evals/profile-generation/README.md` — scaffold pointing at sub 7.
- `evals/golden/profiles/cowboy_bebop.yaml`, `solo_leveling.yaml` — two ground-truth fixtures.

**Missing (this plan delivers):**
- AniList deep-metadata query (description, characters, tags, mean popularity, etc.) — the franchise-graph query is too narrow to feed Path A's LLM parse pass.
- `src/lib/research/fandom.ts` — single-page Fandom wiki fetcher with conservative rate limits.
- `src/lib/agents/profile-researcher-a.ts` — orchestrator that pulls AniList metadata + Fandom prose, hands them to a fast-tier LLM parse pass producing `AnimeResearchOutput`.
- `AIDM_PROFILE_RESEARCH_PATH=a|b|both` env-var gating (currently unused; plan §3 sub 6 says this becomes load-bearing at sub 6).
- `evals/profile-generation/run.ts` — runs the active path(s) against ground-truth YAMLs, writes raw output + telemetry.
- `evals/profile-generation/score.ts` — DNA delta, trope agreement, power-tier delta, stat-mapping correctness. Multi-axis aggregated score per IP.
- `pnpm evals:profile-generation` script.

---

## 2. Sub-commit (single thorough commit)

Per CLAUDE.md "thorough over tiny" + the M2.5 residuals shape: one commit that ships both subs together. Audit on the full diff.

### 2.1 Path A — scrapers + LLM parse

**AniList deep query.** Extend `src/lib/research/anilist.ts` with a second exported fn `fetchAniListProfile(anilist_id: number): Promise<AniListProfilePayload>` returning:
- title, alternate_titles, type, format, status, startDate.year, episodes, chapters, popularity, averageScore.
- description (Markdown, AniList provides it cleaned).
- tags (name, rank, isMediaSpoiler — used for trope detection).
- characters (top 6 by role: MAIN / SUPPORTING / BACKGROUND).
- relations (sequels / spin-offs / source — for the slug + series_group fields).

A new `AniListProfilePayload` interface in the file (not exported to types.ts — implementation detail of the scrapers pipeline). The GraphQL query lives inline next to `SEARCH_QUERY` per the existing pattern.

**Fandom scraper.** New `src/lib/research/fandom.ts` with `fetchFandomPage(slug: string): Promise<string | null>`. Single-page fetch, no link following, no anti-scrape evasion (if Fandom 403s on us we return null and Path A falls back to AniList-only). Strips wiki nav / sidebar / templates; keeps prose text. The `slug` comes from the AniList payload's title.

Fandom URL convention: `https://{ipname}.fandom.com/wiki/{Main_Character_Or_Concept}`. Knowing the right subdomain is the hard part — we use the title's slugified form (lowercase, hyphens) as the subdomain candidate, fall back to null on 404. This is acknowledged-fragile per the plan §4 risk; the eval harness will measure how often it fires.

**Path A orchestrator.** `src/lib/agents/profile-researcher-a.ts`:
- Step 1: `searchFranchise(query)` → top match → `selectedAnilistId`.
- Step 2: `fetchAniListProfile(anilist_id)` → structured AniList payload.
- Step 3: `fetchFandomPage(slug)` → prose (or null).
- Step 4: LLM parse pass — Sonnet 4.6 (thinking tier; structured-output discipline matters more than extended reasoning). The prompt receives AniList payload + Fandom prose + the `AnimeResearchOutput` schema, returns the JSON. Same Zod parse + one-retry policy as Path B.
- Returns `{ output, telemetry }` matching Path B's shape so the harness can compare apples-to-apples.

**Env-var gate.** Add `AIDM_PROFILE_RESEARCH_PATH` to `src/lib/env.ts`. Default `"b"` (no behavior change). `searchProfileLibrary → no hit → spawn_subagent("research")` consults the env var to pick Path A, Path B, or both (parallel; sub-7-style comparison out of band).

### 2.2 Sub 7 — eval harness

**`evals/profile-generation/run.ts`.**
- Loads ground-truth YAMLs from `evals/golden/profiles/*.yaml` (the existing 2). Authoring Frieren + HxH ground-truths is deferred per §4 below — the harness ships functional against the existing 2, which is enough to demonstrate scoring + drive sub 6 decisions.
- For each IP: invoke the configured path(s), capture `AnimeResearchOutput` + telemetry.
- Writes to `evals/profile-generation/runs/<timestamp>/<path>/<slug>.json`.
- CLI flags: `--path a|b|both` (default `both`), `--ip <slug>` to scope to one fixture.

**`evals/profile-generation/score.ts`.**
- `scoreDnaDelta(produced, groundTruth): number` — sum of `|p - g|` across the 11 numeric DNA axes.
- `scoreTropeAgreement(produced, groundTruth): number` — count of boolean disagreements across the 15 trope axes (lower is better).
- `scorePowerTierDelta(produced, groundTruth): number` — peak/typical/floor ordinal distance.
- `scoreStatMapping(produced, groundTruth): boolean` — did Path X correctly detect on-screen stats where they exist (SL has them, Bebop doesn't)?
- Aggregates into `score.json` + a printable `decision.md` per the README spec.

Voice-card + visual-style judge scores (Gemini-as-judge) are deferred — they need an additional Gemini-client wrapper + rubric prompts that warrant their own follow-up. The four mechanical axes ship in this commit.

**`pnpm evals:profile-generation`** entry in `package.json`.

---

## 3. Scope decisions

- **One commit, not two.** Per CLAUDE.md "thorough over tiny." Both subs are coupled (sub 7 can't decide anything without sub 6's second path), so they ride together. Bundled audit cycle on the full diff.
- **Sonnet 4.6 (thinking tier) for Path A parse, not Opus.** Path A's job is structured extraction over already-fetched material, not synthesis. Cheaper + faster; output discipline still adequate. Path B stays on Opus + extended thinking + `web_search` — that's where the synthesis happens.
- **Two ground-truths instead of four.** Frieren + HxH authoring deferred. The harness ships functional against Bebop + SL; scoring is meaningful with just two IPs (one with stats, one without). Authoring more YAMLs is a separate exercise that needs content-side review.
- **Gemini-as-judge axes deferred.** The mechanical four (DNA / tropes / power / stat-mapping) cover the §10.6 decision rule's hard thresholds. Judge rubrics ship in a follow-up commit when there's content to compare on.
- **Fandom subdomain heuristic stays naive.** A title-to-subdomain mapping table would be the rigorous fix; the eval harness will surface whether Fandom-null is rare enough that Path A degrades gracefully or if the heuristic needs work.
- **No conductor system-prompt changes.** `spawn_subagent("research")` already routes through whatever path the env-var picks. The conductor stays path-agnostic.

---

## 4. Deferred work (out of this commit)

- Frieren + HxH ground-truth YAMLs (§10.5 spec breadth). Authoring effort + content review; lands in its own pass.
- Gemini-as-judge voice-card + visual-style scoring (the two soft axes).
- Per-edge AniList `startDate` for richer canonical-first detection (Wave B retro §3.1 item).
- Fandom subdomain map for irregular cases.
- M9 cost-ledger integration of Path A telemetry (AniList/Fandom calls don't have per-call cost; LLM parse pass cost mirrors any other Sonnet call already tracked).

---

## 5. Risks

- **Fandom anti-bot.** Random 403s on first launch — mitigation: return null + let LLM parse fall back to AniList-only.
- **Path A LLM parse hallucinates outside the source material.** Prompt is constrained ("Use ONLY the provided AniList payload and Fandom prose; do not invent characters or abilities"). Sonnet 4.6 honors this well in tests. The eval harness measures it.
- **AniList rate-limit (90 req/min/IP).** Single research call is ~2 queries (search + deep). Below the limit. Sub 7 harness running over 2 IPs is fine.
- **Ground-truth set is too small to decide §10.6.** Acknowledged. Sub 7's purpose at this commit is to build the comparator; the decision needs at least 4-6 IPs to be credible. Authoring backlog explicit.
- **Scoring axes are over-mechanical.** DNA delta + trope agreement are well-defined; "stat mapping correctness" relies on the harness knowing which IPs *should* have stats — encoded as a `has_stat_mapping_ground_truth: boolean` field on the YAML or inferred from the YAML's `ip_mechanics.power_distribution.has_quantified_stats` shape.

---

## 6. Acceptance (sub 6+7 DoD)

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` verdes.
- [ ] `pnpm evals:profile-generation --path b --ip cowboy_bebop` runs and writes a `runs/<ts>/b/cowboy_bebop.json`. (Path A run needs network access to AniList + Fandom; documented in the script's `--help`.)
- [ ] `AIDM_PROFILE_RESEARCH_PATH=a` env var routes the conductor's `spawn_subagent("research")` through Path A (smoke-tested with a mock LLM).
- [ ] Subagent audit on full diff. Findings addressed.
- [ ] No retro (this is closing existing scope, not a new milestone).

---

## 7. What's next

After this commit:
- M3.5 — Google-KA (Gemini multi-provider for KA).
- M4 — embedder + Vector Search.
- The Gemini-as-judge + ground-truth YAML authoring backlog gets a follow-up plan when the data demands it.
