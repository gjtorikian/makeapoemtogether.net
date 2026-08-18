import type { LobbyRoom } from "../../shared/rooms.ts";
import { CODE_ALPHABET, CODE_LENGTH, normalizeRoomCode } from "../../shared/rooms.ts";
import type { ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";
import { poemGrid } from "../gallery/cards.ts";
import { GALLERY_PATH } from "../gallery/route.ts";

// The lobby: the screen a visitor meets before they are in any poem at all, and
// the one they come back to when a round ends. Three ways out of it, in the
// order they matter to someone standing in a room where this is already
// happening:
//
//   1. join a public poem that is filling up right now,
//   2. type the code for a private one somebody told them,
//   3. start their own — public (listed here for strangers) or private (a code
//      to hand out, and nothing on this screen but a count).
//
// Below the fold: the poems already made. The lobby is the screen the app sits
// on between rounds, so the archive belongs HERE rather than behind a link —
// what an arriving guest wants is to see what this thing produces, and a wall
// of finished poems answers that better than a sentence about it.

// Enough to fill the screen and prove the point without turning the lobby into
// the gallery — /gallery is where the whole collection lives.
const LANDING_MAX = 12;

// What a code field accepts as it is typed. Crockford's folding happens per
// keystroke (the `1` someone types for the `I` they think they see lands as a
// `1` on screen, so what they read back is what will be sent), and characters
// the alphabet has no room for simply never appear.
//
// Deliberately NO length cap — the same lesson the people field learned. A
// fifth character must READ as too long, with Join dead, rather than being
// trimmed behind the typist into a legal code for somebody else's poem.
function sanitizeCodeEntry(raw: string): string {
  const folded = raw.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0");
  return [...folded].filter((ch) => CODE_ALPHABET.includes(ch)).join("");
}

export function Landing(ctx: ScreenCtx): HTMLElement {
  const { rooms, privatePending } = ctx.state.lobby;
  const poems = ctx.ui.recentPoems ?? [];
  const shown = poems.slice(0, LANDING_MAX);
  // More than fits, or more than this page fetched.
  const hasMore = poems.length > shown.length || ctx.ui.morePoems;
  const quiet = rooms.length === 0 && privatePending === 0;

  return el("main", { class: "screen screen--landing" }, [
    el("h1", {
      class: "title",
      // Nothing going on is worth saying out loud: it means whoever is holding
      // this phone is the one who starts it.
      text: quiet ? "You're the first one here!" : "Let's make a poem.",
    }),
    el("p", {
      class: "subtitle",
      text: quiet
        ? "Start a collaborative poem. Everyone who joins becomes a co-author — each adds one word, in turn, with only a clue about the word before theirs. The poem reveals to everyone at once when every slot is filled."
        : "Join one of the poems being written right now, or start your own. Each person adds one word, in turn, with only a clue about the word before theirs — and the poem reveals to everyone at once.",
    }),
    // The error lives at the top of the lobby because the only thing that
    // produces one here is a code that didn't work, and the field is right
    // below it.
    ctx.state.error
      ? el("p", { class: "lobby__error", role: "alert", text: ctx.state.error })
      : null,
    rooms.length > 0 ? openRooms(rooms, ctx) : null,
    privatePending > 0 ? privateEntry(ctx) : null,
    // One label, always. It is tempting to say "Launch poem" on a quiet lobby
    // and "Start a new poem" on a busy one, but a control that renames itself
    // depending on what strangers elsewhere are doing is a control nobody can
    // learn — and it is the same action either way. Only its prominence
    // changes: primary when it is the only thing to do here, secondary when
    // there are poems to join above it.
    el(
      "button",
      {
        class: quiet ? "btn btn--primary" : "btn btn--secondary",
        type: "button",
        on: {
          click: () => {
            ctx.ui.configuring = true;
            ctx.rerender();
          },
        },
      },
      ["Start a new poem"],
    ),
    // Nothing at all until there is something to show: a fresh install's
    // lobby looks exactly as it did before any of this existed, with no
    // empty shelf and no dead link.
    shown.length > 0
      ? el("section", { class: "landing__archive" }, [
        // No `navigate`: the room has no router, so a card is a real page
        // load into the gallery — which is also what closes this socket.
        poemGrid(shown),
        hasMore
          ? el("a", { class: "gallery-link", href: GALLERY_PATH }, [
            "See all of them →",
          ])
          : null,
      ])
      : null,
  ]);
}

// The public poems, oldest first — the one closest to finishing sits at the
// top, which is also the one where a late arrival is most useful. Each card is
// one tap: `join` is main.ts's attach, so a tap here is the same arrival a
// scanned QR is, seat and all.
function openRooms(rooms: LobbyRoom[], ctx: ScreenCtx): HTMLElement {
  return el("section", { class: "lobby__section" }, [
    el("h2", {
      class: "lobby__heading",
      text: rooms.length === 1 ? "A poem is being written" : "Poems being written",
    }),
    el(
      "ul",
      { class: "lobby-list" },
      rooms.map((room) =>
        el("li", { class: "lobby-list__item" }, [
          el(
            "button",
            {
              class: "lobby-room",
              type: "button",
              ariaLabel: `Join the poem with code ${[...room.code].join(" ")}`,
              on: { click: () => ctx.join(room.code) },
            },
            [
              el("span", { class: "lobby-room__code", text: room.code }),
              el("span", { class: "lobby-room__fill", text: fillText(room) }),
            ],
          ),
        ]),
      ),
    ),
  ]);
}

// Occupancy, in words. A room with no unclaimed seats is still worth joining —
// you watch it land, and take any seat that frees up — so it says so rather
// than looking closed.
function fillText(room: LobbyRoom): string {
  const words = `${room.filled} of ${room.totalSeats} words in`;
  if (room.open === 0) return `${words} · full, join to watch`;
  return `${words} · ${room.open} ${room.open === 1 ? "seat" : "seats"} open`;
}

// The private half. A private poem is never listed — this section exists
// because SOMETHING is happening that this visitor can't see, and the honest
// thing is to say so and offer the field. Everyone else's code is still their
// own business.
function privateEntry(ctx: ScreenCtx): HTMLElement {
  const input = el("input", {
    class: "code-input",
    type: "text",
    inputmode: "text",
    autocomplete: "off",
    autocapitalize: "characters",
    spellcheck: "false",
    ariaLabel: "Private poem code",
    placeholder: "CODE",
    value: ctx.ui.codeEntry,
    on: {
      input: onType,
      keydown: (e: KeyboardEvent) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        submit();
      },
    },
  });

  const joinBtn = el(
    "button",
    {
      class: "btn btn--primary",
      type: "button",
      on: { click: submit },
    },
    ["Join"],
  );

  // Patch in place rather than re-rendering the screen: a full repaint on every
  // keystroke would take the caret with it.
  function onType(): void {
    const cleaned = sanitizeCodeEntry(input.value);
    if (cleaned !== input.value) input.value = cleaned;
    ctx.ui.codeEntry = cleaned;
    refresh();
  }

  function refresh(): void {
    const ok = normalizeRoomCode(ctx.ui.codeEntry) !== null;
    joinBtn.disabled = !ok;
    // Only complain about a code that has gone PAST the right length —
    // half-typed is not wrong yet.
    if (!ok && ctx.ui.codeEntry.length > CODE_LENGTH) {
      input.setAttribute("aria-invalid", "true");
    } else {
      input.removeAttribute("aria-invalid");
    }
  }

  function submit(): void {
    const code = normalizeRoomCode(ctx.ui.codeEntry);
    if (code === null) return;
    ctx.ui.codeEntry = "";
    ctx.join(code);
  }

  refresh();

  return el("section", { class: "lobby__section lobby__section--private" }, [
    el("h2", {
      class: "lobby__heading",
      text: "A private poem is waiting"
    }),
    el("p", {
      class: "muted",
      text: "Private poems aren't listed. If someone gave you a four-character code, this is where it goes.",
    }),
    el("div", { class: "code-entry" }, [input, joinBtn]),
  ]);
}
