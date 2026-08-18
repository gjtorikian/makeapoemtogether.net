import { randomUUID } from "node:crypto";
import type {
  GeneratorOutput,
  RoomPhase,
  SeatPublic,
  ServerMsg,
  WordType,
} from "../shared/types";
import type { LobbyRoom, RoomVisibility } from "../shared/rooms";
import { buildPool, drawType, returnType, type Pool } from "./pool";
import { normalizeWord } from "./normalize";
import { fallbackClue } from "../shared/clue";

// Internal event vocabulary the transport adapter feeds the room. This is a
// SUPERSET of the wire `ClientMsg` contract: the server enriches each frame
// with the connection's `clientId` and adds lifecycle events (`connect`,
// `disconnect`, `tick`, `composed`) that have no wire form. Nothing here is
// broadcast — the room only ever emits `ServerMsg`.
export type RoomEvent =
  | { t: "connect"; clientId: string }
  // `counts` is untrusted (it arrives from a client frame), so it is typed as a
  // partial map and normalized/validated in `onLaunch` before use.
  | { t: "launch"; clientId: string; counts: Partial<Record<WordType, number>> }
  | { t: "join"; clientId: string }
  | { t: "submit"; clientId: string; word: string }
  | { t: "release"; clientId: string; index: number }
  | { t: "cancel"; clientId: string }
  | { t: "react"; clientId: string }
  // Presented by a fresh connection to reclaim a parked identity. The token is
  // validated as a string at the transport boundary (toEvent); everything else —
  // existence, expiry, replay — is decided here.
  | { t: "hello"; clientId: string; token: string }
  | { t: "disconnect"; clientId: string }
  // The transport's answer to a `compose` effect. `token` identifies the round
  // that asked for it; a poem for a superseded round is dropped (see onComposed).
  | { t: "composed"; token: number; poem: GeneratorOutput }
  // The transport's answer to a `clue` effect: a hint for the word at `index`,
  // to be shown to the NEXT seat's holder. `word` echoes the word the clue was
  // written for, so a clue for a since-released-and-refilled seat is dropped.
  | { t: "clued"; token: number; index: number; word: string; clue: string }
  | { t: "tick"; now: number };

// An outbound intent: a `ServerMsg` addressed either to one client (`to` is a
// clientId) or to everyone connected (`to === "all"`). The transport fans these
// out; the room stays socket-agnostic.
export interface Outbound {
  to: "all" | string;
  msg: ServerMsg;
}

// A side effect the room wants performed on its behalf — slow, network-touching
// work the room asks for instead of doing. The transport runs it and reports
// back with its own event (`composed` / `clued`), which lands as its own atomic
// transition — the room is never mid-await, so a `cancel` or `disconnect`
// arriving during the work cannot interleave with half-applied state.
//
// `compose` writes the poem when the last slot fills. `clue` writes the hint
// for the word just accepted, destined for the next seat in the queue.
export type Effect =
  | {
      kind: "compose";
      token: number;
      words: Array<{ type: WordType; word: string }>;
    }
  | {
      kind: "clue";
      token: number;
      index: number;
      word: string;
      wordType: WordType;
    };

// What every `handle` call returns. `effects` is empty for all but the
// submission that completes a round.
export interface RoomResult {
  outbound: Outbound[];
  effects: Effect[];
}

// A claimed seat. `type` is fixed once drawn on join; `word` is null until the
// holder submits. `filled` in the public view is derived as `word !== null`.
// `clue` is the hint written ABOUT this seat's word FOR the next seat's holder;
// it lives here (not on the recipient) because the recipient may not have
// claimed their seat yet when the clue arrives.
interface Seat {
  index: number;
  type: WordType;
  clientId: string;
  word: string | null;
  filledAt: number | null;
  clue: string | null;
}

