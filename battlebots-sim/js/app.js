import { train, backtest, deriveMatchup, CLASSES, CLASS_LABEL, FEATURE_NAMES } from './model.js';
import { simulate, groundedLines, fmtClock, weaponOf } from './sim.js';
import { Arena } from './render.js';
import * as A from './audio.js';
import { offeredOdds, impliedProb, settle, VIG } from './betting.js';

const $ = (id) => document.getElementById(id);
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

let BOTS = [], FIGHTS = [], MODEL = null, ARENA = null, BT = null, running = false;
let byId = {};

// ---------------------------------------------------------------- boot

async function boot() {
  const problems = [];
  let botDoc, fightDoc;
  try {
    [botDoc, fightDoc] = await Promise.all([
      fetch('data/bots.json').then((r) => r.json()),
      fetch('data/fights.json').then((r) => r.json()),
    ]);
  } catch (e) {
    $('provenance').className = 'pill pill-bad';
    $('provenance').textContent = 'DATA LOAD FAILED';
    $('feed').append(el('li', 'end', 'Could not load data/bots.json or data/fights.json. Serve this folder over http, not file://'));
    return;
  }

  BOTS = botDoc.bots || [];
  byId = Object.fromEntries(BOTS.map((b) => [b.id, b]));

  // integrity: drop fights that reference unknown bots rather than letting them poison
  // the records silently
  const raw = fightDoc.fights || [];
  const orphans = raw.filter((f) => !byId[f.a] || !byId[f.b]);
  const badWinner = raw.filter((f) => byId[f.a] && byId[f.b] && f.winner !== f.a && f.winner !== f.b);
  FIGHTS = raw.filter((f) => byId[f.a] && byId[f.b] && (f.winner === f.a || f.winner === f.b));

  if (orphans.length) problems.push(['bad', `${orphans.length} fight(s) reference a bot id not in bots.json - dropped`]);
  if (badWinner.length) problems.push(['bad', `${badWinner.length} fight(s) have a winner that is neither competitor - dropped`]);
  const unclassed = BOTS.filter((b) => !CLASSES.includes(b.weapon));
  if (unclassed.length) problems.push(['warn', `${unclassed.length} bot(s) have an unrecognised weapon class - excluded from the matchup grid`]);
  const noFights = BOTS.filter((b) => !FIGHTS.some((f) => f.a === b.id || f.b === b.id));
  if (noFights.length) problems.push(['warn', `${noFights.length} bot(s) have no fights - predictions for them are prior-only`]);
  if (FIGHTS.length < 20) problems.push(['warn', `only ${FIGHTS.length} fights - the back-test number will be very noisy`]);

  MODEL = train(BOTS, FIGHTS);
  provenance(botDoc._meta, fightDoc._meta);
  renderChecks(problems, botDoc._meta, fightDoc._meta);
  fetch('data/polymarket.json').then((r) => r.json()).then((pm) => renderLineage(botDoc._meta, pm._meta)).catch(() => renderLineage(botDoc._meta, null));
  renderMeta();
  renderChatter();
  buildPickers();

  ARENA = new Arena($('arena'));
  wire();

  fetch('data/polymarket.json').then((r) => r.json())
    .then((pm) => { POLY_LIVE = pm.live || []; refresh(); })
    .catch(() => { POLY_LIVE = []; });
  renderGeo();
  renderPoly();

  // back-test is ~60 model refits; keep it off the critical path
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 60));
  idle(() => { BT = backtest(BOTS, FIGHTS); renderBacktest(); });
}

function provenance(bm, fm) {
  const p = $('provenance');
  const synthetic = !bm || bm.source === 'synthetic';
  if (synthetic) {
    p.className = 'pill pill-warn';
    p.textContent = 'SYNTHETIC DEMO DATA';
    p.title = 'Not scraped. Replace data/*.json with real scraped output before showing numbers as real.';
  } else {
    p.className = 'pill pill-live';
    p.textContent = `LIVE - ${(bm.sourceLabel || bm.source).toUpperCase()}`;
    p.title = `Fetched ${bm.fetchedAt || 'unknown'}`;
  }
}

// ---------------------------------------------------------------- pickers

function buildPickers() {
  const ranked = [...BOTS].sort((a, b) => MODEL.rating[b.id] - MODEL.rating[a.id]);
  for (const sel of [$('selA'), $('selB')]) {
    sel.innerHTML = '';
    for (const b of ranked) {
      const r = MODEL.records[b.id];
      sel.append(new Option(`${b.name}  (${r.w}-${r.l}, ${CLASS_LABEL[weaponOf(b)]})`, b.id));
    }
  }
  $('selA').value = ranked[0].id;
  $('selB').value = ranked[Math.min(3, ranked.length - 1)].id;
  refresh();
}

