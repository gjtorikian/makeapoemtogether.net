import type { SavedPoem } from "../../shared/gallery.ts";
import { el } from "../lib/dom.ts";
import { poemPath } from "./route.ts";

// The poem card and the grid it lives in — shared by the two surfaces that
// show saved poems: the landing screen (inside the room's runtime) and
// /gallery (inside the gallery's). One component, so the shelf looks the same
// wherever you meet it.
//
// The difference between those two surfaces is navigation, and it is the
// `navigate` argument: the gallery routes client-side, while the landing has
// no router — leaving the room to read a poem is a real page load, which is
// also what closes its socket.

export type Navigate = (path: string) => void;

// Poems are stamped with the server's clock and read in the viewer's locale —
// a poem made at a party is remembered by when, not by an id.
const WHEN = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function when(ms: number): string {
  return WHEN.format(new Date(ms));
}

// An anchor that navigates in-page when a router is available, but is a real
// link underneath either way: the href is correct, so long-press-to-copy,
// open-in-new-tab, and a modified click all do what they should. Only a plain
// left click is ever intercepted.
export function navLink(
  href: string,
  cls: string,
  children: (Node | string)[],
  navigate?: Navigate,
): HTMLAnchorElement {
  return el(
    "a",
    {
      class: cls,
      href,
      on: navigate
        ? {
          click: (e: MouseEvent) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            if (e.button !== 0) return;
            e.preventDefault();
            navigate(href);
          },
        }
        : undefined,
    },
    children,
  );
}

function poemCard(
  poem: SavedPoem,
  navigate?: Navigate,
  fresh?: boolean,
): HTMLElement {
  // The class rides on the cell rather than the card so the animation moves the
  // whole grid slot, and it is only ever present on the one paint that first
  // saw this poem — a CSS animation replays every time its class is re-added.
  return el("li", fresh ? { class: "poem-cell--fresh" } : {}, [
    navLink(
      poemPath(poem.id),
      "poem-card",
      [
        el("p", { class: "poem-card__when", text: when(poem.createdAt) }),
        // The opening lines are how someone who was in the room recognizes
        // their poem; CSS clamps the block so cards stay a scannable size
        // whether a poem is three lines or twelve.
        el("p", {
          class: "poem-card__preview",
          text: poem.lines.join("\n"),
        }),
        el("span", {
          class: "poem-card__meta",
          text: `${poem.lines.length} ${poem.lines.length === 1 ? "line" : "lines"}`,
        }),
      ],
      navigate,
    ),
  ]);
}

// `fresh` names the poems that were not on this shelf a moment ago — the lobby
// passes it so a poem finishing in another room floats in rather than simply
// being there. The gallery omits it: every poem on that page is equally old
// news, and a page of poems animating on load is a screensaver.
export function poemGrid(
  poems: SavedPoem[],
  navigate?: Navigate,
  fresh?: ReadonlySet<string>,
): HTMLElement {
  return el(
    "ul",
    { class: "poem-grid", ariaLabel: "Saved poems" },
    poems.map((p) => poemCard(p, navigate, fresh?.has(p.id))),
  );
}
