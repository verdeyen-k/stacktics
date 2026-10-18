(() => {
  const { Game, SHOP, WORLD_W, PLATFORM, TICK, flexSegments } = TowerGame;
  const COLORS = ['#ff6b6b', '#4dabf7', '#ffd43b', '#69db7c'];
  const DARK   = ['#c94545', '#2f7fc4', '#d4a514', '#3fae55'];
  const $ = id => document.getElementById(id);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const buzz = ms => { try { navigator.vibrate && navigator.vibrate(ms); } catch {} };

  // ── Sound effects, synthesized with Web Audio (no files) ────────
  const sfx = (() => {
    let ac = null, master = null, noiseBuf = null;
    let muted = store.get('muted') === '1';
    // Browsers only allow audio after a user gesture, so start it on the first touch or key.
    const unlock = () => {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!ac && AC) {
        ac = new AC();
        master = ac.createGain();
        master.gain.value = 0.5;
        master.connect(ac.destination);
      }
      if (ac && ac.state === 'suspended') ac.resume();
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    // One note whose pitch glides from f0 to f1 over dur seconds.
    function tone(f0, f1, dur, { type = 'sine', vol = 0.3, delay = 0 } = {}) {
      const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + dur + 0.02);
    }

    // A burst of band-passed noise: knocks, squelches, ticks.
    function noise(freq, q, dur, vol, delay = 0) {
      if (!noiseBuf) {
        noiseBuf = ac.createBuffer(1, ac.sampleRate / 2, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const t = ac.currentTime + delay, src = ac.createBufferSource(), f = ac.createBiquadFilter(), g = ac.createGain();
      src.buffer = noiseBuf;
      f.type = 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q;
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(f).connect(g).connect(master);
      src.start(t);
      src.stop(t + dur + 0.02);
    }

    const sounds = {
      hit(v, size = 44) { // wooden clack: louder for harder hits, lower for bigger blocks
        const k = Math.min(1, v / 10);
        const p = Math.max(0.4, Math.min(2, Math.pow(44 / size, 0.8))) * (0.92 + Math.random() * 0.16);
        noise(1100 * p, 4, 0.07, 0.2 + 0.5 * k);
        tone(200 * p, 120 * p, 0.08, { vol: 0.1 + 0.3 * k });
      },
      drop() { tone(520, 260, 0.12, { type: 'triangle', vol: 0.12 }); },
      fall() { tone(700, 140, 0.55, { type: 'triangle', vol: 0.18 }); },
      point() {
        tone(988, 988, 0.12, { type: 'square', vol: 0.05, delay: 0.25 });
        tone(1319, 1319, 0.3, { type: 'square', vol: 0.05, delay: 0.33 });
      },
      bounce() { // cartoon boing: pitch jumps up, then wobbles down
        const t = ac.currentTime, o = ac.createOscillator(), lfo = ac.createOscillator(), depth = ac.createGain(), g = ac.createGain();
        o.frequency.setValueAtTime(140, t);
        o.frequency.exponentialRampToValueAtTime(420, t + 0.08);
        o.frequency.exponentialRampToValueAtTime(220, t + 0.4);
        lfo.frequency.value = 18;
        depth.gain.value = 30;
        lfo.connect(depth).connect(o.frequency);
        g.gain.setValueAtTime(0.25, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        o.connect(g).connect(master);
        for (const n of [o, lfo]) { n.start(t); n.stop(t + 0.5); }
      },
      buy() { [1047, 1319, 1568].forEach((f, i) => tone(f, f, 0.12, { type: 'triangle', vol: 0.12, delay: i * 0.06 })); },
      turn() { tone(660, 660, 0.15, { vol: 0.12 }); tone(880, 880, 0.25, { vol: 0.12, delay: 0.12 }); },
      rushed() {
        for (let i = 0; i < 3; i++) noise(3000, 8, 0.03, 0.4, i * 0.08);
        tone(440, 880, 0.2, { type: 'sawtooth', vol: 0.05, delay: 0.24 });
      },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone(f, f, i === 3 ? 0.6 : 0.18, { type: 'triangle', vol: 0.15, delay: i * 0.14 })); },
      stick() { noise(400, 2, 0.18, 0.35); tone(160, 90, 0.15, { vol: 0.12 }); },
      soak() { noise(2500, 1, 0.25, 0.15); },
      pull(v) { // magnetic vwoom: buzzy, wobbling, rising hum, louder for a stronger pull
        const k = Math.min(1, v / 3), t = ac.currentTime, dur = 0.4;
        const lp = ac.createBiquadFilter(), g = ac.createGain(), lfo = ac.createOscillator(), depth = ac.createGain();
        lp.type = 'lowpass';
        lp.frequency.value = 700;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.06 + 0.12 * k, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        lfo.frequency.value = 22;
        depth.gain.value = 0.04;
        lfo.connect(depth).connect(g.gain);
        lp.connect(g).connect(master);
        const oscs = [0, 7].map(detune => {
          const o = ac.createOscillator();
          o.type = 'sawtooth';
          o.detune.value = detune * 10;
          o.frequency.setValueAtTime(85, t);
          o.frequency.exponentialRampToValueAtTime(150 + 60 * k, t + dur);
          o.connect(lp);
          return o;
        });
        for (const n of [...oscs, lfo]) { n.start(t); n.stop(t + dur + 0.02); }
      },
      slide(v) { // squeaky slide whistle, higher and louder the faster it slides
        const k = Math.min(1, v / 6);
        tone(550 + 350 * k, 800 + 700 * k, 0.18, { vol: 0.05 + 0.07 * k });
        noise(3200, 0.8, 0.16, 0.05 + 0.06 * k);
      },
      tick() { noise(2200, 6, 0.025, 0.2); },
      grab() { tone(300, 450, 0.06, { vol: 0.12 }); },
      clear() { noise(600, 0.7, 0.35, 0.3); },
    };

    return {
      play(name, ...args) { if (ac && !muted && ac.state === 'running') sounds[name](...args); },
      get muted() { return muted; },
      toggle() { muted = !muted; store.set('muted', muted ? '1' : '0'); unlock(); return muted; },
    };
  })();

  // ── Screens ──────────────────────────────────────────────────────
  const SCREENS = ['menu', 'local', 'lobby', 'rules', 'game'];
  function show(name) {
    for (const s of SCREENS) $(s).hidden = s !== name;
    if (name === 'game') resize();
  }
  document.querySelectorAll('[data-back]').forEach(b => b.onclick = () => show('menu'));
  $('btn-rules').onclick = () => show('rules');

  const nameInput = $('name');
  nameInput.value = store.get('name') || '';
  const myName = () => { const n = nameInput.value.trim() || 'Player'; store.set('name', n); return n; };

  // ── Session: either a local Game or a server connection ─────────
  let session = null;
  let ws = null;

  function resetView() {
    effects.length = 0;
    aimX = null;
    cam.init = false;
    $('over').hidden = true;
    $('quit-confirm').hidden = true;
    lastScoresKey = '';
  }

  // Pass & play
  let localCount = 2;
  function renderLocalNames() {
    const box = $('local-names');
    const old = [...box.querySelectorAll('input')].map(i => i.value);
    box.innerHTML = '';
    for (let i = 0; i < localCount; i++) {
      const inp = document.createElement('input');
      inp.className = 'field';
      inp.maxLength = 12;
      inp.placeholder = `Player ${i + 1}`;
      inp.value = old[i] ?? (i === 0 ? (nameInput.value.trim()) : '');
      inp.style.borderLeft = `8px solid ${COLORS[i]}`;
      box.appendChild(inp);
    }
  }
  $('local-counts').onclick = e => {
    const n = +e.target.dataset.n;
    if (!n) return;
    localCount = n;
    for (const b of $('local-counts').children) b.classList.toggle('on', +b.dataset.n === n);
    renderLocalNames();
  };
  $('btn-local').onclick = () => { myName(); renderLocalNames(); show('local'); };
  $('btn-local-start').onclick = () => {
    const names = [...$('local-names').querySelectorAll('input')].map((inp, i) => inp.value.trim() || `Player ${i + 1}`);
    startLocal(names);
  };

  $('btn-science').onclick = () => startLocal(['Scientist'], true);

  function startLocal(names, science = false) {
    const game = new Game(names.map((name, i) => ({ id: 'L' + i, name })), { science });
    let acc = 0;
    session = {
      mode: 'local', names, science,
      get me() { return game.active ? game.active.id : null; }, // whoever's turn it is holds the phone
      isHost: true,
      act(a, d = {}) {
        const pid = game.active && game.active.id;
        if (a === 'aim') game.aim(pid, d.x);
        if (a === 'rotate') game.rotate(pid, d.dir);
        if (a === 'buy') game.buy(pid, d.item);
        if (a === 'drop') game.drop(pid);
        if (a === 'clear') game.clear(pid);
        if (a === 'grab') return game.grab(pid, d.x, d.y, d.slop);
        if (a === 'move') game.move(pid, d.x, d.y);
        if (a === 'release') game.release(pid);
      },
      update(dt) {
        acc = Math.min(acc + dt, 250);
        while (acc >= TICK) { game.step(); acc -= TICK; }
        const snap = game.snapshot();
        handleEvents(game.drainEvents(), snap);
        return snap;
      },
      rematch() { startLocal(names, science); },
      quit() { session = null; show('menu'); },
    };
    resetView();
    setScienceUI(science);
    show('game');
  }

  // Science mode hides scoring and shows power-ups as free toggles.
  function setScienceUI(on) {
    $('scores').hidden = on;
    $('btn-clear').hidden = !on;
    for (const b of shopEl.children) {
      b.querySelector('.cost').textContent = on ? 'free' : `★${SHOP[b.dataset.item].cost}`;
      b.hidden = on && b.dataset.item === 'rush';
    }
    shopEl.classList.toggle('science', on);
  }

  // Online
  function connect(first) {
    if (!location.host) { $('menu-error').textContent = 'Online play needs the server (npm start).'; return; }
    if (ws) ws.close();
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    const sock = ws;
    sock.onopen = () => sock.send(JSON.stringify(first));
    sock.onerror = () => { $('menu-error').textContent = 'Could not reach the server.'; };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = null;
      if (session && session.mode === 'net') { session = null; show('menu'); $('menu-error').textContent = 'Disconnected.'; }
    };
    sock.onmessage = e => onServer(JSON.parse(e.data));
  }
  const sendNet = msg => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  $('btn-create').onclick = () => { $('menu-error').textContent = ''; connect({ t: 'create', name: myName() }); };
  $('btn-join').onclick = () => {
    const code = $('join-code').value.trim().toUpperCase();
    if (code.length !== 4) { $('menu-error').textContent = 'Enter the 4-letter room code.'; return; }
    $('menu-error').textContent = '';
    connect({ t: 'join', code, name: myName() });
  };
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join').click(); });
  $('btn-leave').onclick = () => { const s = ws; ws = null; session = null; if (s) s.close(); show('menu'); };
  $('btn-start').onclick = () => sendNet({ t: 'start' });

  function onServer(msg) {
    if (msg.t === 'error') { $('menu-error').textContent = msg.msg; if (ws) ws.close(); return; }

    if (msg.t === 'lobby') {
      if (!session || session.mode !== 'net') session = makeNetSession();
      Object.assign(session, { me: msg.you, isHost: msg.host === msg.you, code: msg.code });
      if (msg.game) {
        if (session.gameNo !== msg.game) { session.gameNo = msg.game; session.buf = []; resetView(); setScienceUI(false); show('game'); }
        return;
      }
      $('lobby-code').textContent = msg.code;
      const list = $('lobby-players');
      list.innerHTML = '';
      msg.players.forEach((p, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="swatch" style="background:${COLORS[i]}"></span><span></span><span class="tag"></span>`;
        li.children[1].textContent = p.name;
        li.children[2].textContent = [p.id === msg.host && 'host', p.id === msg.you && 'you'].filter(Boolean).join(' · ');
        list.appendChild(li);
      });
      $('btn-start').hidden = !session.isHost;
      $('btn-start').disabled = msg.players.length < 2;
      $('btn-start').textContent = msg.players.length < 2 ? 'Need 2+ players' : 'Start game';
      $('lobby-wait').hidden = session.isHost;
      show('lobby');
    }

    if (msg.t === 'state' && session && session.mode === 'net') {
      session.buf.push({ t: performance.now(), s: msg.s });
      if (session.buf.length > 12) session.buf.shift();
      handleEvents(msg.ev, msg.s);
    }
  }

  function makeNetSession() {
    let lastAimSent = 0;
    return {
      mode: 'net', buf: [], gameNo: 0,
      act(a, d = {}) {
        if (a === 'aim' && !d.force) {
          const now = performance.now();
          if (now - lastAimSent < 33) return;
          lastAimSent = now;
        }
        sendNet({ t: 'act', a, ...d });
      },
      // Render ~100ms in the past and interpolate between server snapshots.
      update() {
        const buf = this.buf;
        if (!buf.length) return null;
        const latest = buf[buf.length - 1].s;
        const rt = performance.now() - 100;
        let i = buf.length - 2;
        while (i >= 0 && buf[i].t > rt) i--;
        if (i < 0 || i >= buf.length - 1) return latest;
        const a = buf[i], b = buf[i + 1];
        const k = Math.max(0, Math.min(1, (rt - a.t) / (b.t - a.t)));
        const prev = new Map(a.s.blocks.map(bl => [bl[0], bl]));
        const blocks = latest.blocks.map(bl => {
          const nb = b.s.blocks.find(x => x[0] === bl[0]);
          const pb = prev.get(bl[0]);
          if (!nb || !pb) return bl;
          let da = nb[3] - pb[3];
          if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
          return [bl[0], pb[1] + (nb[1] - pb[1]) * k, pb[2] + (nb[2] - pb[2]) * k, pb[3] + da * k, ...bl.slice(4)];
        });
        return { ...latest, blocks };
      },
      rematch() { sendNet({ t: 'rematch' }); },
      quit() { const s = ws; ws = null; session = null; if (s) s.close(); show('menu'); },
    };
  }

  // ── Game events → effects & toasts ──────────────────────────────
  const effects = [];
  function toast(text, color) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    if (color) el.style.color = color;
    $('game').appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }
  const playerOf = (snap, id) => snap.players.find(p => p.id === id);

  function handleEvents(evs, snap) {
    for (const e of evs) {
      if (e.type === 'turn') {
        aimX = null;
        const p = playerOf(snap, e.player);
        if (!p) continue;
        if (session.mode === 'local') { toast(`${p.name}'s turn`, COLORS[p.color]); sfx.play('turn'); }
        else if (e.player === session.me) { toast('Your turn!', COLORS[p.color]); buzz(30); sfx.play('turn'); }
      }
      if (e.type === 'hit') sfx.play('hit', e.v, e.s);
      if (e.type === 'slide') sfx.play('slide', e.v);
      if (e.type === 'pull') sfx.play('pull', e.v);
      if (e.type === 'drop') sfx.play('drop');
      if (e.type === 'stick') sfx.play('stick');
      if (e.type === 'soak') sfx.play('soak');
      if (e.type === 'bounce') { effects.push({ kind: 'ring', x: e.x, y: e.y, life: 1, color: '#f06595' }); sfx.play('bounce'); }
      if (e.type === 'fall') {
        buzz(25);
        sfx.play('fall');
        if (e.to.length) sfx.play('point');
        for (let i = 0; i < 16; i++) {
          const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = 1.5 + Math.random() * 3;
          effects.push({ kind: 'spark', x: e.x, y: e.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 1, color: '#ffe08a' });
        }
        e.to.forEach((id, i) => {
          const p = playerOf(snap, id);
          if (p) effects.push({ kind: 'text', x: e.x, y: e.y - 20 - i * 22, text: `+1 ${p.name}`, life: 1, color: COLORS[p.color] });
        });
      }
      if (e.type === 'buy') {
        const p = playerOf(snap, e.player), item = SHOP[e.item];
        if (p && !snap.science) toast(`${p.name}: ${item.icon} ${item.label}!`, COLORS[p.color]);
        sfx.play(snap.science ? 'tick' : 'buy');
      }
      if (e.type === 'rushed') {
        const p = playerOf(snap, e.player);
        if (p) toast(`⏩ Rushed! ${p.name} goes now`, COLORS[p.color]);
        sfx.play('rushed');
      }
      if (e.type === 'win') { buzz([40, 60, 40]); sfx.play('win'); }
    }
  }

  // ── Canvas, camera, drawing ─────────────────────────────────────
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d');
  const view = { w: 0, h: 0, dpr: 1, top: 0, bottom: 0 };
  const cam = { scale: 1, init: false };
  const VIEW_BOTTOM = 120; // world y pinned to the bottom of the play area, just below the platform

  function resize() {
    view.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    view.w = window.innerWidth;
    view.h = window.innerHeight;
    canvas.width = Math.round(view.w * view.dpr);
    canvas.height = Math.round(view.h * view.dpr);
  }
  window.addEventListener('resize', resize);
  resize();

  // Background stars, in world space so they scroll as the tower climbs.
  const stars = Array.from({ length: 160 }, () => ({
    x: -400 + Math.random() * 1200, y: -6000 + Math.random() * 5800, r: 0.6 + Math.random() * 1.4,
  }));

  function towerTop(snap) {
    let top = 0;
    for (const b of snap.blocks) {
      if (b[7] & 4) continue;
      const halfY = (Math.abs(b[4] * Math.sin(b[3])) + Math.abs(b[5] * Math.cos(b[3]))) / 2;
      top = Math.min(top, b[2] - halfY);
    }
    return top;
  }

  function updateCamera(snap, dt) {
    view.top = $('hud').getBoundingClientRect().bottom + 6;
    view.bottom = $('controls').getBoundingClientRect().top;
    const avail = Math.max(100, view.bottom - view.top);
    const top = snap.hover ? snap.hover.y - snap.hover.halfY - 30 : towerTop(snap) - 200;
    // Always keep the platform in view: zoom out as far as the tower needs.
    const scale = Math.min(view.w / 440, avail / (VIEW_BOTTOM - top));
    if (!cam.init) { cam.scale = scale; cam.init = true; }
    cam.scale += (scale - cam.scale) * (1 - Math.exp(-dt / 300));
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawBlock(x, y, a, bw, bh, c, flags, alpha = 1) {
    const hw = bw / 2, h = bh / 2, s = bh, r = s * 0.14;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.globalAlpha = alpha;
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    roundRect(-hw, -h, bw, bh, r);
    ctx.fillStyle = flags & 8 ? '#ffe27a' : COLORS[c];
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineWidth = flags & 8 ? 4 : 2;
    ctx.strokeStyle = DARK[c];
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    roundRect(-hw + 4, -h + 4, bw - 8, s * 0.22, r * 0.6);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    roundRect(-hw + 4, h - 4 - s * 0.16, bw - 8, s * 0.16, r * 0.6);
    ctx.fill();

    if (flags & 8) { // sponge: pores and soap bubbles
      ctx.fillStyle = 'rgba(190, 140, 20, 0.45)';
      for (let i = 0; i < Math.round(bw / s * 6); i++) {
        const px = -hw + ((i * 0.618 + 0.2) % 1) * bw, py = -h + ((i * 0.382 + 0.3) % 1) * bh;
        ctx.beginPath(); ctx.ellipse(px, py, s * 0.06, s * 0.045, i, 0, Math.PI * 2); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(200, 240, 255, 0.9)';
      ctx.lineWidth = 1.5;
      for (const [fx, fr] of [[-0.3, 0.1], [0.05, 0.14], [0.32, 0.08]]) {
        ctx.beginPath(); ctx.arc(fx * bw, -h - s * fr, s * fr, 0, Math.PI * 2); ctx.stroke();
      }
    } else if (flags & 16) { // soaked: wet shine and blue drips
      ctx.fillStyle = 'rgba(160, 220, 255, 0.35)';
      roundRect(-hw, -h, bw, bh, r);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = s * 0.06;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(-hw + s * 0.25, h - s * 0.3); ctx.lineTo(-hw + s * 0.55, -h + s * 0.25); ctx.stroke();
      ctx.fillStyle = 'rgba(120, 200, 255, 0.9)';
      for (const fx of [-0.3, 0.25]) { ctx.beginPath(); ctx.arc(fx * bw, h + s * 0.06, s * 0.05, 0, Math.PI * 2); ctx.fill(); }
    }

    if (flags & 64) { // flexible (hovering, still straight): ribs where the slices will be
      const n = flexSegments(bw);
      ctx.strokeStyle = 'rgba(0,0,0,0.18)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 1; i < n; i++) { const px = -hw + bw * i / n; ctx.moveTo(px, -h + 3); ctx.lineTo(px, h - 3); }
      ctx.stroke();
    }

    if (flags & 32) { // bouncy: pink rubber rim with a spring across the top
      ctx.strokeStyle = '#f06595';
      ctx.lineWidth = Math.max(3, s * 0.1);
      roundRect(-hw, -h, bw, bh, r);
      ctx.stroke();
      const zig = Math.max(3, Math.round(bw / (s * 0.18)));
      ctx.strokeStyle = 'rgba(255, 240, 246, 0.95)';
      ctx.lineWidth = Math.max(2, s * 0.06);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i <= zig; i++) {
        const px = -hw + s * 0.18 + (bw - s * 0.36) * (i / zig), py = -h + s * (i % 2 ? 0.2 : 0.36);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.stroke();
    }

    if (flags & 1) { // glue: honey border with drips
      ctx.strokeStyle = 'rgba(255, 190, 40, 0.95)';
      ctx.lineWidth = Math.max(3, s * 0.08);
      roundRect(-hw, -h, bw, bh, r);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 190, 40, 0.95)';
      for (const fx of [-0.25, 0.1, 0.3]) {
        const dx = fx * bw, len = s * (0.12 + Math.abs(fx) * 0.2);
        ctx.fillRect(dx - s * 0.035, h - 2, s * 0.07, len);
        ctx.beginPath(); ctx.arc(dx, h - 2 + len, s * 0.055, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (flags & 2) { // magnet: horseshoe icon
      const m = s * 0.22;
      ctx.lineCap = 'butt';
      ctx.lineWidth = s * 0.13;
      ctx.strokeStyle = '#e03131';
      ctx.beginPath();
      ctx.moveTo(-m, -m * 0.7); ctx.lineTo(-m, m * 0.1);
      ctx.arc(0, m * 0.1, m, Math.PI, 0, true);
      ctx.lineTo(m, -m * 0.7);
      ctx.stroke();
      ctx.strokeStyle = '#e9ecef';
      ctx.beginPath();
      ctx.moveTo(-m, -m * 1.1); ctx.lineTo(-m, -m * 0.65);
      ctx.moveTo(m, -m * 1.1); ctx.lineTo(m, -m * 0.65);
      ctx.stroke();
    }
    ctx.restore();
  }

  // A flexible block's slices, drawn as one bendy strip through their corners.
  function drawFlexible(segs) {
    const corner = (b, sx, sy) => {
      const c = Math.cos(b[3]), sn = Math.sin(b[3]), px = sx * b[4] / 2, py = sy * b[5] / 2;
      return [b[1] + px * c - py * sn, b[2] + px * sn + py * c];
    };
    const top = [], bottom = [];
    for (const b of segs) { top.push(corner(b, -1, -1), corner(b, 1, -1)); bottom.push(corner(b, -1, 1), corner(b, 1, 1)); }
    const trace = pts => { ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); };
    const mid = (p, q, t = 0.5) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
    const color = segs[0][6], flags = segs[0][7];

    ctx.save();
    ctx.globalAlpha = flags & 4 ? 0.6 : 1;
    ctx.lineJoin = 'round';
    trace([...top, ...[...bottom].reverse()]);
    ctx.closePath();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = COLORS[color];
    ctx.fill();
    ctx.shadowColor = 'transparent';
    if (segs.some(b => b[7] & 16)) { ctx.fillStyle = 'rgba(160, 220, 255, 0.35)'; ctx.fill(); }
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = DARK[color];
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 1; i < segs.length; i++) {
      const t = mid(top[2 * i - 1], top[2 * i]), b = mid(bottom[2 * i - 1], bottom[2 * i]);
      ctx.moveTo(...mid(t, b, 0.08));
      ctx.lineTo(...mid(t, b, 0.92));
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    trace(top.map((p, i) => mid(p, bottom[i], 0.14)).slice(1, -1));
    ctx.stroke();
    ctx.restore();
  }

  function draw(snap, dt, now) {
    const { w, h, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Sky gets darker the higher you look.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    const height = -towerTop(snap);
    const t = Math.min(1, height / 1500);
    g.addColorStop(0, `hsl(${255 - t * 15}, 45%, ${16 - t * 8}%)`);
    g.addColorStop(1, `hsl(${265 - t * 20}, 40%, ${30 - t * 10}%)`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    const s = cam.scale;
    const ox = w / 2 - PLATFORM.x * s, oy = view.bottom - VIEW_BOTTOM * s;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);

    for (const st of stars) {
      ctx.globalAlpha = Math.min(0.8, (-st.y - 150) / 1200);
      if (ctx.globalAlpha <= 0) continue;
      ctx.fillStyle = '#fff';
      ctx.fillRect(st.x, st.y, st.r, st.r);
    }
    ctx.globalAlpha = 1;

    // Pedestal + platform
    ctx.fillStyle = '#3a3170';
    ctx.beginPath();
    ctx.moveTo(PLATFORM.x - 90, 30); ctx.lineTo(PLATFORM.x + 90, 30);
    ctx.lineTo(PLATFORM.x + 55, 1200); ctx.lineTo(PLATFORM.x - 55, 1200);
    ctx.fill();
    roundRect(PLATFORM.x - PLATFORM.w / 2, 0, PLATFORM.w, PLATFORM.h, 6);
    ctx.fillStyle = '#9b8fd6';
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.fillRect(PLATFORM.x - PLATFORM.w / 2 + 6, 3, PLATFORM.w - 12, 5);

    // Height marker
    const top = towerTop(snap);
    if (top < -5) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5 / s;
      ctx.beginPath(); ctx.moveTo(-200, top); ctx.lineTo(WORLD_W + 200, top); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `600 ${13 / s}px Fredoka, system-ui, sans-serif`;
      ctx.textAlign = 'right';
      ctx.fillText(`${(-top / 44).toFixed(1)} squares tall`, (w - ox) / s - 10 / s, top - 6 / s);
    }

    const flexible = new Map();
    for (const b of snap.blocks) {
      if (b[7] & 64) {
        if (!flexible.has(b[8])) flexible.set(b[8], []);
        flexible.get(b[8]).push(b);
      } else drawBlock(b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[7] & 4 ? 0.6 : 1);
    }
    for (const segs of flexible.values()) drawFlexible(segs);

    ctx.fillStyle = 'rgba(255, 190, 40, 0.95)';
    for (const [gx, gy] of snap.glue) { ctx.beginPath(); ctx.arc(gx, gy, 3.5, 0, Math.PI * 2); ctx.fill(); }

    if (snap.grab) { // science-mode tether from finger to the grabbed block
      const [fx, fy, bx, by] = snap.grab;
      ctx.setLineDash([5, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2 / s;
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(bx, by); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(bx, by, 4 / s, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.beginPath(); ctx.arc(fx, fy, 12 / s, 0, Math.PI * 2); ctx.stroke();
    }

    const hv = snap.hover;
    if (hv) {
      const x = aimX ?? hv.x;
      ctx.setLineDash([4, 6]);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, hv.y + hv.h / 2 + 6); ctx.lineTo(x, 0); ctx.stroke();
      ctx.setLineDash([]);
      const bob = Math.sin(now / 300) * 3;
      drawBlock(x, hv.y + bob, hv.angle, hv.w, hv.h, hv.c, (hv.glue ? 1 : 0) | (hv.magnet ? 2 : 0) | (hv.sponge ? 8 : 0) | (hv.bouncy ? 32 : 0) | (hv.flex ? 64 : 0), 0.92);
      if (hv.rush) {
        ctx.font = `700 ${16 / s}px Fredoka, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffb84d';
        ctx.fillText('⏩ RUSH', x, hv.y - hv.h / 2 - 14 / s);
      }
    }

    // Particles & floating text
    ctx.textAlign = 'center';
    for (let i = effects.length - 1; i >= 0; i--) {
      const e = effects[i];
      e.life -= dt / (e.kind === 'text' ? 1400 : 700);
      if (e.life <= 0) { effects.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, e.life * 1.5);
      ctx.fillStyle = e.color;
      if (e.kind === 'spark') {
        e.x += e.vx; e.y += e.vy; e.vy += 0.15;
        ctx.fillRect(e.x - 2, e.y - 2, 4, 4);
      } else if (e.kind === 'ring') {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(e.x, e.y, 18 + (1 - e.life) * 40, 0, Math.PI * 2); ctx.stroke();
      } else {
        e.y -= dt * 0.03;
        ctx.font = `700 ${18 / s}px Fredoka, system-ui, sans-serif`;
        ctx.lineWidth = 4 / s;
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.strokeText(e.text, e.x, e.y);
        ctx.fillText(e.text, e.x, e.y);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── HUD & controls ──────────────────────────────────────────────
  let lastScoresKey = '';
  const myTurn = snap => snap && snap.phase === 'aim' && snap.turn === session.me;
  const mePlayer = snap => snap.players.find(p => p.id === (session.mode === 'local' ? snap.turn : session.me));

  const shopEl = $('shop');
  for (const [key, item] of Object.entries(SHOP)) {
    const b = document.createElement('button');
    b.dataset.item = key;
    b.innerHTML = `<span class="ic">${item.icon}</span><span>${item.label}</span><span class="cost">★${item.cost}</span><span class="cnt"></span>`;
    b.title = item.desc;
    b.onclick = () => session && session.act('buy', { item: key });
    shopEl.appendChild(b);
  }

  function updateUI(snap) {
    const key = JSON.stringify([snap.players, snap.turn]);
    if (key !== lastScoresKey) {
      lastScoresKey = key;
      const box = $('scores');
      box.innerHTML = '';
      for (const p of snap.players) {
        const d = document.createElement('div');
        d.className = 'score' + (p.id === snap.turn && snap.phase !== 'over' ? ' active' : '');
        d.style.color = COLORS[p.color];
        d.innerHTML = `<span class="swatch" style="background:${COLORS[p.color]}"></span><span class="nm"></span><span class="pts">${p.points}</span>`;
        d.querySelector('.nm').textContent = p.name + (session.mode === 'net' && p.id === session.me ? ' (you)' : '');
        box.appendChild(d);
      }
    }

    const active = playerOf(snap, snap.turn);
    const mine = myTurn(snap);
    let banner = '', timer = '';
    if (snap.phase === 'aim' && active) {
      banner = session.mode === 'local' ? `${active.name}'s turn` : mine ? 'Your turn — drag to aim' : `${active.name} is aiming…`;
      if (snap.science) banner = '🔬 Science mode · drag blocks to move them';
      if (snap.timeLeft != null && snap.timeLeft < 10000) timer = `${Math.ceil(snap.timeLeft / 1000)}s`;
    } else if (snap.phase === 'settle') banner = 'Wobble…';
    if ($('banner-text').textContent !== banner) $('banner-text').textContent = banner;
    if ($('banner-timer').textContent !== timer) $('banner-timer').textContent = timer;
    $('banner').style.color = active ? COLORS[active.color] : '';

    const me = mePlayer(snap);
    const hv = snap.hover;
    for (const b of shopEl.children) {
      const it = b.dataset.item;
      const owned = !!hv && (it === 'long' ? hv.len > 1 : it === 'small' || it === 'big' ? hv.sizeMod === it : hv[it]);
      const badge = it === 'long' && hv && hv.len > 1 ? `×${hv.len}` : '';
      if (b.dataset.badge !== badge) { b.dataset.badge = badge; b.querySelector('.cnt').textContent = badge; }
      b.classList.toggle('owned', owned && mine);
      b.disabled = snap.science
        ? !hv || (!owned && !SHOP[it].ok(hv) && !['long', 'small', 'big'].includes(it)) // toggles; Long cycles, sizes swap
        : !mine || !hv || !SHOP[it].ok(hv) || !me || me.points < SHOP[it].cost;
    }
    for (const id of ['btn-drop', 'btn-rot-l', 'btn-rot-r']) $(id).disabled = !mine;
    $('controls').style.opacity = mine || snap.phase === 'over' ? 1 : 0.55;

    const over = snap.phase === 'over';
    if (over && $('over').hidden) {
      const w = playerOf(snap, snap.winner);
      $('over-title').textContent = w ? (session.mode === 'net' && w.id === session.me ? 'You win!' : `${w.name} wins!`) : 'Game over';
      $('over-sub').textContent = snap.players.map(p => `${p.name} ★${p.points}`).join('   ');
      $('btn-rematch').hidden = !session.isHost;
      $('over-sub').textContent += session.isHost ? '' : '  ·  waiting for host…';
    }
    $('over').hidden = !over;
  }

  // ── Input ───────────────────────────────────────────────────────
  let aimX = null;   // locally predicted aim so dragging feels instant online
  let drag = null;
  let current = null;

  function setAim(x) {
    if (!myTurn(current) || !current.hover) return;
    const half = Math.min(current.hover.halfX, WORLD_W / 2);
    aimX = Math.max(half, Math.min(WORLD_W - half, x));
    session.act('aim', { x: aimX });
  }

  // Screen position → world position, matching the transform in draw().
  const toWorld = e => ({
    x: PLATFORM.x + (e.clientX - view.w / 2) / cam.scale,
    y: VIEW_BOTTOM - (view.bottom - e.clientY) / cam.scale,
  });

  canvas.addEventListener('pointerdown', e => {
    if (!myTurn(current)) return;
    // In science mode, touching a block grabs it; touching empty space aims the next block.
    const grabbing = current.science && session.act('grab', { ...toWorld(e), slop: 14 / cam.scale });
    if (grabbing) sfx.play('grab');
    drag = { id: e.pointerId, x: e.clientX, block: !!grabbing };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.block) { session.act('move', toWorld(e)); return; }
    setAim((aimX ?? current.hover.x) + (e.clientX - drag.x) / cam.scale);
    drag.x = e.clientX;
  });
  const endDrag = e => {
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.block) session.act('release');
    else if (aimX != null) session.act('aim', { x: aimX });
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  const rotate = dir => { if (myTurn(current)) { session.act('rotate', { dir }); sfx.play('tick'); } };
  const drop = () => {
    if (!myTurn(current)) return;
    if (aimX != null) session.act('aim', { x: aimX, force: true });
    session.act('drop');
    buzz(15);
  };
  $('btn-rot-l').onclick = () => rotate(-1);
  $('btn-rot-r').onclick = () => rotate(1);
  $('btn-drop').onclick = drop;

  window.addEventListener('keydown', e => {
    if ($('game').hidden || !current || e.target.tagName === 'INPUT') return;
    const x = aimX ?? (current.hover && current.hover.x);
    if (e.key === 'ArrowLeft' || e.key === 'a') setAim(x - 8);
    else if (e.key === 'ArrowRight' || e.key === 'd') setAim(x + 8);
    else if (e.key === 'q') rotate(-1);
    else if (e.key === 'e') rotate(1);
    else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); drop(); }
  });

  $('btn-quit').onclick = () => { $('quit-confirm').hidden = false; };
  $('btn-clear').onclick = () => { if (session) { session.act('clear'); sfx.play('clear'); } };
  const soundBtn = $('btn-sound');
  soundBtn.textContent = sfx.muted ? '🔇' : '🔊';
  soundBtn.onclick = () => { soundBtn.textContent = sfx.toggle() ? '🔇' : '🔊'; };
  $('btn-quit-no').onclick = () => { $('quit-confirm').hidden = true; };
  $('btn-quit-yes').onclick = () => session && session.quit();
  $('btn-over-menu').onclick = () => session && session.quit();
  $('btn-rematch').onclick = () => session && session.rematch();

  // ── Main loop ───────────────────────────────────────────────────
  let lastT = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(100, now - lastT);
    lastT = now;
    if (!session || $('game').hidden) return;
    const snap = session.update(dt);
    if (!snap) return;
    current = snap;
    if (!myTurn(snap)) aimX = null;
    updateCamera(snap, dt);
    draw(snap, dt, now);
    updateUI(snap);
  }
  requestAnimationFrame(frame);
})();
