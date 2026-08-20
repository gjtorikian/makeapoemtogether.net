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
  // Server epoch ms at which this seat's holder dropped offline. Absent (or
  // null) means nobody has dropped — the seat is simply claimed.
  //
  // A start time, not a deadline, because nothing is counting down: no timer
  // ever takes a seat away from the person holding it. The boards count this
  // UP ("connection lost · 4:32") so the length of an absence is legible, and
  // the host — the only one who can free a seat — has something to judge by.
  // Absolute, like `expiresAt`, so every screen reads the same server clock
  // without the room re-broadcasting a number once a second.
  heldSince?: number | null;
  // Server epoch ms at which the poem became THIS holder's to write, and null
  // for every seat but the one whose turn it is.
  //
  // Deliberately not "when they sat down". Claiming a seat early in a six-hour
  // poem and waiting an hour for the queue to reach you is the system working;
  // a clock counting that would read as a person being slow when they have not
  // been asked for anything yet. So it starts at the later of the two moments
  // that must both have happened — the queue arriving at this slot, and this
  // person taking it — which is the first instant they could have written.
  batonSince?: number | null;
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
  | { t: "hello"; token: string } // reclaim a seat/host role after a reconnect
  // Liveness, asked by the CLIENT. The server has its own protocol-level ping
  // for the other direction; this is the one a phone waking from a locked
  // screen needs, because a socket the OS quietly tore down still reads as OPEN
  // from JavaScript and would otherwise be talked into forever. Answered by
  // `pong` and nothing else — it touches no room and holds no seat.
  | { t: "ping" };

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
  // The answer to a client `ping`. Carries nothing: its arrival IS the payload.
  | { t: "pong" }
  | { t: "error"; code: string; message: string };