export interface RoomDeps {
  rng: () => number;
  now: () => number;
  // This room's identity in the registry. The room does nothing with either
  // beyond carrying them on `state` frames — the address is the transport's
  // business — but they ride along there so a client always knows which poem it
  // is looking at and whether that poem is listed. Optional (with placeholder
  // defaults) so a room can be driven standalone, with no registry owning it.
  code?: string;
  visibility?: RoomVisibility;
  maxSlots?: number;
  graceMs?: number;
  idleMs?: number;
  // How long to sit in `composing` before giving up on the transport's answer.
  // The composer has its own, shorter timeout and always falls back, so this is
  // a backstop against a transport that never reports at all.
  composeTimeoutMs?: number;
  // How long the queue's next author may be left waiting for a clue before the
  // room writes the deterministic fallback itself. Same belt-and-braces role as
  // `composeTimeoutMs`: the transport's clue writer always answers, so this
  // only fires if that answer is lost entirely.
  clueTimeoutMs?: number;
  // Coalescing window for `react` taps: at most one `reaction` broadcast per
  // window, however hard fifty phones mash.
  reactionWindowMs?: number;
  // Mint a resume token for a fresh connection. Injected so the caller controls
  // where the randomness comes from.
  makeToken?: () => string;
}

// The single in-memory room: a pure-ish state machine over `RoomEvent`s. Every
// transition is synchronous and atomic (single-threaded JS guarantees no
// interleaving), which is what lets the high-risk logic — strict fill, seat
// release, the three reset paths, and the blind reveal — be reasoned about
// here, with no sockets in the picture.
//
// Blindness is structural: the only outbound that can carry a submitted word is
// the final `reveal`. Every interim broadcast is a `state` whose seats expose
// `{ index, type, filled }` and never the word itself.
export class Room {
  readonly code: string;
  readonly visibility: RoomVisibility;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly maxSlots: number;
  private readonly graceMs: number;
  private readonly idleMs: number;
  private readonly composeTimeoutMs: number;
  private readonly clueTimeoutMs: number;
  private readonly reactionWindowMs: number;
  private readonly makeToken: () => string;

  private _phase: RoomPhase = "empty";
  private hostId: string | null = null;
  private total = 0;
  private pool: Pool = [];
  private readonly seats = new Map<number, Seat>();
  // Every connected client, so `state` can be personalized (isHost/mySeat/myType)
  // per recipient. Populated on connect/launch/join, cleared on disconnect.
  private readonly members = new Set<string>();
  private lastActivityAt = 0;
  private hostDisconnectedAt: number | null = null;
  // Monotonic round id for every effect in flight (compose AND clue). Bumped on
  // every reset and on entering `composing`, so a poem — or a clue — that
  // arrives for a superseded round can be recognized and dropped.
  private composeToken = 0;
  private composeStartedAt: number | null = null;
  // Server epoch ms when composing began; carried on `state` frames so every
  // client keys the composing animation off one shared clock. Null otherwise.
  private composingSince: number | null = null;
  // Reaction coalescing: taps accumulate here and flush as one counted
  // broadcast at most once per `reactionWindowMs`.
  private pendingReactions = 0;
  private lastReactionEmit = -Infinity;
  // Resume plumbing. Every connection gets a token at connect (both live maps);
  // on disconnect the identity worth restoring — a seat index or the host role —
  // is parked in `resumable` under that token until `graceMs` expires.
  private readonly tokenByClient = new Map<string, string>();
  private readonly clientByToken = new Map<string, string>();
  private readonly resumable = new Map<
    string,
    { clientId: string; identity: number | "host"; deadline: number }
  >();
  // Unfilled seats whose holder disconnected: held (unclaimable, still counted
  // by strict fill) until the deadline so the owner can resume, then pooled.
  private readonly heldSeats = new Map<number, number>();

  constructor(deps: RoomDeps) {
    this.code = deps.code ?? "0000";
    this.visibility = deps.visibility ?? "public";
    this.rng = deps.rng;
    this.now = deps.now;
    this.maxSlots = deps.maxSlots ?? 12;
    this.graceMs = deps.graceMs ?? 30_000;
    this.idleMs = deps.idleMs ?? 600_000;
    this.composeTimeoutMs = deps.composeTimeoutMs ?? 45_000;
    this.clueTimeoutMs = deps.clueTimeoutMs ?? 15_000;
    this.reactionWindowMs = deps.reactionWindowMs ?? 200;
    this.makeToken = deps.makeToken ?? randomUUID;
  }

  get phase(): RoomPhase {
    return this._phase;
  }

  // Is anyone still watching? The registry uses this to decide when a finished
  // room may be swept — a room nobody is bound to has nothing left to show.
  get memberCount(): number {
    return this.members.size;
  }

