#!/usr/bin/env node
/**
 * Seed discovery for motor.no (Labrador CMS).
 *
 * Every tag page exposes its full article list as JSON when you append
 * `?lab_viewport=json` (no pagination, no login). We pull a generous set of
 * tyre-related tags + brand tags, union the results and keep the ones that look
 * tyre-related. Output: crawler/seeds/motor-tags.json  (array of teaser objects
 * straight from Labrador: id, url, title, kicker, seoTitle, description, tags,
 * section, published, paywall, motor_testresult…)
 *
 * Sub-articles (one per tyre) are usually NOT tagged, so this is only the seed;
 * crawler/ingest.mjs follows links from fetched pages to find the rest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'seeds', 'motor-tags.json');
const UA = 'dekk-tester crawler (hobby project; contact: tommy.leonhardsen@q-free.com)';

const TAGS = [
  'dekktester', 'dekktest', 'dekk', 'vinterdekk', 'sommerdekk', 'piggdekk', 'piggfrie', 'piggfritt',
  'helårsdekk', 'helarsdekk', 'vinterdekktest', 'sommerdekktest', 'test', 'tester',
  'vinterdekk2026', 'vinterdekk2025', 'vinterdekk2024', 'sommerdekk2026', 'sommerdekk2025', 'sommerdekk2024',
  'nokian', 'michelin', 'continental', 'bridgestone', 'goodyear', 'pirelli', 'hankook', 'kumho', 'nexen',
  'nankang', 'nordman', 'gislaved', 'vredestein', 'falken', 'yokohama', 'toyo', 'firestone', 'dunlop',
  'sava', 'linglong', 'landsail', 'triangle', 'goodride', 'maxxis', 'mazzini', 'radar', 'greenmax', 'leao', 'sailun',
  'hakkapeliitta', 'hakkapeliitta 01',
];

const TYRE_RX = /dekk|pigg|hakkapel|d[äa]ck|tyre|tire|vinterdekk|sommerdekk/i;

async function fetchTag(tag) {
  const url = `https://www.motor.no/tag/${encodeURIComponent(tag)}?lab_viewport=json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j.result) ? j.result : [];
}

const all = new Map();
for (const tag of TAGS) {
  const res = await fetchTag(tag).catch(e => { console.error('!', tag, e.message); return []; });
  for (const x of res) if (x && x.id && x.type === 'article') all.set(x.id, x);
  console.log(String(res.length).padStart(4), tag);
  await new Promise(r => setTimeout(r, 250));
}
const hay = x => [x.title, x.seoTitle, x.kicker, x.description, x.url, ...(x.tags || [])].join(' ');
const tyre = [...all.values()].filter(x => TYRE_RX.test(hay(x)));
// Strip the bulky teaser image/metadata noise; keep what the parser needs.
const slim = tyre.map(x => ({
  id: x.id, url: x.url, section: x.section, published: x.published, paywall: !!x.paywall,
  title: x.title, kicker: x.kicker, seoTitle: x.seoTitle, description: x.description,
  byline: x.byline, tags: x.tags, motor_testresult: x.motor_testresult ?? null,
})).sort((a, b) => a.published.localeCompare(b.published));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(slim, null, 1));
console.log(`union ${all.size} articles, ${slim.length} tyre-related -> ${path.relative(process.cwd(), OUT)}`);
