#!/usr/bin/env node
// Exercises the parsers against fixture HTML so they are known-good before the venue.
// When you rewrite them for the real markup, update these fixtures and keep this green.
//   node scrape/test_parsers.mjs
import { parseRoster, parseResults, classifyWeapon, validate } from './scrape.mjs';

let failures = 0;
const ok = (cond, msg) => { if (!cond) { failures++; console.log('FAIL ' + msg); } else console.log('  ok  ' + msg); };

// ---------------------------------------------------------------- weapon classes
const WEAPON_CASES = [
  ['Vertical spinner', 'vspinner'], ['drum spinner', 'vspinner'], ['Eggbeater', 'vspinner'],
  ['Horizontal undercutter', 'hspinner'], ['bar spinner', 'hspinner'], ['Shell spinner', 'hspinner'],
  ['Pneumatic flipper', 'flipper'], ['Launcher', 'flipper'],
  ['Hydraulic crusher', 'crusher'], ['grabber and lifter', 'crusher'], ['Claw', 'crusher'],
  ['Overhead hammer', 'hammer'], ['Vertical saw', 'vspinner'], ['axe', 'hammer'],
  ['spinner', 'hspinner'],
  ['Wedge', 'control'], ['', 'control'], [null, 'control'],
];
console.log('weapon classification');
for (const [input, want] of WEAPON_CASES) {
  const got = classifyWeapon(input);
  ok(got === want, `${JSON.stringify(input)} -> ${got}${got === want ? '' : ` (wanted ${want})`}`);
}

// ---------------------------------------------------------------- roster
console.log('\nroster parser');
const ROSTER_HTML = `
<table><thead><tr><th>Name</th><th>Weapon</th><th>Weight</th></tr></thead><tbody>
<tr><td>Tombstone</td><td>Horizontal bar spinner</td><td>250 lb</td></tr>
<tr><td>Hydra</td><td>Hydraulic flipper</td><td>250 lb</td></tr>
<tr><td>SawBlaze</td><td>Overhead hammer saw</td><td>250 lb</td></tr>
<tr><td>Claw Viper</td><td>Grabber</td><td>250 lb</td></tr>
</tbody></table>`;
const bots = parseRoster(ROSTER_HTML);
ok(bots.length === 4, `parsed ${bots.length} bots (want 4, header row skipped)`);
ok(bots[0].id === 'tombstone', `first id is ${bots[0] && bots[0].id}`);
ok(bots[0].weapon === 'hspinner', `Tombstone -> ${bots[0] && bots[0].weapon}`);
ok(bots[1].weapon === 'flipper', `Hydra -> ${bots[1] && bots[1].weapon}`);
ok(bots[3].id === 'claw-viper', `multi-word name slugged to ${bots[3] && bots[3].id}`);
ok(bots.every((b) => b.weightLb === 250), 'weights parsed');
ok(new Set(bots.map((b) => b.color)).size === 4, 'each bot got a distinct colour');

// ---------------------------------------------------------------- results
console.log('\nresults parser');
const RESULTS_HTML = `
<table><tbody>
<tr><td>S1E1</td><td>Tombstone def. Hydra</td><td>KO</td><td>1:36</td></tr>
<tr><td>S1E1</td><td>SawBlaze def. Claw Viper</td><td>Judges' decision</td><td>3:00</td></tr>
<tr><td>S1E2</td><td>Hydra def. SawBlaze</td><td>Knockout</td><td>0:48</td></tr>
<tr><td>S1E2</td><td>Ghost Bot def. Tombstone</td><td>KO</td><td>2:10</td></tr>
</tbody></table>`;
const ids = new Set(bots.map((b) => b.id));
const fights = parseResults(RESULTS_HTML, ids);
ok(fights.length === 3, `parsed ${fights.length} fights (want 3 - the unknown "Ghost Bot" row is dropped)`);
ok(fights[0].a === 'tombstone' && fights[0].b === 'hydra', `first fight ${fights[0].a} v ${fights[0].b}`);
ok(fights[0].winner === 'tombstone', 'winner read from "def."');
ok(fights[0].method === 'KO' && fights[0].sec === 96, `method ${fights[0].method}, ${fights[0].sec}s`);
ok(fights[1].method === 'JD' && fights[1].sec === 180, `decision parsed as ${fights[1].method}, ${fights[1].sec}s`);
ok(fights[2].sec === 48, `0:48 -> ${fights[2].sec}s`);
ok(fights.every((f) => ids.has(f.a) && ids.has(f.b)), 'no orphan references survive');

// ---------------------------------------------------------------- validation
console.log('\nvalidator');
const clean = validate(bots, fights);
ok(clean.errs.length === 0, `clean data produces no errors${clean.errs.length ? ': ' + clean.errs.join('; ') : ''}`);
ok(clean.warns.some((w) => /small sample/.test(w)), 'small sample is warned about');

const orphaned = validate(bots, [...fights, { id: 'fX', a: 'nobody', b: 'hydra', winner: 'hydra', method: 'KO', sec: 60 }]);
ok(orphaned.errs.some((e) => /unknown bot ids/.test(e)), 'orphan reference is an error');

const badWin = validate(bots, [{ id: 'f1', a: 'hydra', b: 'tombstone', winner: 'sawblaze', method: 'KO', sec: 60 }]);
ok(badWin.errs.some((e) => /did not compete/.test(e)), 'winner who did not compete is an error');

// "A def. B" pages legitimately yield winner === a every time; that must not block a run
const allA = Array.from({ length: 12 }, (_, i) => ({
  id: 'f' + i, a: 'tombstone', b: 'hydra', winner: 'tombstone', method: 'KO', sec: 90,
}));
const lazy = validate(bots, allA);
ok(lazy.errs.length === 0, 'uniform winner side is NOT a blocking error (would reject a valid "def." scrape)');
ok(lazy.warns.some((w) => /first-listed bot/.test(w)), 'uniform winner side is still warned about');

console.log(`\n${failures ? 'FAILED: ' + failures + ' check(s)' : 'PASS - all parser checks green'}`);
process.exit(failures ? 1 : 0);
