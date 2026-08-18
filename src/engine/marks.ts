// Which words in the finished poem did the room actually submit?
//
// By the time a poem exists, the players' words and the writer's connective
// tissue are indistinguishable prose — "the crimson lantern shimmers" gives no
// hint that only two of those words came from people. This pass records the
// difference while it is still knowable, so a poem read back weeks later can
// still show whose it was.
//
// It answers the same question the fidelity guard asks ("where is each
// submitted word?") and MUST answer it identically: same tokenizer, same
// accepted inflections, same forward-only scan, so the marks land on exactly
// the tokens the guard counted. The difference is only that the guard throws
// the positions away and this keeps them.

import type { WordMark } from "../shared/types.ts";
import { prefixMatch } from "./guard.ts";
import { inflections } from "./morphology.ts";

interface PositionedToken {
  token: string;
  line: number;
  start: number;
  end: number;
}

// Runs of letters and digits, which is what the guard's tokenizer splits on.
const WORD = /[\p{L}\p{N}]+/gu;

// The guard drops the "s" of a possessive ("moon's" -> "moon"); this stream has
// to drop it too, or the two scans would disagree about how many tokens they
// have seen and every later mark would slide by one.
function isPossessiveS(line: string, start: number, token: string): boolean {
  if (token !== "s") return false;
  const before = line[start - 1];
  return before === "'" || before === "’";
}

function scan(lines: readonly string[]): PositionedToken[] {
  const out: PositionedToken[] = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(WORD)) {
      const start = m.index ?? 0;
      const token = m[0].toLowerCase();
      if (isPossessiveS(line, start, token)) continue;
      out.push({ token, line: i, start, end: start + m[0].length });
    }
  });
  return out;
}

/**
 * Locate each submitted word in the poem, in submission order. Words the poem
 * doesn't contain are simply not marked — that is the fidelity guard's
 * complaint to make, not this pass's.
 */
export function markSubmitted(
  words: ReadonlyArray<{ word: string }>,
  lines: readonly string[],
): WordMark[] {
  const tokens = scan(lines);
  const marks: WordMark[] = [];
  let cursor = 0;

  for (const { word } of words) {
    const lower = word.toLowerCase();
    const accepted = inflections(word);
    const at = tokens.findIndex(
      (t, i) =>
        i >= cursor && (accepted.has(t.token) || prefixMatch(lower, t.token)),
    );
    if (at < 0) continue;
    cursor = at + 1; // forward-only: two people who submitted the same word get
    // one mark each, on the two places it appears
    const { line, start, end } = tokens[at];
    marks.push({ line, start, end });
  }

  return marks;
}
