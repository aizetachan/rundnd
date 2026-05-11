# M3 — Persistent Campaigns

**Milestone:** M3 (after M2.5 close).
**Status:** 🟡 Plan written, sub-commits starting.
**Authority:** ROADMAP §23 → "M3 — Persistent campaigns (3-4 days)".
**Goal:** durable, exportable, deletable campaigns. The user can take their data with them, the user can wipe their account, and the system survives those operations cleanly.

---

## 1. What ROADMAP §23 M3 specifies

> Campaign CRUD (Server Actions + list/detail Server Components). ✅ Already done (M2 sub 5/6)
> Turn persistence with prompt fingerprints and trace links. ✅ Already done (M1)
> JSON export (`/api/users/export`). ⏳ THIS PLAN
> Account deletion (soft → hard within 24h). ⏳ THIS PLAN
> Settings page (tone, content tier). ✅ Already done (M2 sub 5)
> Admin trace viewer. ⏳ THIS PLAN (or deferred to M3.5 — see §3)

> **Acceptance:** create two campaigns, play both, resume across browser close, data survives Railway redeploy, export round-trips, delete works end-to-end.

The "data survives redeploy" + "resume across browser close" bullets are already covered by Firestore + M2 Wave A sub 5. What remains is **export** + **deletion** + (optionally) **admin trace viewer**.

---

## 2. Sub-commits

### Sub 1 — JSON export (`/api/users/export`)

**Goal:** the user clicks a button on `/account/spending` (or a new `/account` page) → downloads a JSON bundle of every campaign they own + every turn + every memory layer entry.

**Files:**
- `src/app/api/users/export/route.ts` — POST endpoint, auth-gated, streams a JSON blob with the user's full state.
- `src/app/(app)/account/page.tsx` (or modify existing `/spending` page) — adds an "Export my data" button.
- Helper: `src/lib/account/export.ts` builds the bundle.

**Bundle shape:**
```json
{
  "schema_version": "v1",
  "exported_at": "2026-05-11T...",
  "user": { "id": "...", "email": "..." },
  "campaigns": [
    {
      "id": "...",
      "name": "...",
      "phase": "playing",
      "profile_refs": ["cowboy-bebop"],
      "settings": { ... },
      "createdAt": "...",
      "turns": [{ "turn_number": 1, ... }],
      "characters": [{ "name": "...", ... }],
      "context_blocks": [...],
      "semantic_memories": [...],
      "session_zero": { ... }  // when present
    }
  ]
}
```

Excludes: provisional memory writes, OpeningStatePackage versioned artifacts (too verbose; recoverable from session_zero + the latest turn).

### Sub 2 — Account deletion (soft + hard)

**Goal:** user can wipe their account. Soft delete is immediate (sets `users/{uid}.deletedAt = now`, marks all owned campaigns `deletedAt = now`); hard delete runs ~24h later via a Cloud Scheduler cron that scans `users.where(deletedAt < 24h ago)` and purges every subcollection.

**Files:**
- `src/app/api/users/delete/route.ts` — POST endpoint. Two-step confirm UX (mirror the abandon-campaign pattern from M2 Wave A sub 5).
- `src/app/(app)/account/page.tsx` — adds "Delete my account" button at the bottom, separated visually.
- `src/lib/account/soft-delete.ts` — marks `deletedAt` on user + all owned campaigns transactionally.
- `scripts/users-hard-delete.ts` — CLI script that purges users where `deletedAt < now - 24h`. Documented for manual run pending Cloud Scheduler in sub 3 (or M9 billing milestone).
- `firebase.json` — no Cloud Scheduler entry yet (manual cron deferred).

Side effects on soft delete:
- `getCurrentUser()` checks `users/{uid}.deletedAt`; if non-null, returns null → middleware redirects to /sign-in.
- The 14-day archive cron (Wave A retro item) gets unified with this: a single "users.where(deletedAt < N)" scanner handles both.

### Sub 3 — Admin trace viewer (optional)

**Goal:** a `/admin/traces` page where the dev (you) can see recent Langfuse-style traces of turns. Useful for debugging "why did KA narrate X?"

**Status:** evaluating necessity. Langfuse already provides this externally; building it in-app duplicates work. **Decision deferred** — if the M3 retro shows real debugging pain, sub 3 lands as a follow-up. Today's plan ships sub 1 + sub 2 only.

### Sub 4 — Retro

`docs/retros/M3.md`.

---

## 3. Scope decisions

- **Cloud Scheduler for hard deletion deferred.** The hard-delete script runs manually at M3 first ship. Cloud Scheduler integration lands when there's an admin surface (M3.5+) or when billing makes the data-retention policy auditable (M9 Stripe).
- **Admin trace viewer deferred.** Langfuse covers the external view. Re-evaluate at M3 retro.
- **Custom profile authoring UI deferred to a separate plan.** Not in ROADMAP §23 M3; it's a debug/admin feature with its own scope.
- **Settings page (M3 listed it as deliverable) already done in M2 Wave A sub 5.** Modifications, if any, ride on sub 1's `/account` page work.

---

## 4. Risks

- **Export bundle size.** A 200-turn campaign with all memory layers could be 500 KB - 2 MB of JSON. Streaming response handles it; the client-side download blob does too. Hit-the-cap is unlikely at M3 timescale but worth watching.
- **Deletion is irreversible past 24h.** Two-step confirm UX is the user-facing safety net. The 24h soft-delete window is the technical one (gives them a path to email "I changed my mind" — when a support email exists in the future).
- **Auth cookie still valid after soft-delete.** Firebase Auth session cookies are 14-day; the deletedAt check in getCurrentUser is the runtime gate. If the cookie isn't revoked, a stale tab could still hit auth-required APIs — but our routes all `getCurrentUser → null check → 401`, so it's covered.
- **Soft-deleted campaigns lose their Algolia profile/turn indices?** No — soft delete leaves Firestore data intact; indices stay until hard delete (sub 3 cron) which also deletes the Algolia records.

---

## 5. Acceptance (M3 DoD)

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build` verdes.
- [ ] App deployed con rollout en verde.
- [ ] Smoke: create campaign, play 2 turns, click "Export my data" → downloads a JSON file → opens and contains both turns + character + any chronicler-written memory.
- [ ] Smoke: click "Delete my account" → confirm → next request 401s → /sign-in shows landing → sign-in with same Google account creates a NEW (clean) user doc (the deleted one no longer matches via lazy-upsert because the lazy-upsert checks `deletedAt`).
- [ ] Subagent audit on each sub-commit. Findings addressed.
- [ ] `docs/retros/M3.md` written.

---

## 6. What's after M3

ROADMAP §23 ladder: M3.5 Google-KA → M4 embedder + Vector Search → M5+ image generation. Wave B sub 6+7 (Path A scrapers + eval) remains in parallel. M2.5 hardening items continue rolling forward.
