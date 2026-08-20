import "./styles/app.css";
import type { ServerMsg } from "../shared/types.ts";
import { normalizeRoomCode } from "../shared/rooms.ts";
import { initialState, reduce, type AppState } from "./state.ts";
import { connect, type Wire, type WireStatus } from "./lib/ws.ts";
import { mockWire } from "./lib/mockWs.ts";
import { createCapabilities } from "./lib/capabilities.ts";
import { render, type AppUi } from "./render.ts";
import { initialConfigDraft } from "./screens/hostConfig.ts";
import { parseGalleryRoute } from "./gallery/route.ts";
import { mountGallery } from "./gallery/mount.ts";
import { fetchPage } from "./gallery/api.ts";

// Boot: open a wire (real WS, or the mock when `?mock=<scene>` is present), fold
// every server frame into `state` via the pure reducer, and re-render. The
// client mirrors the server — it never derives game state on its own.
const root = document.getElementById("app");
if (!root) throw new Error("missing #app root");
const app: HTMLElement = root;

// Every device API flows through this one feature-detected, never-throwing
// object; nothing else in the client reaches for the share / vibrate / wake
// lock APIs directly. Created once — its wake lock re-acquire listener lives
// for the page.
const caps = createCapabilities();

// The resume secret, and the room it belongs to.
//
// Kept in localStorage, which is a deliberate change of mind. sessionStorage
// was right when a poem was a ten-minute party trick: the secret died with the
// tab, which matched the toy's ephemerality, and the failure it had to survive
// was a phone locking mid-round. But a poem can be given six hours or a day, and
// on one of those CLOSING THE TAB IS THE NORMAL THING TO DO — you sign up, put
// the phone away, and come back when it is your turn. Now that a seat is held
// for you until somebody frees it, a secret that died with the tab would mean
// coming back to find your own chair occupied by a ghost of yourself that only
// the host could clear.
//
// The cost is that every tab on this browser reads the same secret, so opening
// the invite link twice would have the second tab claim the first one's seat.
// The room settles that: a `hello` for an identity whose connection is still
// answering is refused (Room.onHello), so the live tab keeps it and the new one
// is an ordinary visitor.
//
// The code rides along because a token is only meaningful in the room that
// minted it: replaying last poem's token into this poem's room would at best be
// ignored and at worst reclaim a seat in a round this tab has left.
const TOKEN_KEY = "lets-make-a-poem/resume";

// Which poem this tab is in, as far as the address bar is concerned. A join
// link is the ordinary way into a room — a QR on a projector, a code passed
// across a table — so the code lives in the URL, which is also what makes a
// reload land back in the same poem.
const ROOM_PARAM = "room";

const params = new URLSearchParams(location.search);
const scene = params.get("mock");
// The mock wire knows nothing about rooms: it plays canned frames for one
// screen. Every room-addressing behavior below is switched off for it rather
// than half-working.
const isMock = scene !== null;

// The stage: the same SPA opened at /stage renders projector-scale screens on
// an ordinary connection — no protocol role, no seat, ever. A startup-time
// branch exactly like the `?mock=` switch above: decided once from location,
// never touching the reducer. Path over query param because /stage is
// speakable and typeable on a venue laptop, and the SPA fallback (dev and
// prod) already serves it.
const isStage = location.pathname === "/stage";

// The gallery (/gallery, /poem/:id) is a different kind of page: it reads the
// archive over REST and never opens a socket. Branching here — before any wire
// exists — is what guarantees a reader browsing last night's poems cannot be
// handed a seat in tonight's room by the auto-join below.
const galleryRoute = parseGalleryRoute(location.pathname);

let state: AppState = initialState;
const ui: AppUi = {
  configuring: false,
  // Phones no longer cross an entry screen — a visitor lands straight on the
  // lobby, or straight in their role when they followed a join link. Only the
  // stage keeps its threshold ("Open the stage"): a projector needs the
  // operator's deliberate tap, and that tap arms the laptop's audio.
  entered: !isStage,
  isStage,
  // Filled by loadRecentPoems() below — null until the first fetch answers.
  recentPoems: null,
  morePoems: false,
  // What the private-code field currently holds. View-only: the server never
  // sees a keystroke of it until Join.
  codeEntry: "",
  // The host's in-progress setup, kept across paints (and across rounds, so a
  // second poem starts from the shape of the first).
  config: initialConfigDraft(),
};
let status: WireStatus = "connecting";
let everOpened = false;
let joinRequested = false;
// Decided once per ATTACH, on the first state frame that arrives from the room
// we just entered: only a tab that ARRIVES into a collecting room auto-claims a
// seat. Someone who was already sitting in the room when it launched, or who
// attached to watch a poem that has moved on, lands on the audience screen —
// whose explicit "Grab a seat" is the deliberate path. Reset to null by
// attachTo(), so each join is judged on its own arrival.
let autoJoinEligible: boolean | null = null;
let helloSent = false;
let wire: Wire;

