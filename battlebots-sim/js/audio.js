// Minimal procedural audio. Web Audio only - no <audio> element and no new Audio(), which
// on some platforms hands playback to the OS media player and looks like a media app.
// Everything is synthesised, so there are no asset files and nothing to licence.

let ctx = null;
let master = null;
let muted = false;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0.28;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlock() { ac(); }
export function isMuted() { return muted; }
export function setMuted(v) {
  muted = !!v;
  if (master) master.gain.value = muted ? 0 : 0.28;
  return muted;
}
export function toggleMute() { return setMuted(!muted); }

function noiseBuffer(c, dur) {
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  return buf;
}

// metal-on-metal: filtered noise burst plus a low thud
export function impact(strength = 1) {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, 0.18 + 0.1 * strength);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1800 + Math.random() * 1600;
  bp.Q.value = 0.8;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.55 * strength, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22 + 0.12 * strength);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t); src.stop(t + 0.4);

  const o = c.createOscillator();
  const og = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(120 * strength, t);
  o.frequency.exponentialRampToValueAtTime(38, t + 0.25);
  og.gain.setValueAtTime(0.5 * strength, t);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
  o.connect(og); og.connect(master);
  o.start(t); o.stop(t + 0.32);
}

// continuous spinner whine, pitched per bot, started on fight and stopped at the end
let whine = null;
export function startWhine(freq = 190) {
  const c = ac(); if (!c) return;
  stopWhine();
  const o = c.createOscillator(), o2 = c.createOscillator(), g = c.createGain();
  o.type = 'sawtooth'; o.frequency.value = freq;
  o2.type = 'square'; o2.frequency.value = freq * 1.995;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  g.gain.setValueAtTime(0.0001, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.06, c.currentTime + 0.7);
  o.connect(lp); o2.connect(lp); lp.connect(g); g.connect(master);
  o.start(); o2.start();
  whine = { o, o2, g };
}
export function stopWhine() {
  if (!whine || !ctx) return;
  const t = ctx.currentTime;
  try {
    whine.g.gain.cancelScheduledValues(t);
    whine.g.gain.setValueAtTime(Math.max(0.0001, whine.g.gain.value), t);
    whine.g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    whine.o.stop(t + 0.35); whine.o2.stop(t + 0.35);
  } catch (_) { /* already stopped */ }
  whine = null;
}

export function koSting() {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime;
  [0, 0.11, 0.22].forEach((d, i) => {
    const o = c.createOscillator(), g = c.createGain();
    o.type = 'square';
    o.frequency.setValueAtTime([180, 240, 300][i], t + d);
    g.gain.setValueAtTime(0.0001, t + d);
    g.gain.exponentialRampToValueAtTime(0.3, t + d + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.3);
    o.connect(g); g.connect(master);
    o.start(t + d); o.stop(t + d + 0.34);
  });
}

export function blip(freq = 660) {
  const c = ac(); if (!c || muted) return;
  const t = c.currentTime;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'triangle'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  o.connect(g); g.connect(master);
  o.start(t); o.stop(t + 0.14);
}

// pause everything when the tab is hidden
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) ctx.suspend(); else ctx.resume();
});
