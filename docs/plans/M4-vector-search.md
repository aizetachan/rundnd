# M4 — Embedder + Vector Search

**Milestone:** M4 (after M3.5 sub 1).
**Status:** 🟡 Plan written, sub 1 (embedder foundation) shipping in this commit.
**Authority:** ROADMAP §23 → "M4 — embedder + Vector Search (3-4 days)"; M0.5 retro ("Vector Search diferido a M4"); `src/lib/tools/semantic/search-memory.ts:80–87` documents the gated M4 retrieval runtime; `src/lib/tools/chronicler/write-semantic-memory.ts:14` documents the embedding-null write at M1.
**Goal:** semantic memory layer becomes useful. Today every `search_memory` call returns an empty array; chronicler writes facts with `embedding: null`. After M4, `write_semantic_memory` populates real embeddings and `search_memory` does vector top-k against the campaign's memory store + heat boost + category decay + MemoryRanker rerank.

---

## 1. Decisions

### 1.1 Embedder: Gemini `text-embedding-004` via `@google/genai`

The SDK is already wired (M3.5 sub 1 ships Google-KA on the same dependency). Gemini's text-embedding-004 is 768-dim, $0.0125 per 1M input tokens. A typical semantic memory fact is ~30 tokens; 100k memory writes ≈ 3M tokens ≈ $0.04. Cheap enough not to gate.

Alternatives considered, all rejected for this milestone:
- **Voyage** — best benchmarks for narrative search but a new SDK + new key + a new bill line.
- **OpenAI `text-embedding-3-small`** — fine, but `@openai/sdk` is currently used only for tests / probes; adding OpenAI as a runtime dependency widens the failure surface.
- **Anthropic** — doesn't ship an embedder.

`AIDM_EMBEDDING_PROVIDER` env var stays — when Voyage's pricing or quality justifies it (M9-ish?), the registry pattern lets us add a second backend without rewriting callers.

### 1.2 Storage: Firestore Vector Search (`findNearest`)

The Firebase Admin SDK supports a `findNearest()` query that performs cosine / dot-product / euclidean KNN over a vector-indexed field. Per the project memory: "Vector Search diferido a M4 (no embedder hasta entonces)." That was always the plan.

We add a single-field vector index on `semanticMemories.embedding` per campaign via `firestore.indexes.json`. Index creation is async (~5min on first deploy); the write path doesn't block on index readiness because writes don't query.

Alternatives considered, rejected:
- **pgvector** — would need a Postgres adjacent to Firestore. The user explicitly rejected hybrid Firebase + external Postgres (see `project_firebase_pure_decision.md`).
- **Algolia vectors** — Algolia supports vectors but the index is per-app, not per-campaign. Cross-campaign isolation would have to be enforced via filters, which is fragile.

### 1.3 Embed at write time, not at read time

Embeddings are computed inside `write_semantic_memory` before the Firestore doc lands. The write blocks on the embedder call (~50-100ms typical). Read path becomes free of embedder cost — `search_memory` just calls `findNearest` with the query embedding.

The query embedding still pays one embedder call per `search_memory` invocation. KA's `search_memory` doc says "2–3 orthogonal queries per turn" — that's 2–3 embed calls per memory-heavy turn, sub-cent each.

### 1.4 Backfill is best-effort, not blocking

Existing rows have `embedding: null` (M1 writes). A backfill script populates them in batches; the script runs once at first M4 deploy, then again whenever a category's decay knob shifts or the embedder model bumps. Rows that fail backfill stay null and are excluded from `findNearest` (no contribution to recall). Acceptable degradation — non-embedded rows are still searchable by category + heat in MemoryRanker's fallback path.

---

## 2. Sub-commits

### Sub 1 — Embedder foundation (this commit)

**Files:**
- `src/lib/embeddings/index.ts` — barrel export.
- `src/lib/embeddings/types.ts` — `Vector` (Float32Array), `EmbedResult` envelope.
- `src/lib/embeddings/gemini.ts` — `embedTextGemini(text)` calls Gemini's `embedContent` endpoint via `@google/genai`.
- `src/lib/embeddings/index.ts` exports a registry `embedText(text)` that dispatches by `env.AIDM_EMBEDDING_PROVIDER` (default `"gemini"`).
- `src/lib/env.ts` — adds `AIDM_EMBEDDING_PROVIDER` enum (`"gemini" | "none"`) and `AIDM_EMBEDDING_MODEL` string (default `"text-embedding-004"`).
- `src/lib/tools/chronicler/write-semantic-memory.ts` — when embedder is configured AND the env var is not `"none"`, embed `content` before the Firestore insert; persist as `Float32Array` (Firestore SDK serializes as `VectorValue` automatically). On embedder failure, log + persist with `embedding: null` so the write never blocks on Gemini availability.
- Tests: `src/lib/embeddings/__tests__/gemini.test.ts` — mock the SDK, verify shape + error fallback. `src/lib/tools/chronicler/__tests__/chronicler-tools.test.ts` — extend the existing `write_semantic_memory` test suite with an embedded-on path (env=`"gemini"`, mocked embedder) and the failure-fallback path.

