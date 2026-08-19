import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WORD_TYPES, type WordType } from "../shared/types.ts";
import type { RoomSnapshot } from "../room/room.ts";

// Poems in flight, on disk, so a restart does not throw away words people have
// already written. Distinct from `archive.ts` in every way that matters: the
// archive is an append-only log of FINISHED poems and grows forever; this is a
// single file holding the CURRENT state of every unfinished room, overwritten
// in place and empty again the moment the last one ends.
//
// A caveat worth stating plainly: this file contains submitted words before
// anyone has seen them, so the blind guarantee now depends on the filesystem as
// well as on the process. That is the same trust boundary the words already sat
// behind — they were in this process's memory either way — but it is a wider
// surface, and DATA_DIR should be treated as server-private.
//
// Design rules are archive.ts's, for the same reasons:
//   1. Never throw. A full disk or a read-only volume must not take down a room
//      that is working perfectly well in memory.
//   2. Injectable dir and clock, so a test can point at a scratch directory.
//
// Writes go to a temp file and are renamed into place, which is atomic on
// POSIX. The archive can get away with plain appends because a torn final line
// costs one poem; here a torn file would cost every room at once.

const FILE_NAME = "rooms.json";
const TEMP_NAME = "rooms.json.tmp";

export interface RoomStore {
  /**
   * Every persisted room still worth restoring. Synchronous because it is
   * called once, at startup, before a single socket exists — there is nothing
   * to block, and doing it inline removes any window where a client could
   * connect to a server whose rooms have not loaded yet.
   */
  load(): RoomSnapshot[];
  /** Persist the given rooms. Never throws; failures are logged. */
  save(snapshots: RoomSnapshot[]): void;
  /**
   * The same write, synchronously — for shutdown, where the process will not
   * live long enough to await a promise.
   */
  saveSync(snapshots: RoomSnapshot[]): void;
}

export interface RoomStoreConfig {
  /** Defaults to DATA_DIR, then ./data. */
  dir?: string;
  now?: () => number;
}

function isWordType(v: unknown): v is WordType {
  return typeof v === "string" && (WORD_TYPES as readonly string[]).includes(v);
}

// A snapshot is trusted only as far as it parses into the exact shape we wrote,
// AND satisfies the invariants the Room is built on. A hand-edited or truncated
// file must not be able to produce a room whose pool and seats disagree about
// how many slots it has — that would be a corrupt poem rather than a lost one,
// and losing it is strictly better.
function parseSnapshot(raw: unknown): RoomSnapshot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const v = raw as Record<string, unknown>;
  if (typeof v.code !== "string" || v.code === "") return null;
  if (v.visibility !== "public" && v.visibility !== "private") return null;
  if (v.phase !== "collecting" && v.phase !== "composing") return null;
  if (typeof v.total !== "number" || !Number.isInteger(v.total) || v.total < 1) {
    return null;
  }
  if (!Array.isArray(v.pool) || !v.pool.every(isWordType)) return null;
  if (!Array.isArray(v.words)) return null;
  if (v.expiresAt !== null && typeof v.expiresAt !== "number") return null;
  if (typeof v.graceMs !== "number" || v.graceMs <= 0) return null;
  if (typeof v.vacantSlotMs !== "number" || v.vacantSlotMs <= 0) return null;

  const words: RoomSnapshot["words"] = [];
  for (const w of v.words as unknown[]) {
    if (typeof w !== "object" || w === null) return null;
    const s = w as Record<string, unknown>;
    if (typeof s.index !== "number" || !Number.isInteger(s.index)) return null;
    if (!isWordType(s.type)) return null;
    if (typeof s.word !== "string" || s.word === "") return null;
    if (s.filledAt !== null && typeof s.filledAt !== "number") return null;
    if (s.clue !== null && typeof s.clue !== "string") return null;
    words.push({
      index: s.index,
      type: s.type,
      word: s.word,
      filledAt: s.filledAt as number | null,
      clue: s.clue as string | null,
    });
  }

  // The invariants. Words are written in strict queue order, so a snapshot's
  // filled seats are always exactly slots 0..n-1; and every slot is either
  // written or still in the pool.
  words.sort((a, b) => a.index - b.index);
  if (words.some((w, i) => w.index !== i)) return null;
  if (words.length + v.pool.length !== v.total) return null;
  // A composing room with nothing to compose is not a room.
  if (v.phase === "composing" && words.length !== v.total) return null;

  return {
    code: v.code,
    visibility: v.visibility,
    phase: v.phase,
    total: v.total,
    pool: v.pool as WordType[],
    words,
    expiresAt: v.expiresAt as number | null,
    graceMs: v.graceMs,
    vacantSlotMs: v.vacantSlotMs,
  };
}

export function createRoomStore(cfg: RoomStoreConfig = {}): RoomStore {
  const dir = cfg.dir ?? process.env.DATA_DIR ?? "./data";
  const now = cfg.now ?? (() => Date.now());
  const file = join(dir, FILE_NAME);
  const temp = join(dir, TEMP_NAME);

  // Serialize writes behind one promise chain, so a slow write and a fast one
  // can never land out of order and leave the older state on disk.
  let writes: Promise<unknown> = Promise.resolve();

  return {
    load(): RoomSnapshot[] {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return []; // no file yet — a fresh server, not an error
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        console.error("[poem] rooms file is unreadable; starting with none");
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      const snapshots: RoomSnapshot[] = [];
      const at = now();
      for (const raw of parsed) {
        const snap = parseSnapshot(raw);
        if (!snap) continue;
        // A poem whose deadline passed while the server was down is over. It
        // would be reset by the first tick anyway; skipping it here means it
        // never briefly reappears in the lobby.
        if (snap.expiresAt !== null && at >= snap.expiresAt) continue;
        snapshots.push(snap);
      }
      return snapshots;
    },

    save(snapshots: RoomSnapshot[]): void {
      const body = JSON.stringify(snapshots);
      const queued = writes.then(async () => {
        try {
          await mkdir(dir, { recursive: true });
          await writeFile(temp, body, "utf8");
          await rename(temp, file);
        } catch (err) {
          console.error("[poem] could not persist rooms in flight", err);
        }
      });
      writes = queued.catch(() => null);
    },

    saveSync(snapshots: RoomSnapshot[]): void {
      try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(temp, JSON.stringify(snapshots), "utf8");
        renameSync(temp, file);
      } catch (err) {
        console.error("[poem] could not persist rooms on shutdown", err);
      }
    },
  };
}
