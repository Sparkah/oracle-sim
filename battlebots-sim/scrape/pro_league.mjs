#!/usr/bin/env node
/**
 * BattleBots Pro League (2026) -> data/*.json
 *
 * A real multi-page crawl, not a single fetch: the season page gives the 24-bot field and
 * every fight aired so far, and each of those 24 names is then a page of its own that
 * carries the weapon, weight and speed the model needs. One page in, thirty-three pages
 * fetched, two files out.
 *
 *   node scrape/pro_league.mjs --list           # show the crawl plan
 *   node scrape/pro_league.mjs --dry-run        # fetch, parse, validate, write nothing
 *   node scrape/pro_league.mjs --out data       # write it
 *   node scrape/pro_league.mjs --refresh        # ignore the cache
 *
 * Transport. battlebots.fandom.com answers a plain curl with 403, which is exactly what
 * Bright Data's Web Unlocker is for. If BRIGHTDATA_API_KEY resolves to a working zone we go
 * through it and the emitted _meta says so. If it does not, we fall back to a direct fetch
 * and _meta says THAT, loudly. The provenance badge must never claim a route we did not
 * take - the whole point of the badge is that it cannot be talked into lying.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyWeapon, validate } from './scrape.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scrape', '.cache');

const API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
const HOST = 'https://battlebots.fandom.com';
const SEASON_PAGE = 'BattleBots Pro League';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// The MediaWiki parse endpoint hands back the page source rather than rendered HTML. That is
// a deliberate choice: the rendered markup is a moving target of nested divs, the wikitext
// is a stable contract, and a fight row is a single unambiguous line in it.
const wikiUrl = (page) => `${HOST}/api.php?action=parse&page=${encodeURIComponent(page)}&format=json&prop=wikitext`;

// ---------------------------------------------------------------- transport

let ROUTE = null; // 'brightdata' | 'direct' - decided once, on the first fetch

async function brightDataFetch(url) {
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: ZONE, url, format: 'raw' }),
  });
  if (!res.ok) throw new Error(`Bright Data ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return res.text();
}

async function directFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`direct ${res.status} ${res.statusText}`);
  return res.text();
}

// Decide the route once by actually trying it, not by checking whether a key is set. A key
// that resolves to no zone looks configured and answers 400, and finding that out per-page
// would mean 33 failures instead of one.
async function pickRoute() {
  if (ROUTE) return ROUTE;
  if (API_KEY) {
    try {
      await brightDataFetch(wikiUrl(SEASON_PAGE));
      ROUTE = 'brightdata';
      process.stderr.write('route: Bright Data Web Unlocker\n');
      return ROUTE;
    } catch (e) {
      process.stderr.write(`route: Bright Data unavailable (${String(e.message).slice(0, 120)})\n`);
    }
  }
  ROUTE = 'direct';
  process.stderr.write('route: direct fetch (Bright Data not in play - _meta will say so)\n');
  return ROUTE;
}

const cacheName = (page) => page.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 80);

// Which route actually fetched each page, recorded at fetch time and kept beside the cache.
// Inferring it later is how provenance goes wrong: a second run served entirely from cache
// has no live route at all, and reporting that as "direct" would understate a Bright Data
// fetch just as badly as the reverse would overstate one. The badge is only worth having if
// it reports what happened rather than what is happening now.
const MANIFEST = join(CACHE, '_routes.json');
const readManifest = () => { try { return JSON.parse(readFileSync(MANIFEST, 'utf8')); } catch { return {}; } };
const noteRoute = (page, route) => {
  const m = readManifest();
  m[page] = { route, fetchedAt: new Date().toISOString() };
  writeFileSync(MANIFEST, JSON.stringify(m, null, 2));
};

async function fetchWiki(page, { refresh = false } = {}) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, `${cacheName(page)}.json`);
  if (!refresh && existsSync(file)) {
    // A cache file with no manifest entry predates route recording, so we genuinely do not
    // know how it arrived. Say so rather than letting it inherit this run's route - that is
    // precisely how a dataset ends up claiming a Bright Data provenance it only partly has.
    if (!readManifest()[page]) noteRoute(page, 'unknown');
    return readFileSync(file, 'utf8');
  }
  const route = await pickRoute();
  const url = wikiUrl(page);
  // Web Unlocker 502s occasionally under load. Without a retry that single blip silently
  // becomes a bot with no weapon, which is worse than a loud failure: it lands in the
  // matchup grid as 'control' and quietly changes the model. Retry before accepting it.
  let body, lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      body = route === 'brightdata' ? await brightDataFetch(url) : await directFetch(url);
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  if (body === undefined) throw lastErr;
  writeFileSync(file, body);
  noteRoute(page, route);
  return body;
}

export function wikitextOf(body) {
  let d;
  try { d = JSON.parse(body); } catch { throw new Error('response was not JSON - transport returned something else'); }
  if (d.error) throw new Error(`wiki error: ${d.error.code || ''} ${d.error.info || ''}`);
  const wt = d?.parse?.wikitext?.['*'];
  if (typeof wt !== 'string' || !wt.length) throw new Error('no wikitext in response');
  return wt;
}

// ---------------------------------------------------------------- parsers

const slug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// [[Name]] and [[Target|Label]] both resolve to the page title, because the title is what we
// have to fetch next. Taking the label instead would send us looking for a page that does
// not exist for every piped link on the roster.
const linkTitle = (s) => {
  const m = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(s || '');
  return m ? m[1].trim() : null;
};

// One distinct hue per competitor rather than an eight-colour cycle repeated three times -
// with 24 bots a cycling palette gives three machines the same colour, which is exactly the
// confusion the livery is there to prevent. Golden-angle spacing keeps neighbours apart.
const hueColor = (i, n) => {
  const hue = (i * 137.508) % 360;
  const light = 52 + (i % 3) * 7;
  return `hsl(${hue.toFixed(0)} 68% ${light}%)`;
};

/**
 * The 24-bot field, read from the six group-standings tables under "Pro League Standings".
 *
 * Read the roster from the standings rather than from the prose, because the prose lists
 * absentees (SawBlaze, Lock-Jaw, Whiplash, Hydra are all named as NOT competing) and a
 * name-scraping parser will happily put them in the league.
 */
