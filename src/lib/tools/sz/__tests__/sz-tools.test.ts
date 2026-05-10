import { FieldValue } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import type { AidmToolContext } from "../../index";

/**
 * Per-tool unit tests for the five SessionZeroConductor tools.
 *
 * Coverage:
 *   - Zod input rejects malformed args
 *   - execute() issues the right Firestore actions on
 *     `campaigns/{id}/sessionZero/state`
 *   - hard_requirements_met flips correctly per commit_field call
 *   - finalize_session_zero gates on hard requirements + is idempotent
 *   - propose_canonicality_mode rejects a recommended mode not in options
 *
 * Like chronicler-tools.test.ts: dynamic-import the registry per test
 * (tests/setup.ts runs vi.resetModules in beforeEach), use a fake
 * Firestore that captures writes, no real DB.
 */

const CAMPAIGN = "22222222-2222-4222-9222-222222222222";

interface CapturedWrites {
  sets: Array<{ path: string; data: Record<string, unknown>; merge: boolean }>;
  transactionRuns: number;
}

interface FakeOpts {
  /**
   * Initial state of the SZ doc (at campaigns/{CAMPAIGN}/sessionZero/state).
   * When omitted, the doc starts empty (no `exists`).
   */
  szDoc?: Record<string, unknown>;
  /**
   * Whether the campaign doc itself exists. Default true (auth passes).
   */
  campaign?: { ownerUid?: string; deletedAt?: Date | null } | null;
}

async function freshRegistry() {
  return await import("../../index");
}

function makeCaptured(): CapturedWrites {
  return { sets: [], transactionRuns: 0 };
}

/**
 * Fake Firestore exposing two surfaces:
 *   - `campaigns/{CAMPAIGN}` for authorizeCampaignAccess
 *   - `campaigns/{CAMPAIGN}/sessionZero/state` for SZ tool reads/writes
 *
 * SZ doc state is mutable — set() inside a transaction or outside both
 * mutate the same in-memory `szData` so a subsequent tx.get() reads the
 * post-write state. Captures every set() into `captured.sets`.
 */
