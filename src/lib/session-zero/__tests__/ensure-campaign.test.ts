import { describe, expect, it } from "vitest";
import { ensureSessionZeroCampaign } from "../ensure-campaign";

/**
 * Unit tests for ensureSessionZeroCampaign. Focus:
 *   - When the user has an in-flight SZ campaign + state doc, return its id (created=false)
 *   - When the user has no SZ campaign at all, create one (created=true) with a state doc
 *   - When the user has a finalized SZ campaign in their list, skip it and create a new one
 *
 * The function is plain Firestore wiring with no agent/LLM
 * dependencies, so we drive it with a small in-memory fake.
 */

interface CampaignRow {
  id: string;
  data: Record<string, unknown>;
  szDoc?: Record<string, unknown>;
}

interface FakeOpts {
  rows?: CampaignRow[];
  /** Capture the next id `add()` returns. Tests assert the new doc had this id. */
  newId?: string;
}

function makeFakeFirestore(opts: FakeOpts = {}) {
  const rows: CampaignRow[] = (opts.rows ?? []).map((r) => ({
    id: r.id,
    data: { ...r.data },
    szDoc: r.szDoc ? { ...r.szDoc } : undefined,
  }));
  const newId = opts.newId ?? "campaign-new";
  let addedId: string | null = null;

  function makeCampaignRef(id: string) {
    const row = rows.find((r) => r.id === id);
    return {
      id,
      set: async (data: Record<string, unknown>, _opts?: { merge?: boolean }) => {
        if (row) {
          row.data = { ...row.data, ...data };
        }
      },
      collection: (name: string) => {
        if (name !== "sessionZero") {
          throw new Error(`unexpected subcollection ${name}`);
        }
        return {
          doc: (docId: string) => {
            if (docId !== "state") throw new Error(`unexpected sz doc id ${docId}`);
            return {
              get: async () => ({
                exists: row?.szDoc !== undefined,
                data: () => row?.szDoc,
              }),
              set: async (data: Record<string, unknown>) => {
                if (row) row.szDoc = { ...data };
              },
            };
          },
        };
      },
    };
  }

  return {
    firestore: {
      collection: (col: string) => {
        if (col !== "campaigns") {
          throw new Error(`unexpected top-level collection: ${col}`);
        }
        return {
          where: (_field: string, _op: string, _val: unknown) => ({
            where: (_f2: string, _o2: string, _v2: unknown) => ({
              orderBy: (_field: string, _dir: string) => ({
                limit: (_n: number) => ({
                  get: async () => ({
                    docs: rows.map((r) => ({
                      id: r.id,
                      data: () => r.data,
                      ref: makeCampaignRef(r.id),
                    })),
                  }),
                }),
              }),
            }),
          }),
          doc: (id: string) => makeCampaignRef(id),
          add: async (data: Record<string, unknown>) => {
            addedId = newId;
            rows.unshift({ id: newId, data: { ...data } });
            return makeCampaignRef(newId);
          },
        };
      },
    } as unknown as Parameters<typeof ensureSessionZeroCampaign>[0],
    rows,
    getAddedId: () => addedId,
  };
}

describe("ensureSessionZeroCampaign", () => {
  it("creates a new campaign + SZ doc when user has no in-flight SZ", async () => {
    const fake = makeFakeFirestore({ rows: [], newId: "fresh-campaign" });
    const out = await ensureSessionZeroCampaign(fake.firestore, "u-1");
    expect(out).toEqual({ campaignId: "fresh-campaign", created: true });
    expect(fake.getAddedId()).toBe("fresh-campaign");
    const created = fake.rows.find((r) => r.id === "fresh-campaign");
    expect(created?.data.phase).toBe("session_zero");
    expect(created?.data.ownerUid).toBe("u-1");
    expect(created?.szDoc?.phase).toBe("in_progress");
    expect(created?.szDoc?.campaignId).toBe("fresh-campaign");
    expect(
      (created?.szDoc?.hard_requirements_met as Record<string, boolean>)?.has_profile_ref,
    ).toBe(false);
  });

  it("returns the existing in-flight SZ campaign without creating a new one", async () => {
    const fake = makeFakeFirestore({
      rows: [
        {
          id: "existing-sz",
          data: {
            ownerUid: "u-1",
            phase: "session_zero",
            deletedAt: null,
            createdAt: new Date(),
          },
          szDoc: { phase: "in_progress" },
        },
      ],
    });
    const out = await ensureSessionZeroCampaign(fake.firestore, "u-1");
    expect(out).toEqual({ campaignId: "existing-sz", created: false });
    expect(fake.getAddedId()).toBeNull();
  });

  it("skips a finalized SZ and creates a fresh one", async () => {
    const fake = makeFakeFirestore({
      rows: [
        {
          id: "finalized-sz",
          data: {
            ownerUid: "u-1",
            phase: "playing", // already cut over to gameplay
            deletedAt: null,
            createdAt: new Date(),
          },
          szDoc: { phase: "complete" },
        },
      ],
      newId: "fresh-campaign",
    });
    const out = await ensureSessionZeroCampaign(fake.firestore, "u-1");
    expect(out.created).toBe(true);
    expect(out.campaignId).toBe("fresh-campaign");
  });

  it("skips a SZ campaign whose state doc is already at ready_for_handoff", async () => {
    const fake = makeFakeFirestore({
      rows: [
        {
          id: "ready-sz",
          data: {
            ownerUid: "u-1",
            phase: "session_zero",
            deletedAt: null,
            createdAt: new Date(),
          },
          szDoc: { phase: "ready_for_handoff" },
        },
      ],
      newId: "fresh-campaign",
    });
    const out = await ensureSessionZeroCampaign(fake.firestore, "u-1");
    expect(out.created).toBe(true);
    expect(out.campaignId).toBe("fresh-campaign");
  });
});