  // How this room advertises itself in the lobby: occupancy only, the same
  // blindness the seat view keeps. `open` is unclaimed capacity — a room with
  // none is still joinable, just as audience.
  lobbyView(): LobbyRoom {
    let filled = 0;
    for (const s of this.seats.values()) if (s.word !== null) filled += 1;
    return {
      code: this.code,
      totalSeats: this.total,
      filled,
      open: Math.max(0, this.total - this.seats.size),
    };
  }

  handle(e: RoomEvent): RoomResult {
    let outbound: Outbound[] = [];
    let effects: Effect[] = [];
    switch (e.t) {
      case "connect":
        outbound = this.onConnect(e.clientId);
        break;
      case "launch":
        outbound = this.onLaunch(e.clientId, e.counts);
        break;
      case "join":
        outbound = this.onJoin(e.clientId);
        break;
      case "submit":
        ({ outbound, effects } = this.onSubmit(e.clientId, e.word));
        break;
      case "release":
        outbound = this.onRelease(e.clientId, e.index);
        break;
      case "cancel":
        outbound = this.onCancel(e.clientId);
        break;
      case "react":
        outbound = this.onReact(e.clientId);
        break;
      case "hello":
        outbound = this.onHello(e.clientId, e.token);
        break;
      case "disconnect":
        outbound = this.onDisconnect(e.clientId);
        break;
      case "composed":
        outbound = this.onComposed(e.token, e.poem);
        break;
      case "clued":
        outbound = this.onClued(e.token, e.index, e.word, e.clue);
        break;
      case "tick":
        outbound = this.onTick(e.now);
        break;
    }
    return { outbound, effects };
  }

  // --- handlers -------------------------------------------------------------

  private onConnect(clientId: string): Outbound[] {
    this.members.add(clientId);
    // Every connection gets a resume secret up front. If this socket later
    // drops while holding a seat or the host role, presenting the token via
    // `hello` on a fresh connection reclaims that identity within `graceMs`.
    const token = this.makeToken();
    this.tokenByClient.set(clientId, token);
    this.clientByToken.set(token, clientId);
    // Reply with a private snapshot so a fresh visitor knows whether to launch
    // (empty), join (collecting), or wait (revealed).
    return [
      { to: clientId, msg: { t: "token", value: token } },
      { to: clientId, msg: this.buildState(clientId) },
    ];
  }

  private onLaunch(
    clientId: string,
    counts: Partial<Record<WordType, number>>,
  ): Outbound[] {
    this.members.add(clientId);
    if (this._phase !== "empty") {
      return [this.err(clientId, "room-occupied", "A poem is already in progress.")];
    }
    if (!counts || typeof counts !== "object") {
      return [this.err(clientId, "bad-config", "Missing slot counts.")];
    }
    const norm: Record<WordType, number> = {
      adjective: counts.adjective ?? 0,
      noun: counts.noun ?? 0,
      verb: counts.verb ?? 0,
    };
    if (Object.values(norm).some((n) => !Number.isInteger(n) || n < 0)) {
      return [this.err(clientId, "bad-config", "Counts must be non-negative integers.")];
    }
    const total = norm.adjective + norm.noun + norm.verb;
    if (total < 1 || total > this.maxSlots) {
      return [
        this.err(
          clientId,
          "bad-config",
          `Total slots must be between 1 and ${this.maxSlots}.`,
        ),
      ];
    }
    this.hostId = clientId;
    this.total = total;
    this.pool = buildPool(norm);
    this.seats.clear();
    this.hostDisconnectedAt = null;
    this._phase = "collecting";
    this.lastActivityAt = this.now();
    return this.broadcastState();
  }

  private onJoin(clientId: string): Outbound[] {
    this.members.add(clientId);
    if (this._phase !== "collecting") {
      return [this.err(clientId, "room-busy", "The room is not accepting players right now.")];
    }
    if (this.seatOf(clientId)) {
      return [this.err(clientId, "already-seated", "You already hold a seat.")];
    }
    const index = this.lowestOpenIndex();
    if (index === null) {
      // Full room: no error. The joiner stays a connected member with no seat —
      // the audience role, fully derivable client-side from `mySeat: null` +
      // `phase`. Broadcasting keeps everyone's view current (membership may be
      // new) and tells the joiner where they stand. A later `join` from them is
      // the claim path for any seat that frees up: first request wins, same
      // race as launch day.
      return this.broadcastState();
    }
    const type = drawType(this.pool, this.rng);
    if (type === null) {
      // Should not happen while an open index exists, but stay defensive —
      // and consistent with the no-error audience rule above.
      return this.broadcastState();
    }
    this.seats.set(index, {
      index,
      type,
      clientId,
      word: null,
      filledAt: null,
      clue: null,
    });
    this.lastActivityAt = this.now();
    return [
      { to: clientId, msg: { t: "assigned", index, wordType: type } },
      ...this.broadcastState(),
    ];
  }

