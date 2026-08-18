// Pass 2: connective realization. Walk the inflected tokens left → right and,
// between each adjacent pair, consult a pattern table keyed on
// (prevType, nextType) to maybe insert a connective (article, preposition,
// conjunction, or comma). Line breaks fall every 1–3 phrases. The aesthetic is
// the surreal fragment: commas and breaks make arbitrary POS orders read as
// intentional rather than broken.
//
// Invariants:
//   - Content tokens are emitted in their given order; nothing is reordered.
//   - At least one real (word) connective is inserted.
//   - At least one line break is inserted when there are >= 2 tokens.

import type { WordType } from "../shared/types.ts";
import type { InflectedToken } from "./morphology.ts";
import { article, isPluralNoun } from "./morphology.ts";
import { makeChooser, type Chooser } from "./seed.ts";
import { PREPOSITIONS, CONJUNCTIONS } from "./lexicon.ts";

// A determiner for a noun slot: an indefinite article disagrees with a plural
// ("a moons"), so fall back to "the" when the noun has been pluralized.
function determiner(nextWord: string): string {
  return isPluralNoun(nextWord) ? "the" : article(nextWord);
}

// One rendered atom in the output stream.
type Item =
  | { kind: "word"; s: string } // a real word (content or connective)
  | { kind: "punct"; s: string } // glues to the previous word, e.g. ","
  | { kind: "break" }; // a line break

// The pattern table. Each entry returns "" (no connective), a comma, or one or
// more words. Embraces fragments — bare lists are the failure mode we design
// against, so even same-type runs get glue.
function connectiveBetween(
  prev: WordType,
  next: WordType,
  nextWord: string,
  choose: Chooser,
): string {
  // `${preposition} the` ("through the", "beneath the", ...) for variety.
  const prepThe = `${choose.pick(PREPOSITIONS)} the`;
  const conj = choose.pick(CONJUNCTIONS);

  switch (`${prev}->${next}`) {
    case "adjective->noun":
      return choose.pick(["the", determiner(nextWord), ""]);
    case "adjective->adjective":
      return choose.pick([",", conj, ", so"]);
    case "adjective->verb":
      return choose.pick(["", "and", "now"]);
    case "noun->verb":
      return choose.pick(["", "that", ","]);
    case "noun->noun":
      return choose.pick([",", conj, "of", "of the", prepThe]);
    case "noun->adjective":
      return choose.pick([",", "so", "and", "becoming"]);
    case "verb->noun":
      return choose.pick(["the", prepThe, determiner(nextWord)]);
    case "verb->verb":
      return choose.pick([conj, ",", "to", "then"]);
    case "verb->adjective":
      // Avoid ending on a determiner here: the following adjective->noun adds
      // its own, which would double up ("...the restless a garden").
      return choose.pick(["", "so", "now", "becoming"]);
    default:
      return "";
  }
}

// The optional connective that opens the poem, based on the first token's type.
function leadingConnective(first: InflectedToken, choose: Chooser): string {
  switch (first.type) {
    case "noun":
      return choose.pick(["the", determiner(first.word), ""]);
    case "adjective":
      return choose.pick(["the", determiner(first.word), "so"]);
    case "verb":
      return choose.pick(["", "to", "we"]);
    default:
      return "";
  }
}

// Render the item stream into trimmed, non-empty lines.
function renderLines(items: Item[]): string[] {
  let buf = "";
  for (const it of items) {
    if (it.kind === "break") {
      buf = buf.replace(/ +$/, "") + "\n";
    } else if (it.kind === "punct") {
      // Drop a comma that would open a line (e.g. a break landed just before it).
      if (buf.length === 0 || buf.endsWith("\n")) continue;
      buf = buf.replace(/ +$/, "") + it.s + " ";
    } else {
      buf += it.s + " ";
    }
  }
  return buf
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function realizeConnective(tokens: InflectedToken[], seed: number): string[] {
  if (tokens.length === 0) return [""];

  // Decorrelate from morphology's stream while staying deterministic.
  const choose = makeChooser(seed ^ 0x5bd1e995);
  const items: Item[] = [];
  let connectiveWords = 0;

  // Split a connective string ("of the", ", so") into stream items.
  const pushConnective = (c: string): void => {
    if (!c) return;
    for (const part of c.split(" ")) {
      if (part === ",") {
        items.push({ kind: "punct", s: "," });
      } else if (part.length > 0) {
        items.push({ kind: "word", s: part });
        connectiveWords++;
      }
    }
  };

  pushConnective(leadingConnective(tokens[0], choose));

  let phrasesOnLine = 0;
  let limit = choose.int(3) + 1; // 1..3 phrases per line
  let breaks = 0;

  tokens.forEach((tok, i) => {
    if (i > 0) {
      pushConnective(connectiveBetween(tokens[i - 1].type, tok.type, tok.word, choose));
    }
    items.push({ kind: "word", s: tok.word });
    phrasesOnLine++;

    const isLast = i === tokens.length - 1;
    if (!isLast) {
      // Force at least one break: if we reach the final gap with none yet, take it.
      const forceBreak = i === tokens.length - 2 && breaks === 0;
      if (phrasesOnLine >= limit || forceBreak) {
        items.push({ kind: "break" });
        breaks++;
        phrasesOnLine = 0;
        limit = choose.int(3) + 1;
      }
    }
  });

  // Guarantee at least one real connective even for pathological inputs.
  if (connectiveWords === 0) {
    items.unshift({ kind: "word", s: "the" });
  }

  return renderLines(items);
}
