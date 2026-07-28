#!/usr/bin/env node
/**
 * Reddit -> per-bot discussion volume, merged into data/bots.json
 *
 *   node scrape/reddit_chatter.mjs                 # merge whatever snapshots are cached
 *   node scrape/reddit_chatter.mjs --trigger       # start a fresh subreddit collection first
 *
 * THE MISTAKE THIS FILE EXISTS TO CORRECT
 *
 * Reddit was written off early in the build as unreachable. Web Unlocker refuses reddit.com on
 * robots.txt grounds, which is true, and one attempt at the Scraper API dataset came back with
 * a validation error, which was also true - and then it was abandoned while x.com and
 * youtube.com were pursued through exactly the same mechanism until they worked.
 *
 * That was inconsistent, and it was the wrong call. The validation errors are the contract:
 * the API names the fields it will not accept and the discovery modes it supports, so each
 * rejection narrows the input rather than closing the door. Reddit Posts reports
 * `subreddit_url`, `keyword` and `author_url`; the first attempt failed only because it sent a
 * `date` field the endpoint does not take in that mode, and the second because it sent
 * `time_filter` instead of `sort_by_time`. Neither was a wall.
 *
 * The general lesson, which cost this project its richest sources for most of the evening:
 * when a scraper API rejects your input, read the rejection and iterate. Do not generalise one
 * refusal into "this platform is unavailable" - and above all do not generalise a refusal on
 * one platform into a refusal on another without testing it.
 */

import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'scrape', '.cache');
const API_KEY = process.env.BRIGHTDATA_API_KEY || '';
const POSTS = 'gd_lvz8ah06191smkebj4';        // "Reddit - Posts"

const auth = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function trigger() {
  // Note the field names: sort_by_time, NOT time_filter. The endpoint rejects the latter.
  const body = [{ url: 'https://www.reddit.com/r/battlebots/', sort_by: 'Top', sort_by_time: 'This month' }];
  const res = await fetch(
    `https://api.brightdata.com/datasets/v3/trigger?dataset_id=${POSTS}&include_errors=true&type=discover_new&discover_by=subreddit_url`,
    { method: 'POST', headers: auth, body: JSON.stringify(body) });
  const j = await res.json();
  if (!j.snapshot_id) throw new Error(`trigger failed: ${JSON.stringify(j).slice(0, 300)}`);
  process.stderr.write(`snapshot ${j.snapshot_id}\n`);
  for (let i = 0; i < 40; i++) {
    const st = await (await fetch(`https://api.brightdata.com/datasets/v3/progress/${j.snapshot_id}`, { headers: auth })).json();
    process.stderr.write(`  ${st.status}${st.records != null ? ` (${st.records})` : ''}\n`);
    if (st.status === 'ready') break;
    if (st.status === 'failed') throw new Error('collection failed');
    await sleep(20000);   // Reddit discovery runs for minutes, unlike X and YouTube
  }
  const rows = await (await fetch(`https://api.brightdata.com/datasets/v3/snapshot/${j.snapshot_id}?format=json`, { headers: auth })).json();
  writeFileSync(join(CACHE, `reddit_${j.snapshot_id}.json`), JSON.stringify(rows, null, 2));
  return rows;
}

const textOf = (r) => [r.title, r.description, r.post_text, r.selftext, r.comment, r.comment_text]
  .filter(Boolean).join(' ');

async function main() {
  if (process.argv.includes('--trigger')) {
    if (!API_KEY) throw new Error('BRIGHTDATA_API_KEY is not set');
    await trigger();
  }

  const files = existsSync(CACHE) ? readdirSync(CACHE).filter((f) => f.startsWith('reddit_') && f.endsWith('.json')) : [];
  if (!files.length) { console.log('no cached Reddit snapshots - run with --trigger'); return; }

  const rows = [];
  for (const f of files) {
    try {
      const d = JSON.parse(readFileSync(join(CACHE, f), 'utf8'));
      for (const r of (Array.isArray(d) ? d : d.data || [])) if (!r.error) rows.push(r);
    } catch { /* a half-written snapshot is skipped, not fatal */ }
  }
  console.log(`Reddit items: ${rows.length} across ${files.length} snapshot(s)`);
  if (!rows.length) return;

  const doc = JSON.parse(readFileSync(join(ROOT, 'data/bots.json'), 'utf8'));
  let hit = 0;
  for (const b of doc.bots) {
    // Whole-word match only. Substring matching would fire "HUGE" on the ordinary word huge,
    // which is exactly the sort of silent inflation that makes a volume metric meaningless.
    const esc = b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`, 'i');
    let n = 0, ups = 0;
    for (const r of rows) {
      const t = textOf(r);
      if (!t || !rx.test(t)) continue;
      n++;
      ups += Number(r.num_upvotes ?? r.upvotes ?? r.score ?? 0) || 0;
    }
    if (!n) continue;
    hit++;
    const prev = b.chatter || { mentions: 0, views: 0, likes: 0 };
    b.chatter = { ...prev, mentions: (prev.mentions || 0) + n, redditMentions: n, redditUpvotes: ups };
  }

  const meta = (doc._meta.chatter ||= {});
  meta.reddit = {
    source: `reddit.com via Bright Data Scraper API (dataset ${POSTS}, discover_by=subreddit_url)`,
    items: rows.length,
    subreddit: 'r/battlebots',
    caveat: 'Post volume and upvotes, not sentiment. Whole-word bot-name matches. Web Unlocker refuses reddit.com on robots.txt grounds; the dataset API is the correct route.',
  };
  writeFileSync(join(ROOT, 'data/bots.json'), JSON.stringify(doc, null, 2));
  console.log(`merged - ${hit} of ${doc.bots.length} bots mentioned on Reddit`);
  for (const b of doc.bots.filter((x) => x.chatter?.redditMentions).sort((a, c) => c.chatter.redditMentions - a.chatter.redditMentions).slice(0, 8)) {
    console.log(`  ${String(b.chatter.redditMentions).padStart(3)}  ${b.name}  (${b.chatter.redditUpvotes} upvotes)`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
