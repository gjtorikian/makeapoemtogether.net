# Let's Make a Poem

A real-time collaborative exquisite-corpse poem game. A visitor hosts a poem — picking its mood on a lyric/narrative/descriptive/dramatic grid, how many people are writing, and whether the poem is public or private — and each subsequent visitor contributes one assigned word type, in turn, guided only by a clue about the word before theirs. Submitted words remain hidden until every slot is filled, then everyone sees the same generated poem at once.

Several poems can be underway at once. Arriving at `/` puts you in the **lobby**: join a public poem that is filling up right now, type the four-character code for a private one, or start your own.

The application is mobile-first. A round is ephemeral — seats, clues, and the room itself die with it — but the poem it produces is not: every revealed poem is written to disk and stays readable in the gallery at `/gallery`, with a permalink of its own at `/poem/:id`. Starting another round no longer costs you the last one.

## Requirements

- Node.js 22 or later
- npm

## Run Locally

```bash
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`). The development server includes the live room WebSocket endpoint at `/ws`, so separate browser windows or devices connected to the same URL can start poems, find each other in the lobby, and write together.

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
error, a timeout, and an unparseable response — **a reveal never fails and never
waits on a third party**, it just degrades to the deterministic poem. Fallbacks
are always logged with their reason; a silent one is a bug.

**Tense agreement** (`src/engine/tense.ts`) is the last pass, and it runs on the
output of both engines. Whatever tense the poem's first verb is in, every later
verb is pulled into it — `The stars were flying where the child eats` becomes
`…where the child ate`. Neither writer upstream can do this alone: the
deterministic engine inflects each word from its immediate neighbours, and a
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
model to use "restless" as a noun or "sang" as an adjective — and a reasoning
model handed that would deliberate until it hit `max_tokens` and return
`content: null`, having never written a line. Every such round degraded to the
deterministic poem. Disabling reasoning fixed it outright and measured about
twice as fast and six times cheaper on those inputs.

```bash
cp .env.example .env      # then add your key from https://openrouter.ai/keys
```

The key is read from `process.env` on the server only. It is deliberately not a
`VITE_`-prefixed variable, so it can never be inlined into the browser bundle;
the client never talks to OpenRouter and never learns which engine wrote a poem.

`OPENROUTER_MODEL` accepts any slug from https://openrouter.ai/models and
defaults to `anthropic/claude-sonnet-5` (roughly $0.002 per poem). For better
verse at about five times the cost, try `anthropic/claude-fable-5`.

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

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Vite development server with the shared room WebSocket server. |
| `npm run build` | Build the browser client and production Node server. |
| `npm run build:server` | Rebuild only the production Node server bundle. |
| `npm start` | Run the built production server. |
| `npm run typecheck` | Type-check without emitting files. |

## Public and Private Poems

