// Space Console signaling service — a thin WebRTC room relay.
//
// It brokers ONLY the connection handshake: a TV ("host") creates a room and
// gets a code; phones ("guests") join by code; the server relays SDP offers /
// answers and ICE candidates between the matched peers. Once their DataChannel
// opens, gameplay intents flow phone→TV peer-to-peer and never touch this
// process. No game state, no auth, no database — just an in-memory room map.

import http from "http";
import fs from "fs";
import path from "path";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
// Bind IPv4 0.0.0.0 (all interfaces). The default binds IPv6-only on some
// hosts, which LAN phones (typically IPv4) can't reach — they'd hang forever.
const HOST = process.env.HOST || "0.0.0.0";
// When STATIC_DIR is set, also serve the app's static files on the SAME port, so
// signaling is same-origin as the page. iOS Safari only lets page JS reach the
// host:port the page loaded from, so cross-port signaling is unreachable from an
// iPhone — single-origin fixes that. Unset = signaling only (original behavior).
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;

let wss;
if (STATIC_DIR) {
  const httpServer = http.createServer((req, res) => serveStatic(req, res));
  wss = new WebSocketServer({ server: httpServer }); // WS shares the HTTP port
  httpServer.listen(PORT, HOST, () =>
    console.log(`[web-api] app + signaling on http://${HOST}:${PORT} (static: ${STATIC_DIR})`));
} else {
  wss = new WebSocketServer({ port: PORT, host: HOST });
  console.log(`[web-api] signaling on ws://${HOST}:${PORT}`);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
};

// Minimal static file server rooted at STATIC_DIR (dev/self-host convenience).
function serveStatic(req, res) {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  const filePath = path.normalize(path.join(STATIC_DIR, urlPath));
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

/** code -> { host: ws, guests: Map<id, ws> } */
const rooms = new Map();
let nextGuestId = 1;

// A,2..9 minus easily-confused characters (no 0/O/1/I) — matches the client.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode(len = 4) {
  let code;
  do {
    code = "";
    for (let i = 0; i < len; i++) {
      code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

wss.on("connection", (ws) => {
  ws.role = null; // "host" | "guest"
  ws.code = null;
  ws.id = null;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.type) {
      // TV registers a room. It proposes a code; we honour it if free, else mint one.
      case "create": {
        let code = (msg.code || "").toUpperCase();
        if (!code || rooms.has(code)) code = makeCode();
        rooms.set(code, { host: ws, guests: new Map() });
        ws.role = "host";
        ws.code = code;
        send(ws, { type: "created", code });
        console.log(`[room] host created ${code}`);
        break;
      }

      // Phone joins a room by code; we pair it to the host and announce it.
      case "join": {
        const code = (msg.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "error", reason: "no-room" });
          console.log(`[room] guest join ${code} -> NO ROOM (known: ${[...rooms.keys()].join(",") || "none"})`);
          return;
        }
        const id = "g" + nextGuestId++;
        ws.role = "guest";
        ws.code = code;
        ws.id = id;
        room.guests.set(id, ws);
        send(ws, { type: "joined", id, code });
        send(room.host, { type: "join", from: id, name: msg.name || null });
        console.log(`[room] guest ${id} joined ${code}`);
        break;
      }

      // Relay one handshake blob (SDP or ICE) to the other peer.
      case "signal": {
        const room = rooms.get(ws.code);
        if (!room) return;
        const kind = msg.data && msg.data.sdp ? `sdp:${msg.data.sdp.type}` : "ice";
        if (ws.role === "guest") {
          send(room.host, { type: "signal", from: ws.id, data: msg.data });
          console.log(`[signal] guest ${ws.id} -> host (${kind})`);
        } else if (ws.role === "host") {
          send(room.guests.get(msg.to), { type: "signal", data: msg.data });
          console.log(`[signal] host -> guest ${msg.to} (${kind})`);
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.code);
    if (!room) return;
    if (ws.role === "host") {
      // TV left — tear the room down and tell every controller.
      for (const guest of room.guests.values()) send(guest, { type: "host-gone" });
      rooms.delete(ws.code);
    } else if (ws.role === "guest") {
      room.guests.delete(ws.id);
      send(room.host, { type: "leave", from: ws.id });
    }
  });
});