  private onSubmit(clientId: string, word: string): RoomResult {
    const only = (o: Outbound): RoomResult => ({ outbound: [o], effects: [] });
    if (this._phase !== "collecting") {
      return only(this.err(clientId, "room-busy", "The room is not collecting words."));
    }
    const seat = this.seatOf(clientId);
    if (!seat) {
      return only(this.err(clientId, "no-seat", "You have no seat to submit to."));
    }
    if (seat.word !== null) {
      return only(this.err(clientId, "already-submitted", "Your word is already in."));
    }
    // The queue: the poem is written strictly in slot order. Only the holder of
    // the active seat (lowest slot still waiting for its word) may submit; the
    // client mirrors this and never shows an early input, so this error is a
    // guard against stale or hand-rolled frames, not a screen anyone sees.
    if (seat.index !== this.activeIndex()) {
      return only(
        this.err(clientId, "not-your-turn", "The poem is written in order — wait for your turn."),
      );
    }
    const r = normalizeWord(word);
    if (!r.ok) {
      return only(this.err(clientId, "invalid-word", `Enter exactly one word (${r.reason}).`));
    }
    seat.word = r.word;
    seat.filledAt = this.now();
    this.lastActivityAt = this.now();
    // Strict fill: the poem is composed iff every configured slot now holds a word.
    if (this.isComplete()) return this.startComposing();
    // A successor slot exists (the round isn't complete), so ask the transport
    // to write the clue its holder will receive. The word leaves the room here
    // exactly like compose's words do — as an effect, never on the wire.
    return {
      outbound: this.broadcastState(),
      effects: [
        {
          kind: "clue",
          token: this.composeToken,
          index: seat.index,
          word: seat.word,
          wordType: seat.type,
        },
      ],
    };
  }

  private onRelease(clientId: string, index: number): Outbound[] {
    if (clientId !== this.hostId) {
      return [this.err(clientId, "forbidden", "Only the host can release seats.")];
    }
    if (this._phase !== "collecting") return [];
    const seat = this.seats.get(index);
    if (!seat) return []; // already open / out of range — nothing to free
    returnType(this.pool, seat.type);
    this.seats.delete(index);
    // Host release overrides a grace hold: the freed seat is claimable now, and
    // a late `hello` from the old holder will find its seat gone and fall
    // through to the normal flow.
    this.heldSeats.delete(index);
    this.lastActivityAt = this.now();
    return this.broadcastState();
  }

  private onCancel(clientId: string): Outbound[] {
    // Once a poem has been revealed there is no in-progress work to protect.
    // Let any visitor begin the next round, including someone who arrived after
    // the reveal and therefore cannot be the original host.
    if (this._phase === "revealed") return this.reset();
    if (clientId !== this.hostId) {
      return [this.err(clientId, "forbidden", "Only the host can cancel.")];
    }
    if (this._phase === "empty") return [];
    return this.reset();
  }

  private onComposed(token: number, poem: GeneratorOutput): Outbound[] {
    // Drop a poem for a round that no longer exists. Between the effect being
    // issued and the transport answering, the host may have cancelled, the grace
    // timer may have fired, or the compose backstop may have reset the room —
    // any of which bumped the token. Revealing here would resurrect a dead round
    // and leak its words to whoever is now in the room.
    if (this._phase !== "composing" || token !== this.composeToken) return [];
    // Straight to the reveal: the moment the poem exists, everyone receives it
    // in the same transition — no countdown beat in between.
    this._phase = "revealed";
    this.composeStartedAt = null;
    this.composingSince = null;
    // Applause accumulated during composing dies with the live phases —
    // reactions are dropped in `revealed`, so a stale flush would be wrong.
    this.pendingReactions = 0;
    this.lastActivityAt = this.now();
    // One identical payload for everyone — the simultaneous blind reveal.
    return [{ to: "all", msg: { t: "reveal", poem } }];
  }

