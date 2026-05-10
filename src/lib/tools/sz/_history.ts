import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Shared helper: append a conductor-side entry to
 * `conversation_history` on the SZ doc and bump `updatedAt`.
 *
 * Firestore forbids FieldValue sentinels inside array elements, so the
 * per-entry `createdAt` is a JS Date (matches the ConductorMessage
 * Zod schema's `z.date()`) while the doc-level `updatedAt` uses
 * serverTimestamp(). Concurrent calls for the same doc are safe —
 * `arrayUnion` is atomic per-element, and SZ turns serialize anyway
 * (the conductor finishes one tool before the next).
 *
 * Retry caveat: `arrayUnion` deduplicates by deep equality, but each
 * call here generates a fresh `new Date()`, so an SDK-level retry
 * (e.g. transient transport hiccup) will append a second copy of the
 * same proposal/question rather than collapsing it. Acceptable for
 * Wave A — the conductor's turn loop is serial and retries are rare;
 * a duplicate transcript entry is cosmetic. If sub 3's resume UX shows
 * the duplication noticeably, switch to a content-derived stable id.
 *
 * Used by: propose_character_option, ask_clarifying_question,
 * propose_canonicality_mode (and any future SZ-side tools that need to
 * thread their call through the transcript). `commit_field` does NOT
 * use this — its writes are field-level and are tracked separately so
 * the transcript stays readable.
 */
export async function appendConductorToolCall(opts: {
  firestore: Firestore;
  campaignId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  /**
   * Optional human-readable text to surface alongside the tool_call —
   * the conductor's narration for this tool invocation. The streamed
   * KA-side text is the primary surface; this is for cases where the
   * tool itself emits a question or proposal that the UI renders out
   * of the streaming flow.
   */
  text?: string;
}): Promise<void> {
  const ref = opts.firestore
    .collection(COL.campaigns)
    .doc(opts.campaignId)
    .collection(CAMPAIGN_SUB.sessionZero)
    .doc(SESSION_ZERO_DOC_ID);

  await ref.set(
    {
      conversation_history: FieldValue.arrayUnion({
        role: "conductor",
        text: opts.text ?? "",
        tool_calls: [
          {
            name: opts.toolName,
            args: opts.args,
            result: opts.result,
          },
        ],
        createdAt: new Date(),
      }),
      updatedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  );
}
