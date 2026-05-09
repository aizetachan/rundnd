/**
 * Helpers for deterministic Firestore doc IDs from natural keys.
 *
 * Many catalog tables in the SQL world enforced uniqueness via UNIQUE
 * INDEX on (campaignId, name). Firestore has no such constraint, but
 * using the natural key as the doc ID is race-free and idempotent: two
 * concurrent writes converge on the same doc rather than creating
 * duplicates. The trade-off is that names must be sanitized into a
 * legal doc id (Firestore disallows `/`, `__`*__, etc.).
 */

const SAFE_ID_CHARS = /[^a-z0-9_-]+/g;

/**
 * Lowercase + collapse non-alphanumeric runs to `-`. 200-char cap so
 * weird inputs can't blow past Firestore's 1.5KB doc-id ceiling.
 *
 * Same input → same output. Different inputs that collide post-sanitize
 * (e.g. "Lloyd" vs "lloyd") are treated as the same NPC, which mirrors
 * the original SQL UNIQUE on case-insensitive name semantics. If the
 * game ever needs case-sensitive NPC names, switch to slugifying with
 * a hash suffix.
 */
export function safeNameId(name: string): string {
  return name.trim().toLowerCase().replace(SAFE_ID_CHARS, "-").replace(/^-+|-+$/g, "").slice(0, 200) || "unnamed";
}