function statLine(bot) {
  const r = MODEL.records[bot.id];
  const bits = [
    `${r.w}-${r.l}`,
    `${r.ko} KO`,
    r.avgWinSec ? `avg win ${fmtClock(r.avgWinSec)}` : 'no wins',
  ];
  if (bot.chatter) bits.push(`${bot.chatter.mentions} mentions`);
  return bits.join('  ·  ');
}

// ---------------------------------------------------------------- prediction layers
//
// Everything composes in LOG-ODDS, not in probability. Adding probabilities would let two
// layers push past 1.0 and would break the antisymmetry the whole model is built on; adding
// log-odds keeps P(A>B) + P(B>A) === 1 exactly however many layers are stacked.
//
// The base layer is the fitted model and cannot be switched off - there is nothing to layer
// onto without it.

const logit = (p) => Math.log(Math.max(1e-9, p) / Math.max(1e-9, 1 - p));
const sig = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

// X buzz as a signal. Scraped reach, not a claim that reach predicts anything - the weight is
// deliberately small and the layer is OFF by default, so nobody can accuse the headline
// number of quietly containing it.
const BUZZ_W = 0.45;

// Live prediction-market layer.
//
// It queries the markets actually fetched from Polymarket's Gamma API and looks for one
// covering this matchup. There isn't one - there is no BattleBots market on Polymarket - so
// in practice this layer reports that and contributes nothing.
//
// It deliberately does NOT fall back to the `proposed` list. Those are our own model's prices
// written in Polymarket's format; folding them back in as an independent signal would be the
// model confirming itself, which is exactly the circularity that killed the old house book.
// An empty layer that says so is worth more than a full one that lies.
let POLY_LIVE = [];
function polyMarketFor(a, b) {
  const hit = POLY_LIVE.find((m) => {
    const q = (m.question || '').toLowerCase();
    return q.includes(a.name.toLowerCase()) && q.includes(b.name.toLowerCase());
  });
  return hit || null;
}
function polyDelta(a, b) {
  const m = polyMarketFor(a, b);
  if (!m) return { d: 0, label: 'no market for this matchup' };
  // A real market price replaces our prior outright rather than nudging it - if someone has
  // staked money on this fight, that is better information than a 23-fight fit.
  return { d: logit(m.impliedYes) - logit(MODEL.predict(a.id, b.id).p), label: `market ${(m.impliedYes * 100).toFixed(0)}%` };
}
function buzzDelta(a, b) {
  const reach = (x) => (x.chatter ? Math.log1p(x.chatter.views || 0) + Math.log1p((x.chatter.mentions || 0) * 50) : 0);
  const d = reach(a) - reach(b);
  if (!d) return 0;
  // Squash so a viral post cannot dominate the fitted model.
  return BUZZ_W * Math.tanh(d / 12);
}

function layeredP(a, b) {
  const base = MODEL.predict(a.id, b.id).p;
  let z = logit(base);
  const parts = [];
  if ($('lyBuzz').checked) { const d = buzzDelta(a, b); z += d; parts.push(`buzz ${d >= 0 ? '+' : ''}${d.toFixed(2)}`); }
  if ($('lyPoly').checked) { const r = polyDelta(a, b); z += r.d; parts.push(`polymarket ${r.d ? (r.d >= 0 ? '+' : '') + r.d.toFixed(2) : '0.00'}`); }
  if ($('lyUser').checked) {
    const d = (Number($('lyUserVal').value) || 0) / 100 * 1.5;
    z += d; parts.push(`your call ${d >= 0 ? '+' : ''}${d.toFixed(2)}`);
  }
  return { base, p: sig(z), parts };
}

function refresh() {
  const a = byId[$('selA').value], b = byId[$('selB').value];
  $('statA').textContent = a ? statLine(a) : '';
  $('statB').textContent = b ? statLine(b) : '';
  $('hpNameA').textContent = a ? a.name : '-';
  $('hpNameB').textContent = b ? b.name : '-';
  if (!a || !b || a.id === b.id) {
    $('pbFill').style.width = '50%';
    $('pbA').textContent = '50%'; $('pbB').textContent = '50%';
    $('fight').disabled = a && b && a.id === b.id;
    $('predcap').textContent = a && b && a.id === b.id
      ? 'Pick two different bots.'
      : 'Model prediction before the bout.';
    return;
  }
  $('fight').disabled = running;
  const { base, p, parts } = layeredP(a, b);
  $('pbFill').style.width = pct(p, 1);
  $('pbA').textContent = pct(p);
  $('pbB').textContent = pct(1 - p);
  $('predcap').innerHTML = explain(a, b);
  $('lyUserVal').disabled = !$('lyUser').checked;
  const bz = (a.chatter || b.chatter) ? `${a.chatter ? a.chatter.mentions : 0} vs ${b.chatter ? b.chatter.mentions : 0} mentions` : 'no X mentions for either';
  $('lyBuzzSub').textContent = bz;
  const pm = polyMarketFor(a, b);
  $('lyPolySub').textContent = pm ? `market ${(pm.impliedYes * 100).toFixed(0)}%` : 'no market exists';
  $('lyPoly').disabled = !pm;
  $('lyPoly').closest('.ly').title = pm ? 'Live Polymarket price for this matchup.'
    : 'No BattleBots market exists on Polymarket, so this layer has nothing real to contribute. It will not substitute our own prices.';
  $('lyOut').textContent = parts.length ? `base ${pct(base)} -> ${pct(p)}  (${parts.join(', ')})` : `base only, ${pct(base)}`;
  renderBook();
}

