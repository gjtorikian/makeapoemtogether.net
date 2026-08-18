import type { ScreenCtx } from "../render.ts";
import type { AppState } from "../state.ts";
import { el } from "../lib/dom.ts";

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
    // affordance as the audience screen.
    return el("main", { class: "screen screen--waiting" }, [
      el("h1", { class: "title", text: "Your word is in." }),
      el("p", {
        class: "subtitle",
        text: "Sit tight! The poem reveals to everyone the moment the last slot fills.",
      }),
      el("p", {
        class: "pulse",
        ariaLabel: "Waiting for other contributors",
        text: "Waiting for the others…",
      })
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
      })
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
