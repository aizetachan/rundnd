import { runMetaDirector } from "@/lib/agents/meta-director";
import type { AgentLogger } from "@/lib/agents/types";
import { defaultLogger } from "@/lib/agents/types";
import { CAMPAIGN_SUB, COL } from "@/lib/firestore";
import { anthropicFallbackConfig } from "@/lib/providers";
import type { AidmSpanHandle } from "@/lib/tools";
import { CampaignSettings } from "@/lib/types/campaign-settings";
import type { Firestore } from "firebase-admin/firestore";
import { resolveModelContext } from "./turn";

/**
 * Meta conversation workflow — Phase 5 of v3-audit closure.
 *
 * Runs when the player is in `/meta` mode. The route handler decides,
 * based on campaign.settings.meta_conversation.active + message prefix,
 * whether to dispatch here or to runTurn.
 *
 * Command semantics:
 *   - `/meta <feedback>`  → enter state (or continue existing), run
 *                           MetaDirector, append to history
 *   - `/resume [suffix]`  → exit state; if suffix, it's queued for the
 *                           next gameplay turn (the caller consumes it)
 *   - `/play`/`/back`/`/exit` → exit state, no further action
 *   - (non-command while active) → continue the dialectic
 *
 * Meta turns do NOT persist to the `turns` collection — turns/{turnId}
 * is reserved for gameplay exchanges. Meta history lives on
 * `campaigns/{id}.settings.meta_conversation.history`; this keeps
 * nextTurnNumber computation clean (max(turn_number) over turns
 * subcollection ignores meta-loop noise).
 *
 * Chronicler does NOT fire on meta turns. The meta loop is authorship-
 * calibration; nothing to catalog.
 */

export type MetaEventType =
  | { type: "entered"; message: string }
  | { type: "text"; delta: string }
  | { type: "suggested_override"; category: string; value: string }
  | { type: "exited"; pendingResumeSuffix?: string }
  | { type: "error"; message: string };

export interface MetaWorkflowInput {
  campaignId: string;
  userId: string;
  /** Raw message including any slash-prefix. */
  playerMessage: string;
}

export interface MetaWorkflowDeps {
  firestore: Firestore;
  trace?: AidmSpanHandle;
  logger?: AgentLogger;
  /** Inject mock MetaDirector in tests. */
  runMetaDirectorFn?: typeof runMetaDirector;
}

// Word-boundary lookahead — requires the command to be followed by whitespace
// or end-of-string. Without it `/metafoo` / `/playing` / `/resumestuff` would
// silently match as their respective commands and misinterpret the payload.
const SLASH_RE = /^\s*\/(meta|resume|play|back|exit)(?=\s|$)\s*/i;

/**
 * Classify the incoming message against meta-loop commands. Returns the
 * command (if any) + the stripped payload. Pure function; no side
 * effects.
 */
export function classifyMetaMessage(raw: string): {
  command: "meta" | "resume" | "play" | "back" | "exit" | null;
  payload: string;
} {
  const m = raw.match(SLASH_RE);
  if (!m) return { command: null, payload: raw.trim() };
  const command = m[1]?.toLowerCase() as "meta" | "resume" | "play" | "back" | "exit";
  const payload = raw.slice(m[0].length).trim();
  return { command, payload };
}

/**
 * Decide whether this message should enter the meta workflow. Called
 * from the route handler before it dispatches to runTurn vs runMeta.
 */
export function shouldDispatchMeta(
  raw: string,
  currentState: { active: boolean } | undefined,
): boolean {
  const { command } = classifyMetaMessage(raw);
  // Any meta-loop command OR any message while the loop is active.
  if (command) return true;
  if (currentState?.active) return true;
  return false;
}

async function loadMetaState(
  firestore: Firestore,
  campaignId: string,
  userId: string,
): Promise<{
  settings: Record<string, unknown>;
  meta: NonNullable<CampaignSettings["meta_conversation"]> | null;
  lastGameplayTurn: number;
}> {
  const snap = await firestore.collection(COL.campaigns).doc(campaignId).get();
  if (!snap.exists) throw new Error("Campaign not found");
  const data = snap.data();
  if (!data || data.ownerUid !== userId || data.deletedAt !== null) {
    throw new Error("Campaign not found");
  }
  const rawSettings = (data.settings ?? {}) as Record<string, unknown>;
  const parsed = CampaignSettings.safeParse(rawSettings);
  const meta = parsed.success ? (parsed.data.meta_conversation ?? null) : null;

  // nextGameplayTurn is informational — caller uses it when setting
  // `started_at_turn` on entry. Pull the highest turnNumber from the
  // turns subcollection.
  const latestSnap = await firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .collection(CAMPAIGN_SUB.turns)
    .orderBy("turnNumber", "desc")
    .limit(1)
    .get();
  const latestRow = latestSnap.docs[0]?.data();
  const lastGameplayTurn =
    typeof latestRow?.turnNumber === "number" ? latestRow.turnNumber : 0;

  return { settings: rawSettings, meta, lastGameplayTurn };
}

