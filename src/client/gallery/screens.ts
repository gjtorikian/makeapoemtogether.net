import type { PoemDetail, SavedPoem } from "../../shared/gallery.ts";
import type { Capabilities } from "../lib/capabilities.ts";
import { el } from "../lib/dom.ts";
import { markedLine } from "../lib/poemMarks.ts";
import { copyButton, poemHead, shareButton } from "../lib/poemActions.ts";
import { navLink, poemGrid, when, type Navigate } from "./cards.ts";
import { GALLERY_PATH, poemPath } from "./route.ts";

// The gallery's screens. Same shape as the room's: pure functions from data to
// a DOM node, no fetching and no state of their own (mount.ts owns both).
//
// The room is a live thing you are inside; the gallery is a shelf you browse.
// It shares the app's type and color, but nothing here animates on a clock,
// nothing pulses, and nothing can change under the reader.

export type { Navigate };

function backToRoom(): HTMLElement {
  // A full page load on purpose: leaving the gallery for the room means
  // opening a socket, which is main.ts's boot, not a client-side route.
  return el("a", { class: "gallery__exit", href: "/" }, ["← "]);
}

export function LoadingScreen(): HTMLElement {
  return el("main", { class: "screen screen--gallery" }, [
    el("p", { class: "muted", text: "Fetching the poems…" }),
  ]);
}

export function ErrorScreen(message: string, retry: () => void): HTMLElement {
  return el("main", { class: "screen screen--gallery" }, [
    el("h1", { class: "title", text: "Hmm." }),
    el("p", { class: "error", text: message }),
    el(
      "button",
      { class: "btn btn--primary", type: "button", on: { click: retry } },
      ["Try again"],
    ),
    backToRoom(),
  ]);
}

export interface ListProps {
  poems: SavedPoem[];
  /** Non-null when older poems remain; drives the "Show older" button. */
  nextBefore: string | null;
  loadingMore: boolean;
  onOlder: () => void;
  navigate: Navigate;
}

export function GalleryList(props: ListProps): HTMLElement {
  const { poems, nextBefore, loadingMore, onOlder, navigate } = props;

  if (poems.length === 0) {
    return el("main", { class: "screen screen--gallery" }, [
      el("h1", { class: "title", text: "Nothing here yet" }),
      el("p", {
        class: "subtitle",
        text: "Once a room finishes a poem, it lands here and stays.",
      }),
      backToRoom(),
    ]);
  }

  return el("main", { class: "screen screen--gallery" }, [
    el("h1", { class: "title", text: "The gallery" }),
    el("p", {
      class: "subtitle",
      text: "Every poem this room has finished, newest first.",
    }),
    poemGrid(poems, navigate),
    nextBefore
      ? el(
        "button",
        {
          class: "btn btn--secondary",
          type: "button",
          disabled: loadingMore,
          on: { click: onOlder },
        },
        [loadingMore ? "Loading…" : "Show older poems"],
      )
      : el("p", { class: "muted", text: "" }),
    backToRoom(),
  ]);
}

export interface PoemProps {
  detail: PoemDetail;
  caps: Capabilities;
  navigate: Navigate;
}

export function PoemView(props: PoemProps): HTMLElement {
  const { detail, caps, navigate } = props;
  const { poem, newerId, olderId } = detail;

  // No stagger here: the line-by-line materialization belongs to the reveal,
  // where the room is watching it happen together. A poem you came back to
  // read is simply there.
  const lines = el(
    "div",
    { class: "poem poem--static", ariaLabel: "The poem" },
    poem.lines.map((line, i) =>
      el("p", { class: "poem__line" }, markedLine(line, poem.marks, i)),
    ),
  );

  return el("main", { class: "screen screen--gallery-poem" }, [
    navLink(GALLERY_PATH, "gallery__up", ["← "], navigate),
    // Copy in the upper right, across from the poem's date.
    el("nav", { class: "poem-nav", ariaLabel: "Nearby poems" }, [
      newerId
        ? navLink(poemPath(newerId), "btn btn--secondary btn--small", ["← Newer"], navigate)
        : el("span", { class: "poem-nav__end", text: "Newest" }),
      olderId
        ? navLink(poemPath(olderId), "btn btn--secondary btn--small", ["Older →"], navigate)
        : el("span", { class: "poem-nav__end", text: "Oldest" }),
    ]),
    poemHead(
      el("p", { class: "poem-when", text: when(poem.createdAt) }),
      el("div", { class: "poem__actions" }, [
        copyButton(caps, poem.text, lines),
        shareButton(caps, poem.text),
      ])),
    lines,
    // Without this the underline is a mystery. Only shown when there is
    // something underlined to explain.
    poem.marks?.length
      ? el("p", { class: "poem-legend" }, [
        el("span", { class: "poem__mine", text: "Dotted words" }),
        " were submitted by the room.",
      ])
      : null,
  ]);
}
