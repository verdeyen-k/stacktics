// Serves the game for local testing (npm start). Online rooms run through Firebase, with the host's
// browser running the physics, so the published site needs no server at all.
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3002;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
};

// Only these files are served; everything else is a 404.
const FILES = {
  '/':           'index.html',
  '/index.html': 'index.html',
  '/client.js':  'client.js',
  '/game.js':    'game.js',
};

http.createServer((req, res) => {
  const file = FILES[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Stacktics running at http://localhost:${PORT}`));
