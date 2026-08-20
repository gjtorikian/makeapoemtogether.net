import type { ClientMsg } from "../shared/types.ts";
import type { RoomVisibility } from "../shared/rooms.ts";
import type { SavedPoem } from "../shared/gallery.ts";
import type { AppState } from "./state.ts";
import type { Capabilities } from "./lib/capabilities.ts";
import { clear, el } from "./lib/dom.ts";
import { Landing } from "./screens/landing.ts";
import { HostConfig } from "./screens/hostConfig.ts";
import { HostWaiting } from "./screens/hostWaiting.ts";
import { Contributor } from "./screens/contributor.ts";
import { Audience } from "./screens/audience.ts";
import { Composing } from "./screens/composing.ts";
import { Reveal } from "./screens/reveal.ts";
import { pickStageScreen, stageRipple } from "./stage/stageScreens.ts";

// Ephemeral client-only view flags that aren't part of the server-mirrored
// `AppState`. `configuring`: the host taps "Launch poem" on the landing screen
// (room still `empty` server-side) and configures the poem before the `launch`
// frame moves the room to `collecting`. `entered`: true from boot on phones
// (they have no entry screen); on the stage it is flipped by the operator's
// "Open the stage" tap and never cleared — not even on `reset` — because what
// it records (audio armed, wake lock asked, hello replayed) is per-page-load,
// not per-round.
// `isStage`: the page was opened at /stage — a startup-time fact (main.ts reads
// location once), carried here because AppUi is where view-only flags live.
// The stage is a rendering costume, not a protocol role: same wire, same
// reducer, projector-scale screens that never claim a seat.
// `recentPoems`: the archive, fetched over REST for the landing screen's grid.
// It is view-only client state and NOT part of the server-mirrored `AppState`
// — the room protocol knows nothing about saved poems, and the reducer must
// stay a pure function of the wire. null means "not fetched yet", which the
// landing renders as nothing at all rather than as an empty shelf.
// `morePoems`: the fetched page was not the whole collection, so the landing
// offers the way through to /gallery.
// `codeEntry`: what the lobby's private-code field currently holds. It lives
// here, not in `AppState`, because it is nobody's business but this tab's until
// the moment Join is tapped.
// `config`: what the host has set up but not yet launched.
export interface AppUi {
  configuring: boolean;
  entered: boolean;
  isStage: boolean;
  recentPoems: SavedPoem[] | null;
  morePoems: boolean;
  // Ids of poems that appeared in the latest fetch and were not there before —
  // the ones the shelf should float in rather than simply have. Same one-paint
  // lifetime as `justFilledSeat`: main.ts empties it immediately after the
  // paint that consumed it, so an unrelated repaint never replays the arrival.
  freshPoems: ReadonlySet<string>;
  codeEntry: string;
  config: HostConfigDraft;
}

// The host-config screen's in-progress choices, held OUT of that screen's
// closure. Screens are rebuilt from scratch on every paint, and paints happen
// for reasons the config screen shows nothing of — a lobby refresh two rooms
// away, the archive fetch landing, a reconnect banner. Keeping the draft here
// is what stops any of those from quietly resetting the room someone is
// halfway through setting up.
export interface HostConfigDraft {
  // The mood pad's point, in [0,1]^2.
  x: number;
  y: number;
  // The committed people count, and the raw text of the field it is typed in
  // (which may be mid-edit, and legitimately not a number we can launch on).
  people: number;
  peopleText: string;
  visibility: RoomVisibility;
  // How long the poem gets before it expires. Always one of the shared stops,
  // and always legal for `visibility` — the slider clamps it whenever either
  // changes (see hostConfig.ts's refreshDuration).
  durationMs: number;
}

// What every screen receives. `send` is the only way to talk to the server;
// `rerender` lets a screen request a re-paint after flipping a `ui` flag;
// `caps` is the single gateway to device APIs (share/vibrate/wake lock/audio);
// `enter` is the entry tap's wiring, implemented in main.ts. `join` enters a
// room by code — a `send` of its own plus the per-arrival bookkeeping (the URL,
// the auto-join guards) that only main.ts can do.
export interface ScreenCtx {
  state: AppState;
  ui: AppUi;
  send(msg: ClientMsg): void;
  join(code: string): void;
  rerender(): void;
  disconnected: boolean;
  caps: Capabilities;
  enter(): void;
}