function makeFakeFirestore(
  captured: CapturedWrites,
  opts: FakeOpts = {},
): AidmToolContext["firestore"] {
  const campaignMissing = opts.campaign === null;
  const campaignData = campaignMissing
    ? undefined
    : {
        ownerUid: opts.campaign?.ownerUid ?? "u-1",
        deletedAt: opts.campaign?.deletedAt ?? null,
        name: "test",
        settings: {},
        phase: "session_zero",
        profileRefs: [],
        createdAt: new Date(),
      };

  // Mutable, shared SZ doc — applied set merges directly into this object
  // so tx.get() after a write returns the merged state.
  let szData: Record<string, unknown> | undefined =
    opts.szDoc !== undefined ? { ...opts.szDoc } : undefined;
  let szExists = opts.szDoc !== undefined;

  function applySet(data: Record<string, unknown>, merge: boolean): void {
    if (!merge || szData === undefined) {
      szData = { ...data };
      szExists = true;
      return;
    }
    // Shallow merge with dotted-key support — sufficient for the
    // commit_field paths (`character_draft.name`, etc.) without
    // pulling in a full deep-merge dependency.
    for (const [k, v] of Object.entries(data)) {
      if (k.includes(".")) {
        const parts = k.split(".");
        let cursor = szData as Record<string, unknown>;
        for (let i = 0; i < parts.length - 1; i++) {
          const seg = parts[i];
          if (!seg) continue;
          if (typeof cursor[seg] !== "object" || cursor[seg] === null) {
            cursor[seg] = {};
          }
          cursor = cursor[seg] as Record<string, unknown>;
        }
        const last = parts[parts.length - 1];
        if (last) cursor[last] = v;
      } else {
        (szData as Record<string, unknown>)[k] = v;
      }
    }
  }

  const szDocPath = `campaigns/${CAMPAIGN}/sessionZero/state`;
  const szDocRef = {
    id: "state",
    path: szDocPath,
    get: async () => ({
      id: "state",
      exists: szExists,
      data: () => szData,
    }),
    set: async (data: Record<string, unknown>, options?: { merge?: boolean }) => {
      const merge = options?.merge ?? false;
      captured.sets.push({ path: szDocPath, data, merge });
      applySet(data, merge);
    },
  };

  const szSubcollection = {
    doc: (id: string) => {
      if (id === "state") return szDocRef;
      throw new Error(`unexpected sz doc id: ${id}`);
    },
  };

  const campaignDocRef = {
    id: CAMPAIGN,
    path: `campaigns/${CAMPAIGN}`,
    get: async () => ({
      id: CAMPAIGN,
      exists: !campaignMissing,
      data: () => campaignData,
    }),
    collection: (sub: string) => {
      if (sub === "sessionZero") return szSubcollection;
      throw new Error(`unexpected subcollection: ${sub}`);
    },
  };

  async function runTransaction<T>(
    callback: (tx: {
      get: (ref: { get: () => Promise<unknown> }) => Promise<unknown>;
      set: (
        ref: { path: string },
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => void;
    }) => Promise<T>,
  ): Promise<T> {
    captured.transactionRuns += 1;
    const tx = {
      get: async (ref: { get: () => Promise<unknown> }) => ref.get(),
      set: (
        ref: { path: string },
        data: Record<string, unknown>,
        options?: { merge?: boolean },
      ) => {
        const merge = options?.merge ?? false;
        captured.sets.push({ path: ref.path, data, merge });
        if (ref.path === szDocPath) applySet(data, merge);
      },
    };
    return await callback(tx);
  }

  return {
    collection: (name: string) => {
      if (name === "campaigns") {
        return { doc: () => campaignDocRef };
      }
      throw new Error(`unexpected top-level collection: ${name}`);
    },
    runTransaction,
  } as unknown as AidmToolContext["firestore"];
}

function makeCtx(firestore: AidmToolContext["firestore"]): AidmToolContext {
  return {
    campaignId: CAMPAIGN,
    userId: "u-1",
    firestore,
  };
}

const ALL_REQS_FALSE = {
  has_profile_ref: false,
  has_canonicality_mode: false,
  has_character_name: false,
  has_character_concept: false,
  has_starting_situation: false,
};

const ALL_REQS_TRUE = {
  has_profile_ref: true,
  has_canonicality_mode: true,
  has_character_name: true,
  has_character_concept: true,
  has_starting_situation: true,
};

describe("SZ tools — propose_character_option", () => {
  it("appends a tool_call entry to conversation_history with options + rationale", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {});
    const out = await mod.invokeTool(
      "propose_character_option",
      {
        options: [
          {
            label: "Bounty Hunter",
            name: "Lyle Marrow",
            concept: "Ex-cop drifting after his old precinct burned out",
            power_tier: "T10",
            abilities_sketch: "Pistol, knife, contact network",
            appearance_sketch: "Tall, scarred jaw",
            personality_sketch: "Quiet, dry humor",
            backstory_sketch: "Lost a partner in the ISSP collapse",
          },
          {
            label: "Black-Market Doc",
            name: "Iris Vega",
            concept: "Med-tech surgeon trading favors for fuel",
            power_tier: "T10",
            abilities_sketch: "Field surgery, jet pilot",
            appearance_sketch: "Cropped hair, augment over left eye",
            personality_sketch: "Warm, cynical",
            backstory_sketch: "Disappeared after a botched military op",
          },
        ],
        rationale: "Two ways into a Bebop campaign — outer-system rogue vs. inner-system fixer.",
      },
      makeCtx(fs),
    );
    expect(out).toMatchObject({ ok: true, options_count: 2 });
    expect(captured.sets).toHaveLength(1);
    const set = captured.sets[0];
    if (!set) throw new Error("expected one set");
    expect(set.path).toBe(`campaigns/${CAMPAIGN}/sessionZero/state`);
    expect(set.merge).toBe(true);
    expect(set.data.conversation_history).toBeDefined();
  });

  it("arrayUnion entry carries role + tool_call shape (regression guard)", async () => {
    // Spy on FieldValue.arrayUnion so we can inspect the entry _history.ts
    // hands to Firestore. The sentinel itself is opaque; capturing the
    // call's argument is the only stable way to assert payload shape.
    const spy = vi.spyOn(FieldValue, "arrayUnion");
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {});
    await mod.invokeTool(
      "propose_character_option",
      {
        options: [
          {
            label: "A",
            name: "A",
            concept: "x",
            power_tier: "T10",
            abilities_sketch: "x",
            appearance_sketch: "x",
            personality_sketch: "x",
            backstory_sketch: "x",
          },
          {
            label: "B",
            name: "B",
            concept: "x",
            power_tier: "T10",
            abilities_sketch: "x",
            appearance_sketch: "x",
            personality_sketch: "x",
            backstory_sketch: "x",
          },
        ],
        rationale: "x",
      },
      makeCtx(fs),
    );
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = spy.mock.calls[0]?.[0] as {
      role: string;
      text: string;
      tool_calls: Array<{ name: string; args: unknown; result: unknown }>;
      createdAt: Date;
    };
    expect(entry.role).toBe("conductor");
    expect(entry.text).toBe("");
    expect(entry.createdAt).toBeInstanceOf(Date);
    expect(entry.tool_calls).toHaveLength(1);
    expect(entry.tool_calls[0]?.name).toBe("propose_character_option");
    expect(entry.tool_calls[0]?.result).toEqual({ ok: true, options_count: 2 });
    spy.mockRestore();
  });

  it("rejects fewer than 2 options (Zod)", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {});
    await expect(
      mod.invokeTool(
        "propose_character_option",
        {
          options: [
            {
              label: "Solo",
              name: "Solo",
              concept: "Only one",
              power_tier: "T10",
              abilities_sketch: "x",
              appearance_sketch: "x",
              personality_sketch: "x",
              backstory_sketch: "x",
            },
          ],
          rationale: "x",
        },
        makeCtx(fs),
      ),
    ).rejects.toThrow();
  });
});

