#!/usr/bin/env node
// Generates a synthetic but INTERNALLY CONSISTENT season so the app has something real
// to chew on before the live scrape lands.
//
// Consistency is the point. Every record, KO count and win rate the UI shows is derived
// from the fight list at runtime, so the fight list is the only thing that has to exist.
// It is generated from latent bot strengths and a latent weapon-matchup matrix, which
// means there IS genuine signal for the model to recover - and the back-test number is
// therefore a real measurement, not a tautology.
//
//   node tools/gen_synthetic_season.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// deterministic PRNG so regenerating gives byte-identical files
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(20260728);
const gauss = () => {
  // Box-Muller, clamped so no bot ends up absurd
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.max(-2.5, Math.min(2.5, Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)));
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

const PALETTE = {
  vspinner: ['#ff8a3d', '#ffb020', '#ff6b35', '#f7a325', '#ff9f1c'],
  hspinner: ['#e8503a', '#d94f3d', '#c9433c', '#ef5b4c', '#dc4a3a'],
  flipper:  ['#3da9fc', '#2f8ee0', '#4fb8ff', '#2d7dd2', '#5ab0f0'],
  crusher:  ['#a06bd6', '#8f5bc4', '#b47ae0', '#9563cf'],
  hammer:   ['#3fbf7f', '#35a86f', '#4fd18c', '#2f9c66', '#44c98a'],
};

// weapon -> latent quality multiplier and matchup edges.
// Rock-paper-scissors-ish, mirroring the real meta chatter: horizontal spinners eat
// flippers' low profile, flippers beat hammers by tossing them, crushers punish spinners
// that commit, hammers punish crushers that grab.
const CLASSES = ['vspinner', 'hspinner', 'flipper', 'crusher', 'hammer'];
const TRUE_MATCHUP = {
  //            vs: vspin hspin flip  crush hammer
  vspinner: { vspinner: 0.00, hspinner: -0.15, flipper: 0.25, crusher: 0.10, hammer: 0.30 },
  hspinner: { vspinner: 0.15, hspinner: 0.00, flipper: 0.35, crusher: -0.20, hammer: 0.10 },
  flipper:  { vspinner: -0.25, hspinner: -0.35, flipper: 0.00, crusher: 0.20, hammer: 0.40 },
  crusher:  { vspinner: -0.10, hspinner: 0.20, flipper: -0.20, crusher: 0.00, hammer: -0.30 },
  hammer:   { vspinner: -0.30, hspinner: -0.10, flipper: -0.40, crusher: 0.30, hammer: 0.00 },
};

const ROSTER = [
  ['tombstone', 'Tombstone', 'hspinner'], ['hypershock', 'Hypershock', 'hspinner'],
  ['rotator', 'Rotator', 'hspinner'], ['gigabyte', 'Gigabyte', 'hspinner'],
  ['valkyrie', 'Valkyrie', 'hspinner'],
  ['bite-force', 'Bite Force', 'vspinner'], ['minotaur', 'Minotaur', 'vspinner'],
  ['witch-doctor', 'Witch Doctor', 'vspinner'], ['end-game', 'End Game', 'vspinner'],
  ['copperhead', 'Copperhead', 'vspinner'],
  ['hydra', 'Hydra', 'flipper'], ['blip', 'Blip', 'flipper'],
  ['bronco', 'Bronco', 'flipper'], ['quantum', 'Quantum', 'flipper'],
  ['subzero', 'Subzero', 'flipper'],
  ['kraken', 'Kraken', 'crusher'], ['lock-jaw', 'Lock-Jaw', 'crusher'],
  ['claw-viper', 'Claw Viper', 'crusher'], ['whiplash', 'Whiplash', 'crusher'],
  ['sawblaze', 'SawBlaze', 'hammer'], ['skorpios', 'Skorpios', 'hammer'],
  ['shatter', 'Shatter', 'hammer'], ['beta', 'Beta', 'hammer'],
  ['chomp', 'Chomp', 'hammer'],
];

