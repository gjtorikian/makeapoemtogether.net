// Transport-agnostic contract shared by the server, room engine, and client.
// Blindness is enforced HERE: the public seat shape carries occupancy only,
// never the submitted word.

import type { LobbyRoom, RoomVisibility } from "./rooms.ts";

export type WordType = "adjective" | "noun" | "verb";

// The canonical order every layer iterates word types in — one source so a
// new type lands in the pool, the boards, and the config pad at once.
export const WORD_TYPES: readonly WordType[] = ["adjective", "noun", "verb"];
// `composing` sits between the last submission and the reveal: the poem is being
// written (an LLM call takes seconds, unlike the deterministic composer). The
// room is closed to joins and submissions while it lasts, and — like every other
// interim phase — carries no words.
//
// `empty` is a room's first and last instant only: the registry mints a room and
// launches it in the same transition, and a room that falls back to `empty` (by
// cancel, host grace, or idle) is disposed of. No client ever sees it — an
// unbound connection gets `lobby` frames instead.
export type RoomPhase = "empty" | "collecting" | "composing" | "revealed";

// Public seat view broadcast to clients — occupancy ONLY (blind).
export interface SeatPublic {
  index: number; // arrival-order position in the poem (0-based)
  type: WordType;
  filled: boolean; // never the word itself
  // True while the holder has dropped offline and the seat is grace-held for
  // their return (still counted by strict fill, not claimable). Boards show
  // "connection lost" instead of pretending someone is typing — and the host
  // can see exactly which seat to release when it blocks the queue. Optional
  // so absent means not held.
  held?: boolean;
}

// Generator boundary (room engine <-> composer)
export interface GeneratorInput {
  words: Array<{ type: WordType; word: string }>; // in arrival order
}
// Where each submitted word landed in the finished poem — a half-open char
// range within `lines[line]`. Computed once, at composition, because it stops
// being knowable the moment the poem is just text: nothing downstream can tell
// a player's "lantern" from a writer's "the".
export interface WordMark {
  line: number;
  start: number;
  end: number;
}

export interface GeneratorOutput {
  lines: string[];
  text: string; // lines.join("\n")
  // In submission order. Optional so a poem archived before this existed (and
  // any generator that doesn't bother) still satisfies the contract.
  marks?: WordMark[];
}

// Client -> Server
//
// Every frame below `attach` is addressed to the room this connection is bound
// to. A connection starts UNBOUND — in the lobby — where the only meaningful
// frames are `launch` (make a room) and `attach` (enter one).
export type ClientMsg =
  // Mint a room and become its host. `visibility` decides whether it is listed
  // in the lobby or reachable by its code alone; `durationMs` is how long the
  // poem has before it expires, which the server re-derives from the shared
  // stop table (see shared/duration.ts) rather than trusting.
  | {
      t: "launch";
      counts: Record<WordType, number>;
      visibility: RoomVisibility;
      durationMs: number;
    }
  // Bind this connection to an existing room by code. Public codes come from
  // the lobby listing; private ones are typed in by someone who was told.
  | { t: "attach"; code: string }
  // Unbind and go back to the lobby, leaving the room to carry on without us.
  | { t: "leave" }
  | { t: "join" } // request a seat; server assigns type + index
  | { t: "submit"; word: string } // the single word for my seat
  | { t: "release"; index: number } // host frees an idle seat
  | { t: "cancel" } // host abandons an active session; anyone can clear a revealed round
  | { t: "react" } // payload-free applause tap; coalesced server-side
  | { t: "hello"; token: string }; // reclaim a seat/host role after a reconnect

// Server -> Client
export type ServerMsg =
  // The unbound view: what an arriving visitor may do instead of a room's
  // state. Sent on connect, on `leave`, when the room a connection was bound to
  // ends — and whenever the listing itself changes, so a lobby left open shows
  // poems appearing and filling in real time.
  //
  // Only PUBLIC rooms are listed. Private ones contribute nothing but a count:
  // enough to say "someone in here is making one" (and so offer the code
  // field), never enough to find it.
  | { t: "lobby"; rooms: LobbyRoom[]; privatePending: number }
  | {
      t: "state";
      // Which room this frame describes. Non-null by construction: `state` only
      // ever reaches a connection bound to a room.
      code: string;
      visibility: RoomVisibility;
      phase: RoomPhase;
      totalSeats: number; // configured capacity; claimed seats are listed below
      seats: SeatPublic[];
      // Remaining unclaimed word types, as counts. Lets every surface render
      // the not-yet-claimed slots (dim placeholders) without leaking anything:
      // the pool holds types the host configured, never words.
      pool: Record<WordType, number>;
      // The queue head: the lowest slot index still waiting for its word. The
      // poem is written in order — only this seat's holder may submit. Null
      // outside `collecting`.
      activeSeat: number | null;
      // Personalized: the clue for the word just before mine, delivered ONLY to
      // the client holding the active seat (null for everyone else, and for
      // seat 0, which writes free). The one sanctioned crack in blindness — a
      // hint about a single neighboring word, never the word itself.
      clue: string | null;
      isHost: boolean;
      mySeat: number | null;
      myType: WordType | null;
      // Server epoch ms when composing began; null outside `composing`. Clients
      // key the synchronized composing gradient off this shared timestamp.
      composingSince: number | null;
      // Server epoch ms at which this poem expires and the room is torn down.
      // Non-null only while `collecting` — the deadline is a limit on how long
      // words may take to arrive, and once the last one has, the round is
      // committed and runs to its reveal. Clients count down against it locally,
      // so a phone with a badly wrong clock shows a wrong number; the reset
      // itself is the server's, and lands as a `reset` frame regardless.
      expiresAt: number | null;
    }
  | { t: "assigned"; index: number; wordType: WordType }
  | { t: "reveal"; poem: GeneratorOutput }
  // Coalesced applause pulse — ambiance, not accounting (count caps at 999).
  | { t: "reaction"; count: number }
  // Per-connection resume secret; presenting it via `hello` on a fresh socket
  // reclaims the seat (word intact) or host role within the grace window.
  | { t: "token"; value: string }
  // This room is over — cancelled, or swept for idleness. Everyone still bound
  // to it is unbound by the same frame and lands back in the lobby; a `lobby`
  // frame follows.
  | { t: "reset" }
  | { t: "error"; code: string; message: string };
