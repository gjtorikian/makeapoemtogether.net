// The deterministic poem composer: the real implementation of the Generator
// interface (Phase 2 wires it in behind that boundary, replacing the stub).
//
// Pure and synchronous. seed = hash(words) ties every choice to the exact input,
// so the same word set always produces the same poem.

import type { Generator } from "../shared/generator.ts";
import { hash } from "./seed.ts";
import { applyMorphology } from "./morphology.ts";
import { realizeConnective } from "./connective.ts";
import { harmonizeTense } from "./tense.ts";
import { markSubmitted } from "./marks.ts";

export const composer: Generator = {
  compose: ({ words }) => {
    const seed = hash(words.map((w) => w.word).join("|"));
    const inflected = applyMorphology(words, seed); // pass 1: morphology
    const drafted = realizeConnective(inflected, seed); // pass 2: connective + breaks
    // Pass 3: one tense across the poem. Morphology inflects each word from its
    // immediate neighbours, so a submitted past-tense word that opens a poem
    // ("sang the stars") used to sit beside a tidy present one ("eating") with
    // nothing able to see both. Non-verb slots are protected: this pass may
    // never decide someone's "velvet" was a verb.
    const lines = harmonizeTense(
      drafted,
      words.filter((w) => w.type !== "verb").map((w) => w.word),
    );
    // Last: record where each player's word ended up, while that is still
    // knowable — after this the poem is only text.
    return { lines, text: lines.join("\n"), marks: markSubmitted(words, lines) };
  },
};
