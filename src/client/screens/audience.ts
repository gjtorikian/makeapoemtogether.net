import type { SeatPublic } from "../../shared/types.ts";
import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";
import { poolPlaceholders, seatCellClasses, seatStatusText } from "./board.ts";

// The unseated view: a full room is no error, just a different role. Audience
// members watch the fill map (occupancy ONLY — never words, same structural
// blindness as the host's grid), send ambient tap-reactions, and — when a seat
// frees up mid-round — get a claim button that is nothing more than the normal
// join path. A lost claim race needs no handling: the next state frame simply
// re-renders the button away.
export function Audience(ctx: ScreenCtx): HTMLElement {
  const { state } = ctx;
  const seats = state.seats;
  const total = state.totalSeats;
  const filled = seats.filter((s) => s.filled).length;
  // A grace-held seat (its holder blipped offline) stays listed in `seats`, so
  // it correctly does NOT count as claimable — only genuinely unclaimed
  // capacity does.
  const claimable = state.phase === "collecting" && seats.length < total;

  const grid = el("ul", { class: "seat-grid" }, [
    ...seats.map((s) =>
      seatCell(s, state.justFilledSeat, state.justClaimedSeat),
    ),
    ...poolPlaceholders(state.pool),
  ]);

  return el("main", { class: "screen screen--audience" }, [
    el("h1", { class: "title", text: "You're in the audience." }),
    el("p", {
      class: "subtitle",
      text: "Every word arrives one at a time, in the order submitted. The poem arrives on this screen the same instant it lands on the authors'.",
    }),
    el("p", {
      class: "progress",
      text: `${filled} of ${total} words in`,
    }),
    grid,
    claimable
      ? el(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          // First tap wins server-side; losing just re-renders this away.
          on: { click: () => ctx.send({ t: "join" }) },
        },
        ["Grab a seat"],
      )
      : null,
    // A full poem is no longer a dead end: there may be another one filling up
    // two taps away, and the lobby is where you find out.
    el(
      "button",
      {
        class: "btn btn--quiet",
        type: "button",
        on: { click: () => ctx.send({ t: "leave" }) },
      },
      ["Find another poem"],
    ),
  ]);
}

// No Release button here (that's the host's), no interaction per cell — just
// occupancy plus the shared flash pulses (word landed / holder arrived).
function seatCell(
  seat: SeatPublic,
  justFilled: number | null,
  justClaimed: number | null,
): HTMLElement {
  return el(
    "li",
    { class: seatCellClasses(seat, justFilled, justClaimed) },
    [
      el("span", { class: "seat__type", text: seat.type }),
      el("span", { class: "seat__status", text: seatStatusText(seat) }),
    ],
  );
}
