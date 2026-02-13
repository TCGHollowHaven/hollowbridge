/* Hollow Bridge Relay (Render Web Service)
   - Permanent HTTPS URL for TikTok Live Studio "Link" source
   - Socket.IO relay between:
       (A) Hollow Bridge Desktop App (publisher)
       (B) Browser Overlay (viewer)
*/

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const compression = require("compression");
const { v4: uuidv4 } = require("uuid");

const app = express();

app.use(helmet({
  // allow the overlay to be embedded as a source
  contentSecurityPolicy: false
}));
app.use(compression());
app.use(express.json({ limit: "1mb" }));

// Health
app.get("/health", (_req, res) => res.status(200).send("ok"));

// Create a new session id (you’ll use this in the desktop app later)
app.post("/api/session", (_req, res) => {
  const id = uuidv4().replace(/-/g, "").slice(0, 12);
  res.json({ ok: true, sessionId: id });
});

// Overlay page TikTok Live Studio will load
app.get("/overlay/:sessionId", (req, res) => {
  const sessionId = String(req.params.sessionId || "").trim();
  if (!sessionId) return res.status(400).send("Missing sessionId");

  res.type("html").send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Hollow Bridge Relay Overlay</title>
  <style>
    html, body { margin:0; padding:0; width:100%; height:100%; background: transparent; overflow:hidden; }
    #status { position: fixed; top: 10px; left: 10px; z-index: 999999; padding: 8px 10px;
      font-family: Segoe UI, Arial, sans-serif; font-size: 12px;
      border-radius: 10px; background: rgba(0,0,0,.55); color:#fff; border: 1px solid rgba(255,255,255,.2);
      display:none;
    }
  </style>
</head>
<body>
  <div id="status"></div>

  <!-- We keep this relay overlay "dumb": it just receives events.
       Your actual Hollow Bridge overlay HTML can be injected later.
  -->

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    const statusEl = document.getElementById('status');

    function showStatus(msg){
      statusEl.style.display = 'block';
      statusEl.textContent = msg;
    }

    // Connect as viewer
    const socket = io({
      transports: ['websocket', 'polling'],
      query: { sessionId, role: 'viewer' }
    });

    socket.on('connect', () => showStatus('Connected to relay: ' + sessionId));
    socket.on('disconnect', () => showStatus('Disconnected - retrying...'));

    // Generic event pass-through: the desktop app will emit these
    // You can later attach these to your real overlay renderer.
    socket.on('hb:event', (payload) => {
      // For now, just expose it globally for debugging
      window.__HB_LAST_EVENT__ = payload;
      // If you want, you can console.log it:
      // console.log('hb:event', payload);
    });

    // (Optional) Keepalive display off after a moment
    setTimeout(() => { statusEl.style.display = 'none'; }, 2000);
  </script>
</body>
</html>`);
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  },
  transports: ["websocket", "polling"]
});

// In-memory state per session
// This is fine for Free tier and beta. Later, if you want resilience, we can add Redis.
const sessions = new Map();
/*
  sessions.get(sessionId) = {
    lastState: { ... },   // last known payload
    publishers: number,
    viewers: number
  }
*/

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { lastState: null, publishers: 0, viewers: 0 });
  }
  return sessions.get(sessionId);
}

io.on("connection", (socket) => {
  const { sessionId, role } = socket.handshake.query || {};
  const sid = String(sessionId || "").trim();
  const r = String(role || "").trim();

  if (!sid) {
    socket.disconnect(true);
    return;
  }

  socket.join(sid);
  const s = getSession(sid);

  if (r === "publisher") s.publishers += 1;
  else s.viewers += 1;

  // If we already have state, send it to the newly connected viewer
  if (s.lastState) {
    socket.emit("hb:event", { type: "state", data: s.lastState });
  }

  // Publisher sends events to relay
  socket.on("hb:event", (payload) => {
    // payload format (recommended):
    // { type: 'emoji'|'goal'|'train'|'state'|..., data: {...}, ts: Date.now() }
    try {
      if (!payload || typeof payload !== "object") return;

      // Cache last known "state" so overlays joining late can catch up
      if (payload.type === "state") {
        s.lastState = payload.data || null;
      }

      // Broadcast to everyone in the session (including the sender is fine, but we can exclude if needed)
      io.to(sid).emit("hb:event", payload);
    } catch (_e) {}
  });

  socket.on("disconnect", () => {
    const ss = getSession(sid);
    if (r === "publisher") ss.publishers = Math.max(0, ss.publishers - 1);
    else ss.viewers = Math.max(0, ss.viewers - 1);

    // Optional cleanup: if nobody is connected, drop the session after a bit
    if (ss.publishers === 0 && ss.viewers === 0) {
      sessions.delete(sid);
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`[HB Relay] listening on :${PORT}`);
});
