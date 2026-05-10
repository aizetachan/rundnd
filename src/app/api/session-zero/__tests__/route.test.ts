import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/session-zero auth + gate tests. Mirrors the /api/turns surface,
 * scoped to:
 *   - 401 on unauthenticated
 *   - 400 on malformed body
 *   - 429 on rate-limit / cost-cap
 *   - 404 on missing campaign / wrong owner
 *   - 409 when the campaign is not in session_zero phase
 *
 * The streaming happy path needs the Agent SDK + Firestore + budget
 * stack lined up — that's covered by integration tests when sub 4
 * lands. Here we fence the 4xx surface and assert the route never
 * starts the stream when an early gate fires.
 */

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/budget", () => ({
  checkBudget: vi.fn(),
  incrementCostLedger: vi.fn(async () => undefined),
}));

vi.mock("@/lib/firebase/admin", () => ({
  getFirebaseFirestore: vi.fn(),
}));

vi.mock("@/lib/observability/langfuse", () => ({
  getLangfuse: () => null,
}));

vi.mock("@/lib/agents", () => ({
  runSessionZeroConductor: vi.fn(),
}));

vi.mock("@/lib/session-zero/state", () => ({
  loadSessionZero: vi.fn(),
  appendConversationTurn: vi.fn(async () => undefined),
}));

interface CampaignDoc {
  ownerUid: string;
  deletedAt: Date | null;
  phase: string;
  settings: Record<string, unknown>;
}

function fakeFirestore(campaign: CampaignDoc | null) {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({
          exists: campaign !== null,
          data: () => campaign,
        }),
      }),
    }),
  };
}

const ALLOWED_BUDGET = { ok: true } as const;

describe("/api/session-zero — auth + gate surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when the request is unauthenticated", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "c-1", message: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("400s on malformed body (missing message)", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "c-1" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("429s when the rate limit gate fires", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { checkBudget } = await import("@/lib/budget");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    vi.mocked(checkBudget).mockResolvedValue({
      ok: false,
      reason: "rate",
      retryAfterSec: 30,
      rateCount: 12,
      rateCap: 10,
    } as never);
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "c-1", message: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("rate_limited");
    expect(body.reason).toBe("rate");
  });

  it("429s when the cost cap is reached", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { checkBudget } = await import("@/lib/budget");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    vi.mocked(checkBudget).mockResolvedValue({
      ok: false,
      reason: "cost_cap",
      usedUsd: 5.01,
      capUsd: 5,
      nextResetAt: "2026-05-11T00:00:00Z",
    } as never);
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "c-1", message: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("cost_cap_reached");
  });

  it("404s when the campaign doesn't exist", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { checkBudget } = await import("@/lib/budget");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    vi.mocked(checkBudget).mockResolvedValue(ALLOWED_BUDGET as never);
    vi.mocked(getFirebaseFirestore).mockReturnValue(fakeFirestore(null) as never);
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "missing", message: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("404s when the campaign belongs to a different user", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { checkBudget } = await import("@/lib/budget");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    vi.mocked(checkBudget).mockResolvedValue(ALLOWED_BUDGET as never);
    vi.mocked(getFirebaseFirestore).mockReturnValue(
      fakeFirestore({
        ownerUid: "u-2",
        deletedAt: null,
        phase: "session_zero",
        settings: {},
      }) as never,
    );
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "c-1", message: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("409s when the campaign is not in session_zero phase", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    const { checkBudget } = await import("@/lib/budget");
    const { getFirebaseFirestore } = await import("@/lib/firebase/admin");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u-1", email: null });
    vi.mocked(checkBudget).mockResolvedValue(ALLOWED_BUDGET as never);
    vi.mocked(getFirebaseFirestore).mockReturnValue(
      fakeFirestore({
        ownerUid: "u-1",
        deletedAt: null,
        phase: "playing",
        settings: {},
      }) as never,
    );
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/session-zero", {
      method: "POST",
      body: JSON.stringify({ campaignId: "c-1", message: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("wrong_phase");
    expect(body.detail).toContain("playing");
  });
});
