import { createHash } from "node:crypto";
import {
  projectSynthesizedProfile,
  runActiveIPSynthesizer,
} from "@/lib/agents/active-ip-synthesizer";
import { runHandoffCompiler } from "@/lib/agents/handoff-compiler";
import { CAMPAIGN_SUB, COL, SESSION_ZERO_DOC_ID } from "@/lib/firestore";
import type { CampaignProviderConfig } from "@/lib/providers";
import type { AidmSpanHandle } from "@/lib/tools";
import type { OpeningStatePackage } from "@/lib/types/opening-state-package";
import { Profile } from "@/lib/types/profile";
import { SessionZeroState } from "@/lib/types/session-zero";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

/**
 * Orchestrates the post-conductor handoff:
 *   1. Loads the SZ doc (must be at phase=ready_for_handoff).
 *   2. Flips SZ phase to `handoff_in_progress`. Concurrent finalize
 *      hits short-circuit on the phase guard at step 1.
 *   3. Loads the single profile from profile_refs[0]. Hybrids land in
 *      Wave B; this throws on multiple refs to fail loud rather than
 *      silently take the first.
 *   4. Calls HandoffCompiler — LLM synthesis + deterministic merge.
 *   5. Persists a versioned `openingStatePackages` doc with content_hash
 *      so a redo can detect duplicate compilations.
 *   6. In a single transaction, writes the campaign settings (world
 *      state, active_dna, active_composition, name), creates the
 *      Character row, flips campaign.phase to "playing" and SZ doc
 *      phase to "complete".
 *
 * Failure handling: a fallback synthesis (LLM exhausted retries) lands
 * with `readiness.handoff_status = "warnings_only"` and the package
 * persists. The orchestrator still flips phases — better to land the
 * player on /play with a thin opening they can /meta about than leave
 * them stuck on /sz indefinitely. A blocked status would revert to
 * `in_progress` (sub 5 / Wave B); not implemented here.
 *
 * Cancellation: `runHandoff` does NOT take an `AbortSignal` by design.
 * The route handler's `req.signal` aborts the conductor's stream; the
 * handoff runs after the stream completes and continues server-side
 * even if the player closes the tab. Partial state is impossible
 * thanks to step 6's transaction; on next /sz visit the SZ phase
 * reads `complete` and the player lands on /play. Worst case: we
 * billed the LLM call without a UI update — acceptable.
 */

export interface RunHandoffInput {
  campaignId: string;
  userId: string;
  modelContext: CampaignProviderConfig;
}

export interface RunHandoffDeps {
  firestore: Firestore;
  trace?: AidmSpanHandle;
}

export interface RunHandoffResult {
  packageId: string;
  packageContentHash: string;
  redirectTo: string;
  fellBack: boolean;
}

function hashPackage(pkg: OpeningStatePackage): string {
  // Stable JSON.stringify isn't built-in; ordered fields are good
  // enough for our redo-dedup. The created_at field varies on every
  // run so we exclude it from the hash.
  const { created_at, ...meta } = pkg.package_metadata;
  void created_at;
  const stable = { ...pkg, package_metadata: meta };
  return createHash("sha256").update(JSON.stringify(stable), "utf8").digest("hex");
}

function deriveCampaignName(pkg: OpeningStatePackage): string {
  const profileTitle = pkg.package_metadata.profile_id;
  const protagonist = pkg.player_character.name;
  if (profileTitle && protagonist) return `${profileTitle} — ${protagonist}`;
  return profileTitle || protagonist || "(untitled campaign)";
}

