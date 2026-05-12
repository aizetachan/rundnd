import { describe, expect, it } from "vitest";
import { renderProductionPrompt, runProductionAgent } from "../production";

describe("renderProductionPrompt", () => {
  it("renders scene_portrait with style first", () => {
    const out = renderProductionPrompt({
      kind: "scene_portrait",
      subjectName: "Bebop interior at dusk",
      subjectBrief: "Spike on the couch with a cigarette",
      visualStyleDescriptors: ["jazz-noir palette", "Watanabe framing"],
    });
    expect(out).toMatch(/Style: jazz-noir palette, Watanabe framing/);
    expect(out).toContain("scene portrait");
    expect(out).toContain("16:9");
  });

  it("renders npc_portrait with character medium", () => {
    const out = renderProductionPrompt({
      kind: "npc_portrait",
      subjectName: "Vicious",
      subjectBrief: "white-haired, syndicate-coded, katana",
      visualStyleDescriptors: ["high contrast"],
      aspectRatio: "3:2",
    });
    expect(out).toContain("character portrait");
    expect(out).toContain("Vicious");
  });
});

describe("runProductionAgent", () => {
  it("returns stub when no generate callback", async () => {
    const out = await runProductionAgent({
      kind: "scene_portrait",
      subjectName: "x",
      subjectBrief: "y",
      visualStyleDescriptors: ["z"],
    });
    expect(out.stubbed).toBe(true);
    expect(out.artifactUrl).toBe("");
    expect(out.dimensions).toBeNull();
    expect(out.promptUsed).toContain("Style: z");
  });

  it("forwards prompt to live generator + returns dimensions", async () => {
    let seenPrompt: string | undefined;
    const out = await runProductionAgent(
      {
        kind: "npc_portrait",
        subjectName: "Spike",
        subjectBrief: "laconic, gunslinger",
        visualStyleDescriptors: ["noir"],
      },
      {
        generate: async (prompt) => {
          seenPrompt = prompt;
          return {
            artifactUrl: "https://example.com/img.png",
            width: 1024,
            height: 768,
          };
        },
      },
    );
    expect(seenPrompt).toContain("Spike");
    expect(out.stubbed).toBe(false);
    expect(out.artifactUrl).toBe("https://example.com/img.png");
    expect(out.dimensions).toEqual({ width: 1024, height: 768 });
  });
});
