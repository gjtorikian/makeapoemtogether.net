import type { WordMark } from "../../shared/types.ts";
import { el } from "./dom.ts";

// Rendering the room's own words apart from the writer's connective tissue.
// Shared by the two surfaces that show a whole poem — the reveal and the
// gallery's permalink — so a word is marked identically in the moment it
// appears and in the archive weeks later.
//
// Everything here is defensive: a wrong mark is worse than no mark, because it
// credits the room with a word nobody submitted. Any range that doesn't line up
// with the text yields the plain line.
export function markedLine(
  line: string,
  marks: WordMark[] | undefined,
  index: number,
): (Node | string)[] {
  const mine = (marks ?? [])
    .filter((m) => m.line === index)
    .sort((a, b) => a.start - b.start);
  if (mine.length === 0) return [line];

  const parts: (Node | string)[] = [];
  let at = 0;
  for (const m of mine) {
    // Overlapping, reversed, or past the end of the line: bail out whole.
    if (m.start < at || m.end > line.length || m.start >= m.end) return [line];
    if (m.start > at) parts.push(line.slice(at, m.start));
    parts.push(
      el("span", {
        class: "poem__mine",
        text: line.slice(m.start, m.end),
        // Read aloud as well as seen: a dotted underline says nothing to a
        // screen reader.
        title: "submitted by someone in the room",
      }),
    );
    at = m.end;
  }
  if (at < line.length) parts.push(line.slice(at));
  return parts;
}
