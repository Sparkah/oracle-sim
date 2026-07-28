#!/usr/bin/env node
/**
 * X (Twitter) -> fan chatter per bot, merged into data/bots.json
 *
 *   node scrape/x_chatter.mjs                  # trigger a fresh collection, poll, merge
 *   node scrape/x_chatter.mjs --snapshot sd_x  # reuse a snapshot already collected
 *
 * WHY THIS IS A DIFFERENT PRODUCT TO THE REST OF THE SCRAPE
 *
 * Web Unlocker handles battlebots.fandom.com and gamma-api.polymarket.com fine, but answers
 * x.com, reddit.com and youtube.com with:
 *
 *   "Requested site is not available for immediate access mode in accordance with robots.txt"
 *
 * That is not a bug and not an IP problem - adding an IP to the allowlist changes nothing.
 * The big social platforms are carved out of Web Unlocker's immediate-access mode and served
 * by the dedicated Scraper API datasets instead. So X goes through the dataset trigger/poll
 * API, not through /request.
 *
 * The X Posts dataset discovers by PROFILE, not by keyword - the API reports its own allowed
 * types as `profile_url` and `profiles_array`. There is no keyword search here, so the fan
 * chatter is whatever the league and team accounts posted, not a search of the whole network.
 * That is a real limitation and it is stated in _meta rather than glossed over.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scrape', '.cache');
const API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const DATASET = 'gd_lwxkxvnf1cynvib9co';       // "X (formerly Twitter) - Posts"

const PROFILES = [
  'https://x.com/BattleBots',
  'https://x.com/BattleBotsAdam',
  'https://x.com/RobotCombat',
];

const auth = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trigger() {
  const body = PROFILES.map((url) => ({ url, num_of_posts: 40, start_date: '', end_date: '' }));
  const res = await fetch(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${DATASET}&include_errors=true&type=discover_new&discover_by=profile_url`,
    { method: 'POST', headers: auth, body: JSON.stringify(body) },
  );
  const j = await res.json();
  if (!j.snapshot_id) throw new Error(`trigger failed: ${JSON.stringify(j).slice(0, 300)}`);
  return j.snapshot_id;
}

async function waitReady(snap, { tries = 20, gap = 12000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const st = await (await fetch(`https://api.brightdata.com/datasets/v3/progress/${snap}`, { headers: auth })).json();
    process.stderr.write(`  ${st.status}${st.records != null ? ` (${st.records} records)` : ''}\n`);
    if (st.status === 'ready') return st;
    if (st.status === 'failed') throw new Error('collection failed');
    await sleep(gap);
  }
  throw new Error('timed out waiting for snapshot');
}

const download = async (snap) =>
  (await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${snap}?format=json`, { headers: auth })).json();

// Count a bot as mentioned when its name appears as a whole phrase, case-insensitively.
// Substring matching would have "Huge" fire on the word huge in ordinary prose, which is
// exactly the kind of silent inflation that makes a sentiment number meaningless.
function countMentions(posts, bots) {
  const tally = Object.fromEntries(bots.map((b) => [b.id, { mentions: 0, likes: 0, views: 0 }]));
  for (const p of posts) {
    const text = `${p.description || p.text || ''} ${(p.hashtags || []).join(' ')}`;
    if (!text.trim()) continue;
    for (const b of bots) {
      const esc = b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i').test(text)) continue;
      const t = tally[b.id];
      t.mentions++;
      t.likes += Number(p.likes) || 0;
      t.views += Number(p.views) || 0;
    }
  }
  return tally;
}

async function main() {
  const argv = process.argv.slice(2);
  const given = (() => { const i = argv.indexOf('--snapshot'); return i >= 0 ? argv[i + 1] : null; })();
  if (!API_KEY) throw new Error('BRIGHTDATA_API_KEY is not set');

  let snap = given;
  if (!snap) { process.stderr.write('triggering X collection\n'); snap = await trigger(); process.stderr.write(`  snapshot ${snap}\n`); await waitReady(snap); }

  const raw = await download(snap);
  const rows = (Array.isArray(raw) ? raw : raw.data || []).filter((r) => !r.error);
  console.log(`X posts collected: ${rows.length}`);
  if (existsSync(CACHE)) writeFileSync(join(CACHE, 'x_posts.json'), JSON.stringify(rows, null, 2));

  const botDoc = JSON.parse(readFileSync(join(ROOT, 'data/bots.json'), 'utf8'));
  const tally = countMentions(rows, botDoc.bots);

  let hit = 0;
  for (const b of botDoc.bots) {
    const t = tally[b.id];
    // No mentions means no chatter, not zero sentiment. Leave it null so the UI shows a dash
    // rather than implying we measured indifference.
    b.chatter = t.mentions ? { mentions: t.mentions, likes: t.likes, views: t.views } : null;
    if (t.mentions) hit++;
  }
  botDoc._meta.chatter = {
    source: 'x.com via Bright Data Scraper API (dataset ' + DATASET + ')',
    snapshot: snap,
    posts: rows.length,
    profiles: PROFILES,
    fetchedAt: new Date().toISOString(),
    caveat: 'The X Posts dataset discovers by profile, not keyword, so this is league/team account output rather than a search of all of X. Mention counts are whole-word name matches.',
  };
  writeFileSync(join(ROOT, 'data/bots.json'), JSON.stringify(botDoc, null, 2));
  console.log(`merged chatter into data/bots.json - ${hit} of ${botDoc.bots.length} bots mentioned`);

  const top = botDoc.bots.filter((b) => b.chatter).sort((a, b) => b.chatter.mentions - a.chatter.mentions).slice(0, 8);
  for (const b of top) console.log(`  ${String(b.chatter.mentions).padStart(3)} mentions  ${b.name}  (${b.chatter.views.toLocaleString()} views)`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
