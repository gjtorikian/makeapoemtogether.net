import type { SeatPublic } from "../../shared/types.ts";
import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";
import { markedLine } from "../lib/poemMarks.ts";
import { Composing } from "../screens/composing.ts";
import { LINE_STAGGER_MS } from "../screens/reveal.ts";
import {
  poolPlaceholders,
  seatCellClasses,
  seatStatusText,
} from "../screens/board.ts";
import { joinUrl } from "../lib/roomInvite.ts";
import { countdown } from "../lib/countdown.ts";
import { qrCanvas } from "./qr.ts";

// The projector surface. Same SPA, same state frames, same phase logic — a
// different costume: no seat is ever claimed, no host control is ever rendered
// (unreachable by construction, not by guard clauses), and everything on screen
// arrives via the broadcasts every phone gets, so wire-blindness holds here for
// free. Scale lives in CSS under the `.stage` root class; these functions only
// decide structure.

// Mirror of render.ts's pickScreen, one branch per phase — deliberately the
// same ordering.
export function pickStageScreen(ctx: ScreenCtx): HTMLElement {
  const { state, ui } = ctx;
  // The stage's entry threshold: the operator's tap is what arms the laptop's
  // audio — often the room's best speaker — for the reveal sting.
  if (!ui.entered) return StageEntry(ctx);
  // In no room: the idle QR. An unpinned stage is already watching the lobby
  // for the next public poem to follow, so this is a waiting screen, not a
  // dead end — and it is deliberately not the phone lobby, whose buttons are
  // controls the projector must never own.
  if (state.code === null) return StageIdle(ctx);
  if (state.phase === "revealed") return StageReveal(ctx);
  // The shared composing screen carries the wait; the `.stage` class scales it
  // to projector size. The reveal frame lands the moment the composer answers.
  if (state.phase === "composing") return Composing(ctx);
  if (state.phase === "collecting") return StageCollecting(ctx);
  // `empty` — and `revealed`-with-no-poem falls here too via StageReveal: the
  // idle QR, never the phone Landing (its "Launch poem" is a host control).
  return StageIdle(ctx);
}

// The operator's threshold. Same gesture contract as the phone entry — one tap
// arms audio + wake lock — but its wiring (main.ts's `enter`) sends nothing in
// stage mode: no hello replay, no auto-join.
function StageEntry(ctx: ScreenCtx): HTMLElement {
  return el("main", { class: "screen screen--entry" }, [
    el("h1", { class: "title", text: "Let's make a poem." }),
    el("p", {
      class: "subtitle",
      text: "This screen is the stage: it shows the join code, the poem filling up, and the reveal — for the whole room at once.",
    }),
    el(
      "button",
      {
        class: "btn btn--primary btn--entry",
        type: "button",
        on: { click: () => ctx.enter() },
      },
      ["Open the stage"],
    ),
  ]);
}

// Idle: the QR at maximum size with the origin printed beneath it in large
// type. The printed URL renders unconditionally — QR-hostile phones (cracked
// cameras, old devices) type it instead, and it is the fallback should the
// canvas render fail.
//
// A stage in no room encodes the ORIGIN, not a join link: there is no poem to
// join yet, and what a scanner should land on is the lobby, where they can
// start one. The moment a public poem exists this screen is replaced — an
// unpinned stage follows it (main.ts) without anyone touching the laptop.
function StageIdle(ctx: ScreenCtx): HTMLElement {
  void ctx; // idle renders from location alone; the ctx keeps the signature uniform
  return el("main", { class: "screen stage-idle" }, [
    el("h1", { class: "title", text: "Scan to make a poem" }),
    el("div", { class: "stage-qr stage-qr--big" }, [qrCanvas(location.origin)]),
    el("p", { class: "stage-url", text: location.origin }),
  ]);
}

