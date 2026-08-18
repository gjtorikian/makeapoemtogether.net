// Pass 1: morphology. Inflect each content word by its slot type and local
// context. compromise handles POS-aware conjugation/gerund/comparative;
// pluralize handles plurals. Anything compromise can't inflect (rare, proper,
// or non-English tokens) falls back to the original token — acceptable, even
// desirable, for a surreal toy.

import nlp from "compromise";
import pluralize from "pluralize";
import type { WordType } from "../shared/types.ts";
import { makeChooser } from "./seed.ts";
import { indefiniteArticle } from "./lexicon.ts";

// compromise's conjugate() returns a clean forms map; typed loosely because the
// available keys vary by verb (e.g. irregulars add a Participle).
type VerbForms = Partial<Record<"Infinitive" | "PastTense" | "PresentTense" | "Gerund" | "FutureTense", string>>;
type AdjForms = Partial<Record<"Adjective" | "Comparative" | "Superlative", string>>;

// Force the word to be read as a verb even when compromise defaults it to a
// noun (e.g. "moon" submitted into a verb slot), then read its conjugation.
function verbForms(verb: string): VerbForms | undefined {
  let forms = nlp(verb).verbs().conjugate()[0] as VerbForms | undefined;
  if (!forms) {
    const doc = nlp(verb);
    doc.tag("Verb");
    forms = doc.verbs().conjugate()[0] as VerbForms | undefined;
  }
  return forms;
}

function adjForms(adj: string): AdjForms | undefined {
  let forms = nlp(adj).adjectives().conjugate()[0] as AdjForms | undefined;
  if (!forms) {
    const doc = nlp(adj);
    doc.tag("Adjective");
    forms = doc.adjectives().conjugate()[0] as AdjForms | undefined;
  }
  return forms;
}

function pluralizeNoun(w: string): string {
  return pluralize(w);
}

export function isPluralNoun(w: string): boolean {
  return pluralize.isPlural(w);
}

function gerund(verb: string): string {
  return verbForms(verb)?.Gerund ?? verb;
}

function conjugate(verb: string, t: "past" | "present3"): string {
  const forms = verbForms(verb);
  if (!forms) return verb;
  return (t === "past" ? forms.PastTense : forms.PresentTense) ?? verb;
}

function comparative(adj: string): string {
  return adjForms(adj)?.Comparative ?? adj;
}

export function article(nextWord: string): "a" | "an" {
  return indefiniteArticle(nextWord);
}

// Only a genuinely gradable, short adjective takes an "-er" comparative. Nouns
// pressed into an adjective slot ("velvet", "cathedral") and long / non-gradable
// adjectives ("crimson", "electric", "golden") would otherwise produce junk like
// "velveter" / "crimsoner". Two cheap, deterministic gates: compromise must read
// the word as an adjective WITHOUT us forcing the tag, and the word must be short
// enough for "-er" to be well-formed — monosyllables, or two-syllable adjectives
// ending in y/le/ow/er (happy, gentle, narrow, clever).
function isComparableAdjective(word: string): boolean {
  const w = word.toLowerCase();
  if (!/^[a-z]+$/.test(w)) return false; // emoji, digits, odd tokens: leave as-is
  if (!nlp(word).has("#Adjective")) return false;
  const syllables = (w.match(/[aeiouy]+/g) ?? []).length;
  if (syllables <= 1) return true;
  return syllables === 2 && /(?:y|le|ow|er)$/.test(w);
}

// Every surface form a submitted word may legitimately take in a poem, used by
// the fidelity guard to decide whether an LLM-written line still contains it.
//
// Generous on purpose, and in both directions: all three POS paths are consulted
// regardless of the word's slot type (a noun-slot word can still be verbed by a
// good line), and the raw token is always included. The cost of being too narrow
// is a needless fallback to the deterministic composer; the cost of being too
// wide is only that a near-miss inflection passes — the word still has to be
// *there*. Irregulars are the reason this exists rather than a prefix test:
// "sing" -> "sang" and "good" -> "better" share no usable prefix.
export function inflections(word: string): Set<string> {
  const forms = new Set<string>([word.toLowerCase()]);
  const add = (s: string | undefined): void => {
    if (s) forms.add(s.toLowerCase());
  };
  try {
    for (const v of Object.values(verbForms(word) ?? {})) add(v);
    for (const a of Object.values(adjForms(word) ?? {})) add(a);
    add(pluralize.singular(word));
    add(pluralize.plural(word));
  } catch {
    // compromise/pluralize can throw on pathological tokens; the raw word alone
    // is a fine accepted set for anything that exotic.
  }
  return forms;
}

// A content token after morphology: keeps its slot type so the connective pass
// can consult the (prevType, nextType) pattern table.
export interface InflectedToken {
  type: WordType;
  word: string;
}

// Inflect every token in arrival order. Order is NEVER changed — only the
// surface form of each word. Choices (plural? gerund vs. present? comparative?)
// are seeded, so the whole poem is deterministic.
export function applyMorphology(
  words: ReadonlyArray<{ type: WordType; word: string }>,
  seed: number,
): InflectedToken[] {
  const choose = makeChooser(seed);
  return words.map((tok, i) => {
    const prev = words[i - 1]?.type;
    let word = tok.word;

    switch (tok.type) {
      case "noun": {
        // A noun in a run of nouns pluralizes more often; otherwise rarely.
        const p = prev === "noun" ? 0.6 : 0.25;
        if (choose.bool(p)) word = pluralizeNoun(tok.word);
        break;
      }
      case "verb": {
        if (i === 0) {
          // A leading verb reads as an imperative — keep the base form.
          word = tok.word;
        } else if (prev === "noun") {
          // After a noun it behaves like a predicate: present-3rd or gerund.
          word = choose.bool() ? conjugate(tok.word, "present3") : gerund(tok.word);
        } else {
          // Elsewhere lean on gerunds for a drifting, surreal cadence.
          word = choose.bool() ? gerund(tok.word) : tok.word;
        }
        break;
      }
      case "adjective": {
        // Occasionally heighten to a comparative ("brighter", "happier") — but
        // only for real, short, gradable adjectives, so a noun-in-an-adjective-
        // slot never becomes "velveter" / "cathedraler". choose.bool() is
        // evaluated first, so the seeded stream (and every other word's choice)
        // is byte-for-byte unchanged whether or not the guard passes.
        if (choose.bool(0.3) && isComparableAdjective(tok.word)) {
          word = comparative(tok.word);
        }
        break;
      }
    }

    return { type: tok.type, word };
  });
}