describe("SZ tools — ask_clarifying_question", () => {
  it("appends a question entry; persists question text + topic", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {});
    const out = await mod.invokeTool(
      "ask_clarifying_question",
      {
        question: "Are you bringing the canonical Bebop crew, or do you want to replace them?",
        topic: "canonicality",
        field_target: "canonicality_mode",
      },
      makeCtx(fs),
    );
    expect(out).toMatchObject({ ok: true });
    expect(captured.sets).toHaveLength(1);
  });
});

describe("SZ tools — propose_canonicality_mode", () => {
  it("rejects a recommended mode that isn't in the options list", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {});
    await expect(
      mod.invokeTool(
        "propose_canonicality_mode",
        {
          // Schema requires min(2) options; pick two and recommend a third.
          options: [
            { mode: "full_cast", pitch: "x" },
            { mode: "replaced_protagonist", pitch: "x" },
          ],
          recommended: "inspired",
          rationale: "x",
        },
        makeCtx(fs),
      ),
    ).rejects.toThrow(/recommended/);
  });

  it("appends the proposal when recommended is valid", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {});
    const out = await mod.invokeTool(
      "propose_canonicality_mode",
      {
        options: [
          { mode: "full_cast", pitch: "Spike + Jet + Faye + Ed + Ein, you're a 6th." },
          { mode: "replaced_protagonist", pitch: "You ARE Spike. Crew + ship intact." },
          { mode: "inspired", pitch: "Same vibe, all-original cast." },
        ],
        recommended: "replaced_protagonist",
        rationale: "Most premise-respect for a Bebop pitch.",
      },
      makeCtx(fs),
    );
    expect(out).toMatchObject({ ok: true, recommended: "replaced_protagonist" });
    expect(captured.sets).toHaveLength(1);
  });
});

