// Pass 3: tense agreement. Whatever tense the poem's FIRST verb is in, every
// later verb joins it.
//
// Why it is a pass and not a rule inside the other two: neither of the writers
// upstream can see the whole poem's verbs at once. The deterministic composer
// inflects each word from its immediate neighbours (so a submitted "sang" that
// opens a poem stays past while the next verb becomes a tidy present "eats"),
// and the language model — asked or not — drifts across a few lines. This is
// the only place that reads the finished poem end to end, which is exactly what
// tense agreement needs.
//
// Design rules:
//   1. Never invent a reading. If there is no verb, one verb, or no detectable
//      tense, the poem is returned untouched.
//   2. Never lose a line. A rewrite that changes the shape of the poem is
//      discarded — a mangled poem is worse than a mixed-tense one, and the
//      caller has no way to tell what happened after the fact.
//   3. Never throw. compromise can be surprised by the tokens players submit;
//      the original lines are always an acceptable answer.
//   4. Never conjugate someone's noun. A part-of-speech tagger reading a
//      fragment will happily treat a submitted "velvet" as a verb and write
//      "velveted"; `protect` is the list of words that were NOT submitted into
//      verb slots, and if the rewrite alters one of them it is thrown away.
//      The fidelity guard cannot catch this on its own — its prefix match
//      accepts "velveted" for "velvet" — so the check lives here.
//   5. Never move punctuation. Conjugation is a change of letters; anything
//      else is the library having a bad day, and a poem is a thing people
//      keep. The three checks at the end of `harmonizeTense` — line count,
//      punctuation skeleton, protected words — are all the same instinct:
//      when in doubt, hand back what the composer actually wrote.

import nlp from "compromise";
import { prefixMatch, tokenize } from "./guard.ts";
import { inflections } from "./morphology.ts";

// Everything that isn't a letter, a digit, or whitespace — the poem's
// punctuation skeleton. Conjugating a verb changes letters and nothing else,
// so this must come back identical; see `harmonizeTense`.
function punctuation(text: string): string {
  return text.replace(/[\p{L}\p{N}]+/gu, "").replace(/\s+/g, "");
}

export type PoemTense = "past" | "present" | "future";

// compromise's own labels for the verb phrase's grammar, which is the thing
// worth trusting here: it reads "were flying" as one past-progressive phrase,
// where the bare tag on "were" says nothing useful.
const TENSES: Record<string, PoemTense> = {
  PastTense: "past",
  PresentTense: "present",
  FutureTense: "future",
};

interface VerbJson {
  verb?: { grammar?: { tense?: string; form?: string } };
}

/** The tense the rest of the poem should follow, or null if there isn't one. */
function firstVerbTense(text: string): PoemTense | null {
  let first: VerbJson | undefined;
  try {
    first = nlp(text).verbs().json()[0] as VerbJson | undefined;
  } catch {
    return null;
  }
  const tense = first?.verb?.grammar?.tense;
  return tense ? (TENSES[tense] ?? null) : null;
}

// Every token in `text` that reads as one of the protected words, in order.
// Comparing this between a poem and its rewrite answers the only question that
// matters: did the pass touch a word that wasn't a verb?
function protectedForms(text: string, protect: readonly string[]): string[] {
  if (protect.length === 0) return [];
  const tokens = tokenize(text);
  const found: string[] = [];
  for (const word of protect) {
    const accepted = inflections(word);
    const lower = word.toLowerCase();
    for (const t of tokens) {
      if (accepted.has(t) || prefixMatch(lower, t)) found.push(t);
    }
  }
  return found;
}

/**
 * @param protect Submitted words from non-verb slots. If the rewrite changes
 *   the form of any of them, the original poem is returned instead.
 */
export function harmonizeTense(
  lines: string[],
  protect: readonly string[] = [],
): string[] {
  if (lines.length === 0) return lines;
  const text = lines.join("\n");

  try {
    // One verb can't disagree with anything, and a poem with none is often the
    // most surreal thing the room produced. Both are left alone.
    if (nlp(text).verbs().length < 2) return lines;

    const target = firstVerbTense(text);
    if (!target) return lines;

    const verbs = nlp(text).verbs();
    if (target === "past") verbs.toPastTense();
    else if (target === "present") verbs.toPresentTense();
    else verbs.toFutureTense();

    const next = verbs.all().text().split("\n").map((l) => l.trim());
    // Rule 2: same number of lines, none of them emptied. compromise rewrites
    // in place, so this should always hold — and if it ever doesn't, the poem
    // that reaches the room is the one the composer actually wrote.
    if (next.length !== lines.length) return lines;
    if (next.some((l) => l.length === 0)) return lines;

    // Rule 5: conjugation moves letters, never punctuation. compromise's
    // present-tense conversion breaks this when the verb term carries the
    // punctuation that ends a sentence — it appends the third-person "s" AFTER
    // the mark and then repeats it, so a poem ending "…exited." came back
    // "…exited.s." and went to disk that way. ("exited?" becomes "exited?s?",
    // "exited…" becomes "exited…s…" — same bug, any terminator.)
    //
    // It cannot be repaired from the outside: the mangled token has lost the
    // conjugation as well as the punctuation ("exited" never became "exits"),
    // so there is nothing to shuffle back into place. The poem is returned as
    // written instead, mixed tense and all — which is a far smaller failure
    // than handing someone their word back broken.
    if (punctuation(next.join("\n")) !== punctuation(text)) return lines;

    // Rule 4: a noun or adjective someone submitted must read the same after
    // the rewrite as before it.
    const before = protectedForms(text, protect);
    const after = protectedForms(next.join("\n"), protect);
    if (before.length !== after.length) return lines;
    if (before.some((form, i) => form !== after[i])) return lines;

    return next;
  } catch {
    return lines;
  }
}
