#!/usr/bin/env node
/**
 * motor.no crawler — fetches article HTML through the Chrome DevTools MCP browser.
 *
 * Why a browser: the test articles are behind NAF's paywall. The only session we
 * hold is the one in the Chrome that the `chrome-devtools` CLI (chrome-devtools-mcp)
 * controls, where the user has logged in by hand. We run `fetch()` *inside* a
 * motor.no tab so the Paywall-Token cookie rides along. No credentials ever touch
 * this repo, and nothing here reads or stores the cookie.
 *
 * Prereq: `npm i -g chrome-devtools-mcp`, then in the CLI's Chrome window log in on
 * motor.no (NAF member). `chrome-devtools list_pages` must show a motor.no tab;
 * we select the first one we find (or open one).
 *
 * Discovery: seeds come from crawler/seeds/motor-tags.json (see discover-tags.mjs).
 * The per-tyre sub-articles are usually untagged, so we follow in-article links
 * for a couple of rounds. Sidebar/nav links (the same ~20 links on every page)
 * are filtered by frequency: anything linked from more than
 * max(25, 10 % of fetched pages) pages is treated as chrome, not content.
 *
 * Usage:
 *   node crawler/crawl.mjs [--out crawler/raw] [--depth 2] [--batch 12]
 *                          [--delay-ms 300] [--max 1500] [--refetch]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes(n);

const OUT = path.resolve(root, opt('--out', 'crawler/raw'));
const DEPTH = Number(opt('--depth', 2));
const BATCH = Number(opt('--batch', 12));
const DELAY = Number(opt('--delay-ms', 300));
const MAX = Number(opt('--max', 1500));
const REFETCH = flag('--refetch');
const SEEDS = path.join(here, 'seeds', 'motor-tags.json');
const MANIFEST = path.join(OUT, 'manifest.json');
const LOGIN_PROBE = 'https://www.motor.no/tester/motors-vinterdekktest-2026-de-beste-piggdekkene/367185';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dekk-crawl-'));

// ---- chrome-devtools CLI plumbing --------------------------------------------
const CLI = (() => {
  const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true }).stdout.trim();
  const p = path.join(npmRoot, 'chrome-devtools-mcp', 'build', 'src', 'bin', 'chrome-devtools.js');
  if (!fs.existsSync(p)) throw new Error(`chrome-devtools CLI not found at ${p} - npm i -g chrome-devtools-mcp`);
  return p;
})();
function cli(...cliArgs) {
  const r = spawnSync(process.execPath, [CLI, ...cliArgs], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`chrome-devtools ${cliArgs[0]} failed: ${(r.stderr || r.stdout).slice(-600)}`);
  return r.stdout;
}
/** run an async function in the selected page; result parsed from the JSON file */
function evalInPage(fnSource) {
  const f = path.join(TMP, `eval-${Date.now()}.json`);
  cli('evaluate_script', fnSource, '--filePath', f);
  const raw = fs.readFileSync(f, 'utf8'); fs.unlinkSync(f);
  return JSON.parse(raw);
}
function selectMotorPage() {
  const list = cli('list_pages');
  const m = list.match(/^(\d+): .*\(https:\/\/www\.motor\.no\/[^)]*\)/m);
  if (m) { cli('select_page', m[1]); return; }
  cli('new_page', 'https://www.motor.no/');
}

