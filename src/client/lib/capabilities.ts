// Every device API the client touches flows through this one module: wake lock,
// vibration, Web Share (with the clipboard write as its fallback), and a tiny
// synthesized Web Audio engine. Nothing outside this file may reach for
// navigator.share / navigator.vibrate / navigator.wakeLock directly — that rule
// is what lets the rest of the client stay oblivious to which phone, browser,
// and transport (plain-http LAN!) it happens to be running on.
//
// Design rules, in order:
//   1. Never throw. Absent APIs no-op (vibrate on iOS), rejected promises are
//      swallowed into a result value. Degradation is silent by design — the
//      venue runs plain http, so secure-context APIs (wake lock, share) are
//      routinely missing and that is not an error.
//   2. Injectable globals, not a DOM fixture. Every default is resolved via a
//      `globalThis` lookup (the `llm.ts` `globalThis.fetch` precedent) rather
//      than a bare `window.AudioContext` default parameter, which would throw
//      on import anywhere there is no window — this module has to be safe to
//      merely load outside a browser.
//   3. Audio is synthesized (oscillator + gain envelope) — no bundled asset.
//      `arm()` must run inside a user-gesture handler: iOS only lets an
//      AudioContext start from one, which is the entry tap's whole job.

export type ShareResult = "shared" | "copied" | "unavailable";
export type CopyResult = "copied" | "unavailable";
export type WakeLockResult = "acquired" | "unavailable";

// Minimal structural shapes — just what this module calls, so a caller can hand
// in a tiny fake and the real browser objects still satisfy them.

export interface CapNavigator {
  share?(data: { text?: string; title?: string }): Promise<void>;
  clipboard?: { writeText(text: string): Promise<void> };
  vibrate?(pattern: number | number[]): boolean;
  // The sentinel the platform hands back is deliberately untyped: nothing here
  // holds onto it (see `acquire`), so its shape is not this module's business.
  wakeLock?: { request(type: "screen"): Promise<unknown> };
}

export interface CapAudioNode {
  connect(target: CapAudioNode): CapAudioNode;
}

