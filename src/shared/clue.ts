import type { WordType } from "./types";

// The clue floor, shared by the LLM clue writer (its degradation target), the
// transport (its catch-all), and the room's tick backstop. Purely structural —
// type, length, and (for longer words) the first letter — so it can give a real
// hint without ever handing out the word itself, and never needs the network.
// "desk" -> "a noun, starts with D, 4 letters"; a 2-letter word stays bare
// ("a verb of 2 letters") so a short word is never leaked by its first char.
export function fallbackClue(word: string, type: WordType): string {
  const article = type === "adjective" ? "an" : "a";
  const chars = [...word];
  const n = chars.length;
  const letters = n === 1 ? "letter" : "letters";
  // Reveal the first letter once the word is long enough that one character
  // can't basically reconstruct it — a crossword-style hint that keeps the
  // floor useful instead of bare type + length. Short words stay structural
  // so a 1-3 letter word is never given away by its first character.
  if (n >= 4) {
    const first = chars[0].toUpperCase();
    return `${article} ${type}, starts with ${first}, ${n} ${letters}`;
  }
  return `${article} ${type} of ${n} ${letters}`;
}