// Show which features drove the call. This is the answer to "is this just a random number".
function explain(a, b) {
  const { contrib } = MODEL.predict(a.id, b.id);
  const parts = FEATURE_NAMES
    .map((n, i) => ({ n, v: contrib[i] }))
    .filter((x) => Math.abs(x.v) > 0.04)
    .sort((x, y) => Math.abs(y.v) - Math.abs(x.v))
    .slice(0, 3)
    .map((x) => `${x.v > 0 ? a.name : b.name} on ${x.n}`);
  if (!parts.length) return 'Too close to call from the season data - the features cancel out.';
  return `Driven by: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------- origins

async function renderGeo() {
  let doc;
  try { doc = await fetch('data/geography.json').then((r) => r.json()); }
  catch { $('geoMeta').textContent = 'data/geography.json not found - run node scrape/geography.mjs'; return; }
  const m = doc._meta || {};
  $('geoMeta').textContent = `${m.known} of ${m.total} competitors located - ${m.sourceLabel} (${m.requests} extra requests)`;

  const regions = Object.entries(doc.byRegion || {});
  const max = Math.max(1, ...regions.map(([, v]) => v.length));
  const wrap = $('geoBars'); wrap.innerHTML = '';
  for (const [region, names] of regions) {
    const row = el('div', 'geobar');
    row.append(el('div', 'gb-l', region));
    const t = el('div', 'gb-t'); t.style.width = `${(names.length / max) * 100}%`;
    t.title = names.join(', ');
    row.append(t);
    row.append(el('div', 'gb-n', String(names.length)));
    wrap.append(row);
  }

  const t = $('geoTable');
  t.innerHTML = '<thead><tr><th>BOT</th><th>FROM</th><th>TEAM</th></tr></thead>';
  const tb = el('tbody');
  for (const b of doc.bots || []) {
    const tr = el('tr');
    tr.append(el('td', null, b.name));
    const o = b.origin;
    tr.append(el('td', null, o && o.city ? `${o.city}, ${o.region}` : (o && o.region) || '-'));
    tr.append(el('td', null, b.team || '-'));
    tb.append(tr);
  }
  t.append(tb);
}

// ---------------------------------------------------------------- polymarket
//
// Two lists, kept visually and verbally distinct on purpose. The live ones are real traded
// prices; the proposed ones are our model in their format. Blurring those two would be
// exactly the kind of quiet overclaim this whole app is built to avoid.

async function renderPoly() {
  let doc;
  try { doc = await fetch('data/polymarket.json').then((r) => r.json()); }
  catch { $('polyMeta').textContent = 'data/polymarket.json not found - run node scrape/polymarket.mjs'; return; }

  const m = doc._meta || {};
  $('polyMeta').textContent = `${(m.sourceLabel || 'polymarket')} - fetched ${(m.fetchedAt || '').slice(0, 16).replace('T', ' ')}`;

  const money = (n) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${Math.round(n)}`);

  // No live list any more. The only open Polymarket markets are Fed decisions and 2028
  // primaries - real, but nothing to do with robot combat, and a page of them next to a fight
  // forecast is noise. State the absence instead, because the absence is the actual finding.
  $('polyNone').textContent =
    `There is no BattleBots market on Polymarket - searched battlebots, robot and robot combat against `
    + `their public Gamma API, and the only robot markets are Figure and Tesla Optimus ones. `
    + `So this is the listing that does not exist yet, priced by the model.`;

  const propWrap = $('polyProp');
  propWrap.innerHTML = '';
  for (const k of (doc.proposed || []).slice(0, 12)) {
    const row = el('div', 'mkt prop');
    row.append(el('div', 'mkt-q', k.question));
    row.append(el('div', 'mkt-p', `${(k.modelProb * 100).toFixed(0)}%`));
    row.append(el('div', 'mkt-v', `${k.oddsYes.toFixed(2)} / ${k.oddsNo.toFixed(2)}`));
    propWrap.append(row);
  }
}

// ---------------------------------------------------------------- the book
//
// The house prices off the record-only baseline, which is the same comparison the back-test
// makes. That is deliberate: betting into the model's own fair odds is zero-EV whatever the
// model is worth, so the only way a wager means anything is to price it off something else
// and let the model's disagreement be the edge.

