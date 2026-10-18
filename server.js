const http = require('http');
const fs   = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Game, TICK } = require('./game');

const PORT = process.env.PORT || 3002;
const MAX_PLAYERS = 4;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
};

// Only these files are served; everything else is a 404.
const FILES = {
  '/':                  'index.html',
  '/index.html':        'index.html',
  '/client.js':         'client.js',
  '/game.js':           'game.js',
  '/vendor/matter.js':  'node_modules/matter-js/build/matter.min.js',
};

const httpServer = http.createServer((req, res) => {
  const file = FILES[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
});

// ── Rooms ──────────────────────────────────────────────────────────
const rooms = new Map();
const CHARS  = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = () => Array.from({ length: 4 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join('');
let nextPlayerId = 1;

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const broadcast = (room, msg) => { const s = JSON.stringify(msg); for (const p of room.players) if (p.ws.readyState === 1) p.ws.send(s); };
const cleanName = n => String(n || '').replace(/[^\p{L}\p{N} _'-]/gu, '').trim().slice(0, 12) || 'Player';

function sendLobby(room) {
  for (const p of room.players) send(p.ws, {
    t: 'lobby', code: room.code, you: p.id, host: room.host, seesaw: room.seesaw,
    players: room.players.map(q => ({ id: q.id, name: q.name })),
    game: room.game ? room.gameNo : 0,
  });
}

function startGame(room) {
  room.gameNo = (room.gameNo || 0) + 1;
  room.game = new Game(room.players.map(p => ({ id: p.id, name: p.name })), { seesaw: room.seesaw });
  room.last = performance.now();
  room.acc = 0;
  room.ticks = 0;
  sendLobby(room);
  clearInterval(room.loop);
  room.loop = setInterval(() => tickRoom(room), TICK);
}

function tickRoom(room) {
  const now = performance.now();
  room.acc = Math.min(room.acc + now - room.last, 250); // don't spiral after a stall
  room.last = now;
  while (room.acc >= TICK) { room.game.step(); room.acc -= TICK; room.ticks++; }
  // ~30 snapshots/sec; clients interpolate between them.
  if (room.ticks >= 2) {
    room.ticks = 0;
    broadcast(room, { t: 'state', s: room.game.snapshot(), ev: room.game.drainEvents() });
  }
}

function leave(ws) {
  const room = rooms.get(ws.code);
  if (!room) return;
  room.players = room.players.filter(p => p.ws !== ws);
  if (!room.players.length) { clearInterval(room.loop); rooms.delete(room.code); return; }
  if (room.host === ws.pid) room.host = room.players[0].id;
  if (room.game) room.game.removePlayer(ws.pid);
  sendLobby(room);
}

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const room = rooms.get(ws.code);

    if (msg.t === 'create') {
      if (room) return;
      let code;
      do { code = genCode(); } while (rooms.has(code));
      ws.code = code; ws.pid = 'p' + nextPlayerId++;
      rooms.set(code, { code, host: ws.pid, players: [{ id: ws.pid, name: cleanName(msg.name), ws }], game: null, seesaw: !!msg.seesaw });
      sendLobby(rooms.get(code));

    } else if (msg.t === 'join') {
      if (room) return;
      const target = rooms.get(String(msg.code || '').toUpperCase().trim());
      const err = !target ? 'Room not found' : target.game ? 'Game already started'
        : target.players.length >= MAX_PLAYERS ? 'Room is full' : null;
      if (err) { send(ws, { t: 'error', msg: err }); return; }
      ws.code = target.code; ws.pid = 'p' + nextPlayerId++;
      target.players.push({ id: ws.pid, name: cleanName(msg.name), ws });
      sendLobby(target);

    } else if (!room) {
      return;

    } else if (msg.t === 'start' || msg.t === 'rematch') {
      if (ws.pid !== room.host || room.players.length < 2) return;
      if (msg.t === 'start' && room.game) return;
      if (msg.t === 'rematch' && (!room.game || room.game.phase !== 'over')) return;
      startGame(room);

    } else if (msg.t === 'act' && room.game) {
      const g = room.game;
      if (msg.a === 'aim')    g.aim(ws.pid, msg.x);
      if (msg.a === 'rotate') g.rotate(ws.pid, msg.dir);
      if (msg.a === 'buy')    g.buy(ws.pid, msg.item);
      if (msg.a === 'drop')   g.drop(ws.pid);

    } else if (msg.t === 'leave') {
      leave(ws);
      ws.code = null;
    }
  });

  ws.on('close', () => leave(ws));
});

httpServer.listen(PORT, () => console.log(`Stacktics running on http://localhost:${PORT}`));
