import { getOpenRouter } from "@/lib/llm";
import {
  type KeyAnimatorEvent,
  type KeyAnimatorOpenAIDeps,
  type KeyAnimatorOpenAIInput,
  runKeyAnimatorOpenAI,
} from "./openai";

/**
 * OpenRouter shim — re-uses `runKeyAnimatorOpenAI` with the OpenRouter
 * client (different base URL, different API key, same Chat Completions
 * surface). Model IDs are free-form (e.g. `anthropic/claude-opus-4.7`,
 * `deepseek/deepseek-chat`).
 */
export async function* runKeyAnimatorOpenRouter(
  input: KeyAnimatorOpenAIInput,
  deps: KeyAnimatorOpenAIDeps = {},
): AsyncGenerator<KeyAnimatorEvent, void, void> {
  const client = deps.openai ?? getOpenRouter;
  yield* runKeyAnimatorOpenAI(input, { ...deps, openai: client });
}
