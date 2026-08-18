// The OpenRouter composition pass.
//
// Why this exists: the deterministic composer stitches words together with a
// pattern table keyed on (prevType, nextType). It can insert an article or a
// comma, but it has no idea what the words MEAN, so two verbs in a row get glue
// and nothing else — "walk" and "sang" end up jammed side by side because
// nothing in the pipeline can reason about tense agreement. A language model
// can, which is the entire motivation for this layer.
//
// What it is not: a replacement. src/engine/compose.ts remains the floor. This
// composer never rejects — every failure path (no key, HTTP error, timeout,
// malformed body, a poem that dropped someone's word) resolves to the
// deterministic poem instead. A reveal is the payoff for everyone in the room;
// it must not depend on a third party being up.

import type { AsyncComposer, Generator } from "../shared/generator.ts";
import type { GeneratorInput, GeneratorOutput } from "../shared/types.ts";
import { composer as deterministic } from "./compose.ts";
import { checkFidelity } from "./guard.ts";
import { harmonizeTense } from "./tense.ts";
import { markSubmitted } from "./marks.ts";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Sonnet 5 is the default: strong enough at short-form verse for a toy, and
// roughly a fifth the cost of anthropic/claude-fable-5, which is the upgrade to
// reach for if the poems feel flat. Override with OPENROUTER_MODEL.
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5";
export const DEFAULT_TIMEOUT_MS = 12_000;

export interface LlmComposerConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** Sent as HTTP-Referer / X-Title; OpenRouter uses these for attribution. */
  siteUrl?: string;
  siteName?: string;
  /** The floor this composer degrades to. Defaults to the deterministic engine. */
  fallback?: Generator;
  /** Injectable; defaults to the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Called on every degradation, so the server can log why a poem was plain. */
  onFallback?: (reason: string) => void;
}

const SYSTEM_PROMPT = `You write the reveal for "Let's Make a Poem", a party game. Each player secretly submitted ONE word without seeing anyone else's. You are given those words in the exact order the players arrived. Your job is to make them read as a single intentional poem.

Rules, in order of importance:
1. Use EVERY submitted word, and use them in the order given. This is absolute — a player who typed a word must find it in the poem.
2. You MAY inflect a word to make it fit: conjugate verbs for tense and agreement, pluralize or make possessive, use a comparative. "walk" may become "walked"; "moon" may become "moons". Choose the inflections that make the words agree with each other — this is the main thing you are here to do.
3. ONE TENSE for the whole poem. Whatever tense you put the first verb in, every later verb matches it. "The stars were flying where the child eats" is wrong — it must be "were flying / ate" or "are flying / eats".
4. You MAY add connective language between them: articles, prepositions, conjunctions, pronouns, and short linking phrases. Punctuate and break lines to create sense and rhythm.
5. Do NOT substitute a submitted word for a synonym, and do NOT drop one.
6. Keep added imagery restrained. The submitted words are the poem; your additions are the thread. Never add a noun more vivid than the ones you were given.

Style: 2 to 6 short lines. Surreal and concrete rather than abstract or sentimental. No title, no rhyme scheme required, no explanation.

Output the poem itself and nothing else — no preamble, no quotation marks, no markdown.`;

// Render the submitted words as a delimited list rather than inline prose. They
// are untrusted player input (arbitrary single tokens), so they are presented as
// data to be used, never as text to be obeyed.
function userPrompt(input: GeneratorInput): string {
  const list = input.words
    .map((w, i) => `${i + 1}. [${w.type}] ${w.word}`)
    .join("\n");
  return `Submitted words, in arrival order:\n\n${list}\n\nWrite the poem.`;
}

