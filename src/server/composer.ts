// Chooses which composer the room's transport will run, from the environment.
//
// The key never leaves this process. It is read from `process.env` on the
// server only — deliberately NOT via a VITE_-prefixed variable, because Vite
// inlines those into the browser bundle, and a key in the client bundle would be
// public. The client never learns which composer is in use; it only ever sees
// the finished poem in a `reveal`.

import type { AsyncComposer } from "../shared/generator.ts";
import {
  createLlmComposer,
  asyncDeterministic,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
} from "../engine/llm.ts";
import {
  createLlmClueWriter,
  deterministicClueWriter,
  DEFAULT_CLUE_TIMEOUT_MS,
  type AsyncClueWriter,
} from "../engine/clue.ts";

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// Returns the LLM composer when OPENROUTER_API_KEY is set, otherwise the
// deterministic engine. Either way the app works; the key is an upgrade, not a
// dependency.
export function composerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AsyncComposer {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.log(
      "[poem] OPENROUTER_API_KEY not set — using the deterministic composer.",
    );
    return asyncDeterministic();
  }

  const model = env.OPENROUTER_MODEL?.trim() || DEFAULT_MODEL;
  const timeoutMs = positiveInt(env.OPENROUTER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  console.log(`[poem] composing with ${model} via OpenRouter (${timeoutMs}ms timeout).`);

  return createLlmComposer({
    apiKey,
    model,
    timeoutMs,
    siteUrl: env.PUBLIC_URL?.trim(),
    siteName: "Let's Make a Poem",
    // Surfaced in the server log only. A degraded poem is still a poem, so this
    // is never sent to players — but silent degradation would be impossible to
    // diagnose in production.
    onFallback: (reason) =>
      console.warn(`[poem] fell back to the deterministic composer: ${reason}`),
  });
}

// The clue writer uses the same key as the composer, but its model can diverge:
// OPENROUTER_CLUE_MODEL wins, then OPENROUTER_MODEL (so a single var still
// upgrades both), then the code default. Clues are a lower bar than a whole
// poem — one word to one line — so a cheaper model is safe here, and the
// deterministic fallback ("a noun, starts with D, 4 letters") covers any miss.
// Without a key the queue runs on deterministic clues, playable but plainer.
export function clueWriterFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AsyncClueWriter {
  const apiKey = env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return deterministicClueWriter();

  const model =
    env.OPENROUTER_CLUE_MODEL?.trim() ||
    env.OPENROUTER_MODEL?.trim() ||
    undefined;
  return createLlmClueWriter({
    apiKey,
    model,
    timeoutMs: positiveInt(env.OPENROUTER_CLUE_TIMEOUT_MS, DEFAULT_CLUE_TIMEOUT_MS),
    siteUrl: env.PUBLIC_URL?.trim(),
    siteName: "Let's Make a Poem",
    onFallback: (reason) =>
      console.warn(`[poem] fell back to the deterministic clue: ${reason}`),
  });
}
