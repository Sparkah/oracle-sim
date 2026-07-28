// Top-down arena renderer. Owns movement and effects; does NOT own the outcome.
//
// The bots drive at each other under simple steering. Every time they make contact the
// renderer pops the next event off the pre-computed timeline and plays it. So the fight
// looks emergent while following a script the model already committed to.

import * as A from './audio.js';
import { weaponOf } from './sim.js';

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

export class Arena {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.parts = [];
    this.debris = [];
    this.shake = 0;
    this.timeScale = 1;
    this.raf = null;
    this.bout = null;
    this.flash = 0;
    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    if (!this.raf) this._idle();   // _resize may already have started it - never run two
  }

  _resize() {
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(320, r.width), h = Math.max(220, r.height);
    this.cv.width = Math.round(w * this.dpr);
    this.cv.height = Math.round(h * this.dpr);
    this.W = w; this.H = h;
    if (!this.raf) this._idle();
  }

  destroy() {
    window.removeEventListener('resize', this._resize);
    if (this.raf) cancelAnimationFrame(this.raf);
    A.stopWhine();
  }

  // ---------------------------------------------------------------- public

  play(bout, { onEvent, onDone, onTick } = {}) {
    this.stop();
    const pad = 90;
    // Corner colour, not the bot's roster colour. The HP bar, the picker labels and the
    // machine on the floor all have to agree, otherwise a flipper with a blue roster colour
    // shows up blue in the arena while its health bar is red.
    const CORNER = { 1: '#e8503a', '-1': '#3da9fc' };
    const mk = (bot, x, dir) => ({
      bot, corner: CORNER[dir], x, y: this.H / 2, vx: 0, vy: 0,
      ang: dir > 0 ? 0 : Math.PI,
      dir, hp: 100, spin: 0, wep: 0, hurt: 0, dead: false,
      retreat: 0,
      // scale with the arena so the bots read at projector distance instead of becoming
      // two specks in the middle of a wide canvas
      r: Math.max(30, Math.min(46, Math.min(this.W, this.H) * 0.105)),
    });
    this.bout = bout;
    this.A = mk(bout.a, pad, 1);
    this.B = mk(bout.b, this.W - pad, -1);
    this.byId = { [bout.a.id]: this.A, [bout.b.id]: this.B };
    this.queue = bout.events.filter((e) => e.type !== 'start').slice();
    this.onEvent = onEvent; this.onDone = onDone; this.onTick = onTick;
    this.parts = []; this.debris = []; this.shake = 0; this.flash = 0;
    this.timeScale = 1;
    this.done = false;
    this.clock = 0;
    this.contactCd = 0.55;
    // pace the whole bout into roughly twenty seconds regardless of exchange count
    this.gap = clamp(19 / Math.max(1, this.queue.length), 1.0, 2.4);
    this.finishHold = 0;

    A.unlock();
    A.startWhine(160 + (bout.a.name.length + bout.b.name.length) * 4);

    this.last = performance.now();
    const loop = (now) => {
      const dtRaw = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      this._step(dtRaw * this.timeScale, dtRaw);
      this._draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop() {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    A.stopWhine();
  }

  // idle attract state before the first fight
  _idle() {
    const loop = () => {
      this.t = (this.t || 0) + 0.016;
      const c = this.ctx;
      this._frame();
      c.save();
      c.scale(this.dpr, this.dpr);
      c.fillStyle = 'rgba(255,255,255,0.30)';
      c.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      c.textAlign = 'center';
      c.fillText('SELECT TWO BOTS AND RUN THE FIGHT', this.W / 2, this.H / 2 + 4);
      c.restore();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- sim step

  _step(dt, dtRaw) {
    this.clock += dt;
    this.shake = Math.max(0, this.shake - dtRaw * 34);
    this.flash = Math.max(0, this.flash - dtRaw * 3.4);
    this.timeScale = lerp(this.timeScale, 1, dtRaw * 1.6);

    for (const p of this.parts) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt;
      p.vy += 240 * dt * (p.grav || 0); p.vx *= 0.985; p.vy *= 0.985;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const d of this.debris) { d.life -= dt * 0.25; d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 0.9; d.vy *= 0.9; }
    this.debris = this.debris.filter((d) => d.life > 0);

    const A1 = this.A, B1 = this.B;
    A1.spin += dt * (A1.dead ? 1 : 26);
    B1.spin += dt * (B1.dead ? 1 : 26);
    A1.hurt = Math.max(0, A1.hurt - dtRaw * 2.6);
    B1.hurt = Math.max(0, B1.hurt - dtRaw * 2.6);
    A1.wep = Math.max(0, A1.wep - dtRaw * 2.2);
    B1.wep = Math.max(0, B1.wep - dtRaw * 2.2);

    this.contactCd -= dt;

    if (this.done) {
      this.finishHold += dt;
      this._drive(A1, B1, dt, true);
      this._drive(B1, A1, dt, true);
      if (this.finishHold > 2.4 && this.onDone) { const f = this.onDone; this.onDone = null; f(); }
      return;
    }

    this._drive(A1, B1, dt, false);
    this._drive(B1, A1, dt, false);

    const dx = B1.x - A1.x, dy = B1.y - A1.y;
    const dist = Math.hypot(dx, dy);
    if (dist < A1.r + B1.r + 8 && this.contactCd <= 0 && this.queue.length) {
      this._resolveNext(dist, dx, dy);
    }
    if (this.onTick) this.onTick(A1.hp, B1.hp);
  }

  _drive(me, foe, dt, idle) {
    if (me.dead) { me.vx *= 0.9; me.vy *= 0.9; me.x += me.vx * dt; me.y += me.vy * dt; return; }
    me.retreat = Math.max(0, me.retreat - dt);
    const dx = foe.x - me.x, dy = foe.y - me.y;
    const d = Math.hypot(dx, dy) || 1;
    // back off after a hit, then charge again. Two bots grinding together in the middle of
    // the floor is what it looked like before, and it reads as a bug rather than a fight.
    const want = idle ? this.W * 0.3 : (me.retreat > 0 ? this.W * 0.34 : 30);
    const push = d > want ? 1 : -0.9;
    const spd = idle ? 130 : (me.retreat > 0 ? 300 : 340);
    me.vx += (dx / d) * push * spd * dt * 3.2;
    me.vy += (dy / d) * push * spd * dt * 3.2;
    // orbit component so the passes come in at varying angles
    const orbit = me.retreat > 0 ? 130 : 60;
    me.vx += (-dy / d) * orbit * dt * me.dir * 3.2;
    me.vy += (dx / d) * orbit * dt * me.dir * 3.2;

    // Weak spring toward the middle. The orbit term makes the pair's centre of mass wander,
    // and without this they end up grinding along the bottom rail with the action half out
    // of frame. Stronger vertically because there is far less room on that axis.
    me.vx += (this.W / 2 - me.x) * 0.5 * dt * 3.2;
    me.vy += (this.H / 2 - me.y) * 1.1 * dt * 3.2;

    me.vx *= 0.92; me.vy *= 0.92;
    me.x += me.vx * dt; me.y += me.vy * dt;

    // vertical margin leaves room for the name plate, which sits outside the chassis
    const mx = me.r + 18, my = me.r + 34;
    if (me.x < mx) { me.x = mx; me.vx = Math.abs(me.vx) * 0.5; }
    if (me.x > this.W - mx) { me.x = this.W - mx; me.vx = -Math.abs(me.vx) * 0.5; }
    if (me.y < my) { me.y = my; me.vy = Math.abs(me.vy) * 0.5; }
    if (me.y > this.H - my) { me.y = this.H - my; me.vy = -Math.abs(me.vy) * 0.5; }

    const tgt = Math.atan2(dy, dx);
    let da = ((tgt - me.ang + Math.PI * 3) % TAU) - Math.PI;
    me.ang += da * clamp(dt * 5.5, 0, 1);
  }

  _resolveNext(dist, dx, dy) {
    const e = this.queue.shift();
    this.contactCd = this.gap;

    const att = e.actor ? this.byId[e.actor] : null;
    const def = e.target ? this.byId[e.target] : null;

    // both bots disengage after every exchange so the next one reads as a fresh pass
    const backoff = this.gap * 0.42;
    this.A.retreat = backoff; this.B.retreat = backoff;

    if (e.type === 'miss') {
      if (att) att.wep = 1;
      this.contactCd = this.gap * 0.55;
      // shove apart so the next approach reads as a fresh pass
      this._separate(120);
      if (this.onEvent) this.onEvent(e);
      A.blip(420);
      return;
    }

    if (att) att.wep = 1;
    if (def) {
      def.hurt = 1;
      if (typeof e.hpA === 'number') { this.A.hp = e.hpA; this.B.hp = e.hpB; }
    }

    const big = e.type === 'bighit' || e.type === 'oota' || e.type === 'ko';
    const power = e.type === 'oota' ? 1.55 : big ? 1.25 : 0.8;

    if (def) {
      const nx = (def.x - (att ? att.x : def.x)), ny = (def.y - (att ? att.y : def.y));
      const n = Math.hypot(nx, ny) || 1;
      const kb = e.type === 'oota' ? 1000 : big ? 520 : 300;
      def.vx += (nx / n) * kb; def.vy += (ny / n) * kb;
      if (att) { att.vx -= (nx / n) * kb * 0.28; att.vy -= (ny / n) * kb * 0.28; }
      this._sparks(def.x - (nx / n) * 18, def.y - (ny / n) * 18, big ? 26 : 14, att ? att.corner : '#fff');
      if (big) this._shed(def, 3);
    }

    this.shake = big ? 16 : 8;
    this.flash = big ? 0.5 : 0.22;
    A.impact(power);
    if (big) this.timeScale = 0.35;

    if (e.type === 'ko' || e.type === 'oota') {
      if (def) { def.dead = true; def.hp = 0; }
      this.done = true;
      A.stopWhine();
      A.koSting();
      this.timeScale = 0.3;
      this._shed(def, 10);
    }
    if (e.type === 'decision') {
      this.done = true;
      A.stopWhine();
      A.blip(760);
    }
    if (e.type === 'immobile' && def) { def.spinDamaged = true; }

    if (this.onEvent) this.onEvent(e);
  }

  _separate(force) {
    const dx = this.B.x - this.A.x, dy = this.B.y - this.A.y;
    const d = Math.hypot(dx, dy) || 1;
    this.A.vx -= (dx / d) * force; this.A.vy -= (dy / d) * force;
    this.B.vx += (dx / d) * force; this.B.vy += (dy / d) * force;
  }

  _sparks(x, y, n, color) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = 60 + Math.random() * 320;
      this.parts.push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0.25 + Math.random() * 0.45, max: 0.7, grav: 0.35,
        color: Math.random() < 0.65 ? '#ffd27a' : color, w: 1 + Math.random() * 1.6,
      });
    }
  }

  _shed(bot, n) {
    if (!bot) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, s = 30 + Math.random() * 130;
      this.debris.push({
        x: bot.x, y: bot.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 1, size: 2 + Math.random() * 3.5, rot: Math.random() * TAU, color: bot.corner,
      });
    }
  }

  // ---------------------------------------------------------------- draw

  _frame() {
    const c = this.ctx;
    c.save();
    c.scale(this.dpr, this.dpr);
    const g = c.createLinearGradient(0, 0, 0, this.H);
    g.addColorStop(0, '#12151c'); g.addColorStop(1, '#0a0c11');
    c.fillStyle = g; c.fillRect(0, 0, this.W, this.H);

    // floor plate grid
    c.strokeStyle = 'rgba(255,255,255,0.045)'; c.lineWidth = 1;
    for (let x = 0; x < this.W; x += 46) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, this.H); c.stroke(); }
    for (let y = 0; y < this.H; y += 46) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(this.W, y + 0.5); c.stroke(); }

    // hazard border
    const m = 26;
    c.save();
    c.beginPath(); c.rect(m, m, this.W - m * 2, this.H - m * 2); c.clip();
    c.restore();
    c.lineWidth = 10;
    c.strokeStyle = 'rgba(255,190,40,0.16)';
    c.setLineDash([16, 12]);
    c.strokeRect(m, m, this.W - m * 2, this.H - m * 2);
    c.setLineDash([]);
    c.strokeStyle = 'rgba(255,255,255,0.10)'; c.lineWidth = 2;
    c.strokeRect(m, m, this.W - m * 2, this.H - m * 2);
    c.restore();
  }

  _draw() {
    const c = this.ctx;
    this._frame();
    c.save();
    c.scale(this.dpr, this.dpr);
    if (this.shake > 0.2) {
      c.translate((Math.random() - 0.5) * this.shake, (Math.random() - 0.5) * this.shake);
    }

    for (const d of this.debris) {
      c.save(); c.globalAlpha = clamp(d.life, 0, 1) * 0.8;
      c.translate(d.x, d.y); c.rotate(d.rot);
      c.fillStyle = d.color; c.fillRect(-d.size / 2, -d.size / 2, d.size, d.size);
      c.restore();
    }

    if (this.A) this._bot(c, this.A, this.B);
    if (this.B) this._bot(c, this.B, this.A);

    for (const p of this.parts) {
      c.globalAlpha = clamp(p.life / p.max, 0, 1);
      c.strokeStyle = p.color; c.lineWidth = p.w;
      c.beginPath(); c.moveTo(p.x, p.y);
      c.lineTo(p.x - p.vx * 0.016, p.y - p.vy * 0.016);
      c.stroke();
    }
    c.globalAlpha = 1;

    if (this.flash > 0.01) {
      c.fillStyle = `rgba(255,240,200,${this.flash * 0.30})`;
      c.fillRect(-40, -40, this.W + 80, this.H + 80);
    }
    c.restore();
  }

  _bot(c, b, foe) {
    const col = b.corner;
    const wep = weaponOf(b.bot);
    c.save();
    c.translate(b.x, b.y);

    // shadow
    c.save();
    c.globalAlpha = 0.34; c.fillStyle = '#000';
    c.beginPath(); c.ellipse(2, 7, b.r * 1.05, b.r * 0.62, 0, 0, TAU); c.fill();
    c.restore();

    c.rotate(b.ang);

    // chassis - silhouette is per-bot, fill stays the corner colour so red/blue always reads
    const st = styleOf(b.bot);
    const hurt = b.hurt;
    c.fillStyle = hurt > 0.05 ? mix(col, '#ffffff', hurt * 0.6) : col;
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 2;
    chassisPath(c, b.r, st.chassis);
    c.fill(); c.stroke();

    // livery in the bot's own colour, clipped to the hull
    c.save();
    chassisPath(c, b.r, st.chassis); c.clip();
    c.fillStyle = st.accent; c.globalAlpha = 0.55;
    if (st.stripe === 1) c.fillRect(-b.r, -b.r * 0.16, b.r * 2, b.r * 0.32);
    else if (st.stripe === 2) {
      for (let i = -1; i < 3; i++) {
        c.beginPath();
        c.moveTo(-b.r * 0.9 + i * b.r * 0.45, -b.r);
        c.lineTo(-b.r * 0.62 + i * b.r * 0.45, -b.r);
        c.lineTo(-b.r * 0.9 + i * b.r * 0.45, b.r);
        c.lineTo(-b.r * 1.18 + i * b.r * 0.45, b.r);
        c.closePath(); c.fill();
      }
    }
    c.restore();

    // treads
    c.fillStyle = 'rgba(10,10,12,0.85)';
    c.fillRect(-b.r * 0.85, -b.r * 0.92, b.r * 1.1, b.r * 0.3);
    c.fillRect(-b.r * 0.85, b.r * 0.62, b.r * 1.1, b.r * 0.3);

    // weapon
    c.save();
    if (wep === 'hspinner') {
      c.rotate(b.spin);
      c.fillStyle = '#c9ced8';
      c.beginPath(); c.arc(0, 0, b.r * 0.86, 0, TAU); c.fill();
      c.fillStyle = '#8b929e';
      for (let i = 0; i < st.blades; i++) {
        c.save(); c.rotate((i / st.blades) * TAU);
        c.beginPath(); c.moveTo(b.r * 0.5, -5); c.lineTo(b.r * 1.15, 0); c.lineTo(b.r * 0.5, 5); c.closePath(); c.fill();
        c.restore();
      }
      c.fillStyle = '#1b1e25'; c.beginPath(); c.arc(0, 0, b.r * 0.3, 0, TAU); c.fill();
    } else if (wep === 'vspinner') {
      const s = Math.abs(Math.cos(b.spin));
      const len = b.r * 0.78 * st.drum;
      const drums = st.twin ? [-len * 0.55, len * 0.55] : [0];
      const half = st.twin ? len * 0.48 : len;
      for (const off of drums) {
        c.save();
        c.translate(b.r * 0.72, off);
        c.fillStyle = '#c9ced8';
        c.beginPath(); c.ellipse(0, 0, 6 + s * 3, half, 0, 0, TAU); c.fill();
        c.fillStyle = '#7d838f';
        c.fillRect(-3, -half, 6, half * 2 * (0.35 + s * 0.65));
        c.restore();
      }
    } else if (wep === 'flipper') {
      const lift = b.wep;
      c.fillStyle = '#b9c0cc';
      c.beginPath();
      c.moveTo(b.r * 0.15, -b.r * 0.62);
      c.lineTo(b.r * (1.05 + lift * 0.25), -b.r * (0.30 - lift * 0.18));
      c.lineTo(b.r * (1.05 + lift * 0.25), b.r * (0.30 - lift * 0.18));
      c.lineTo(b.r * 0.15, b.r * 0.62);
      c.closePath(); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.stroke();
    } else if (wep === 'crusher') {
      const open = 0.25 + b.wep * 0.75;
      c.strokeStyle = '#b9c0cc'; c.lineWidth = 7; c.lineCap = 'round';
      c.beginPath(); c.moveTo(b.r * 0.35, 0); c.lineTo(b.r * 1.18, -b.r * 0.62 * open); c.stroke();
      c.beginPath(); c.moveTo(b.r * 0.35, 0); c.lineTo(b.r * 1.18, b.r * 0.62 * open); c.stroke();
    } else if (wep === 'hammer') {
      const sw = b.wep;
      c.rotate(-0.9 + sw * 1.7);
      c.strokeStyle = '#9aa1ad'; c.lineWidth = 6; c.lineCap = 'round';
      c.beginPath(); c.moveTo(0, 0); c.lineTo(b.r * 1.25, 0); c.stroke();
      c.fillStyle = '#c9ced8';
      c.fillRect(b.r * 1.05, -8, 14, 16);
    } else {
      c.fillStyle = '#b9c0cc';
      c.fillRect(b.r * 0.5, -b.r * 0.5, 10, b.r);
    }
    c.restore();
    c.restore();

    // Name plate, unrotated. Placed on the side facing AWAY from the opponent, so it can
    // never land on top of the other machine however the two of them are oriented. A fixed
    // above/below rule looks fine until they stack vertically and the labels swap sides.
    c.save();
    c.translate(b.x, b.y);
    let ox = 0, oy = b.dir > 0 ? -b.r - 13 : b.r + 21;
    if (foe) {
      const ax = b.x - foe.x, ay = b.y - foe.y;
      const an = Math.hypot(ax, ay);
      if (an > 6) {
        const off = b.r + 24;
        ox = (ax / an) * off;
        oy = (ay / an) * off + 4;
      }
    }
    c.font = '700 12px ui-monospace, SFMono-Regular, Menlo, monospace';
    c.textAlign = 'center';
    const label = b.bot.name.toUpperCase();
    const tw = c.measureText(label).width;
    // keep the whole plate inside the canvas
    const tx = clamp(ox, -b.x + tw / 2 + 10, this.W - b.x - tw / 2 - 10);
    const ty = clamp(oy, -b.y + 16, this.H - b.y - 8);
    c.translate(tx, 0);
    c.fillStyle = 'rgba(8,10,14,0.78)';
    c.beginPath();
    const rr = 4, bx = -tw / 2 - 6, by = ty - 11, bw = tw + 12, bh = 15;
    c.moveTo(bx + rr, by); c.arcTo(bx + bw, by, bx + bw, by + bh, rr);
    c.arcTo(bx + bw, by + bh, bx, by + bh, rr); c.arcTo(bx, by + bh, bx, by, rr);
    c.arcTo(bx, by, bx + bw, by, rr); c.closePath(); c.fill();
    c.fillStyle = b.dead ? 'rgba(255,255,255,0.4)' : b.corner;
    c.fillText(label, 0, ty);
    c.restore();
  }
}


