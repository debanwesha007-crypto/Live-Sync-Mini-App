// server.js
// Express + WebSocket server for the Live-Sync Sticky Note Board.
//
// Persistence has two modes, chosen automatically:
//   - If DATABASE_URL is set, notes and users are stored in Postgres (e.g. a
//     free Neon database) -- this survives Render's free-tier ephemeral
//     filesystem, so accounts and notes never get wiped on a cold start.
//   - If DATABASE_URL is NOT set, notes/users are stored in local JSON files
//     (notes-data.json / users.json) -- zero setup, good for local dev.
//
// Everything else (WebSocket relay, versioned-edit conflict handling,
// reminders, session auth) is unchanged regardless of which mode is active.

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, "notes-data.json");
const USERS_FILE = path.join(__dirname, "users.json");
const SESSION_COOKIE = "board_session";

const USE_DB = !!process.env.DATABASE_URL;
const pool = USE_DB
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // required by most managed Postgres hosts (Neon, Render, Supabase)
    })
  : null;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------------------
// Persistence layer
// ---------------------------------------------------------------------------
let users = {};       // username -> { passwordHash }
let notes = {};        // id -> { id, x, y, text, color, z, version, reminderAt, createdBy }
let zCounter = 1;

async function initStorage() {
  if (!USE_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      x DOUBLE PRECISION NOT NULL,
      y DOUBLE PRECISION NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL,
      z INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      reminder_at TIMESTAMPTZ,
      created_by TEXT
    );
  `);
  console.log("Connected to Postgres and ensured tables exist.");
}

async function loadAll() {
  if (USE_DB) {
    const { rows: userRows } = await pool.query("SELECT username, password_hash FROM users");
    users = {};
    userRows.forEach((r) => { users[r.username] = { passwordHash: r.password_hash }; });

    const { rows: noteRows } = await pool.query("SELECT * FROM notes");
    notes = {};
    let maxZ = 0;
    noteRows.forEach((r) => {
      notes[r.id] = {
        id: r.id,
        x: r.x,
        y: r.y,
        text: r.text,
        color: r.color,
        z: r.z,
        version: r.version,
        reminderAt: r.reminder_at ? new Date(r.reminder_at).toISOString() : null,
        createdBy: r.created_by,
      };
      if (r.z > maxZ) maxZ = r.z;
    });
    zCounter = maxZ + 1;
    console.log(`Loaded ${userRows.length} user(s) and ${noteRows.length} note(s) from Postgres.`);
  } else {
    try {
      if (fs.existsSync(USERS_FILE)) users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
    } catch (e) {
      console.error("Failed to load users file, starting fresh:", e.message);
      users = {};
    }
    try {
      if (fs.existsSync(DATA_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
        notes = parsed.notes || {};
        zCounter = parsed.zCounter || 1;
        console.log(`Loaded ${Object.keys(notes).length} note(s) from ${DATA_FILE}`);
      }
    } catch (e) {
      console.error("Failed to load persisted notes, starting fresh:", e.message);
      notes = {};
    }
  }
}

// ---- file-mode helpers (whole-object debounced writes) ----
let notesSaveTimer = null;
function saveNotesToFile() {
  clearTimeout(notesSaveTimer);
  notesSaveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify({ notes, zCounter }), (err) => {
      if (err) console.error("Failed to persist notes:", err.message);
    });
  }, 250);
}
function saveUsersToFile() {
  fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), (err) => {
    if (err) console.error("Failed to persist users:", err.message);
  });
}

// ---- db-mode helpers (per-row writes, lightly debounced per note during drags) ----
const dbNoteWriteTimers = {};
function persistNoteUpsert(note) {
  if (!USE_DB) { saveNotesToFile(); return; }
  clearTimeout(dbNoteWriteTimers[note.id]);
  dbNoteWriteTimers[note.id] = setTimeout(() => {
    pool.query(
      `INSERT INTO notes (id, x, y, text, color, z, version, reminder_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         x = $2, y = $3, text = $4, color = $5, z = $6, version = $7, reminder_at = $8`,
      [note.id, note.x, note.y, note.text, note.color, note.z, note.version, note.reminderAt, note.createdBy]
    ).catch((err) => console.error("DB note upsert failed:", err.message));
  }, 150);
}
function persistNoteDelete(id) {
  if (!USE_DB) { saveNotesToFile(); return; }
  clearTimeout(dbNoteWriteTimers[id]);
  pool.query("DELETE FROM notes WHERE id = $1", [id])
    .catch((err) => console.error("DB note delete failed:", err.message));
}
function persistNewUser(username, passwordHash) {
  if (!USE_DB) { saveUsersToFile(); return; }
  pool.query(
    "INSERT INTO users (username, password_hash) VALUES ($1, $2) ON CONFLICT (username) DO NOTHING",
    [username, passwordHash]
  ).catch((err) => console.error("DB user insert failed:", err.message));
}

// ---------------------------------------------------------------------------
// Sessions (in-memory; a login is only lost if the Node process itself
// restarts mid-session, which just means logging in again -- accounts and
// notes themselves are unaffected since those live in the DB/files above)
// ---------------------------------------------------------------------------
const sessions = new Map(); // token -> { username, expires }
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

function createSession(username) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { username, expires: Date.now() + SESSION_TTL_MS });
  return token;
}
function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}
function requireAuth(req, res, next) {
  const session = getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) return res.status(401).json({ error: "Not logged in" });
  req.username = session.username;
  next();
}

// ---- Auth routes ----
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2 || password.length < 4) {
    return res.status(400).json({ error: "Username (2+ chars) and password (4+ chars) required" });
  }
  if (users[username]) {
    return res.status(409).json({ error: "That username is already taken" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  users[username] = { passwordHash };
  persistNewUser(username, passwordHash);

  const token = createSession(username);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  res.json({ ok: true, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const user = users[username];
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  const match = await bcrypt.compare(password || "", user.passwordHash);
  if (!match) return res.status(401).json({ error: "Invalid username or password" });

  const token = createSession(username);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`);
  res.json({ ok: true, username });
});

