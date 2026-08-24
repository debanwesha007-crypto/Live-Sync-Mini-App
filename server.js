// server.js
// Express + WebSocket server for the Live-Sync Sticky Note Board.
//
// Features:
// - Serves the React (CDN) frontend from /public
// - Username/password auth: hashed passwords (bcryptjs), simple session
//   cookie (no external session library -> easy to follow for a course project)
// - The WebSocket connection itself requires a valid session cookie, so only
//   logged-in users can join the shared board
// - Persists notes AND users to disk (notes-data.json / users.json) so both
//   survive a server restart
// - Per-note version numbers + editing presence, so two tabs editing the same
//   note get a visible conflict notice instead of a silent overwrite
// - Per-note optional reminder (reminderAt): synced like any other field, so
//   every tab independently knows when a note's reminder is due

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, "notes-data.json");
const USERS_FILE = path.join(__dirname, "users.json");
const SESSION_COOKIE = "board_session";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------------------------------------------------------------------
// Users + sessions
// ---------------------------------------------------------------------------
let users = {}; // username -> { passwordHash }
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      users = JSON.parse(fs.readFileSync(USERS_FILE, "utf-8"));
    }
  } catch (e) {
    console.error("Failed to load users file, starting fresh:", e.message);
    users = {};
  }
}
function saveUsers() {
  fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2), (err) => {
    if (err) console.error("Failed to persist users:", err.message);
  });
}
loadUsers();

// token -> { username, expires }
const sessions = new Map();
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
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
  return s;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = decodeURIComponent(pair.slice(idx + 1).trim());
    out[key] = val;
  });
  return out;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE]);
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
  saveUsers();

  const token = createSession(username);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
  );
  res.json({ ok: true, username });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const user = users[username];
  if (!user) return res.status(401).json({ error: "Invalid username or password" });

  const match = await bcrypt.compare(password || "", user.passwordHash);
  if (!match) return res.status(401).json({ error: "Invalid username or password" });

  const token = createSession(username);
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
  );
  res.json({ ok: true, username });
});

app.post("/api/logout", (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  res.json({ username: req.username });
});

// ---------------------------------------------------------------------------
// Shared board state
// ---------------------------------------------------------------------------
// note shape: { id, x, y, text, color, z, version, reminderAt }
let notes = {};
let zCounter = 1;
const editingBy = {}; // noteId -> username currently focused on it (ephemeral)

const COLORS = ["#fff59d", "#a5d6a7", "#90caf9", "#f48fb1", "#ffcc80", "#ce93d8"];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

function loadNotes() {
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
let saveTimer = null;
function saveNotes() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify({ notes, zCounter }), (err) => {
      if (err) console.error("Failed to persist notes:", err.message);
    });
  }, 250);
}
loadNotes();

function broadcast(payload, exceptWs) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN && client !== exceptWs) client.send(data);
  });
}
function sendTo(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// WebSocket: require a valid session cookie to connect at all
// ---------------------------------------------------------------------------
wss.on("connection", (ws, req) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies[SESSION_COOKIE]);
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
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    switch (msg.type) {
      case "add": {
        const id = `note-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const note = {
          id,
          x: msg.x ?? 40,
          y: msg.y ?? 40,
          text: "",
          color: randomColor(),
          z: zCounter++,
          version: 1,
          reminderAt: null,
          createdBy: username,
        };
        notes[id] = note;
        broadcast({ type: "add", note });
        saveNotes();
        break;
      }

      case "move": {
        const note = notes[msg.id];
        if (!note) return;
        note.x = msg.x;
        note.y = msg.y;
        note.z = zCounter++;
        broadcast({ type: "move", id: msg.id, x: note.x, y: note.y, z: note.z }, ws);
        saveNotes();
        break;
      }

      case "editing-start": {
        editingBy[msg.id] = username;
        broadcast({ type: "editing-start", id: msg.id, username }, ws);
        break;
      }
      case "editing-end": {
        if (editingBy[msg.id] === username) delete editingBy[msg.id];
        broadcast({ type: "editing-end", id: msg.id, username }, ws);
        break;
      }

      case "edit": {
        const note = notes[msg.id];
        if (!note) return;
        if (msg.baseVersion !== note.version) {
          sendTo(ws, {
            type: "edit-rejected",
            id: msg.id,
            text: note.text,
            version: note.version,
            attemptedText: msg.text,
          });
          return;
        }
        note.text = msg.text;
        note.version += 1;
        broadcast({ type: "edit", id: msg.id, text: note.text, version: note.version }, ws);
        sendTo(ws, { type: "edit-ack", id: msg.id, version: note.version });
        saveNotes();
        break;
      }

      case "edit-force": {
        const note = notes[msg.id];
        if (!note) return;
        note.text = msg.text;
        note.version += 1;
        broadcast({ type: "edit", id: msg.id, text: note.text, version: note.version }, ws);
        sendTo(ws, { type: "edit-ack", id: msg.id, version: note.version });
        saveNotes();
        break;
      }

      // Set or clear a reminder on a note. Broadcast + persist like any other field --
      // every connected tab independently watches reminderAt and fires its own
      // local notification when it's due, so no extra "due" message is needed.
      case "reminder": {
        const note = notes[msg.id];
        if (!note) return;
        note.reminderAt = msg.reminderAt || null;
        broadcast({ type: "reminder", id: msg.id, reminderAt: note.reminderAt }, ws);
        saveNotes();
        break;
      }

      case "delete": {
        delete notes[msg.id];
        delete editingBy[msg.id];
        broadcast({ type: "delete", id: msg.id }, ws);
        saveNotes();
        break;
      }

      default:
        break;
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

server.listen(PORT, () => {
  console.log(`Live-Sync Board running at http://localhost:${PORT}`);
  console.log("Open this URL in two (or more) browser tabs to see live sync in action.");
});