const bots = ROSTER.map(([id, name, weapon], i) => ({
  id, name, weapon,
  weightLb: 250,
  color: PALETTE[weapon][i % PALETTE[weapon].length],
  // latent, NOT written to disk - the model has to recover its effect from outcomes
  _strength: gauss() * 0.9,
  _finisher: 0.25 + rnd() * 0.5,   // propensity to end a fight by KO
  chatter: null,
}));
const byId = Object.fromEntries(bots.map((b) => [b.id, b]));

// Fan chatter correlates with strength but noisily - loved underdogs are the interesting
// cell in the sentiment view, so let a couple of weak bots be beloved.
for (const b of bots) {
  const hype = b._strength * 0.5 + gauss() * 0.8;
  b.chatter = {
    mentions: Math.round(120 + Math.max(0, hype + 2) * 190 + rnd() * 90),
    sentiment: Math.round(Math.max(-0.9, Math.min(0.95, 0.15 + hype * 0.28 + gauss() * 0.22)) * 100) / 100,
  };
}

// --- schedule: each bot fights 4-5 times, no rematches ---
const pairs = [];
for (let i = 0; i < bots.length; i++) {
  for (let j = i + 1; j < bots.length; j++) pairs.push([bots[i], bots[j]]);
}
// shuffle
for (let i = pairs.length - 1; i > 0; i--) {
  const j = Math.floor(rnd() * (i + 1));
  [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
}
const count = Object.fromEntries(bots.map((b) => [b.id, 0]));
const TARGET = 5;
const schedule = [];
for (const [a, b] of pairs) {
  if (count[a.id] >= TARGET || count[b.id] >= TARGET) continue;
  schedule.push([a, b]);
  count[a.id]++; count[b.id]++;
}

const EVENTS = ['S1E1', 'S1E2', 'S1E3', 'S1E4', 'S1E5', 'S1E6', 'S1E7', 'S1E8'];
const fights = schedule.map(([a, b], i) => {
  const edge = (a._strength - b._strength) + TRUE_MATCHUP[a.weapon][b.weapon];
  const pA = 1 / (1 + Math.exp(-1.35 * edge));
  const aWins = rnd() < pA;
  const w = aWins ? a : b, l = aWins ? b : a;
  // decisive bots finish; close fights go to the judges
  const koChance = w._finisher * (0.45 + 0.55 * Math.min(1, Math.abs(edge)));
  const isKO = rnd() < koChance;
  const sec = isKO
    ? Math.round(24 + rnd() * 130)          // finishes land anywhere in the match
    : 180;                                   // full distance
  return {
    id: 'f' + String(i + 1).padStart(3, '0'),
    a: a.id, b: b.id, winner: w.id,
    method: isKO ? 'KO' : 'JD',
    sec,
    event: EVENTS[Math.floor(i / Math.ceil(schedule.length / EVENTS.length))] || 'S1E8',
    _loser: l.id,
  };
}).map(({ _loser, ...f }) => f);

const stamp = '2026-07-28T09:00:00Z';
const outBots = {
  _meta: { source: 'synthetic', sourceLabel: 'Synthetic demo season', fetchedAt: stamp, n: bots.length },
  bots: bots.map(({ _strength, _finisher, ...b }) => b),
};
const outFights = {
  _meta: { source: 'synthetic', season: 'PL-1', fetchedAt: stamp, n: fights.length },
  fights,
};

mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data/bots.json'), JSON.stringify(outBots, null, 2) + '\n');
writeFileSync(join(ROOT, 'data/fights.json'), JSON.stringify(outFights, null, 2) + '\n');

// sanity read-out so a bad generation is obvious immediately
const wins = Object.fromEntries(bots.map((b) => [b.id, 0]));
for (const f of fights) wins[f.winner]++;
const ranked = [...bots].sort((x, y) => wins[y.id] - wins[x.id]);
process.stdout.write(
  `wrote ${bots.length} bots, ${fights.length} fights\n` +
  `KO rate ${Math.round(100 * fights.filter((f) => f.method === 'KO').length / fights.length)}%\n` +
  `top: ${ranked.slice(0, 5).map((b) => `${b.name} ${wins[b.id]}-${count[b.id] - wins[b.id]}`).join(', ')}\n`
);
