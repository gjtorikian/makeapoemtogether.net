import type { RoomVisibility } from "./rooms.ts";

// How long a poem is given before it expires, and the vocabulary both sides
// speak about it. Shared because the host's slider and the server's validation
// must agree on exactly which durations exist: the client picks a stop, the
// server re-derives it from the same table and never trusts the number.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// The slider's detents, ascending. Deliberately not a linear range — a thumb on
// a phone has to be able to land on each one, and nobody needs the difference
// between seventeen and eighteen hours.
export const DURATION_STOPS: readonly number[] = [
  10 * MINUTE,
  20 * MINUTE,
  30 * MINUTE,
  40 * MINUTE,
  50 * MINUTE,
  60 * MINUTE,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  24 * HOUR,
];

export const PUBLIC_MAX_MS = 60 * MINUTE;

export const DEFAULT_DURATION_MS = 10 * MINUTE;

// The stops a given visibility may choose from. The public list is a prefix of
// the private one, which is what lets the slider keep its index when someone
// toggles from private back to public (see `clampDuration`).
export function stopsFor(visibility: RoomVisibility): readonly number[] {
  return visibility === "private"
    ? DURATION_STOPS
    : DURATION_STOPS.filter((ms) => ms <= PUBLIC_MAX_MS);
}

// Untrusted duration -> one this visibility is allowed to have. Anything that is
// not a number, not a stop, or past this visibility's ceiling becomes the
// nearest legal stop rather than an error: a bad duration is not worth refusing
// a poem over, and the server is the only opinion that counts either way.
export function normalizeDuration(
  raw: unknown,
  visibility: RoomVisibility,
): number {
  const stops = stopsFor(visibility);
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Math.min(DEFAULT_DURATION_MS, stops[stops.length - 1]);
  }
  // Nearest stop, ties going longer — someone who asks for more time and lands
  // between two detents should not be given less than they asked for.
  let best = stops[0];
  for (const ms of stops) {
    if (Math.abs(ms - raw) <= Math.abs(best - raw)) best = ms;
  }
  return best;
}

// Keep a chosen duration legal when visibility changes. Going private widens the
// range and never moves the choice; going public caps it at the hour.
export function clampDuration(ms: number, visibility: RoomVisibility): number {
  const stops = stopsFor(visibility);
  const max = stops[stops.length - 1];
  return ms > max ? max : ms;
}

// The slider's label for a stop: "20 min", "1 hour", "6 hours", "24 hours".
export function formatDuration(ms: number): string {
  if (ms < HOUR) return `${Math.round(ms / MINUTE)} min`;
  const hours = Math.round(ms / HOUR);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

// The countdown's readout. Under an hour it counts seconds ("19:32") because
// that is when seconds start to matter; above it, minutes ("23h 47m") — a
// digit that changes every second on a clock with a day left on it is noise
// nobody reads twice.
export function formatCountdown(msLeft: number): string {
  const left = Math.max(0, msLeft);
  if (left >= HOUR) {
    const hours = Math.floor(left / HOUR);
    const mins = Math.floor((left % HOUR) / MINUTE);
    return `${hours}h ${String(mins).padStart(2, "0")}m`;
  }
  const total = Math.ceil(left / 1000);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

// When the countdown should start reading as a deadline rather than a fact.
export const URGENT_MS = 60_000;

// --- windows that scale with the poem -------------------------------------
//
// Two of the room's waits are really judgements about pace: how long to keep a
// departed host's role for them, and how long to leave a slot nobody is in
// before dropping it from the poem. Fixed constants can only be right for one
// length of poem. At 30 seconds and 20 seconds they were tuned for a room that
// empties in ten minutes, and in a day-long poem they are absurd — closing your
// tab is the NORMAL thing to do in a poem written across an evening, and a slot
// vanishing fifty seconds later would shrink an overnight poem down to whoever
// happened to be awake at the same moment.
//
// So both are a fraction of the poem's own life: 1/20 and 1/30, which come to
// exactly the old 30s and 20s at the ten-minute floor and grow from there. A
// slot therefore survives about 8% of the poem's length before it is dropped,
// whatever length that is.
//
// There is deliberately NO third window for a dropped player's seat. Every
// number tried there was wrong, because one timer was being asked to do two
// jobs: keep a ghost from blocking the queue, and keep your place in line while
// you are away. Thirty seconds served the first and made signing up for a
// six-hour poem meaningless; eighteen minutes served neither. So no timer takes
// a seat away from anyone now — a disconnected seat is held for as long as it
// takes, the boards show how long it has been, and the host is the only thing
// that frees it. The poem's own deadline is the backstop, and it composes what
// is in rather than throwing it away (see Room.expireIntoPoem).
const MIN_GRACE_MS = 30_000;
const MIN_VACANT_SLOT_MS = 20_000;

// How long a departed HOST's role — and any parked resume identity — is held
// for their return. Still scaled: a host who closes their laptop on a day-long
// poem must not have the room handed to a stranger (or reset out from under
// them, when nobody else is in it) a few seconds later.
export function graceFor(durationMs: number): number {
  return Math.max(MIN_GRACE_MS, Math.round(durationMs / 20));
}

// How long the queue waits on a slot with nobody in it before dropping it.
export function vacantSlotFor(durationMs: number): number {
  return Math.max(MIN_VACANT_SLOT_MS, Math.round(durationMs / 30));
}