export interface CapAudioParam {
  setValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

export interface CapOscillator extends CapAudioNode {
  type: string;
  frequency: CapAudioParam;
  start(when: number): void;
  stop(when: number): void;
}

export interface CapGain extends CapAudioNode {
  gain: CapAudioParam;
}

export interface CapAudioContext {
  state: string;
  currentTime: number;
  destination: CapAudioNode;
  resume(): Promise<void>;
  createOscillator(): CapOscillator;
  createGain(): CapGain;
}

export type CapAudioCtor = new () => CapAudioContext;

export interface CapDocument {
  visibilityState: string;
  addEventListener(type: string, listener: () => void): void;
}

export interface CapabilitiesConfig {
  /** Defaults to the real navigator when one exists. */
  nav?: CapNavigator;
  /** Defaults to the platform AudioContext, if any. */
  AudioCtor?: CapAudioCtor;
  /** Hosts the wake lock's visibilitychange re-acquire; defaults to document. */
  doc?: CapDocument;
}

export interface Capabilities {
  /** Whether the native share sheet exists — screens key button copy off this. */
  canShare: boolean;
  share(text: string): Promise<ShareResult>;
  /** The clipboard alone, with no share sheet — what a Copy button wants. */
  copy(text: string): Promise<CopyResult>;
  vibrate(pattern: number | number[]): void;
  wakeLock: {
    request(): Promise<WakeLockResult>;
  };
  audio: {
    arm(): void;
    sting(): void;
  };
}

export function createCapabilities(cfg: CapabilitiesConfig = {}): Capabilities {
  // `globalThis` lookups so merely creating this object is safe outside a
  // browser: there is no `window` there, and a partial `navigator` (when one
  // exists) simply lacks every optional API below, which is the degraded path
  // anyway.
  const nav = cfg.nav ?? (globalThis.navigator as CapNavigator | undefined);
  const AudioCtor =
    cfg.AudioCtor ?? (globalThis.AudioContext as CapAudioCtor | undefined);
  const doc = cfg.doc ?? (globalThis.document as CapDocument | undefined);

  // --- copy / share -------------------------------------------------------

  const canShare = typeof nav?.share === "function";

  // The clipboard on its own. A Copy button must never open a share sheet —
  // that is a different promise to the person tapping it.
  async function copy(text: string): Promise<CopyResult> {
    if (nav?.clipboard) {
      try {
        await nav.clipboard.writeText(text);
        return "copied";
      } catch {
        // Plain-http pages often have no usable clipboard (it is
        // secure-context-only), and some engines refuse outside a gesture.
      }
    }
    // The caller owns the last resort (select-the-text UI) — it needs a DOM
    // node, which this module deliberately never touches.
    return "unavailable";
  }

  async function share(text: string): Promise<ShareResult> {
    if (nav?.share) {
      try {
        await nav.share({ text });
        return "shared";
      } catch (err) {
        // The visitor closed the share sheet. Respect the cancel: no clipboard
        // cascade — they chose not to share, so don't share for them.
        if ((err as { name?: string } | null)?.name === "AbortError") {
          return "unavailable";
        }
        // Anything else (NotAllowedError, data rejected…) falls through to the
        // clipboard, exactly like a phone with no share sheet at all.
      }
    }
    return copy(text);
  }

  // --- vibration (Android garnish, never load-bearing) -------------------

  function vibrate(pattern: number | number[]): void {
    // iOS Safari has no navigator.vibrate; some engines throw on odd patterns.
    // Either way this is ambiance — swallow everything.
    try {
      nav?.vibrate?.(pattern);
    } catch {
      /* garnish, not a channel */
    }
  }

  // --- wake lock ---------------------------------------------------------

  let wanted = false; // survives platform releases, drives the re-acquire

  async function acquire(): Promise<WakeLockResult> {
    const wl = nav?.wakeLock;
    if (!wl) return "unavailable"; // plain http, old browser — silent by design
    try {
      // The sentinel is deliberately dropped: nothing in the client releases
      // the lock by hand, and the platform releases it for us when the tab
      // hides or the page goes away. `wanted` is what survives that, so the
      // visibilitychange handler below can take it back.
      await wl.request("screen");
      return "acquired";
    } catch {
      // Low battery, hidden tab, permission policy — all silent. The resume
      // token path recovers the seat if the screen does lock and the socket
      // drops.
      return "unavailable";
    }
  }

  // The platform releases the lock whenever the tab hides; the documented
  // pattern is to re-request on the next visibilitychange -> visible.
  if (doc) {
    doc.addEventListener("visibilitychange", () => {
      if (wanted && doc.visibilityState === "visible") void acquire();
    });
  }

  const wakeLock = {
    request(): Promise<WakeLockResult> {
      wanted = true;
      return acquire();
    },
  };

  // --- audio (synthesized; armed by the entry tap) -----------------------

  let audioCtx: CapAudioContext | null = null;

  function arm(): void {
    if (!AudioCtor) return;
    try {
      if (!audioCtx) audioCtx = new AudioCtor();
      // Created inside a gesture handler the context should come up running,
      // but iOS sometimes hands it over suspended anyway — resume is idempotent.
      void audioCtx.resume().catch(() => {});
    } catch {
      audioCtx = null;
    }
  }

  // One short envelope-shaped sine. All frequencies/durations live here so the
  // sounds are tweakable in code — the "no bundled asset" decision.
  function note(
    ctx: CapAudioContext,
    freq: number,
    start: number,
    dur: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  function play(fn: (ctx: CapAudioContext) => void): void {
    const ctx = audioCtx;
    if (!ctx) return; // never armed (or arming failed) — silent phone, fine
    try {
      if (ctx.state === "suspended") {
        // Browser quirk: armed yet still suspended. One more resume attempt,
        // then schedule regardless — if it stays suspended the notes are
        // inaudible no-ops and the room's sound survives via other phones.
        void ctx.resume().catch(() => {});
      }
      fn(ctx);
    } catch {
      /* audio is garnish */
    }
  }

  const audio = {
    arm,
    // The reveal sting: a two-note rise (G4 -> D5), landing together with the
    // poem's materialization.
    sting(): void {
      play((ctx) => {
        const t = ctx.currentTime;
        note(ctx, 392.0, t, 0.18);
        note(ctx, 587.33, t + 0.12, 0.5);
      });
    },
  };

  return { canShare, share, copy, vibrate, wakeLock, audio };
}
