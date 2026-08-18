import { WORD_TYPES, type WordType } from "../shared/types";

// The type pool is the multiset of word types the host configured. A `join`
// draws a random type from the remaining pool; a `release` returns a freed
// seat's type to the pool so the next joiner can draw it again. Building the
// pool in a fixed type order keeps construction deterministic, so the injected
// `rng` alone determines which type a seat gets.
export type Pool = WordType[];

// Build the multiset from the host's per-type counts (e.g. {adjective:2,noun:1}
// → ["adjective","adjective","noun"]).
export function buildPool(counts: Record<WordType, number>): Pool {
  const pool: Pool = [];
  for (const type of WORD_TYPES) {
    const n = counts[type] ?? 0;
    for (let i = 0; i < n; i++) pool.push(type);
  }
  return pool;
}

// Remove and return a random remaining type, or null when the pool is empty.
// `rng` is injected so draws are deterministic under test.
export function drawType(pool: Pool, rng: () => number): WordType | null {
  if (pool.length === 0) return null;
  const raw = Math.floor(rng() * pool.length);
  const i = Math.min(Math.max(raw, 0), pool.length - 1); // guard rng() === 1 / out-of-range
  const [type] = pool.splice(i, 1);
  return type;
}

// Return a released seat's type to the pool (the chosen "return-to-pool" path).
export function returnType(pool: Pool, type: WordType): void {
  pool.push(type);
}