  private onClued(
    token: number,
    index: number,
    word: string,
    clue: string,
  ): Outbound[] {
    // Same staleness discipline as onComposed: the round may have reset (token
    // bumped) or moved to composing while the clue was being written. And the
    // seat itself may have churned — released by the host and refilled with a
    // different word — which the token cannot see, so the clue must also match
    // the word it was written for. `clue !== null` keeps the first answer
    // (transport or tick backstop) authoritative.
    if (this._phase !== "collecting" || token !== this.composeToken) return [];
    const seat = this.seats.get(index);
    if (!seat || seat.word !== word || seat.clue !== null) return [];
    seat.clue = clue.trim() || fallbackClue(word, seat.type);
    this.lastActivityAt = this.now();
    // The broadcast is what delivers the clue: buildState hands it to whichever
    // client now holds the active seat, and only to them.
    return this.broadcastState();
  }

  private onDisconnect(clientId: string): Outbound[] {
    this.members.delete(clientId);
    // A disconnect no longer frees a seat outright: resume tokens mean the
    // same person can come back on a fresh socket, so their identity is parked
    // instead of discarded.
    //   - an UNFILLED seat is grace-held for `graceMs` (unclaimable, still
    //     counted by strict fill), then pooled by the tick sweep;
    //   - a FILLED seat is never freed by disconnect at all — its word is part
    //     of the poem, and strict fill keeps counting it;
    //   - the host role keeps the existing grace timer, and a resumed host
    //     cancels it.
    const seat = this.seatOf(clientId);
    const wasHost = clientId === this.hostId && this._phase !== "empty";
    const token = this.tokenByClient.get(clientId);
    if (token !== undefined) {
      const identity: number | "host" | null = wasHost ? "host" : seat ? seat.index : null;
      if (identity !== null) {
        this.resumable.set(token, {
          clientId,
          identity,
          deadline: this.now() + this.graceMs,
        });
      } else {
        // Seatless non-host: nothing to resume — retire the token binding.
        this.dropToken(token);
      }
    }
    // Host abandoning mid-session starts the grace timer; a later tick past the
    // window resets the room.
    if (wasHost) {
      this.hostDisconnectedAt = this.now();
    }
    if (seat && this._phase === "collecting" && seat.word === null) {
      this.heldSeats.set(seat.index, this.now() + this.graceMs);
      // The hold IS a public-view change (`held` flips true): everyone —
      // especially the host, who can release the seat — must see "connection
      // lost" now, not on whatever broadcast happens next.
      return this.broadcastState();
    }
    // Nothing else changes the public seat view — no broadcast. (Membership
    // shrank, but `state` frames are personalized per member and the departed
    // client is the only one whose view changed.)
    return [];
  }

  private onReact(clientId: string): Outbound[] {
    // Ambiance has no error path: anything outside the live phases (or from a
    // stranger) is silently dropped.
    if (!this.members.has(clientId)) return [];
    if (this._phase !== "collecting" && this._phase !== "composing") return [];
    this.pendingReactions += 1;
    // Immediate-first-then-window: a sporadic tap broadcasts right away; a
    // flood accumulates and rides the next event or tick past the window.
    return this.flushReactions(this.now());
  }

  private onHello(clientId: string, token: string): Outbound[] {
    // Replay guard: a token still bound to a live connection cannot be claimed
    // by a second one. First binding wins — the same race semantics as seats.
    const liveOwner = this.clientByToken.get(token);
    if (
      liveOwner !== undefined &&
      liveOwner !== clientId &&
      this.members.has(liveOwner)
    ) {
      return [this.err(clientId, "token-in-use", "That identity is already connected.")];
    }
    const entry = this.resumable.get(token);
    // Unknown or expired token: silently continue the normal flow — the caller
    // is just a fresh visitor (audience, if the room is full).
    if (!entry || this.now() > entry.deadline) return [];
    if (entry.identity === "host") {
      if (this.hostId !== entry.clientId || this._phase === "empty") {
        this.dropToken(token);
        return [];
      }
      this.hostId = clientId;
      // The reclaim is what cancels the pending room reset.
      this.hostDisconnectedAt = null;
    } else {
      const seat = this.seats.get(entry.identity);
      // The seat may have been released, swept, or (impossibly while held)
      // reclaimed — in every case the identity is stale.
      if (!seat || seat.clientId !== entry.clientId) {
        this.dropToken(token);
        return [];
      }
      seat.clientId = clientId; // word (if any) intact
      this.heldSeats.delete(seat.index);
    }
    // Single-use: the identity now lives under the new connection's own token
    // (issued at connect), so a future disconnect parks it afresh.
    this.dropToken(token);
    this.lastActivityAt = this.now();
    return this.broadcastState();
  }

