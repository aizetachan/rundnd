import { env } from "@/lib/env";
import OpenAI from "openai";

/**
 * The OpenAI client does double duty: direct OpenAI calls AND OpenRouter
 * (swap baseURL, use OPENROUTER_API_KEY). M5.5 promotes the OpenRouter
 * factory to first-class.
 */
let _openaiClient: OpenAI | undefined;
let _openrouterClient: OpenAI | undefined;

export function getOpenAI(): OpenAI {
  if (_openaiClient) return _openaiClient;
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
  _openaiClient = new OpenAI({ apiKey });
  return _openaiClient;
}

/**
 * OpenRouter client. Uses the OpenAI SDK with overridden baseURL +
 * the OpenRouter API key. The HTTP surface matches Chat Completions
 * verbatim, so runKeyAnimatorOpenAI works for both providers when
 * the right client is injected.
 */
export function getOpenRouter(): OpenAI {
  if (_openrouterClient) return _openrouterClient;
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY not configured");
  _openrouterClient = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
  });
  return _openrouterClient;
}
