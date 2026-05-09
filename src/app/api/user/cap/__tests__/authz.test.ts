import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * /api/user/cap authz tests (M0.5 — Firebase Auth migration).
 *
 * The endpoint takes `{ capUsd }` in the body — deliberately no
 * userId. Session identity from Firebase's session cookie (resolved by
 * `getCurrentUser`) IS the authorization, so user A cannot set user B's
 * cap by crafting a body: there is no body field to spoof. These tests
 * lock that contract in.
 */

vi.mock("@/lib/auth", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("@/lib/budget", () => ({
  setUserDailyCap: vi.fn(async () => undefined),
}));

describe("/api/user/cap — authz", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s when the request is unauthenticated", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue(null);
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/user/cap", {
      method: "POST",
      body: JSON.stringify({ capUsd: 5 }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthenticated");
  });

  it("uses the session user.id — never a userId from the body", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue({
      id: "session-user-A",
      email: "a@example.com",
    });
    const budget = await import("@/lib/budget");
    const { POST } = await import("../route");
    // Try to set a cap while claiming (via body) a different userId.
    // The body schema strips it; the session identity wins.
    const req = new Request("http://localhost/api/user/cap", {
      method: "POST",
      body: JSON.stringify({ capUsd: 99, userId: "target-user-B" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(budget.setUserDailyCap).toHaveBeenCalledTimes(1);
    // Assert the identity passed to the budget writer is the SESSION
    // identity, not any spoofed userId from the body.
    expect(vi.mocked(budget.setUserDailyCap).mock.calls[0]?.[0]).toBe("session-user-A");
    expect(vi.mocked(budget.setUserDailyCap).mock.calls[0]?.[1]).toBe(99);
  });

  it("accepts null to clear the cap", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: null });
    const budget = await import("@/lib/budget");
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/user/cap", {
      method: "POST",
      body: JSON.stringify({ capUsd: null }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(budget.setUserDailyCap).mock.calls[0]?.[1]).toBeNull();
  });

  it("accepts 0 distinctly from null (zero-spend day)", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: null });
    const budget = await import("@/lib/budget");
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/user/cap", {
      method: "POST",
      body: JSON.stringify({ capUsd: 0 }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(vi.mocked(budget.setUserDailyCap).mock.calls[0]?.[1]).toBe(0);
  });

  it("400s on negative cap", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: null });
    const budget = await import("@/lib/budget");
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/user/cap", {
      method: "POST",
      body: JSON.stringify({ capUsd: -10 }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(budget.setUserDailyCap).not.toHaveBeenCalled();
  });

  it("400s on non-numeric cap", async () => {
    const { getCurrentUser } = await import("@/lib/auth");
    vi.mocked(getCurrentUser).mockResolvedValue({ id: "u1", email: null });
    const budget = await import("@/lib/budget");
    const { POST } = await import("../route");
    const req = new Request("http://localhost/api/user/cap", {
      method: "POST",
      body: JSON.stringify({ capUsd: "five" }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(budget.setUserDailyCap).not.toHaveBeenCalled();
  });
});