// The room this tab believes it is in. Seeded from the URL (a join link), kept
// in step with the server's `state` frames, and cleared when the room ends. It
// is what a reconnect re-attaches to — a fresh socket is a fresh connection to
// the server and remembers nothing on its own.
let boundCode: string | null = isMock ? null : normalizeRoomCode(params.get(ROOM_PARAM) ?? "");

// The room we have asked to be in and not yet had an answer about.
//
// It exists because the server GREETS every new connection with a `lobby`
// frame, and we send our `attach` the instant the socket opens — so that
// greeting, composed before the server had heard of us, lands after it. Taken
// at face value it says "you are in no room", which clobbered `boundCode` in
// the one-frame gap before `token` arrived, and the resume secret was dropped
// on the floor. Every reconnect after that was a stranger arriving: the seat
// stayed held, and its owner sat in the audience of their own poem.
//
// So while an attach is outstanding, a `lobby` frame is stale by construction
// and ignored entirely. Cleared by anything that IS an answer — `state` (we are
// in), `error` (we are not), `reset` (there is nothing to be in).
let awaitingAttach: string | null = null;

// A stage opened at a specific code is PINNED to it: an operator who asked for
// one poem must not be handed a different one when that round ends. Read once,
// from the address the page was opened at — `boundCode` moves around afterwards
// (and is cleared when a room ends), so it cannot answer this question later.
const stagePinned = isStage && boundCode !== null;

interface StoredResume {
  code: string;
  token: string;
}

function storedResume(): StoredResume | null {
  // Storage access can throw (privacy modes); resume is a nicety, not a need.
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredResume>;
    return typeof parsed.code === "string" && typeof parsed.token === "string"
      ? { code: parsed.code, token: parsed.token }
      : null;
  } catch {
    return null;
  }
}

function storeResume(value: StoredResume | null): void {
  try {
    if (value === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, JSON.stringify(value));
  } catch {
    /* fine — resume simply won't survive a reload */
  }
}

// Replay the stored identity at most once per connection, and always right
// after the `attach` that puts us back in its room: the server must weigh the
// resume before treating this connection as a fresh visitor. (Should the resume
// lose anyway, the reducer swallows the fallout — `token-in-use` /
// `already-seated` are not errors a visitor can act on; the storage
// side-channel below clears the dead token.)
function sendHello(): void {
  // The stage never replays an identity: an operator who tested as a
  // contributor in this tab and then typed /stage would otherwise RESUME THAT
  // SEAT onto the projector. Gated here — the one choke point — so every call
  // site is covered.
  if (isStage) return;
  if (helloSent) return;
  const resume = storedResume();
  // A token is only good in the room that issued it.
  if (resume === null || resume.code !== boundCode) return;
  helloSent = true;
  wire.send({ t: "hello", token: resume.token });
}

// Enter a room by code: from the URL on boot, from a tap on the lobby's
// listing, from a typed private code, or from a reconnect putting us back where
// we were. The per-connection join guards reset here because this arrival is
// its own arrival — that is what makes "I followed a link into a collecting
// room" mean "seat me", exactly once, per room entered.
function attachTo(code: string): void {
  boundCode = code;
  awaitingAttach = code;
  autoJoinEligible = null;
  joinRequested = false;
  helloSent = false;
  wire.send({ t: "attach", code });
  sendHello();
}

// Keep the address bar honest about which poem this tab is in, without adding a
// history entry — the room is not a page you go back to. This is also what
// makes a reload, and the browser's own restore-the-tab, land in the same room.
function syncUrl(): void {
  if (isMock) return;
  const next = new URL(location.href);
  if (boundCode === null) next.searchParams.delete(ROOM_PARAM);
  else next.searchParams.set(ROOM_PARAM, boundCode);
  if (next.href !== location.href) history.replaceState(null, "", next.href);
}

