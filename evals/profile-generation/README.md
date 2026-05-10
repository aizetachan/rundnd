# Profile-generation eval (M2 Wave B sub 7)

Compares the two profile-research paths against ground-truth YAMLs
to drive the ROADMAP §10.6 decision rule.

## Paths under test

- **Path A** — AniList GraphQL + Fandom wiki → LLM structured-output parse.
- **Path B** — Claude Opus 4.7 + extended thinking + native `web_search` tool → direct structured output.

## Ground truth

`ground-truth/*.yaml` — small set of manually-authored Profiles. The
existing fixtures at `evals/golden/profiles/` (Cowboy Bebop, Solo
Leveling) get copied here at build time; we author 2 more by hand
(Frieren, Hunter x Hunter) so the harness sees ≥4 IPs spanning the
ROADMAP §10.5 spec coverage (canonical_dna axes hit, stat-mapping
present + absent, varied power_distribution shapes).

## Score axes

Per ROADMAP §10.6:

- DNA scale delta (sum of absolute differences across 11 numeric axes).
- Trope flag agreement (15 boolean axes; count disagreements).
- Power-distribution tier delta (peak_tier, typical_tier, floor_tier).
- Stat-mapping correctness — binary: did the path detect on-screen stats
  where they exist (Solo Leveling), and skip them where they don't
  (Cowboy Bebop)?
- Voice-card quality — Gemini-as-judge rubric 1–5 against ground-truth
  cards.
- Visual-style alignment — Gemini-as-judge rubric 1–5.

## Decision rule

Ship Path B alone (delete scrapers) if:
- DNA scale delta < 10 (summed across all axes).
- Trope disagreements < 3.
- Stat mapping correct on every IP in the ground-truth set.
- Judge scores within 0.3 of Path A.

Else: keep Path A as primary; revisit when next-generation models ship.

## Running

```bash
pnpm evals:profile-generation
```

Output:
- `runs/<timestamp>/<path>/<slug>.json` — raw `AnimeResearchOutput` from each path per IP.
- `runs/<timestamp>/score.json` — aggregated scores per axis.
- `runs/<timestamp>/decision.md` — printable summary the user can paste into the M2-wave-b retro.

## Implementation status (sub 7 not landed yet)

This README lives ahead of the runner so the directory exists and `pnpm typecheck` doesn't break on absent paths. Sub 7 wires `run.ts` and `score.ts`.