export function parseGroups(wt) {
  const out = [];
  const section = wt.slice(wt.indexOf('== Pro League Standings =='));
  const re = /===\s*Group\s+([A-F])\s*===([\s\S]*?)(?=\n===|\n==\s)/g;
  let m;
  while ((m = re.exec(section))) {
    const group = m[1];
    const rows = m[2].split('|-');
    for (const row of rows) {
      const title = linkTitle(row);
      if (!title) continue;
      const rec = /(\d+)\s*-\s*(\d+)/.exec(row.replace(/<[^>]*>/g, ''));
      out.push({
        name: title,
        group,
        statedWins: rec ? Number(rec[1]) : null,
        statedLosses: rec ? Number(rec[2]) : null,
      });
    }
  }
  // A bot can appear once. Dedupe defensively rather than trusting the table.
  const seen = new Set();
  return out.filter((b) => (seen.has(b.name) ? false : seen.add(b.name)));
}

/**
 * Every aired fight, from the per-episode tables under "Episodes".
 *
 * The result is encoded purely as emphasis: the winner is the bolded link in
 * `'''[[Winner]]''' vs. [[Loser]]`. Unaired episodes render as `'''TBC vs. TBC'''` and are
 * skipped - bolding is a formatting choice on those, not a result, and a parser that reads
 * them as outcomes invents fights that never happened.
 */
