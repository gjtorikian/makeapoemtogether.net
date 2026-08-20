import { randomUUID } from "node:crypto";
import { setInterval } from "node:timers";
import { WebSocket, type WebSocketServer, type RawData } from "ws";
import {
  type Effect,
  type Outbound,
  type RoomEvent,
  type RoomResult,
  Room,
} from "../room/room";
import { RoomRegistry } from "../room/registry";
import type { ClientMsg, ServerMsg } from "../shared/types";
import { normalizeRoomCode } from "../shared/rooms";
import type { AsyncComposer } from "../shared/generator.ts";
import type { AsyncClueWriter } from "../engine/clue.ts";
import { composer as deterministic } from "../engine/compose.ts";
import { fallbackClue } from "../shared/clue.ts";
import { composerFromEnv, clueWriterFromEnv } from "./composer.ts";
import { createArchive, type PoemArchive } from "./archive.ts";
import { createRoomStore, type RoomStore } from "./roomStore.ts";
import type { RoomSnapshot } from "../room/room";

const TICK_MS = 1000;

// How often to ping every socket, and how long a socket may go without any
// answer before it is presumed gone.
//
// This exists because a seat is a scarce resource: a room holds exactly as many
// as its host configured, and a seat held by nobody makes that room unjoinable
// for everyone else. TCP alone will not tell us — a laptop that sleeps, a
// dropped wifi link, or a background tab that Chrome discards all leave the
// connection ESTABLISHED with no close frame ever sent, and without a heartbeat
// the room holds that seat until the 10-minute idle backstop.
//
// The two numbers are separate on purpose. Detection has to be FAST, because
// the seat's 30-second hold does not start until the socket is declared dead —
// a slow sweep is time added to a countdown people are watching. But a single
// missed answer must not be fatal: a phone on bad cellular can take seconds to
// reply, and terminating it would eject someone who is merely on a train. So
// ping often (3s) and give up only after a silence several pings long (12s).
const HEARTBEAT_MS = 3_000;
const HEARTBEAT_TIMEOUT_MS = 12_000;

export interface WireRoomOptions {
  composer?: AsyncComposer;
  clueWriter?: AsyncClueWriter;
  heartbeatMs?: number;
  // How long a socket may go without answering before it is torn down. Scaled
  // off `heartbeatMs` when only that is given, so a caller driving the sweep
  // fast for a test does not also have to restate the patience.
  heartbeatTimeoutMs?: number;
  // Where revealed poems are kept. Injectable so a caller can archive somewhere
  // other than the real DATA_DIR — the dev server passes its own.
  archive?: PoemArchive;
  // Where poems still being written are kept, so a restart does not throw away
  // words. Injectable for the same reason as the archive; pass a store over a
  // scratch directory to drive it without touching the real one.
  store?: RoomStore;
  // Tick interval, for driving a room faster than the wall clock. No caller
  // overrides it today; it falls back to the default.
  tickMs?: number;
  // Ceiling on simultaneous rooms in this process.
  maxRooms?: number;
}

// Map an untrusted wire frame to an internal room event, or null to ignore it.
// The lobby verbs (`launch`, `attach`, `leave`) are NOT room events — they
// decide which room a connection is bound to, and are handled before this.
function toEvent(msg: ClientMsg, clientId: string): RoomEvent | null {
  switch (msg.t) {
    case "join":
      return { t: "join", clientId };
    case "submit":
      return { t: "submit", clientId, word: msg.word };
    case "release":
      return { t: "release", clientId, index: msg.index };
    case "cancel":
      return { t: "cancel", clientId };
    case "react":
      return { t: "react", clientId };
    case "hello":
      // The token is untrusted input: anything but a string is a malformed
      // frame and is ignored, the same as an unknown `t`.
      return typeof msg.token === "string"
        ? { t: "hello", clientId, token: msg.token }
        : null;
    default:
      return null;
  }
}

