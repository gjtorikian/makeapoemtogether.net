import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";

// One full breath of the shared composing gradient, in ms. Long enough to read
// as calm, short enough that clock skew between phones stays invisible.
const BREATHE_MS = 4000;

// The gap between the last submission and the reveal. It exists because writing
// the poem can now take seconds rather than microseconds — and because the wait
// is shared, it is worth showing rather than hiding: everyone in the room sits
// on this screen at the same time, and the reveal lands for all of them at once.
//
// Deliberately blind, like every other interim screen: it can say how many words
// went in, but never which. `state.poem` is still structurally null here.
export function Composing(ctx: ScreenCtx): HTMLElement {
  const { state } = ctx;
  const count = state.totalSeats || state.seats.length;

  // The breathing gradient, phase-locked across the room: every phone drops
  // into the same point of the loop by keying a negative animation-delay off
  // the server's `composingSince` epoch. Phone clocks are NTP-close enough for
  // a 4-second cycle; one phone breathing out of phase is invisible in a room.
  const gradient = el("div", { class: "composing__gradient" });
  if (state.composingSince !== null) {
    const into =
      (((Date.now() - state.composingSince) % BREATHE_MS) + BREATHE_MS) %
      BREATHE_MS;
    gradient.style.animationDelay = `-${into}ms`;
  }

  return el("main", { class: "screen screen--composing" }, [
    gradient,
    el("h1", { class: "title", text: "Every slot is full." }),
    el("p", {
      class: "subtitle",
      text:
        count > 0
          ? `${count} words are being woven into one poem. This takes a moment.`
          : "The words are being woven into one poem. This takes a moment.",
    }),
    // Kept even when reduced motion hides the gradient: screen readers (and
    // anyone else) get the status line, not the choreography.
    el("p", {
      class: "pulse",
      role: "status",
      ariaLabel: "Composing the poem",
      text: "Composing…",
    }),
  ]);
}
