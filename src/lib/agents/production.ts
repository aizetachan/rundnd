import { z } from "zod";

/**
 * ProductionAgent (M8) — scene + NPC + location portrait generation.
 *
 * This module ships the agent INTERFACE only. Live image API
 * integration (Gemini Imagen / OpenAI Images / Stability / etc.)
 * requires per-deploy API keys + storage wiring (Firebase Storage)
 * that aren't configured here. The shape below is what live calls
 * will fulfill; `runProductionAgent` returns a stub artifact today
 * so downstream code can wire against the interface.
 *
 * Image style targets the Profile.visual_style descriptors — the
 * generator's prompt rolls the produced descriptors through so
 * outputs stay in-IP-voice.
 */

export const ProductionTaskKind = z.enum(["scene_portrait", "npc_portrait", "location_portrait"]);
export type ProductionTaskKind = z.infer<typeof ProductionTaskKind>;

export const ProductionInput = z.object({
  kind: ProductionTaskKind,
  subjectName: z.string().min(1),
  /** Short verbal description of what's in frame. */
  subjectBrief: z.string().min(1),
  /** Visual-style descriptors from the campaign's active profile —
   *  e.g. "smoke-gold lighting, Watanabe framing, jazz-noir palette". */
  visualStyleDescriptors: z.array(z.string()).min(1),
  /** Aspect ratio hint. The image API may snap to its supported set. */
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "3:2"]).default("16:9"),
});
export type ProductionInput = z.input<typeof ProductionInput>;

export const ProductionOutput = z.object({
  /** Storage path / URL the artifact landed at. Empty when stubbed. */
  artifactUrl: z.string(),
  /** Width / height of the generated image. Null when stubbed. */
  dimensions: z.object({ width: z.number().int(), height: z.number().int() }).nullable(),
  /** The fully-rendered prompt the agent submitted, kept for audit. */
  promptUsed: z.string(),
  /** True when the live image API wasn't configured and we returned
   *  a placeholder artifact. */
  stubbed: z.boolean(),
});
export type ProductionOutput = z.infer<typeof ProductionOutput>;

/**
 * Compose the prompt the image model receives. Style descriptors
 * come first (so the model anchors on style); subject brief follows.
 * Aspect ratio + medium directive close it out.
 */
export function renderProductionPrompt(rawInput: ProductionInput): string {
  const input = ProductionInput.parse(rawInput);
  const styleLine = input.visualStyleDescriptors.join(", ");
  const mediumLine =
    input.kind === "scene_portrait"
      ? "wide cinematic frame, painterly digital art"
      : input.kind === "npc_portrait"
        ? "character portrait, 3/4 angle, painterly digital art"
        : "establishing shot of a location, painterly digital art";
  return [
    `Style: ${styleLine}`,
    `Subject (${input.kind.replace(/_/g, " ")}): ${input.subjectName} — ${input.subjectBrief}`,
    `Medium: ${mediumLine}`,
    `Aspect ratio: ${input.aspectRatio}`,
  ].join("\n");
}

export interface ProductionAgentDeps {
  /**
   * Inject a live image-generation callback. When omitted, the
   * function returns a stub artifact (M8 sub 1 default — keeps the
   * surface usable without live API config).
   */
  generate?: (
    prompt: string,
    input: ProductionInput,
  ) => Promise<{
    artifactUrl: string;
    width: number;
    height: number;
  }>;
}

/**
 * Run the ProductionAgent. Without a `generate` callback, returns a
 * stubbed output that downstream code can still persist + render —
 * the artifactUrl points to a placeholder, and `stubbed: true`
 * surfaces the gap to the UI.
 */
export async function runProductionAgent(
  rawInput: ProductionInput,
  deps: ProductionAgentDeps = {},
): Promise<ProductionOutput> {
  const input = ProductionInput.parse(rawInput);
  const prompt = renderProductionPrompt(input);
  if (!deps.generate) {
    return {
      artifactUrl: "",
      dimensions: null,
      promptUsed: prompt,
      stubbed: true,
    };
  }
  const out = await deps.generate(prompt, input);
  return {
    artifactUrl: out.artifactUrl,
    dimensions: { width: out.width, height: out.height },
    promptUsed: prompt,
    stubbed: false,
  };
}