// Wire a registry of rooms to a WebSocket server: a clientId per socket, a room
// binding per client (null while they are in the lobby), frame -> event
// mapping, per-room outbound fan-out, and the 1s tick that drives every room's
// grace / inactivity backstops. Used by BOTH the production server
// (src/server/index.ts) and the Vite dev plugin, so realtime behavior is
// identical under `npm run dev` and `npm start`. Returns a stop() that clears
// the timers.
export function wireRoom(
  wss: WebSocketServer,
  opts: WireRoomOptions = {},
): () => void {
  const composer = opts.composer ?? composerFromEnv();
  const clueWriter = opts.clueWriter ?? clueWriterFromEnv();
  const archive = opts.archive ?? createArchive();
  const store = opts.store ?? createRoomStore();
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
  const heartbeatTimeoutMs =
    opts.heartbeatTimeoutMs ??
    (opts.heartbeatMs === undefined
      ? HEARTBEAT_TIMEOUT_MS
      : opts.heartbeatMs * 4);
  const tickMs = opts.tickMs ?? TICK_MS;

  const registry = new RoomRegistry({
    rng: Math.random,
    now: () => Date.now(),
    maxRooms: opts.maxRooms,
    roomDeps: {
      // The room asks this when someone presents a resume token that is still
      // bound to a connection it believes is here. "Heard from within two
      // heartbeats" is the honest reading of a socket that is still answering;
      // anything quieter is a corpse the room has simply not buried yet, and
      // its identity belongs to whoever holds the secret. See Room.onHello.
      isReachable: (clientId) => {
        const conn = conns.get(clientId);
        if (!conn) return false;
        return Date.now() - conn.lastSeenAt <= heartbeatMs * 2;
      },
    },
  });

  // Every live connection, and which room it is bound to. `code: null` is the
  // lobby — a connection that exists, receives listings, and holds no seat
  // anywhere. Mirrors each Room's own member set for the rooms above it.
  interface Conn {
    ws: WebSocket;
    code: string | null;
    // When we last heard ANYTHING from this socket — a pong, a frame, the
    // connection itself. A socket silent for longer than `heartbeatTimeoutMs`
    // is presumed gone and torn down, which releases its seat through the
    // normal close path. A timestamp rather than a "missed the last ping" flag
    // so one slow reply on a bad connection is survivable.
    lastSeenAt: number;
  }
  const conns = new Map<string, Conn>();
  // code -> the clients bound to it. The room knows its members too; this is
  // the transport's copy, and the one fan-out reads.
  const membersByCode = new Map<string, Set<string>>();

  // The last listing actually sent, as JSON. The lobby is recomputed after
  // every event and every tick, but only pushed when it differs — otherwise a
  // busy room would spam every idle visitor once a second.
  //
  // Seeded with the empty listing rather than "" so the first tick after
  // startup is not a spurious "the lobby changed" push to everyone who just
  // connected and was handed that very listing.
  let lastLobbyJson = JSON.stringify({
    t: "lobby",
    rooms: [],
    privatePending: 0,
  } satisfies ServerMsg);

  function sendTo(clientId: string, msg: ServerMsg): void {
    const conn = conns.get(clientId);
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  // Fan out one room's outbound. `to: "all"` means everyone bound to THAT room —
  // never the lobby, and never another poem's players.
  function dispatch(code: string, outbound: Outbound[]): void {
    const members = membersByCode.get(code);
    for (const o of outbound) {
      if (o.to === "all") {
        if (!members) continue;
        const data = JSON.stringify(o.msg);
        for (const id of members) {
          const conn = conns.get(id);
          if (conn && conn.ws.readyState === WebSocket.OPEN) conn.ws.send(data);
        }
      } else {
        sendTo(o.to, o.msg);
      }
    }
  }

  // Perform an effect off the room's synchronous path, then feed the answer
  // back as its own event. The room decides whether it is still wanted (the
  // token identifies the round), so nothing here needs to know about
  // cancellation. The `.catch`es are belt-and-braces: the configured composer
  // and clue writer both already guarantee an answer, and this makes it
  // structurally impossible for the room to be stranded (in `composing`, or the
  // queue's next author on their waiting screen) by a rejected promise.
  //
  // The room is captured rather than looked up by code: by the time an answer
  // lands, its room may have been swept and a NEW room may hold that code.
  // Feeding one poem's composition to another's players is exactly the leak
  // this closure prevents.
  function runEffect(room: Room, fx: Effect): void {
    if (fx.kind === "compose") {
      const input = { words: fx.words };
      void composer
        .compose(input)
        .catch((err: unknown) => {
          console.error("[poem] composer rejected; using the deterministic poem", err);
          return deterministic.compose(input);
        })
        .then((poem) => {
          apply(room, room.handle({ t: "composed", token: fx.token, poem }));
          settle();
        });
      return;
    }
    // fx.kind === "clue"
    void clueWriter
      .clue({ word: fx.word, type: fx.wordType })
      .catch((err: unknown) => {
        console.error("[poem] clue writer rejected; using the deterministic clue", err);
        return fallbackClue(fx.word, fx.wordType);
      })
      .then((clue) => {
        apply(
          room,
          room.handle({
            t: "clued",
            token: fx.token,
            index: fx.index,
            word: fx.word,
            clue,
          }),
        );
        settle();
      });
  }

  function apply(room: Room, result: RoomResult): void {
    dispatch(room.code, result.outbound);
    archiveReveals(result.outbound);
    for (const fx of result.effects) runEffect(room, fx);
  }

  // Persistence hangs off the transport, not the Room: the Room stays a pure
  // state machine whose only I/O is its declared effects, and a poem's copy on
  // disk is no more its business than the sockets are.
  //
  // Deliberately after `dispatch` and deliberately not awaited — the
  // simultaneous reveal is the trick, and no phone waits on a disk. A failed
  // write is already swallowed and logged by the archive; the poem is on every
  // screen either way.
  function archiveReveals(outbound: Outbound[]): void {
    for (const o of outbound) {
      if (o.msg.t === "reveal") void archive.save(o.msg.poem);
    }
  }

  // --- bindings -------------------------------------------------------------

  // Membership bookkeeping alone — no events, no frames. Split out from
  // `enterRoom` because launching has to record the binding BEFORE the room is
  // known to be viable, so a broadcast during that transition reaches its host.
  function addBinding(clientId: string, code: string): void {
    const conn = conns.get(clientId);
    if (!conn) return;
    conn.code = code;
    let members = membersByCode.get(code);
    if (!members) {
      members = new Set();
      membersByCode.set(code, members);
    }
    members.add(clientId);
  }

  function removeBinding(clientId: string): void {
    const conn = conns.get(clientId);
    if (!conn || conn.code === null) return;
    const members = membersByCode.get(conn.code);
    members?.delete(clientId);
    if (members?.size === 0) membersByCode.delete(conn.code);
    conn.code = null;
  }

  function enterRoom(clientId: string, room: Room): void {
    unbind(clientId);
    addBinding(clientId, room.code);
    // The room's own `connect` is what mints this connection's resume token and
    // hands back its first snapshot.
    apply(room, room.handle({ t: "connect", clientId }));
  }

  // Detach a client from whatever room it is on, telling that room the same
  // thing a dropped socket would: the identity is parked for the grace window,
  // an unfilled seat is held, a filled one keeps its word.
  function unbind(clientId: string): void {
    const code = conns.get(clientId)?.code;
    if (code === undefined || code === null) return;
    removeBinding(clientId);
    const room = registry.get(code);
    if (room) apply(room, room.handle({ t: "disconnect", clientId }));
  }

  function lobbyFrame(): ServerMsg {
    const { rooms, privatePending } = registry.lobby();
    return { t: "lobby", rooms, privatePending };
  }

  // Push the listing to everyone in the lobby, but only when it has actually
  // changed. Called after every applied event and every tick.
  function broadcastLobby(): void {
    const frame = lobbyFrame();
    const json = JSON.stringify(frame);
    if (json === lastLobbyJson) return;
    lastLobbyJson = json;
    for (const [clientId, conn] of conns) {
      if (conn.code === null) sendTo(clientId, frame);
    }
  }

  // Retire dead rooms and return anyone who was still bound to one to the
  // lobby. The room itself has already told them (`reset`); this is the
  // transport half — the binding goes away and the listing takes its place.
  function settle(): void {
    for (const code of registry.sweep()) {
      const members = membersByCode.get(code);
      membersByCode.delete(code);
      if (members) {
        for (const id of members) {
          const conn = conns.get(id);
          if (conn) conn.code = null;
          sendTo(id, lobbyFrame());
        }
      }
    }
    broadcastLobby();
  }

  // --- lobby verbs ----------------------------------------------------------

  function onLaunch(clientId: string, msg: Extract<ClientMsg, { t: "launch" }>): void {
    const conn = conns.get(clientId);
    if (!conn) return;
    // Launching is a lobby action. A bound connection asking for one is a stale
    // or hand-rolled frame — the host config screen is only reachable unbound.
    if (conn.code !== null) {
      sendTo(clientId, {
        t: "error",
        code: "already-in-room",
        message: "You're already in a poem.",
      });
      return;
    }
    const visibility = msg.visibility === "private" ? "private" : "public";
    const room = registry.create(visibility);
    if (!room) {
      sendTo(clientId, {
        t: "error",
        code: "rooms-full",
        message: "Too many poems are being written right now. Try again in a minute.",
      });
      return;
    }
    // Creating and launching are ONE transition from the outside: the binding is
    // recorded, both events run, and only then is anything sent. A room whose
    // configuration the Room rejects never existed as far as the host's screen
    // is concerned — no snapshot of an empty room, no code, no flicker through
    // a room that is about to be swept. They keep the config screen and the
    // error, which is the only useful thing that happened.
    addBinding(clientId, room.code);
    const opened = room.handle({ t: "connect", clientId });
    // `durationMs` rides through untouched: the Room re-derives it from the
    // shared stop table against the visibility it was actually created with, so
    // a hand-rolled frame asking for a week in a public room gets an hour.
    const launched = room.handle({
      t: "launch",
      clientId,
      counts: msg.counts,
      durationMs: msg.durationMs,
    });
    if (room.phase === "empty") {
      removeBinding(clientId);
      registry.delete(room.code);
      for (const o of launched.outbound) {
        if (o.msg.t === "error") sendTo(clientId, o.msg);
      }
      sendTo(clientId, lobbyFrame());
      return;
    }
    apply(room, opened);
    apply(room, launched);
    settle();
  }

  function onAttach(clientId: string, raw: unknown): void {
    const conn = conns.get(clientId);
    if (!conn) return;
    const code = typeof raw === "string" ? normalizeRoomCode(raw) : null;
    const room = code === null ? undefined : registry.get(code);
    if (!room) {
      // The same answer whether the code is malformed, expired, or simply
      // never existed: a stranger guessing at private codes learns nothing
      // from the wording.
      sendTo(clientId, {
        t: "error",
        code: "no-such-room",
        message: "No poem is waiting under that code.",
      });
      return;
    }
    if (conn.code === room.code) return; // already here
    enterRoom(clientId, room);
    settle();
  }

  function onLeave(clientId: string): void {
    unbind(clientId);
    settle();
    sendTo(clientId, lobbyFrame());
  }

  // --- sockets --------------------------------------------------------------

  wss.on("connection", (ws: WebSocket) => {
    const clientId = randomUUID();
    conns.set(clientId, { ws, code: null, lastSeenAt: Date.now() });
    function heard(): void {
      const conn = conns.get(clientId);
      if (conn) conn.lastSeenAt = Date.now();
    }
    // The protocol-level pong is answered automatically by browsers and by `ws`,
    // so this needs nothing from the client.
    ws.on("pong", heard);
    // A fresh visitor starts in the lobby: here is what you may join, or make.
    sendTo(clientId, lobbyFrame());

    ws.on("message", (raw: RawData) => {
      // Any frame at all is proof of life, malformed ones included — a client
      // that can put bytes on this socket has not vanished.
      heard();
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return; // ignore malformed frames
      }
      // Liveness, answered from the lobby and from a room alike. Deliberately
      // first and deliberately room-free: a client asking whether this socket
      // is still real must get an answer even when the poem it was in has
      // ended under it.
      if (msg.t === "ping") {
        sendTo(clientId, { t: "pong" });
        return;
      }
      if (msg.t === "launch") {
        onLaunch(clientId, msg);
        return;
      }
      if (msg.t === "attach") {
        onAttach(clientId, msg.code);
        return;
      }
      if (msg.t === "leave") {
        onLeave(clientId);
        return;
      }
      // Everything else is addressed to a room. From the lobby there is no room
      // to address, so the frame is dropped exactly like an unknown `t`.
      const code = conns.get(clientId)?.code;
      const room = code == null ? undefined : registry.get(code);
      if (!room) return;
      const event = toEvent(msg, clientId);
      if (!event) return;
      apply(room, room.handle(event));
      settle();
    });

    ws.on("close", () => {
      unbind(clientId);
      conns.delete(clientId);
      settle();
    });

    ws.on("error", () => {
      // A close event follows; nothing to do here.
    });
  });

  // --- persistence ----------------------------------------------------------

  // The last state actually written, as JSON. Rooms are snapshotted on every
  // tick but only written when they differ — the same "don't push what hasn't
  // changed" rule the lobby listing follows, and the reason a quiet room costs
  // no disk at all.
  let lastPersisted = "";

  function currentSnapshots(): RoomSnapshot[] {
    const snaps: RoomSnapshot[] = [];
    for (const room of registry.all()) {
      const snap = room.snapshot();
      if (snap) snaps.push(snap);
    }
    return snaps;
  }

  // Deliberately on the tick and NOT on every applied event: a word lands, the
  // reveal is choreographed, and nobody waits on a disk — the same reasoning
  // that keeps `archive.save` off the reveal path. The cost is that a crash can
  // lose up to one tick of writing; a clean shutdown loses nothing (see stop()).
  function persist(): void {
    const snaps = currentSnapshots();
    const json = JSON.stringify(snaps);
    if (json === lastPersisted) return;
    lastPersisted = json;
    store.save(snaps);
  }

  // Put yesterday's unfinished poems back before anything can connect. A room
  // caught mid-composing hands back the effect that died with the old process;
  // running it here is what turns "the server restarted during composition"
  // into a few seconds of the composing screen rather than a lost poem.
  for (const snap of store.load()) {
    const restored = registry.restore(snap);
    if (!restored) continue;
    for (const fx of restored.effects) runEffect(restored.room, fx);
  }
  // Seed the comparison from what is actually on disk, so a boot that changed
  // nothing does not rewrite the file.
  lastPersisted = JSON.stringify(currentSnapshots());

  // Drive every room's grace / inactivity backstops. unref() so the tick alone
  // never keeps the process alive (the listening server does).
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const room of registry.all()) {
      apply(room, room.handle({ t: "tick", now }));
    }
    settle();
    persist();
  }, tickMs);
  ticker.unref();

  // Sweep for clients that have stopped answering and tear them down.
  // `terminate()` (not `close()`) because a half-open socket will never complete
  // a closing handshake — there is nobody left to reply. It emits `close`, so
  // the seat is released by the same path a clean disconnect uses.
  const heart = setInterval(() => {
    const now = Date.now();
    for (const conn of conns.values()) {
      if (now - conn.lastSeenAt > heartbeatTimeoutMs) {
        conn.ws.terminate();
        continue;
      }
      if (conn.ws.readyState === WebSocket.OPEN) conn.ws.ping();
    }
  }, heartbeatMs);
  heart.unref();

  return () => {
    clearInterval(ticker);
    clearInterval(heart);
    // A redeploy is the failure this whole mechanism is for, and it is the one
    // case where we know the process is going: flush synchronously, so the last
    // tick's worth of words goes with it rather than being lost to a promise
    // nobody is around to await.
    store.saveSync(currentSnapshots());
  };
}