// ---- helpers -------------------------------------------------------------------
const idOf = u => { const m = String(u).match(/\/(\d{5,7})(?:[?#]|$)/); return m ? m[1] : null; };
const normalize = u => { try { const x = new URL(u, 'https://www.motor.no'); if (!/(^|\.)motor\.no$/.test(x.hostname)) return null; x.search = ''; x.hash = ''; return x.toString(); } catch { return null; } };
const extractLinks = html => {
  const $ = cheerio.load(html);
  const main = $('main').length ? $('main') : $('body');
  const set = new Set();
  main.find('a[href]').each((_, a) => { const u = normalize($(a).attr('href')); if (u && idOf(u)) set.add(u); });
  return [...set];
};
/** fetch a batch of urls inside the page; returns [{url,status,finalUrl,html}] */
function fetchBatch(urls) {
  // The CLI acts on the *selected* page, and anything else using the same browser
  // (a screenshot of another tab, say) changes the selection. Re-select every batch
  // so fetches always run from a motor.no origin (cookies + no CORS).
  selectMotorPage();
  const fn = `async () => {
    const urls = ${JSON.stringify(urls)};
    const out = [];
    for (const u of urls) {
      try {
        const r = await fetch(u, { credentials: 'include', redirect: 'follow' });
        out.push({ url: u, status: r.status, finalUrl: r.url, html: await r.text() });
      } catch (e) { out.push({ url: u, status: 0, error: String(e) }); }
      await new Promise(res => setTimeout(res, ${DELAY}));
    }
    return out;
  }`;
  return evalInPage(fn);
}

// ---- main ----------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const saveManifest = () => fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1));

selectMotorPage();
{
  const [probe] = fetchBatch([LOGIN_PROBE]);
  const ok = probe.status === 200 && /Slik tester vi/.test(probe.html) && !/paywall-teaser-title/.test(probe.html);
  console.log(`paywall check: ${ok ? 'full article visible (logged in)' : 'TEASER ONLY - log in on motor.no in the chrome-devtools window first'}`);
  if (!ok) process.exit(3);
}

const seeds = JSON.parse(fs.readFileSync(SEEDS, 'utf8'));
const frontier = new Map(); // url -> {depth, from}
for (const s of seeds) { const u = normalize(s.url); if (u) frontier.set(u, { depth: 0, from: 'seed' }); }
const linkedFrom = new Map(); // url -> number of pages linking to it
const outlinks = new Map();   // url -> string[]
const countLinks = (url, links) => { outlinks.set(url, links); for (const l of links) linkedFrom.set(l, (linkedFrom.get(l) || 0) + 1); };
for (const m of Object.values(manifest)) if (m.links) countLinks(m.url, m.links);

let fetched = 0;
for (let depth = 0; depth <= DEPTH; depth++) {
  const todo = [...frontier].filter(([, v]) => v.depth === depth).map(([u]) => u);
  const need = todo.filter(u => { const id = idOf(u); return REFETCH || !(manifest[id]?.status === 200 && fs.existsSync(path.join(OUT, `${id}.html`))); });
  console.log(`\n== round ${depth}: ${todo.length} urls, ${need.length} to fetch ==`);
  for (let i = 0; i < need.length && fetched < MAX; i += BATCH) {
    const batch = need.slice(i, i + BATCH);
    let results;
    try { results = fetchBatch(batch); } catch (e) { console.log(`  ! batch failed: ${e.message}`); continue; }
    for (const r of results) {
      const id = idOf(r.url); fetched++;
      const links = r.status === 200 ? extractLinks(r.html) : [];
      if (r.status === 200) fs.writeFileSync(path.join(OUT, `${id}.html`), r.html, 'utf8');
      manifest[id] = { url: r.url, finalUrl: r.finalUrl, status: r.status, error: r.error, bytes: r.html?.length ?? 0, depth, from: frontier.get(r.url)?.from ?? null, fetched_at: new Date().toISOString(), links };
      countLinks(r.url, links);
      console.log(`  ${r.status} d${depth} ${id} ${r.url.replace('https://www.motor.no/', '').slice(0, 90)} (${links.length} links)`);
    }
    saveManifest();
  }
  if (depth === DEPTH) break;
  const totalPages = Object.values(manifest).filter(m => m.status === 200).length;
  const threshold = Math.max(25, Math.ceil(totalPages * 0.10));
  let added = 0;
  for (const url of todo) for (const l of outlinks.get(url) || []) {
    if (frontier.has(l) || (linkedFrom.get(l) || 0) > threshold || !idOf(l)) continue;
    frontier.set(l, { depth: depth + 1, from: idOf(url) }); added++;
  }
  console.log(`  next round: +${added} candidate urls (sidebar threshold ${threshold} pages)`);
}
saveManifest();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\ndone. fetched ${fetched} this run; manifest has ${Object.keys(manifest).length} entries -> ${path.relative(root, OUT)}`);
