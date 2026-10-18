# Stacktics

Stacking with tactics: a turn-based block-stacking physics game for phones. Take turns dropping blocks onto a wobbly tower.
Every block that falls off the platform gives ★1 to everyone whose turn it *isn't*. Spend ★ on power-ups:

| Power-up | Cost | Effect |
|---|---|---|
| 🤏 Tiny | ★1 | Smaller block |
| 🐘 Huge | ★1 | Bigger block |
| ↔️ Long | ★1 | Doubles the block's length; buy it again to keep stretching (up to 360 wide) |
| 🍯 Glue | ★2 | Sticks to whatever it touches (bonds can snap) |
| 🧽 Slippery | ★2 | A soapy sponge: slides on everything and soaks the blocks it touches so they slide too |
| 🏀 Bouncy | ★2 | Hops once when it lands, then acts as a trampoline: anything that lands on it bounces off. Can't be combined with Glue |
| 🪱 Flexible | ★2 | A rubbery block made of slices joined by springs, so it bends and stretches. Works with Tiny, Huge and Long; not with Glue, Slippery, Bouncy or Magnet |
| 🧲 Magnet | ★3 | Keeps pulling nearby blocks toward it |
| ⏩ Rush | ★4 | The next player's turn starts 0.6s after your drop, whether the tower has settled or not |

First to ★10 wins.

## Run

```
npm install
npm start          # http://localhost:3002
```

- **Play on this device**: pass-and-play for 2–4 players; the physics runs in the browser.
- **🔬 Science mode**: a solo sandbox for learning how the pieces behave. There are no timers or scores, power-ups are free toggles that stay on between drops, and 🧹 clears the platform.
- **Online**: create a room, and friends join with the 4-letter code (up to 4 players). The server runs the physics so everyone sees the same tower.

Pick **▬ Platform** or **⚖️ Seesaw** on the menu before starting any of these. On the seesaw the plank tips toward the heavier side, up to 15° each way, so keep the tower balanced. Online, the host's pick applies to the whole room.

To play from a phone on your Wi-Fi, open `http://<your-PC-IP>:3002`. Under WSL2 you need mirrored networking
(`networkingMode=mirrored` in `%UserProfile%\.wslconfig`) or a `netsh interface portproxy` rule, plus a firewall allowance for port 3002.

## Files

- `game.js`: rules and Matter.js physics. Shared by the server and the browser.
- `server.js`: static file server and WebSocket rooms. Runs one authoritative `Game` per room and broadcasts snapshots at ~30 Hz.
- `client.js`: canvas rendering, camera, touch controls, and the local/online sessions.
- `index.html`: screens and styles.
