import type {
  GeneratorOutput,
  RoomPhase,
  SeatPublic,
  ServerMsg,
  WordType,
} from "../shared/types.ts";
import type { LobbyRoom, RoomVisibility } from "../shared/rooms.ts";

// The single source of truth for the client. Every screen is a pure function of
// this state; nothing here is derived locally from game rules. The server's
// `state` / `assigned` / `reveal` / `reset` pushes are folded in by `reduce`,
// which is how the blind guarantee holds in the data layer (not just the UI):
// `poem` is structurally `null` until a `reveal` frame carries it.

// The coalesced applause pulse. `count` is the frame's tap tally (capped
// server-side); `seq` bumps on EVERY frame, even when `count` repeats — the CSS
// ripple retriggers by keying on it, so 50 simultaneous taps are one class
// toggle, never 50 DOM inserts.
export interface ReactionPulse {
  count: number;
  seq: number;
}

// What the lobby offers: the public poems in progress, and how many private
// ones are waiting for someone who knows their code. The count is all the
// server will say about a private room — enough to offer the code field, never
// enough to find it.
export interface LobbyView {
  rooms: LobbyRoom[];
  privatePending: number;
}

export interface AppState {
  // The poem this client is in, or null in the lobby. This is the client's
  // ONE routing fact: null means the lobby's screens, non-null means the
  // room's. Set only by a `state` frame and cleared only by `lobby`/`reset`,
  // both of which are the server saying which side of that line we are on.
  code: string | null;
  visibility: RoomVisibility | null;
  lobby: LobbyView;
  phase: RoomPhase; // empty | collecting | composing | revealed
  totalSeats: number; // configured capacity; may exceed the number of claimed seats
  seats: SeatPublic[]; // occupancy only — never the words
  // Remaining unclaimed word types (counts) — the boards render these as dim
  // placeholder slots that light up as arrivals claim them.
  pool: Record<WordType, number>;
  // The queue head: the slot whose word the room is waiting on. The contributor
  // screen keys its write/wait split on this.
  activeSeat: number | null;
  // The hint about the word just before mine — non-null only when I hold the
  // active seat and the server has the clue ready. Mirrors the wire exactly;
  // no screen ever derives a clue locally.
  myClue: string | null;
  isHost: boolean;
  mySeat: number | null;
  myType: WordType | null;
  poem: GeneratorOutput | null; // null until `reveal`
  error: string | null;
  reactionPulse: ReactionPulse;
  // Server epoch ms when composing began — keys the shared breathing gradient
  // so every phone in the room breathes in the same 4-second cycle.
  composingSince: number | null;
  // Server epoch ms at which this poem expires, or null when nothing is
  // counting down (every phase but `collecting`, and the lobby). The countdown
  // element reads it directly; no screen derives a deadline of its own.
  expiresAt: number | null;
  // The seat whose word landed in the latest `state` frame (the audience
  // screen's recently-filled highlight). Null again on any frame that flips
  // nothing, so a re-broadcast fades the highlight naturally.
  justFilledSeat: number | null;
  // The seat that appeared (someone arrived and drew their type) in the latest
  // `state` frame — the board's light-up-on-arrival flash. Same one-frame
  // lifetime as justFilledSeat.
  justClaimedSeat: number | null;
}

export const initialState: AppState = {
  code: null,
  visibility: null,
  lobby: { rooms: [], privatePending: 0 },
  phase: "empty",
  totalSeats: 0,
  seats: [],
  pool: { adjective: 0, noun: 0, verb: 0 },
  activeSeat: null,
  myClue: null,
  isHost: false,
  mySeat: null,
  myType: null,
  poem: null,
  error: null,
  reactionPulse: { count: 0, seq: 0 },
  composingSince: null,
  expiresAt: null,
  justFilledSeat: null,
  justClaimedSeat: null,
};

