import type { ScreenCtx } from "../render.ts";
import type { AppState } from "../state.ts";
import { el } from "../lib/dom.ts";
import { countdown } from "../lib/countdown.ts";

// A contributor's states, all derived from `AppState` (never local game
// logic). The poem is written in queue order, so:
//
//   submitted            -> the blind waiting view (unchanged);
//   not my turn yet      -> in line: how many words must land before mine;
//   my turn, clue coming -> the beat between the previous word landing and its
//                           clue arriving (server-side LLM call, seconds);
//   my turn              -> the input — free rein for seat 0, everyone else
//                           writes off the clue about the word just before.
//
// They never see another word — only its clue, and only their predecessor's.
// The poem itself arrives via `reveal`.
export function Contributor(ctx: ScreenCtx): HTMLElement {
  const { state } = ctx;
  const mine = state.seats.find((s) => s.index === state.mySeat);
  const submitted = mine?.filled ?? false;

  if (submitted) {
    // Authors are audience-with-a-word-in while they wait — same reaction
    // affordance as the audience screen. The countdown is the other half of the
    // queued screen's "words before yours": now that the wait is behind them,
    // the shape of it is how much poem is still owed.
    const after = wordsAfter(state);
    return el("main", { class: "screen screen--waiting" }, [
      el("h1", { class: "title", text: "Your word is in." }),
      el("p", {
        class: "subtitle",
        text: "Sit tight! The poem reveals to everyone the moment the last slot fills.",
      }),
      el("p", {
        class: "progress",
        text:
          after === 0
            ? "Yours was the last word — the poem is being written now."
            : `${after} ${after === 1 ? "word" : "words"} still to come after yours.`,
      }),
      el("p", {
        class: "pulse",
        ariaLabel: "Waiting for other contributors",
        text: "Waiting for the others…",
      }),
      countdown(state.expiresAt),
      // Their word is already the server's; what a closed tab costs them is the
      // reveal it was submitted for.
      keepOpen("Your word is safely in, but the poem appears right here — and nowhere else."),
    ]);
  }

  const type = state.myType ?? "word";
  const myTurn = state.mySeat !== null && state.activeSeat === state.mySeat;

  if (!myTurn) {
    // Someone earlier in the queue is still writing (or their slot is still
    // unclaimed). Nothing to do but hold — with a count so the wait has shape.
    const ahead = wordsAhead(state);
    return el("main", { class: "screen screen--waiting screen--queued" }, [
      el("h1", { class: "title" }, [
        "You're the ",
        el("em", { class: "type-badge", text: type }),
      ]),
      el("p", {
        class: "subtitle",
        text: `The poem is written in order; there ${ahead === 1 ? "is" : "are"} ${ahead} ${ahead === 1 ? "word" : "words"} before yours. When it's your turn, you'll get a clue about the word just before.`,
      }),
      el("p", {
        class: "pulse",
        ariaLabel: "Waiting for your turn",
        text: "Waiting for your turn…",
      }),
      countdown(state.expiresAt),
      // The one wait where leaving actually costs the seat: an unfilled slot is
      // grace-held only briefly after the socket drops, then returned to the
      // pool for whoever asks next — and dropped from the poem entirely if
      // nobody takes it, rather than holding everyone else up.
      keepOpen("Leave and your slot goes to whoever asks next."),
    ]);
  }

  if (state.mySeat !== null && state.mySeat > 0 && state.myClue === null) {
    // The previous word just landed; its clue is being written server-side.
    // Brief by construction — the clue writer always answers within seconds.
    return el("main", { class: "screen screen--waiting screen--clue-wait" }, [
      el("h1", { class: "title", text: "You're up!" }),
      el("p", {
        class: "subtitle",
        text: "Reading the word before yours…",
      }),
      el("p", {
        class: "pulse",
        ariaLabel: "Waiting for your clue",
        text: "Your clue is coming…",
      }),
      countdown(state.expiresAt),
    ]);
  }

  const input = el("input", {
    class: "word-input",
    type: "text",
    inputmode: "text",
    autocapitalize: "none",
    autocomplete: "off",
    maxlength: 40,
    placeholder: "one word",
    ariaLabel: "Your word",
  });

  const errorEl = el("p", { class: "error", text: state.error ?? "" });

  function attempt(): void {
    const raw = input.value.trim();
    // Local guard mirrors the server's one-token rule for instant feedback; the
    // server still re-validates and may answer with an `invalid-word` error.
    if (raw === "" || /\s/.test(raw)) {
      errorEl.textContent = "Enter exactly one word — no spaces.";
      return;
    }
    errorEl.textContent = "";
    ctx.send({ t: "submit", word: raw });
  }

  const form = el(
    "form",
    {
      class: "word-form",
      on: {
        submit: (e) => {
          e.preventDefault();
          attempt();
        },
      },
    },
    [
      input,
      el("button", { class: "btn btn--primary", type: "submit" }, [
        "Add my word",
      ]),
    ],
  );

  return el("main", { class: "screen screen--contributor" }, [
    el("h1", { class: "title" }, [
      "You're the ",
      el("em", { class: "type-badge", text: type }),
    ]),
    state.myClue !== null
      ? el("p", { class: "clue" }, [
        "The word before yours: ",
        el("em", { class: "clue__text", text: `“${state.myClue}”` }),
      ])
      : null,
    el("p", {
      class: "subtitle",
      text:
        state.mySeat === 0
          ? "You're the poem's opening! Type a single word; the next writer gets only a clue about it."
          : "Type a single word to follow it. You won't see anyone's actual words until the poem is revealed.",
    }),
    form,
    errorEl,
    // Below the input, not above it: the person whose turn it is should read
    // their clue and their prompt first, and find the clock only once they have.
    countdown(state.expiresAt),
  ]);
}

// Unfilled slots before mine, claimed or not — the queue distance my turn
// waits on.
function wordsAhead(state: AppState): number {
  const mySeat = state.mySeat ?? 0;
  let ahead = 0;
  for (let i = 0; i < mySeat; i++) {
    const seat = state.seats.find((s) => s.index === i);
    if (!seat || !seat.filled) ahead += 1;
  }
  return ahead;
}

// The mirror image: unfilled slots after mine, claimed or not. Counts down on
// its own, because every submission behind me lands as a `state` frame and
// every `state` frame repaints this screen — there is no local timer to drift.
function wordsAfter(state: AppState): number {
  const mySeat = state.mySeat ?? 0;
  let after = 0;
  for (let i = mySeat + 1; i < state.totalSeats; i++) {
    const seat = state.seats.find((s) => s.index === i);
    if (!seat || !seat.filled) after += 1;
  }
  return after;
}

// The footnote every waiting contributor gets. A closed tab costs something in
// both directions — the seat before submitting, the reveal after it — so the
// warning is shared and only its second half differs.
function keepOpen(cost: string): HTMLElement {
  return el("p", { class: "keep-open" }, [
    el("strong", { text: "Keep this tab open." }),
    ` ${cost}`,
  ]);
}
