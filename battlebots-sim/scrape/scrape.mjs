#!/usr/bin/env node
/**
 * Bright Data -> data/*.json
 *
 * The app never talks to the network. This script is the only thing that does, and its
 * whole job is to emit the two files described in SCHEMA.md. That separation is what makes
 * the swap at the venue a five-minute job instead of a rewrite.
 *
 *   export BRIGHTDATA_API_KEY=...          # from the $100 credit link at the event
 *   export BRIGHTDATA_ZONE=web_unlocker1   # whatever the zone is called in your account
 *
 *   node scrape/scrape.mjs --list                 # show the configured targets
 *   node scrape/scrape.mjs --probe <url>          # fetch one page, print the first 2KB
 *   node scrape/scrape.mjs --out data             # full run: fetch, parse, validate, write
 *   node scrape/scrape.mjs --out data --dry-run   # parse cached HTML only, write nothing
 *
 * VERIFY THE ENDPOINT BEFORE YOU RELY ON IT. Bright Data has several products (Web
 * Unlocker, Web Scraper API, SERP API, an MCP server) and the request shape differs between
 * them. The call below is the Web Unlocker /request shape. Run --probe first: if it comes
 * back with HTML you are in business, if it 401s or 404s, fix `brightDataFetch` and nothing
 * else in this file has to change.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scrape', '.cache');

const API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';

// ---------------------------------------------------------------- targets
//
// TODO AT THE VENUE: point these at the real Pro League pages. Keep one entry per page you
// need; the parser for each is below. Season/roster pages first - the fight list is the one
// the model actually needs, the roster only supplies names and weapon classes.
const TARGETS = {
  roster: 'https://example.invalid/battlebots-pro-league/robots',
  results: 'https://example.invalid/battlebots-pro-league/results',
  // chatter is optional; drop it if time is short, the app degrades cleanly
  chatter: null,
};

// ---------------------------------------------------------------- transport

async function brightDataFetch(url) {
  if (!API_KEY) throw new Error('BRIGHTDATA_API_KEY is not set');
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ zone: ZONE, url, format: 'raw' }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Bright Data ${res.status} ${res.statusText}\n${body.slice(0, 500)}`);
  }
  return res.text();
}

// Cache every fetch. At a hack night you will re-run the parser twenty times and you do not
// want to spend credits or wait on the network for each pass.
async function getPage(name, url, { refresh = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${name}.html`);
  if (!refresh && existsSync(file)) {
    process.stderr.write(`cache hit: ${name}\n`);
    return readFileSync(file, 'utf8');
  }
  process.stderr.write(`fetching: ${name} ${url}\n`);
  const html = await brightDataFetch(url);
  writeFileSync(file, html);
  return html;
}

// ---------------------------------------------------------------- parsers
//
// Deliberately regex-based and dumb. You will be writing these live against HTML you have
// not seen before, and a dependency-free file you can edit in one place beats a parser
// library you have to install and learn at 19:00. Swap in cheerio if the markup fights you.

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const strip = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

// Map whatever the site calls a weapon onto the five classes the model understands.
// Anything unmatched falls through to 'control' and is excluded from the matchup grid,
// which is the safe default - better than silently miscategorising a bot.
export function classifyWeapon(text) {
  let t = (text || '').toLowerCase();
  // A bot that has changed weapon across seasons lists every era it has run, e.g.
  // "horizontal spinner (WC II) vertical spinner (WC IV-present)". The current
  // configuration is the one the model should see, so if any era is marked present,
  // keep only that clause and discard the history.
  if (/present/.test(t)) {
    const cur = t.split(/(?<=\))\s*/).filter((c) => /present/.test(c));
    if (cur.length) t = cur.join(' ');
  }
  // Orientation wins over weapon shape, and must be tested first. A drum is normally
  // vertical, so the shape words imply vertical - but "horizontal drum spinner" is a real
  // configuration (Malice) and matching on `drum` before `horizontal` gets it backwards.
  if (/\bhoriz/.test(t)) return 'hspinner';
  if (/\bvert/.test(t)) return 'vspinner';
  if (/\b(drum|egg ?beater|overcut)/.test(t)) return 'vspinner';
  if (/\b(undercut|bar spinner|shell)/.test(t)) return 'hspinner';
  if (/\b(flip|launch)/.test(t)) return 'flipper';
  if (/\b(crush|grab|claw|clamp|pinch)/.test(t)) return 'crusher';
  if (/\b(hammer|axe|saw)/.test(t)) return 'hammer';
  if (/\bspinner\b/.test(t)) return 'hspinner';   // bare "spinner" is usually horizontal
  return 'control';
}

const PALETTE = ['#e8503a', '#3da9fc', '#ff8a3d', '#3fbf7f', '#a06bd6', '#ffb020', '#d94f3d', '#2f8ee0'];

// TODO AT THE VENUE: rewrite the selector below for the real markup.
export function parseRoster(html) {
  const bots = [];
  // expects rows shaped roughly like: <tr><td>Name</td><td>Weapon</td><td>250 lb</td></tr>
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(strip).filter(Boolean);
    if (cells.length < 2) continue;
    const name = cells[0];
    if (!name || /^(name|robot|bot)$/i.test(name)) continue;
    const weapon = classifyWeapon(cells[1]);
    const weightLb = parseInt((cells.find((c) => /lb|kg/i.test(c)) || '250').replace(/\D/g, ''), 10) || 250;
    bots.push({ id: slug(name), name, weapon, weightLb, color: PALETTE[bots.length % PALETTE.length], chatter: null });
  }
  return bots;
}

