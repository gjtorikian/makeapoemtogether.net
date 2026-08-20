import { WORD_TYPES, type SeatPublic, type WordType } from "../../shared/types.ts";
import { el } from "../lib/dom.ts";
import { holdTimer } from "../lib/countdown.ts";

// The slot board's shared pieces. Every surface (host, audience, stage) now
// renders the WHOLE poem shape: claimed seats plus one dim placeholder per
// word type still waiting in the pool — so "two nouns and a verb still need
// people" is visible before anyone arrives, and a cell lights up the moment an
// arrival randomly draws it. Occupancy and types only; never a word.

// Expand the remaining-pool counts into one placeholder cell per unclaimed
// type, grouped in a fixed order (the server's draw order is random, so counts
// are all it broadcasts).
export function poolPlaceholders(pool: Record<WordType, number>): HTMLElement[] {
  const cells: HTMLElement[] = [];
  for (const type of WORD_TYPES) {
    for (let i = 0; i < (pool[type] ?? 0); i++) {
      cells.push(
        el("li", { class: "seat seat--open" }, [
          el("span", { class: "seat__type", text: type }),
          el("span", { class: "seat__status", text: "no one yet" }),
        ]),
      );
    }
  }
  return cells;
}

// The class list for a claimed seat's cell: waiting/filled state, the
// grace-held marker, plus the two one-frame flashes — green when its word just
// landed, accent when its holder just arrived and drew the type.
export function seatCellClasses(
  seat: SeatPublic,
  justFilled: number | null,
  justClaimed: number | null,
): string {
  return [
    "seat",
    seat.filled ? "seat--filled" : "seat--waiting",
    seat.heldSince != null ? "seat--held" : "",
    seat.index === justFilled ? "seat--just-filled" : "",
    seat.index === justClaimed ? "seat--just-claimed" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// One honest status line per seat state. "connection lost…" matters most: a
// held ghost pretending to be "someone's on it…" reads as a phantom player —
// and in a queue it silently blocks everyone behind it.
export function seatStatusText(seat: SeatPublic): string {
  if (seat.filled) return "word in";
  if (seat.heldSince != null) return "connection lost";
  return "someone's on it…";
}

// The status line as a node, because a held seat's carries a live clock —
// counting UP, because nothing is going to take the seat away at any number.
// It is there to be judged: the host reads it and decides (there is a Release
// button beside it on their screen), and everyone else reads it to understand
// why the queue is not moving. "Connection lost" alone was the thing that made
// a dropped player look permanent and unaccountable.
export function seatStatus(seat: SeatPublic): HTMLElement {
  return el("span", { class: "seat__status" }, [
    seatStatusText(seat),
    holdTimer(seat.heldSince),
  ]);
}