// Collecting: the fill map dominates — occupancy ONLY, the same structural
// blindness as every other pre-reveal screen — while the QR shrinks to a
// corner so late arrivals can still join.
function StageCollecting(ctx: ScreenCtx): HTMLElement {
  const { state } = ctx;
  const filled = state.seats.filter((s) => s.filled).length;

  const grid = el("ul", { class: "seat-grid" }, [
    ...state.seats.map((s) =>
      stageSeatCell(s, state.justFilledSeat, state.justClaimedSeat),
    ),
    ...poolPlaceholders(state.pool),
  ]);

  return el("main", { class: "screen stage-collecting" }, [
    el("p", {
      class: "progress",
      role: "status",
      text: `${filled} of ${state.totalSeats} words in`,
    }),
    // The room's shared clock, at the size the room can read from the back.
    countdown(state.expiresAt),
    state.seats.length === 0
      ? el("p", { class: "muted stage-waiting", text: "Waiting for the first phone…" })
      : null,
    grid,
    cornerQr(state.code),
  ]);
}

// Same classes as the phone fill map (audience.ts's cells) so the occupancy
// styling and the flash highlights stay single-source — minus every button:
// the stage cell is watchable, never tappable.
function stageSeatCell(
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

// The late-arrival join path during collection: a small fixed QR + URL in the
// corner, out of the fill map's way.
//
// Now that a server holds many poems at once, this QR points at THIS one —
// scanning it lands in the room on the projector, not in the lobby to hunt for
// it. The code is printed alongside for the same reason the URL always was:
// a phone that cannot scan can still be told four characters.
function cornerQr(code: string | null): HTMLElement {
  const target = code === null ? location.origin : joinUrl(code);
  return el("div", { class: "stage-corner" }, [
    el("div", { class: "stage-qr stage-qr--corner" }, [qrCanvas(target)]),
    code !== null
      ? el("p", { class: "stage-code", ariaLabel: `Room code: ${[...code].join(" ")}` }, [code])
      : null,
    el("p", { class: "stage-url stage-url--corner", text: target }),
  ]);
}

// The reveal at projector scale: the same lines, the same per-line stagger
// (LINE_STAGGER_MS is shared with the phone reveal — the choreography must not
// drift), just bigger. No share button, no "Make another": the stage owns no
// controls after the entry tap.
function StageReveal(ctx: ScreenCtx): HTMLElement {
  const poem = ctx.state.poem;

  // A stage opened just after a reveal gets phase `revealed` with no poem (it
  // was broadcast once, before this connection). A poem was already made and a
  // new round is coming — the idle QR is the useful thing to project.
  if (!poem) return StageIdle(ctx);

  const lines = el(
    "div",
    { class: "poem", ariaLabel: "The revealed poem" },
    poem.lines.map((line, i) => {
      // Marked here too: the projector and the phones show the same poem at
      // the same moment, and one of them underlining the room's own words
      // while the other doesn't is a difference the room can see.
      const lineEl = el("p", { class: "poem__line" }, markedLine(line, poem.marks, i));
      lineEl.style.animationDelay = `${i * LINE_STAGGER_MS}ms`;
      return lineEl;
    }),
  );

  return el("main", { class: "screen stage-reveal" }, [lines]);
}

// The stage's version of the reaction pulse: an expanding ring from a random
// position — the "bigger" render of the same coalesced `reaction` frame the
// phones pulse on. One node per frame, never one per tap; the count rides
// along. Called from render()'s single pulse consumer (lastPulseSeq), never
// from a parallel one.
export function stageRipple(count: number): HTMLElement {
  const node = el("div", { class: "stage-ripple", role: "presentation" }, [
    el("span", { class: "stage-ripple__ring" }),
    el("span", { class: "stage-ripple__heart", text: "♥" }),
    count > 1
      ? el("span", { class: "stage-ripple__count", text: `×${count}` })
      : null,
  ]);
  // Random placement inside the middle band of the projection — rings landing
  // somewhere new each frame is what makes fifty taps read as a room, not a
  // metronome. Inline because it is per-instance, not a style.
  node.style.left = `${10 + Math.random() * 80}%`;
  node.style.top = `${20 + Math.random() * 55}%`;
  return node;
}