export async function runHandoff(
  input: RunHandoffInput,
  deps: RunHandoffDeps,
): Promise<RunHandoffResult> {
  const { firestore } = deps;

  // 1. Load SZ state. Validate via the type-system — Firestore
  // Timestamps don't round-trip through z.date(), so we coerce dates
  // before parse. (Same pattern as state.ts; the parsed shape is what
  // the conductor's input expects.)
  const szRef = firestore
    .collection(COL.campaigns)
    .doc(input.campaignId)
    .collection(CAMPAIGN_SUB.sessionZero)
    .doc(SESSION_ZERO_DOC_ID);
  const szSnap = await szRef.get();
  if (!szSnap.exists) {
    throw new Error(`runHandoff: no SZ doc for campaign ${input.campaignId}`);
  }
  const szRaw = szSnap.data() ?? {};
  if (szRaw.phase !== "ready_for_handoff") {
    throw new Error(
      `runHandoff: SZ phase is "${szRaw.phase}", expected "ready_for_handoff" — caller should gate.`,
    );
  }
  const szState = SessionZeroState.parse({
    ...szRaw,
    conversation_history: (szRaw.conversation_history ?? []).map((m: Record<string, unknown>) => ({
      ...m,
      createdAt: coerceDate(m.createdAt),
    })),
    handoff_started_at: coerceDate(szRaw.handoff_started_at),
    createdAt: coerceDate(szRaw.createdAt) ?? new Date(0),
    updatedAt: coerceDate(szRaw.updatedAt) ?? new Date(0),
  });

  // 2. Flip phase to `handoff_in_progress`. Concurrent finalize+handoff
  // hits short-circuit at step 1's phase guard. Sub 5's resume flow
  // distinguishes a quiesced doc (`ready_for_handoff` — handoff never
  // ran) from one mid-compile (`handoff_in_progress` — recoverable
  // by re-running) by reading this phase.
  //
  // The rest of this function runs inside a try/catch so any failure
  // reverts phase back to `ready_for_handoff` — leaving the doc in
  // `handoff_in_progress` would brick the player (the route handler's
  // pre-stream guard only triggers handoff on `ready_for_handoff`, so
  // a stuck doc would never retry).
  await szRef.set(
    { phase: "handoff_in_progress", updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );

  try {
    return await compileAndPersist({ firestore, szRef, szState, input, deps });
  } catch (err) {
    await szRef
      .set({ phase: "ready_for_handoff", updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      .catch(() => {
        /* best-effort revert; if Firestore is down we re-throw the
         * original error which is more actionable than a write failure. */
      });
    throw err;
  }
}

/**
 * The compile + persist phases of the handoff, factored so the parent
 * function can wrap them in a try/catch that reverts SZ phase on
 * failure. Not a public surface — call sites use `runHandoff`.
 */
async function compileAndPersist(args: {
  firestore: Firestore;
  szRef: FirebaseFirestore.DocumentReference;
  szState: SessionZeroState;
  input: RunHandoffInput;
  deps: RunHandoffDeps;
}): Promise<RunHandoffResult> {
  const { firestore, szRef, szState, input, deps } = args;

  // 3. Load the profile(s). Single = pass straight to HandoffCompiler;
  //    multiple = run the active-IP synthesizer first, then pass the
  //    synthesized profile to HandoffCompiler. The HandoffCompiler
  //    itself remains single-profile-only — synthesis happens before.
  if (szState.profile_refs.length === 0) {
    throw new Error("runHandoff: SZ has no profile_refs — finalize gate should have caught this");
  }
  const sourceProfiles: Profile[] = [];
  for (const ref of szState.profile_refs) {
    const snap = await firestore.collection(COL.profiles).doc(ref).get();
    if (!snap.exists) {
      throw new Error(`runHandoff: profile not found at profiles/${ref}`);
    }
    sourceProfiles.push(Profile.parse(snap.data()?.content));
  }

  let profile: Profile;
  let hybridSynthesisNotes: string | null = null;
  if (sourceProfiles.length === 1) {
    profile = sourceProfiles[0] as Profile;
  } else {
    // Multi-profile hybrid. The conductor's last "starting_situation"
    // captures the player's blend intent; fallback to a generic
    // synthesizer prompt when unset.
    const intent =
      szState.starting_situation ??
      `${sourceProfiles.map((p) => p.title).join(" + ")} as a coherent campaign`;
    const synthResult = await runActiveIPSynthesizer(
      {
        sourceProfiles,
        intent,
        modelContext: input.modelContext,
      },
      { trace: deps.trace },
    );
    const hybridId = `hybrid_${createHash("sha1").update(szState.profile_refs.join("|")).digest("hex").slice(0, 12)}`;
    profile = projectSynthesizedProfile(synthResult.synthesis, sourceProfiles, hybridId);
    hybridSynthesisNotes = synthResult.fellBack
      ? "synthesis fell back to placeholder; arc planning leans on first source"
      : synthResult.synthesis.hybrid_synthesis_notes;
  }

  // 4. Compile.
  const compiled = await runHandoffCompiler(
    {
      campaignId: input.campaignId,
      szState,
      profile,
    },
    {
      modelContext: input.modelContext,
      trace: deps.trace,
      logContext: { campaignId: input.campaignId, userId: input.userId },
    },
  );

  const pkg = compiled.package;
  const contentHash = hashPackage(pkg);

  // 5. Persist the versioned OSP doc. content_hash is deterministic for
  // dedup if a sub-5 redo runs the same SZ through twice. We don't use
  // that in this commit but the field's there for the future.
  const ospCol = firestore
    .collection(COL.campaigns)
    .doc(input.campaignId)
    .collection(CAMPAIGN_SUB.openingStatePackages);
  const ospAdded = await ospCol.add({
    campaignId: input.campaignId,
    contentHash,
    supersedes: null,
    package: pkg,
    fellBack: compiled.fellBack,
    createdAt: FieldValue.serverTimestamp(),
  });

  // 6. Transactional writeback. Either every campaign-level mutation
  // lands together with the SZ doc transition, or nothing does. The
  // alternative (sequential writes) leaves room for half-cutover state
  // — campaign at phase=playing but no Character row, or Character
  // row written but settings.world_state still null.
  const campaignRef = firestore.collection(COL.campaigns).doc(input.campaignId);
  const characterRef = campaignRef.collection(CAMPAIGN_SUB.characters).doc();

  const newName = deriveCampaignName(pkg);
  const characterDoc = {
    campaignId: input.campaignId,
    name: pkg.player_character.name,
    concept: pkg.player_character.concept,
    powerTier: szState.character_draft.power_tier ?? "T10",
    sheet: {
      available: true,
      name: pkg.player_character.name,
      concept: pkg.player_character.concept,
      power_tier: szState.character_draft.power_tier ?? "T10",
      stats: null,
      abilities: pkg.player_character.abilities.map((a) => ({
        name: a.name,
        description: a.description,
        limitations: a.limitations ?? null,
      })),
      inventory: [],
      stat_mapping: null,
      current_state: { hp: 30, status_effects: [] },
    },
    appearance: pkg.player_character.appearance,
    personality: pkg.player_character.personality,
    backstory: pkg.player_character.backstory,
    voice_notes: pkg.player_character.voice_notes,
    createdAt: FieldValue.serverTimestamp(),
  };

  const campaignSettingsPatch = {
    active_dna: pkg.director_inputs.initial_dna,
    active_composition: pkg.director_inputs.initial_composition,
    world_state: {
      location: pkg.opening_situation.starting_location,
      situation: pkg.opening_situation.immediate_situation,
      time_context: pkg.opening_situation.time_context,
      arc_phase: "setup",
      tension_level: 0.2,
      present_npcs: pkg.opening_cast.map((c) => c.name),
    },
    canon_rules: pkg.canon_rules.forbidden_contradictions,
    // Hybrid synthesis audit trail — Director can re-read this on arc
    // transitions to remember which source dominates which axis.
    // Null on single-profile campaigns.
    hybrid_synthesis_notes: hybridSynthesisNotes,
  };

  await firestore.runTransaction(async (tx) => {
    tx.set(
      campaignRef,
      {
        name: newName,
        phase: "playing",
        profileRefs: szState.profile_refs,
        settings: campaignSettingsPatch,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
    tx.set(characterRef, characterDoc);
    tx.set(
      szRef,
      {
        phase: "complete",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  });

  return {
    packageId: ospAdded.id,
    packageContentHash: contentHash,
    redirectTo: `/campaigns/${input.campaignId}/play`,
    fellBack: compiled.fellBack,
  };
}

function coerceDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (v && typeof (v as { toDate?: () => Date }).toDate === "function") {
    return (v as { toDate: () => Date }).toDate();
  }
  return null;
}