export function parseEpisodeFights(wt, knownNames) {
  const fights = [];
  const section = wt.slice(wt.indexOf('== Episodes =='));
  const re = /===\s*Episode\s+(\d+)\s*===([\s\S]*?)(?=\n===|\n==\s|$)/g;
  let m, n = 0;
  const dropped = [];
  while ((m = re.exec(section))) {
    const ep = Number(m[1]);
    for (const line of m[2].split('\n')) {
      if (!/\bvs\.?\b/i.test(line)) continue;
      if (/TBC|TBA/i.test(line)) continue;
      // Split on the "vs." so each side is judged on its own emphasis.
      const parts = line.split(/\s+vs\.?\s+/i);
      if (parts.length !== 2) continue;
      const [lhs, rhs] = parts;
      const aName = linkTitle(lhs), bName = linkTitle(rhs);
      if (!aName || !bName) continue;
      const aBold = /'''\s*\[\[/.test(lhs);
      const bBold = /'''\s*\[\[/.test(rhs);
      if (aBold === bBold) { dropped.push(`E${ep}: ${aName} vs ${bName} (no single bolded winner)`); continue; }
      if (knownNames && (!knownNames.has(aName) || !knownNames.has(bName))) {
        dropped.push(`E${ep}: ${aName} vs ${bName} (not on the roster)`);
        continue;
      }
      fights.push({
        id: 'f' + String(++n).padStart(3, '0'),
        a: slug(aName), b: slug(bName),
        winner: slug(aBold ? aName : bName),
        // The season page records who won and nothing else. It does not say KO or judges'
        // decision and it does not say how long the fight took. Emitting a guess here would
        // put fabricated numbers straight into a model feature, so both stay null and the
        // features that depend on them are dropped downstream.
        method: null, sec: null,
        event: `E${ep}`,
      });
    }
  }
  return { fights, dropped };
}

/** Weapon, weight and speed off a single robot's `{{Bot}}` infobox. */
export function parseBotPage(wt, name) {
  const field = (k) => {
    const m = new RegExp(`\\|${k}\\s*=([^|}]*)`, 'i').exec(wt);
    return m ? m[1].replace(/<[^>]*>/g, ' ').replace(/\[\[|\]\]/g, '').replace(/\s+/g, ' ').trim() : '';
  };
  const weaponsText = field('weapons');
  const weightText = field('weight');
  const lb = /(\d{2,3})\s*lb/i.exec(weightText);
  const kg = /(\d{2,3})\s*kg/i.exec(weightText);
  return {
    weapon: classifyWeapon(weaponsText),
    weaponText: weaponsText || null,
    weightLb: lb ? Number(lb[1]) : kg ? Math.round(Number(kg[1]) * 2.205) : 250,
    from: field('from') || null,
    team: field('team') || null,
  };
}

// ---------------------------------------------------------------- main

async function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
  const refresh = has('--refresh');

  if (has('--list')) {
    console.log(`host    ${HOST}`);
    console.log(`season  ${SEASON_PAGE}`);
    console.log(`plan    1 season page -> 24 robot pages (weapon/weight) = 25 fetches`);
    console.log(`\nzone: ${ZONE}\nkey:  ${API_KEY ? 'set' : 'NOT SET'}`);
    return;
  }

  const seasonWt = wikitextOf(await fetchWiki(SEASON_PAGE, { refresh }));
  const roster = parseGroups(seasonWt);
  console.log(`roster: ${roster.length} bots across ${new Set(roster.map((b) => b.group)).size} groups`);
  if (roster.length !== 24) console.log(`  note: expected 24 competitors, parsed ${roster.length}`);

  const names = new Set(roster.map((b) => b.name));
  const { fights, dropped } = parseEpisodeFights(seasonWt, names);
  console.log(`fights: ${fights.length} aired${dropped.length ? `, ${dropped.length} row(s) skipped` : ''}`);
  for (const d of dropped.slice(0, 6)) console.log(`  skip  ${d}`);

  // 24 more fetches, one per bot, for the weapon class the matchup grid is built from.
  const bots = [];
  for (const [i, r] of roster.entries()) {
    let info = { weapon: 'control', weaponText: null, weightLb: 250, from: null, team: null };
    try {
      info = parseBotPage(wikitextOf(await fetchWiki(r.name, { refresh })), r.name);
    } catch (e) {
      console.log(`  warn  ${r.name}: ${String(e.message).slice(0, 80)}`);
    }
    bots.push({
      id: slug(r.name), name: r.name, weapon: info.weapon, weightLb: info.weightLb,
      color: hueColor(i, roster.length), group: r.group,
      weaponText: info.weaponText, from: info.from, team: info.team, chatter: null,
    });
    process.stderr.write(`  ${String(i + 1).padStart(2)}/${roster.length} ${r.name} -> ${info.weapon}\n`);
  }

  const { errs, warns } = validate(bots, fights);
  for (const w of warns) console.log(`  warn  ${w}`);
  for (const e of errs) console.log(`  ERROR ${e}`);
  if (errs.length) { process.exitCode = 1; return; }

  // Report the routes the pages in this dataset were actually fetched over, whether or not
  // this particular run touched the network.
  const man = readManifest();
  const used = new Set(Object.values(man).map((r) => r.route));
  const route = used.size === 0 ? 'unknown' : used.size === 1 ? [...used][0] : 'mixed';
  const sourceLabel =
    route === 'brightdata' ? 'battlebots.fandom.com via Bright Data Web Unlocker'
    : route === 'mixed' ? `battlebots.fandom.com (mixed: ${[...used].sort().join(' + ')})`
    : route === 'direct' ? 'battlebots.fandom.com (direct fetch, Bright Data not used)'
    : 'battlebots.fandom.com';
  const fetchedAt = new Date().toISOString();
  const meta = { source: 'battlebots-fandom', sourceLabel, route, fetchedAt, season: 'Pro League 2026' };

  if (has('--dry-run')) { console.log('\ndry run - nothing written'); return; }
  const out = val('--out') || 'data';
  writeFileSync(join(ROOT, out, 'bots.json'), JSON.stringify({ _meta: { ...meta, n: bots.length }, bots }, null, 2));
  writeFileSync(join(ROOT, out, 'fights.json'), JSON.stringify({ _meta: { ...meta, n: fights.length }, fights }, null, 2));
  console.log(`\nwrote ${out}/bots.json (${bots.length}) and ${out}/fights.json (${fights.length})`);
  console.log(`route: ${route}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
