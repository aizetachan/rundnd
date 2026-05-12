import { z } from "zod";
import { type AgentRunnerDeps, runStructuredAgent } from "./_runner";

/**
 * Compactor — fast-tier agent that produces Block 2 micro-summaries.
 *
 * When working memory exceeds its budget, the oldest exchanges are
 * evicted and Compactor distills them into a single CompactionEntry.
 * KA's Block 2 renders these as prose; the player never sees them.
 *
 * Runs on fast tier (Haiku / Flash-Lite / gpt-5-mini) — the
 * compression task doesn't need creative writing, just faithful
 * preservation of beats + emotional movement.
 */

export const CompactorInput = z.object({
  /** Turn-numbered exchanges to compress (oldest first). */
  exchanges: z
    .array(
      z.object({
        turn_number: z.number().int(),
        player_message: z.string(),
        narrative: z.string(),
        intent: z.string().optional(),
      }),
    )
    .min(1)
    .max(20),
  /** Source's natural tone hint (helps the summary read in-voice). */
  toneHint: z.string().optional(),
});
export type CompactorInput = z.input<typeof CompactorInput>;

export const CompactorOutput = z.object({
  /** 2-4 sentence summary covering the exchanges. */
  text: z.string().min(20),
  /** Inclusive turn range covered, derived from input. */
  turns_covered: z.tuple([z.number().int(), z.number().int()]),
});
export type CompactorOutput = z.infer<typeof CompactorOutput>;

const SYSTEM_PROMPT = `You are a compactor for a long-form fiction engine. You receive a window of past exchanges (player message + KA narrative + intent) and produce a compact summary that preserves: who did what, what changed, what emotional movement, what threads now matter.

Output JSON exactly matching this shape:
{ "text": "2-4 sentences capturing the window, in the source's voice if a tone hint is given", "turns_covered": [first_turn_number, last_turn_number] }

Rules:
- Stay terse. The reader is KA reading its own past — no exposition.
- Keep proper nouns (NPCs, locations, factions) verbatim.
- If the window opens a thread that's now active, name it.
- Don't invent: only summarize what's in the exchanges.
- No prose outside the JSON. No code fences.`;

function buildUserContent(input: z.output<typeof CompactorInput>): string {
  const parts: string[] = [];
  if (input.toneHint) {
    parts.push(`Tone hint: ${input.toneHint}`);
    parts.push("");
  }
  parts.push("Exchanges:");
  for (const e of input.exchanges) {
    parts.push(`Turn ${e.turn_number}${e.intent ? ` [${e.intent}]` : ""}`);
    parts.push(`  player: ${e.player_message.slice(0, 200)}`);
    parts.push(`  narrative: ${e.narrative.slice(0, 400)}`);
    parts.push("");
  }
  parts.push("Return the JSON now.");
  return parts.join("\n");
}

function fallbackOutput(input: z.output<typeof CompactorInput>): CompactorOutput {
  const first = input.exchanges[0]?.turn_number ?? 0;
  const last = input.exchanges[input.exchanges.length - 1]?.turn_number ?? first;
  return {
    text: `(compactor fallback — ${input.exchanges.length} exchanges between turns ${first} and ${last} not summarized; raw transcript still in episodic memory)`,
    turns_covered: [first, last],
  };
}

export async function runCompactor(
  input: CompactorInput,
  deps: AgentRunnerDeps = {},
): Promise<CompactorOutput> {
  const parsed = CompactorInput.parse(input);
  return runStructuredAgent(
    {
      agentName: "compactor",
      tier: "fast",
      systemPrompt: SYSTEM_PROMPT,
      promptId: "agents/compactor",
      userContent: buildUserContent(parsed),
      outputSchema: CompactorOutput,
      fallback: fallbackOutput(parsed),
      maxTokens: 2048,
    },
    deps,
  );
}

/**
 * Decision: should the compactor fire for a campaign at this turn?
 * Pure: returns true when working memory has exceeded the configured
 * size threshold and the oldest window can be evicted.
 *
 * Today's policy: every 5 turns past turn 10, compact the oldest 5
 * turns into one entry. Tuned conservatively; M7 retro will adjust
 * once we have long-horizon telemetry.
 */
export function shouldCompact(
  turnNumber: number,
  workingMemorySize: number,
  workingMemoryBudget = 10,
): boolean {
  if (workingMemorySize <= workingMemoryBudget) return false;
  // Fire only on every 5th turn beyond the budget so we don't keep
  // re-running for one-at-a-time evictions.
  return (turnNumber - workingMemoryBudget) % 5 === 0;
}
