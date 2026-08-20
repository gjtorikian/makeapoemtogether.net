import { formatCountdown, URGENT_MS } from "../../shared/duration.ts";
import { el } from "./dom.ts";

// The self-ticking clocks: how long this poem has left before it expires, and
// how long a dropped player's seat has been dark.
//
// One counts DOWN to something the room will do, the other counts UP from
// something that happened — and that asymmetry is the design, not an accident.
// Nothing takes a seat away when its clock reaches a number, so a seat's clock
// has no number to reach. It is there so the length of an absence is legible to
// the host, who is the only thing that frees a seat.
//
// They tick on their own, and that is the whole reason this is a module rather
// than a few lines inside a screen. `render()` rebuilds the entire tree from
// scratch, so driving a countdown by repainting once a second would destroy the
// contributor's word field — caret, selection, and whatever they had typed —
// every second of their turn. Instead ONE interval lives here for the life of
// the page and touches nothing but its own elements' text, the same discipline
// `lastPulseSeq` keeps for the reaction ripple.
//
// Screens call `countdown(...)` / `holdCountdown(...)` and place the node where
// it belongs. Each paint builds fresh nodes and registers them; the nodes from
// the previous paint are already detached, which is exactly how the interval
// knows to drop them (`isConnected`) — and when the last one goes, so does the
// interval. That pruning is what lets a board register one clock per held seat
// without leaking a timer per seat per paint.

interface Live {
  // The element placed in the tree — what `isConnected` is asked about, and
  // what carries the urgent class.
  node: HTMLElement;
  // The inner element whose text is the only thing rewritten each second.
  value: HTMLElement;
  // The epoch ms this clock is measured against: the moment it is counting
  // towards, or the moment it is counting away from.
  at: number;
  // Which of those. `true` counts up from `at`, `false` counts down to it.
  elapsed: boolean;
  format: (ms: number) => string;
  // Below this much time remaining the node reads as a deadline rather than a
  // fact. Null for a clock with no deadline to read as — every elapsed one.
  urgent: { atOrBelow: number; className: string } | null;
  // Last text written, so an interval that finds nothing changed writes nothing.
  // At the long end of the range the readout only moves once a minute.
  text: string;
}

const lives = new Set<Live>();
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

function paint(live: Live): void {
  const ms = live.elapsed ? Date.now() - live.at : live.at - Date.now();
  const text = live.format(ms);
  if (text !== live.text) {
    live.text = text;
    live.value.textContent = text;
  }
  if (live.urgent) {
    live.node.classList.toggle(live.urgent.className, ms <= live.urgent.atOrBelow);
  }
}

function tick(): void {
  for (const live of lives) {
    // A node that is no longer in the document belongs to a screen that has
    // been painted over — the room ended, the poem moved past collecting, or
    // the held seat was reclaimed or swept. Nothing left to count for.
    if (!live.node.isConnected) {
      lives.delete(live);
      continue;
    }
    paint(live);
  }
  if (lives.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

function register(live: Live): void {
  lives.add(live);
  paint(live);
  if (timer === null) timer = setInterval(tick, 1000);
}

// The poem's clock, or null when there is no deadline to show (every phase but
// `collecting`, and the lobby). Returning null rather than an empty node lets
// callers drop it into a child list without a wrapper.
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
  register({
    node,
    value,
    at: expiresAt,
    elapsed: false,
    format: formatCountdown,
    urgent: { atOrBelow: URGENT_MS, className: "countdown--urgent" },
    text: "",
  });
  return node;
}

// A clock counting up from a moment that has already happened. Null in, null
// out, so a caller can drop the result straight into a child list.
//
// `formatCountdown` is reused as-is: it reads "4:32" up to an hour and "1h 12m"
// past it, which is exactly the right shape for an elapsed span too — seconds
// while someone might just be thinking, and coarser once it is clear they are
// not coming back this afternoon.
//
// Never urgent, in either flavour. Nothing happens at any particular number —
// that is the whole point of both of them — and a style that reddened would be
// the interface implying a deadline the room does not have.
function elapsed(
  since: number | null | undefined,
  className: string,
  ariaLabel: string,
): HTMLElement | null {
  if (since == null) return null;
  const value = el("span", { class: "seat__timer-value" });
  const node = el(
    "span",
    {
      class: className,
      role: "timer",
      // Same reasoning as the poem's clock: a per-second live region on every
      // seat at once would be unusable. The label says the fact once.
      ariaLive: "off",
      ariaLabel,
    },
    [value],
  );
  register({ node, value, at: since, elapsed: true, format: formatCountdown, urgent: null, text: "" });
  return node;
}

// How long a seat has been dark — its holder is offline and only the host can
// free it.
export function holdTimer(heldSince: number | null | undefined): HTMLElement | null {
  return elapsed(heldSince, "seat__hold", "How long this seat has been disconnected");
}

// How long the poem has been waiting on the person whose turn it is. Set only
// for the seat holding the baton, so a queued seat renders nothing — being in
// line is not something to be timed for.
export function batonTimer(batonSince: number | null | undefined): HTMLElement | null {
  return elapsed(batonSince, "seat__baton", "How long this seat has had the turn");
}
