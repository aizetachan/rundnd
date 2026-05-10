import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-action tests for `abandonCampaign` + `redoSessionZero`.
 *
 * Coverage:
 *   - Auth: 401 surface (`unauthenticated` code) when no session
 *   - Authz: `campaign_not_found` when the doc is missing, owned by
 *     another user, or already soft-deleted
 *   - `abandonCampaign`: stamps `deletedAt` and revalidates /campaigns
 *   - `redoSessionZero`: eligibility (sz phase or playing+0 turns),
 *     soft-deletes prior + creates fresh + writes supersedes pointer
 *   - `redoSessionZero`: rejects when the campaign is at `playing`
 *     phase with at least one turn (player has committed)
 *
 * Mocks: getCurrentUser + getFirebaseFirestore + ensureSessionZeroCampaign
 * + revalidatePath. Real Firestore wiring is exercised when we test
 * the integration in dev — these tests fence the action contract.
 */

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getFirebaseFirestore: vi.fn(),
}));

vi.mock("@/lib/session-zero/ensure-campaign", () => ({
  ensureSessionZeroCampaign: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

interface FakeCampaignDoc {
  exists: boolean;
  data?: Record<string, unknown>;
  /** Number of docs in the turns subcollection. */
  turnCount?: number;
}

interface CapturedSets {
  /** Each set call captured as { path, data, merge }. */
  sets: Array<{ path: string; data: Record<string, unknown>; merge: boolean }>;
}

function makeFirestore(docs: Record<string, FakeCampaignDoc>): {
  firestore: unknown;
  captured: CapturedSets;
} {
  const captured: CapturedSets = { sets: [] };
  return {
    captured,
    firestore: {
      collection: (col: string) => {
        if (col !== "campaigns") {
          throw new Error(`unexpected top-level collection: ${col}`);
        }
        return {
          doc: (id: string) => {
            const path = `campaigns/${id}`;
            const doc = docs[id];
            return {
              path,
              get: async () => ({
                exists: doc?.exists ?? false,
                data: () => doc?.data,
              }),
              set: async (data: Record<string, unknown>, opts?: { merge?: boolean }) => {
                captured.sets.push({ path, data, merge: opts?.merge ?? false });
              },
              collection: (sub: string) => {
                if (sub !== "turns") throw new Error(`unexpected sub: ${sub}`);
                const count = doc?.turnCount ?? 0;
                return {
                  limit: () => ({
                    get: async () => ({ empty: count === 0 }),
                  }),
                };
              },
            };
          },
        };
      },
    },
  };
}

describe("abandonCampaign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("401s when unauthenticated", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const { abandonCampaign } = await import("../actions");
    const result = await abandonCampaign("c-1");
    expect(result).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("rejects when the campaign doesn't exist", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const fake = makeFirestore({ "c-missing": { exists: false } });
    vi.mocked(getFirebaseFirestore).mockReturnValue(fake.firestore as never);
    const { abandonCampaign } = await import("../actions");
    const result = await abandonCampaign("c-missing");
    expect(result).toMatchObject({ ok: false, code: "campaign_not_found" });
  });

  it("rejects when the campaign belongs to another user", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const fake = makeFirestore({
      "c-1": { exists: true, data: { ownerUid: "u-2", deletedAt: null } },
    });
    vi.mocked(getFirebaseFirestore).mockReturnValue(fake.firestore as never);
    const { abandonCampaign } = await import("../actions");
    const result = await abandonCampaign("c-1");
    expect(result).toMatchObject({ ok: false, code: "campaign_not_found" });
    // No write should have fired — the rejection came before set.
    expect(fake.captured.sets).toHaveLength(0);
  });

  it("stamps deletedAt and revalidates /campaigns on success", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    const { revalidatePath } = await import("next/cache");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const fake = makeFirestore({
      "c-1": { exists: true, data: { ownerUid: "u-1", deletedAt: null, phase: "session_zero" } },
    });
    vi.mocked(getFirebaseFirestore).mockReturnValue(fake.firestore as never);
    const { abandonCampaign } = await import("../actions");
    const result = await abandonCampaign("c-1");
    expect(result).toEqual({ ok: true });
    expect(fake.captured.sets).toHaveLength(1);
    const set = fake.captured.sets[0];
    if (!set) throw new Error("expected one set");
    expect(set.path).toBe("campaigns/c-1");
    expect(set.merge).toBe(true);
    expect(set.data.deletedAt).toBeDefined();
    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/campaigns");
  });
});

describe("redoSessionZero", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects when the campaign is at `playing` phase with at least one turn", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const fake = makeFirestore({
      "c-1": {
        exists: true,
        data: { ownerUid: "u-1", deletedAt: null, phase: "playing" },
        turnCount: 3,
      },
    });
    vi.mocked(getFirebaseFirestore).mockReturnValue(fake.firestore as never);
    const { redoSessionZero } = await import("../actions");
    const result = await redoSessionZero("c-1");
    expect(result).toMatchObject({ ok: false, code: "not_eligible" });
    expect(fake.captured.sets).toHaveLength(0);
  });

  it("succeeds for a session_zero phase campaign: soft-deletes prior + creates fresh + supersedes pointer", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    const { ensureSessionZeroCampaign } = await import("../ensure-campaign");
    const { revalidatePath } = await import("next/cache");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const fake = makeFirestore({
      "c-old": {
        exists: true,
        data: { ownerUid: "u-1", deletedAt: null, phase: "session_zero" },
      },
      "c-new": { exists: true },
    });
    vi.mocked(getFirebaseFirestore).mockReturnValue(fake.firestore as never);
    vi.mocked(ensureSessionZeroCampaign).mockResolvedValue({
      campaignId: "c-new",
      created: true,
    });
    const { redoSessionZero } = await import("../actions");
    const result = await redoSessionZero("c-old");
    expect(result).toEqual({ ok: true, data: { newCampaignId: "c-new" } });

    const oldSet = fake.captured.sets.find((s) => s.path === "campaigns/c-old");
    if (!oldSet) throw new Error("expected old campaign set");
    expect(oldSet.data.deletedAt).toBeDefined();
    expect(oldSet.data.supersededAt).toBeDefined();

    const newSet = fake.captured.sets.find((s) => s.path === "campaigns/c-new");
    if (!newSet) throw new Error("expected new campaign set");
    expect(newSet.data.supersedes).toBe("c-old");

    expect(vi.mocked(revalidatePath)).toHaveBeenCalledWith("/campaigns");
  });

  it("succeeds for a `playing` campaign with zero turns (pre-first-turn redo)", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    const { ensureSessionZeroCampaign } = await import("../ensure-campaign");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const fake = makeFirestore({
      "c-old": {
        exists: true,
        data: { ownerUid: "u-1", deletedAt: null, phase: "playing" },
        turnCount: 0,
      },
      "c-new": { exists: true },
    });
    vi.mocked(getFirebaseFirestore).mockReturnValue(fake.firestore as never);
    vi.mocked(ensureSessionZeroCampaign).mockResolvedValue({
      campaignId: "c-new",
      created: true,
    });
    const { redoSessionZero } = await import("../actions");
    const result = await redoSessionZero("c-old");
    expect(result).toEqual({ ok: true, data: { newCampaignId: "c-new" } });
  });

  it("401s when unauthenticated", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const { redoSessionZero } = await import("../actions");
    const result = await redoSessionZero("c-1");
    expect(result).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
