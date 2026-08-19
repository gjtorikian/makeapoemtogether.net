import { WORD_TYPES, type WordType } from "../../shared/types.ts";
import type { RoomVisibility } from "../../shared/rooms.ts";
import {
  clampDuration,
  DEFAULT_DURATION_MS,
  formatDuration,
  stopsFor,
} from "../../shared/duration.ts";
import type { HostConfigDraft, ScreenCtx } from "../render.ts";
import { el } from "../lib/dom.ts";

// Mirrors the server's default `maxSlots` (see room.ts). The server is
// authoritative and re-validates the counts on `launch`; this only keeps the UI
// in range so a launch isn't bounced.
const MAX_PEOPLE = 25;
const MIN_PEOPLE = 1;
const DEFAULT_PEOPLE = 6;

// What the screen opens on the first time. Public by default: the toy is a room
// full of strangers adding words, and the listing is what makes that happen
// without anyone reading a code aloud. Private is the deliberate choice, so it
// is the one you have to tap.
export function initialConfigDraft(): HostConfigDraft {
  return {
    x: 0.5,
    y: 0.5,
    people: DEFAULT_PEOPLE,
    peopleText: String(DEFAULT_PEOPLE),
    visibility: "public",
    durationMs: DEFAULT_DURATION_MS,
  };
}

// --- the people field's arithmetic ----------------------------------------
// The count is typeable as well as steppable, which means untrusted text in a
// control that used to be a span. These three are the whole of that, kept pure
// and apart from the DOM wiring because "what happens when someone pastes -4 or
// 9999 into the room size" deserves an answer that isn't a launch.

// Digits only — and deliberately NO length cap. Capping the field at two
// characters turned "100" into "10": the third keystroke vanished, the number
// became a legal one, and Launch stayed enabled on a value nobody typed.
// Whatever is entered stays entered; `parsePeople` below is what judges it.
function sanitizePeople(raw: string): string {
  return raw.replace(/\D+/g, "");
}

// The typed value, if it is one we can commit. Null means "not yet" — an empty
// field mid-edit, or a number out of range — which disables Launch WITHOUT
// rewriting what someone is still in the middle of typing.
function parsePeople(raw: string): number | null {
  const digits = sanitizePeople(raw);
  if (digits === "") return null;
  const n = Number(digits);
  return n >= MIN_PEOPLE && n <= MAX_PEOPLE ? n : null;
}

// What the field settles on when focus leaves it. An empty field returns to
// the last committed count rather than snapping to 1: clearing the box to
// retype is not a request for a one-person poem.
function clampPeople(raw: string, fallback: number): number {
  const digits = sanitizePeople(raw);
  if (digits === "") return fallback;
  return Math.min(MAX_PEOPLE, Math.max(MIN_PEOPLE, Number(digits)));
}

// The four classical modes of poetry, one per corner of the pad. Each corner is
// a word-type mix; the chosen point blends them. The weights are editorial, not
// scientific: lyric feeling leans on adjectives, narrative and dramatic drive
// on verbs, descriptive scene-setting is built from nouns.
const CORNERS: Record<string, Record<WordType, number>> = {
  lyric: { adjective: 0.5, noun: 0.3, verb: 0.2 }, // top-left
  narrative: { adjective: 0.15, noun: 0.4, verb: 0.45 }, // top-right
  descriptive: { adjective: 0.35, noun: 0.5, verb: 0.15 }, // bottom-left
  dramatic: { adjective: 0.25, noun: 0.25, verb: 0.5 }, // bottom-right
};