const LB_KEY = 'plo.players';

// Persistent player table. Keyed by lowercased name so "Tim" and "tim" are one person.
const loadPlayers = () => { try { return JSON.parse(localStorage.getItem(LB_KEY)) || {}; } catch { return {}; } };
const savePlayers = (p) => localStorage.setItem(LB_KEY, JSON.stringify(p));
let PLAYERS = loadPlayers();

// `create` defaults to false on purpose. renderBook runs on every keystroke, so creating on
// lookup enrols "T", "Ti" and "Tim" as three separate players before anyone has played a
// single fight. Only the act of starting a match enrols anybody.
function getPlayer(name, create = false) {
  const key = (name || '').trim().toLowerCase();
  if (!key) return null;
  if (!PLAYERS[key]) {
    if (!create) return null;
    PLAYERS[key] = { name: name.trim(), bank: 1000, w: 0, l: 0 };
  }
  return PLAYERS[key];
}

let openMatch = null;   // { A, B, ante, aId, bId }

// The model's forecast, shown to BOTH players. It is information, not a counterparty - the
// bout is drawn from this same probability, so a house pricing off it would be settling bets
// against its own coin. Two humans facing one forecast is a fair game; that is the fix.
const housePrice = (a, b) => {
  const r = MODEL.records;
  return r[a.id].winRate / Math.max(1e-9, r[a.id].winRate + r[b.id].winRate);
};

function renderLeaderboard() {
  const t = $('lbTable');
  t.innerHTML = '';
  const rows = Object.values(PLAYERS).sort((x, y) => y.bank - x.bank).slice(0, 8);
  if (!rows.length) {
    // append() returns undefined, so chaining off it throws and takes the whole panel down.
    const tr = el('tr');
    tr.append(el('td', '', 'No players yet.'));
    t.append(tr);
    return;
  }
  rows.forEach((p, i) => {
    const tr = el('tr', i === 0 ? 'lead' : '');
    tr.append(el('td', '', `${i + 1}. ${p.name}`));
    tr.append(el('td', '', `${p.w}-${p.l}`));
    tr.append(el('td', '', String(Math.round(p.bank))));
    t.append(tr);
  });
}

function renderBook() {
  const a = byId[$('selA').value], b = byId[$('selB').value];
  const ok = a && b && a.id !== b.id;
  for (const id of ['oddsA', 'oddsB']) $(id).disabled = !ok || running;
  $('stake').disabled = !ok || running;
  if (!ok) { $('oNameA').textContent = $('oNameB').textContent = '-'; $('oPriceA').textContent = $('oPriceB').textContent = '-'; return; }

  const pb = housePrice(a, b);
  const { p } = MODEL.predict(a.id, b.id);
  $('oNameA').textContent = a.name; $('oNameB').textContent = b.name;
  $('oPriceA').textContent = `${(p * 100).toFixed(0)}%`;
  $('oPriceB').textContent = `${((1 - p) * 100).toFixed(0)}%`;
  $('oEdgeA').textContent = `record price ${(pb * 100).toFixed(0)}%`;
  $('oEdgeB').textContent = `record price ${((1 - pb) * 100).toFixed(0)}%`;

  const pa = getPlayer($('pnameA').value), pbl = getPlayer($('pnameB').value);
  $('obankA').textContent = pa ? Math.round(pa.bank) : '1000';
  $('obankB').textContent = pbl ? Math.round(pbl.bank) : '1000';
  $('pot').textContent = openMatch ? Math.round(openMatch.ante * 2) : 0;
  renderLeaderboard();
}

function settleBet(bout) {
  if (!openMatch) return;
  const m = openMatch;
  const redWon = (bout.winner.id || bout.winner) === m.aId;
  const win = redWon ? m.A : m.B, lose = redWon ? m.B : m.A;
  win.bank += m.ante * 2; win.w++; lose.l++;
  savePlayers(PLAYERS);
  const note = $('bookNote');
  note.className = 'book-note win';
  note.textContent = `${win.name} takes the ${Math.round(m.ante * 2)} pot. ${win.name} ${Math.round(win.bank)}, ${lose.name} ${Math.round(lose.bank)}.`;
  openMatch = null;
  renderBook();
}

// ---------------------------------------------------------------- fight

