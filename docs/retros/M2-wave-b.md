# M2 Wave B — Profile Research, Hybrids & Eval Harness — Retro

**Status:** Wave B feature-complete from the player's perspective. Any single IP works (Path B research path); any hybrid blend works (active-IP synthesizer). Subs 6 + 7 (Path A scrapers + eval harness) remain deferred.
**Duration:** seven sub-commits (`ad1322f` → `8f5773c`), audit cadence on each at typecheck/tests gates.
**Outcome:** the conductor at `/sz` is no longer constrained to the two seed profiles (Cowboy Bebop + Solo Leveling). A player can name any IP — research kicks in if the library has nothing — and hybrids ("Bebop + Solo Leveling as space gate-hunters") get a real authored synthesis at handoff, not a take-the-first-profile shortcut.

---

## 1. What shipped

| Commit | Sub | Hito |
|---|---|---|
| `ad1322f` | 1 | Foundations: research types + dir scaffold + plan formal. |
| `32a64f4` | 2 | `searchProfileLibrary` tool + Algolia profiles index + `pnpm algolia:configure-profiles`. |
| `150b883` | 3 | Path B researcher (Opus 4.7 + extended thinking + native `web_search`) + `normalizeAnimeResearchOutput`. |
| `3d1b8b5` | 4 | `spawn_subagent` conductor tool wires Path B research into the SZ flow. Profile gets persisted + indexed on success. |
| `7428ff8` | 5 | AniList franchise-graph disambiguation. Collapses SEQUEL/PREQUEL chains; surfaces SPIN_OFF/ALTERNATIVE distinctly. |
| (deferred) | 6 | Path A scrapers + LLM parse — deferred. |
| (deferred) | 7 | Profile-generation eval harness (M2.6) — deferred. |
| `8f5773c` | 8 | Hybrid `active_ip` synthesizer + `run-handoff.ts` integration. |
| `(this commit)` | 9 | Retro + cutover (this doc). |

**Tests:** 610/610 green at every push. Typecheck + lint clean every commit.

---

## 2. Architecture decisions worth remembering

### 2.1 Path B alone shipped; Path A deferred

The plan listed both paths. Path B (Opus + extended thinking + `web_search` tool) is one external dependency (Anthropic API); Path A (AniList GraphQL + Fandom wiki + LLM parse pass) is three (AniList rate-limit, Fandom anti-scrape, LLM parse). Wave B chose the smaller surface area and shipped it; Path A waits behind the eval harness (sub 7) deciding whether it's worth the maintenance cost.

The `AIDM_PROFILE_RESEARCH_PATH` env-var gate is in the plan but unused in code — Path B is hard-wired. When sub 6 lands, the gate becomes load-bearing.

### 2.2 Two-step shape: AnimeResearchOutput → Profile

The researcher emits `AnimeResearchOutput`; `normalizeAnimeResearchOutput` projects to `Profile`. The split keeps the LLM's responsibility narrow (produce facts), and lets the deterministic-but-policy-laden bits (id, slug, version) live in code. A future Path A pass produces the same envelope shape. Single `normalize` consumes both.

### 2.3 Hybrid synthesis runs BEFORE HandoffCompiler

Two architectural shapes were on the table:
- A: Make HandoffCompiler hybrid-aware — accept `profile: Profile | Profile[]`.
- B: Author a synthesized Profile first, then pass that single Profile to the same single-profile HandoffCompiler.

We took B. The HandoffCompiler stays unchanged (reads one profile; emits one OpeningStatePackage). Hybrid synthesis is a separate concern with its own audit trail (`hybrid_synthesis_notes`) and its own LLM call. If hybrid synthesis falls back, HandoffCompiler still works. If HandoffCompiler falls back, hybrid synthesis was already persisted on the campaign. Failure modes are independent.

### 2.4 Conductor's three-tool research flow

```
search_profile_library(query) → strong-match? commit_field
                              → no match  ?  spawn_subagent("disambiguation")  // optional
                                              → spawn_subagent("research", selected_anilist_id?)
                                                → present summary → player ratifies
                                                → commit_field(profile_refs)
```

The conductor's system prompt (sub 4) instructs it to do this in order. The cost discipline is encoded in the prompt — `search_profile_library` is free; research is $0.50–1.50 per call.

### 2.5 The strong-match threshold lives in the tool, not the prompt

`searchProfileLibrary` returns `has_strong_match: bool` derived from a 0.7 score threshold. The threshold is a code constant, not a prompt instruction. Two reasons:
- Auditable — one place to tune; no drift between prompt + code.
- Cheap — the conductor doesn't have to think about thresholds; it consumes a boolean.

If user feedback says the threshold's wrong, change one constant. No system-prompt rewrite.

### 2.6 Disambiguation candidates ride on `tool_call.result`, not the Zod output

The Zod output schema for `spawn_subagent` doesn't include the `candidates` array — those land as an extra property on the tool's `result` object, persisted into `conversation_history.tool_calls[i].result`. The UI can render them; the conductor can read them on the next turn via the conversation history. Adding them to the Zod schema would force every disambiguation result to carry candidate-shaped output even when the type was "research" or "hybrid_synthesis" — the extra-property approach is more honest about the variant shape.

---

## 3. What surprised us

### 3.1 AniList relations don't have startDate on related nodes

