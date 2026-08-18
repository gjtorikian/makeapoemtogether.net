// Submission integrity helper. The arrival-order / fidelity model depends on
// exactly one normalized token per seat: trim surrounding whitespace, reject
// empty input, and reject anything with interior whitespace (i.e. > 1 word).
// A single non-ASCII / emoji token is intentionally accepted (one token, no
// whitespace) — surreal on-brand input.
export function normalizeWord(
  raw: string,
): { ok: true; word: string } | { ok: false; reason: string } {
  const w = raw.trim();
  if (!w) return { ok: false, reason: "empty" };
  if (/\s/.test(w)) return { ok: false, reason: "multi-word" };
  return { ok: true, word: w };
}
