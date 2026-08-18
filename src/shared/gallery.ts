// The gallery contract, shared by the archive (writer), the REST handler
// (server), and the gallery screens (client) — the same discipline as
// `types.ts` for the room protocol: one shape, three consumers, no drift.
//
// The room's `reveal` frame stays ephemeral by design; this is the copy that
// goes to disk, so an evening's poems survive "Make another", a server
// restart, and the tab that made them.

import type { WordMark } from "./types.ts";

export interface SavedPoem {
  // Short hex, URL-safe: the permalink at /poem/:id. Short enough to read off
  // a projector and type into a phone.
  id: string;
  createdAt: number; // epoch ms, server clock
  // Same shape as GeneratorOutput, flattened in: a saved poem IS a poem, and
  // the reveal screen and the gallery render from identical fields.
  lines: string[];
  text: string; // lines.join("\n")
  // Where the room's own words landed, so the gallery can show which words
  // were chosen by people and which are the writer's connective tissue.
  // Optional: poems archived before this existed simply render unmarked.
  marks?: WordMark[];
}

// One page of the gallery, newest first. `nextBefore` is the cursor to send
// back as `?before=` for the next (older) page; null when this page ends the
// collection.
export interface PoemPage {
  poems: SavedPoem[];
  nextBefore: string | null;
}

// A single poem plus its neighbors, so /poem/:id can offer older/newer
// navigation without the client holding the whole collection. Null on either
// side means this poem is an end of the collection.
export interface PoemDetail {
  poem: SavedPoem;
  newerId: string | null;
  olderId: string | null;
}

export const DEFAULT_PAGE_SIZE = 20;
// A page ceiling so a hand-written `?limit=100000` can't ask the server to
// serialize the entire evening into one response.
export const MAX_PAGE_SIZE = 100;