**NOT in sub 1:**
- `search_memory` still returns empty. The retrieval runtime is sub 2.
- No Firestore Vector Search index creation. Sub 2 adds `firestore.indexes.json`.
- No backfill script. Sub 3.
- No MemoryRanker integration. Sub 4.

### Sub 2 — Vector retrieval runtime

**Files:**
- `firestore.indexes.json` — add vector index on `semanticMemories.embedding` (configuration: `vectorConfig: { dimension: 768, flat: {} }`).
- `src/lib/tools/semantic/search-memory.ts` — implement the read path:
  - Embed the query (or each of `queries`) via `embedText`.
  - Call `firestore.collection(...).findNearest({ vectorField: "embedding", queryVector, limit: k, distanceMeasure: "COSINE" })`.
  - Apply `STATIC_BOOST` (session_zero / plot_critical / episode tier).
  - Multiplex with category + heat decay (existing `decay.ts`).
  - Pass to MemoryRanker for final rerank (already wired).
- Tests: end-to-end + the merge logic.

### Sub 3 — Backfill script

`scripts/embed-backfill.ts`. CLI: scan `semanticMemories` where `embedding == null`, batch-embed (5 docs / batch, ~250ms each), persist. `--dry-run`, `--limit N`, `--campaign <id>` flags. Idempotent — re-running on the same data is a no-op.

### Sub 4 — Polish + retro

- Wire embedding cost into the cost ledger.
- Surface "embedded vs not" telemetry on the memory inspection page.
- M4 retro.

---

## 3. Scope decisions

- **Sub 1 ships the embedder + write-path embed only.** Read path stays sub 2 — keeps the foundation reviewable in isolation.
- **`embedding: null` rows degrade silently to category-only retrieval.** No hard error. The system was already shipping with all-null embeddings; sub 1's only behavior change is that new writes populate when the env is set.
- **Gemini-only embedder at sub 1.** Voyage/OpenAI can land as additional registry entries when the cost/quality math demands it.
- **No prompt cache for embedder calls.** Each fact gets embedded once; cache would never hit.

---

## 4. Risks

- **Gemini embedder rate limits.** Free tier caps at 1500 RPM. A campaign in heavy memory-writing season could brush against it. Mitigation: M9 cost-tier work surfaces user-visible limits; sub 1's failure path (persist null on embed failure) absorbs occasional rate-limit hits.
- **Firestore Vector Search index build time on first deploy.** ~5min; reads against an unbuilt index fail with a clear error. Mitigation: sub 2 lands the index in `firestore.indexes.json` and `firebase deploy --only firestore:indexes` runs before the runtime code lights up.
- **Embedding cost compounds.** 1M memory writes ≈ $0.40 lifetime — not the dollar concern; the concern is whether KA's per-turn `search_memory` fan-out (2-3 queries × N turns × N campaigns) hits Gemini's free-tier ceiling and starts billing. Will surface in telemetry by sub 2.
- **Backfill races with concurrent writes.** A row with `embedding: null` selected by backfill could simultaneously be re-written by a Chronicler call. Mitigation: backfill uses a Firestore transaction; concurrent write wins on conflict (acceptable — the active write is the canonical state).

---

## 5. Acceptance (M4 sub 1 DoD)

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` verdes.
- [ ] `AIDM_EMBEDDING_PROVIDER=gemini` env routing wired; default `"gemini"` works without configuration when GOOGLE_API_KEY is set.
- [ ] `write_semantic_memory` populates the `embedding` field when env is set; persists `null` on embedder failure.
- [ ] Test coverage on both happy + fallback paths for the embed-on-write logic.
- [ ] Subagent audit on full diff. Findings addressed.
- [ ] No `search_memory` behavior change (still returns `[]`); documented gap.

---

## 6. What's next

After this commit:
- M4 sub 2 — vector retrieval runtime (own follow-up).
- M4 sub 3 — backfill script.
- M4 sub 4 — polish + retro.
- M5+ — image generation (ProductionAgent).
- M5.5 — OpenAI-KA.