describe("SZ tools — commit_field", () => {
  it("commits character_name + flips has_character_name=true; other reqs untouched", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {
      szDoc: { hard_requirements_met: ALL_REQS_FALSE },
    });
    const out = (await mod.invokeTool(
      "commit_field",
      { field: "character_name", value: "Spike Spiegel" },
      makeCtx(fs),
    )) as { hard_requirements_met: typeof ALL_REQS_FALSE };
    expect(out.hard_requirements_met).toEqual({
      ...ALL_REQS_FALSE,
      has_character_name: true,
    });
    expect(captured.transactionRuns).toBe(1);
    const set = captured.sets.find((s) => s.path.endsWith("/sessionZero/state"));
    if (!set) throw new Error("expected SZ set");
    expect(set.data["character_draft.name"]).toBe("Spike Spiegel");
  });

  it("commit_field profile_refs writes top-level profile_refs and flips has_profile_ref", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {
      szDoc: { hard_requirements_met: ALL_REQS_FALSE },
    });
    const out = (await mod.invokeTool(
      "commit_field",
      { field: "profile_refs", value: ["cowboy_bebop"] },
      makeCtx(fs),
    )) as { hard_requirements_met: typeof ALL_REQS_FALSE };
    expect(out.hard_requirements_met.has_profile_ref).toBe(true);
    const set = captured.sets[0];
    if (!set) throw new Error("expected one set");
    expect(set.data.profile_refs).toEqual(["cowboy_bebop"]);
  });

  it("rejects empty string for character_name (per-field Zod inside execute)", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {
      szDoc: { hard_requirements_met: ALL_REQS_FALSE },
    });
    await expect(
      mod.invokeTool("commit_field", { field: "character_name", value: "" }, makeCtx(fs)),
    ).rejects.toThrow();
  });

  it("rejects malformed power_tier (per-field Zod inside execute)", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {
      szDoc: { hard_requirements_met: ALL_REQS_FALSE },
    });
    await expect(
      mod.invokeTool("commit_field", { field: "power_tier", value: "T11" }, makeCtx(fs)),
    ).rejects.toThrow();
  });

  it("throws when the SZ doc doesn't exist (entry-point handler must seed it first)", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {});
    await expect(
      mod.invokeTool(
        "commit_field",
        { field: "character_name", value: "Spike Spiegel" },
        makeCtx(fs),
      ),
    ).rejects.toThrow(/no SZ doc/);
  });

  it("preserves prior hard_requirements flags across commits", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {
      szDoc: {
        hard_requirements_met: { ...ALL_REQS_FALSE, has_profile_ref: true },
      },
    });
    const out = (await mod.invokeTool(
      "commit_field",
      { field: "character_name", value: "Spike Spiegel" },
      makeCtx(fs),
    )) as { hard_requirements_met: typeof ALL_REQS_FALSE };
    expect(out.hard_requirements_met).toEqual({
      ...ALL_REQS_FALSE,
      has_profile_ref: true,
      has_character_name: true,
    });
  });
});

describe("SZ tools — finalize_session_zero", () => {
  it("transitions phase to ready_for_handoff when all hard reqs are met", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {
      szDoc: {
        phase: "in_progress",
        hard_requirements_met: ALL_REQS_TRUE,
      },
    });
    const out = await mod.invokeTool(
      "finalize_session_zero",
      { rationale: "Spike + Bebop crew + Tharsis opening." },
      makeCtx(fs),
    );
    expect(out).toMatchObject({
      ok: true,
      phase: "ready_for_handoff",
      transitioned: true,
    });
    const set = captured.sets[0];
    if (!set) throw new Error("expected one set");
    expect(set.data.phase).toBe("ready_for_handoff");
    expect(set.data.handoff_started_at).toBeDefined();
  });

  it("throws when hard requirements are missing", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {
      szDoc: {
        phase: "in_progress",
        hard_requirements_met: { ...ALL_REQS_TRUE, has_character_name: false },
      },
    });
    await expect(
      mod.invokeTool("finalize_session_zero", { rationale: "x" }, makeCtx(fs)),
    ).rejects.toThrow(/has_character_name/);
  });

  it("is idempotent — second call when already finalized returns transitioned=false", async () => {
    const mod = await freshRegistry();
    const captured = makeCaptured();
    const fs = makeFakeFirestore(captured, {
      szDoc: {
        phase: "ready_for_handoff",
        hard_requirements_met: ALL_REQS_TRUE,
      },
    });
    const out = await mod.invokeTool("finalize_session_zero", { rationale: "retry" }, makeCtx(fs));
    expect(out).toMatchObject({
      ok: true,
      phase: "ready_for_handoff",
      transitioned: false,
    });
    // No write should have fired on the no-op path.
    expect(captured.sets).toHaveLength(0);
  });

  it("throws when the SZ doc doesn't exist", async () => {
    const mod = await freshRegistry();
    const fs = makeFakeFirestore(makeCaptured(), {});
    await expect(
      mod.invokeTool("finalize_session_zero", { rationale: "x" }, makeCtx(fs)),
    ).rejects.toThrow(/no SZ doc/);
  });
});
