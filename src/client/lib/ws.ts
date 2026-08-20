import type { ClientMsg, ServerMsg } from "../../shared/types.ts";

// One socket, typed both ways. The client only ever sends `ClientMsg` and only
// ever receives `ServerMsg`; everything game-related is decided server-side and
// mirrored here. On an unexpected close we reconnect with capped backoff and
// surface status so the UI can show a reconnect banner.
//
// Two things beyond "reconnect on close", both aimed at the same failure: a
// phone whose screen locks, or a laptop whose lid closes, mid-poem.
//
//   1. A SUSPENDED PAGE'S SOCKET IS A GHOST. The OS tears the connection down
//      while JavaScript is frozen, and no close event is ever delivered — so on
//      wake `readyState` still reads OPEN and every frame we send goes nowhere,
//      silently, forever. Nothing in the platform will tell us. So we ask: an
//      app-level `ping` that must be answered by a `pong` within
//      PROBE_TIMEOUT_MS, or the socket is declared dead and replaced.
//
//   2. WAKING IS NOT A GOOD TIME TO BE PATIENT. The backoff exists for a server
//      that is down, not for a phone that just came back — someone staring at a
//      "Reconnecting…" banner they caused by glancing away should not also wait
//      out an eight-second timer. Every wake signal we can get (the tab becoming
//      visible, the window regaining focus, the network coming back, a
//      bfcache restore) resets the backoff and reconnects now.

export type WireStatus = "connecting" | "open" | "closed";

export interface Wire {
  send(msg: ClientMsg): void;
  close(): void;
}

export interface WireHandlers {
  onMessage(msg: ServerMsg): void;
  onStatus?(status: WireStatus): void;
}

const FIRST_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;

// How often to ask the server whether this socket is still real, and how long
// to wait for the answer. The interval is the unattended safety net — a lid
// closed and reopened fires no event on some platforms, so something has to
// notice on its own. The timeout is deliberately short: by the time we are
// probing, the socket is already suspect, and a seat's hold is counting down.
const PROBE_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

// Slack on the one-shot check a wake schedules. A timer set for exactly
// PROBE_TIMEOUT_MS lands ON the deadline, where `checkProbe`'s "has it been
// LONGER than the timeout" is still false by a millisecond — and the wake path
// would silently hand a dead socket back to the 15-second interval it exists to
// beat. Small enough that nobody could see it; large enough to clear any timer
// rounding, in either direction.
const PROBE_GRACE_MS = 250;

// The floor between two immediate reconnects. Wake signals arrive in clusters —
// alt-tabbing fires visibility AND focus, and someone flicking between apps
// fires them over and over — and skipping the backoff is a courtesy to a phone
// that just woke up, not a licence to hammer a server that is actually down.
// Comfortably shorter than PROBE_TIMEOUT_MS, so it can never suppress the
// reconnect a genuinely dead socket earns.
const MIN_REOPEN_MS = 2_000;

