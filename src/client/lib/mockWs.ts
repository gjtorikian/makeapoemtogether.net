import type { ClientMsg, ServerMsg, WordType } from "../../shared/types.ts";
import type { Wire, WireHandlers } from "./ws.ts";

// A backend-free playground driver. `main.ts` swaps the real `connect` for this
// when the page is loaded with `?mock=<scene>`, so any screen/state can be
// rendered (and lightly interacted with) against canned `ServerMsg`s on the Vite
// dev server alone. Scenes:
//
//   ?mock=landing       first-visitor lobby, with nothing going on
//   ?mock=lobby         the lobby with public poems listed and a private one pending
//   ?mock=hostConfig    the mood pad + people stepper (main.ts flips ui.configuring)
//   ?mock=hostWaiting   the slot board: claimed, filled, and unclaimed cells
//   ?mock=contributor   the queue from a contributor's seat: in line -> clue -> write
//   ?mock=audience      full room: fill map, reactions, a seat freeing up
//   ?mock=composing     the wait while the poem is being written
//   ?mock=reveal        a finished poem
//
// `send` reacts with plausible follow-ups so the flow is clickable end to end.

// How long the mock sits in `composing` before revealing. Real composition is an
// OpenRouter round trip; this stands in for it so the screen can be seen without
// a key (and without waiting on the network).
const MOCK_COMPOSE_MS = 1800;

// The beat between a word landing and its clue arriving — stands in for the
// real clue writer's OpenRouter round trip.
const MOCK_CLUE_MS = 1200;

const SAMPLE: Extract<ServerMsg, { t: "reveal" }> = {
  t: "reveal",
  poem: {
    lines: [
      "A velvet moon dissolves,",
      "and the restless mountains hum",
      "beneath a purple sky.",
    ],
    text: "A velvet moon dissolves,\nand the restless mountains hum\nbeneath a purple sky.",
  },
};

const NO_POOL: Record<WordType, number> = { adjective: 0, noun: 0, verb: 0 };

// Every mocked room is the same one — the scenes are about screens, not about
// finding a poem, and a fixed code keeps the invite/QR renderings stable.
const MOCK_CODE = "K7QM";

function state(
  over: Partial<Omit<Extract<ServerMsg, { t: "state" }>, "t">> = {},
): ServerMsg {
  return {
    t: "state",
    code: MOCK_CODE,
    visibility: "public",
    phase: "empty",
    totalSeats: 0,
    seats: [],
    pool: NO_POOL,
    activeSeat: null,
    clue: null,
    isHost: false,
    mySeat: null,
    myType: null,
    composingSince: null,
    ...over,
  };
}

function seat(index: number, type: WordType, filled: boolean) {
  return { index, type, filled };
}

function initScene(scene: string, emit: (msg: ServerMsg) => void): void {
  switch (scene) {
    case "hostWaiting":
      emit(
        state({
          phase: "collecting",
          totalSeats: 6,
          isHost: true,
          activeSeat: 1,
          pool: { adjective: 1, noun: 1, verb: 1 },
          seats: [
            seat(0, "adjective", true),
            seat(1, "noun", false),
            seat(2, "verb", false),
          ],
        }),
      );
      break;
    case "contributor": {
      // The queue, from seat 1: in line while seat 0 writes; the clue-pending
      // beat when their word lands; then the clue arrives and the input
      // unlocks.
      const base = {
        phase: "collecting" as const,
        totalSeats: 3,
        mySeat: 1,
        myType: "noun" as const,
        pool: { adjective: 0, noun: 0, verb: 1 },
      };
      emit(
        state({
          ...base,
          activeSeat: 0,
          seats: [seat(0, "adjective", false), seat(1, "noun", false)],
        }),
      );
      setTimeout(() => {
        emit(
          state({
            ...base,
            activeSeat: 1,
            seats: [seat(0, "adjective", true), seat(1, "noun", false)],
          }),
        );
      }, 2600);
      setTimeout(() => {
        emit(
          state({
            ...base,
            activeSeat: 1,
            clue: "soft as expensive fabric",
            seats: [seat(0, "adjective", true), seat(1, "noun", false)],
          }),
        );
      }, 2600 + MOCK_CLUE_MS);
      break;
    }
    case "audience": {
      // Full room, no seat for us: the fill map ticks over, reactions ripple,
      // and midway a seat frees up so the claim button appears.
      const full = [
        seat(0, "adjective", true),
        seat(1, "noun", true),
        seat(2, "verb", false),
        seat(3, "noun", false),
        seat(4, "adjective", false),
        seat(5, "verb", false),
      ];
      emit(
        state({ phase: "collecting", totalSeats: 6, activeSeat: 2, seats: full }),
      );
      setTimeout(() => {
        // A word lands — seat 2 flips filled (the just-filled highlight).
        const filled2 = full.map((s) => (s.index === 2 ? { ...s, filled: true } : s));
        emit(
          state({
            phase: "collecting",
            totalSeats: 6,
            activeSeat: 3,
            seats: filled2,
          }),
        );
      }, 2200);
      setTimeout(() => emit({ t: "reaction", count: 3 }), 3400);
      setTimeout(() => {
        // Seat 4's holder leaves and the seat is released: claimable capacity
        // (its adjective returns to the pool).
        emit(
          state({
            phase: "collecting",
            totalSeats: 6,
            activeSeat: 3,
            pool: { adjective: 1, noun: 0, verb: 0 },
            seats: [
              seat(0, "adjective", true),
              seat(1, "noun", true),
              seat(2, "verb", true),
              seat(3, "noun", false),
              seat(5, "verb", false),
            ],
          }),
        );
      }, 5200);
      setTimeout(() => emit({ t: "reaction", count: 12 }), 6400);
      break;
    }
    case "composing":
      emit(
        state({
          phase: "composing",
          totalSeats: 3,
          mySeat: 0,
          myType: "noun",
          composingSince: Date.now(),
          seats: [
            seat(0, "noun", true),
            seat(1, "adjective", true),
            seat(2, "verb", true),
          ],
        }),
      );
      break;
    case "reveal":
      emit(SAMPLE);
      break;
    case "lobby":
      // A busy lobby: two public poems at different stages of filling, and a
      // private one that shows up only as a count and a code field.
      emit({
        t: "lobby",
        rooms: [
          { code: "K7QM", totalSeats: 6, filled: 4, open: 0 },
          { code: "3XBW", totalSeats: 4, filled: 1, open: 2 },
        ],
        privatePending: 1,
      });
      break;
    case "hostConfig":
    case "landing":
    default:
      // The quiet lobby: nothing in progress, so the visitor is the one who
      // starts it.
      emit({ t: "lobby", rooms: [], privatePending: 0 });
  }
}