  private onTick(now: number): Outbound[] {
    if (this._phase === "empty") return [];
    // Backstop against a transport that never answers a compose effect. The
    // composer has its own, shorter timeout and always falls back to the
    // deterministic engine, so this should never fire — but without it a lost
    // answer would strand the room in `composing`, where nobody can launch,
    // join, or submit, until the far longer idle timeout expired.
    if (
      this._phase === "composing" &&
      this.composeStartedAt !== null &&
      now - this.composeStartedAt > this.composeTimeoutMs
    ) {
      return [
        { to: "all", msg: { t: "error", code: "compose-failed", message: "The poem could not be written. Start another round." } },
        ...this.reset(),
      ];
    }
    if (
      this.hostDisconnectedAt !== null &&
      now - this.hostDisconnectedAt > this.graceMs
    ) {
      return this.reset();
    }
    if (now - this.lastActivityAt > this.idleMs) return this.reset();
    const out: Outbound[] = [];
    out.push(...this.sweepHeldSeats(now));
    this.sweepResumable(now);
    out.push(...this.sweepPendingClue(now));
    out.push(...this.flushReactions(now));
    return out;
  }

  // --- internals ------------------------------------------------------------

  // Emit the coalesced reaction pulse if a full window has passed since the
  // last one; otherwise keep accumulating (the next event or tick retries).
  private flushReactions(now: number): Outbound[] {
    if (this.pendingReactions === 0) return [];
    if (this._phase !== "collecting" && this._phase !== "composing") {
      this.pendingReactions = 0;
      return [];
    }
    if (now - this.lastReactionEmit < this.reactionWindowMs) return [];
    // Cap: the count is ambiance, not accounting — a five-digit number would
    // just look broken.
    const count = Math.min(this.pendingReactions, 999);
    this.pendingReactions = 0;
    this.lastReactionEmit = now;
    return [{ to: "all", msg: { t: "reaction", count } }];
  }

  // Pool grace-held seats whose owner never came back. Only unfilled seats are
  // ever held, but re-check `word` defensively — a filled seat must never be
  // pooled.
  private sweepHeldSeats(now: number): Outbound[] {
    let freed = false;
    for (const [index, deadline] of this.heldSeats) {
      if (now <= deadline) continue;
      this.heldSeats.delete(index);
      const seat = this.seats.get(index);
      if (seat && seat.word === null) {
        returnType(this.pool, seat.type);
        this.seats.delete(index);
        freed = true;
      }
    }
    return freed ? this.broadcastState() : [];
  }

  // Backstop against a transport that never answers a clue effect. The clue
  // writer has its own timeout and always degrades to the deterministic clue,
  // so this should never fire — but without it a lost answer would strand the
  // next author on the "waiting for your clue" screen until the idle reset.
  // Only the queue-relevant clue matters: the one for the active seat's
  // predecessor, the single clue anyone is actually waiting on.
  private sweepPendingClue(now: number): Outbound[] {
    if (this._phase !== "collecting") return [];
    const active = this.activeIndex();
    if (active === null || active === 0) return [];
    const prev = this.seats.get(active - 1);
    if (!prev || prev.word === null || prev.clue !== null) return [];
    if (prev.filledAt === null || now - prev.filledAt <= this.clueTimeoutMs) {
      return [];
    }
    prev.clue = fallbackClue(prev.word, prev.type);
    return this.broadcastState();
  }

  // Retire parked identities whose grace window has closed, so a very old
  // token can never resurrect anything.
  private sweepResumable(now: number): void {
    for (const [token, entry] of this.resumable) {
      if (now > entry.deadline) this.dropToken(token);
    }
  }

  // Remove every trace of a token: its live binding (both directions) and any
  // parked identity.
  private dropToken(token: string): void {
    const clientId = this.clientByToken.get(token);
    if (clientId !== undefined) this.tokenByClient.delete(clientId);
    this.clientByToken.delete(token);
    this.resumable.delete(token);
  }

  private seatOf(clientId: string): Seat | undefined {
    for (const s of this.seats.values()) {
      if (s.clientId === clientId) return s;
    }
    return undefined;
  }

