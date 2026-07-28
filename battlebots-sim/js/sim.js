// Bout generator. Produces a deterministic event timeline for a fight.
//
// The outcome is decided FIRST, by the model, and the exchanges are then generated to
// arrive there. That ordering is deliberate: the point of the demo is that the prediction
// and the fight you watch are the same claim. If the visuals rolled their own dice you
// could show a 90% favourite losing on stage while the bar above it still said 90%, which
// reads as broken rather than as variance.
//
// Everything is driven by a seeded PRNG keyed on the two bot ids, so the same matchup
// always produces the same bout. You can rehearse a demo and get it back verbatim.

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Per-weapon behaviour. `dmg` is mean damage per landed hit, `spread` the variance,
// `oota` the chance a landed hit throws the opponent out of the arena outright.
const WEAPON = {
  hspinner: { dmg: 22, spread: 12, oota: 0.03, verb: ['undercuts', 'catches', 'rips into'], noun: 'undercut', immob: 0.10 },
  vspinner: { dmg: 20, spread: 11, oota: 0.02, verb: ['launches', 'overcuts', 'gets under'], noun: 'overcut', immob: 0.08 },
  flipper:  { dmg: 9,  spread: 5,  oota: 0.14, verb: ['flips', 'throws', 'stands up'], noun: 'flip', immob: 0.04 },
  crusher:  { dmg: 14, spread: 6,  oota: 0.02, verb: ['bites down on', 'punctures', 'clamps'], noun: 'bite', immob: 0.22 },
  hammer:   { dmg: 16, spread: 8,  oota: 0.01, verb: ['hammers', 'axes', 'drops the blade on'], noun: 'axe blow', immob: 0.12 },
  control:  { dmg: 8,  spread: 4,  oota: 0.05, verb: ['shoves', 'controls', 'drives through'], noun: 'shove', immob: 0.15 },
};
export const weaponOf = (bot) => WEAPON[bot.weapon] ? bot.weapon : 'control';

const pct = (x) => Math.round(x * 100) + '%';