async function writeMetaState(
  firestore: Firestore,
  campaignId: string,
  settings: Record<string, unknown>,
  meta: NonNullable<CampaignSettings["meta_conversation"]> | null,
): Promise<void> {
  // If meta is null, drop the key entirely so parse stays clean; use
  // Reflect.deleteProperty per repo convention (Biome noDelete + TS strict).
  let newSettings: Record<string, unknown>;
  if (meta) {
    newSettings = { ...settings, meta_conversation: meta };
  } else {
    newSettings = { ...settings };
    Reflect.deleteProperty(newSettings, "meta_conversation");
  }
  await firestore
    .collection(COL.campaigns)
    .doc(campaignId)
    .set({ settings: newSettings }, { merge: true });
}

/**
 * Run one meta exchange. Async generator matches runTurn's shape so the
 * route handler can stream the response + a terminal event.
 */
export async function* runMeta(
  input: MetaWorkflowInput,
  deps: MetaWorkflowDeps,
): AsyncGenerator<MetaEventType, void, void> {
  const logger = deps.logger ?? defaultLogger;
  const firestore = deps.firestore;
  const metaDirectorFn = deps.runMetaDirectorFn ?? runMetaDirector;
  const { command, payload } = classifyMetaMessage(input.playerMessage);
  const logContext = { campaignId: input.campaignId, userId: input.userId };

  try {
    const state = await loadMetaState(firestore, input.campaignId, input.userId);

    // --- Exit-command short-circuit (/play, /back, /exit, /resume) ---
    if (command === "play" || command === "back" || command === "exit") {
      await writeMetaState(firestore, input.campaignId, state.settings, null);
      yield {
        type: "exited",
        pendingResumeSuffix: undefined,
      };
      return;
    }
    if (command === "resume") {
      const suffix = payload.length > 0 ? payload : undefined;
      await writeMetaState(firestore, input.campaignId, state.settings, null);
      yield { type: "exited", pendingResumeSuffix: suffix };
      return;
    }

    // --- /meta entry or continued meta reply ---
    // If the message is just `/meta` with no payload, we still enter the
    // state but there's nothing for the director to answer. Treat as a
    // greeting.
    const effectiveMessage =
      command === "meta" && payload.length === 0
        ? "(The player entered the meta conversation with no message.)"
        : command === "meta"
          ? payload
          : input.playerMessage;

    const isFreshEntry = !state.meta?.active;
    const priorHistory = state.meta?.history ?? [];

    if (isFreshEntry) {
      yield {
        type: "entered",
        message: "Stepping out of the scene for a moment — what's on your mind?",
      };
    }

    // Dispatch to MetaDirector. Uses the campaign's modelContext (same
    // provider dispatch as everywhere else).
    const settingsParse = CampaignSettings.safeParse(state.settings);
    const modelContext = settingsParse.success
      ? resolveModelContext(state.settings, logger)
      : anthropicFallbackConfig();

    const result = await metaDirectorFn(
      {
        playerMessage: effectiveMessage,
        history: priorHistory.map((h) => ({ role: h.role, text: h.text })),
        campaignSummary: "",
      },
      { trace: deps.trace, logger, modelContext },
    );

    yield { type: "text", delta: result.response };
    if (result.suggested_override) {
      yield {
        type: "suggested_override",
        category: result.suggested_override.category,
        value: result.suggested_override.value,
      };
    }

    // Update meta state with this exchange.
    const now = new Date().toISOString();
    const newMeta: NonNullable<CampaignSettings["meta_conversation"]> = {
      active: true,
      started_at_turn: state.meta?.started_at_turn ?? state.lastGameplayTurn,
      history: [
        ...priorHistory,
        { role: "player" as const, text: effectiveMessage, ts: now },
        { role: "director" as const, text: result.response, ts: now },
      ],
      pending_resume_suffix: state.meta?.pending_resume_suffix,
    };
    await writeMetaState(firestore, input.campaignId, state.settings, newMeta);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger("error", "runMeta: failed", {
      ...logContext,
      error: msg,
    });
    yield { type: "error", message: msg };
  }
}
