#!/usr/bin/env node
/**
 * Career fight history -> data/fights_career.json
 *
 *   node scrape/career.mjs            # parse the cached bot pages
 *   node scrape/career.mjs --write    # also swap it into data/fights.json
 *
 * WHY
 *
 * The Pro League season is eight episodes old. Twenty-three fights across twenty-four bots is
 * two fights each, and no amount of modelling fixes that - the back-test says so and the
 * betting P&L says so louder.
 *
 * But every competitor's own wiki page carries a full career results table: one row per
 * competition, listing the opponents that bot beat and the ones it lost to, going back to
 * 2004 for the veterans. Tombstone alone is 33-17. Those pages are already in the cache from
 * the roster crawl, so this costs no extra requests - it is the same 25 pages read properly
 * instead of read for one field.
 *
 * WHAT IT IS NOT
 *
 * These are historical fights across many seasons and rule sets, not Pro League 2026 fights.
 * A bot's 2016 form is weak evidence for its 2026 form. So this writes a SEPARATE file and
 * tags every fight with its competition; it does not quietly inflate the season numbers. The
 * app labels which dataset it is running on.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scrape', '.cache');

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// [[Target|Label]] -> Target. The target is the canonical bot page, and two pages that link
// the same robot under different labels must collapse to one id or the same fight is counted
// twice under two names.
const links = (cell) =>
  [...(cell || '').matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)].map((m) => m[1].trim()).filter(Boolean);

/**
 * The career table sits after the "Competitive Wins/Losses" summary and has three columns:
 * competition, opponents beaten, opponents lost to.
 */
export function parseCareer(wt, selfName) {
  const anchor = wt.indexOf('Competitive Wins/Losses');
  if (anchor < 0) return [];
  const tblStart = wt.indexOf('{|', anchor);
  if (tblStart < 0) return [];
  const tblEnd = wt.indexOf('\n|}', tblStart);
  const table = wt.slice(tblStart, tblEnd < 0 ? tblStart + 20000 : tblEnd);

  const out = [];
  for (const row of table.split('\n|-').slice(1)) {
    // Cells are newline-leading pipes. Header rows use ! and are skipped by the slice above.
    const cells = row.split('\n|').slice(1);
    if (cells.length < 3) continue;
    const comp = cells[0].replace(/<[^>]*>/g, ' ').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim();
    for (const opp of links(cells[1])) out.push({ self: selfName, opp, selfWon: true, comp });
    for (const opp of links(cells[2])) out.push({ self: selfName, opp, selfWon: false, comp });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const { bots } = JSON.parse(readFileSync(join(ROOT, 'data/bots.json'), 'utf8'));
  const roster = new Set(bots.map((b) => b.id));
  const byName = Object.fromEntries(bots.map((b) => [b.name, b]));

  if (!existsSync(CACHE)) { console.error('no cache - run scrape/pro_league.mjs first'); process.exit(1); }

  let raw = [];
  for (const b of bots) {
    const f = join(CACHE, b.name.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80) + '.json');
    if (!existsSync(f)) { console.log(`  miss  ${b.name}`); continue; }
    let wt;
    try { wt = JSON.parse(readFileSync(f, 'utf8')).parse.wikitext['*']; } catch { continue; }
    const rows = parseCareer(wt, b.name);
    raw.push(...rows);
    console.log(`  ${String(rows.length).padStart(3)}  ${b.name}`);
  }

  console.log(`\nraw career results parsed: ${raw.length}`);

  // Every fight is written on BOTH bots' pages - once as a win, once as a loss. Dedupe on the
  // unordered pair plus competition, keeping the first, or the sample doubles and every
  // shrinkage constant in the model is silently wrong.
  const seen = new Map();
  let conflicts = 0;
  for (const r of raw) {
    const a = slug(r.self), b = slug(r.opp);
    if (a === b) continue;
    const key = [a, b].sort().join('|') + '#' + slug(r.comp);
    const winner = r.selfWon ? a : b;
    if (seen.has(key)) {
      // The two pages disagree about who won. Drop it rather than pick a side.
      if (seen.get(key).winner !== winner) { seen.get(key).bad = true; conflicts++; }
      continue;
    }
    seen.set(key, { a, b, winner, comp: r.comp, bad: false });
  }

  const all = [...seen.values()].filter((f) => !f.bad);
  const inRoster = all.filter((f) => roster.has(f.a) && roster.has(f.b));
  console.log(`deduped: ${all.length} unique fights (${conflicts} dropped for conflicting winners)`);
  console.log(`both bots in the Pro League field: ${inRoster.length}`);

  const fights = inRoster.map((f, i) => ({
    id: 'c' + String(i + 1).padStart(3, '0'),
    a: f.a, b: f.b, winner: f.winner,
    method: null, sec: null,          // the career table records who won and nothing else
    event: f.comp || 'career',
  }));

  const doc = {
    _meta: {
      source: 'battlebots-fandom-career',
      sourceLabel: 'battlebots.fandom.com career tables via Bright Data Web Unlocker',
      route: 'brightdata',
      fetchedAt: new Date().toISOString(),
      n: fights.length,
      caveat: 'Historical fights across many seasons and rule sets, not Pro League 2026. Parsed from the same 25 cached pages as the roster - no extra requests. Deduped across both competitors\' pages.',
    },
    fights,
  };
  writeFileSync(join(ROOT, 'data/fights_career.json'), JSON.stringify(doc, null, 2));
  console.log(`\nwrote data/fights_career.json (${fights.length} fights)`);

  const comps = {};
  for (const f of fights) comps[f.event] = (comps[f.event] || 0) + 1;
  const top = Object.entries(comps).sort((x, y) => y[1] - x[1]).slice(0, 8);
  for (const [c, n] of top) console.log(`  ${String(n).padStart(3)}  ${c}`);

  if (argv.includes('--write')) {
    const season = JSON.parse(readFileSync(join(ROOT, 'data/fights.json'), 'utf8'));
    const merged = [...fights, ...season.fights];
    writeFileSync(join(ROOT, 'data/fights.json'), JSON.stringify({
      _meta: { ...season._meta, n: merged.length, merged: 'career + Pro League 2026',
        caveat: 'Career fights from previous seasons are included. They are historical form, not this season.' },
      fights: merged,
    }, null, 2));
    console.log(`\nmerged into data/fights.json - ${merged.length} fights total`);
  }
}

main();
