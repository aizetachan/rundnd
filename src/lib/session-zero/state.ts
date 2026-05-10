import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import type { ConductorMessage } from "@/lib/types/session-zero";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * SZ state read/write helpers shared by the route handler + the page
 * loader. Keep this file thin — it does not validate against the full
 * `SessionZeroState` Zod schema because Firestore Timestamps don't
 * round-trip through Zod's `z.date()` (the fields stored on
 * `conversation_history` entries arrive as Timestamps, and Zod's date
 * coercion isn't symmetric). Higher layers re-shape if they need typed
 * access.
 */

export interface LoadedSessionZero {
  campaignId: string;
  phase: string;
  conversationHistory: ConductorMessage[];
  hardRequirementsMet: Record<string, boolean>;
}

function coerceDate(v: unknown): Date {
  if (v instanceof Date) return v;
  // Firestore Timestamps expose toDate(); fallback to now() so the SDK
  // doesn't choke on a malformed entry. createdAt is best-effort.
  if (v && typeof (v as { toDate?: () => Date }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  return new Date(0);
}

function coerceMessage(raw: unknown): ConductorMessage {
  const m = (raw ?? {}) as Record<string, unknown>;
  const role =
    m.role === "user" || m.role === "conductor" || m.role === "system" ? m.role : "system";
  const text = typeof m.text === "string" ? m.text : "";
  const toolCallsRaw = Array.isArray(m.tool_calls) ? (m.tool_calls as unknown[]) : [];
  const tool_calls = toolCallsRaw.map((c) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    return {
      name: typeof cc.name === "string" ? cc.name : "",
      args: cc.args,
      result: cc.result,
    };
  });
  return { role, text, tool_calls, createdAt: coerceDate(m.createdAt) };
}

/**
 * Read the SZ doc for a campaign. Throws if missing — callers should
 * ensure the doc exists (via `ensureSessionZeroCampaign`) before
 * calling. Returns the fields the route handler / UI loader need; the
 * full document is not re-validated here (see file-level note).
 */
export async function loadSessionZero(
  firestore: Firestore,
  campaignId: string,
): Promise<LoadedSessionZero> {
  const ref = firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.sessionZero)
    .doc(SESSION_ZERO_DOC_ID);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new Error(`loadSessionZero: no SZ doc at campaigns/${campaignId}/sessionZero/state`);
  }
  const data = snap.data() ?? {};
  const history = Array.isArray(data.conversation_history) ? data.conversation_history : [];
  // Sort by createdAt — `arrayUnion` doesn't preserve append order
  // when entries land out of step (the conductor's tool-call entries
  // are written DURING a run, while the route handler's user/conductor
  // framing entries are written AFTER the run completes). The
  // conductor's renderHistory consumes this array verbatim on the
  // next turn, so chronological order is load-bearing for context.
  const sorted = history.map(coerceMessage).sort((a, b) => {
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
  return {
    campaignId,
    phase: typeof data.phase === "string" ? data.phase : "in_progress",
    conversationHistory: sorted,
    hardRequirementsMet: (data.hard_requirements_met ?? {}) as Record<string, boolean>,
  };
}

/**
 * Append a turn boundary to `conversation_history`. The conductor's
 * tool-call entries are persisted by the tools themselves during the
 * run; this helper only records the human-side message and the
 * conductor's prose response surfacing the streamed text.
 *
 * Parity with `_history.ts`: the per-entry `createdAt` is a JS Date
 * (`arrayUnion` forbids FieldValue sentinels in array elements); the
 * doc-level `updatedAt` uses serverTimestamp.
 */
export async function appendConversationTurn(
  firestore: Firestore,
  campaignId: string,
  entries: ConductorMessage[],
): Promise<void> {
  if (entries.length === 0) return;
  const ref = firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.sessionZero)
    .doc(SESSION_ZERO_DOC_ID);
  await ref.set(
    {
      conversation_history: FieldValue.arrayUnion(...entries),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
