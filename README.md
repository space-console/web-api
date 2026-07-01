# web-api

Signaling service for **Space Console** — a thin **WebRTC room relay**. It is the
matchmaker that lets a phone (`game-controller`) and a TV (`game-launcher-web`)
find each other by a short **room code** and exchange the WebRTC handshake
(SDP + ICE). Once their DataChannel opens, gameplay **intents flow phone→TV
peer-to-peer** and never pass through this service.

No game state, no auth, no database — just an in-memory map of rooms.

## Run locally

**Signaling only** (apps served elsewhere):

```sh
cd web-api
npm install
npm start        # signaling on ws://localhost:8080   (npm run dev = --watch)
```

**Single-origin — app + signaling on ONE port** (recommended, and required for
real iPhones): iOS Safari only lets page JS reach the exact host:port the page
loaded from, so the signaling WebSocket must share the app's origin.

```sh
STATIC_DIR=.. PORT=8000 npm start     # or: npm run serve:app
```

`STATIC_DIR` is a directory to serve statically; `..` (the workspace root) lets
the sibling repos resolve as `/game-launcher-web`, `/game-controller`,
`/games/<id>`. Then open:

- TV:    `http://<host>:8000/game-launcher-web/`
- phone: `http://<host>:8000/game-controller/`

Read the room code on the TV, enter it on the phone.

### Signaling URL

Clients default to **the page's own origin** (`ws(s)://<host:port>` of the page),
so single-origin serving needs no config. When signaling runs on a different
host/port, override per device:

```
http://<host>:8000/game-controller/?signal=ws://<signal-host>:<port>
```

### TURN (real phones / off-LAN)

Direct P2P often fails on phones (iOS mDNS, strict NAT). Pass a TURN relay to the
clients via query params (comma-separated URLs allowed; `&relay=1` forces relay):

```
?turn=turn:host:3478&turnuser=USER&turncred=PASS
```

STUN-only is the default. For production, self-host coturn.

## Protocol

JSON frames over one WebSocket per client.

| From | Message | Meaning |
| --- | --- | --- |
| TV → | `{type:"create", code}` | Register a room (server confirms or re-mints the code). |
| → TV | `{type:"created", code}` | Authoritative room code. |
| phone → | `{type:"join", code, name?}` | Join a room. |
| → phone | `{type:"joined", id, code}` / `{type:"error", reason}` | Paired, or no such room. |
| → TV | `{type:"join", from, name}` / `{type:"leave", from}` | A controller joined / left. |
| ↔ | `{type:"signal", to?, data}` | Relay one SDP/ICE blob to the other peer. |
| → phone | `{type:"host-gone"}` | The TV closed the room. |

## Documentation

See the **wiki** repo for the transport architecture and how this fits the
launcher / controller seams.
