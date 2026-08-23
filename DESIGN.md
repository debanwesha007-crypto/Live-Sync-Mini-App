# Design Write-Up — Live-Sync Sticky Board

## What it is
A shared sticky-note board: any browser tab that adds, moves, edits, or deletes
a note broadcasts that change to every other open tab in real time, using
WebSockets. Two tabs open side by side demonstrate the sync.

## Stack and why
- **React (via CDN + Babel standalone)** for the UI, per the assignment's
  requirement to use React — loaded straight in the HTML page rather than
  through a build tool (Vite/webpack), since the app has no other need for a
  bundler and this keeps `npm install` limited to the backend.
- **WebSockets over SSE**, because the app is bidirectional: clients don't
  just receive updates, they also *send* actions (add/move/edit/delete) that
  need to reach the server and then fan out to everyone else. SSE is a good
  fit for one-way server-to-client streams (e.g. a live poll tally); a
  collaborative board with client-originated writes fits WebSockets better.
- **Express + the `ws` library** rather than Socket.IO, to keep the protocol
  visible and simple (plain JSON messages over a raw WebSocket) rather than
  behind an abstraction layer — this made it easier to reason about and test
  the sync logic directly.

## Architecture
- The server is the single source of truth. It holds an in-memory `notes`
  object (`id -> {x, y, text, color, z, version}`) and relays every mutation
  to all other connected clients.
- Each client tracks its own copy of that state locally for instant
  rendering, and reconciles it as messages arrive from the server.
- On connect, a client receives a `sync` message with the full current board
  state, its own generated `clientId`, and a map of which notes are currently
  being edited by someone else.

## Handling three specific challenges

**1. Optimistic UI.** Every user action updates local React state immediately
— the button click, drag, or keystroke feels instant. The corresponding
message is sent to the server in the background, and the server's broadcast
(sent to *other* tabs) is what actually keeps everyone else in sync. The
originating tab doesn't wait on a round trip for its own UI to update.

**2. Concurrent edits on the same note.** Each note carries a `version`
number that increments on every accepted edit. When a client sends an edit,
it includes the version it last saw (`baseVersion`). If another tab's edit
already landed since then, the server rejects the stale write and sends the
current (winning) text back to the sender — surfaced in the UI as a visible
conflict banner with the choice to keep their own text anyway or accept the
other tab's. This avoids the common bug where the last message to arrive
silently wins with no indication anything was lost. As a lighter-weight
signal, tabs also broadcast when a note's textarea gains/loses focus, so
other tabs see a "someone's typing" badge before a conflict even happens.

**3. Surviving a refresh (and a restart).** Because state lives on the
server, not in the browser, simply reopening a tab already restores the
board via the initial `sync` message — no special handling needed there. To
go a step further, the server also persists `notes` to a local
`notes-data.json` file (debounced, so rapid edits don't hammer disk I/O) and
reloads it on boot, so a full server restart doesn't wipe the board either.

## Known limitations / what I'd add with more time
- Persistence is a flat JSON file — fine for a single-instance demo, but
  wouldn't scale to multiple server processes. A real deployment would use a
  database (e.g. Postgres or Redis) as the shared store instead.
- Conflict resolution is "reject and inform," not a merge — genuinely
  merging two people's simultaneous edits to the same text (like Google Docs)
  would need an operational-transform or CRDT approach, which felt like
  overkill for this scope.
- No authentication/rooms — any tab connecting to the server sees the same
  single board.
