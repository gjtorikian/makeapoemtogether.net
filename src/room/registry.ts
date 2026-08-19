import { Room, type Effect, type RoomDeps, type RoomSnapshot } from "./room";
import type { LobbyRoom, RoomVisibility } from "../shared/rooms";
import { makeRoomCode } from "../shared/rooms";

// Many rooms, one process. The registry owns the mapping from code to Room and
// nothing else: it mints addresses, hands them out, answers "what is joinable
// right now", and forgets a room the moment it dies. Every rule about how a
// poem is written still lives in Room, which knows about the registry only
// through the code it carries on its `state` frames.
//
// Lifetime is deliberately not reference-counted. A room ends the way it always
// did — cancelled, host gone past the grace window, or idle — and each of those
// paths returns the Room to `empty`, which is the registry's cue to drop it.
// The one addition is the sweep below: a FINISHED room nobody is bound to has
// nothing left to show, so it goes early rather than sitting on its code for
// the ten idle minutes.

export interface RegistryDeps {
  rng: () => number;
  now: () => number;
  // How many rooms may exist at once. Not a product limit so much as a ceiling
  // on what one process will hold: every room carries timers, seats, and a
  // pending composition.
  maxRooms?: number;
  // Everything a Room is built with apart from its identity, which is the
  // registry's to assign.
  roomDeps?: Omit<RoomDeps, "rng" | "now" | "code" | "visibility">;
}

// Random attempts before minting gives up. With 32^4 codes and a maxRooms in
// the dozens, a single collision is already improbable; fifty in a row cannot
// happen outside a scripted rng.
const MINT_ATTEMPTS = 50;

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly maxRooms: number;
  private readonly roomDeps: Omit<RoomDeps, "rng" | "now" | "code" | "visibility">;

  constructor(deps: RegistryDeps) {
    this.rng = deps.rng;
    this.now = deps.now;
    this.maxRooms = deps.maxRooms ?? 64;
    this.roomDeps = deps.roomDeps ?? {};
  }

  get size(): number {
    return this.rooms.size;
  }

  // A fresh room at a free code, or null if the process is already holding as
  // many as it will (or — vanishingly — if minting kept colliding). Null is a
  // "try again in a minute", not a crash: the caller turns it into an error
  // frame.
  create(visibility: RoomVisibility): Room | null {
    if (this.rooms.size >= this.maxRooms) return null;
    const code = this.mintCode();
    if (code === null) return null;
    const room = new Room({
      ...this.roomDeps,
      rng: this.rng,
      now: this.now,
      code,
      visibility,
    });
    this.rooms.set(code, room);
    return room;
  }

  // Put a persisted room back, keeping the code it already had — that code is
  // in address bars, in QR codes, and on the resume tokens of every tab still
  // open, so minting a new one would strand all of them. Null if the process is
  // already full or something else has claimed that code (neither can happen on
  // a clean boot, which is the only time this is called; both are cheap to
  // refuse rather than to reason about).
  restore(snap: RoomSnapshot): { room: Room; effects: Effect[] } | null {
    if (this.rooms.size >= this.maxRooms) return null;
    if (this.rooms.has(snap.code)) return null;
    const restored = Room.restore(snap, {
      ...this.roomDeps,
      rng: this.rng,
      now: this.now,
    });
    this.rooms.set(snap.code, restored.room);
    return restored;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  // What an unbound visitor is offered. Public rooms are listed in creation
  // order — oldest first, so the poem closest to finishing sits at the top —
  // and only while they are still `collecting`: a room being composed or
  // already revealed is not something to join.
  //
  // Private rooms contribute a COUNT and nothing else. That count is the whole
  // reason the code field is offered at all ("someone here is making one"), and
  // it is deliberately the most a stranger can learn.
  lobby(): { rooms: LobbyRoom[]; privatePending: number } {
    const rooms: LobbyRoom[] = [];
    let privatePending = 0;
    for (const room of this.rooms.values()) {
      if (room.phase !== "collecting") continue;
      if (room.visibility === "private") privatePending += 1;
      else rooms.push(room.lobbyView());
    }
    return { rooms, privatePending };
  }

  // Drop rooms that have nothing left to do: any that fell back to `empty` (the
  // Room's own end-of-life), plus finished ones nobody is watching. Returns the
  // codes removed so the caller can unbind whoever was still on them.
  sweep(): string[] {
    const gone: string[] = [];
    for (const [code, room] of this.rooms) {
      const dead =
        room.phase === "empty" ||
        (room.phase === "revealed" &&
          room.memberCount === 0 &&
          // A room restored from disk can finish composing before the phones
          // that were writing it have reconnected. Sweeping it then would throw
          // the reveal away in the seconds people are already on their way back
          // to it, so a room nobody has ever been in waits — for them, or for
          // the idle timeout.
          room.everOccupied);
      if (!dead) continue;
      this.rooms.delete(code);
      gone.push(code);
    }
    return gone;
  }

  private mintCode(): string | null {
    for (let i = 0; i < MINT_ATTEMPTS; i++) {
      const code = makeRoomCode(this.rng);
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }
}
