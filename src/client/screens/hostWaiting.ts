import type { SeatPublic } from "../../shared/types.ts";
import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";
import { roomInvite } from "../lib/roomInvite.ts";
import { countdown } from "../lib/countdown.ts";
import { poolPlaceholders, seatCellClasses, seatStatus } from "./board.ts";

// The host's view while words come in: the WHOLE poem shape, every slot. A
// claimed seat renders occupancy ONLY — its word type, whether the word is in,
// a flash when either just changed — never the submitted word (the public seat
// shape carries no word, so blindness is structural here). The still-unclaimed
// types sit alongside as dim placeholders that light up as arrivals draw them.
// The host can release an idle seat or cancel the whole session.
//
// The invite sits at the top because on a private poem it is the ONLY way
// anyone else gets in: nothing lists that room, so a host who cannot find the
// code is a host with a poem nobody can join.
export function HostWaiting(ctx: ScreenCtx): HTMLElement {
  const seats = ctx.state.seats;

  const grid = el("ul", { class: "seat-grid" }, [
    ...seats.map((s) => seatCell(s, ctx)),
    ...poolPlaceholders(ctx.state.pool),
  ]);

  return el("main", { class: "screen screen--host-waiting" }, [
    el("h1", { class: "title", text: "Gathering words…" }),
    countdown(ctx.state.expiresAt),
    ctx.state.code !== null && ctx.state.visibility !== null
      ? roomInvite(ctx.caps, ctx.state.code, ctx.state.visibility)
      : null,
    seats.length === 0
      ? el("p", {
        class: "muted",
        text: "No one's joined yet",
      })
      : null,
    grid,
    el(
      "button",
      {
        class: "btn btn--danger",
        type: "button",
        on: { click: () => ctx.send({ t: "cancel" }) },
      },
      ["Cancel poem"],
    ),
  ]);
}

function seatCell(seat: SeatPublic, ctx: ScreenCtx): HTMLElement {
  const { justFilledSeat, justClaimedSeat, activeSeat } = ctx.state;
  const held = seat.heldSince != null;
  // The poem is written in slot order, so a dark seat at the head of the queue
  // is not one person's problem — it is the reason nobody else can write. That
  // is the single fact a host needs to act on, and nothing else on this screen
  // says it: the seat next to it looks exactly the same.
  const blocking = held && seat.index === activeSeat;
  return el(
    "li",
    { class: seatCellClasses(seat, justFilledSeat, justClaimedSeat) },
    [
      el("span", { class: "seat__type", text: seat.type }),
      seatStatus(seat),
      blocking
        ? el("span", {
          class: "seat__blocking",
          text: "the poem is waiting on this seat",
        })
        : null,
      el(
        "button",
        {
          class: `btn btn--small${blocking ? " btn--danger" : ""}`,
          type: "button",
          // Releasing a seat is the only way anyone is ever removed from a
          // poem, and it is always a person's decision — so the wording says
          // what it does rather than hinting that a clock is about to do it.
          ariaLabel: held
            ? `Free the ${seat.type} seat for someone else`
            : `Release the ${seat.type} seat`,
          on: { click: () => ctx.send({ t: "release", index: seat.index }) },
        },
        [held ? "Free seat" : "Release"],
      ),
    ],
  );
}
