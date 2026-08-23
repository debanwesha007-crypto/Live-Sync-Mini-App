# Live-Sync Sticky Board

A small real-time app: open the page in two browser tabs, and any sticky note
you add, move, edit, or delete in one tab instantly shows up in the other.

## Stack
- **Frontend:** React 18 (loaded via CDN + Babel standalone — no build step, no `npm install` needed for the frontend)
- **Backend:** Node.js + Express (serves the page) + `ws` (WebSocket server)
- **Real-time transport:** WebSockets

## How it works
- The server (`server.js`) keeps the *authoritative* state of all sticky notes in memory **and** persists it to `notes-data.json` on every change (debounced), so state survives a server restart, not just a tab refresh.
- Each browser tab opens a WebSocket connection to the server.
- When a tab adds/moves/edits/deletes a note, it sends a small JSON message over the socket.
- The server updates its state and **broadcasts** the change to every other connected tab.
- A newly opened tab gets a full `sync` message with the current board state, its own client id, and who's currently editing what.
- **Optimistic UI:** every local action (add/move/edit) updates the UI immediately, before the server confirms it — the app doesn't wait on a round trip to feel responsive.
- **Concurrent-edit handling:** each note has a `version` number. When a tab sends an edit, it includes the version it last saw (`baseVersion`). If another tab's edit landed first, the server **rejects the stale write** and sends back the text that actually won — the second editor sees a conflict banner with the choice to keep their own text or accept the other tab's, rather than one edit silently vanishing. While a note is focused in another tab, editors also see a small "someone's typing" badge on it.

## Setup

```bash
cd live-sync-board
npm install
npm start
```

You should see:
```
Live-Sync Board running at http://localhost:3001
```

## Demo
1. Open `http://localhost:3001` in one browser tab.
2. Open the same URL in a second tab (or a second browser window) side by side.
3. In Tab A, click **"+ Add Sticky Note"** — it appears instantly in Tab B too.
4. Drag the note around in Tab A — Tab B's copy moves live.
5. Type into the note in either tab — the text syncs to the other in real time.
6. Delete a note — it disappears everywhere.

### Demoing conflict handling
1. Click into the same note's text box in *both* tabs at once (you'll see a "someone's typing" badge appear on the other tab).
2. Type different text in each tab within a second or two of each other.
3. Whichever edit reaches the server first wins; the *other* tab gets a visible orange conflict banner showing what won, with buttons to **keep their own text anyway** or **dismiss** — instead of silently losing what they typed.

### Demoing persistence
1. Add a few notes and edit them.
2. Stop the server (Ctrl+C) and run `npm start` again.
3. Refresh the browser tab — the board is exactly as you left it (state is loaded from `notes-data.json` on boot).

## Project structure
```
live-sync-board/
├── package.json        # backend dependencies (express, ws)
├── server.js           # Express static server + WebSocket relay, versioning, persistence
├── notes-data.json     # auto-created on first run; holds the persisted board state
└── public/
    └── index.html      # React UI (CDN React + Babel, single file)
```

## Notes / possible extensions
- Persistence is a flat JSON file, which is plenty for a course project; swapping in SQLite/Postgres would be the natural next step for a "real" app.
- Currently broadcasts to *all* clients (no rooms/auth) — good enough for a single shared board.
- Further extensions: live cursor positions (broadcast mouse coordinates the same way moves are broadcast now), a "who's online" count, or per-note edit history.