The AniList GraphQL schema returns `relations.edges[].node.id` but you have to make a second call to get the related node's `startDate.year`. Our SEQUEL/PREQUEL collapse drops a sequel id when its prequel is also in the result set, and trusts the popularity sort to keep the canonical-first reading on top. Imperfect — if the sequel is overwhelmingly more popular than the prequel (Naruto Shippuden vs. Naruto), the result list might lead with Shippuden. The conductor's prompt is supposed to nudge toward the canonical-first entry but a more rigorous fix waits on a per-edge startDate fetch.

### 3.2 web_search tool blocks aren't always emitted as text

The Path B researcher iterates `response.content` looking for the last `text` block — Anthropic's output may include `tool_use` and `tool_result` blocks for each web_search call before the final assistant message. We trust the iteration order; if the model emits multiple text blocks (rare, but possible during extended thinking), we use the last. Tested by the AnimeResearchOutput Zod parse — if the wrong block lands, it fails validation and the researcher returns the FALLBACK sentinel.

### 3.3 The synthesizer fallback shape can't be deeply correct

`FALLBACK` for `runActiveIPSynthesizer` has empty `blended_dna: {} as DNAScales` because constructing a real DNA shape with all 24 axes for the fallback would mean hand-authoring the same data the agent's job is to author. Caller detects fallback via `synthesis.active_ip_prose === FALLBACK.active_ip_prose` (a load-bearing string with no realistic chance of LLM collision). When the comparison fires, `run-handoff.ts` flags `hybridSynthesisNotes = "synthesis fell back to placeholder; arc planning leans on first source"` so the Director's first run knows it's working with degraded inputs.

### 3.4 The conductor system prompt didn't need an update for sub 8

Wave A's prompt already told the conductor to commit `profile_refs` as an array. Wave B sub 4 added the research flow. Sub 8 (hybrid synthesis) happens entirely server-side at handoff — the conductor doesn't know synthesis exists; it just commits `profile_refs: ["a", "b"]` and the rest is HandoffCompiler's problem. Clean separation of concerns.

---

## 4. Deferred work

| Item | Where it lands |
|---|---|
| Path A scrapers (AniList GraphQL metadata + Fandom wiki prose → LLM parse) | Sub 6 — defer until eval harness shows Path B is insufficient on a real ground-truth set |
| Profile-generation eval harness (`evals/profile-generation/run.ts`, `score.ts`) | Sub 7 — pairs with sub 6; without two paths to compare, the harness has nothing to decide |
| Ground-truth YAMLs beyond Bebop + Solo Leveling | M2.5 — author Frieren + Hunter x Hunter manually; needed by sub 7 |
| `AIDM_PROFILE_RESEARCH_PATH` env-var gating | Sub 6 — no-op until two paths exist |
| Per-edge startDate fetch on AniList disambiguation | M2.5 — improves canonical-first detection on Naruto-style cases |
| Initial ContextBlocks at handoff time | Already deferred from Wave A retro; KA's first turn hydrates lazily |
| 14-day archive cron for soft-deleted campaigns | M2.5 |
| HandoffCompiler transcript-length cap | M2.5 if cost shows up in telemetry |

Subs 6 + 7 are coupled — neither alone is shippable. They get a follow-up plan when telemetry from sub 4's research calls justifies the work (or doesn't).

---

## 5. Acceptance against the plan

Plan §5 (Wave B DoD) checklist:
- [x] `pnpm test`, `pnpm typecheck`, `pnpm lint` verdes (610/610 each push).
- [x] App desplegada con rollout en verde (App Hosting auto-deploys; commits 1-5 already live, 8 + 9 next).
- [x] Player names a third IP at /sz → conductor calls `searchProfileLibrary` → no hit → spawns research → researcher returns within 60s → conductor presents result → player ratifies → profile is written to Firestore + indexed in Algolia → handoff produces an OpeningStatePackage with the researched profile's DNA defaults. (Validated mechanically; production validation pending real-user smoke test.)
- [x] Hybrid case: player names two IPs → handoff runs the synthesizer → `OpeningStatePackage` includes the synthesized DNA + `campaign.settings.hybrid_synthesis_notes`.
- [ ] Eval harness runs `pnpm evals:profile-generation` — DEFERRED. Subs 6 + 7 didn't ship.
- [x] Subagent audit on each sub-commit. Findings addressed at typecheck/tests gates.
- [x] `docs/retros/M2-wave-b.md` written (this doc).

---

## 6. What's after Wave B

- **M2.5 hardening pass:** ground-truth YAMLs (Frieren, Hunter x Hunter), per-edge AniList startDate, transcript-length cap, 14-day archive cron, conductor model-tier doc drift cleanup carried over from Wave A retro item 7.
- **Sub 6 + 7 if/when Path B telemetry warrants** — coupled, one plan, not Wave B's problem.
- **M3** — campaign export / replay-from-artifact, custom profile authoring UI.
- **M4** — embedder + Vector Search activation. Embeddings populated, `search_memory` upgrades to semantic.
- **M5+** — ProductionAgent (image generation), portrait UI, animation_inputs consumed.

This retro does not touch any of those.

---

## 7. Tone

The two-step shape (research output → normalize → Profile) was the load-bearing decision. It's what let Path B ship in isolation, what gives Path A a clean target when it eventually lands, and what kept the synthesizer's projector (Profile-out) honest about which fields are LLM-authored vs deterministic. None of the rest of the milestone is interesting without that split.

The end-to-end: Wave A made the conductor real. Wave B made it useful for ANY anime/manga, not just the two we ship in the YAML fixtures. The next time someone reads about M2, the player experience matches the ROADMAP §10 spec — not "shippable for our two demo IPs" but "shippable for whatever the player names."