// Per-machine visual identity.
//
// Eighteen of the twenty-four bots in this league are vertical spinners, so classifying the
// silhouette by weapon alone makes most of the roster look like the same robot. That is a
// real problem for a picker: selecting a different bot has to LOOK like selecting a
// different bot. Everything here is derived deterministically from the bot id, so a given
// machine always renders identically without any of it being stored or invented as data.
function hashId(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function styleOf(bot) {
  const h = hashId(bot.id || bot.name || 'x');
  return {
    chassis: h % 4,                       // wedge | box | hex | dart
    blades: 2 + ((h >> 3) % 3),           // horizontal spinner blade count
    twin: ((h >> 6) & 1) === 1,           // twin drums on a vertical spinner
    drum: 0.82 + ((h >> 8) % 5) * 0.07,   // drum length
    stripe: (h >> 11) % 3,                // none | centre stripe | chevrons
    accent: bot.color || '#c9ced8',
  };
}

// Chassis outlines, all sized off r so they stay comparable in mass.
function chassisPath(c, r, kind) {
  c.beginPath();
  if (kind === 1) {            // boxy brick
    c.moveTo(r * 0.85, -r * 0.7); c.lineTo(r * 0.85, r * 0.7);
    c.lineTo(-r * 0.9, r * 0.7); c.lineTo(-r * 0.9, -r * 0.7);
  } else if (kind === 2) {     // hex
    c.moveTo(r * 0.95, 0); c.lineTo(r * 0.4, r * 0.75); c.lineTo(-r * 0.55, r * 0.75);
    c.lineTo(-r * 0.95, 0); c.lineTo(-r * 0.55, -r * 0.75); c.lineTo(r * 0.4, -r * 0.75);
  } else if (kind === 3) {     // dart
    c.moveTo(r * 1.05, 0); c.lineTo(-r * 0.25, r * 0.8); c.lineTo(-r * 0.85, r * 0.35);
    c.lineTo(-r * 0.85, -r * 0.35); c.lineTo(-r * 0.25, -r * 0.8);
  } else {                     // classic wedge
    c.moveTo(r * 0.95, 0); c.lineTo(r * 0.2, r * 0.78); c.lineTo(-r * 0.9, r * 0.62);
    c.lineTo(-r * 0.9, -r * 0.62); c.lineTo(r * 0.2, -r * 0.78);
  }
  c.closePath();
}

function mix(a, b, t) {
  const pa = hex(a), pb = hex(b);
  return `rgb(${Math.round(lerp(pa[0], pb[0], t))},${Math.round(lerp(pa[1], pb[1], t))},${Math.round(lerp(pa[2], pb[2], t))})`;
}
function hex(h) {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map((c) => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