// TODO AT THE VENUE: rewrite for the real markup.
export function parseResults(html, knownIds) {
  const fights = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  let n = 0;
  for (const row of rows) {
    const cells = (row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(strip).filter(Boolean);
    if (cells.length < 3) continue;
    // expects: [event, "A def. B", method, time]
    const vs = cells.find((c) => /\bdef\.?\b|\bvs\.?\b|\bbeat\b/i.test(c));
    if (!vs) continue;
    const m = vs.split(/\s+(?:def\.?|beat|vs\.?)\s+/i);
    if (m.length !== 2) continue;
    const a = slug(m[0]), b = slug(m[1]);
    if (knownIds && (!knownIds.has(a) || !knownIds.has(b))) continue;
    const methodCell = cells.find((c) => /ko|knockout|judge|decision|tap|submission/i.test(c)) || '';
    const method = /ko|knockout/i.test(methodCell) ? 'KO' : /tap|submission/i.test(methodCell) ? 'TAP' : 'JD';
    const timeCell = cells.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    const sec = timeCell
      ? parseInt(timeCell.split(':')[0], 10) * 60 + parseInt(timeCell.split(':')[1], 10)
      : (method === 'KO' ? 120 : 180);
    fights.push({ id: 'f' + String(++n).padStart(3, '0'), a, b, winner: a, method, sec, event: cells[0] || 'S1' });
  }
  return fights;
}

// ---------------------------------------------------------------- validation
//
// Same rules the app enforces at boot, run here so a broken scrape fails at the terminal
// instead of halfway through a demo.
export function validate(bots, fights) {
  const errs = [], warns = [];
  const ids = new Set(bots.map((b) => b.id));
  if (bots.length < 2) errs.push(`only ${bots.length} bots parsed`);
  if (new Set(bots.map((b) => b.id)).size !== bots.length) errs.push('duplicate bot ids');
  if (!fights.length) errs.push('no fights parsed');

  const orphans = fights.filter((f) => !ids.has(f.a) || !ids.has(f.b));
  if (orphans.length) errs.push(`${orphans.length} fight(s) reference unknown bot ids, e.g. ${orphans[0].a} vs ${orphans[0].b}`);
  const badWinner = fights.filter((f) => f.winner !== f.a && f.winner !== f.b);
  if (badWinner.length) errs.push(`${badWinner.length} fight(s) have a winner who did not compete`);

  const perBot = {};
  for (const f of fights) { perBot[f.a] = (perBot[f.a] || 0) + 1; perBot[f.b] = (perBot[f.b] || 0) + 1; }
  const noFights = bots.filter((b) => !perBot[b.id]);
  if (noFights.length) warns.push(`${noFights.length} bot(s) have no fights: ${noFights.slice(0, 5).map((b) => b.name).join(', ')}`);
  if (fights.length < 20) warns.push(`${fights.length} fights is a very small sample - say so when you show the accuracy`);
  const unclassed = bots.filter((b) => b.weapon === 'control');
  if (unclassed.length > bots.length * 0.3) warns.push(`${unclassed.length}/${bots.length} bots fell through to 'control' - the weapon regexes probably need work`);

  // Every winner being the 'a' side is EXPECTED for an "A def. B" results page, and is a
  // tell for a lazy parser on any other format. Only a warning, because blocking here would
  // reject a perfectly good scrape. It is harmless to the model either way: features are
  // differences, there is no bias term, and every fight is trained in both orientations, so
  // which side a bot was written on cannot influence the fit.
  if (fights.length > 8 && fights.every((f) => f.winner === f.a)) {
    warns.push('every fight was won by the first-listed bot - correct for an "A def. B" page, ' +
      'but check parseResults is actually reading the winner if the source lists them any other way');
  }
  return { errs, warns };
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };

  if (has('--list')) {
    for (const [k, v] of Object.entries(TARGETS)) console.log(`${k.padEnd(10)} ${v || '(disabled)'}`);
    console.log(`\nzone: ${ZONE}\nkey:  ${API_KEY ? 'set' : 'NOT SET'}`);
    return;
  }

  if (has('--probe')) {
    const url = val('--probe');
    if (!url) throw new Error('--probe needs a url');
    const html = await brightDataFetch(url);
    console.log(`${html.length} bytes\n---\n${html.slice(0, 2000)}`);
    return;
  }

  const outDir = join(ROOT, val('--out') || 'data');
  const refresh = has('--refresh');

  const rosterHtml = await getPage('roster', TARGETS.roster, { refresh });
  const bots = parseRoster(rosterHtml);
  const ids = new Set(bots.map((b) => b.id));

  const resultsHtml = await getPage('results', TARGETS.results, { refresh });
  const fights = parseResults(resultsHtml, ids);

  const { errs, warns } = validate(bots, fights);
  for (const w of warns) process.stderr.write(`WARN  ${w}\n`);
  for (const e of errs) process.stderr.write(`ERROR ${e}\n`);
  if (errs.length) {
    process.stderr.write('\nrefusing to write - fix the parsers first\n');
    process.exit(1);
  }

  if (has('--dry-run')) {
    console.log(`dry run OK: ${bots.length} bots, ${fights.length} fights (nothing written)`);
    return;
  }

  const stamp = new Date().toISOString();
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'bots.json'), JSON.stringify({
    _meta: { source: 'brightdata', sourceLabel: 'Bright Data scrape', fetchedAt: stamp, n: bots.length },
    bots,
  }, null, 2) + '\n');
  writeFileSync(join(outDir, 'fights.json'), JSON.stringify({
    _meta: { source: 'brightdata', season: 'PL-1', fetchedAt: stamp, n: fights.length },
    fights,
  }, null, 2) + '\n');

  console.log(`wrote ${bots.length} bots and ${fights.length} fights to ${outDir}`);
  console.log('now run: node tools/eval.mjs   (check the accuracy before you show it)');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { process.stderr.write(String(e.message || e) + '\n'); process.exit(1); });
}
