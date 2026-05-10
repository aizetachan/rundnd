import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anthropicFallbackConfig } from "@/lib/providers";
import jsYaml from "js-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * runHandoff orchestrator tests. Mocks the HandoffCompiler agent +
 * builds a fake Firestore that captures every set/add. Coverage:
 *   - Throws when SZ doc is missing or in the wrong phase
 *   - Throws on hybrid profile_refs (Wave B feature)
 *   - On success: writes OSP doc, transactional campaign update +
 *     character creation + SZ doc phase=complete
 *   - Fallback synthesis still completes the handoff (warnings_only
 *     phase still flips so the player isn't stuck on /sz)
 */

vi.mock("@/lib/agents/handoff-compiler", () => ({
  runHandoffCompiler: vi.fn(),
}));

interface CampaignRow {
  id: string;
  data: Record<string, unknown>;
  szDoc?: Record<string, unknown>;
}

interface CapturedWrites {
  ospAdds: Array<{ path: string; data: Record<string, unknown> }>;
  txSets: Array<{ path: string; data: Record<string, unknown>; merge: boolean }>;
}

function loadBebopProfile(): unknown {
  const raw = readFileSync(
    join(process.cwd(), "evals", "golden", "profiles", "cowboy_bebop.yaml"),
    "utf8",
  );
  return jsYaml.load(raw);
}

function makeFakeFirestore(opts: {
  campaign: CampaignRow;
  profileExists?: boolean;
  characterId?: string;
}) {
  const captured: CapturedWrites = { ospAdds: [], txSets: [] };
  const campaign = { ...opts.campaign };
  const profileExists = opts.profileExists ?? true;
  const characterId = opts.characterId ?? "char-fresh";

  function makeCampaignRef() {
    const path = `campaigns/${campaign.id}`;
    return {
      id: campaign.id,
      path,
      get: async () => ({
        id: campaign.id,
        exists: true,
        data: () => campaign.data,
      }),
      collection: (name: string) => {
        if (name === "sessionZero") {
          return {
            doc: (docId: string) => {
              if (docId !== "state") throw new Error(`unexpected sz doc id ${docId}`);
              return {
                path: `${path}/sessionZero/state`,
                get: async () => ({
                  id: "state",
                  exists: campaign.szDoc !== undefined,
                  data: () => campaign.szDoc,
                }),
                // The mid-phase flip to handoff_in_progress fires
                // outside the transaction; capture it as a regular set.
                set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
                  captured.txSets.push({
                    path: `${path}/sessionZero/state`,
                    data,
                    merge: options?.merge ?? false,
                  });
                  if (campaign.szDoc) {
                    campaign.szDoc = { ...campaign.szDoc, ...data };
                  }
                },
              };
            },
          };
        }
        if (name === "openingStatePackages") {
          return {
            add: async (data: Record<string, unknown>) => {
              const id = `osp-${captured.ospAdds.length + 1}`;
              captured.ospAdds.push({ path: `${path}/openingStatePackages/${id}`, data });
              return { id };
            },
          };
        }
        if (name === "characters") {
          return {
            doc: () => ({ path: `${path}/characters/${characterId}` }),
          };
        }
        throw new Error(`unexpected subcollection ${name}`);
      },
    };
  }

  return {
    captured,
    firestore: {
      collection: (col: string) => {
        if (col === "campaigns") return { doc: () => makeCampaignRef() };
        if (col === "profiles") {
          return {
            doc: (id: string) => ({
              get: async () => ({
                id,
                exists: profileExists,
                data: () => (profileExists ? { content: loadBebopProfile() } : undefined),
              }),
            }),
          };
        }
        throw new Error(`unexpected top-level collection ${col}`);
      },
      runTransaction: async <T>(
        cb: (tx: {
          set: (
            ref: { path: string },
            data: Record<string, unknown>,
            options?: { merge?: boolean },
          ) => void;
        }) => Promise<T>,
      ): Promise<T> => {
        const tx = {
          set: (
            ref: { path: string },
            data: Record<string, unknown>,
            options?: { merge?: boolean },
          ) => {
            captured.txSets.push({
              path: ref.path,
              data,
              merge: options?.merge ?? false,
            });
          },
        };
        return cb(tx);
      },
    },
  };
}

