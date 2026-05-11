import type { AidmToolContext } from "@/lib/tools";
import { describe, expect, it, vi } from "vitest";

/**
 * Tests for the M4 sub 2 vector-retrieval runtime in search_memory.
 * Mirrors the fakeFirestore shape from registry.test.ts (so the
 * registry's authorizeCampaignAccess pass succeeds) plus a findNearest
 * extension on the semanticMemories subcollection.
 */

interface MemoryDoc {
  id: string;
  data: {
    content: string;
    fragment?: string | null;
    category: string;
    heat: number;
    turnNumber: number;
    _distance: number;
  };
}

function fakeFirestore(memoryDocs: MemoryDoc[]): AidmToolContext["firestore"] {
  const semanticMemoriesCollection = {
    findNearest: () => ({
      get: async () => ({
        docs: memoryDocs.map((m) => ({ id: m.id, data: () => m.data })),
      }),
    }),
    doc: () => ({
      set: async () => undefined,
    }),
  };

  const mkSubcol = (sub: string) => {
    if (sub === "semanticMemories") return semanticMemoriesCollection;
    const queryShape: Record<string, unknown> = {
      where: () => queryShape,
      orderBy: () => queryShape,
      limit: () => queryShape,
      get: async () => ({ empty: true, docs: [] }),
    };
    return { ...queryShape, doc: () => ({ collection: mkSubcol }) };
  };

  const campaignDocRef = {
    id: "c-1",
    get: async () => ({
      id: "c-1",
      exists: true,
      data: () => ({
        ownerUid: "u-1",
        deletedAt: null,
        name: "test",
        settings: {},
        phase: "playing",
        profileRefs: [],
        createdAt: new Date(),
      }),
    }),
    collection: (sub: string) => mkSubcol(sub),
  };

  return {
    collection: (name: string) => {
      if (name === "campaigns") {
        return { doc: () => campaignDocRef };
      }
      return { doc: () => ({ collection: mkSubcol }) };
    },
  } as unknown as AidmToolContext["firestore"];
}

function makeCtx(firestore: AidmToolContext["firestore"]): AidmToolContext {
  return { campaignId: "c-1", userId: "u-1", firestore };
}

async function freshTools() {
  vi.resetModules();
  vi.doMock("@/lib/embeddings", () => ({
    isEmbedderConfigured: () => true,
    embedText: async () => ({
      vector: [0.1, 0.2, 0.3],
      dimension: 3,
      model: "mock",
      tokens: null,
    }),
  }));
  return import("../../index");
}