// The landing screen's grid of finished poems. A REST read, kept entirely out
// of the reducer (the room protocol has no idea the archive exists) and out of
// the render path — screens re-run constantly and must never fire an effect,
// so this is driven from `onMessage`, alongside the other side-channels.
//
// `stale` is what makes a just-finished poem appear: the round that ends with
// `reset` added one, so the next visit to the lobby must re-fetch rather than
// show the list it loaded when the tab opened.
let poemsLoading = false;
let poemsStale = true;

async function loadRecentPoems(): Promise<void> {
  if (poemsLoading || !poemsStale) return;
  poemsLoading = true;
  const res = await fetchPage(null);
  poemsLoading = false;
  poemsStale = false;
  // A failed fetch leaves the lobby exactly as it is: the poems are a welcome,
  // not a feature anyone is waiting on, and an error message here would be the
  // first thing a guest sees on arriving.
  if (!res.ok) return;
  ui.recentPoems = res.value.poems;
  ui.morePoems = res.value.nextBefore !== null;
  // Same courtesy as a lobby refresh: the config screen shows no archive, and
  // an unannounced repaint under someone's fingers is a poor trade for a grid
  // they will see the moment they are back on the lobby.
  if (!ui.configuring) paint();
}

function paint(): void {
  render(app, {
    state,
    ui,
    send: (m) => wire.send(m),
    rerender: paint,
    caps,
    enter,
    join: attachTo,
    // Only nag about the connection after we've actually been connected — the
    // initial "connecting" flash shouldn't show a reconnect banner.
    disconnected: everOpened && status !== "open",
  });
}

// The stage operator's entry tap ("Open the stage"): arms the laptop's audio +
// wake lock inside the one guaranteed gesture and lifts the stage's gate.
// `entered` never clears afterwards — audio stays armed for the page's life.
function enter(): void {
  if (ui.entered) return;
  caps.audio.arm();
  void caps.wakeLock.request();
  sendHello();
  ui.entered = true;
  maybeAutoJoin();
  paint();
}

// Phones have no entry screen anymore, but iOS still only starts an
// AudioContext inside a user gesture — so the FIRST tap anywhere (launching,
// grabbing a seat, submitting, reacting) arms audio and asks for the wake
// lock. Once is enough: both survive for the page's life, and the wake lock
// re-acquires itself via capabilities.ts's visibilitychange listener.
if (!isStage && !galleryRoute) {
  document.addEventListener(
    "pointerdown",
    () => {
      caps.audio.arm();
      void caps.wakeLock.request();
    },
    { once: true },
  );
}

// A visitor who arrives into a collecting room claims the next open seat — at
// most once per attach (every `state` broadcast would otherwise re-trigger it),
// and only if this arrival landed IN the collection (`autoJoinEligible`).
// This is deliberately the ONLY automatic join path; the audience screen's
// claim button sends its own explicit `join`, but a fresh visitor never
// double-requests.
function maybeAutoJoin(): void {
  // A stage in a collecting room satisfies every phone precondition below
  // (collecting, not host, seatless) — this gate is what keeps a projector
  // from eating a contributor's seat. Structural: no stage screen has a join
  // button either, so this is the only path to close.
  if (isStage) return;
  if (
    autoJoinEligible === true &&
    state.phase === "collecting" &&
    !state.isHost &&
    state.mySeat === null &&
    !joinRequested
  ) {
    joinRequested = true;
    wire.send({ t: "join" });
  }
}

// The projector, unpinned: follow whichever public poem is happening. A venue
// laptop is opened once at /stage and left alone, so it takes the oldest listed
// room — the one closest to finishing — and takes the next one when that round
// ends. An operator who wants a specific poem (a private one, or one of
// several) opens /stage?room=CODE instead, and this never fires again for the
// life of the page — not even after that poem ends.
//
// Private rooms are never followed. They are not in the listing at all, which
// is the whole point of them.
function maybeFollowPublicRoom(): void {
  if (!isStage || stagePinned || boundCode !== null) return;
  const next = state.lobby.rooms[0];
  if (next) attachTo(next.code);
}

