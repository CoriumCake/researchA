import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

/**
 * One structured-output call. Returns the parsed JSON object that matches `schema`.
 * Uses server-side refusal fallbacks ("default" routing) so a safety decline on the
 * primary model is retried on Anthropic's recommended fallback model.
 */
export async function callJson({ system, user, schema, effort, maxTokens = 16000, model = config.model }) {
  // Server-side fallbacks exist for Opus/Sonnet/Fable, not Haiku.
  const fallback = model.startsWith("claude-haiku")
    ? {}
    : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };
  const response = await getClient().beta.messages.create({
    model,
    max_tokens: maxTokens,
    ...fallback,
    cache_control: { type: "ephemeral" },
    output_config: { effort, format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") {
    throw new Error(`model declined (${response.stop_details?.category ?? "no category"})`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("response hit max_tokens — lower the batch size");
  }
  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  return { data: JSON.parse(text), model: response.model, usage: response.usage };
}

export function describeLlmError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "Anthropic API key is missing or invalid";
  if (e instanceof Anthropic.RateLimitError) return "rate limited by the Anthropic API — try again shortly";
  if (e instanceof Anthropic.BadRequestError) return `bad request: ${e.message}`;
  if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
  return e?.message || String(e);
}