const READY_SZ_DOC = {
  campaignId: "c-1",
  ownerUid: "u-1",
  phase: "ready_for_handoff",
  profile_refs: ["cowboy-bebop"],
  canonicality_mode: "replaced_protagonist",
  character_draft: {
    name: "Spike Spiegel",
    concept: "Bounty hunter",
    power_tier: "T9",
    abilities: [{ name: "Jeet Kune Do", description: "Fluid striking", limitations: null }],
    appearance: "Tall, lean",
    personality: "Wry",
    backstory: "Ex-syndicate",
    voice_notes: "Resigned humor",
  },
  conversation_history: [],
  starting_location: "The Bebop",
  starting_situation: "Spike's waking up.",
  hard_requirements_met: {
    has_profile_ref: true,
    has_canonicality_mode: true,
    has_character_name: true,
    has_character_concept: true,
    has_starting_situation: true,
  },
  blocking_issues: [],
  rolling_summary: "",
  handoff_started_at: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

const STUB_PACKAGE = {
  package_metadata: {
    session_id: "c-1",
    campaign_id: "c-1",
    schema_version: "v4.0",
    created_at: new Date(),
    profile_id: "al_1",
    canonicality_mode: "replaced_protagonist" as const,
  },
  readiness: {
    handoff_status: "ready" as const,
    blocking_issues: [],
    warnings: [],
    missing_but_nonblocking: [],
  },
  player_character: {
    name: "Spike Spiegel",
    concept: "Bounty hunter",
    appearance: "Tall, lean",
    abilities: [],
    personality: "Wry",
    backstory: "Ex-syndicate",
    voice_notes: "Resigned humor",
  },
  opening_situation: {
    starting_location: "The Bebop",
    time_context: "Morning",
    immediate_situation: "Spike wakes up.",
    scene_objective: "Take the bounty",
    scene_question: "Will Spike commit?",
    expected_initial_motion: "Check the terminal",
    forbidden_opening_moves: [],
  },
  world_context: {
    geography: null,
    factions: [],
    political_climate: null,
    supernatural_rules: null,
  },
  opening_cast: [],
  canon_rules: {
    timeline_mode: "alternate" as const,
    divergence_notes: null,
    forbidden_contradictions: [],
  },
  director_inputs: {
    hooks: [],
    tone_anchors: [],
    pacing_cues: [],
    initial_dna: {} as never,
    initial_composition: {} as never,
  },
  animation_inputs: {
    visual_style_notes: null,
    character_pose_notes: null,
    environment_details: null,
  },
  hard_constraints: [],
  soft_targets: [],
  uncertainties: [],
  relationship_graph: [],
  contradictions_summary: [],
  orphan_facts: [],
};

describe("runHandoff orchestrator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws when the SZ doc is missing", async () => {
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: { id: "c-1", data: { ownerUid: "u-1" } },
    });
    await expect(
      runHandoff(
        { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
        { firestore: fake.firestore as never },
      ),
    ).rejects.toThrow(/no SZ doc/);
  });

  it("throws when the SZ doc is not at ready_for_handoff", async () => {
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: {
        id: "c-1",
        data: { ownerUid: "u-1" },
        szDoc: { ...READY_SZ_DOC, phase: "in_progress" },
      },
    });
    await expect(
      runHandoff(
        { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
        { firestore: fake.firestore as never },
      ),
    ).rejects.toThrow(/in_progress/);
  });

  it("throws when profile_refs has more than one entry (hybrid → Wave B)", async () => {
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: {
        id: "c-1",
        data: { ownerUid: "u-1" },
        szDoc: { ...READY_SZ_DOC, profile_refs: ["cowboy-bebop", "berserk"] },
      },
    });
    await expect(
      runHandoff(
        { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
        { firestore: fake.firestore as never },
      ),
    ).rejects.toThrow(/hybrid/);
  });

  it("throws when the profile doc doesn't exist", async () => {
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: { id: "c-1", data: { ownerUid: "u-1" }, szDoc: READY_SZ_DOC },
      profileExists: false,
    });
    await expect(
      runHandoff(
        { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
        { firestore: fake.firestore as never },
      ),
    ).rejects.toThrow(/profile not found/);
  });

  it("on success: persists OSP doc, writes campaign + character + flips phases", async () => {
    const { runHandoffCompiler } = await import("@/lib/agents/handoff-compiler");
    vi.mocked(runHandoffCompiler).mockResolvedValue({
      package: STUB_PACKAGE,
      fellBack: false,
    });
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: { id: "c-1", data: { ownerUid: "u-1" }, szDoc: READY_SZ_DOC },
    });
    const result = await runHandoff(
      { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
      { firestore: fake.firestore as never },
    );
    expect(result.redirectTo).toBe("/campaigns/c-1/play");
    expect(result.fellBack).toBe(false);

    // OSP doc persisted with content_hash + package payload.
    expect(fake.captured.ospAdds).toHaveLength(1);
    const osp = fake.captured.ospAdds[0];
    if (!osp) throw new Error("expected one OSP add");
    expect(osp.path).toMatch(/openingStatePackages\//);
    expect(osp.data.contentHash).toBeTypeOf("string");
    expect(osp.data.package).toBeDefined();

    // Transactional writes: campaign updates + character + SZ phase=complete.
    const campaignSet = fake.captured.txSets.find(
      (w) => w.path === "campaigns/c-1" && w.merge === true,
    );
    if (!campaignSet) throw new Error("expected campaign set");
    expect(campaignSet.data.phase).toBe("playing");
    expect(campaignSet.data.profileRefs).toEqual(["cowboy-bebop"]);
    expect(campaignSet.data.settings).toBeDefined();

    const charSet = fake.captured.txSets.find((w) => w.path.includes("/characters/"));
    if (!charSet) throw new Error("expected character set");
    expect(charSet.data.name).toBe("Spike Spiegel");

    // Two SZ writes: the pre-compile flip to handoff_in_progress and
    // the in-transaction flip to complete.
    const szSets = fake.captured.txSets.filter((w) => w.path.endsWith("/sessionZero/state"));
    expect(szSets.map((s) => s.data.phase)).toEqual(["handoff_in_progress", "complete"]);
  });

  it("on compiler exception: reverts SZ phase to ready_for_handoff so the player can retry", async () => {
    const { runHandoffCompiler } = await import("@/lib/agents/handoff-compiler");
    vi.mocked(runHandoffCompiler).mockRejectedValue(new Error("network blew up"));
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: { id: "c-1", data: { ownerUid: "u-1" }, szDoc: READY_SZ_DOC },
    });
    await expect(
      runHandoff(
        { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
        { firestore: fake.firestore as never },
      ),
    ).rejects.toThrow(/network blew up/);

    // Two phase writes: handoff_in_progress (start) → ready_for_handoff (revert).
    const szSets = fake.captured.txSets.filter((w) => w.path.endsWith("/sessionZero/state"));
    expect(szSets.map((s) => s.data.phase)).toEqual(["handoff_in_progress", "ready_for_handoff"]);
    // No campaign or character writes: the transactional block never ran.
    expect(fake.captured.txSets.find((w) => w.path === "campaigns/c-1")).toBeUndefined();
    expect(fake.captured.txSets.find((w) => w.path.includes("/characters/"))).toBeUndefined();
  });

  it("on fallback synthesis: still flips phases (warnings_only is not blocking)", async () => {
    const { runHandoffCompiler } = await import("@/lib/agents/handoff-compiler");
    vi.mocked(runHandoffCompiler).mockResolvedValue({
      package: {
        ...STUB_PACKAGE,
        readiness: {
          handoff_status: "warnings_only",
          blocking_issues: [],
          warnings: ["LLM synthesis fell back"],
          missing_but_nonblocking: [],
        },
      },
      fellBack: true,
    });
    const { runHandoff } = await import("../run-handoff");
    const fake = makeFakeFirestore({
      campaign: { id: "c-1", data: { ownerUid: "u-1" }, szDoc: READY_SZ_DOC },
    });
    const result = await runHandoff(
      { campaignId: "c-1", userId: "u-1", modelContext: anthropicFallbackConfig() },
      { firestore: fake.firestore as never },
    );
    expect(result.fellBack).toBe(true);
    expect(result.redirectTo).toBe("/campaigns/c-1/play");
    // Phase still flips through handoff_in_progress → complete — the
    // player lands on /play.
    const szSets = fake.captured.txSets.filter((w) => w.path.endsWith("/sessionZero/state"));
    expect(szSets.map((s) => s.data.phase)).toContain("complete");
  });
});
