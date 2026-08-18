import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { GeneratorOutput, WordMark } from "../shared/types.ts";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type PoemDetail,
  type PoemPage,
  type SavedPoem,
} from "../shared/gallery.ts";

// On-disk permanence for revealed poems: an append-only JSONL file under
// DATA_DIR. One poem per line, in creation order.
//
// Why a flat file and not a database: a poem is ~200 bytes and a loud evening
// produces a few dozen, so the entire collection is smaller than the client
// bundle. Append-only also survives the failure mode this actually has — a
// venue laptop losing power mid-write — by costing at most the last line,
// which `readAll` skips as unparseable rather than refusing to open.
//
// Design rules, matching capabilities.ts on the client:
//   1. Never throw. A full disk, a read-only volume, a missing DATA_DIR — none
//      of it may break a reveal in front of a room full of people. Writes that
//      fail are logged and return null; reads that fail return an empty
//      collection. The poem is still on every screen; only its copy is lost.
//   2. Injectable everything (dir, clock, id), so an archive can be pointed at
//      a scratch directory with deterministic output and no global state.

const FILE_NAME = "poems.jsonl";

export interface PoemArchive {
  /** Persist a revealed poem. Resolves null if the write failed (never throws). */
  save(poem: GeneratorOutput): Promise<SavedPoem | null>;
  /** One page of poems, newest first. */
  list(opts?: { limit?: number; before?: string | null }): Promise<PoemPage>;
  /** One poem plus its older/newer neighbors, or null if the id is unknown. */
  get(id: string): Promise<PoemDetail | null>;
}

export interface ArchiveConfig {
  /** Defaults to DATA_DIR, then ./data. */
  dir?: string;
  now?: () => number;
  newId?: () => string;
}

// 12 hex chars = 48 bits. Collision-safe well past any plausible number of
// poems, and short enough to read aloud off a projector.
function shortId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

// Marks are positions into text that is right there beside them, so they are
// checked against it: a range that doesn't point at real characters would
// render as a stray underline in the middle of a word. Anything questionable
// is dropped and the poem simply reads unmarked. Absent entirely for every
// poem archived before marks existed, which is why this returns [] rather than
// rejecting the line.
function parseMarks(raw: unknown, lines: string[]): WordMark[] {
  if (!Array.isArray(raw)) return [];
  const marks: WordMark[] = [];
  for (const m of raw as Array<Partial<WordMark>>) {
    if (typeof m?.line !== "number" || !Number.isInteger(m.line)) return [];
    if (typeof m.start !== "number" || !Number.isInteger(m.start)) return [];
    if (typeof m.end !== "number" || !Number.isInteger(m.end)) return [];
    const line = lines[m.line];
    if (line === undefined) return [];
    if (m.start < 0 || m.end > line.length || m.start >= m.end) return [];
    marks.push({ line: m.line, start: m.start, end: m.end });
  }
  return marks;
}

// A line is trusted only as far as it parses into the exact shape we wrote.
// Anything else (a half-written final line, a hand-edited file) is skipped, so
// one bad line costs one poem instead of the whole gallery.
function parseLine(line: string): SavedPoem | null {
  try {
    const v = JSON.parse(line) as Partial<SavedPoem>;
    if (typeof v.id !== "string" || v.id === "") return null;
    if (typeof v.createdAt !== "number" || !Number.isFinite(v.createdAt)) {
      return null;
    }
    if (!Array.isArray(v.lines) || v.lines.some((l) => typeof l !== "string")) {
      return null;
    }
    if (typeof v.text !== "string") return null;
    const marks = parseMarks(v.marks, v.lines);
    return {
      id: v.id,
      createdAt: v.createdAt,
      lines: v.lines,
      text: v.text,
      ...(marks.length > 0 ? { marks } : {}),
    };
  } catch {
    return null;
  }
}

export function createArchive(cfg: ArchiveConfig = {}): PoemArchive {
  const dir = cfg.dir ?? process.env.DATA_DIR ?? "./data";
  const now = cfg.now ?? (() => Date.now());
  const newId = cfg.newId ?? shortId;
  const file = join(dir, FILE_NAME);

  // Serialize writes behind one promise chain. `appendFile` on a small buffer
  // is effectively atomic on POSIX, but two reveals can never be worth a
  // torn line — and this costs one variable.
  let writes: Promise<unknown> = Promise.resolve();

  async function append(entry: SavedPoem): Promise<SavedPoem | null> {
    try {
      // recursive: true also makes an existing directory a no-op, so this is
      // both first-run setup and a per-write guard against someone clearing
      // DATA_DIR while the server is up.
      await mkdir(dir, { recursive: true });
      await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    } catch (err) {
      console.error("[poem] could not archive the poem; it stays ephemeral", err);
      return null;
    }
  }

  // The whole collection, newest first. Cheap by construction (see the file
  // note above) — no cache, so a poem written by another process, or a file
  // dropped in by hand, shows up on the next request.
  async function readAll(): Promise<SavedPoem[]> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      return []; // no file yet — an empty gallery, not an error
    }
    const poems: SavedPoem[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      const poem = parseLine(line);
      if (poem) poems.push(poem);
    }
    return poems.reverse(); // file is oldest-first; the gallery is newest-first
  }

  return {
    save(poem: GeneratorOutput): Promise<SavedPoem | null> {
      const entry: SavedPoem = {
        id: newId(),
        createdAt: now(),
        lines: poem.lines,
        text: poem.text,
        // Validated on the way in as well as on the way out: a generator that
        // handed over nonsense positions must not put them on disk.
        ...(poem.marks ? { marks: parseMarks(poem.marks, poem.lines) } : {}),
      };
      const queued = writes.then(() => append(entry));
      // Keep the chain alive whatever happens: `append` already swallows its
      // own failures, and this makes an unexpected throw non-poisoning.
      writes = queued.catch(() => null);
      return queued;
    },

    async list(opts = {}): Promise<PoemPage> {
      const all = await readAll();
      const limit = Math.min(
        Math.max(1, Math.floor(opts.limit ?? DEFAULT_PAGE_SIZE)),
        MAX_PAGE_SIZE,
      );
      // The cursor is the id of the last poem the caller already has; the page
      // starts just after it. An unknown cursor (a deleted poem, a mangled
      // URL) starts from the top rather than 404ing a browse.
      let start = 0;
      if (opts.before) {
        const at = all.findIndex((p) => p.id === opts.before);
        if (at >= 0) start = at + 1;
      }
      const poems = all.slice(start, start + limit);
      const last = poems.at(-1);
      const more = last ? start + poems.length < all.length : false;
      return { poems, nextBefore: more && last ? last.id : null };
    },

    async get(id: string): Promise<PoemDetail | null> {
      const all = await readAll();
      const at = all.findIndex((p) => p.id === id);
      if (at < 0) return null;
      // `all` is newest-first, so the newer neighbor is the PREVIOUS index.
      return {
        poem: all[at],
        newerId: at > 0 ? all[at - 1].id : null,
        olderId: at < all.length - 1 ? all[at + 1].id : null,
      };
    },
  };
}
