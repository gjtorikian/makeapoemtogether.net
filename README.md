# Let's Make a Poem

A real-time collaborative exquisite-corpse poem game. A visitor hosts a poem — picking its mood on a lyric/narrative/descriptive/dramatic grid, how many people are writing, how long the poem has, and whether it is public or private — and each subsequent visitor contributes one assigned word type, in turn, guided only by a clue about the word before theirs. Submitted words remain hidden until every slot is filled, then everyone sees the same generated poem at once.

Several poems can be underway at once. Arriving at `/` puts you in the **lobby**: join a public poem that is filling up right now, type the four-character code for a private one, or start your own.

The application is mobile-first. A round is ephemeral — seats, clues, and the room itself die with it — but the poem it produces is not: every revealed poem is written to disk and stays readable in the gallery at `/gallery`, with a permalink of its own at `/poem/:id`. Starting another round no longer costs you the last one.

## How a Round Works

1. A visitor lands on the lobby and starts a poem: they pick its mood on a grid between **lyric**, **narrative**, **descriptive**, and **dramatic** (the chosen point sets the adjective/noun/verb mix), how many people are in the room — up to 25, each writing one word — how long the poem has before it expires, and whether it is public or private. (There is no entry screen; the phone's audio and wake lock arm on the first tap anywhere, since iOS only starts an AudioContext inside a user gesture.)
2. Everyone who arrives _into the poem_ — by join link, by tapping it in the lobby, or by typing its code — is seated into an open slot and randomly assigned its word type; every surface shows the whole poem shape, with still-unclaimed types as dim slots that light up as arrivals draw them. Once every seat is claimed, later arrivals join the audience: they watch the slots fill, but never see a word. (A tab sitting on the lobby is in no poem at all and is never handed a seat by one starting.)
3. The poem is written as a queue, in slot order. Seat 0 writes free. Every later author waits their turn and is unlocked with a _clue_ about the word just before theirs — "desk" arrives as "a place where one writes". The clue is written by the same OpenRouter pass that composes the poem (deterministic fallback without a key: "a noun, starts with D, 4 letters"), delivered only to the one author whose turn it is. The host only ever sees slot occupancy, never a word.
4. When all slots are filled, the room enters `composing` and hands the words to the composer. Everyone waits on the same screen; no word is on the wire yet.
5. The moment the composer answers, the poem is revealed simultaneously to everyone in that room — and written to the archive on the same beat. The host's "Make another" ends the room and returns everyone to the lobby; everyone else can leave on their own, which is a different thing on purpose (a late arrival reading the poem must not be able to close the room out from under the people still reading it). Either way the poem is already in the gallery.

## Requirements

- Node.js 22 or later
- npm

## Run Locally

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. The development server includes the live room WebSocket endpoint at `/ws`, so separate browser windows or devices connected to the same URL can start poems, find each other in the lobby, and write together.

## Poem Composition

Poems are composed server-side, by one of two engines.

**The deterministic engine** (`src/engine/`) is the default and needs no
configuration. It inflects each word by its slot type and stitches the results
together with articles, prepositions, and line breaks drawn from a pattern table
keyed on adjacent word types. It is fast, free, and reproducible — but it has no
model of meaning, so it cannot make two verbs agree with each other beyond the
tense pass described below.

**The OpenRouter pass** (`src/engine/llm.ts`) turns on when `OPENROUTER_API_KEY`
is set. It sends the words, in order, to a language model that can conjugate them
into agreement and write real connective tissue around them. Every response is
checked by the fidelity guard (`src/engine/guard.ts`) before anyone sees it:

- Every submitted word must appear, in submission order.
- Inflection is allowed — `walk` may become `walked`, `moon` may become `moons`.
  This latitude is the point of the pass.
- Substitution is not. A poem that swaps `walk` for `wandered` is rejected.

A rejected poem earns one corrective retry, then falls back. So does an HTTP
error, a timeout, and an unparseable response. A reveal never fails and never
waits on a third party, it just degrades to the deterministic poem. Fallbacks
are always logged with their reason; a silent one is a bug.

**Tense agreement** (`src/engine/tense.ts`) is the last pass, and it runs on the
output of both engines. Whatever tense the poem's first verb is in, every later
verb is pulled into it — `The stars were flying where the child eats` becomes
`…where the child ate`. Neither writer upstream can do this alone: the
deterministic engine inflects each word from its immediate neighbors, and a
language model drifts across a few lines however firmly the prompt asks it not
to. This is the only pass that reads the finished poem end to end.

It is deliberately timid. If there is no verb, one verb, or no detectable tense,
the poem is returned untouched; so is any rewrite that would change the number
of lines. And it never conjugates a word submitted into a noun or adjective slot
— a part-of-speech tagger reading a fragment will gladly turn someone's `velvet`
into `velveted`, and the fidelity guard cannot catch it (its prefix match
accepts the mangled form), so the tense pass checks that itself and discards the
whole rewrite rather than hand back a damaged word.

Composition typically takes 2–4 seconds, which is what the `composing` phase and
its screen exist to cover.

The request sends `reasoning: { enabled: false }`. This is not a cost tweak, it
is a correctness one. Slots are assigned at random, so the game routinely asks a
model to use "restless" as a noun or "sang" as an adjective, and a reasoning
model handed that would deliberate until it hit `max_tokens` and return
`content: null`, having never written a line. Every such round degraded to the
deterministic poem. Disabling reasoning fixed it outright and measured about
twice as fast and six times cheaper on those inputs.

## Production Build

```bash
npm run build
npm start
```

This builds the client to `dist/client` and bundles the HTTP/WebSocket server to `dist/server`. The server listens on port `3000` by default; set `PORT` to use another port.

```bash
PORT=8080 npm start
```

`GET /healthz` returns `ok` for health checks.

## Commands

| Command                | Purpose                                                                  |
| ---------------------- | ------------------------------------------------------------------------ |
| `npm run dev`          | Start the Vite development server with the shared room WebSocket server. |
| `npm run build`        | Build the browser client and production Node server.                     |
| `npm run build:server` | Rebuild only the production Node server bundle.                          |
| `npm start`            | Run the built production server.                                         |
| `npm run typecheck`    | Type-check without emitting files.                                       |

## Public and Private Poems

Every poem gets a four-character code drawn from [Crockford's base32](https://www.crockford.com/base32.html). The code is the poem's
address: `https://<origin>/?room=K7QM` is the join link, and it is what the
lobby's QR encodes.

Rooms live only as long as their round: cancelling, running out of time, or a
room nobody ever joined going idle ends a poem, and its code goes
with it. Everyone still in it lands back in the lobby.

## How Long a Poem Has

Every poem is launched with a deadline, chosen on the host's slider and fixed at
that moment.

|       | Public                | Private                    |
| ----- | --------------------- | -------------------------- |
| Range | 10 min → 1 hour       | 10 min → 24 hours          |
| Stops | 10/20/30/40/50/60 min | …plus 2h, 3h, 6h, 12h, 24h |

Public poems cap at an hour because a public poem sits in the lobby the entire
time it is alive, and a listing that outlives the evening is clutter every
visitor reads past. The long end is for a private poem passed around by code —
a poem written across a day rather than in one sitting. Toggling a 12-hour
poem back to public clamps it to the hour on the spot.

When the time runs out the poem is gone, words and all. Everyone lands back
in the lobby, and nothing is archived: an unfinished poem is not a poem. The
deadline is checked only while words are still being collected, so a round that
reached its last word a second before zero still composes and still reveals; it
is a limit on how long words may take to arrive, not on the reveal they earn.

The countdown is on every screen of a live poem — host, contributor, audience,
and the stage — and goes red in its final minute. It is one element driven by a
single interval (`src/client/lib/countdown.ts`), never by a repaint: rebuilding
the tree once a second would destroy the caret and half-typed word of whoever's
turn it is. Clients count down against a server timestamp using their own clock,
so a phone set to the wrong time shows the wrong number; the expiry itself is
the server's alone and arrives as a `reset` frame either way.

The stops are defined once, in `src/shared/duration.ts`, and the server
re-derives every duration from that table against the visibility the room was
actually created with — a hand-rolled frame asking a public room for a week gets
an hour.

Two things are deliberately NOT governed by the deadline. A room nobody has
joined still expires after ten idle minutes however long its deadline, so an
abandoned 24-hour poem does not sit on a code and a registry slot for a day. And
a round that has reached `composing` is committed: the compose backstop owns it
from there.

The room's patience scales with the poem. If someone leaves the room, their seat is held for them to rejoin, and then dropped completely.

| Poem     | Seat held | Slot dropped after | Total   |
| -------- | --------- | ------------------ | ------- |
| 10 min   | 30 s      | 20 s               | 50 s    |
| 1 hour   | 3 min     | 2 min              | 5 min   |
| 6 hours  | 18 min    | 12 min             | 30 min  |
| 24 hours | 72 min    | 48 min             | 2 hours |

## Project Structure

```text
src/client/  Vanilla TypeScript SPA, screens, state reducer, and styles
src/room/    Room state machine, round lifecycle, and the registry of live rooms
src/engine/  Composition: morphology, connective text, OpenRouter pass, fidelity guard
src/server/  HTTP static server, WebSocket room wiring, composer selection, poem archive + gallery API
src/client/gallery/  The /gallery and /poem/:id surfaces (REST, no socket)
src/shared/  Client/server protocol, room codes, composer interfaces, and the gallery contract
```

Rooms are sealed from one another at the transport: a connection is bound to at most one room, and a broadcast fans out to that room's members alone. The client receives only public seat occupancy during collection. Submitted words are kept server-side and sent to clients only in the final `reveal` message — and the archive is written from that same message, so nothing reaches disk that the room had not already made public.
