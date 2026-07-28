#!/usr/bin/env node
// Headless season P&L. Run this before quoting any money number on stage.
//   node tools/bet.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backtest } from '../js/model.js';
import { seasonPnL, offeredOdds, VIG } from '../js/betting.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const { bots } = read('data/bots.json');
const { fights } = read('data/fights.json');
const name = Object.fromEntries(bots.map((b) => [b.id, b.name]));

// --l2 lets you bet the same season with a differently regularised model. That comparison is
// the whole lesson: an overconfident fit finds "edges" everywhere and pays for them.
const argv = process.argv.slice(2);
const flag = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? Number(argv[i + 1]) : d; };
const l2 = flag('--l2', 0.02);
const bt = backtest(bots, fights, { l2 });
console.log(`regularisation l2=${l2}`);
// Bet in the order the fights actually aired, not in the confidence order the back-test
// sorts into for its calibration table. A bankroll curve implies a timeline.
const chrono = [...bt.rows].sort((x, y) => String(x.fight.id).localeCompare(String(y.fight.id)));
const r = seasonPnL(chrono);

console.log(`season: ${fights.length} fights, house margin ${(VIG * 100).toFixed(1)}%`);
console.log(`model accuracy ${(bt.accuracy * 100).toFixed(1)}%  baseline ${(bt.baseline * 100).toFixed(1)}%  brier ${bt.brier.toFixed(4)}\n`);

console.log(`bets placed   ${r.nBets} of ${fights.length}  (${r.skipped} passed - no edge over the house price)`);
if (r.nBets) {
  console.log(`record        ${r.won}-${r.lost}  (${(r.hitRate * 100).toFixed(1)}% of bets landed)`);
  console.log(`staked        ${r.staked.toFixed(0)}`);
}
console.log(`bankroll      ${r.start} -> ${r.final.toFixed(0)}   profit ${r.profit >= 0 ? '+' : ''}${r.profit.toFixed(0)}`);
if (r.staked > 0) console.log(`ROI           ${(r.roi * 100).toFixed(1)}% of turnover`);

if (r.bets.length) {
  console.log('\nevery bet:');
  for (const b of r.bets) {
    console.log(`  ${b.id}  back ${name[b.backed].padEnd(14)} @${b.odds.toFixed(2)}  edge ${(b.edge * 100).toFixed(1)}%  stake ${b.stake.toFixed(0).padStart(4)}  ${b.hit ? 'WON ' : 'LOST'}  bank ${b.bank.toFixed(0)}`);
  }
}

console.log('\nread this before quoting it:');
if (r.nBets === 0) {
  console.log('  The model never disagreed with the record-only price by more than the house margin,');
  console.log('  so there was no bet to place all season. That is the McNemar result in money: no');
  console.log('  edge to sell. It is a finding, not a bug.');
} else if (r.nBets < 5) {
  console.log(`  ${r.nBets} bet(s) is not a track record. Whatever this P&L says, it is noise - do not`);
  console.log('  present it as evidence the model makes money.');
} else {
  console.log('  Check the bet count before believing the ROI. Under ~30 bets a positive return is');
  console.log('  well within variance for a model with no real edge.');
}
