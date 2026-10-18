// Shared game rules + physics. Runs on the server (authoritative online play)
// and in the browser (pass-and-play on one device).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('matter-js'));
  else root.TowerGame = factory(root.Matter);
})(typeof self !== 'undefined' ? self : this, function (Matter) {
  const { Engine, Bodies, Body, Composite, Constraint, Events, Query, Vector } = Matter;

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
  const BOUNCE_SELF  = 0.55;   // a bouncy block's one hop, as a fraction of its landing speed
  const BOUNCE_FLING = 0.95;   // how hard a landed bouncy block throws back what hits it
  const BOUNCE_MIN   = 1.5;    // closing speeds below this (resting, sliding) don't bounce
  const BOUNCE_MAX   = 10;     // cap on any bounce speed, px per tick
  const HIT_MIN      = 1.2;    // collisions softer than this make no 'hit' sound event
  const HIT_GAP      = 60;     // ms between 'hit' events, so a collapse doesn't flood clients
  const FLEX_STIFF   = 0.25;   // springiness of a flexible block's joints: lower bends and stretches more

  // A flexible block is a row of slices about 12 wide, joined by springs.
  const flexSegments = w => Math.max(3, Math.min(16, Math.round(w / 12)));
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
              ok: h => !h.glue && !h.sponge && !h.bouncy && !h.flex, apply: h => { h.glue = true; } },
    sponge: { cost: 2, label: 'Slippery', icon: '🧽', desc: 'A soapy sponge that makes whatever it touches slippery',
              ok: h => !h.sponge && !h.glue && !h.flex,            apply: h => { h.sponge = true; } },
    bouncy: { cost: 2, label: 'Bouncy',   icon: '🏀', desc: 'Hops once when it lands, then flings off anything that lands on it',
              ok: h => !h.bouncy && !h.glue && !h.flex,            apply: h => { h.bouncy = true; } },
    flex:   { cost: 2, label: 'Flexible', icon: '🪱', desc: 'A rubbery block that bends and stretches',
              ok: h => !h.flex && !h.glue && !h.sponge && !h.bouncy && !h.magnet, apply: h => { h.flex = true; } },
    magnet: { cost: 3, label: 'Magnet',   icon: '🧲', desc: 'Pulls nearby blocks in',
              ok: h => !h.magnet && !h.flex,                       apply: h => { h.magnet = true; } },
    rush:   { cost: 4, label: 'Rush',     icon: '⏩', desc: "Next player's turn starts before the tower settles",
              ok: h => !h.rush,                                    apply: h => { h.rush = true; } },
  };

  const r1 = n => Math.round(n * 10) / 10;
  const r3 = n => Math.round(n * 1000) / 1000;

  class Game {
    constructor(players, opts = {}) {
      this.target  = opts.target || TARGET;
      this.science = !!opts.science; // sandbox: no timers, no scoring, power-ups are free toggles
      this.players = players.map((p, i) => ({ id: p.id, name: p.name, color: i, points: 0 }));
      this.events  = [];
      this.time    = 0;
      this.nextId  = 1;
      this.blocks  = [];
      this.glues   = [];
      this.pendingGlue = [];
      this.pendingBounce = [];
      this.flexLinks = [];
      this.stepHit = 0;          // hardest collision this tick, for sound
      this.lastHit = -Infinity;
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
      if (this.science) {
        // Keep the last setup so an experiment can be repeated; blocks are always the standard size.
        this.hover = this.hover ? { ...this.hover } : { x: WORLD_W / 2, angle: 0, base: BASE_SIZE, scale: 1, len: 1,
          sizeMod: null, glue: false, magnet: false, sponge: false, bouncy: false, flex: false, rush: false };
        return;
      }
      const base = BASE_SIZE * (0.85 + Math.random() * 0.3);
      this.hover = { x: WORLD_W / 2, angle: 0, base, scale: 1, len: 1, sizeMod: null,
                     glue: false, magnet: false, sponge: false, bouncy: false, flex: false, rush: false };
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
      if (this.science) { this.toggle(item); this.aim(pid, this.hover.x); return; }
      const p = this.active, h = this.hover, it = SHOP[item];
      if (p.points < it.cost || !it.ok(h)) return;
      p.points -= it.cost;
      it.apply(h);
      this.aim(pid, h.x); // re-clamp in case the block grew
      this.events.push({ type: 'buy', player: pid, item });
    }

    // Science mode: power-ups switch on and off for free. Long steps ×2, ×4… then back to ×1.
    toggle(item) {
      const h = this.hover, it = SHOP[item];
      if (item === 'rush') return;
      if (item === 'small' || item === 'big') {
        const was = h.sizeMod;
        h.sizeMod = null; h.scale = 1;
        if (was !== item && it.ok(h)) it.apply(h);
      } else if (item === 'long') {
        if (it.ok(h)) it.apply(h); else h.len = 1;
      } else if (h[item]) h[item] = false;
      else if (it.ok(h)) it.apply(h);
    }

    // Science mode: grab a block with a springy tether and drag it around. slop widens the target for fingers.
    grab(pid, x, y, slop = 0) {
      if (!this.science || !this.canAct(pid)) return false;
      this.release(pid);
      const p = { x, y }, loose = this.blocks.filter(b => !b.fallen);
      let body = Query.point(loose, p)[0];
      if (!body) {
        let best = Infinity;
        for (const b of loose) {
          const d = Vector.magnitude(Vector.sub(b.position, p)) - Math.max(b.w, b.h) / 2;
          if (d < slop && d < best) { best = d; body = b; }
        }
      }
      if (!body) return false;
      this.grabbed = Constraint.create({
        pointA: p, bodyB: body, pointB: Vector.sub(p, body.position), length: 0, stiffness: 0.2, damping: 0.1,
      });
      Composite.add(this.engine.world, this.grabbed);
      return true;
    }

    move(pid, x, y) {
      if (this.grabbed && this.canAct(pid)) this.grabbed.pointA = { x, y };
    }

    release() {
      if (!this.grabbed) return;
      Composite.remove(this.engine.world, this.grabbed);
      this.grabbed = null;
    }

    clear(pid) {
      if (!this.science || !this.canAct(pid)) return;
      const world = this.engine.world;
      this.release();
      for (const c of [...this.glues, ...this.flexLinks]) Composite.remove(world, c);
      for (const b of this.blocks) Composite.remove(world, b);
      this.glues = [];
      this.flexLinks = [];
      this.blocks = [];
      this.pendingGlue.length = 0;
      this.pendingBounce.length = 0;
    }

    drop(pid) {
      if (!this.canAct(pid)) return;
      const h = this.hover, w = blockW(h), ht = blockH(h), y = this.hoverY();
      const physics = { friction: h.sponge ? SLICK : 0.7, frictionStatic: 1, restitution: 0.02, density: 0.0015 };
      // group ties together the bodies of one block (a flexible block has several).
      const props = {
        group: this.nextId, color: this.active.color, glue: h.glue, magnet: h.magnet, sponge: h.sponge, slick: h.sponge,
        bouncy: h.bouncy, bounced: false, flex: h.flex, bonds: 0, fallen: false,
      };
      if (h.flex) this.addFlexible(h.x, y, w, ht, h.angle, physics, props);
      else {
        const body = Bodies.rectangle(h.x, y, w, ht, { ...physics, angle: h.angle, chamfer: { radius: ht * 0.12 } });
        Object.assign(body, props, { gid: this.nextId++, w, h: ht });
        Composite.add(this.engine.world, body);
        this.blocks.push(body);
      }
      this.rush = h.rush;
      this.events.push({ type: 'drop', player: pid });
      if (this.science) { this.startTurn(this.turn); return; } // no waiting: the next block is ready at once
      this.phase = 'settle';
      this.phaseStart = this.time;
      this.calm = 0;
    }

    // Slices side by side, each joined to the next by springs near its top and bottom edges.
    addFlexible(x, y, w, ht, angle, physics, props) {
      const world = this.engine.world, n = flexSegments(w), sw = w / n;
      const filter = { group: Body.nextGroup(true) }; // a block's own slices don't collide with each other
      const rot = (px, py) => Vector.rotate({ x: px, y: py }, angle);
      const segs = [];
      for (let i = 0; i < n; i++) {
        const c = rot((i + 0.5) * sw - w / 2, 0);
        const seg = Bodies.rectangle(x + c.x, y + c.y, sw, ht, {
          ...physics, angle, collisionFilter: filter, chamfer: { radius: Math.min(sw, ht) * 0.2 },
        });
        Object.assign(seg, props, { gid: this.nextId++, w: sw, h: ht });
        segs.push(seg);
      }
      Composite.add(world, segs);
      this.blocks.push(...segs);
      const inset = ht * 0.4;
      for (let i = 1; i < n; i++) {
        for (const dy of [-inset, inset]) {
          const c = Constraint.create({
            bodyA: segs[i - 1], bodyB: segs[i], pointA: rot(sw / 2, dy), pointB: rot(-sw / 2, dy),
            length: 0, stiffness: FLEX_STIFF, damping: 0.08,
          });
          Composite.add(world, c);
          this.flexLinks.push(c);
        }
      }
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
      this.applyBounces();
      if (this.stepHit > HIT_MIN && this.time - this.lastHit > HIT_GAP) {
        this.events.push({ type: 'hit', v: r1(this.stepHit) });
        this.lastHit = this.time;
      }
      this.stepHit = 0;
      this.checkFalls();

      if (!this.science && this.phase === 'aim' && this.time - this.phaseStart > AIM_TIME) this.drop(this.active.id);

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
        const n = pair.collision.normal;
        this.stepHit = Math.max(this.stepHit, Math.abs((a.velocity.x - b.velocity.x) * n.x + (a.velocity.y - b.velocity.y) * n.y));
        // The sponge soaks whatever loose block it touches (but not the platform, and soaked blocks don't spread it).
        for (const [sp, o] of [[a, b], [b, a]]) {
          if (sp.sponge && !o.isStatic && !o.slick) { o.slick = true; o.friction = SLICK; this.events.push({ type: 'soak' }); }
        }
        // Bounces are applied after the solver runs, which would otherwise soak them up.
        // Velocities are recorded now, before the solver changes them, to measure how hard they hit.
        if (a.bouncy || b.bouncy) {
          this.pendingBounce.push({ a, b, n: { x: n.x, y: n.y }, va: { ...a.velocity }, vb: { ...b.velocity } });
        }
        // Queue bonds; adding constraints mid-update is asking for trouble.
        if (!a.glue && !b.glue) continue;
        const points = pair.collision.supports.filter(Boolean).slice(0, 2).map(p => ({ x: p.x, y: p.y }));
        if (points.length) this.pendingGlue.push({ a, b, points });
      }
    }

    // A bouncy block hops once on its first landing; after that, it flings off whatever hits it.
    applyBounces() {
      for (const { a, b, n, va, vb } of this.pendingBounce) {
        const landed = new Map([[a, a.bounced], [b, b.bounced]]); // state before this contact
        for (const [x, y, vx, vy] of [[a, b, va, vb], [b, a, vb, va]]) {
          if (x.isStatic || x.fallen) continue;
          let k;
          if (x.bouncy && !landed.get(x)) k = BOUNCE_SELF;
          else if (y.bouncy && landed.get(y)) k = BOUNCE_FLING;
          else continue;
          // Unit normal pointing from y toward x, and how fast they were closing along it.
          let nx = n.x, ny = n.y;
          if ((x.position.x - y.position.x) * nx + (x.position.y - y.position.y) * ny < 0) { nx = -nx; ny = -ny; }
          const hit = -((vx.x - vy.x) * nx + (vx.y - vy.y) * ny);
          if (x.bouncy) x.bounced = true; // a gentle first touch still counts as landing, just without the hop
          if (hit < BOUNCE_MIN) continue;
          const speed = Math.min(BOUNCE_MAX, hit * k);
          const v = x.velocity, along = v.x * nx + v.y * ny;
          Body.setVelocity(x, { x: v.x + (speed - along) * nx, y: v.y + (speed - along) * ny });
          this.events.push({ type: 'bounce', x: r1(x.position.x), y: r1(x.position.y) });
        }
      }
      this.pendingBounce.length = 0;
    }

    applyGlue() {
      const world = this.engine.world;
      for (const { a, b, points } of this.pendingGlue) {
        const sticky = a.glue ? a : b;
        if (a.fallen || b.fallen || sticky.bonds >= GLUE_BONDS) continue;
        if (this.glues.some(c => (c.bodyA === a && c.bodyB === b) || (c.bodyA === b && c.bodyB === a))) continue;
        sticky.bonds++;
        this.events.push({ type: 'stick' });
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

    // A block falls when its middle drops below the platform top; a flexible block counts once, not per slice.
    checkFalls() {
      const world = this.engine.world;
      const groups = new Map();
      for (const b of this.blocks) {
        if (!groups.has(b.group)) groups.set(b.group, []);
        groups.get(b.group).push(b);
      }
      const gone = new Set();
      for (const parts of groups.values()) {
        const cx = parts.reduce((t, b) => t + b.position.x, 0) / parts.length;
        const cy = parts.reduce((t, b) => t + b.position.y, 0) / parts.length;
        if (!parts[0].fallen && cy > FALL_Y) {
          for (const b of parts) b.fallen = true;
          const by = this.active ? this.active.id : null;
          const to = [];
          if (this.phase !== 'over' && !this.science) {
            for (const p of this.players) if (p.id !== by) { p.points++; to.push(p.id); }
          }
          this.events.push({ type: 'fall', x: r1(cx), y: r1(cy), by, to });
        }
        if (cy > KILL_Y || Math.abs(cx - PLATFORM.x) > 1200) for (const b of parts) gone.add(b);
      }
      if (!gone.size) return;
      for (const b of gone) Composite.remove(world, b);
      const keep = c => {
        if (!gone.has(c.bodyA) && !gone.has(c.bodyB)) return true;
        Composite.remove(world, c);
        return false;
      };
      this.glues = this.glues.filter(keep);
      this.flexLinks = this.flexLinks.filter(keep);
      if (this.grabbed && gone.has(this.grabbed.bodyB)) this.release();
      this.blocks = this.blocks.filter(b => !gone.has(b));
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
        science: this.science,
        timeLeft: this.phase === 'aim' && !this.science ? Math.max(0, Math.round(AIM_TIME - (this.time - this.phaseStart))) : null,
        players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, points: p.points })),
        hover: this.phase === 'aim' ? {
          ...h, x: r1(h.x), angle: r3(h.angle), y: r1(this.hoverY()),
          w: r1(blockW(h)), h: r1(blockH(h)), halfX: r1(this.halfX()), halfY: r1(this.halfY()), c: this.active.color,
        } : null,
        blocks: this.blocks.map(b => [b.gid, r1(b.position.x), r1(b.position.y), r3(b.angle), r1(b.w), r1(b.h), b.color,
          (b.glue ? 1 : 0) | (b.magnet ? 2 : 0) | (b.fallen ? 4 : 0) | (b.sponge ? 8 : 0) | (b.slick ? 16 : 0) | (b.bouncy ? 32 : 0) | (b.flex ? 64 : 0), b.group]),
        grab: this.grabbed ? (() => {
          const c = this.grabbed, p = Vector.add(c.bodyB.position, c.pointB);
          return [r1(c.pointA.x), r1(c.pointA.y), r1(p.x), r1(p.y)];
        })() : null,
        glue: this.glues.filter(c => !c.strut).map(c => {
          const p = Vector.add(c.bodyA.position, c.pointA);
          return [r1(p.x), r1(p.y)];
        }),
      };
    }
  }

  return { Game, SHOP, WORLD_W, PLATFORM, TICK, flexSegments };
});
