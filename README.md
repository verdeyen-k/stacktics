# 2D Jenga

A turn-based square-stacking physics game for phones. Take turns dropping squares onto a wobbly tower.
Every square that falls off the platform gives ★1 to everyone whose turn it *isn't*. Spend ★ on power-ups:

| Power-up | Cost | Effect |
|---|---|---|
| 🤏 Tiny | ★1 | Smaller square |
| 🐘 Huge | ★1 | Bigger square |
| 🍯 Glue | ★2 | Sticks to whatever it touches (bonds can snap) |
| 🧲 Magnet | ★3 | Keeps pulling nearby squares toward it |

First to ★10 wins.

## Run

```
npm install
npm start          # http://localhost:3002
```

- **Play on this phone**: pass-and-play for 2–4 players; the physics runs in the browser.
- **Online**: create a room, and friends join with the 4-letter code (up to 4 players). The server runs the physics so everyone sees the same tower.

To play from a phone on your Wi-Fi, open `http://<your-PC-IP>:3002`. Under WSL2 you need mirrored networking
(`networkingMode=mirrored` in `%UserProfile%\.wslconfig`) or a `netsh interface portproxy` rule, plus a firewall allowance for port 3002.

## Files

- `game.js`: rules and Matter.js physics. Shared by the server and the browser.
- `server.js`: static file server and WebSocket rooms. Runs one authoritative `Game` per room and broadcasts snapshots at ~30 Hz.
- `client.js`: canvas rendering, camera, touch controls, and the local/online sessions.
- `index.html`: screens and styles.
