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
import * as store from "./db.js";

const PORT = process.env.PORT || 8080;
// Bind IPv4 0.0.0.0 (all interfaces). The default binds IPv6-only on some
// hosts, which LAN phones (typically IPv4) can't reach — they'd hang forever.
const HOST = process.env.HOST || "0.0.0.0";
// When STATIC_DIR is set, also serve the app's static files on the SAME port, so
// signaling is same-origin as the page. iOS Safari only lets page JS reach the
// host:port the page loaded from, so cross-port signaling is unreachable from an
// iPhone — single-origin fixes that. Unset = signaling only (app served elsewhere).
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;

// One HTTP server for everything: the /api/* stats endpoints, the WebSocket
// upgrade (signaling), and — when STATIC_DIR is set — the app's static files,
// all on a single same-origin port. iOS only lets page JS reach the origin
// host:port, so keeping the stats API on the same port as the app matters too.
const httpServer = http.createServer(handleHttp);
const wss = new WebSocketServer({ server: httpServer }); // WS shares the HTTP port
httpServer.listen(PORT, HOST, () =>
  console.log(`[web-api] signaling + api${STATIC_DIR ? " + app" : ""} on http://${HOST}:${PORT}` +
    (STATIC_DIR ? ` (static: ${STATIC_DIR})` : "")));

function handleHttp(req, res) {
  const url = (req.url || "/").split("?")[0];
  if (url.startsWith("/api/")) return handleApi(req, res);
  if (STATIC_DIR) return serveStatic(req, res);
  res.writeHead(404); res.end("not found");
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

// ---- ICE / TURN config ----------------------------------------------------
// Clients ask the server which STUN/TURN servers to use, rather than carrying
// credentials in URL params. These repos are public, so TURN credentials live
// ONLY in the deploy's environment variables and are handed out at runtime.
//
//   TURN_URLS        comma-separated, e.g. "turn:x.metered.live:80,turns:x:443"
//   TURN_USERNAME    TURN credential pair
//   TURN_CREDENTIAL
//
// With TURN unset the console still works whenever the phone and the TV can
// reach each other directly (same Wi-Fi) — TURN is the fallback for the rest.
function iceServers() {
  const stun = (process.env.STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const servers = [{ urls: stun }];
  const turn = (process.env.TURN_URLS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (turn.length) {
    servers.push({
      urls: turn,
      username: process.env.TURN_USERNAME || "",
      credential: process.env.TURN_CREDENTIAL || "",
    });
  }
  return servers;
}

// ---- Write rate limit -----------------------------------------------------
// The stats POSTs are unauthenticated (they're fire-and-forget beacons from a
// browser, so there's no secret to hold). Public deploys therefore need a lid,
// or anyone with curl can stuff the leaderboards. A per-IP-per-minute cap is
// plenty: real play produces a handful of writes per game.
const WRITE_LIMIT = Number(process.env.WRITE_LIMIT || 30);
const writeHits = new Map(); // ip -> { count, resetAt }

function rateLimited(req) {
  // Render/most PaaS put the real client IP in X-Forwarded-For.
  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  if (writeHits.size > 5000) {
    for (const [k, v] of writeHits) if (now > v.resetAt) writeHits.delete(k);
  }
  let entry = writeHits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    writeHits.set(ip, entry);
  }
  return ++entry.count > WRITE_LIMIT;
}

// ---- Stats API ------------------------------------------------------------
// A tiny JSON API over the SQLite store (db.js). Writes are POST beacons the
// launcher fires as games are played; reads power leaderboards / popularity.
// Same-origin with the app, so no CORS dance is needed for the console itself.
function handleApi(req, res) {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  const json = (code, body) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(body));
  };

  // Health check — Render pings this to know the instance is up.
  if (req.method === "GET" && pathname === "/api/health") {
    return json(200, { ok: true, rooms: rooms.size });
  }
  if (req.method === "GET" && pathname === "/api/ice") {
    return json(200, { iceServers: iceServers() });
  }
  if (req.method === "GET" && pathname === "/api/leaderboard") {
    const game = searchParams.get("game");
    if (!game) return json(400, { error: "game required" });
    const limit = Number(searchParams.get("limit")) || 10;
    return json(200, { game, scores: store.leaderboard(game, limit) });
  }
  if (req.method === "GET" && pathname === "/api/stats") {
    return json(200, store.stats());
  }

  if (req.method === "POST") {
    if (rateLimited(req)) return json(429, { error: "slow down" });
    return readJson(req, (body) => {
      try {
        switch (pathname) {
          case "/api/play":
            store.recordPlay(body); return json(200, { ok: true });
          case "/api/score":
            store.recordScore(body); return json(200, { ok: true });
          case "/api/result":
            store.recordResult(body); return json(200, { ok: true });
          default:
            return json(404, { error: "no such endpoint" });
        }
      } catch (err) {
        console.error("[api] write failed", err);
        return json(500, { error: "write failed" });
      }
    });
  }

  json(404, { error: "no such endpoint" });
}

// Read a small JSON request body (capped so a bad client can't exhaust memory).
function readJson(req, cb) {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 16 * 1024) req.destroy(); // 16 KB is plenty for a beacon
  });
  req.on("end", () => {
    try { cb(raw ? JSON.parse(raw) : {}); }
    catch { cb({}); }
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
