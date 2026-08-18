// The fidelity guard: does an LLM-written poem actually contain every submitted
// word, in submission order?
//
// This is the contract the game rests on. A contributor types one word and waits
// for the reveal; if their word isn't in it, the round lied to them. The
// deterministic composer satisfies this by construction (it emits the tokens it
// was given), but a language model will happily write a lovely poem that quietly
// swaps "walk" for "wandered" — so its output is checked rather than trusted.
//
// Inflection IS allowed: "walk" may surface as "walked", "moon" as "moons".
// That latitude is the whole point of the LLM pass — it is what lets a
// present-tense and a past-tense verb agree instead of being jammed together.
// Substitution is not allowed. The line between them is `inflections()`.

import type { GeneratorInput, GeneratorOutput } from "../shared/types.ts";
import { inflections } from "./morphology.ts";

export interface GuardResult {
  ok: boolean;
  /** Submitted words that never appeared, in submission order. */
  missing: string[];
  /** True when every word appeared but not in submission order. */
  outOfOrder: boolean;
}

// Split a poem into comparable tokens: lowercase, strip punctuation, drop
// possessives ("moon's" -> "moon") and the hyphens in coinages ("moon-drenched"
// contributes both halves, so a hyphenated compound still counts as using the
// word).
//
// Exported for the tense pass, which compares a poem against its own rewrite
// and must chop it up exactly the way this guard does.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

// A last-resort match for tokens no dictionary knows — invented words, proper
// nouns, other languages ("zorble", "frabnicate"). Shares the deterministic
// composer's assumption that regular inflection preserves a 4-character prefix.
export function prefixMatch(submitted: string, candidate: string): boolean {
  const n = Math.min(4, submitted.length);
  if (candidate.length < n) return false;
  return submitted.slice(0, n) === candidate.slice(0, n);
}

// Verify a poem against the words it was built from. Scans strictly forward, so
// order is enforced as well as presence.
export function checkFidelity(
  input: GeneratorInput,
  poem: GeneratorOutput,
): GuardResult {
  const tokens = tokenize(poem.text);
  const missing: string[] = [];
  let cursor = 0;
  let outOfOrder = false;

  for (const { word } of input.words) {
    const lower = word.toLowerCase();
    const accepted = inflections(word);
    const matches = (t: string): boolean =>
      accepted.has(t) || prefixMatch(lower, t);

    const at = tokens.findIndex((t, i) => i >= cursor && matches(t));
    if (at >= 0) {
      cursor = at + 1;
      continue;
    }
    // Present, but earlier than a word that should have preceded it. Report it
    // as an ordering failure rather than a missing word — the distinction
    // matters to the retry prompt, which can ask for a reorder instead of
    // claiming a word was dropped.
    if (tokens.some(matches)) {
      outOfOrder = true;
      continue;
    }
    missing.push(word);
  }

  return { ok: missing.length === 0 && !outOfOrder, missing, outOfOrder };
}
