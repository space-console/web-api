// Space Console signaling service — a thin WebRTC room relay.
//
// It brokers ONLY the connection handshake: a TV ("host") creates a room and
// gets a code; phones ("guests") join by code; the server relays SDP offers /
// answers and ICE candidates between the matched peers. Once their DataChannel
// opens, gameplay intents flow phone→TV peer-to-peer and never touch this
// process. No game state, no auth, no database — just an in-memory room map.

import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

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
        break;
      }

      // Phone joins a room by code; we pair it to the host and announce it.
      case "join": {
        const code = (msg.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
          send(ws, { type: "error", reason: "no-room" });
          return;
        }
        const id = "g" + nextGuestId++;
        ws.role = "guest";
        ws.code = code;
        ws.id = id;
        room.guests.set(id, ws);
        send(ws, { type: "joined", id, code });
        send(room.host, { type: "join", from: id, name: msg.name || null });
        break;
      }

      // Relay one handshake blob (SDP or ICE) to the other peer.
      case "signal": {
        const room = rooms.get(ws.code);
        if (!room) return;
        if (ws.role === "guest") {
          send(room.host, { type: "signal", from: ws.id, data: msg.data });
        } else if (ws.role === "host") {
          send(room.guests.get(msg.to), { type: "signal", data: msg.data });
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

console.log(`[web-api] signaling on ws://localhost:${PORT}`);
