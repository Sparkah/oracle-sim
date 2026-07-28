#!/usr/bin/env node
/**
 * Polymarket -> data/polymarket.json
 *
 *   node scrape/polymarket.mjs --out data
 *
 * Two jobs, and it is worth being blunt about which is which.
 *
 * 1. LIVE MARKETS. Polymarket's Gamma API is public and unauthenticated, so we pull real
 *    open markets with real prices. These are genuine. The point of showing them is that the
 *    odds engine in js/betting.js can price a real prediction market, not just our own book.
 *
 * 2. THE PORT. There is no BattleBots market on Polymarket - I searched for "battlebots",
 *    "robot" and "robot combat" and the only robot markets are Figure and Tesla Optimus ones.
 *    So the Pro League fights are emitted in Polymarket's own market shape, priced by our
 *    model. That is a listing proposal, NOT a live market, and it is labelled that way
 *    everywhere it surfaces. Presenting model prices as market prices would be the single
 *    fastest way to lose an engineering-judged room.
 *
 * Fetched through Bright Data when a zone is available, direct otherwise, with the route
 * recorded either way.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { train } from '../js/model.js';
import { offeredOdds, impliedProb, kelly, VIG } from '../js/betting.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const ZONE = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
const GAMMA = 'https://gamma-api.polymarket.com';

async function brightDataFetch(url) {
  const res = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ zone: ZONE, url, format: 'raw' }),
  });
  if (!res.ok) throw new Error(`Bright Data ${res.status}`);
  return res.text();
}

async function get(url) {
  if (API_KEY) {
    try { return { body: await brightDataFetch(url), route: 'brightdata' }; }
    catch (e) { process.stderr.write(`  bright data failed (${String(e.message).slice(0, 60)}), falling back\n`); }
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`direct ${res.status}`);
  return { body: await res.text(), route: 'direct' };
}

// Polymarket returns outcomes/outcomePrices as JSON-encoded strings inside the JSON. Parse
// defensively - a market with a malformed pair is skipped rather than shown at a wrong price.
const parseMaybe = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; }
};

async function main() {
  const argv = process.argv.slice(2);
  const out = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : 'data'; })();

  process.stderr.write('fetching live Polymarket markets\n');
  const { body, route } = await get(`${GAMMA}/markets?limit=250&closed=false&active=true&order=volumeNum&ascending=false`);
  const raw = JSON.parse(body);
  const list = Array.isArray(raw) ? raw : (raw.data || []);

  const live = [];
  for (const m of list) {
    const outcomes = parseMaybe(m.outcomes);
    const prices = parseMaybe(m.outcomePrices);
    if (!outcomes || !prices || outcomes.length !== prices.length || outcomes.length !== 2) continue;
    const p = Number(prices[0]);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
    // Sorting by volume alone surfaces enormous longshot markets priced at 0-2%, which look
    // broken next to a fight prediction. Keep genuinely contested ones - those are the only
    // markets where a pricing engine has anything to say.
    if (p < 0.12 || p > 0.88) continue;
    live.push({
      id: String(m.id), question: m.question, slug: m.slug,
      outcomes, prices: prices.map(Number),
      // What the market's own price implies, and the decimal odds a bettor faces.
      impliedYes: p,
      oddsYes: 1 / p, oddsNo: 1 / (1 - p),
      volume: Number(m.volumeNum ?? m.volume ?? 0),
      liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
      endDate: m.endDate || m.endDateIso || null,
      url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
    });
    if (live.length >= 12) break;
  }
  process.stderr.write(`  ${live.length} live two-outcome markets\n`);

  // The port: our fights, in their shape.
  const { bots } = JSON.parse(readFileSync(join(ROOT, 'data/bots.json'), 'utf8'));
  const { fights } = JSON.parse(readFileSync(join(ROOT, 'data/fights.json'), 'utf8'));
  const model = train(bots, fights);
  const name = Object.fromEntries(bots.map((b) => [b.id, b.name]));

  // Every remaining pairing the league could still stage, priced by the model. Capped so the
  // payload stays small; the full grid is 24*23/2 = 276.
  const played = new Set(fights.map((f) => [f.a, f.b].sort().join('|')));
  const proposed = [];
  // Walk the grid on a stride rather than row by row. Taking the first N pairs in order gives
  // twenty-four markets that all start with the same bot, which reads as a broken generator.
  for (let gap = 1; gap < bots.length && proposed.length < 24; gap++) {
    for (let i = 0; i < bots.length && proposed.length < 24; i++) {
      const j = (i + gap) % bots.length;
      if (j <= i) continue;
      const a = bots[i], b = bots[j];
      if (played.has([a.id, b.id].sort().join('|'))) continue;
      const { p } = model.predict(a.id, b.id);
      proposed.push({
        // Polymarket's own market shape, so this is a listing payload rather than a mockup.
        question: `Will ${a.name} beat ${b.name} in BattleBots Pro League 2026?`,
        slug: `battlebots-pro-league-${a.id}-vs-${b.id}`,
        outcomes: ['Yes', 'No'],
        outcomePrices: [p.toFixed(3), (1 - p).toFixed(3)],
        oddsYes: Number(offeredOdds(p).toFixed(3)),
        oddsNo: Number(offeredOdds(1 - p).toFixed(3)),
        a: a.id, b: b.id, aName: name[a.id], bName: name[b.id],
        modelProb: Number(p.toFixed(4)),
      });
    }
  }

  const doc = {
    _meta: {
      source: 'polymarket-gamma',
      sourceLabel: route === 'brightdata'
        ? 'gamma-api.polymarket.com via Bright Data' : 'gamma-api.polymarket.com (direct)',
      route,
      fetchedAt: new Date().toISOString(),
      vig: VIG,
      // Said once, here, so every consumer of this file inherits the caveat.
      note: 'live[] are real open Polymarket markets. proposed[] are OUR model prices in Polymarket market format - no BattleBots market exists on Polymarket, these are a listing proposal, not traded prices.',
    },
    live,
    proposed,
  };
  writeFileSync(join(ROOT, out, 'polymarket.json'), JSON.stringify(doc, null, 2));
  console.log(`wrote ${out}/polymarket.json - ${live.length} live markets, ${proposed.length} proposed Pro League markets`);
  console.log(`route: ${route}`);
  if (live.length) {
    console.log('\nlive sample:');
    for (const m of live.slice(0, 5)) {
      console.log(`  ${(m.impliedYes * 100).toFixed(0)}%  ${m.question.slice(0, 62)}  (vol ${Math.round(m.volume).toLocaleString()})`);
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