function onMessage(msg: ServerMsg): void {
  // A listing that was composed before the server had heard our `attach` is not
  // about us — see `awaitingAttach`. Dropped whole rather than merely ignored
  // for `boundCode`: the reducer treats any `lobby` frame as "you are in no
  // room" and would wipe the room off the screen, flashing the lobby in the
  // middle of a reconnect nobody asked to see.
  if (msg.t === "lobby" && awaitingAttach !== null) return;
  if (msg.t === "state" || msg.t === "error" || msg.t === "reset") {
    awaitingAttach = null;
  }
  // Side-channels the pure reducer must not own (storage, clocks, effects):
  // The stage stores no token — it has no seat to resume, and writing its
  // unclaimed identity would clobber a token a phone visit in this tab may
  // still want.
  // `awaitingAttach` as a fallback, not decoration: this frame answers a
  // `connect` we asked for, so the room it belongs to is the one we asked for
  // even if nothing has confirmed it yet. Losing this write is not a cosmetic
  // failure — it is the whole resume mechanism, silently.
  const tokenRoom = boundCode ?? awaitingAttach;
  if (msg.t === "token" && !isStage && tokenRoom !== null) {
    storeResume({ code: tokenRoom, token: msg.value });
  }
  // NOTE: a stored token used to be discarded here on `token-in-use`. It must
  // not be. That refusal now means one thing only — another tab on this browser
  // is in the room and still answering — and the secret is that tab's to keep
  // using. Throwing it away would end its poem the next time it reconnected. A
  // token whose room has ended is a different matter: Nothing would come of replaying it (the
  // identity lived in that Room object, which is gone), but a secret with
  // nothing left to unlock has no reason to sit in storage.
  if (msg.t === "reset") storeResume(null);
  // The first frame from a room we just entered decides auto-join for that
  // stay: landing mid-collection means "I followed the link to write" (seat
  // them); anything else means we came to watch, and every later round must be
  // joined by a tap, not by inertia.
  if (msg.t === "state" && autoJoinEligible === null) {
    autoJoinEligible = msg.phase === "collecting";
  }
  // The server is authoritative about which room this connection is in — both
  // directions. `state` says which one; `lobby` says none.
  if (msg.t === "state") boundCode = msg.code;
  if (msg.t === "lobby" || msg.t === "reset") boundCode = null;
  if (msg.t === "state" || msg.t === "lobby" || msg.t === "reset") syncUrl();
  if (msg.t === "reveal") {
    // The choreographed moment: sting + vibration fire HERE, on the frame
    // transition, exactly once — never in the Reveal screen's render, which
    // replays on every reaction pulse or banner toggle. A late joiner learns
    // of the poem via a `state` frame instead and correctly gets neither.
    if (state.poem === null) {
      caps.audio.sting();
      caps.vibrate([40, 60, 120]); // Android garnish; silently absent on iOS
    }
  }
  // The lobby is the only screen that shows the archive, so fetch it exactly
  // when we are in it (and re-fetch after a round ends — that reset means a
  // poem was added). No other phase pays for the request.
  if (msg.t === "reset") poemsStale = true;
  if (msg.t === "lobby" || msg.t === "reset") void loadRecentPoems();
  state = reduce(state, msg);
  // Entering a room is what closes the setup screen — and ONLY that. A lobby
  // refresh must never close it: the listing changes on its own schedule (any
  // room anywhere filling up), and a host halfway through choosing a room size
  // would be thrown back to the lobby by somebody else's poem.
  if (msg.t === "state") ui.configuring = false;
  // NOTE: a room ending does NOT re-arm auto-join. Last round's contributors
  // become the next round's lobby visitors until they pick a poem — seats are
  // claimed by people, not by whichever tabs happen to still be open.
  maybeAutoJoin();
  maybeFollowPublicRoom();
  // A lobby refresh while the host is setting up a poem changes nothing on
  // their screen — the listing is not on it — and repainting mid-edit would
  // take the caret out of the field they are typing in. The draft would
  // survive (it lives in `ui`), but the interruption is still wrong.
  if (msg.t === "lobby" && ui.configuring) return;
  paint();
}

function onStatus(s: WireStatus): void {
  status = s;
  if (s === "open") {
    everOpened = true;
    // A fresh socket is a fresh client to the server — it has no idea which
    // room this tab was in, and no idea who we were. Re-attaching (and, inside
    // that, replaying the stored token) is what makes a dropped connection a
    // blip rather than an ejection.
    joinRequested = false;
    helloSent = false;
    if (boundCode !== null) attachTo(boundCode);
  }
  paint();
}

if (galleryRoute) {
  // The gallery runs its own tiny runtime (routing + REST) and shares only
  // `caps` — the share sheet works the same on a week-old poem as on a fresh
  // one. Nothing below this line runs: no socket is ever opened.
  mountGallery(app, caps);
} else {
  if (scene) {
    if (scene === "hostConfig") ui.configuring = true;
    wire = mockWire(scene, { onMessage, onStatus });
  } else {
    wire = connect({ onMessage, onStatus });
  }

  paint();
}
