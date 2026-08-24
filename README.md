# Live-Sync Sticky Board

A small real-time app: log in, open the page in two browser tabs, and any
sticky note you add, move, edit, or delete in one tab instantly shows up in
the other. Notes can also carry a reminder that fires a browser notification
when due.

## Stack
- **Frontend:** React 18 (loaded via CDN + Babel standalone — no build step, no `npm install` needed for the frontend)
- **Backend:** Node.js + Express (serves the page + auth API) + `ws` (WebSocket server) + `bcryptjs` (password hashing)
- **Real-time transport:** WebSockets

## Features
- **Login / sign up** — username + password, hashed with bcrypt, session cookie required to even open the WebSocket connection.
- **Shared sticky-note board** — add, drag, edit, delete; synced live across every open tab.
- **Reminders** — set a date/time on any note; when it's due, the note flashes red and (if you've enabled notifications) a browser notification fires. Synced like any other field, so every tab agrees on what's overdue.
- **Optimistic UI** — every local action updates the screen immediately, before the server confirms it.
- **Concurrent-edit handling** — each note has a version number; if two tabs edit the same note near-simultaneously, the second one gets a visible conflict banner (with the choice to keep their text or accept the other tab's) instead of silently losing their edit.
- **Persistence** — notes and user accounts are written to disk (debounced), so both survive a server restart, not just a tab refresh.
- **Responsive design** — freeform draggable board on desktop; on narrow/mobile screens the board switches to a stacked list (dragging is disabled where it wouldn't work well with touch).

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

Open `http://localhost:3001`, create an account (any username/password — this
is a local demo, not a production auth system), and you'll land on the board.

## Demo

1. Open `http://localhost:3001` in one browser tab and sign up / log in.
2. Open the same URL in a second tab (log in with the same or a different account).
3. Click **"+ Add Sticky Note"** in one tab — it appears instantly in the other.
4. Drag the note around, or type into it — both sync live. On a phone-sized window, the board becomes a scrollable stacked list instead of free-drag.

### Demoing reminders
1. Click the ⏰ icon on a note, set a time a minute or two in the future, and hit Save.
2. Click **"Enable browser notifications"** in the toolbar if prompted.
3. Wait for the time to pass — the note gets a pulsing red "Overdue" badge in every open tab, and a browser notification pops up in tabs where you enabled it.

### Demoing conflict handling
1. Click into the same note's text box in *both* tabs at once (a "typing…" badge appears on the other tab, with the editor's username).
2. Type different text in each tab within a second or two of each other.
3. Whichever edit reaches the server first wins; the other tab gets an orange conflict banner showing what won, with the option to keep their own text anyway or dismiss.

### Demoing persistence
1. Add/edit a few notes.
2. Stop the server (Ctrl+C) and run `npm start` again.
3. Refresh — the board (and your login) picks up right where it left off.

## Project structure
```
live-sync-board/
├── package.json        # backend dependencies (express, ws, bcryptjs)
├── server.js           # Express app: auth routes + WebSocket relay, versioning, persistence
├── notes-data.json     # auto-created on first run; persisted board state
├── users.json          # auto-created on first run; usernames + hashed passwords
└── public/
    └── index.html      # React UI: login/register view + board view, single file
```

## Notes / possible extensions
- Auth here is intentionally simple (hand-rolled sessions, no email verification/password reset) — enough to demonstrate the concept for a course project. A production app would use a proper session store and stronger password rules.
- Persistence is flat JSON files; swapping in SQLite/Postgres would be the natural next step.
- No rooms — every logged-in user shares the same single board.
- Further extensions: live cursor positions, a "who's online" list, per-note edit history.