Every poem gets a four-character code drawn from [Crockford's base32][crockford]
— ULID's alphabet, which leaves out `I`, `L`, `O` and `U` so nothing is
misread off a projector or misheard across a table. The code is the poem's
address: `https://<origin>/?room=K7QM` is the join link, and it is what the
stage's QR encodes.

What the code is *for* depends on the poem:

| | Public | Private |
| --- | --- | --- |
| In the lobby | Listed, with its fill state, joinable by tapping | Not listed — only counted ("a private poem is waiting") |
| How people get in | Tap the listing, follow a link, or scan the stage QR | The code, from someone who has it |
| The stage follows it | Yes, if unpinned (see below) | Only when pinned with `/stage?room=CODE` |

A code that is typed is normalized the way Crockford intended: case is folded,
spaces and dashes are dropped, and `I`/`l` read as `1` with `O` as `0`. A wrong
code and a malformed one get the same answer — "No poem is waiting under that
code" — so guessing at private codes tells you nothing.

Rooms live only as long as their round: cancelling, the host being gone past
the grace window, or ten idle minutes ends a poem, and its code goes with it.
Everyone still in it lands back in the lobby.

[crockford]: https://www.crockford.com/base32.html

## How a Round Works

1. A visitor lands on the lobby and starts a poem: they pick its mood on a grid between **lyric**, **narrative**, **descriptive**, and **dramatic** (the chosen point sets the adjective/noun/verb mix), how many people are in the room — each person writes one word — and whether it is public or private. (There is no entry screen; the phone's audio and wake lock arm on the first tap anywhere, since iOS only starts an AudioContext inside a user gesture.)
2. Everyone who arrives *into the poem* — by join link, by tapping it in the lobby, or by typing its code — is seated into an open slot and randomly assigned its word type; every surface shows the whole poem shape, with still-unclaimed types as dim slots that light up as arrivals draw them. Once every seat is claimed, later arrivals join the audience: they watch the slots fill, but never see a word. (A tab sitting on the lobby is in no poem at all and is never handed a seat by one starting.)
3. The poem is written as a **queue**, in slot order. Seat 0 writes free. Every later author waits their turn and is unlocked with a *clue* about the word just before theirs — "desk" arrives as "a place where one writes". The clue is written by the same OpenRouter pass that composes the poem (deterministic fallback without a key: "a noun, starts with D, 4 letters"), delivered only to the one author whose turn it is. The host only ever sees slot occupancy, never a word.
4. When all slots are filled, the room enters `composing` and hands the words to the composer. Everyone waits on the same screen; no word is on the wire yet.
5. The moment the composer answers, the poem is revealed simultaneously to everyone in that room — and written to the archive on the same beat. The host's "Make another" ends the room and returns everyone to the lobby; everyone else can leave on their own, which is a different thing on purpose (a late arrival reading the poem must not be able to close the room out from under the people still reading it). Either way the poem is already in the gallery.

## The Gallery

Every revealed poem is appended to `${DATA_DIR}/poems.jsonl` (`DATA_DIR`
defaults to `./data`), one JSON object per line, oldest first. A poem is a few
hundred bytes and an evening produces a few dozen, so there is no database: an
append-only file is smaller than the client bundle, survives a venue laptop
losing power mid-write (at worst the last line is unparseable, and it is
skipped), and can be read, backed up, or grepped with ordinary tools.

The lobby renders the most recent poems as a grid under the start button, so an
arriving guest sees what this thing produces rather than a sentence describing
it. (Before the first poem exists there is nothing there —
no empty shelf, no dead link.) Two further surfaces read the same archive:

| Route | What it is |
| --- | --- |
| `/gallery` | Every poem, newest first, paged with **Show older poems**. |
| `/poem/:id` | One poem's permalink, with older/newer navigation and the same share/copy control the reveal screen uses. |

Each saved poem also records **where the room's own words landed** — a
character range per submitted word (`src/engine/marks.ts`), computed at
composition because it stops being knowable the moment the poem is just text:
nothing downstream can tell a player's `lantern` from a writer's `the`. Those
words get a dotted underline on every surface that shows a whole poem — the
reveal, the projector, and the permalink — so the room can see which words were
theirs in the moment, and still see it weeks later. The scan is the fidelity guard's, reused — same tokenizer, same
accepted inflections, same forward-only walk — so a mark lands on the exact
token the guard counted, in the inflected form actually printed (`moons`, not
`moon`). Poems archived before this existed render unmarked, and a range that
doesn't point at real characters is dropped rather than underlining the middle
of a word.

Both are read-only and served over REST (`GET /api/poems`,
`GET /api/poems/:id`) rather than the room socket. A gallery page **never opens
a WebSocket**, which is what keeps someone browsing last night's poems from
being handed a seat in tonight's round. Nothing a browser can send creates or
deletes a poem — the room, on reveal, is the only author.

Archiving is deliberately fire-and-forget on the transport side: the broadcast
goes out first and no phone ever waits on a disk, so the simultaneous reveal is
never delayed. A write that fails (full disk, read-only volume) is logged and
the round carries on — the poem is on every screen either way, and only its
copy is lost.

Composition and clue-writing are asynchronous, so both are modelled as
*effects*: the room stays a synchronous state machine, asks the transport for a
poem (or a clue), and carries on until it answers with a `composed` (or `clued`)
event. Each request carries a token, so an answer for a round that was cancelled
or replaced mid-flight is dropped rather than delivered.

There is one room per server process. Refreshing or opening the root URL joins that shared room rather than creating a private session.

Seats are held by a connection, not a person, and the server pings every socket
on a 15-second heartbeat. A client that stops answering is disconnected and its
seat returned to the pool within about 30 seconds. Without this a vanished
client — a slept laptop, a dropped link, a background tab the browser discards —
would keep its seat indefinitely, because none of those ever send a close frame;
enough of them and the room shows "0 seats open" with nobody in it.

## Running It at a Venue

The venue deployment is one public **HTTPS** origin pointing at one production
server process (`npm run build && npm start` behind any TLS-terminating proxy
or host — the app itself needs no TLS configuration).

**Serve over HTTPS — here is why.** The phone features that carry a live room
are secure-context-only Web APIs: the screen wake lock (fifty phones must stay
lit through a round with nobody touching them) and the native share sheet for
the revealed poem. Over plain http the app degrades silently by design —
nothing errors, but screens sleep mid-round and share becomes copy (see
`src/client/lib/capabilities.ts`, where that degradation policy lives). Plain
http is a development mode, not a venue mode.

**Set up the stage.** Open `https://<your-origin>/stage` on the projector
machine and tap "Open the stage" — the same entry gesture as everyone else,
and it arms the laptop's audio, often the loudest speaker in the room. There
is nothing to configure: while no poem is running, the idle screen shows a QR
encoding exactly the origin in the address bar, and an **unpinned stage
follows whichever public poem appears** — oldest first, so it shows the one
closest to finishing, and it picks up the next one when that round ends. Its
corner QR then becomes that poem's join link, with the code printed beside it
for anyone whose camera won't cooperate.

To point the projector at one specific poem — a private one, or one of several
running at once — open `/stage?room=CODE` instead; a pinned stage never
follows anything else. The stage is a rendering mode, not a participant: it
never claims a seat, and like every screen it shows slot occupancy only until
the reveal.

**What the audience sees.** Phones that arrive after every seat is claimed
join the audience: the same fill map the host sees (occupancy only — never a
word), plus a way back to the lobby to find a poem that still has room.

**How claims work.** Seats go to whoever asks first — joining is a race by
design. When a seat frees up mid-round, every audience screen grows a "Grab a
seat" button; the first tap wins the slot and its word type. A lost race is
not an error: the next broadcast simply re-renders the button away.

**Recovering a stuck seat.** A phone that locks or drops mid-round keeps its
unfilled seat for a ~30-second grace window, and its resume token reclaims the
seat if it comes back. If a contributor is truly gone, the host's waiting
screen has a Release button on every seat: releasing overrides the grace hold
and returns the seat to the pool immediately, where the next joiner or an
audience member's "Grab a seat" claims it.

**Keeping the evening.** Point `DATA_DIR` at a directory that survives a
redeploy — a mounted volume, not a container's ephemeral filesystem — or the
night's poems go with the process. Guests who want to take one home can share
it from the reveal, but the permalink under `/poem/:id` is what still works
next week. The whole archive is one text file; copying it off the host is the
backup.

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