// Pure reducer: fold one server message into the next state. Never mutates `s`,
// never reaches outside its arguments — no storage, no clocks. (The resume
// token's sessionStorage write is main.ts's side-channel for exactly that
// reason: this function must stay callable where there is no browser.)
export function reduce(s: AppState, msg: ServerMsg): AppState {
  switch (msg.t) {
    case "state":
      // Dev HMR can update the browser before its in-memory WebSocket backend
      // reloads. Accept an older state frame long enough to keep the UI useful;
      // the server is still authoritative once it reconnects.
      const totalSeats = Number.isFinite(msg.totalSeats)
        ? msg.totalSeats
        : Math.max(s.totalSeats, msg.seats.length);
      return {
        ...s,
        code: msg.code,
        visibility: msg.visibility,
        phase: msg.phase,
        totalSeats,
        seats: msg.seats,
        pool: msg.pool,
        activeSeat: msg.activeSeat,
        myClue: msg.clue,
        isHost: msg.isHost,
        mySeat: msg.mySeat,
        myType: msg.myType,
        // A plain `state` push never carries words. The poem only arrives via
        // `reveal`; drop any stale poem the instant we leave the revealed phase
        // (e.g. a late snapshot for a room that has already moved on).
        poem: msg.phase === "revealed" ? s.poem : null,
        composingSince: msg.composingSince,
        expiresAt: msg.expiresAt,
        // Highlight only a seat this frame flipped from present-and-waiting to
        // filled. Requiring it to have been seen unfilled keeps a fresh
        // visitor's first snapshot (every filled seat "new" to them) calm.
        justFilledSeat:
          msg.seats.find(
            (next) =>
              next.filled &&
              s.seats.some((prev) => prev.index === next.index && !prev.filled),
          )?.index ?? null,
        // Highlight only a seat this frame ADDED while we were already watching
        // the collection — requiring the previous phase to be `collecting`
        // keeps a fresh visitor's first snapshot (every seat "new") calm, the
        // same discipline as justFilledSeat.
        justClaimedSeat:
          s.phase === "collecting" && msg.phase === "collecting"
            ? (msg.seats.find(
                (next) => !s.seats.some((prev) => prev.index === next.index),
              )?.index ?? null)
            : null,
        error: null,
      };
    case "assigned":
      return { ...s, mySeat: msg.index, myType: msg.wordType, error: null };
    case "reveal":
      // The one frame that may carry words — everyone receives it at once.
      return {
        ...s,
        phase: "revealed",
        poem: msg.poem,
        composingSince: null,
        // The poem exists; nothing is racing a clock any more.
        expiresAt: null,
        error: null,
      };
    case "lobby":
      // A lobby frame is the server saying "you are in no room" — it is only
      // ever sent to an unbound connection. Everything room-shaped goes with
      // it, which is how leaving a poem, and a poem ending under us, are the
      // same transition in the client.
      //
      // `error` survives on purpose: "No poem is waiting under that code" must
      // not be wiped a second later by an unrelated room filling up.
      return {
        ...initialState,
        lobby: { rooms: msg.rooms, privatePending: msg.privatePending },
        error: s.error,
      };
    case "reset":
      // The room ended. Keep the last listing we had so the lobby has something
      // to show in the instant before the `lobby` frame that follows.
      return { ...initialState, lobby: s.lobby };
    case "error":
      // Resume plumbing, not something the visitor did: `already-seated` is a
      // redundant join landing just after a successful resume, and
      // `token-in-use` is a second tab finding the first one still in the room
      // (the stored secret stays put — that first tab is using it). Surfacing
      // either would flash an error at someone who merely opened a link.
      if (msg.code === "token-in-use" || msg.code === "already-seated") return s;
      return { ...s, error: msg.message };
    case "reaction":
      return {
        ...s,
        reactionPulse: { count: msg.count, seq: s.reactionPulse.seq + 1 },
      };
    case "pong":
      // Liveness only, and the wire already swallows it (see lib/ws.ts). The
      // case exists so the reducer stays exhaustive over `ServerMsg` — which is
      // what guarantees a future frame type cannot be silently ignored.
      return s;
    case "token":
      // Deliberately a no-op: persisting the resume secret is a side effect
      // (sessionStorage), which main.ts owns. Keeping the secret out of state
      // also keeps it out of anything a screen could ever render.
      return s;
  }
}