function runFight() {
  if (running) return;
  const a = byId[$('selA').value], b = byId[$('selB').value];
  if (!a || !b || a.id === b.id) return;
  running = true;
  $('fight').disabled = true;
  $('rand').disabled = true;
  $('result').hidden = true;
  $('feed').innerHTML = '';
  $('hpFillA').style.width = '100%'; $('hpFillB').style.width = '100%';
  $('hpValA').textContent = '100'; $('hpValB').textContent = '100';
  $('clock').textContent = '0:00';

  // Both players ante into a pot before anything is simulated. Neither can see the outcome
  // and both are looking at the same forecast, so the deterministic bout is fair to both.
  const ante = Math.max(0, Math.round(Number($('stake').value) || 0));
  const A = getPlayer($('pnameA').value, true), B = getPlayer($('pnameB').value, true);
  if (A && B && ante > 0 && A.bank >= ante && B.bank >= ante) {
    A.bank -= ante; B.bank -= ante;
    openMatch = { A, B, ante, aId: a.id, bId: b.id };
    $('bookNote').className = 'book-note';
    $('bookNote').textContent = `${A.name} on ${a.name} vs ${B.name} on ${b.name} - ${ante * 2} in the pot.`;
  } else {
    openMatch = null;
    if (A && B && ante > 0) { $('bookNote').className = 'book-note lose'; $('bookNote').textContent = 'One of you cannot cover that ante.'; }
  }
  renderBook();

  // The bout is generated from the LAYERED probability, so the fight can never contradict the
  // bar directly above it. A 70% favourite losing on screen while the bar still reads 70% is
  // read as broken, not as variance.
  const lp = layeredP(a, b).p;
  const layeredModel = Object.assign(Object.create(Object.getPrototypeOf(MODEL) || Object.prototype), MODEL, {
    predict: (x, y) => (x === a.id && y === b.id)
      ? { ...MODEL.predict(x, y), p: lp }
      : MODEL.predict(x, y),
  });
  const bout = simulate({ a, b, model: layeredModel });
  const ground = groundedLines(bout, MODEL);
  let groundIdx = 0;
  let shown = 0;

  pushFeed(bout.events[0].text, 'ground');

  ARENA.play(bout, {
    onEvent: (e) => {
      const cls = e.type === 'ko' || e.type === 'decision' || e.type === 'oota' ? 'end'
        : (e.type === 'bighit' ? 'big' : '');
      pushFeed(e.text, cls);
      if (typeof e.hpA === 'number') setHp(bout, e.hpA, e.hpB);
      $('clock').textContent = fmtClock(e.t);
      // drip in a scraped fact every few exchanges so the commentary stays grounded
      if (++shown % 3 === 0 && groundIdx < ground.length) pushFeed(ground[groundIdx++], 'ground');
    },
    onDone: () => {
      running = false;
      $('fight').disabled = false;
      $('rand').disabled = false;
      showResult(bout);
      settleBet(bout);
      refresh();
    },
  });
}

function setHp(bout, hpA, hpB) {
  const aIsRed = true;
  $('hpFillA').style.width = Math.max(0, hpA) + '%';
  $('hpFillB').style.width = Math.max(0, hpB) + '%';
  $('hpValA').textContent = Math.round(Math.max(0, hpA));
  $('hpValB').textContent = Math.round(Math.max(0, hpB));
}

function showResult(bout) {
  const r = $('result');
  const called = (bout.p >= 0.5 ? bout.a.id : bout.b.id) === bout.winner.id;
  const conf = Math.max(bout.p, 1 - bout.p);
  r.hidden = false;
  r.innerHTML = '';
  r.append(el('b', null, `${bout.winner.name.toUpperCase()} WINS BY ${bout.method === 'KO' ? 'KNOCKOUT' : 'DECISION'}`));
  r.append(el('span', null,
    called
      ? `Model had it at ${pct(conf)} and called it right. ${fmtClock(bout.seconds)}.`
      : `Model favoured ${(bout.p >= 0.5 ? bout.a : bout.b).name} at ${pct(conf)} and got it wrong - that happens about ${pct(1 - conf)} of the time by its own estimate. ${fmtClock(bout.seconds)}.`));
}

function pushFeed(text, cls) {
  const li = el('li', cls || '', text);
  $('feed').prepend(li);
  while ($('feed').children.length > 14) $('feed').lastChild.remove();
}

// ---------------------------------------------------------------- backtest view

