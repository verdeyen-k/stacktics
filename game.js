// Shared game rules + physics. Runs on the server (authoritative online play)
// and in the browser (pass-and-play on one device).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('matter-js'));
  else root.TowerGame = factory(root.Matter);
})(typeof self !== 'undefined' ? self : this, function (Matter) {
  const { Engine, Bodies, Body, Composite, Constraint, Events, Vector } = Matter;

  // World units are pixels at scale 1. y grows downward; the platform top sits at y = 0.
  const WORLD_W   = 400;
  const PLATFORM  = { x: 200, y: 20, w: 220, h: 40 };
  const BASE_SIZE = 44;
  const FALL_Y    = 30;     // a block whose center drops below this is off the platform
  const KILL_Y    = 900;    // remove fallen blocks once they're well out of sight
  const DROP_GAP  = 120;    // how far above the tower the next square hovers
  const TICK      = 1000 / 60;
  const AIM_TIME  = 30000;
  const TARGET    = 10;

  const MAGNET_RANGE = 120;
  const MAGNET_PULL  = 0.0007; // gravity is 0.001 * mass per tick, for comparison
  const GLUE_BONDS   = 4;
  const GLUE_STRETCH = 14;     // glue snaps if stretched further than this
  const SLICK        = 0.02;   // friction of the sponge and anything it soaks
  const MAX_W        = 360;    // widest a block may get
  const RUSH_TIME    = 600;    // a rushed turn ends this long after the drop, moving or not

  // The block being aimed: its height is base * scale, its width height * len.
  const blockW = h => h.base * h.scale * h.len;
  const blockH = h => h.base * h.scale;

  // ok(hover) says whether the item can still be bought for this block; shared with the client's buttons.
  const SHOP = {
    small:  { cost: 1, label: 'Tiny',     icon: '🤏', desc: 'Smaller block',
              ok: h => !h.sizeMod,                                 apply: h => { h.sizeMod = 'small'; h.scale = 0.6; } },
    big:    { cost: 1, label: 'Huge',     icon: '🐘', desc: 'Bigger block',
              ok: h => !h.sizeMod && blockW(h) * 1.5 <= MAX_W,     apply: h => { h.sizeMod = 'big'; h.scale = 1.5; } },
    long:   { cost: 1, label: 'Long',     icon: '↔️', desc: 'Doubles the length — buy again to keep stretching',
              ok: h => blockW(h) * 2 <= MAX_W,                     apply: h => { h.len *= 2; } },
    glue:   { cost: 2, label: 'Glue',     icon: '🍯', desc: 'Sticks to what it touches',
              ok: h => !h.glue && !h.sponge,                       apply: h => { h.glue = true; } },
    sponge: { cost: 2, label: 'Slippery', icon: '🧽', desc: 'A soapy sponge that makes whatever it touches slippery',
              ok: h => !h.sponge && !h.glue,                       apply: h => { h.sponge = true; } },
    magnet: { cost: 3, label: 'Magnet',   icon: '🧲', desc: 'Pulls nearby blocks in',
              ok: h => !h.magnet,                                  apply: h => { h.magnet = true; } },
    rush:   { cost: 4, label: 'Rush',     icon: '⏩', desc: "Next player's turn starts before the tower settles",
              ok: h => !h.rush,                                    apply: h => { h.rush = true; } },
  };

  const r1 = n => Math.round(n * 10) / 10;
  const r3 = n => Math.round(n * 1000) / 1000;

  class Game {
    constructor(players, opts = {}) {
      this.target  = opts.target || TARGET;
      this.players = players.map((p, i) => ({ id: p.id, name: p.name, color: i, points: 0 }));
      this.events  = [];
      this.time    = 0;
      this.nextId  = 1;
      this.blocks  = [];
      this.glues   = [];
      this.pendingGlue = [];
      this.winner  = null;

      this.engine = Engine.create({ positionIterations: 12, velocityIterations: 10 });
      this.platform = Bodies.rectangle(PLATFORM.x, PLATFORM.y, PLATFORM.w, PLATFORM.h, {
        isStatic: true, friction: 0.9, frictionStatic: 1, chamfer: { radius: 6 },
      });
      Composite.add(this.engine.world, this.platform);
      Events.on(this.engine, 'collisionStart', e => this.onCollide(e.pairs));

      this.startTurn(Math.floor(Math.random() * this.players.length));
    }

    get active() { return this.players[this.turn]; }

    // ── Turn flow ──────────────────────────────────────────────────
    startTurn(i) {
      this.turn = i;
      this.phase = 'aim';
      this.phaseStart = this.time;
      const base = BASE_SIZE * (0.85 + Math.random() * 0.3);
      this.hover = { x: WORLD_W / 2, angle: 0, base, scale: 1, len: 1, sizeMod: null,
                     glue: false, magnet: false, sponge: false, rush: false };
      this.events.push({ type: 'turn', player: this.active.id });
    }

    endTurn() {
      const best = Math.max(...this.players.map(p => p.points));
      if (best >= this.target) {
        this.phase = 'over';
        this.winner = this.players.find(p => p.points === best).id;
        this.events.push({ type: 'win', player: this.winner });
        return;
      }
      this.startTurn((this.turn + 1) % this.players.length);
    }

    towerTop() {
      let top = 0;
      for (const b of this.blocks) if (!b.fallen) top = Math.min(top, b.bounds.min.y);
      return top;
    }

    // Half the hover block's rotated extent along x / y.
    halfX() { const h = this.hover, a = h.angle; return (Math.abs(blockW(h) * Math.cos(a)) + Math.abs(blockH(h) * Math.sin(a))) / 2; }
    halfY() { const h = this.hover, a = h.angle; return (Math.abs(blockW(h) * Math.sin(a)) + Math.abs(blockH(h) * Math.cos(a))) / 2; }

    hoverY() { return this.towerTop() - DROP_GAP - this.halfY(); }

    // ── Player actions (ignored unless it's that player's aim phase) ─
    canAct(pid) { return this.phase === 'aim' && this.active && this.active.id === pid; }

    aim(pid, x) {
      if (!this.canAct(pid) || typeof x !== 'number' || !isFinite(x)) return;
      const half = Math.min(this.halfX(), WORLD_W / 2);
      this.hover.x = Math.max(half, Math.min(WORLD_W - half, x));
    }

    rotate(pid, dir) {
      if (!this.canAct(pid)) return;
      const step = Math.PI / 12;
      this.hover.angle = ((this.hover.angle + (dir < 0 ? -step : step)) % Math.PI + Math.PI) % Math.PI;
      this.aim(pid, this.hover.x); // re-clamp: a tilted long block is a different width
    }

    buy(pid, item) {
      if (!this.canAct(pid) || !SHOP[item]) return;
      const p = this.active, h = this.hover, it = SHOP[item];
      if (p.points < it.cost || !it.ok(h)) return;
      p.points -= it.cost;
      it.apply(h);
      this.aim(pid, h.x); // re-clamp in case the block grew
      this.events.push({ type: 'buy', player: pid, item });
    }

    drop(pid) {
      if (!this.canAct(pid)) return;
      const h = this.hover, w = blockW(h), ht = blockH(h);
      const body = Bodies.rectangle(h.x, this.hoverY(), w, ht, {
        angle: h.angle, chamfer: { radius: ht * 0.12 },
        friction: h.sponge ? SLICK : 0.7, frictionStatic: 1, restitution: 0.02, density: 0.0015,
      });
      Object.assign(body, {
        gid: this.nextId++, w, h: ht, color: this.active.color,
        glue: h.glue, magnet: h.magnet, sponge: h.sponge, slick: h.sponge, bonds: 0, fallen: false,
      });
      this.rush = h.rush;
      Composite.add(this.engine.world, body);
      this.blocks.push(body);
      this.phase = 'settle';
      this.phaseStart = this.time;
      this.calm = 0;
      this.events.push({ type: 'drop', player: pid });
    }

    removePlayer(pid) {
      const idx = this.players.findIndex(p => p.id === pid);
      if (idx < 0) return;
      this.players.splice(idx, 1);
      if (this.phase === 'over') return;
      if (this.players.length < 2) {
        this.phase = 'over';
        this.winner = this.players[0] ? this.players[0].id : null;
        this.events.push({ type: 'win', player: this.winner, forfeit: true });
        return;
      }
      if (idx < this.turn) this.turn--;
      else if (idx === this.turn) {
        if (this.phase === 'aim') this.startTurn(idx % this.players.length);
        else this.turn = (idx - 1 + this.players.length) % this.players.length; // endTurn advances to whoever was next
      }
    }

    // ── Simulation ─────────────────────────────────────────────────
    step() {
      this.applyMagnets();
      Engine.update(this.engine, TICK);
      this.time += TICK;
      this.applyGlue();
      this.checkFalls();

      if (this.phase === 'aim' && this.time - this.phaseStart > AIM_TIME) this.drop(this.active.id);

      if (this.phase === 'settle') {
        const moving = this.blocks.some(b => !b.fallen &&
          (Vector.magnitude(b.velocity) > 0.15 || Math.abs(b.angularVelocity) > 0.005));
        this.calm = moving ? 0 : this.calm + 1;
        const elapsed = this.time - this.phaseStart;
        const rushed = this.rush && elapsed > RUSH_TIME;
        if ((elapsed > 600 && this.calm > 30) || elapsed > 8000 || rushed) {
          this.endTurn();
          if (rushed && this.phase === 'aim') this.events.push({ type: 'rushed', player: this.active.id });
        }
      }
    }

    applyMagnets() {
      for (const m of this.blocks) {
        if (!m.magnet || m.fallen) continue;
        for (const o of this.blocks) {
          if (o === m || o.fallen) continue;
          const d = Vector.sub(m.position, o.position);
          const dist = Vector.magnitude(d);
          if (dist < 1 || dist > MAGNET_RANGE) continue;
          const f = Vector.mult(d, MAGNET_PULL * o.mass * (1 - dist / MAGNET_RANGE) / dist);
          Body.applyForce(o, o.position, f);
          Body.applyForce(m, m.position, Vector.neg(f));
        }
      }
    }

    onCollide(pairs) {
      for (const pair of pairs) {
        const a = pair.bodyA.parent, b = pair.bodyB.parent;
        // The sponge soaks whatever loose block it touches (but not the platform, and soaked blocks don't spread it).
        for (const [sp, o] of [[a, b], [b, a]]) {
          if (sp.sponge && !o.isStatic && !o.slick) { o.slick = true; o.friction = SLICK; }
        }
        // Queue bonds; adding constraints mid-update is asking for trouble.
        if (!a.glue && !b.glue) continue;
        const points = pair.collision.supports.filter(Boolean).slice(0, 2).map(p => ({ x: p.x, y: p.y }));
        if (points.length) this.pendingGlue.push({ a, b, points });
      }
    }

    applyGlue() {
      const world = this.engine.world;
      for (const { a, b, points } of this.pendingGlue) {
        const sticky = a.glue ? a : b;
        if (a.fallen || b.fallen || sticky.bonds >= GLUE_BONDS) continue;
        if (this.glues.some(c => (c.bodyA === a && c.bodyB === b) || (c.bodyA === b && c.bodyB === a))) continue;
        sticky.bonds++;
        const anchors = points.map(p => [Vector.sub(p, a.position), Vector.sub(p, b.position)]);
        // A single contact point would act as a hinge, so add a center-to-center strut.
        if (anchors.length === 1) anchors.push([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
        for (const [pointA, pointB] of anchors) {
          const c = Constraint.create({ bodyA: a, bodyB: b, pointA, pointB, stiffness: 0.6, damping: 0.1 });
          c.strut = pointA.x === 0 && pointA.y === 0;
          Composite.add(world, c);
          this.glues.push(c);
        }
      }
      this.pendingGlue.length = 0;

      // Snap overstretched glue.
      this.glues = this.glues.filter(c => {
        const pa = Vector.add(c.bodyA.position, c.pointA);
        const pb = Vector.add(c.bodyB.position, c.pointB);
        if (Math.abs(Vector.magnitude(Vector.sub(pa, pb)) - c.length) <= GLUE_STRETCH) return true;
        Composite.remove(world, c);
        return false;
      });
    }

    checkFalls() {
      const world = this.engine.world;
      for (const b of this.blocks) {
        if (b.fallen || b.position.y <= FALL_Y) continue;
        b.fallen = true;
        const by = this.active ? this.active.id : null;
        const to = [];
        if (this.phase !== 'over') {
          for (const p of this.players) if (p.id !== by) { p.points++; to.push(p.id); }
        }
        this.events.push({ type: 'fall', x: r1(b.position.x), y: r1(b.position.y), by, to });
      }
      const gone = this.blocks.filter(b => b.position.y > KILL_Y || Math.abs(b.position.x - PLATFORM.x) > 1200);
      if (!gone.length) return;
      for (const b of gone) {
        Composite.remove(world, b);
        this.glues = this.glues.filter(c => {
          if (c.bodyA !== b && c.bodyB !== b) return true;
          Composite.remove(world, c);
          return false;
        });
      }
      this.blocks = this.blocks.filter(b => !gone.includes(b));
    }

    drainEvents() { const e = this.events; this.events = []; return e; }

    // Compact, JSON-friendly view of everything a client needs to draw.
    snapshot() {
      const h = this.hover;
      return {
        phase: this.phase,
        turn: this.active ? this.active.id : null,
        target: this.target,
        winner: this.winner,
        timeLeft: this.phase === 'aim' ? Math.max(0, Math.round(AIM_TIME - (this.time - this.phaseStart))) : null,
        players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, points: p.points })),
        hover: this.phase === 'aim' ? {
          ...h, x: r1(h.x), angle: r3(h.angle), y: r1(this.hoverY()),
          w: r1(blockW(h)), h: r1(blockH(h)), halfX: r1(this.halfX()), halfY: r1(this.halfY()), c: this.active.color,
        } : null,
        blocks: this.blocks.map(b => [b.gid, r1(b.position.x), r1(b.position.y), r3(b.angle), r1(b.w), r1(b.h), b.color,
          (b.glue ? 1 : 0) | (b.magnet ? 2 : 0) | (b.fallen ? 4 : 0) | (b.sponge ? 8 : 0) | (b.slick ? 16 : 0)]),
        glue: this.glues.filter(c => !c.strut).map(c => {
          const p = Vector.add(c.bodyA.position, c.pointA);
          return [r1(p.x), r1(p.y)];
        }),
      };
    }
  }

  return { Game, SHOP, WORLD_W, PLATFORM, TICK };
});