describe("search_memory — vector retrieval (M4 sub 2)", () => {
  it("returns ranked memories with relevance + heat boost", async () => {
    const tools = await freshTools();
    const ctx = makeCtx(
      fakeFirestore([
        {
          id: "m1",
          data: {
            content: "Vicious knows Julia's hiding on Callisto.",
            fragment: "smoke + neon",
            category: "lore",
            heat: 90,
            turnNumber: 7,
            _distance: 0.2,
          },
        },
        {
          id: "m2",
          data: {
            content: "Faye owes the syndicate.",
            fragment: null,
            category: "relationship",
            heat: 60,
            turnNumber: 3,
            _distance: 0.4,
          },
        },
      ]),
    );
    const result = (await tools.invokeTool(
      "search_memory",
      { query: "Vicious motives", k: 5 },
      ctx,
    )) as { memories: Array<{ id: string; relevance: number; category: string }> };
    expect(result.memories).toHaveLength(2);
    expect(result.memories[0]?.id).toBe("m1");
    const second = result.memories[1];
    if (!second) throw new Error("expected two memories");
    expect(result.memories[0]?.relevance).toBeGreaterThan(second.relevance);
    vi.doUnmock("@/lib/embeddings");
  });

  it("filters by category when provided", async () => {
    const tools = await freshTools();
    const ctx = makeCtx(
      fakeFirestore([
        {
          id: "m1",
          data: { content: "lore fact", category: "lore", heat: 80, turnNumber: 1, _distance: 0.3 },
        },
        {
          id: "m2",
          data: {
            content: "relationship fact",
            category: "relationship",
            heat: 80,
            turnNumber: 1,
            _distance: 0.3,
          },
        },
      ]),
    );
    const result = (await tools.invokeTool(
      "search_memory",
      { query: "anything", categories: ["relationship"], k: 5 },
      ctx,
    )) as { memories: Array<{ id: string }> };
    expect(result.memories.map((m) => m.id)).toEqual(["m2"]);
    vi.doUnmock("@/lib/embeddings");
  });

  it("filters by min_heat", async () => {
    const tools = await freshTools();
    const ctx = makeCtx(
      fakeFirestore([
        {
          id: "cool",
          data: { content: "low", category: "lore", heat: 10, turnNumber: 1, _distance: 0.2 },
        },
        {
          id: "hot",
          data: { content: "high", category: "lore", heat: 80, turnNumber: 1, _distance: 0.3 },
        },
      ]),
    );
    const result = (await tools.invokeTool(
      "search_memory",
      { query: "x", min_heat: 50, k: 5 },
      ctx,
    )) as { memories: Array<{ id: string }> };
    expect(result.memories.map((m) => m.id)).toEqual(["hot"]);
    vi.doUnmock("@/lib/embeddings");
  });

  it("applies STATIC_BOOST to session_zero category", async () => {
    const tools = await freshTools();
    const ctx = makeCtx(
      fakeFirestore([
        {
          id: "sz",
          data: {
            content: "session zero fact",
            category: "session_zero",
            heat: 80,
            turnNumber: 0,
            _distance: 0.5,
          },
        },
        {
          id: "fact",
          data: {
            content: "regular fact",
            category: "fact",
            heat: 80,
            turnNumber: 1,
            _distance: 0.3,
          },
        },
      ]),
    );
    const result = (await tools.invokeTool("search_memory", { query: "x", k: 5 }, ctx)) as {
      memories: Array<{ id: string }>;
    };
    expect(result.memories[0]?.id).toBe("sz");
    vi.doUnmock("@/lib/embeddings");
  });

  it("merges across multi-query fan-out (dedup keeps smallest distance)", async () => {
    const tools = await freshTools();
    const ctx = makeCtx(
      fakeFirestore([
        {
          id: "m1",
          data: { content: "fact", category: "lore", heat: 80, turnNumber: 1, _distance: 0.2 },
        },
      ]),
    );
    const result = (await tools.invokeTool(
      "search_memory",
      { queries: ["q1", "q2", "q3"], k: 5 },
      ctx,
    )) as { memories: Array<{ id: string }> };
    expect(result.memories).toHaveLength(1);
    expect(result.memories[0]?.id).toBe("m1");
    vi.doUnmock("@/lib/embeddings");
  });

  it("returns empty when embedder is disabled", async () => {
    vi.resetModules();
    vi.doMock("@/lib/embeddings", () => ({
      isEmbedderConfigured: () => false,
      embedText: async () => {
        throw new Error("should not be called");
      },
    }));
    const tools = await import("../../index");
    const ctx = makeCtx(fakeFirestore([]));
    const result = (await tools.invokeTool("search_memory", { query: "x", k: 5 }, ctx)) as {
      memories: unknown[];
    };
    expect(result.memories).toEqual([]);
    vi.doUnmock("@/lib/embeddings");
  });

  it("returns empty when every query embed fails", async () => {
    vi.resetModules();
    vi.doMock("@/lib/embeddings", () => ({
      isEmbedderConfigured: () => true,
      embedText: async () => {
        throw new Error("rate limited");
      },
    }));
    const tools = await import("../../index");
    const ctx = makeCtx(fakeFirestore([]));
    const result = (await tools.invokeTool("search_memory", { query: "x", k: 5 }, ctx)) as {
      memories: unknown[];
    };
    expect(result.memories).toEqual([]);
    vi.doUnmock("@/lib/embeddings");
  });
});
