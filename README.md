# web-api

Signaling service for **Space Console** — a thin **WebRTC room relay**. It is the
matchmaker that lets a phone (`game-controller`) and a TV (`game-launcher-web`)
find each other by a short **room code** and exchange the WebRTC handshake
(SDP + ICE). Once their DataChannel opens, gameplay **intents flow phone→TV
peer-to-peer** and never pass through this service.

No game state, no auth, no database — just an in-memory map of rooms.

## Run locally

```sh
cd web-api
npm install
npm start        # ws://localhost:8080   (npm run dev for --watch reload)
```

Then run the apps and point them at it:

```sh
cd game-launcher-web && npm run dev   # http://localhost:5173 (the TV)
cd game-controller   && npm run dev   # http://localhost:5174 (the phone)
```

Open the launcher, read the room code, enter it on the controller — the
controller's d-pad now drives the launcher menu over the peer connection.

### Signaling URL

Both clients default to `ws://<page-hostname>:8080`, so serving the apps from
your laptop's LAN IP makes phones reach the relay automatically. Override per
device with a query param:

```
http://<laptop-ip>:5174/?signal=ws://<laptop-ip>:8080
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

## Documentation

See the **wiki** repo for the transport architecture and how this fits the
launcher / controller seams.
