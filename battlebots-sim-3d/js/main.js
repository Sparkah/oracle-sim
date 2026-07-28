// Wiring for the 3D arena.
//
// The fight logic is NOT here and is not reimplemented anywhere in this folder. The model
// and the bout generator are imported straight out of ../battlebots-sim, so a bout watched
// in 3D is byte-for-byte the same timeline the 2D arena plays: same seed, same winner, same
// exchanges, same damage. This file only picks the fighters, hands the bout to the renderer
// and mirrors it into the HUD.

import { train, CLASS_LABEL } from '../../battlebots-sim/js/model.js';
import { simulate, groundedLines, fmtClock } from '../../battlebots-sim/js/sim.js';
import { Arena3D } from './arena3d.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let BOTS = [], FIGHTS = [], MODEL = null, ARENA = null, AUDIO = null, RUNNING = false;

// Sound is optional and lives in the sibling folder, which another session may be editing.
// A broken import there must not be able to take the arena down with it, hence the guard.
async function loadAudio() {
  try {
    AUDIO = await import('../../battlebots-sim/js/audio.js');
  } catch { AUDIO = null; }
}
const snd = (fn, ...a) => { try { AUDIO && AUDIO[fn] && AUDIO[fn](...a); } catch { /* silent */ } };

// ---------------------------------------------------------------- boot

async function boot() {
  await loadAudio();

  let bj, fj;
  try {
    [bj, fj] = await Promise.all([
      fetch('../battlebots-sim/data/bots.json').then((r) => r.json()),
      fetch('../battlebots-sim/data/fights.json').then((r) => r.json()),
    ]);
  } catch {
    $('loadText').textContent = 'could not read ../battlebots-sim/data - serve over http, not file://';
    return;
  }

  BOTS = bj.bots || [];
  FIGHTS = (fj.fights || []).filter((f) => BOTS.some((b) => b.id === f.a) && BOTS.some((b) => b.id === f.b));
  MODEL = train(BOTS, FIGHTS);

  const meta = bj._meta || {};
  const badge = $('srcBadge');
  if (meta.source && meta.source !== 'synthetic') {
    badge.textContent = `LIVE - ${meta.n || BOTS.length} bots, ${FIGHTS.length} fights`;
    badge.classList.add('live');
  } else {
    badge.textContent = `SYNTHETIC DEMO DATA - ${BOTS.length} bots`;
  }
  badge.title = meta.sourceLabel || '';

  fillPickers();

  ARENA = new Arena3D($('gl'));
  try {
    await ARENA.load((p) => { $('loadText').textContent = `loading mechs ${Math.round(p * 100)}%`; });
  } catch {
    $('loadText').textContent = 'mech models failed to load - check assets/models/';
    return;
  }

  $('loadMask').classList.add('gone');
  setTimeout(() => { $('loadMask').hidden = true; }, 450);
  const btn = $('runBtn');
  btn.disabled = false;
  btn.textContent = 'RUN FIGHT';
}

// ---------------------------------------------------------------- picker

function fillPickers() {
  const sorted = BOTS.slice().sort((x, y) => MODEL.rating[y.id] - MODEL.rating[x.id]);
  for (const sel of [$('selA'), $('selB')]) {
    sel.innerHTML = '';
    for (const b of sorted) {
      const o = el('option', null, `${b.name}  -  ${CLASS_LABEL[MODEL.weapon[b.id]] || 'Control'}`);
      o.value = b.id;
      sel.appendChild(o);
    }
  }
  $('selA').value = sorted[0].id;
  $('selB').value = sorted[1].id;
  $('selA').addEventListener('change', onPick);
  $('selB').addEventListener('change', onPick);
  $('swapBtn').addEventListener('click', () => {
    const a = $('selA').value;
    $('selA').value = $('selB').value;
    $('selB').value = a;
    onPick();
  });
  onPick();
}

const botById = (id) => BOTS.find((b) => b.id === id);

function onPick() {
  // never let the same machine fight itself
  if ($('selA').value === $('selB').value) {
    const alt = BOTS.find((b) => b.id !== $('selA').value);
    $('selB').value = alt.id;
  }
  const a = botById($('selA').value), b = botById($('selB').value);
  const pred = MODEL.predict(a.id, b.id);

  $('oddsFill').style.width = (pred.p * 100).toFixed(1) + '%';
  $('oddsA').textContent = Math.round(pred.p * 100) + '%';
  $('oddsB').textContent = Math.round((1 - pred.p) * 100) + '%';

  $('metaA').innerHTML = metaLine(a);
  $('metaB').innerHTML = metaLine(b);
}

