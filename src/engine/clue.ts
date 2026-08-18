// The clue-writing pass: the queue's "dictionary lookup".
//
// When an author's word is accepted, the next author in the queue receives a
// definition-style hint about it — "desk" becomes "a place where one writes".
// No dictionary ships with the app, and none could cover arbitrary player
// input (names, slang, typos); the same OpenRouter pass that composes the poem
// writes the clue instead.
//
// Same degradation contract as the composer: this writer never rejects. Every
// failure path (no key, HTTP error, timeout, empty body, a clue that leaks the
// word it defines) resolves to the deterministic fallback clue — the queue must
// keep moving even when the third party is down.

import type { WordType } from "../shared/types.ts";
import { fallbackClue } from "../shared/clue.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Same default as the composer. Clues are a dozen tokens of output; latency is
// what matters (the next author is staring at a waiting screen), hence the
// shorter timeout.
const DEFAULT_CLUE_MODEL = "anthropic/claude-sonnet-5";
export const DEFAULT_CLUE_TIMEOUT_MS = 8_000;

export interface ClueInput {
  word: string;
  type: WordType;
}

// What the transport calls. Must always resolve — a writer that cannot produce
// a clue falls back to `fallbackClue` rather than rejecting, so the queue's
// next author is never stranded.
export interface AsyncClueWriter {
  clue(input: ClueInput): Promise<string>;
}

export interface LlmClueWriterConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Sent as HTTP-Referer / X-Title; OpenRouter uses these for attribution. */
  siteUrl?: string;
  siteName?: string;
  /** Injectable; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Called on every degradation, so the server can log why a clue was plain. */
  onFallback?: (reason: string) => void;
}

const SYSTEM_PROMPT = `You write one-line clues for a party word game. A player submitted a single word; the next player gets your clue as their only hint about it.

Rules:
1. Reply with ONE short, dictionary-style clue: 3 to 10 words. "desk" -> "a place where one writes".
2. The clue must NOT contain the word itself, any inflection of it, or an obvious fragment of it.
3. Evoke, don't define exhaustively. Concrete beats clinical.
4. No quotation marks, no trailing period, no preamble — output the clue and nothing else.`;

// The word is untrusted player input (an arbitrary single token), so it is
// presented as labeled data to be described, never as text to be obeyed.
function userPrompt(input: ClueInput): string {
  return `The word (a ${input.type}): ${input.word}\n\nWrite the clue.`;
}

// Strip wrappers models add despite being asked not to, then vet the result:
// single line, sane length, and — the one rule that matters — it must not leak
// the word it defines (checked against the word and its crude stem, so "desks"
// or "writing" can't smuggle "desk"/"write" through).
function parseClue(raw: string, input: ClueInput): string | null {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  text = text.replace(/^(?:clue)\s*:\s*/i, "");
  text = text.split("\n")[0].trim();
  if (
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("“") && text.endsWith("”")))
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\.+$/, "").trim();
  if (text.length === 0 || text.length > 120) return null;
  const clue = text.toLowerCase();
  const word = input.word.toLowerCase();
  const stem = word.length > 4 ? word.slice(0, word.length - 2) : word;
  if (clue.includes(word) || clue.includes(stem)) return null;
  return text;
}

export function createLlmClueWriter(cfg: LlmClueWriterConfig): AsyncClueWriter {
  const model = cfg.model || DEFAULT_CLUE_MODEL;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_CLUE_TIMEOUT_MS;
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const note = cfg.onFallback ?? (() => {});

  // One fetch + parse + vet. Returns the clue on success, or the reason it
  // failed on any other path. Each attempt gets its own AbortController so a
  // slow first call is torn down before the retry fires (and so two attempts
  // can't share a single timed-out socket).
  async function attempt(
    input: ClueInput,
  ): Promise<{ ok: true; clue: string } | { ok: false; reason: string }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const res = await doFetch(OPENROUTER_URL, {
        method: "POST",
        signal: abort.signal,
        headers: {
          authorization: `Bearer ${cfg.apiKey}`,
          "content-type": "application/json",
          ...(cfg.siteUrl ? { "HTTP-Referer": cfg.siteUrl } : {}),
          ...(cfg.siteName ? { "X-Title": cfg.siteName } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt(input) },
          ],
          temperature: 0.8,
          max_tokens: 100,
          // Off for the same reason as the composer: this is a one-line
          // creative task, and reasoning burn-through was the composer's
          // observed content-null failure mode.
          reasoning: { enabled: false },
        }),
      });
      if (!res.ok) return { ok: false, reason: `openrouter http ${res.status}` };
      const body = (await res.json()) as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      const finish = choice?.finish_reason;
      if (typeof content !== "string" || !content.trim()) {
        return { ok: false, reason: "openrouter returned no clue content" };
      }
      // A non-empty body can still be a failure: Gemini intermittently returns
      // `finish_reason: "error"` with truncated content (e.g. "Uses" for
      // "burns", a safety-adjacent word). Treating that as bad and retrying
      // recovers a clean clue on the next sample. Missing finish_reason is
      // left alone so providers/tests that omit it still resolve.
      if (
        typeof finish === "string" &&
        finish !== "stop" &&
        finish !== "stop_sequence"
      ) {
        return { ok: false, reason: `openrouter bad finish_reason: ${finish}` };
      }
      const clue = parseClue(content, input);
      if (clue === null) {
        return {
          ok: false,
          reason: "openrouter clue rejected (leaked the word or unusable)",
        };
      }
      return { ok: true, clue };
    } catch (err) {
      return {
        ok: false,
        reason: abort.signal.aborted
          ? `openrouter timeout after ${timeoutMs}ms`
          : `openrouter request failed: ${(err as Error).message}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async clue(input: ClueInput): Promise<string> {
      // Two attempts. Unlike the composer's corrective retry this re-samples
      // the identical request (no corrective turn): temperature 0.8 means the
      // second draw is a fresh clue, which is what recovers the transient
      // failures — a soft `finish_reason: "error"` on "burns", a dropped word,
      // a one-off 5xx. The first failure is swallowed; only the final reason is
      // logged, so a degraded clue still says why. The next author is blocked
      // for this, but the fallback is no longer a good-enough hint (it's bare
      // type + length), so one recovery round trip is worth the rare extra
      // latency. Worst case is two timeouts; see OPENROUTER_CLUE_TIMEOUT_MS.
      let lastReason = "";
      for (let i = 0; i < 2; i++) {
        const r = await attempt(input);
        if (r.ok) return r.clue;
        lastReason = r.reason;
      }
      note(lastReason);
      return fallbackClue(input.word, input.type);
    },
  };
}

// The keyless writer: the deterministic clue, immediately. One shape for the
// transport to call whether or not OpenRouter is configured — the composer's
// asyncDeterministic pattern.
export function deterministicClueWriter(): AsyncClueWriter {
  return {
    clue: (input) => Promise.resolve(fallbackClue(input.word, input.type)),
  };
}