function renderBacktest() {
  if (!BT) return;
  $('kAcc').textContent = pct(BT.accuracy, 1);
  $('kAccSub').textContent = `${Math.round(BT.accuracy * BT.n)} of ${BT.n} fights`;
  $('kBase').textContent = pct(BT.baseline, 1);
  const lift = (BT.accuracy - BT.baseline) * 100;
  $('kLift').textContent = (lift >= 0 ? '+' : '') + lift.toFixed(1) + ' pts';
  // colour by whether the paired test actually supports it, not by whether it is positive -
  // a green number next to a p of 1.00 would be the dashboard telling a small lie
  $('kLift').style.color = BT.mcnemar.p < 0.05 ? 'var(--green)' : 'var(--amber)';
  $('kLiftSub').textContent = `${Math.abs(Math.round(lift * BT.n / 100))} fight(s) of difference`;
  $('kBrier').textContent = BT.brier.toFixed(3);

  const mc = BT.mcnemar;
  $('kMc').textContent = mc.p >= 0.999 ? '1.00' : mc.p.toFixed(3);
  $('kMc').style.color = mc.p < 0.05 ? 'var(--green)' : 'var(--amber)';
  $('kMcSub').textContent = `${mc.b} vs ${mc.c} discordant fights`;

  // The honest reading, not the flattering one. The lift looks like a win until you notice
  // the two systems are scored on the same fights and almost never actually disagree.
  const swing = (1.96 * Math.sqrt(BT.accuracy * (1 - BT.accuracy) / BT.n) * 100).toFixed(1);
  $('btNote').innerHTML =
    `<b>The lift is not what it looks like - read this before quoting it.</b> Model and baseline are scored on ` +
    `the same ${BT.n} fights, so the comparison is <em>paired</em> and the right test is McNemar, not two ` +
    `separate confidence intervals. They disagree on only ${mc.b + mc.c} fight(s) ` +
    `(${mc.b} to the model, ${mc.c} to the baseline), exact two-sided p = ${mc.p >= 0.999 ? '1.00' : mc.p.toFixed(3)}. ` +
    `<b>There is no evidence here that the model forecasts better than backing the better record.</b> ` +
    `The measured gap comes almost entirely from the ${mc.ties} fight(s) where both bots hold identical records: ` +
    `the baseline cannot call those at all and scores 0.5 on each, while the model went ${mc.tieWins}-${mc.ties - mc.tieWins}. ` +
    `That is a real capability difference - it is decisive where the record is uninformative - but it is not a ` +
    `claim to be a better predictor. For scale, the 95% interval on ${pct(BT.accuracy, 1)} alone is about plus or ` +
    `minus ${swing} points. Hyperparameters were not tuned against this score (<code>tools/sweep.mjs</code> runs the ` +
    `grid; the spread is inside the noise), and heavy regularisation collapses the model onto the baseline exactly, ` +
    `because it degenerates into "back the better record".`;

  const cal = $('calib');
  cal.innerHTML = '';
  for (const b of BT.bins) {
    const row = el('div', 'cal-row');
    row.append(el('span', 'lab', `${Math.round(b.lo * 100)}-${Math.round(Math.min(1, b.hi) * 100)}%`));
    const bar = el('div', 'cal-bar');
    const fill = el('i'); fill.style.width = b.actual == null ? '0%' : pct(b.actual, 0);
    bar.append(fill);
    if (b.claimed != null) { const tick = el('u'); tick.style.left = pct(b.claimed, 0); bar.append(tick); }
    bar.title = b.n ? `claimed ${pct(b.claimed, 1)}, actual ${pct(b.actual, 1)} over ${b.n} fights` : 'no fights in this band';
    row.append(bar);
    row.append(el('span', 'n', b.n ? `n=${b.n}` : '-'));
    cal.append(row);
  }

  const t = $('btTable');
  t.innerHTML = '<thead><tr><th>MATCHUP</th><th>MODEL SAID</th><th>ACTUAL</th><th>CONF</th></tr></thead>';
  const tb = el('tbody');
  for (const r of BT.rows) {
    const f = r.fight;
    const favId = r.p >= 0.5 ? f.a : f.b;
    const tr = el('tr', r.correct ? 'hit' : 'miss');
    tr.append(el('td', null, `${byId[f.a].name} v ${byId[f.b].name}`));
    tr.append(el('td', null, byId[favId].name));
    const act = el('td');
    act.append(el('span', 'tag', f.method));
    act.append(document.createTextNode(' ' + byId[f.winner].name));
    tr.append(act);
    tr.append(el('td', 'num', pct(r.conf)));
    tb.append(tr);
  }
  t.append(tb);
}

// ---------------------------------------------------------------- meta view