function metaLine(bot) {
  const r = MODEL.records[bot.id];
  const w = CLASS_LABEL[MODEL.weapon[bot.id]] || 'Control';
  return `<b>${r.w}-${r.l}</b> this season &middot; ${r.ko} KO<br>${w} &middot; ${bot.weightLb} lb`;
}

// ---------------------------------------------------------------- run

function say(text, cls) {
  const feed = $('feed');
  feed.appendChild(el('li', cls, text));
  feed.scrollTop = feed.scrollHeight;
}

function run() {
  if (RUNNING || !ARENA) return;
  RUNNING = true;

  const a = botById($('selA').value), b = botById($('selB').value);
  const bout = simulate({ a, b, model: MODEL });
  const ground = groundedLines(bout, MODEL);
  let groundIdx = 0;

  $('feed').innerHTML = '';
  say(bout.events[0].text, 'end');

  $('card').hidden = true;
  $('hud').hidden = false;
  $('hpNameA').textContent = a.name.toUpperCase();
  $('hpNameB').textContent = b.name.toUpperCase();
  setHp('A', 100); setHp('B', 100);
  $('clock').textContent = '0:00';

  const btn = $('runBtn');
  btn.disabled = true;
  btn.textContent = 'FIGHTING…';
  $('selA').disabled = $('selB').disabled = $('swapBtn').disabled = true;

  snd('unlock');
  snd('startWhine', 160 + (a.name.length + b.name.length) * 4);

  ARENA.play(bout, {
    onEvent(ev) {
      const cls = ev.type === 'bighit' || ev.type === 'oota' ? 'big'
        : ev.type === 'miss' ? '' : 'hit';
      say(ev.text, cls);
      if (ev.type === 'bighit' || ev.type === 'oota') snd('impact', 1.6);
      else if (ev.type === 'hit') snd('impact', 0.9);
      else if (ev.type === 'miss') snd('blip', 520);
      // drip a scraped fact between exchanges, never more than we actually have
      if (groundIdx < ground.length && (ev.type === 'hit' || ev.type === 'bighit') && Math.random() < 0.55) {
        say(ground[groundIdx++], 'ground');
      }
    },
    onTick({ sec, hpA, hpB }) {
      $('clock').textContent = fmtClock(sec);
      setHp('A', hpA); setHp('B', hpB);
    },
    onDone(done) {
      snd('stopWhine');
      snd('koSting');
      finish(done);
    },
  });
}

function setHp(side, v) {
  const n = Math.max(0, Math.round(v));
  $('hpBar' + side).style.width = n + '%';
  $('hpVal' + side).textContent = n;
}

function finish(bout) {
  // the closing line already arrived through onEvent - promote it rather than saying it twice
  const lastLi = $('feed').lastElementChild;
  if (lastLi) lastLi.className = 'end';

  setHp('A', bout.finalHp[bout.a.id]);
  setHp('B', bout.finalHp[bout.b.id]);
  $('clock').textContent = fmtClock(bout.seconds);

  const favoured = bout.p >= 0.5 ? bout.a : bout.b;
  const conf = Math.round(Math.max(bout.p, 1 - bout.p) * 100);
  const called = favoured.id === bout.winner.id;

  $('cardWin').textContent = bout.winner.name.toUpperCase();
  $('cardWin').style.color = bout.winner.id === bout.a.id ? 'var(--red)' : 'var(--blue)';
  $('cardMethod').textContent = bout.method === 'KO'
    ? `KO · ${fmtClock(bout.seconds)}` : 'JUDGES’ DECISION';
  const call = $('cardCall');
  call.textContent = called
    ? `Model called it at ${conf}% confidence.`
    : `Model had ${favoured.name} at ${conf}%. It missed this one.`;
  call.className = 'cardcall ' + (called ? 'good' : 'bad');

  setTimeout(() => {
    const c = $('card');
    c.hidden = false;
    // unhiding does not replay a CSS animation - reflow it so the second bout pops too
    c.style.animation = 'none'; void c.offsetWidth; c.style.animation = '';
  }, 700);

  RUNNING = false;
  const btn = $('runBtn');
  btn.disabled = false;
  btn.textContent = 'RUN FIGHT';
  $('selA').disabled = $('selB').disabled = $('swapBtn').disabled = false;
}

// ---------------------------------------------------------------- events

$('runBtn').addEventListener('click', run);
$('againBtn').addEventListener('click', () => { $('card').hidden = true; run(); });
$('muteBtn').addEventListener('click', () => {
  const m = AUDIO && AUDIO.toggleMute ? AUDIO.toggleMute() : true;
  $('muteBtn').textContent = m ? 'SOUND OFF' : 'SOUND ON';
});
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !RUNNING && !$('runBtn').disabled) { e.preventDefault(); run(); }
});

boot();
