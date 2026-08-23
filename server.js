// server.js
// Express + WebSocket server for the Live-Sync Sticky Note Board.
// - Serves the React (CDN) frontend from /public
// - Keeps the "source of truth" note state in memory AND persists it to disk
//   (notes-data.json) so state survives a server restart, not just a tab refresh.
// - Broadcasts any change made by one client to every other connected client.
// - Tracks a `version` per note and an "editing" presence per note so two tabs
//   editing the same note at the same moment get a visible conflict notice
//   instead of one silently overwriting the other.

const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, "notes-data.json");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- Shared state (lives on the server, not in any one browser tab) ----
// note shape: { id, x, y, text, color, z, version }
let notes = {};
let zCounter = 1;

// Who is currently focused/typing into which note (ephemeral, not persisted)
// noteId -> clientId
const editingBy = {};

const COLORS = ["#fff59d", "#a5d6a7", "#90caf9", "#f48fb1", "#ffcc80", "#ce93d8"];
function randomColor() {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// ---- Persistence ----
function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf-8");
      const parsed = JSON.parse(raw);
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
function saveToDisk() {
  // debounce writes so rapid edits (keystrokes/drags) don't hammer the disk
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify({ notes, zCounter }), (err) => {
      if (err) console.error("Failed to persist notes:", err.message);
    });
  }, 250);
}

loadFromDisk();

function broadcast(payload, exceptWs) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN && client !== exceptWs) {
      client.send(data);
    }
  });
}

function sendTo(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

wss.on("connection", (ws) => {
  const clientId = crypto.randomUUID();
  ws.clientId = clientId;
  console.log("Client connected:", clientId, "Total clients:", wss.clients.size);

  // Send current full state + this client's id + who's editing what
  sendTo(ws, { type: "sync", notes, clientId, editingBy });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return; // ignore malformed messages
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
        };
        notes[id] = note;
        broadcast({ type: "add", note });
        saveToDisk();
        break;
      }

      case "move": {
        const note = notes[msg.id];
        if (!note) return;
        note.x = msg.x;
        note.y = msg.y;
        note.z = zCounter++;
        broadcast({ type: "move", id: msg.id, x: note.x, y: note.y, z: note.z }, ws);
        saveToDisk();
        break;
      }

      // A tab has focused a note's textarea -> let other tabs know, so they
      // can show "someone else is editing this" instead of a silent conflict later.
      case "editing-start": {
        editingBy[msg.id] = clientId;
        broadcast({ type: "editing-start", id: msg.id, clientId }, ws);
        break;
      }

      case "editing-end": {
        if (editingBy[msg.id] === clientId) delete editingBy[msg.id];
        broadcast({ type: "editing-end", id: msg.id, clientId }, ws);
        break;
      }

      // Versioned edit: client includes the version it last saw (baseVersion).
      // If the note has moved on since then (someone else edited first), we
      // reject the stale edit and tell the sender what actually won, rather
      // than silently overwriting the other person's text.
      case "edit": {
        const note = notes[msg.id];
        if (!note) return;

        if (msg.baseVersion !== note.version) {
          // Conflict: someone else's edit already landed since this client last synced.
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
        // also confirm the new version back to the sender so their baseVersion stays in sync
        sendTo(ws, { type: "edit-ack", id: msg.id, version: note.version });
        saveToDisk();
        break;
      }

      // Force-apply after a conflict banner: user chose "keep mine anyway"
      case "edit-force": {
        const note = notes[msg.id];
        if (!note) return;
        note.text = msg.text;
        note.version += 1;
        broadcast({ type: "edit", id: msg.id, text: note.text, version: note.version }, ws);
        sendTo(ws, { type: "edit-ack", id: msg.id, version: note.version });
        saveToDisk();
        break;
      }

      case "delete": {
        delete notes[msg.id];
        delete editingBy[msg.id];
        broadcast({ type: "delete", id: msg.id }, ws);
        saveToDisk();
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    // release any editing locks this client held
    Object.keys(editingBy).forEach((noteId) => {
      if (editingBy[noteId] === clientId) {
        delete editingBy[noteId];
        broadcast({ type: "editing-end", id: noteId, clientId });
      }
    });
    console.log("Client disconnected:", clientId, "Total clients:", wss.clients.size - 1);
  });
});

server.listen(PORT, () => {
  console.log(`Live-Sync Board running at http://localhost:${PORT}`);
  console.log("Open this URL in two (or more) browser tabs to see live sync in action.");
});
