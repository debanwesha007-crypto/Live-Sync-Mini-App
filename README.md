# Live-Sync Sticky Board

A small real-time app: log in, open the page in two browser tabs, and any
sticky note you add, move, edit, or delete in one tab instantly shows up in
the other. Notes can also carry a reminder that fires a browser notification
when due.

## Stack
- **Frontend:** React 18 (loaded via CDN + Babel standalone — no build step)
- **Backend:** Node.js + Express + `ws` (WebSocket server) + `bcryptjs` (password hashing)
- **Persistence:** Postgres (`pg`) when `DATABASE_URL` is set — local JSON files otherwise (zero-setup for local dev)
- **Real-time transport:** WebSockets

## Features
- **Login / sign up** — hashed passwords, session cookie required to open the WebSocket connection.
- **Shared sticky-note board** — add, drag, edit, delete; synced live across every open tab.
- **Reminders** — set a date/time on any note; when due, it flashes red and (with notifications enabled) fires a browser notification.
- **Optimistic UI** — every local action updates the screen immediately, before the server confirms it.
- **Concurrent-edit handling** — versioned edits; a losing edit gets a visible conflict banner instead of silently vanishing.
- **Persistence that survives a real deploy, not just a refresh** — see below.
- **Responsive design** — freeform draggable board on desktop; a stacked scrollable list on narrow/mobile screens.

## Local setup (no database needed)

```bash
cd live-sync-board
npm install
npm start
```

With no `DATABASE_URL` set, the app automatically stores notes/users in
`notes-data.json` / `users.json` right next to `server.js`. Good enough for
local development and grading — but see the note on hosted deploys below.

## Hosted deploy: Render + a free Postgres database

**Why this is needed:** free hosts like Render and Vercel don't keep a local
filesystem around between restarts. Render's free web services spin down
after 15 minutes idle and come back up with a **completely fresh
filesystem** — so file-based storage (`notes-data.json`/`users.json`) gets
wiped on every cold start, and you'd have to re-register on every visit.
Pointing the app at a real database instead of local files fixes this
permanently, since the database is a separate service that isn't affected by
your web service restarting.

### 1. Create a free Postgres database on Neon
1. Go to **neon.tech** → sign up (no credit card required)
2. Create a new project
3. Copy the **connection string** it gives you (starts with `postgresql://...`)

Neon's free tier never expires and your data is never deleted — the compute
just pauses after a few minutes of inactivity and wakes up in well under a
second on the next request, so nothing is lost.

### 2. Point Render at it
1. In your Render web service dashboard → **Environment**
2. Add an environment variable: `DATABASE_URL` = *(paste the Neon connection string)*
3. Save — Render will redeploy automatically

That's it. On the next boot, the server logs `Persistence mode: Postgres
(DATABASE_URL set)`, creates the `users` and `notes` tables automatically if
they don't exist yet, and every account/note/reminder from then on lives in
Neon — completely unaffected by Render sleeping, waking, or redeploying.

You can verify which mode is active by checking your Render service's logs
right after a deploy — it prints one of:
```
Persistence mode: Postgres (DATABASE_URL set)
Persistence mode: local JSON files
```

## Demo

1. Open the app in one browser tab and sign up / log in.
2. Open the same URL in a second tab.
3. Click **"+ Add Sticky Note"** — it appears instantly in the other tab.
4. Drag the note around, or type into it — both sync live.

### Demoing reminders
1. Click the ⏰ icon on a note, set a time a minute or two out, and Save.
2. Click **"Enable browser notifications"** if prompted.
3. When the time passes, the note gets a pulsing red "Overdue" badge in every open tab, plus a notification in tabs where you enabled it.

### Demoing conflict handling
1. Focus the same note's text box in both tabs (a "typing…" badge appears on the other tab).
2. Type different text in each within a second or two of each other.
3. The losing tab gets an orange conflict banner with the option to keep its own text or accept the winner.

### Demoing persistence
- **Locally:** stop the server (Ctrl+C), run `npm start` again, refresh — everything's still there.
- **On Render with Neon connected:** wait for the free service to sleep (15 min idle), visit again, log in with the same account — your account and notes are unaffected, only the first request after sleep takes a few extra seconds to wake the service.

## Project structure
```
live-sync-board/
├── package.json        # dependencies (express, ws, bcryptjs, pg)
├── server.js           # Express app: auth + WebSocket relay + dual-mode persistence
├── notes-data.json     # local-mode only, auto-created, gitignored
├── users.json          # local-mode only, auto-created, gitignored
└── public/
    └── index.html      # React UI: login/register view + board view
```

## Notes / possible extensions
- Auth is intentionally simple (hand-rolled sessions, no password reset/email verification) — right-sized for a course project, not production-hardened.
- No rooms — every logged-in user shares the same single board.
- Further extensions: live cursor positions, a "who's online" list, per-note edit history.
