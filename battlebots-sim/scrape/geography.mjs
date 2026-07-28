#!/usr/bin/env node
/**
 * Where the Pro League actually comes from -> data/geography.json
 *
 *   node scrape/geography.mjs
 *
 * Every competitor's wiki page carries a `from=` field, and the roster crawl was already
 * reading it - it just went into bots.json and was never used. So this costs no requests at
 * all: it is the same 25 cached pages, read for a field nobody had looked at.
 *
 * The parsing problem worth flagging: a team that has relocated lists every era it has run,
 * e.g. "Berkeley, CA (BB FaceOffs-Present) Somerville, MA (WC IV-Champions II) Cambridge, MA
 * (WC III)". Taking the first match would file Valkyrie under whichever era the wiki happens
 * to list first. Where an era is marked Present, that clause wins.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const US_STATE = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho',
  IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'Washington DC',
};

// A two-letter code is not automatically American. Brazil and Canada write their states and
// provinces the same way, and treating "Rio de Janeiro, RJ" as a US state files Minotaur under
// a country it has never competed for.
const NON_US = {
  ON: ['Ontario', 'Canada'], BC: ['British Columbia', 'Canada'], AB: ['Alberta', 'Canada'],
  QC: ['Quebec', 'Canada'], MB: ['Manitoba', 'Canada'], SK: ['Saskatchewan', 'Canada'],
  NS: ['Nova Scotia', 'Canada'], NB: ['New Brunswick', 'Canada'], NL: ['Newfoundland', 'Canada'],
  RJ: ['Rio de Janeiro', 'Brazil'], SP: ['Sao Paulo', 'Brazil'], MG: ['Minas Gerais', 'Brazil'],
  RS: ['Rio Grande do Sul', 'Brazil'], PR: ['Parana', 'Brazil'], BA: ['Bahia', 'Brazil'],
  SC: ['Santa Catarina', 'Brazil'],
};

/** Current home town for a bot, ignoring the eras it has since moved on from. */
export function currentOrigin(raw) {
  if (!raw) return null;
  let t = String(raw).replace(/\s+/g, ' ').trim();
  if (/present/i.test(t)) {
    const clauses = t.split(/(?<=\))\s*/).filter((c) => /present/i.test(c));
    if (clauses.length) t = clauses[0];
  } else {
    // No "present" marker: take the first clause before any parenthesised era.
    t = t.split(/\s*\(/)[0];
  }
  t = t.replace(/\([^)]*\)/g, '').trim().replace(/[,;]$/, '');

  const us = /([A-Za-z .'-]+),\s*([A-Z]{2})\b/.exec(t);
  if (us) {
    const code = us[2];
    // SC is ambiguous (South Carolina vs Santa Catarina). Only treat a code as non-US when the
    // string carries no other US signal - otherwise the US reading wins, which is right far
    // more often for this league.
    if (NON_US[code] && !(code === 'SC' && !/brazil/i.test(t))) {
      const [region, country] = NON_US[code];
      return { city: us[1].trim(), region, code, country, raw };
    }
    return { city: us[1].trim(), region: US_STATE[code] || code, code, country: 'USA', raw };
  }
  // Non-US entries are written as "City, Country".
  const other = /([A-Za-z .'-]+),\s*([A-Za-z .'-]+)$/.exec(t);
  if (other) return { city: other[1].trim(), region: other[2].trim(), code: null, country: other[2].trim(), raw };
  return { city: null, region: t || null, code: null, country: t || null, raw };
}

function main() {
  const doc = JSON.parse(readFileSync(join(ROOT, 'data/bots.json'), 'utf8'));
  const rows = [];
  for (const b of doc.bots) {
    const o = currentOrigin(b.from);
    rows.push({ id: b.id, name: b.name, team: b.team || null, from: b.from || null, origin: o });
  }

  const known = rows.filter((r) => r.origin && r.origin.region);
  const byRegion = {};
  for (const r of known) {
    const k = r.origin.country === 'USA' ? r.origin.region : r.origin.country;
    (byRegion[k] ||= []).push(r.name);
  }
  const byCountry = {};
  for (const r of known) (byCountry[r.origin.country] ||= []).push(r.name);

  const ranked = Object.entries(byRegion).sort((a, b) => b[1].length - a[1].length);

  const out = {
    _meta: {
      source: 'battlebots-fandom',
      sourceLabel: 'battlebots.fandom.com competitor pages via Bright Data Web Unlocker',
      derivedFrom: 'the `from=` field of each robot\'s {{Bot}} infobox, on the same 25 pages as the roster',
      requests: 0,
      known: known.length,
      total: rows.length,
      caveat: 'Team home town, which is not the same thing as where the audience is. Teams that have relocated list several eras; the one marked Present wins.',
    },
    bots: rows,
    byRegion: Object.fromEntries(ranked),
    byCountry,
  };
  writeFileSync(join(ROOT, 'data/geography.json'), JSON.stringify(out, null, 2));

  console.log(`origins resolved for ${known.length} of ${rows.length} competitors\n`);
  for (const [region, names] of ranked) {
    console.log(`  ${String(names.length).padStart(2)}  ${region.padEnd(16)} ${names.join(', ')}`);
  }
  console.log('\nby country:');
  for (const [c, names] of Object.entries(byCountry).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(names.length).padStart(2)}  ${c}`);
  }
  const missing = rows.filter((r) => !r.origin || !r.origin.region).map((r) => r.name);
  if (missing.length) console.log(`\nno origin on the page: ${missing.join(', ')}`);
}

main();
