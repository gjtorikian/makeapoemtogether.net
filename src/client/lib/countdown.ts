import { formatCountdown, URGENT_MS } from "../../shared/duration.ts";
import { el } from "./dom.ts";

// The shared clock: how long this poem has left before it expires.
//
// It ticks on its own, and that is the whole reason this is a module rather
// than a few lines inside a screen. `render()` rebuilds the entire tree from
// scratch, so driving a countdown by repainting once a second would destroy the
// contributor's word field — caret, selection, and whatever they had typed —
// every second of their turn. Instead ONE interval lives here for the life of
// the page and touches nothing but its own element's text, the same discipline
// `lastPulseSeq` keeps for the reaction ripple.
//
// Screens call `countdown(state.expiresAt)` and place the node wherever it
// belongs. Each paint builds a fresh node and registers it as the live one; the
// previous node is already detached, which is exactly how the interval knows to
// stop (`isConnected`) when the room ends or the phase moves past collecting.

interface Live {
  // The element placed in the tree — what `isConnected` is asked about, and
  // what carries the urgent class.
  node: HTMLElement;
  // The inner element whose text is the only thing rewritten each second.
  value: HTMLElement;
  expiresAt: number;
  // Last text written, so an interval that finds nothing changed writes nothing.
  // At the long end of the range the readout only moves once a minute.
  text: string;
}

let live: Live | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

// The deadline as a wall-clock time, for the label under the countdown. Local
// to the reader's device on purpose: "closes at 9:47 PM" in their own timezone
// is the one form of this that needs no arithmetic.
function closingTime(expiresAt: number): string {
  return new Date(expiresAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function paint(): void {
  if (live === null) return;
  const left = live.expiresAt - Date.now();
  const text = formatCountdown(left);
  if (text !== live.text) {
    live.text = text;
    live.value.textContent = text;
  }
  live.node.classList.toggle("countdown--urgent", left <= URGENT_MS);
}

function tick(): void {
  // A node that is no longer in the document belongs to a screen that has been
  // painted over — the room ended, or the poem moved past collecting. Nothing
  // left to count for.
  if (live === null || !live.node.isConnected) {
    live = null;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    return;
  }
  paint();
}

// The countdown element, or null when there is no deadline to show (every phase
// but `collecting`, and the lobby). Returning null rather than an empty node
// lets callers drop it into a child list without a wrapper.
export function countdown(expiresAt: number | null): HTMLElement | null {
  if (expiresAt === null) return null;
  const value = el("strong", { class: "countdown__value" });
  const node = el(
    "p",
    {
      class: "countdown",
      role: "timer",
      // Explicitly silent: a live region here would have a screen reader
      // announcing a new number every second for the length of the poem. The
      // label below carries the same fact once, in a form worth hearing.
      ariaLive: "off",
      ariaLabel: `This poem closes at ${closingTime(expiresAt)}`,
    },
    [value, el("span", { class: "countdown__label", text: " left" })],
  );
  live = { node, value, expiresAt, text: "" };
  paint();
  if (timer === null) timer = setInterval(tick, 1000);
  return node;
}