  private lowestOpenIndex(): number | null {
    for (let i = 0; i < this.total; i++) {
      if (!this.seats.has(i)) return i;
    }
    return null;
  }

  // The queue head: the lowest slot still waiting for its word, claimed or not.
  // (An unclaimed low slot still blocks everyone behind it — the poem is
  // written in order, so slot i+1 cannot be written before slot i.)
  private activeIndex(): number | null {
    if (this._phase !== "collecting") return null;
    for (let i = 0; i < this.total; i++) {
      const seat = this.seats.get(i);
      if (!seat || seat.word === null) return i;
    }
    return null;
  }

  private poolCounts(): Record<WordType, number> {
    const counts: Record<WordType, number> = { adjective: 0, noun: 0, verb: 0 };
    for (const type of this.pool) counts[type] += 1;
    return counts;
  }

  private isComplete(): boolean {
    if (this.seats.size !== this.total) return false;
    for (const s of this.seats.values()) {
      if (s.word === null) return false;
    }
    return true;
  }

  private orderedSeats(): Seat[] {
    return [...this.seats.values()].sort((a, b) => a.index - b.index);
  }

  private publicSeats(): SeatPublic[] {
    return this.orderedSeats().map((s) => ({
      index: s.index,
      type: s.type,
      filled: s.word !== null, // occupancy/progress only — never the word
      held: this.heldSeats.has(s.index),
    }));
  }

  private buildState(clientId: string): ServerMsg {
    const seat = this.seatOf(clientId);
    const active = this.activeIndex();
    // The clue reaches exactly one client: the holder of the active seat, and
    // only once their predecessor's clue exists. Everyone else — host, audience,
    // queued authors — gets null, which is how the hint stays a private nudge
    // rather than a broadcast leak.
    let clue: string | null = null;
    if (seat && active !== null && seat.index === active && seat.index > 0) {
      clue = this.seats.get(seat.index - 1)?.clue ?? null;
    }
    return {
      t: "state",
      code: this.code,
      visibility: this.visibility,
      phase: this._phase,
      totalSeats: this.total,
      seats: this.publicSeats(),
      pool: this.poolCounts(),
      activeSeat: active,
      clue,
      isHost: clientId === this.hostId,
      mySeat: seat ? seat.index : null,
      myType: seat ? seat.type : null,
      composingSince: this.composingSince,
    };
  }

  private broadcastState(): Outbound[] {
    // One personalized `state` per connected client (isHost/mySeat/myType differ).
    return [...this.members].map((id) => ({ to: id, msg: this.buildState(id) }));
  }

  // Strict fill reached. Hand the words to the transport as an effect and park
  // in `composing` until it answers. The words leave the room here, but they do
  // NOT go on the wire: the accompanying broadcast is an ordinary blind `state`,
  // and only the later `reveal` carries text.
  private startComposing(): RoomResult {
    const words = this.orderedSeats().map((s) => ({
      type: s.type,
      word: s.word as string, // guaranteed non-null by isComplete()
    }));
    this._phase = "composing";
    this.composeToken++;
    this.composeStartedAt = this.now();
    // Shared timestamp for the composing animation: every client keys the same
    // gradient off the same server clock.
    this.composingSince = this.now();
    this.lastActivityAt = this.now();
    return {
      outbound: this.broadcastState(),
      effects: [{ kind: "compose", token: this.composeToken, words }],
    };
  }

  private reset(): Outbound[] {
    this._phase = "empty";
    this.hostId = null;
    this.hostDisconnectedAt = null;
    this.seats.clear();
    this.pool = [];
    this.total = 0;
    // Invalidate any composition still in flight for the round being torn down.
    this.composeToken++;
    this.composeStartedAt = null;
    this.composingSince = null;
    // Ambiance and holds die with the round too.
    this.pendingReactions = 0;
    this.lastReactionEmit = -Infinity;
    this.heldSeats.clear();
    // Every parked identity is round-scoped: a token from before the reset must
    // be dead. Live connections keep their own (unparked) tokens.
    for (const token of [...this.resumable.keys()]) this.dropToken(token);
    this.lastActivityAt = this.now();
    return [{ to: "all", msg: { t: "reset" } }];
  }

  private err(clientId: string, code: string, message: string): Outbound {
    return { to: clientId, msg: { t: "error", code, message } };
  }
}
