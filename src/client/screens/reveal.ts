import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";
import { copyButton, poemHead, shareButton } from "../lib/poemActions.ts";
import { markedLine } from "../lib/poemMarks.ts";
import { GALLERY_PATH } from "../gallery/route.ts";

// The simultaneous reveal. Every phone entered this screen from the same
// `reveal` frame, so the line materialization below is synchronized across
// the room to broadcast jitter. The sting + vibration for this moment fire in
// main.ts on the `reveal` frame itself — exactly once, on the transition —
// because this function re-runs on every re-render (reaction pulses, banner
// toggles) and must never re-fire an effect.
//
// The poem is ephemeral: one share/copy button is the only way out. "Make
// another" (host only) ends the room — everyone in it lands back in the lobby,
// where the next poem gets made. Everyone else simply leaves, which is a
// different thing on purpose: a late arrival reading the poem must not be able
// to close the room out from under the people still reading it.

// Per-line materialization delay, shared with the stage's reveal: phones and
// projector must stagger identically or the room's choreography drifts (the
// contract's no-duplicated-timing-constants decision).
export const LINE_STAGGER_MS = 140;

export function Reveal(ctx: ScreenCtx): HTMLElement {
  const poem = ctx.state.poem;

  // A visitor who arrives just after a reveal gets a `state` with phase
  // `revealed` but no poem (it was broadcast once, before they connected) —
  // no materialization, no sting. They missed the moment, but no longer the
  // poem: it went to the archive on that same frame, so the gallery link below
  // is the real answer to "what did I just miss?".
  if (!poem) {
    return el("main", { class: "screen screen--reveal" }, [
      el("h1", { class: "title", text: "A poem was just made." }),
      el("p", {
        class: "subtitle",
        text: "You arrived right after the reveal — but it was saved. Read it in the gallery, or start a fresh round.",
      }),
      el(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          on: { click: () => ctx.send({ t: "leave" }) },
        },
        ["Back to the lobby"],
      ),
      el("a", { class: "gallery-link", href: GALLERY_PATH }, [
        "Read the poem I missed →",
      ]),
    ]);
  }

  const lines = el(
    "div",
    { class: "poem", ariaLabel: "The revealed poem" },
    poem.lines.map((line, i) => {
      // The room's own words are marked here as well as in the archive — the
      // moment everyone reads the poem is the moment "which of these were
      // ours?" is actually being asked.
      const lineEl = el("p", { class: "poem__line" }, markedLine(line, poem.marks, i));
      lineEl.style.animationDelay = `${i * LINE_STAGGER_MS}ms`;
      return lineEl;
    }),
  );

  // Copy sits in the heading row above the poem; Share only appears where a
  // native sheet exists. Same controls the gallery's permalink mounts.
  const copyBtn = copyButton(ctx.caps, poem.text, lines);

  const actions = el("div", { class: "reveal__actions" }, [
    shareButton(ctx.caps, poem.text),
    ctx.state.isHost
      ? el(
        "button",
        {
          class: "btn btn--secondary",
          type: "button",
          on: { click: () => ctx.send({ t: "cancel" }) },
        },
        ["Make another"],
      )
      : el(
        "button",
        {
          class: "btn btn--secondary",
          type: "button",
          on: { click: () => ctx.send({ t: "leave" }) },
        },
        ["Back to the lobby"],
      ),
  ]);

  return el("main", { class: "screen screen--reveal" }, [
    poemHead(el("h1", { class: "title", text: "Here's your poem" }), copyBtn),
    lines,
    actions,
    // The poem outlives the round now: it was written to the archive on this
    // same reveal, so "Make another" no longer ends it. A plain link (not a
    // `send`) because the gallery is a different surface, not a room screen.
    el("a", { class: "gallery-link", href: GALLERY_PATH }, [
      "See every poem made →",
    ]),
  ]);
}
