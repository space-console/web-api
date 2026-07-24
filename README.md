# web-api

Signaling service for **Space Console** — a thin **WebRTC room relay**. It is the
matchmaker that lets a phone (`game-controller`) and a TV (`game-launcher-web`)
find each other by a short **room code** and exchange the WebRTC handshake
(SDP + ICE). Once their DataChannel opens, gameplay **intents flow phone→TV
peer-to-peer** and never pass through this service.

Rooms are in-memory and ephemeral. Alongside signaling it exposes an
[ICE config endpoint](#ice--turn-real-phones--off-lan) (`GET /api/ice`), a
health check (`GET /api/health` → `{ok, rooms}`), and a small **stats API**
backed by a local **SQLite** file (`db.js`) — high scores, which games get
played, and 2-player results (see [Stats API](#stats-api)). In production it also
serves the whole console as one origin — see [Deploy](#deploy).

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

### ICE / TURN (real phones / off-LAN)

Direct P2P often fails on phones (iOS mDNS, strict NAT), so a TURN relay is the
fallback. Clients fetch their ICE config from the server at **`GET /api/ice`**
(`{ iceServers: [...] }`) rather than carrying credentials in the URL — these
repos are public. Configure it via env (all unset ⇒ STUN-only, which still works
whenever the phone and the TV can reach each other directly):

```
STUN_URLS        default: stun:stun.l.google.com:19302
TURN_URLS        comma-separated, e.g. turn:host:3478,turns:host:5349
TURN_USERNAME
TURN_CREDENTIAL
```

A single device can still override via query params (mirrors `?signal=`), handy
for pointing one phone at a TURN the server doesn't know about:

```
?turn=turn:host:3478&turnuser=USER&turncred=PASS   add a TURN server
?relay=1                                            force relay-only (to verify TURN)
```

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

## Stats API

A tiny JSON API on the **same port** as signaling/app, backed by SQLite
(`better-sqlite3`). The launcher (the one device that sees every game and player)
POSTs fire-and-forget beacons as games are played; anything can read the
aggregates. The DB file defaults to `web-api/data/spaceconsole.db` — override with
`DB_PATH=/path/to.db`. The `data/` dir and `*.db` files are git-ignored.

| Method | Path | Body / query | Purpose |
| --- | --- | --- | --- |
| POST | `/api/play` | `{gameId, roomCode, playerCount}` | Log a launch (popularity, solo-vs-group). |
| POST | `/api/score` | `{gameId, playerName, score, roomCode}` | Record a leaderboard score. |
| POST | `/api/result` | `{gameId, roomCode, outcome, winnerSlot, winnerName, players}` | Record a 2-player result (`outcome`: `win`\|`draw`). |
| GET | `/api/leaderboard?game=<id>&limit=10` | — | Top scores for one game. |
| GET | `/api/stats` | — | Totals + most-played games. |

Schema (`db.js`): `plays`, `scores`, `results`. Maps cleanly to Postgres if the
single-file DB is ever outgrown on the deploy box.

## Deploy

The whole Space Console ships as **one Render service** (`render.yaml`): web-api
serves the launcher, the controller, the games, the signaling socket, the ICE
config and the stats API on a **single origin** — because iOS Safari only lets
page JS reach the host:port the page loaded from, splitting the frontend onto a
separate static host is what breaks iPhones.

The build clones each sibling repo's published `gh-pages` branch into `./public`
and points the server at it:

```sh
npm run build:static     # git-clone launcher + controller + games#gh-pages -> ./public
npm run serve:dist       # STATIC_DIR=./public PORT=8000 node server.js
```

Set `TURN_URLS` / `TURN_USERNAME` / `TURN_CREDENTIAL` (and optionally `STUN_URLS`)
in the Render dashboard — they are not committed. Render's health check hits
`/api/health`. On the free plan there is no persistent disk, so the SQLite stats
file resets on each deploy/sleep; attach a disk and set `DB_PATH=/data/…` to keep
leaderboard history.

## Documentation

See the **wiki** repo (`wiki/docs/services/web-api/`) for the transport
architecture and how this fits the launcher / controller seams.
