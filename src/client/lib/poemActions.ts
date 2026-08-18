import type { Capabilities } from "./capabilities.ts";
import { el } from "./dom.ts";

// The two ways a poem leaves the app, shared by the reveal screen and the
// gallery's permalink so a poem behaves identically whether it is three
// seconds or three weeks old.
//
//   Copy   a small button in the corner above the poem. Always present,
//          always just the clipboard — no sheet, no surprise.
//   Share  the native sheet, and ONLY where one exists. Without it this
//          button used to relabel itself "Copy poem", which is why there were
//          two ways to copy and none of them obvious.
//
// Both report on themselves, briefly, instead of writing to a status line
// under the poem: the answer to "did that work?" belongs on the thing you
// tapped.

// How long a button holds its result before returning to its resting label.
const RESULT_MS = 1800;
// The manual fallback holds longer — it is an instruction, not a receipt, and
// the reader has to act on it.
const MANUAL_MS = 4000;

export function flash(
  button: HTMLButtonElement,
  resting: string,
  label: string,
  state: string,
  ms: number,
): void {
  button.textContent = label;
  button.dataset.state = state;
  // A second tap restarts the window rather than letting the first timer cut
  // the second result short.
  const previous = Number(button.dataset.timer ?? 0);
  if (previous) window.clearTimeout(previous);
  button.dataset.timer = String(
    window.setTimeout(() => {
      button.textContent = resting;
      delete button.dataset.state;
      delete button.dataset.timer;
    }, ms),
  );
}

// Select the poem for a manual copy: the last resort when there is no usable
// clipboard (a plain-http venue). It needs a DOM node, which is why it lives
// here and not in the capabilities module.
function selectText(node: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function copyButton(
  caps: Capabilities,
  text: string,
  // Selected as the fallback when the clipboard is unavailable.
  poemEl: HTMLElement,
): HTMLButtonElement {
  const button = el(
    "button",
    {
      class: "poem__copy",
      type: "button",
      // The visible text is the accessible name (and it changes with the
      // result, so it is announced); `title` carries the longer description.
      title: "Copy poem to clipboard",
      on: { click: () => void run() },
    },
    ["Copy"],
  );

  async function run(): Promise<void> {
    if ((await caps.copy(text)) === "copied") {
      flash(button, "Copy", "Copied!", "copied", RESULT_MS);
      return;
    }
    selectText(poemEl);
    flash(button, "Copy", "Press ⌘C", "manual", MANUAL_MS);
  }

  return button;
}

/**
 * Null where there is no native share sheet — Copy is already the answer, and
 * it owns the select-the-text last resort, so this needs no DOM node.
 */
export function shareButton(
  caps: Capabilities,
  text: string,
): HTMLButtonElement | null {
  if (!caps.canShare) return null;
  const button = el(
    "button",
    {
      class: "poem__share",
      type: "button",
      on: { click: () => void run() },
    },
    ["Share"],
  );

  async function run(): Promise<void> {
    const result = await caps.share(text);
    // "unavailable" here means the sheet was dismissed — a deliberate cancel,
    // which deserves no message at all.
    if (result === "shared") {
      flash(button, "Share poem", "Shared!", "copied", RESULT_MS);
    } else if (result === "copied") {
      // The sheet refused (not cancelled) and the clipboard caught it.
      flash(button, "Share poem", "Copied!", "copied", RESULT_MS);
    }
  }

  return button;
}

// The poem's heading row: whatever identifies the poem on the left, the copy
// button on its right. One helper so the corner button sits in exactly the
// same place on both surfaces.
export function poemHead(left: HTMLElement, action: HTMLElement): HTMLElement {
  return el("div", { class: "poem-head" }, [left, action]);
}
