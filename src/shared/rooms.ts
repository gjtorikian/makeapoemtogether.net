// Room identity, shared by the server (which mints codes) and the client (which
// reads them out of a URL or off a typed field). Kept in `shared/` for the same
// reason the wire contract is: a code the two sides disagree about is a room
// nobody can join.

// Whether a room advertises itself. `public` rooms are listed in the lobby and
// joinable by tapping; `private` rooms appear only as a count ("someone is
// making one") and are joinable ONLY by typing their code.
export type RoomVisibility = "public" | "private";

// A public room as advertised in the lobby — occupancy only, exactly like the
// seat view: which poem is happening and how full it is, never a word of it.
export interface LobbyRoom {
  code: string;
  totalSeats: number;
  filled: number; // words already in
  // Unclaimed capacity. Zero means the room is joinable only as audience.
  open: number;
}

// Crockford's base32 — ULID's alphabet. I, L, O and U are absent by design: the
// first three collide visually with 1 and 0, and the fourth is left out so a
// random code can never spell something unfortunate. That property is the whole
// reason to borrow it: this code gets read off a projector and said out loud.
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Four characters: 32^4 ≈ 1.05M codes, which is enormous next to the handful of
// rooms that are ever live at once, and still short enough to type on a phone
// or shout across a room.
export const CODE_LENGTH = 4;

// Mint a code. Uniqueness is the registry's job (it retries on collision) —
// this only promises randomness from the injected source.
export function makeRoomCode(rng: () => number): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    // `Math.min` guards the `rng() === 1` edge an injected generator may hand
    // us, which would otherwise index one past the alphabet.
    const at = Math.min(CODE_ALPHABET.length - 1, Math.floor(rng() * CODE_ALPHABET.length));
    code += CODE_ALPHABET[at];
  }
  return code;
}

// Fold what someone typed into a canonical code, or null if it cannot be one.
// Crockford's decoding rules are the point: `i`/`l` read as 1 and `o` as 0, so
// a guest who types the letter they see on the projector still lands in the
// room. Spaces and dashes are stripped for the same reason — people punctuate
// codes when they write them down.
export function normalizeRoomCode(raw: string): string | null {
  const cleaned = raw
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (cleaned.length !== CODE_LENGTH) return null;
  for (const ch of cleaned) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return cleaned;
}