export function simulate({ a, b, model, seed = 0 }) {
  const rng = mulberry32(hashSeed(`${a.id}:${b.id}:${seed}`));
  const pred = model.predict(a.id, b.id);
  const recA = model.records[a.id], recB = model.records[b.id];

  // who wins - a seeded draw against the model's own probability
  const aWins = rng() < pred.p;
  const win = aWins ? a : b, lose = aWins ? b : a;
  const winRec = aWins ? recA : recB, loseRec = aWins ? recB : recA;

  // KO or distance. A bot that finishes often, against a bot that gets finished often,
  // ends it early. Both numbers are scraped, not invented.
  const koChance = Math.max(0.06, Math.min(0.92, winRec.koRate * 0.75 + loseRec.koLossRate * 0.55));
  const isKO = rng() < koChance;

  const hpA = { v: 100 }, hpB = { v: 100 };
  const hpOf = (bot) => (bot.id === a.id ? hpA : hpB);
  const events = [];
  let t = 0;

  const push = (e) => events.push({ t: Math.round(t), ...e });

  push({
    type: 'start', actor: null,
    text: `${a.name} versus ${b.name}. Model calls it ${pct(Math.max(pred.p, 1 - pred.p))} ${pred.p >= 0.5 ? a.name : b.name}.`,
  });

  const exchanges = isKO ? 3 + Math.floor(rng() * 5) : 7 + Math.floor(rng() * 5);
  let ended = false;

  for (let i = 0; i < exchanges && !ended; i++) {
    t += 6 + rng() * 14;

    // the eventual winner lands the majority of exchanges, but not all of them - a fight
    // with no answering blows looks scripted, because it is
    const winnerLands = rng() < 0.68;
    const att = winnerLands ? win : lose;
    const def = winnerLands ? lose : win;
    const w = WEAPON[weaponOf(att)];

    if (rng() < 0.14) {
      push({ type: 'miss', actor: att.id, target: def.id, text: `${att.name} swings and misses - ${def.name} backs off the ${w.noun}.` });
      continue;
    }

    // out-of-the-arena finish, flippers only in practice
    if (winnerLands && rng() < w.oota && i > 0) {
      hpOf(def).v = 0;
      push({ type: 'oota', actor: att.id, target: def.id, dmg: 100, hpA: hpA.v, hpB: hpB.v,
        text: `${att.name} puts ${def.name} over the wall. Out of the arena, that is the fight.` });
      ended = true; break;
    }

    let dmg = w.dmg + (rng() - 0.5) * w.spread;
    const big = rng() < 0.24;
    if (big) dmg *= 1.7;
    // the losing side lands weaker shots, otherwise the health bars tell a different story
    // to the scoreboard
    if (!winnerLands) dmg *= 0.55;
    dmg = Math.max(3, Math.round(dmg));

    const dh = hpOf(def);
    dh.v = Math.max(0, dh.v - dmg);

    push({
      type: big ? 'bighit' : 'hit',
      actor: att.id, target: def.id, dmg, hpA: hpA.v, hpB: hpB.v,
      text: `${att.name} ${w.verb[Math.floor(rng() * w.verb.length)]} ${def.name}${big ? ' - huge shot' : ''}.`,
    });

    if (dh.v <= 0) {
      push({ type: 'immobile', actor: att.id, target: def.id, hpA: hpA.v, hpB: hpB.v,
        text: `${def.name} is not moving.` });
      ended = true; break;
    }
    if (winnerLands && rng() < w.immob && i >= 2 && isKO) {
      dh.v = Math.max(0, dh.v - 25);
      push({ type: 'immobile', actor: att.id, target: def.id, hpA: hpA.v, hpB: hpB.v,
        text: `${def.name} is dragging a side - ${att.name} has done real damage.` });
      if (dh.v <= 0) { ended = true; break; }
    }
  }

  // resolve
  if (hpOf(lose).v <= 0 || (isKO && !ended)) {
    if (hpOf(lose).v > 0) hpOf(lose).v = 0;
    t += 4;
    push({
      type: 'ko', actor: win.id, target: lose.id, hpA: hpA.v, hpB: hpB.v,
      text: `Knockout. ${win.name} wins by KO at ${fmtClock(t)}.`,
    });
  } else {
    // went the distance - make sure the winner is visibly ahead on the bars
    if (hpOf(win).v <= hpOf(lose).v) hpOf(lose).v = Math.max(0, hpOf(win).v - 8 - Math.floor(rng() * 14));
    t = 180;
    push({
      type: 'decision', actor: win.id, target: lose.id, hpA: hpA.v, hpB: hpB.v,
      text: `Full three minutes. Judges score it for ${win.name}.`,
    });
  }

  return {
    a, b, winner: win, loser: lose,
    method: events[events.length - 1].type === 'decision' ? 'JD' : 'KO',
    p: pred.p, prediction: pred,
    events,
    finalHp: { [a.id]: hpA.v, [b.id]: hpB.v },
    seconds: Math.min(180, Math.round(t)),
  };
}

export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- grounded commentary

// Colour lines that quote a real scraped number. Used sparingly between exchanges so the
// commentary never drifts into invented facts - if there is no number to cite, say nothing.
export function groundedLines(bout, model) {
  const out = [];
  const { a, b } = bout;
  const rA = model.records[a.id], rB = model.records[b.id];
  const mu = model.matchup;
  const wa = model.weapon[a.id], wb = model.weapon[b.id];

  if (rA.ko || rB.ko) {
    const finisher = rA.rawKoRate >= rB.rawKoRate ? { bot: a, r: rA } : { bot: b, r: rB };
    if (finisher.r.ko > 0) {
      out.push(`${finisher.bot.name} has finished ${finisher.r.ko} of ${finisher.r.n} this season - ${pct(finisher.r.rawKoRate)} by KO.`);
    }
  }
  if (mu.edge[wa] && mu.edge[wa][wb] !== undefined && wa !== wb) {
    const e = mu.edge[wa][wb];
    const n = mu.n[wa][wb];
    if (n >= 2 && Math.abs(e) > 0.15) {
      const better = e > 0 ? wa : wb;
      out.push(`Weapon history favours the ${better.replace('spinner', ' spinner')}: ${pct(e > 0 ? mu.rate[wa][wb] : mu.rate[wb][wa])} across ${n} meetings this season.`);
    }
  }
  const grinder = rA.avgSec > rB.avgSec ? a : b;
  const gRec = grinder.id === a.id ? rA : rB;
  if (gRec.avgSec > 150) out.push(`${grinder.name} tends to go long - ${Math.round(gRec.avgSec)}s average match.`);
  return out;
}
