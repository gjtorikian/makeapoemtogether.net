import type { SeatPublic } from "../../shared/types.ts";
import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";
import { roomInvite } from "../lib/roomInvite.ts";
import { countdown } from "../lib/countdown.ts";
import { poolPlaceholders, seatCellClasses, seatStatusText } from "./board.ts";

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
  const { justFilledSeat, justClaimedSeat } = ctx.state;
  return el(
    "li",
    { class: seatCellClasses(seat, justFilledSeat, justClaimedSeat) },
    [
      el("span", { class: "seat__type", text: seat.type }),
      el("span", { class: "seat__status", text: seatStatusText(seat) }),
      el(
        "button",
        {
          class: "btn btn--small",
          type: "button",
          ariaLabel: `Release the ${seat.type} seat`,
          on: { click: () => ctx.send({ t: "release", index: seat.index }) },
        },
        ["Release"],
      ),
    ],
  );
}