// Strip the wrappers models add despite being asked not to: markdown fences,
// surrounding quotes, a "Poem:" label. Then normalize to non-empty lines, the
// same shape the deterministic composer returns.
function parsePoem(raw: string): GeneratorOutput | null {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  text = text.replace(/^(?:poem|here'?s the poem)\s*:\s*/i, "");
  text = text.trim();
  if (
    text.length > 1 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("“") && text.endsWith("”")))
  ) {
    text = text.slice(1, -1).trim();
  }
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return { lines, text: lines.join("\n") };
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function createLlmComposer(cfg: LlmComposerConfig): AsyncComposer {
  const model = cfg.model || DEFAULT_MODEL;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fallback = cfg.fallback ?? deterministic;
  const doFetch = cfg.fetchImpl ?? globalThis.fetch;
  const note = cfg.onFallback ?? (() => { });

  async function callModel(messages: ChatMessage[]): Promise<string | null> {
    // AbortController rather than Promise.race: a slow request should be torn
    // down, not merely ignored while it keeps a socket open.
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
          messages,
          // Warm enough that the same words don't yield the same poem twice.
          temperature: 0.9,
          // Headroom. Reasoning tokens, when a model emits them, are billed
          // against this same budget — see the `reasoning` note below for why
          // that turned out to matter.
          max_tokens: 1000,
          // Turn extended thinking OFF. This is short-form creative writing, not
          // a reasoning problem, and thinking actively hurt it: a reasoning model
          // handed a hard slot assignment ("restless" as a noun, "sang" as an
          // adjective — routine here, since slots are assigned at random) would
          // deliberate until it hit max_tokens and return `content: null` having
          // never written a line. Disabling it measured ~2x faster and ~6x
          // cheaper on exactly those inputs, and removes that failure mode.
          reasoning: { enabled: false },
        }),
      });
      if (!res.ok) {
        note(`openrouter http ${res.status}`);
        return null;
      }
      const body = (await res.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        // A 200 that carries no usable text. This MUST be reported: it is the
        // one failure that looks like success from the outside, and leaving it
        // silent once hid a systematic truncation bug behind poems that had
        // quietly degraded to the deterministic engine.
        note(
          `openrouter returned no content (finish_reason: ${choice?.finish_reason ?? "unknown"})`,
        );
        return null;
      }
      return content;
    } catch (err) {
      note(
        abort.signal.aborted
          ? `openrouter timeout after ${timeoutMs}ms`
          : `openrouter request failed: ${(err as Error).message}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async compose(input: GeneratorInput): Promise<GeneratorOutput> {
      // Nothing to compose, and nothing an LLM could add.
      if (input.words.length === 0) return fallback.compose(input);

      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(input) },
      ];

      // Two attempts: the first as asked, the second told exactly how it failed.
      // Fidelity failures are usually a dropped word the model can put back, so
      // one corrective round trip is worth the latency; a second is not.
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await callModel(messages);
        if (raw === null) break; // transport failure — retrying won't help

        const parsed = parsePoem(raw);
        if (!parsed) {
          note("openrouter returned an unparseable poem");
          break;
        }

        // Rule 3 of the prompt, enforced rather than hoped for: models drift
        // across a few lines ("were flying ... eats"). A no-op when the model
        // already agreed with itself, which is most of the time. Deliberately
        // BEFORE the guard, so a rewrite that somehow lost a word is caught by
        // the same check that catches the model losing one.
        const lines = harmonizeTense(
          parsed.lines,
          input.words.filter((w) => w.type !== "verb").map((w) => w.word),
        );
        const poem = { lines, text: lines.join("\n") };

        const check = checkFidelity(input, poem);
        // Marked only once the guard has confirmed the words are all there, in
        // order — the mark scan and the guard walk the poem the same way, so a
        // poem that failed the guard would produce marks with holes in it.
        if (check.ok) return { ...poem, marks: markSubmitted(input.words, lines) };

        if (attempt === 0) {
          const problems = [
            check.missing.length
              ? `You left out: ${check.missing.join(", ")}. Every submitted word must appear.`
              : "",
            check.outOfOrder
              ? "The words appeared out of order. They must appear in the order they were submitted."
              : "",
          ]
            .filter(Boolean)
            .join(" ");
          messages.push(
            { role: "assistant", content: poem.text },
            {
              role: "user",
              content: `${problems} Rewrite the poem, keeping the words in submission order. You may still inflect them.`,
            },
          );
          continue;
        }
        note(
          check.missing.length
            ? `fidelity: dropped ${check.missing.join(", ")}`
            : "fidelity: words out of order",
        );
      }

      return fallback.compose(input);
    },
  };
}

// Wrap the synchronous deterministic composer as an AsyncComposer, so the
// transport has one shape to call whether or not OpenRouter is configured.
export function asyncDeterministic(gen: Generator = deterministic): AsyncComposer {
  return { compose: (input) => Promise.resolve(gen.compose(input)) };
}