// The last reaction sequence this renderer has painted. Renderer-local (not
// game state): it only exists so an unrelated re-render doesn't replay the
// ripple, while a genuinely new `reaction` frame always does.
let lastPulseSeq = 0;

// state + role -> screen. The client never decides game state; it only chooses
// which view mirrors the current `phase`/role.
export function render(root: HTMLElement, ctx: ScreenCtx): void {
  clear(root);
  // The one place stage styling is scoped: every projector-scale CSS rule
  // lives under `.stage`, so the phone surface cannot regress.
  root.classList.toggle("stage", ctx.ui.isStage);
  if (ctx.disconnected) root.append(banner());
  const pulse = ctx.state.reactionPulse;
  if (pulse.seq > 0 && pulse.seq !== lastPulseSeq) {
    lastPulseSeq = pulse.seq;
    // The stage renders the same coalesced frame as an expanding ring. The
    // swap happens HERE, inside the module's single pulse consumer — a second
    // consumer of `reactionPulse.seq` would starve this one.
    root.append(ctx.ui.isStage ? stageRipple(pulse.count) : ripple(pulse.count));
  }
  root.append(ctx.ui.isStage ? pickStageScreen(ctx) : pickScreen(ctx));
}

function pickScreen(ctx: ScreenCtx): HTMLElement {
  const { state, ui } = ctx;
  // In no room: the lobby, where a poem is chosen or made. This is the client's
  // whole routing rule — `code` is set by a `state` frame and cleared by a
  // `lobby` one, so which side of the line we are on is the server's call, not
  // a guess from the phase.
  if (state.code === null) {
    if (ui.configuring) return HostConfig(ctx);
    return Landing(ctx);
  }
  // No entry threshold on phones: a visitor is greeted by the lobby itself, and
  // someone who followed a join link lands straight in their role. (iOS audio
  // arms on the first tap anywhere — main.ts's one-time pointerdown listener.)
  if (state.phase === "revealed") return Reveal(ctx);
  if (state.phase === "composing") {
    // Everyone sees the same screen while the poem is written — host and
    // contributors alike have nothing left to do but wait for it. The reveal
    // frame lands the moment the composer answers.
    return Composing(ctx);
  }
  if (state.phase === "collecting") {
    // A seat that still owes a word outranks the host screen: the input lives
    // only on the contributor screen, so an inherited host role must never cost
    // someone their turn. Hosts never draw a seat of their own, which makes
    // this reachable in exactly one situation — a departed host's role handed
    // on to someone who was already writing.
    const mine = state.seats.find((s) => s.index === state.mySeat);
    if (state.mySeat !== null && !(mine?.filled ?? false)) return Contributor(ctx);
    if (state.isHost) return HostWaiting(ctx);
    if (state.mySeat !== null) return Contributor(ctx);
    // Seatless in a collecting room is a role, not a waiting room: the old
    // "Finding you a seat…" dead end is gone.
    return Audience(ctx);
  }
  // `empty` inside a room is a moment nobody sees — a room is launched into
  // `collecting` and disposed of when it falls back — but the phase union still
  // has the case, and the lobby is where someone in a room with no round
  // belongs.
  return Landing(ctx);
}

// One node per coalesced `reaction` frame — never one per tap. Fifty phones
// tapping inside the same window arrive as a single frame and paint as a
// single pulse (the count rides along), so a reaction storm is one reflow.
function ripple(count: number): HTMLElement {
  return el("div", { class: "ripple", role: "presentation" }, [
    el("span", { class: "ripple__heart", text: "♥" }),
    count > 1 ? el("span", { class: "ripple__count", text: `×${count}` }) : null,
  ]);
}

function banner(): HTMLElement {
  return el(
    "div",
    { class: "banner", role: "status", ariaLabel: "Connection lost" },
    ["Reconnecting…"],
  );
}