function renderMeta() {
  const heat = $('heat');
  heat.style.gridTemplateColumns = `minmax(84px,auto) repeat(${CLASSES.length},minmax(58px,1fr))`;
  heat.innerHTML = '';
  heat.append(el('div', 'hh', ''));
  for (const c of CLASSES) heat.append(el('div', 'hh', short(c)));
  for (const x of CLASSES) {
    heat.append(el('div', 'rh', short(x)));
    for (const y of CLASSES) {
      const d = el('div');
      if (x === y) {
        d.textContent = '-'; d.style.background = '#161a23'; d.style.color = 'var(--dim2)';
      } else {
        const rate = MODEL.matchup.rate[x][y];
        const n = MODEL.matchup.n[x][y];
        const k = (rate - 0.5) * 2;
        d.style.background = k >= 0
          ? `rgba(232,80,58,${0.10 + Math.abs(k) * 0.72})`
          : `rgba(61,169,252,${0.10 + Math.abs(k) * 0.72})`;
        d.textContent = pct(rate);
        d.style.color = Math.abs(k) > 0.28 ? '#fff' : 'var(--dim)';
        const w = MODEL.matchup.rawWins[x][y];
        d.title = `${CLASS_LABEL[x]} vs ${CLASS_LABEL[y]}: ${w}-${n - w} raw over ${n} meetings, shown shrunk toward 50%`;
      }
      heat.append(d);
    }
  }

  const t = $('rankTable');
  t.innerHTML = '<thead><tr><th>#</th><th>BOT</th><th>WEAPON</th><th>REC</th><th>RATING</th></tr></thead>';
  const tb = el('tbody');
  [...BOTS].sort((a, b) => MODEL.rating[b.id] - MODEL.rating[a.id]).forEach((b, i) => {
    const r = MODEL.records[b.id];
    const tr = el('tr');
    tr.append(el('td', 'num', String(i + 1)));
    const nm = el('td');
    const dot = el('span'); dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:7px;background:${b.color}`;
    nm.append(dot, document.createTextNode(b.name));
    tr.append(nm);
    tr.append(el('td', null, short(weaponOf(b))));
    tr.append(el('td', 'num', `${r.w}-${r.l}`));
    tr.append(el('td', 'num', pct(MODEL.rating[b.id], 1)));
    tb.append(tr);
  });
  t.append(tb);

  const w = $('weights');
  w.innerHTML = '';
  const max = Math.max(...MODEL.weights.map((v) => Math.abs(v)), 0.001);
  FEATURE_NAMES.forEach((n, i) => {
    const v = MODEL.weights[i];
    const row = el('div', 'wrow');
    row.append(el('span', 'lab', n));
    const tr = el('div', 'wtrack');
    const bar = el('i', v < 0 ? 'neg' : '');
    const frac = Math.abs(v) / max * 50;
    bar.style.left = v >= 0 ? '50%' : (50 - frac) + '%';
    bar.style.width = frac + '%';
    tr.append(bar, el('u'));
    row.append(tr);
    row.append(el('span', 'v', (v >= 0 ? '+' : '') + v.toFixed(3)));
    w.append(row);
  });
}

const short = (c) => ({ vspinner: 'vert spin', hspinner: 'horiz spin', flipper: 'flipper', crusher: 'crusher', hammer: 'hammer', control: 'control' }[c] || c);

// ---------------------------------------------------------------- data view

function renderChecks(problems, bm, fm) {
  const ul = $('checks');
  ul.innerHTML = '';
  const ok = [
    `${BOTS.length} bots and ${FIGHTS.length} fights loaded`,
    `every fight references two known bots`,
    `every fight has a winner that competed in it`,
  ];
  if (!problems.some((p) => p[0] === 'bad')) for (const t of ok) ul.append(el('li', '', t));
  for (const [kind, msg] of problems) ul.append(el('li', kind, msg));

  const kv = $('dataMeta');
  kv.innerHTML = '';
  const rows = [
    ['source', (bm && bm.sourceLabel) || (bm && bm.source) || 'unknown'],
    ['fetched', (bm && bm.fetchedAt) || 'unknown'],
    ['season', (fm && fm.season) || '-'],
    ['bots', String(BOTS.length)],
    ['fights', String(FIGHTS.length)],
    ['fights per bot', (FIGHTS.length * 2 / Math.max(1, BOTS.length)).toFixed(1)],
    ['weapon classes', String(new Set(BOTS.map((b) => weaponOf(b))).size)],
    ['KO rate', pct(FIGHTS.filter((f) => f.method === 'KO').length / Math.max(1, FIGHTS.length), 1)],
  ];
  for (const [k, v] of rows) { kv.append(el('span', 'k', k)); kv.append(el('span', null, v)); }
}

// The lineage table. This is the tab an engineer opens when they want to know whether the
// numbers are real, so it lists the refusals as prominently as the successes - including the
// one I got wrong for an hour by testing Reddit and assuming X behaved the same way.
function renderLineage(botMeta, polyMeta) {
  const t = $('lineage');
  if (!t) return;
  const ch = (botMeta && botMeta.chatter) || null;
  const rows = [
    ['battlebots.fandom.com', 'Web Unlocker', 'ok',
      `${FIGHTS.length} fights, ${BOTS.length} bots from 25 pages`,
      'Season page plus one page per competitor. Plain curl gets 403 here, which is what Web Unlocker is for.'],
    ['x.com', 'Scraper API dataset', ch ? 'ok' : 'no',
      ch ? `${ch.posts} posts, ${BOTS.filter((b) => b.chatter).length} bots mentioned` : 'not collected',
      'Web Unlocker refuses x.com on robots.txt grounds. The social platforms are served by the dataset trigger/poll API instead, which discovers by profile - there is no keyword search on it.'],
    ['gamma-api.polymarket.com', 'Web Unlocker', polyMeta ? 'ok' : 'no',
      polyMeta ? 'live market prices, public API' : 'not fetched',
      'Used to check whether a BattleBots market exists. It does not.'],
    ['reddit.com', 'Web Unlocker', 'no', 'refused',
      'Same robots.txt carve-out as x.com. Adding our IP to the allowlist changed nothing, because it was never an IP restriction. Needs an account-manager unlock, so there is no Reddit data here rather than invented data.'],
    ['youtube.com', 'Web Unlocker', 'no', 'refused',
      'Same carve-out. Episode comments would have been the richest sentiment source and we did not get them.'],
  ];
  t.innerHTML = '';
  const tb = el('tbody');
  for (const [src, product, state, count, why] of rows) {
    const tr = el('tr');
    const c1 = el('td');
    c1.append(el('div', 'src', src));
    c1.append(el('div', 'why', product));
    tr.append(c1);
    tr.append(el('td', state === 'ok' ? 'ok' : 'no', state === 'ok' ? 'FETCHED' : 'REFUSED'));
    const c3 = el('td');
    c3.append(el('div', null, count));
    c3.append(el('div', 'why', why));
    tr.append(c3);
    tb.append(tr);
  }
  t.append(tb);
}

function renderChatter() {
  const t = $('chatterTable');
  const withChat = BOTS.filter((b) => b.chatter);
  if (!withChat.length) { t.innerHTML = '<tbody><tr><td>No chatter scraped.</td></tr></tbody>'; return; }
  // Reach, not sentiment. The X Posts dataset gives engagement counts, not tone, and running
  // a keyword sentiment guess over 40 posts would be inventing a number the source never
  // provided. Views and likes are measured; how anyone feels about a bot is not.
  t.innerHTML = '<thead><tr><th>BOT</th><th>MENTIONS</th><th>VIEWS</th><th>LIKES</th><th>REC</th><th>READ</th></tr></thead>';
  const tb = el('tbody');
  const num = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
  [...withChat].sort((a, b) => b.chatter.mentions - a.chatter.mentions).forEach((b) => {
    const r = MODEL.records[b.id];
    const tr = el('tr');
    tr.append(el('td', null, b.name));
    tr.append(el('td', 'num', String(b.chatter.mentions)));
    tr.append(el('td', 'num', num(b.chatter.views)));
    tr.append(el('td', 'num', num(b.chatter.likes)));
    tr.append(el('td', 'num', `${r.w}-${r.l}`));
    // The only read the data actually supports: talked about a lot, not winning much.
    const talked = b.chatter.mentions >= 2 && r.rawWinRate < 0.5;
    tr.append(el('td', null, talked ? 'talked about, losing' : ''));
    tb.append(tr);
  });
  t.append(tb);
}

// ---------------------------------------------------------------- wiring

function wire() {
  for (const id of ['lyBuzz', 'lyPoly', 'lyUser']) $(id).addEventListener('change', refresh);
  $('lyUserVal').addEventListener('input', refresh);
  for (const id of ['pnameA', 'pnameB']) $(id).addEventListener('input', renderBook);
  // The name inputs live inside the corner buttons, so a click on them must not be treated
  // as a click on the button itself.
  for (const id of ['pnameA', 'pnameB']) $(id).addEventListener('click', (e) => e.stopPropagation());
  $('betClear').addEventListener('click', () => {
    PLAYERS = {}; savePlayers(PLAYERS); openMatch = null;
    $('bookNote').className = 'book-note';
    $('bookNote').textContent = 'Leaderboard cleared. Name both players, set the ante, then run the fight.';
    renderBook();
  });
  $('stake').addEventListener('input', () => {
    if (running) return;
    const ante = Math.round(Number($('stake').value) || 0);
    $('bookNote').textContent = `Ante ${ante} each - ${ante * 2} in the pot. Run the fight.`;
  });
  renderBook();
  $('selA').addEventListener('change', refresh);
  $('selB').addEventListener('change', refresh);
  $('fight').addEventListener('click', () => { A.unlock(); runFight(); });
  $('rand').addEventListener('click', () => {
    if (running) return;
    const pickTwo = () => {
      const i = Math.floor(Math.random() * BOTS.length);
      let j = Math.floor(Math.random() * BOTS.length);
      if (j === i) j = (j + 1) % BOTS.length;
      return [BOTS[i], BOTS[j]];
    };
    const [a, b] = pickTwo();
    $('selA').value = a.id; $('selB').value = b.id;
    refresh();
  });
  $('mute').addEventListener('click', () => {
    const m = A.toggleMute();
    $('mute').textContent = m ? 'SOUND OFF' : 'SOUND ON';
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
      const v = tab.dataset.view;
      document.querySelectorAll('.view').forEach((s) => s.classList.toggle('on', s.id === 'view-' + v));
      if (v === 'backtest' && !BT) { BT = backtest(BOTS, FIGHTS); renderBacktest(); }
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'SELECT') return;
    if (e.code === 'Space' || e.code === 'Enter') { e.preventDefault(); A.unlock(); runFight(); }
  });
}

boot();
