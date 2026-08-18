// Deterministic seeding for the composer. Every "random" choice in morphology
// and connective realization flows through a Chooser seeded from the word set,
// so a given input always yields the same poem — which is what makes a reveal
// reproducible, and therefore shareable.

// FNV-1a 32-bit hash — stable across runs, machines, and Node versions.
export function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A seeded pseudo-random chooser. Pure given its seed: same seed → same stream.
// The raw [0,1) stream stays private: callers want a choice, not a float, and
// every one of them goes through int/pick/bool.
export interface Chooser {
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniformly pick one element of a non-empty array. */
  pick<T>(arr: readonly T[]): T;
  /** True with probability p (default 0.5). */
  bool(p?: number): boolean;
}

// mulberry32 — small, fast, well-distributed 32-bit PRNG.
export function makeChooser(seed: number): Chooser {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (maxExclusive: number): number =>
    maxExclusive <= 0 ? 0 : Math.floor(next() * maxExclusive);
  const pick = <T>(arr: readonly T[]): T => arr[int(arr.length)];
  const bool = (p = 0.5): boolean => next() < p;
  return { int, pick, bool };
}
