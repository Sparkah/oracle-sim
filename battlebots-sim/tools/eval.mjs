#!/usr/bin/env node
// Headless run of the exact model the page uses. Run this after swapping in real scraped
// data to see the numbers before you trust them on a projector.
//   node tools/eval.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { train, backtest, CLASSES, FEATURE_NAMES } from '../js/model.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));

const { bots } = read('data/bots.json');
const { fights } = read('data/fights.json');

const t0 = Date.now();
const m = train(bots, fights);
const bt = backtest(bots, fights);
const ms = Date.now() - t0;

const pct = (x) => (x * 100).toFixed(1) + '%';
const name = Object.fromEntries(bots.map((b) => [b.id, b.name]));

console.log(`data: ${bots.length} bots, ${fights.length} fights`);
console.log(`fit + leave-one-out backtest in ${ms}ms\n`);

console.log(`accuracy        ${pct(bt.accuracy)}   (${Math.round(bt.accuracy * bt.n)}/${bt.n})`);
console.log(`record baseline ${pct(bt.baseline)}`);
console.log(`lift            ${((bt.accuracy - bt.baseline) * 100).toFixed(1)} pts`);
console.log(`brier           ${bt.brier.toFixed(3)}   (0.25 = always guessing 50/50)`);
console.log(`log loss        ${bt.logloss.toFixed(3)}`);

const mc = bt.mcnemar;
console.log(`\nmodel vs baseline, McNemar exact (paired - same fights, so this is the right test):`);
console.log(`  model right / baseline wrong   b = ${mc.b}`);
console.log(`  model wrong / baseline right   c = ${mc.c}`);
console.log(`  tied baseline (equal records)      ${mc.ties}`);
console.log(`  two-sided p = ${mc.p.toFixed(3)}  ->  ${mc.p < 0.05 ? 'significant at 0.05' : 'NOT significant - cannot claim it beats the baseline on this sample'}\n`);

console.log('learned weights (standardised, no bias term):');
FEATURE_NAMES.forEach((f, i) => console.log(`  ${f.padEnd(16)} ${m.weights[i] >= 0 ? '+' : ''}${m.weights[i].toFixed(3)}`));

console.log('\ncalibration:');
for (const b of bt.bins) {
  if (!b.n) continue;
  console.log(`  ${Math.round(b.lo * 100)}-${Math.round(Math.min(1, b.hi) * 100)}%  n=${String(b.n).padStart(3)}  claimed ${pct(b.claimed)}  actual ${pct(b.actual)}`);
}

console.log('\nweapon matchup edge (row beats column, log-odds, shrunk):');
console.log('            ' + CLASSES.map((c) => c.slice(0, 8).padStart(9)).join(''));
for (const x of CLASSES) {
  console.log(x.padEnd(12) + CLASSES.map((y) => (x === y ? '.' : m.matchup.edge[x][y].toFixed(2)).padStart(9)).join(''));
}

console.log('\npower ranking (mean win prob vs field):');
[...bots].sort((a, b) => m.rating[b.id] - m.rating[a.id]).slice(0, 8).forEach((b, i) => {
  const r = m.records[b.id];
  console.log(`  ${String(i + 1).padStart(2)}. ${b.name.padEnd(14)} ${pct(m.rating[b.id]).padStart(6)}   ${r.w}-${r.l}  ${b.weapon}`);
});

// antisymmetry assertion - if this ever fires the no-bias invariant has been broken
let worst = 0;
for (const a of bots) for (const b of bots) {
  if (a.id === b.id) continue;
  worst = Math.max(worst, Math.abs(m.predict(a.id, b.id).p + m.predict(b.id, a.id).p - 1));
}
console.log(`\nantisymmetry check: max |P(A>B) + P(B>A) - 1| = ${worst.toExponential(2)}`);
if (worst > 1e-9) { console.error('FAIL: model is not antisymmetric'); process.exit(1); }