app.post("/api/logout", (req, res) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => res.json({ username: req.username }));

// ---------------------------------------------------------------------------
// Shared board state
// ---------------------------------------------------------------------------
const editingBy = {}; // noteId -> username currently focused on it (ephemeral, not persisted)
const COLORS = ["#fff59d", "#a5d6a7", "#90caf9", "#f48fb1", "#ffcc80", "#ce93d8"];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

function broadcast(payload, exceptWs) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN && client !== exceptWs) client.send(data);
  });
}
function sendTo(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws, req) => {
  const session = getSession(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
  if (!session) {
    sendTo(ws, { type: "auth-error", message: "Please log in again." });
    ws.close(4001, "unauthorized");
    return;
  }
  const username = session.username;
  ws.username = username;
  console.log("Client connected:", username, "Total clients:", wss.clients.size);

  sendTo(ws, { type: "sync", notes, username, editingBy });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {
      case "add": {
        const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const note = {
          id, x: msg.x ?? 40, y: msg.y ?? 40, text: "", color: randomColor(),
          z: zCounter++, version: 1, reminderAt: null, createdBy: username,
        };
        notes[id] = note;
        broadcast({ type: "add", note });
        persistNoteUpsert(note);
        break;
      }
      case "move": {
        const note = notes[msg.id];
        if (!note) return;
        note.x = msg.x; note.y = msg.y; note.z = zCounter++;
        broadcast({ type: "move", id: msg.id, x: note.x, y: note.y, z: note.z }, ws);
        persistNoteUpsert(note);
        break;
      }
      case "editing-start":
        editingBy[msg.id] = username;
        broadcast({ type: "editing-start", id: msg.id, username }, ws);
        break;
      case "editing-end":
        if (editingBy[msg.id] === username) delete editingBy[msg.id];
        broadcast({ type: "editing-end", id: msg.id, username }, ws);
        break;
      case "edit": {
        const note = notes[msg.id];
        if (!note) return;
        if (msg.baseVersion !== note.version) {
          sendTo(ws, { type: "edit-rejected", id: msg.id, text: note.text, version: note.version, attemptedText: msg.text });
          return;
        }
        note.text = msg.text; note.version += 1;
        broadcast({ type: "edit", id: msg.id, text: note.text, version: note.version }, ws);
        sendTo(ws, { type: "edit-ack", id: msg.id, version: note.version });
        persistNoteUpsert(note);
        break;
      }
      case "edit-force": {
        const note = notes[msg.id];
        if (!note) return;
        note.text = msg.text; note.version += 1;
        broadcast({ type: "edit", id: msg.id, text: note.text, version: note.version }, ws);
        sendTo(ws, { type: "edit-ack", id: msg.id, version: note.version });
        persistNoteUpsert(note);
        break;
      }
      case "reminder": {
        const note = notes[msg.id];
        if (!note) return;
        note.reminderAt = msg.reminderAt || null;
        broadcast({ type: "reminder", id: msg.id, reminderAt: note.reminderAt }, ws);
        persistNoteUpsert(note);
        break;
      }
      case "delete": {
        delete notes[msg.id];
        delete editingBy[msg.id];
        broadcast({ type: "delete", id: msg.id }, ws);
        persistNoteDelete(msg.id);
        break;
      }
      default: break;
    }
  });

  ws.on("close", () => {
    Object.keys(editingBy).forEach((noteId) => {
      if (editingBy[noteId] === username) {
        delete editingBy[noteId];
        broadcast({ type: "editing-end", id: noteId, username });
      }
    });
    console.log("Client disconnected:", username, "Total clients:", wss.clients.size - 1);
  });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  try {
    await initStorage();
    await loadAll();
  } catch (e) {
    console.error("Storage init failed -- check DATABASE_URL. Continuing with empty state.", e.message);
  }
  server.listen(PORT, () => {
    console.log(`Live-Sync Board running at http://localhost:${PORT}`);
    console.log(`Persistence mode: ${USE_DB ? "Postgres (DATABASE_URL set)" : "local JSON files"}`);
  });
})();
