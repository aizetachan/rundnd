import { type DocumentData, type DocumentSnapshot, Timestamp } from "firebase-admin/firestore";
import type { z } from "zod";

// Firestore does not enforce a schema — guarantees live in app code. Every
// read/write goes through these helpers so the Zod contract is the same
// front-door that Drizzle's column types used to give us.
//
// Lifecycle of a document:
//   write → encodeForFirestore() converts Date → Timestamp + drops undefined
//   read  → decodeFromFirestore() converts Timestamp → Date + parses with Zod
//
// Anything that needs raw Firestore (transactions, batched writes, vector
// queries) should still call getFirebaseFirestore() directly. These helpers
// are convenience for the common single-doc / single-collection paths.

/**
 * Recursively convert Date → Firestore Timestamp and drop `undefined`
 * (Firestore rejects `undefined` field values; explicit null is fine).
 */
export function encodeForFirestore<T>(value: T): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (value instanceof Date) return Timestamp.fromDate(value);
  if (Array.isArray(value)) {
    return value.map((v) => encodeForFirestore(v)).filter((v) => v !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const encoded = encodeForFirestore(v);
      if (encoded !== undefined) out[k] = encoded;
    }
    return out;
  }
  return value;
}

/**
 * Recursively convert Firestore Timestamp → Date so Zod schemas that expect
 * `z.date()` validate cleanly.
 */
export function decodeFromFirestore(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(decodeFromFirestore);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = decodeFromFirestore(v);
    }
    return out;
  }
  return value;
}

/**
 * Parse a Firestore snapshot through a Zod schema. Returns null for
 * non-existent docs so callers can branch without throwing.
 */
export function parseSnapshot<T>(
  snap: DocumentSnapshot,
  schema: z.ZodType<T>,
): (T & { id: string }) | null {
  if (!snap.exists) return null;
  const raw = snap.data() as DocumentData;
  const decoded = decodeFromFirestore({ ...raw, id: snap.id });
  return schema.parse(decoded) as T & { id: string };
}