export function connect(handlers: WireHandlers): Wire {
  let socket: WebSocket | null = null;
  let closedByUser = false;
  let backoff = FIRST_BACKOFF_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  // When the outstanding probe was sent, or null when we are not waiting on
  // one. Read against `Date.now()` rather than counted down, so a page that was
  // frozen for ten minutes with a probe in flight comes back and immediately
  // finds it unanswered — which is exactly the case this is here for.
  let probedAt: number | null = null;
  // When we last put a socket on the wire, for the reconnect floor below.
  let openedAt = 0;

  function clearRetry(): void {
    if (retryTimer === null) return;
    clearTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleRetry(): void {
    if (closedByUser || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  function open(): void {
    clearRetry();
    probedAt = null;
    openedAt = Date.now();
    handlers.onStatus?.("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    // The room socket is mounted at /ws by the server (and by the Vite dev
    // plugin), so it never collides with Vite's own HMR WebSocket in dev.
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    socket = ws;

    // Every handler below is guarded by `socket === ws`. A socket we have
    // deliberately abandoned (see `revive`) can still deliver a late close, and
    // acting on it would schedule a second reconnect on top of the one already
    // running — two sockets, two identities, one of them holding a seat nobody
    // is behind.
    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      backoff = FIRST_BACKOFF_MS;
      probedAt = null;
      handlers.onStatus?.("open");
    });
    ws.addEventListener("message", (ev) => {
      if (socket !== ws) return;
      // Any frame at all proves the socket is alive — the answer to a probe
      // does not have to be the pong itself.
      probedAt = null;
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return; // ignore malformed frames
      }
      // `pong` is liveness and nothing else: it carries no state, so it stops
      // here rather than travelling through the reducer.
      if (msg.t === "pong") return;
      handlers.onMessage(msg);
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      probedAt = null;
      handlers.onStatus?.("closed");
      scheduleRetry();
    });
    ws.addEventListener("error", () => ws.close());
  }

  // Give up on the current socket and open a new one immediately. Used when a
  // probe goes unanswered and when a wake signal finds no live connection —
  // both cases where the backoff would only be making someone wait for nothing.
  function revive(): void {
    if (closedByUser) return;
    if (Date.now() - openedAt < MIN_REOPEN_MS) {
      // Too soon. Fall back to the ordinary backoff rather than doing nothing,
      // so a suppressed wake can never be the reason nobody reconnects. (A
      // no-op when a retry is already pending, which it normally is.)
      scheduleRetry();
      return;
    }
    const dead = socket;
    // Cleared BEFORE closing, so the close event that follows is recognized as
    // belonging to an abandoned socket and schedules nothing.
    socket = null;
    probedAt = null;
    backoff = FIRST_BACKOFF_MS;
    clearRetry();
    try {
      dead?.close();
    } catch {
      /* already gone — that was the point */
    }
    open();
  }

  // Ask the server whether this socket still exists. A no-op when one is
  // already outstanding: the deadline is running, and a second ping down a dead
  // socket answers nothing.
  function probe(): void {
    const ws = socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (probedAt !== null) return;
    probedAt = Date.now();
    try {
      ws.send(JSON.stringify({ t: "ping" } satisfies ClientMsg));
    } catch {
      // The socket refused the write. No special case: the deadline is already
      // running and `checkProbe` will replace it, which is the same treatment a
      // ping that vanished into a dead connection gets.
    }
  }

  function checkProbe(): void {
    if (probedAt === null) return;
    if (Date.now() - probedAt <= PROBE_TIMEOUT_MS) return;
    revive();
  }

  // Something suggests this page just came back to life. Reconnect or verify —
  // whichever the socket's state calls for — without waiting on any timer.
  function wake(): void {
    if (closedByUser) return;
    checkProbe();
    const ws = socket;
    // Already on its way: leave it be. A CONNECTING socket has no backoff left
    // to skip.
    if (ws !== null && ws.readyState === WebSocket.CONNECTING) return;
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      probe();
      setTimeout(checkProbe, PROBE_TIMEOUT_MS + PROBE_GRACE_MS);
      return;
    }
    revive();
  }

  open();

  // The probe interval runs for the life of the page. It is unref-less by
  // nature in a browser, and cheap: one tiny frame every fifteen seconds, and
  // browsers throttle it to about once a minute while the tab is hidden —
  // which is fine, because the wake signals below cover the moment that
  // actually matters.
  const prober = setInterval(() => {
    if (closedByUser) return;
    checkProbe();
    probe();
  }, PROBE_INTERVAL_MS);

  // Every wake signal the platform offers, because no single one covers every
  // device: `visibilitychange` is the phone unlocking or the tab coming
  // forward; `focus` is the laptop lid, which fires no visibility change at all
  // because the tab was never hidden; `online` is wifi returning; `pageshow` is
  // a restore out of the back/forward cache, where the socket is always gone
  // and no close event was ever delivered.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") wake();
  });
  window.addEventListener("focus", wake);
  window.addEventListener("online", wake);
  window.addEventListener("pageshow", wake);

  return {
    send(msg) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
      }
    },
    close() {
      closedByUser = true;
      clearRetry();
      clearInterval(prober);
      socket?.close();
    },
  };
}