function react(msg: ClientMsg, emit: (msg: ServerMsg) => void): void {
  switch (msg.t) {
    case "launch": {
      // Echo the configured mix back as the pool, exactly like the real room —
      // and the chosen visibility, which is what the host's invite renders.
      const counts = msg.counts;
      const total =
        (counts.adjective ?? 0) + (counts.noun ?? 0) + (counts.verb ?? 0);
      emit(
        state({
          phase: "collecting",
          visibility: msg.visibility,
          totalSeats: total,
          isHost: true,
          activeSeat: 0,
          pool: { ...NO_POOL, ...counts },
          seats: [],
        }),
      );
      break;
    }
    case "attach":
      // The mock holds one room, whatever code was asked for: the scenes are
      // about screens, and a "no such room" here would only ever be a dead end.
      emit(state({ phase: "collecting", totalSeats: 3, activeSeat: 0, seats: [] }));
      break;
    case "leave":
      emit({ t: "lobby", rooms: [], privatePending: 0 });
      break;
    case "join": {
      emit({ t: "assigned", index: 1, wordType: "noun" });
      // Seat 0's word is already in, so the fresh seat 1 is the queue head —
      // its clue arrives after the usual writing beat.
      const seats = [seat(0, "adjective", true), seat(1, "noun", false)];
      emit(
        state({
          phase: "collecting",
          totalSeats: 3,
          mySeat: 1,
          myType: "noun",
          activeSeat: 1,
          pool: { adjective: 0, noun: 0, verb: 1 },
          seats,
        }),
      );
      setTimeout(() => {
        emit(
          state({
            phase: "collecting",
            totalSeats: 3,
            mySeat: 1,
            myType: "noun",
            activeSeat: 1,
            clue: "a place where one writes",
            pool: { adjective: 0, noun: 0, verb: 1 },
            seats,
          }),
        );
      }, MOCK_CLUE_MS);
      break;
    }
    case "submit":
      // Mirror the real server's staging: the room parks in `composing` while
      // the poem is written, then reveals the moment it exists.
      emit(
        state({
          phase: "composing",
          totalSeats: 1,
          mySeat: 0,
          myType: "adjective",
          composingSince: Date.now(),
          seats: [seat(0, "adjective", true)],
        }),
      );
      setTimeout(() => emit(SAMPLE), MOCK_COMPOSE_MS);
      break;
    case "release":
      emit(
        state({
          phase: "collecting",
          totalSeats: 3,
          isHost: true,
          activeSeat: 0,
          pool: { adjective: 1, noun: 1, verb: 1 },
          seats: [],
        }),
      );
      break;
    case "cancel":
      emit({ t: "reset" });
      emit({ t: "lobby", rooms: [], privatePending: 0 });
      break;
    case "react":
      // Echo the tap back as a coalesced pulse of one, so the ripple (and its
      // retrigger-on-every-frame behavior) is exercisable without a server.
      emit({ t: "reaction", count: 1 });
      break;
    case "hello":
      // The mock keeps no identities to resume; a replayed token is a no-op.
      break;
  }
}

export function mockWire(scene: string, handlers: WireHandlers): Wire {
  const emit = (msg: ServerMsg) => handlers.onMessage(msg);
  // Deferred so `main.ts` finishes wiring first: its open handler replays
  // `hello` through the wire, which isn't assigned until mockWire returns.
  queueMicrotask(() => {
    handlers.onStatus?.("open");
    initScene(scene, emit);
  });

  return {
    send(msg) {
      queueMicrotask(() => react(msg, emit));
    },
    close() {},
  };
}