// (x, y) in [0,1]^2 (y grows downward, CSS-style) + a people count -> whole
// per-type counts summing to exactly `people`. Bilinear blend of the corner
// mixes, then largest-remainder rounding so no seat is lost to floors. This is
// the one piece of the pad that is pure arithmetic rather than pointer wiring,
// which is why it sits out here rather than inside the closure below.
function mixFromPoint(
  x: number,
  y: number,
  people: number,
): Record<WordType, number> {
  const blend = {} as Record<WordType, number>;
  for (const t of WORD_TYPES) {
    blend[t] =
      CORNERS.lyric[t] * (1 - x) * (1 - y) +
      CORNERS.narrative[t] * x * (1 - y) +
      CORNERS.descriptive[t] * (1 - x) * y +
      CORNERS.dramatic[t] * x * y;
  }
  const raw = WORD_TYPES.map((t) => blend[t] * people);
  const counts = raw.map(Math.floor);
  let left = people - counts.reduce((a, b) => a + b, 0);
  // Hand the leftover seats to the largest remainders; ties break toward the
  // earlier type so the result is deterministic.
  const order = WORD_TYPES.map((_, i) => i).sort(
    (a, b) => raw[b] - counts[b] - (raw[a] - counts[a]) || a - b,
  );
  for (const i of order) {
    if (left <= 0) break;
    counts[i] += 1;
    left -= 1;
  }
  return { adjective: counts[0], noun: counts[1], verb: counts[2] };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

// The pad + people stepper -> a single `launch` frame. Local state (point,
// people) lives in this closure and patches its own DOM in place; a full
// re-render only happens later, when the server's `collecting` state swaps in
// HostWaiting.
export function HostConfig(ctx: ScreenCtx): HTMLElement {
  // The draft lives in `ui`, not here: this function re-runs on every paint,
  // and paints happen for reasons this screen shows nothing of (a lobby
  // refresh, the archive landing, the reconnect banner). Reading the draft back
  // out is what makes a rebuild invisible instead of a silent reset.
  const draft = ctx.ui.config;

  // True while the field holds something we can't launch on (empty, or out of
  // range). `draft.people` keeps its last good value throughout, so the mix
  // readout and the pad never go blank under a half-typed number.
  let invalid = parsePeople(draft.peopleText) === null;

  const dot = el("div", { class: "mode-pad__dot", role: "presentation" });
  const mixEl = el("p", { class: "config__mix", ariaLabel: "Word mix" });
  // Typeable as well as steppable: ± is right for 5 -> 6, but a host setting up
  // for a table of eleven should be able to say so. `text` + `inputmode`
  // rather than `type="number"`: it brings up the same numeric keypad without
  // the spinner arrows (which would duplicate the ± buttons beside it).
  const peopleInput = el("input", {
    class: "stepper__value stepper__input",
    type: "text",
    inputmode: "numeric",
    autocomplete: "off",
    // No maxlength: a too-long entry must READ as too long (red, Launch dead)
    // rather than being trimmed into something acceptable behind the typist.
    ariaLabel: "People count",
    value: draft.peopleText,
    on: {
      input: onType,
      // Leaving the field is what settles it: clamp, and put the committed
      // number back in the box.
      blur: commit,
      keydown: onFieldKey,
    },
  });

  const launchBtn = el(
    "button",
    {
      class: "btn btn--primary",
      type: "button",
      on: {
        click: () =>
          ctx.send({
            t: "launch",
            counts: mixFromPoint(draft.x, draft.y, draft.people),
            visibility: draft.visibility,
            durationMs: draft.durationMs,
          }),
      },
    },
    ["Launch poem"],
  );

  // Who can find this poem. Two buttons rather than a checkbox because the
  // difference is worth spelling out at the moment of choosing: one of them
  // puts the poem on every stranger's lobby, and the other hands the host a
  // code to pass around.
  const visibilityNote = el("p", { class: "config__note" });
  const publicBtn = visibilityOption("public", "Public", "Anyone can find and join it");
  const privateBtn = visibilityOption("private", "Private", "Only people you give the code to");

  function visibilityOption(
    value: RoomVisibility,
    label: string,
    hint: string,
  ): HTMLButtonElement {
    return el(
      "button",
      {
        class: "choice",
        type: "button",
        role: "radio",
        ariaLabel: `${label}: ${hint}`,
        on: {
          click: () => {
            draft.visibility = value;
            refreshVisibility();
          },
        },
      },
      [
        el("span", { class: "choice__label", text: label }),
        el("span", { class: "choice__hint", text: hint }),
      ],
    );
  }

  function refreshVisibility(): void {
    for (const [btn, value] of [
      [publicBtn, "public"],
      [privateBtn, "private"],
    ] as const) {
      const on = draft.visibility === value;
      btn.classList.toggle("choice--on", on);
      btn.setAttribute("aria-checked", String(on));
    }
    visibilityNote.textContent =
      draft.visibility === "public"
        ? "It'll show up in the lobby while it fills, so anyone here can join in."
        : "It stays off the Internet. You'll get a four-character code to hand out.";
    // Visibility is what decides how long a poem may live, so the slider is
    // rebuilt around it: private opens the hour-and-up stops, public closes them
    // and pulls an over-long choice back down to the ceiling.
    refreshDuration();
  }

  // --- how long the poem has ------------------------------------------------
  // A slider over `stopsFor(visibility)` by INDEX, not by milliseconds: the
  // stops are deliberately non-linear (ten minutes to a full day), and indexing
  // is what makes every detent the same thumb-width apart. The public list is a
  // prefix of the private one, so toggling visibility keeps the same index
  // pointing at the same duration wherever it still exists.

  const durationValue = el("strong", { class: "duration__value" });
  const durationNote = el("p", {
    class: "duration__note",
    text: "Finish the poem before time runs out.",
  });
  const durationInput = el("input", {
    class: "duration__slider",
    type: "range",
    min: "0",
    step: "1",
    ariaLabel: "How long this poem has before it expires",
    on: {
      input: () => {
        const stops = stopsFor(draft.visibility);
        const i = Number(durationInput.value);
        draft.durationMs = stops[Math.min(Math.max(i, 0), stops.length - 1)];
        refreshDuration();
      },
    },
  });
  // The ends of the track, labelled once rather than every detent — eleven
  // labels under a phone-width slider is a wall of text nobody reads.
  const durationScaleMax = el("span", { class: "duration__scale-max" });
  const durationScale = el("div", { class: "duration__scale" }, [
    el("span", { text: "10 min" }),
    durationScaleMax,
  ]);

  function refreshDuration(): void {
    const stops = stopsFor(draft.visibility);
    // Clamp before indexing: a host who picked 12 hours and then tapped Public
    // must land on the hour, not fall off the end of the shorter list.
    draft.durationMs = clampDuration(draft.durationMs, draft.visibility);
    const index = stops.indexOf(draft.durationMs);
    durationInput.max = String(stops.length - 1);
    durationInput.value = String(index < 0 ? 0 : index);
    durationValue.textContent = formatDuration(draft.durationMs);
    durationInput.setAttribute("aria-valuetext", formatDuration(draft.durationMs));
    durationScaleMax.textContent = formatDuration(stops[stops.length - 1]);
  }

  const durationField = el("div", { class: "duration" }, [
    el("div", { class: "duration__head" }, [
      el("span", { class: "duration__label", text: "Time limit" }),
      durationValue,
    ]),
    durationInput,
    durationScale,
    durationNote,
  ]);

  // Never writes the input's value — that would fight the caret of whoever is
  // typing. `setPeople` owns the field's text; this owns everything else.
  function refresh(): void {
    dot.style.left = `${draft.x * 100}%`;
    dot.style.top = `${draft.y * 100}%`;
    const mix = mixFromPoint(draft.x, draft.y, draft.people);
    const parts = WORD_TYPES.filter((t) => mix[t] > 0).map(
      (t) => `${mix[t]} ${t}${mix[t] === 1 ? "" : "s"}`,
    );
    mixEl.textContent = parts.join(" · ");
    if (invalid) peopleInput.setAttribute("aria-invalid", "true");
    else peopleInput.removeAttribute("aria-invalid");
    launchBtn.disabled = invalid;
  }

  // Commit a count from anywhere that isn't the keyboard (± buttons, blur) and
  // put it in the box.
  function setPeople(next: number): void {
    draft.people = next;
    draft.peopleText = String(next);
    invalid = false;
    peopleInput.value = draft.peopleText;
    refresh();
  }

  function onType(): void {
    const digits = sanitizePeople(peopleInput.value);
    // Rewrite only when the sanitizer actually dropped something, so ordinary
    // typing never moves the caret.
    if (digits !== peopleInput.value) peopleInput.value = digits;
    draft.peopleText = digits;
    const parsed = parsePeople(digits);
    invalid = parsed === null;
    // An out-of-range or empty field leaves `people` alone: Launch goes dead
    // until it reads as a number, and nothing else on the screen flinches.
    if (parsed !== null) draft.people = parsed;
    refresh();
  }

  function commit(): void {
    setPeople(clampPeople(peopleInput.value, draft.people));
  }

  function onFieldKey(e: KeyboardEvent): void {
    // Enter settles the field rather than doing nothing — there is no form
    // here to submit, so without this it would look like a dead key.
    if (e.key === "Enter") {
      commit();
      peopleInput.blur();
    } else if (e.key === "ArrowUp") {
      bump(1);
    } else if (e.key === "ArrowDown") {
      bump(-1);
    } else {
      return;
    }
    e.preventDefault();
  }

  function setPoint(nx: number, ny: number): void {
    draft.x = clamp01(nx);
    draft.y = clamp01(ny);
    refresh();
  }

  function pointFromEvent(pad: HTMLElement, e: PointerEvent): void {
    const rect = pad.getBoundingClientRect();
    setPoint(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    );
  }

  // Tap-or-drag surface. Pointer capture keeps a drag live even when the finger
  // wanders off the square; arrow keys nudge the same point for keyboard users.
  const pad = el(
    "div",
    {
      class: "mode-pad",
      role: "application",
      ariaLabel:
        "Poem mood. Drag the dot between lyric, narrative, descriptive, and dramatic to set the word mix. Arrow keys also move it.",
      on: {
        pointerdown: (e) => {
          pad.setPointerCapture(e.pointerId);
          pointFromEvent(pad, e);
        },
        pointermove: (e) => {
          if (e.buttons > 0) pointFromEvent(pad, e);
        },
        keydown: (e) => {
          const step = 0.05;
          if (e.key === "ArrowLeft") setPoint(draft.x - step, draft.y);
          else if (e.key === "ArrowRight") setPoint(draft.x + step, draft.y);
          else if (e.key === "ArrowUp") setPoint(draft.x, draft.y - step);
          else if (e.key === "ArrowDown") setPoint(draft.x, draft.y + step);
          else return;
          e.preventDefault();
        },
      },
    },
    [
      el("span", { class: "mode-pad__corner mode-pad__corner--tl", text: "lyric" }),
      el("span", { class: "mode-pad__corner mode-pad__corner--tr", text: "narrative" }),
      el("span", { class: "mode-pad__corner mode-pad__corner--bl", text: "descriptive" }),
      el("span", { class: "mode-pad__corner mode-pad__corner--br", text: "dramatic" }),
      dot,
    ],
  );
  pad.tabIndex = 0;

  function bump(delta: number): void {
    // Stepping from a half-typed field steps from the last committed count,
    // which is what the draft already holds.
    const next = draft.people + delta;
    if (next < MIN_PEOPLE || next > MAX_PEOPLE) return;
    setPeople(next);
  }

  const peopleStepper = el("div", { class: "stepper" }, [
    el("span", { class: "stepper__label", text: "People" }),
    el("div", { class: "stepper__controls" }, [
      el(
        "button",
        {
          class: "btn btn--round",
          type: "button",
          ariaLabel: "Fewer people",
          on: { click: () => bump(-1) },
        },
        ["−"],
      ),
      peopleInput,
      el(
        "button",
        {
          class: "btn btn--round",
          type: "button",
          ariaLabel: "More people",
          on: { click: () => bump(1) },
        },
        ["+"],
      ),
    ]),
  ]);

  const screen = el("main", { class: "screen screen--config" }, [
    el("h1", { class: "title", text: "Set up your poem" }),
    el("p", {
      class: "subtitle",
      text: "Pick how many people are participating and the poem's mood on the grid. Each person contributes one word.",
    }),
    el("div", { class: "config__layout" }, [
      peopleStepper,
      el(
        "div",
        {
          class: "choice-group",
          role: "radiogroup",
          ariaLabel: "Who can join this poem",
        },
        [publicBtn, privateBtn],
      ),
      visibilityNote,
      el("div", { class: "config__grid" }, [pad, mixEl]),
      durationField,
      launchBtn,
    ]),
  ]);

  refresh();
  refreshVisibility();
  return screen;
}
