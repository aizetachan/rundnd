import { describe, expect, it } from "vitest";
import type { AidmToolContext } from "../index";
import { LAYER_TO_MCP_ID, buildMcpServers, buildSessionZeroMcpServers } from "../mcp-servers";

function makeCtx(): AidmToolContext {
  return {
    campaignId: "c-1",
    userId: "u-1",
  };
}

describe("buildMcpServers", () => {
  it("returns exactly eight KA-side servers, keyed by aidm-<layer> (excludes session_zero)", () => {
    const servers = buildMcpServers(makeCtx());
    expect(Object.keys(servers).sort()).toEqual(
      [
        "aidm-ambient",
        "aidm-working",
        "aidm-episodic",
        "aidm-semantic",
        "aidm-voice",
        "aidm-arc",
        "aidm-critical",
        "aidm-entities",
      ].sort(),
    );
  });

  it("LAYER_TO_MCP_ID exposes every layer → id mapping (incl. session_zero)", () => {
    expect(Object.keys(LAYER_TO_MCP_ID).sort()).toEqual(
      [
        "ambient",
        "working",
        "episodic",
        "semantic",
        "voice",
        "arc",
        "critical",
        "entities",
        "session_zero",
      ].sort(),
    );
  });

  it("aidm-ambient and aidm-working are empty but present (§9.0 ambient/working manifest via blocks)", () => {
    const servers = buildMcpServers(makeCtx());
    expect(servers["aidm-ambient"]).toBeDefined();
    expect(servers["aidm-working"]).toBeDefined();
  });

  it("each server has the expected MCP config shape", () => {
    const servers = buildMcpServers(makeCtx());
    for (const [id, cfg] of Object.entries(servers)) {
      expect(cfg.type).toBe("sdk");
      expect(cfg.name).toBe(id);
      expect(cfg.instance).toBeDefined();
    }
  });

  it("KA's mcp servers do NOT include the SessionZeroConductor surface (aidm-session-zero)", () => {
    const servers = buildMcpServers(makeCtx());
    expect(servers["aidm-session-zero"]).toBeUndefined();
  });
});

describe("buildSessionZeroMcpServers", () => {
  it("returns exactly one server: aidm-session-zero", () => {
    const servers = buildSessionZeroMcpServers(makeCtx());
    expect(Object.keys(servers)).toEqual(["aidm-session-zero"]);
  });

  it("the aidm-session-zero server is well-formed", () => {
    const servers = buildSessionZeroMcpServers(makeCtx());
    const cfg = servers["aidm-session-zero"];
    expect(cfg).toBeDefined();
    expect(cfg?.type).toBe("sdk");
    expect(cfg?.name).toBe("aidm-session-zero");
    expect(cfg?.instance).toBeDefined();
  });

  it("does NOT mount any of KA's cognitive layer servers", () => {
    const servers = buildSessionZeroMcpServers(makeCtx());
    expect(servers["aidm-episodic"]).toBeUndefined();
    expect(servers["aidm-semantic"]).toBeUndefined();
    expect(servers["aidm-entities"]).toBeUndefined();
  });
});
