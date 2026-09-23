#!/usr/bin/env node
/**
 * Stage 3: parsed articles -> docs/data/catalog.json
 *
 * This is where interpretation happens. Stage 2 (parse.mjs) only pulled structure
 * out of HTML; here we decide what is a *test*, what is a *tyre result*, which
 * discipline a number belongs to and which tyre a table column refers to.
 *
 * Model
 *   test   one Motor test season: {season: 'vinter'|'sommer', year}. A winter test
 *          contains the classes 'pigg' and 'piggfri'; a summer test the class
 *          'sommer' (2019 also had 'sommer-budsjett', 2020 was SUV-only).
 *   tyre   one tyre in one test: total points, per-discipline points (from the
 *          motortest widget or the main article's point table), and measured
 *          values (metres, seconds …) from the detail articles where they exist.
 *   article every crawled motor.no page with a kind: main | tyre | detail |
 *          discipline | method | other
 *
 * Discipline keys (what the UI filters on):
 *   is_aks is_brems is_kjor  sno_aks sno_brems sno_kjor
 *   vat_brems vat_kjor vat_grep vannplaning vannplaning_sving
 *   torr_brems torr_kjor  forbruk stoy komfort slitasje
 *
 * Usage: node crawler/build-catalog.mjs [--parsed crawler/parsed] [--out docs/data/catalog.json] [--verbose]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const VERBOSE = args.includes('--verbose');
const PARSED = path.resolve(root, opt('--parsed', 'crawler/parsed'));
const OUT = path.resolve(root, opt('--out', 'docs/data/catalog.json'));
const SEEDS = path.join(here, 'seeds', 'motor-tags.json');
const MANIFEST = path.resolve(root, 'crawler/raw/manifest.json');

const warn = (...a) => { if (VERBOSE) console.warn('  !', ...a); };
const clean = s => String(s ?? '').replace(/­/g, '').replace(/\s+/g, ' ').trim();
const fold = s => clean(s).toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const num = s => { const m = clean(s).replace(/\s/g, '').match(/^-?\d+(?:[.,]\d+)?$/); return m ? Number(m[0].replace(',', '.')) : null; };

// ---- load -----------------------------------------------------------------------------
const seeds = Object.fromEntries(JSON.parse(fs.readFileSync(SEEDS, 'utf8')).map(s => [String(s.id), s]));
const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
const articles = fs.readdirSync(PARSED).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(PARSED, f), 'utf8')));
const byId = Object.fromEntries(articles.map(a => [String(a.id), a]));
console.log(`loaded ${articles.length} parsed articles`);

// ---- discipline normalisation -------------------------------------------------------
const DISCIPLINES = {
  is_aks: { label: 'Akselerasjon på is', group: 'is', better: 'low', units: ['sek', 's'] },
  is_brems: { label: 'Bremsing på is', group: 'is', better: 'low', units: ['m'] },
  is_kjor: { label: 'Kjøring på is', group: 'is', better: 'low', units: ['s', 'sek'] },
  sno_aks: { label: 'Akselerasjon på snø', group: 'sno', better: 'low', units: ['sek', 's'] },
  sno_brems: { label: 'Bremsing på snø', group: 'sno', better: 'low', units: ['m'] },
  sno_kjor: { label: 'Kjøring på snø', group: 'sno', better: 'low', units: ['s', 'sek'] },
  vat_brems: { label: 'Bremsing på våt asfalt', group: 'vat', better: 'low', units: ['m'] },
  vat_kjor: { label: 'Kjøring på våt asfalt', group: 'vat', better: 'low', units: ['s', 'sek'] },
  vat_grep: { label: 'Svinggrep på våt asfalt', group: 'vat', better: 'high', units: ['km/t', 'g'] },
  vannplaning: { label: 'Vannplaning', group: 'vat', better: 'high', units: ['km/t'] },
  vannplaning_sving: { label: 'Vannplaning i sving', group: 'vat', better: 'high', units: ['km/t', 'g'] },
  torr_brems: { label: 'Bremsing på tørr asfalt', group: 'torr', better: 'low', units: ['m'] },
  torr_kjor: { label: 'Kjøring på tørr asfalt', group: 'torr', better: 'low', units: ['s', 'sek'] },
  forbruk: { label: 'Forbruk / rullemotstand', group: 'annet', better: 'low', units: ['l/100km', 'kWh', '%', 'N'] },
  stoy: { label: 'Støy', group: 'annet', better: 'low', units: ['dB'] },
  komfort: { label: 'Komfort', group: 'annet', better: 'high', units: [] },
  slitasje: { label: 'Slitasje / holdbarhet', group: 'annet', better: 'high', units: ['km', 'mm'] },
  stabilitet: { label: 'Stabilitet', group: 'torr', better: 'high', units: [] },
};
/** Map a Norwegian label (table row, widget group+key, heading, kicker) to a discipline key. */
function discKey(label, group = '') {
  const t = fold(label); const g = fold(group);
  const surf = /\bis\b|isstart|glattis/.test(t) || g === 'is' ? 'is'
    : /sno/.test(t) || g === 'sno' ? 'sno'
    : /vat|vatt|regn/.test(t) || /vat/.test(g) ? 'vat'
    : /torr|tort/.test(t) || /torr/.test(g) ? 'torr' : null;
  if (/vannplaning|aquaplan/.test(t)) return /sving|kurve|lateral/.test(t) ? 'vannplaning_sving' : 'vannplaning';
  if (/forbruk|rullemotstand|energi|drivstoff/.test(t)) return 'forbruk';
  if (/stoy|lyd|desibel|db\b/.test(t)) return 'stoy';
  if (/komfort/.test(t)) return 'komfort';
  if (/slitasje|holdbarhet|levetid/.test(t)) return 'slitasje';
  if (/stabilitet/.test(t)) return 'stabilitet';
  if (/svinggrep|sidegrep|grep\b/.test(t) && surf === 'vat') return 'vat_grep';
  const what = /brems|stopp/.test(t) ? 'brems' : /akseler|start|drag|traksjon/.test(t) ? 'aks'
    : /kjor|handling|manover|unnaman|rundetid|bane|folelse|egenskap|styring/.test(t) ? 'kjor' : null;
  if (surf && what) return `${surf}_${what}`;
  if (surf === 'vat' && /grep/.test(t)) return 'vat_grep';
  return null;
}
const unitOf = s => { const t = clean(s).toLowerCase(); if (/km\/t/.test(t)) return 'km/t'; if (/\bdb/.test(t)) return 'dB'; if (/l\/100|liter/.test(t)) return 'l/100km'; if (/kwh/.test(t)) return 'kWh/100km'; if (/\bm(eter)?\b/.test(t) && !/mm/.test(t)) return 'm'; if (/\bs(ek)?\b|tid/.test(t)) return 's'; if (/%/.test(t)) return '%'; if (/\bmm\b/.test(t)) return 'mm'; if (/\bkm\b/.test(t)) return 'km'; if (/\bn\b/.test(t)) return 'N'; return null; };

// ---- brands -------------------------------------------------------------------------------
const BRANDS = ['nokian', 'michelin', 'continental', 'bridgestone', 'goodyear', 'pirelli', 'hankook', 'kumho', 'nexen', 'nankang', 'nordman', 'gislaved', 'vredestein', 'falken', 'yokohama', 'toyo', 'firestone', 'dunlop', 'sava', 'linglong', 'landsail', 'triangle', 'goodride', 'maxxis', 'mazzini', 'radar', 'greenmax', 'leao', 'sailun', 'barum', 'wanli', 'davanti', 'kenda', 'duraturn', 'fulda', 'roadstone', 'nordexx', 'cooper', 'uniroyal', 'semperit', 'kleber', 'bfgoodrich', 'apollo', 'laufenn', 'westlake', 'zeetex', 'tracmax', 'hifly', 'gripmax', 'imperial', 'minerva', 'rotalla', 'ovation', 'matador', 'viking', 'debica', 'kormoran', 'riken', 'tigar', 'petlas', 'lassa', 'ceat', 'general', 'avon', 'marshal', 'momo', 'evergreen', 'aplus', 'jinyu', 'antares', 'sunny', 'sunfull', 'habilead', 'kapsen', 'arivo', 'atlas', 'star performer', 'nankang', 'giti', 'gt radial', 'ling long'];
const BRAND_ALIAS = { conti: 'continental', kuhmo: 'kumho', 'nokian nordman': 'nordman', hankok: 'hankook', 'good year': 'goodyear', michelinn: 'michelin', 'ling long': 'linglong', 'gt radial': 'gt radial', peltas: 'petlas', bridgstone: 'bridgestone', goodrid: 'goodride' };
const REF_RX = /referanse|ref-?dekk|bruktdekk|\bbrukt\b|helarsdekk|helårsdekk|kontinentalt|eu-?piggfri|sentraleurop|mellomeurop|friksjonsdekk|vinterdekk om sommeren|ts ?8[67]0|piggfritt referansedekk|piggfri referanse|^piggfritt$|^piggdekk$|^vw-?dekk|^oem|originaldekk/i;
function brandOf(name) {
  const f = fold(name);
  for (const [a, b] of Object.entries(BRAND_ALIAS)) if (f.startsWith(a)) return b;
  for (const b of BRANDS) if (f === b || f.startsWith(b + ' ')) return b;
  return f.split(' ')[0] || null;
}

// ---- article classification ----------------------------------------------------------------
function seasonOf(published) {
  const d = new Date(published); const m = d.getUTCMonth() + 1;
  return { year: d.getUTCFullYear(), season: m <= 6 ? 'sommer' : 'vinter' };
}
function classify(a) {
  const seed = seeds[a.id] || {};
  const title = clean(a.title || seed.title); const kicker = clean(a.kicker || seed.kicker); const url = a.meta?.url || seed.url || manifest[a.id]?.url || '';
  const hay = fold([title, kicker, a.meta?.headline, seed.seoTitle, url].join(' '));
  const scoreCards = a.cards.filter(c => c.score != null);
  const pointTables = a.tables.filter(t => t.rows.filter(r => discKey(r[0]) && r.slice(1).filter(x => num(x) != null).length >= 3).length >= 3);
  const measureTables = a.tables.filter(t => t.header.length === 2 && t.rows.length >= 4 && t.rows.every(r => num(r[1]) != null || r[1] === ''));
  // Car tests and test drives share layout (and the motortest widget) with tyre pages.
  if (/^(test|prøvekjørt|provekjort|prøvekjøring|langtest|duell)\b/i.test(kicker) || /motor-har-(testet|provekjort)|provekjort-/.test(url)) return 'other';
  // The motortest widget is also used for Motor's car tests ("Test: Volvo XC40"); only the
  // winterTire/summerTire variants are tyres. Old (2017) widgets may lack the class, so
  // fall back to tyre-ish tags/URL.
  if (a.motortest?.name && a.motortest.points != null) {
    const tyreish = a.motortest.kind || /dekk|pigg/.test(fold([...(a.tags || []), ...(seed.tags || []), url, seed.section].join(' ')));
    return tyreish ? 'tyre' : 'other';
  }
  const tyreHay = /dekk|pigg|hakkapel/.test(hay) || /dekk|pigg/.test(fold([...(a.tags || []), ...(seed.tags || [])].join(' ')));
  if (!tyreHay) return 'other';
  if (/slik (tester|gjennomfores|beregnes|finner) /.test(hay) && !scoreCards.length && !pointTables.length) return 'method';
  if (/alle tall|delresultat|detaljene|enkeltkategori|alle resultatene|slik scorer dekkene i/.test(hay) || measureTables.length >= 4) return 'detail';
  if (scoreCards.length >= 3 || pointTables.length) return 'main';
  if (a.runs.length && /testen(?: \d{4})?:|dekktesten:|sommerdekktest|vinterdekktest/.test(hay)) return 'discipline';
  if (/test av (vinter|sommer)dekk|dekktest(en)? ?\d{4}|(vinter|sommer)dekktest(en)?( ?\d{4})?:?|store (vinter|sommer)dekktest|de beste (pigg|piggfrie|sommer|vinter)/.test(hay) && /dekk/.test(hay) && !/adac|forbud|gebyr|debatt|leserinnlegg/.test(hay)) return 'main';
  return 'other';
}
for (const a of articles) {
  const seed = seeds[a.id] || {};
  a.url = a.meta?.url || seed.url || manifest[a.id]?.url || null;
  a.published = a.meta?.published || seed.published || null;
  a.title = clean(a.title || seed.title || a.meta?.headline);
  a.kicker = clean(a.kicker || seed.kicker) || null;
  a.kind = classify(a);
  Object.assign(a, a.published ? seasonOf(a.published) : { year: null, season: null });
  // 2017-2018 sub-articles were published weeks after the test; the season is still right.
}
const kinds = {}; for (const a of articles) kinds[a.kind] = (kinds[a.kind] || 0) + 1;
console.log('article kinds:', kinds);

// ---- tests --------------------------------------------------------------------------------
const tests = new Map(); // key -> test
const testKey = a => `${a.season}-${a.year}`;
const getTest = a => {
  const k = testKey(a);
  if (!tests.has(k)) tests.set(k, { id: k, season: a.season, year: a.year, title: null, url: null, main_ids: [], detail_ids: [], discipline_ids: [], method_ids: [], tyre_ids: [], dimension: null, dimensions: new Set(), car: null, location: null, classes: {}, disciplines: {}, notes: [] });
  return tests.get(k);
};
const DIM_RX = /\b(\d{3})\s?\/\s?(\d{2})\s?[-–]?\s?R?\s?(1[4-9]|2[0-2])\b/gi;
const dimsIn = txt => [...clean(txt).matchAll(DIM_RX)].map(m => `${m[1]}/${m[2]} R${m[3]}`);
for (const a of articles) {
  if (a.kind === 'other' || !a.year) continue;
  const t = getTest(a);
  if (a.kind === 'main') t.main_ids.push(a.id);
  if (a.kind === 'detail') t.detail_ids.push(a.id);
  if (a.kind === 'discipline') t.discipline_ids.push(a.id);
  if (a.kind === 'method') t.method_ids.push(a.id);
  for (const d of dimsIn(a.text)) t.dimensions.add(d);
  const car = a.text.match(/Testbil(?:en|ene)?\s+(?:var|er|:)\s*(.{5,120}?)\.(?!\d)(?:\s|$)/); if (car && !t.car) t.car = clean(car[1]);
  const loc = a.text.match(/\b(Älvsbyn|Alvsbyn|Ivalo|Arvidsjaur|Tammerfors|Tampere|Marseille[s]?|Piteå|Arctic Falls|Nokia|Rovaniemi|Saariselkä|Papenburg|Idiada|Mireval)\b/); if (loc && !t.location) t.location = loc[1];
}

// ---- tyres from motortest widgets ------------------------------------------------------------
const tyres = [];
const tyreByArticle = new Map();
function classOf(a, card) {
  const w = a.motortest; const url = fold(a.url || ''); const sec = fold(seeds[a.id]?.section || ''); const tags = new Set([...(card?.tags || []), ...(a.tags || []), ...(seeds[a.id]?.tags || [])].map(fold));
  const under = fold(card?.under || '');
  if (a.season === 'sommer' || w?.kind === 'sommer') return /budsjett/.test(url + ' ' + sec + ' ' + [...tags].join(' ')) ? 'sommer-budsjett' : 'sommer';
  if (/piggfri/.test(under)) return 'piggfri';
  if (/piggdekk/.test(under)) return 'pigg';
  if (tags.has('piggfrie') || tags.has('piggfrie dekk') || tags.has('piggfritt') || [...tags].some(x => /^piggfrie?\d{4}$/.test(x))) return 'piggfri';
  if (tags.has('piggdekk') || [...tags].some(x => /^piggdekk\d{4}$/.test(x))) return 'pigg';
  if (/piggfri/.test(url)) return 'piggfri';
  if (/piggdekk/.test(url)) return 'pigg';
  if (w) {
    const studs = w.groups?.Pigger?.Antall ?? w.facts?.Pigger;
    if (typeof studs === 'number' && studs > 0) return 'pigg';
    if (typeof studs === 'string' && /nei|ingen|0/.test(fold(studs))) return 'piggfri';
    if (w.facts && 'Pigger' in w.facts === false && Object.keys(w.groups || {}).length) return 'piggfri'; // 2019+ widgets omit Pigger for studless
  }
  return 'vinter';
}
for (const a of articles) {
  if (a.kind !== 'tyre') continue;
  const w = a.motortest; const t = getTest(a);
  // the card that points to this article from a main article (gives class + score + tags)
  let card = null;
  for (const m of articles) if (m.kind === 'main') { const c = m.cards.find(c => String(c.id) === String(a.id)); if (c) { card = c; break; } }
  const name = clean(w.name);
  const cls = classOf(a, card);
  const scores = {};
  for (const [group, kv] of Object.entries(w.groups || {})) {
    if (fold(group) === 'pigger') continue;
    for (const [k, v] of Object.entries(kv)) {
      if (typeof v !== 'number') continue;
      const key = discKey(k, group) || discKey(`${group} ${k}`); if (!key) { warn(a.id, 'unmapped widget key', group, k); continue; }
      scores[key] = { p: v };
    }
  }
  const studs = w.groups?.Pigger?.Antall ?? (typeof w.facts?.Pigger === 'number' ? w.facts.Pigger : null);
  const tyre = {
    id: `t${a.id}`, article_id: String(a.id), test_id: t.id, class: cls,
    name, brand: brandOf(name), reference: REF_RX.test(name) || REF_RX.test(a.title) || REF_RX.test(a.kicker || ''),
    url: a.url, published: a.published,
    points: w.points, rank: null,
    verdict: a.title && fold(a.title) !== fold(name) ? a.title : (a.kicker && fold(a.kicker.replace(/:$/, '')) !== fold(name) ? a.kicker.replace(/:$/, '') : (card?.title || null)),
    kicker: a.kicker, plus: a.plusminus?.plus || null, minus: a.plusminus?.minus || null,
    intro: w.intro || a.subtitle || null,
    facts: { ...w.facts, ...(studs != null && !('Pigger' in (w.facts || {})) ? { Pigger: studs } : {}) },
    scores, measurements: {},
    // No article body: the source is paywalled and the site is public. Numbers, the
    // one-line verdict and the plus/minus phrases are what we republish; the rest is a link.
    body: [],
  };
  if (/disket|diskvalifisert/i.test(a.title + ' ' + (a.kicker || '') + ' ' + (card?.title || ''))) tyre.disqualified = true;
  tyres.push(tyre); tyreByArticle.set(String(a.id), tyre);
  t.tyre_ids.push(tyre.id); (t.classes[cls] ??= { tyre_ids: [], disciplines: {} }).tyre_ids.push(tyre.id);
}
console.log(`tyres from widgets: ${tyres.length}`);

// ---- main articles: title, dimension, score cards, point tables ------------------------------
function makePlaceholder(test, cls, label, source) {
  const name = clean(label);
  const isRef = REF_RX.test(name) || /^(ref|vw|oem|original)/i.test(name);
  const tyre = { id: `p${test.id}-${cls}-${fold(name).replace(/\s+/g, '-')}`, article_id: null, test_id: test.id, class: cls, name, brand: brandOf(name), reference: isRef, url: null, published: null, points: null, rank: null, verdict: null, kicker: null, plus: null, minus: null, intro: null, facts: {}, scores: {}, measurements: {}, body: [], placeholder: source };
  if (tyres.some(x => x.id === tyre.id)) tyre.id += '-' + Math.random().toString(36).slice(2, 6);
  tyres.push(tyre); test.tyre_ids.push(tyre.id); (test.classes[cls] ??= { tyre_ids: [], disciplines: {} }).tyre_ids.push(tyre.id);
  return tyre;
}
function findTyre(test, cls, label, opts = {}) {
  const f = fold(label);
  const pool = tyres.filter(x => x.test_id === test.id && (!cls || x.class === cls));
  if (!pool.length) return null;
  // exact / contains on full name
  let hit = pool.filter(x => fold(x.name) === f || fold(x.name).includes(f) || f.includes(fold(x.name)));
  if (hit.length === 1) return hit[0];
  const b = BRAND_ALIAS[f] || f.split(' ')[0];
  if (REF_RX.test(label)) {
    const refs = pool.filter(x => x.reference);
    if (refs.length === 1) return refs[0]; if (refs.length > 1 && opts.refIndex != null) return refs[opts.refIndex] || refs[0]; if (refs.length) return refs[0];
    // "EU-piggfri" / "Kontinentalt" can also be a regular participant: the one Central-European
    // studless tyre in a Nordic test (Pirelli Cinturato Winter, Conti TS870 …)
    let eu = pool.filter(x => /cinturato winter|wintercontact|ts ?8[67]0|sentraleurop|kontinental|mellomeurop|eu-?dekk|alpin/i.test(`${x.name} ${x.intro || ''} ${x.verdict || ''}`));
    if (eu.length > 1) eu = eu.filter(x => x.class === 'piggfri');
    if (eu.length === 1) return eu[0];
  }
  hit = pool.filter(x => x.brand === b && !x.reference);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) {
    // several tyres of the same brand in the class: prefer model-word overlap, else the non-EU one
    const words = f.split(' ').slice(1).filter(Boolean);
    const scored = hit.map(x => ({ x, n: words.filter(w => fold(x.name).includes(w)).length })).sort((p, q) => q.n - p.n);
    if (scored[0].n > 0 && scored[0].n > (scored[1]?.n ?? -1)) return scored[0].x;
    if (opts.nth != null) return hit[opts.nth] || null;
    warn(test.id, cls, `ambiguous brand "${label}" ->`, hit.map(x => x.name).join(' | '));
    return hit[0];
  }
  return null;
}
for (const a of articles) {
  if (a.kind !== 'main') continue;
  const t = getTest(a);
  // A winter test has two main articles (pigg + piggfri); the test itself gets a neutral name
  // and links to all of them (main_ids).
  t.title = `${t.season === 'vinter' ? 'Vinterdekktest' : 'Sommerdekktest'} ${t.year}`;
  if (!t.url) t.url = a.url;
  const dims = dimsIn(a.text); if (dims.length && !t.dimension) t.dimension = dims[0];
  // score cards -> total points (+ create tyres for sub-articles we never fetched)
  for (const c of a.cards) {
    if (c.score == null) continue;
    if (/slik (tester|finner|gjennomf|beregn)|alle tall|delresultat|detaljene|resultatene|tilbake til/i.test(c.title || c.text || '')) continue; // method/detail cards, not tyres
    // Car-test cards ("Kanskje er dette årets beste bilkjøp") also carry a score label.
    // A tyre card has tyre-ish tags or a brand in the slug.
    const cardHay = fold([...c.tags, c.href, c.kicker || ''].join(' '));
    const isTyreCard = /dekk|pigg/.test(cardHay) || BRANDS.some(b => new RegExp(`(^|[ /-])${b}([ /-]|$)`).test(cardHay));
    if (!isTyreCard) { warn(t.id, 'skipping non-tyre card', c.id, c.title); continue; }
    let tyre = tyreByArticle.get(String(c.id));
    if (!tyre) {
      const sub = byId[String(c.id)];
      const guess = { season: t.season, year: t.year, url: c.href, tags: c.tags, title: c.title, kicker: c.kicker, motortest: null };
      const cls = classOf(guess, c);
      const nameFromTags = c.tags.find(x => BRANDS.includes(x)) || null;
      tyre = { id: `t${c.id}`, article_id: String(c.id), test_id: t.id, class: cls, name: sub?.title || c.title || nameFromTags || `#${c.id}`, brand: nameFromTags || brandOf(sub?.kicker || c.title || ''), reference: false, url: c.href, published: null, points: c.score, rank: null, verdict: c.title, kicker: c.kicker, plus: null, minus: null, intro: c.subtitle, facts: {}, scores: {}, measurements: {}, body: [], from_card_only: true };
      tyres.push(tyre); tyreByArticle.set(String(c.id), tyre); t.tyre_ids.push(tyre.id); (t.classes[cls] ??= { tyre_ids: [], disciplines: {} }).tyre_ids.push(tyre.id);
      warn(t.id, 'tyre only known from card', c.id, c.title);
    } else {
      if (tyre.points == null) tyre.points = c.score;
      if (!tyre.verdict && c.title) tyre.verdict = c.title;
      if (tyre.class === 'vinter') tyre.class = classOf(byId[tyre.article_id] || { season: t.season }, c);
      if (/disket|diskvalifisert/i.test(c.title || '')) tyre.disqualified = true;
    }
  }
  // point tables: rows = disciplines, columns = tyres (short brand labels)
  for (const tb of a.tables) {
    const hdr = tb.header; if (!hdr || hdr.length < 3) continue;
    const labels = hdr.slice(1); const maxCol = labels.findIndex(h => /maks/i.test(h));
    const rowsD = tb.rows.map(r => ({ key: discKey(r[0]), label: clean(r[0]), cells: r.slice(1) })).filter(r => r.key || /sum|total|plassering/i.test(r.label));
    // a real point table has several discipline rows; a car spec sheet with one "Forbruk" row does not
    if (rowsD.filter(r => r.key).length < 3) continue;
    const clsHint = /piggfri/i.test(tb.heading || '') || /piggfri/i.test(tb.section || '') ? 'piggfri' : /piggdekk/i.test(tb.heading || '') || /piggdekk/i.test(tb.section || '') ? 'pigg' : (t.season === 'sommer' ? (Object.keys(t.classes).length === 1 ? Object.keys(t.classes)[0] : 'sommer') : null);
    let cls = clsHint;
    if (!cls) { // infer from which class matches most column labels
      const cand = Object.keys(t.classes); let best = null, bestN = -1;
      for (const c of cand) { const n = labels.filter((l, i) => i !== maxCol && findTyre(t, c, l)).length; if (n > bestN) { bestN = n; best = c; } }
      cls = best;
    }
    const seen = {};
    labels.forEach((label, ci) => {
      if (ci === maxCol || !label) return;
      const b = fold(label); seen[b] = (seen[b] || 0);
      let tyre = findTyre(t, cls, label, { nth: seen[b], refIndex: seen[b] }); seen[b]++;
      if (!tyre) {
        // No per-tyre article for this column (reference tyres, OEM tyres, or a
        // sub-article that never got published). Keep it as a placeholder row so the
        // test is complete; the name is only what the column header said.
        tyre = makePlaceholder(t, cls || 'vinter', label, `table:${a.id}`);
        warn(t.id, cls, 'placeholder tyre for column', label);
      }
      for (const r of rowsD) {
        const v = num(r.cells[ci]); if (v == null) continue;
        if (/plassering/i.test(r.label)) { tyre.rank ??= v; continue; }
        if (/sum|total/i.test(r.label)) { tyre.points ??= v; continue; }
        const mx = num(r.label.match(/\((?:maks\s*)?(\d+)\)/i)?.[1]) ?? (maxCol >= 0 ? num(r.cells[maxCol]) : null);
        tyre.scores[r.key] ??= { p: v };
        if (mx) { tyre.scores[r.key].max = mx; (t.classes[cls]?.disciplines ?? (t.classes[cls] = { tyre_ids: [], disciplines: {} }).disciplines)[r.key] = { max: mx }; }
      }
    });
  }
}

// ---- measured values ---------------------------------------------------------------------
/** Short procedure tag from a conditions text: "25→5 km/t · innendørs · −5 til −6°" */
function procOf(cond) {
  if (!cond) return null;
  const c = clean(cond);
  const parts = [];
  const sp = c.match(/(\d{2,3})\s*(?:–|-|til)\s*(\d{1,3})\s*km\/?t/i) || c.match(/fra\s+(\d{2,3})\s+til\s+(\d{1,3})/i);
  if (sp) parts.push(`${sp[1]}→${sp[2]} km/t`);
  else { const one = c.match(/(?:fra|ved|i)\s+(\d{2,3})\s*km\/?t/i); if (one) parts.push(`${one[1]} km/t`); }
  if (/innend/i.test(c)) parts.push('innendørs');
  else if (/utend|bane|overskyet|sol\b/i.test(c)) parts.push('utendørs');
  const temp = c.match(/([+-−]?\d{1,2})\s*(?:til|–|-)\s*([+-−]?\d{1,2})\s*°/); if (temp) parts.push(`${temp[1]}…${temp[2]}°`);
  const depth = c.match(/(\d+(?:,\d+)?)\s*(?:mm|millimeter) vann/i); if (depth) parts.push(`${depth[1]} mm vann`);
  return parts.join(' · ') || null;
}
function attachMeasurement(test, cls, tyre, key, value, unit, source, conditions, nth) {
  if (!tyre || !key) return false;
  tyre.measurements[key] ??= {};
  if (tyre.measurements[key].value != null && tyre.measurements[key].source !== source) return true;
  tyre.measurements[key] = { value, unit, source, conditions: conditions || null, proc: procOf(conditions) };
  return true;
}
const condOf = lead => clean((lead || []).filter(p => !/^Kommentar/i.test(p)).join(' · ')).slice(0, 240) || null;
// 2019+ detail articles: two-column tables (name, value) under a discipline heading
for (const a of articles) {
  if (!['detail', 'main', 'discipline'].includes(a.kind)) continue;
  const t = getTest(a);
  let sectionCls = null;
  for (const tb of a.tables) {
    if (tb.header.length !== 2 && !(tb.header.length === 3 && !tb.header[2])) continue;
    const rows = tb.rows.map(r => ({ name: r[0], v: num(r[1]) })).filter(r => r.name && r.v != null);
    if (rows.length < 3) continue;
    const key = discKey(tb.heading || '') || discKey(tb.caption || '') || (tb.headings_before || []).map(h => discKey(h)).find(Boolean) || discKey(a.kicker || a.title || '');
    let unit = unitOf(tb.header[1]) || unitOf(tb.heading || '');
    // A two-column table of small integers under "Karakter"/"Poeng" is a rating, not a
    // measurement (subjective handling marks 1-5 or 1-10). Skip it here; points come from
    // the widget / point tables.
    const smallInts = rows.every(r => Number.isInteger(r.v) && r.v >= 0 && r.v <= 15);
    if (!unit && (/karakter|poeng|vurdering|score/i.test(tb.header[1] || '') || smallInts)) { warn(a.id, 'rating table, not measurement:', tb.heading, tb.header); continue; }
    unit = unit || (key ? DISCIPLINES[key]?.units[0] : null);
    if (tb.section) sectionCls = /piggfri/i.test(tb.section) ? 'piggfri' : /piggdekk|pigg\b/i.test(tb.section) ? 'pigg' : sectionCls;
    const cls = /piggfri/i.test(tb.heading || '') ? 'piggfri' : /piggdekk/i.test(tb.heading || '') ? 'pigg' : (sectionCls || (t.season === 'sommer' ? null : null));
    if (!key) { warn(a.id, 'measurement table without discipline:', tb.heading, tb.header); continue; }
    const seen = {};
    for (const r of rows) {
      const b = fold(r.name); seen[b] = seen[b] || 0;
      let tyre = findTyre(t, cls, r.name, { nth: seen[b], refIndex: seen[b] }); seen[b]++;
      // The section heading (PIGGDEKK / PIGGFRIE DEKK) is sometimes missing above a table,
      // so the class carried over from the previous one may be wrong. If the brand only
      // exists in the other winter class, that is where the row belongs.
      if (!tyre && cls && t.season === 'vinter') {
        const other = cls === 'pigg' ? 'piggfri' : 'pigg';
        const alt = findTyre(t, other, r.name, { nth: 0 });
        if (alt) { tyre = alt; warn(a.id, 'row', r.name, 'moved to', other, 'for', key); }
      }
      if (!tyre) {
        const pcls = cls || (t.season === 'sommer' ? 'sommer' : 'vinter');
        tyre = tyres.find(x => x.test_id === t.id && x.placeholder && x.class === pcls && fold(x.name) === fold(r.name)) || makePlaceholder(t, pcls, r.name, `detail:${a.id}`);
        warn(a.id, 'placeholder for measured', r.name, 'in', t.id, pcls, key);
      }
      attachMeasurement(t, cls, tyre, key, r.v, unit, `article:${a.id}`, condOf([tb.heading, ...(tb.lead || [])].filter(Boolean)));
    }
    (t.disciplines[key] ??= { unit, sources: [] }).sources.push(a.id);
  }
}
// 2017-2018 per-discipline articles: flat "Brand value" runs; the brand may appear once per class
for (const a of articles) {
  if (!a.runs.length || !['discipline', 'detail', 'main'].includes(a.kind)) continue;
  const t = getTest(a);
  const key = discKey(a.kicker || '') || discKey(a.title || '');
  // The 2017-2018 discipline articles describe the procedure in the standfirst
  // ("… for å bremse fra 50 til 0 på glatt is"); keep that as the measurement's conditions.
  const runCond = clean(a.subtitle || seeds[a.id]?.description || '').slice(0, 240) || null;
  for (const run of a.runs) {
    const k = discKey(run.label) && !/^dekk\s|bremselengde/i.test(run.label) ? discKey(run.label) : key;
    if (!k) { warn(a.id, 'run without discipline:', run.label); continue; }
    const unit = unitOf(run.label) || DISCIPLINES[k].units[0];
    const better = DISCIPLINES[k].better;
    // Group by brand. A brand that appears once maps to its single tyre. A brand that
    // appears twice in a winter test is one studded and one studless tyre: order the
    // values by performance and the tyres by their widget points for this discipline,
    // then pair them up. Leftover values (no article for that tyre) become placeholder
    // rows so the measurement is not lost. Summer 2017 has no per-tyre articles at
    // all, so every brand becomes a placeholder there.
    const byBrand = {};
    for (const it of run.items) (byBrand[fold(it.name)] ??= []).push(it.value);
    const ambiguous = [];
    for (const [b, vals] of Object.entries(byBrand)) {
      const brand = BRAND_ALIAS[b] || b;
      const cands = tyres.filter(x => x.test_id === t.id && !x.placeholder && (x.brand === brand || fold(x.name).startsWith(b)));
      const sortedVals = [...vals].sort((p, q) => better === 'low' ? p - q : q - p);
      const sortedT = [...cands].sort((p, q) => (q.scores[k]?.p ?? -1) - (p.scores[k]?.p ?? -1));
      if (!cands.length) {
        const cls = t.season === 'sommer' ? 'sommer' : 'vinter';
        const ph = tyres.find(x => x.test_id === t.id && x.placeholder && x.brand === brand && x.class === cls) || makePlaceholder(t, cls, run.items.find(it => fold(it.name) === b).name, `run:${a.id}`);
        attachMeasurement(t, cls, ph, k, sortedVals[0], unit, `article:${a.id}`, runCond);
        if (vals.length > 1) warn(a.id, `brand ${b}: ${vals.length} values, no tyres; kept best`);
        continue;
      }
      if (cands.length === vals.length) { sortedT.forEach((x, i) => attachMeasurement(t, x.class, x, k, sortedVals[i], unit, `article:${a.id}`, runCond)); continue; }
      if (vals.length === 1) { attachMeasurement(t, sortedT[0].class, sortedT[0], k, vals[0], unit, `article:${a.id}`, runCond); continue; }
      ambiguous.push({ b, brand, vals: sortedVals, cands: sortedT });
    }
    // 2 values, 1 tyre: pick the value whose neighbours (tyres in the same class with the
    // same points for this discipline) look alike; the other value goes to a placeholder
    // in the opposite class.
    for (const { b, brand, vals, cands } of ambiguous) {
      const x = cands[0];
      const peers = tyres.filter(y => y.test_id === t.id && y.class === x.class && y !== x && y.measurements[k]?.value != null && y.scores[k]?.p != null);
      let pick = 0;
      if (x.scores[k]?.p != null && peers.length) {
        const same = peers.filter(y => y.scores[k].p === x.scores[k].p);
        const ref = (same.length ? same : peers).reduce((s, y) => s + y.measurements[k].value, 0) / (same.length ? same : peers).length;
        pick = vals.map((v, i) => [Math.abs(v - ref), i]).sort((p, q) => p[0] - q[0])[0][1];
      } else if (t.season === 'vinter' && /^is_|^sno_/.test(k)) {
        pick = x.class === 'pigg' ? 0 : vals.length - 1; // studs win on ice/snow
      }
      attachMeasurement(t, x.class, x, k, vals[pick], unit, `article:${a.id}`, runCond);
      const other = x.class === 'pigg' ? 'piggfri' : x.class === 'piggfri' ? 'pigg' : 'vinter';
      const rest = vals.filter((_, i) => i !== pick);
      const ph = tyres.find(y => y.test_id === t.id && y.placeholder && y.brand === brand && y.class === other) || makePlaceholder(t, other, `${run.items.find(it => fold(it.name) === b).name} (${other}, ukjent modell)`, `run:${a.id}`);
      attachMeasurement(t, other, ph, k, rest[0], unit, `article:${a.id}`, runCond);
    }
    (t.disciplines[k] ??= { unit, sources: [] }).sources.push(a.id);
  }
}

// ---- placeholder names: brand only -> try the main article text for the full model name ----
// vinter-2020 has no per-tyre articles; its point table only says "Michelin", but the main
// article body says "Michelin X-Ice North 4". Take the most frequent "Brand Model…" phrase.
for (const t of tests.values()) {
  const mains = t.main_ids.map(id => byId[String(id)]).filter(Boolean);
  if (!mains.length) continue;
  const text = mains.map(m => m.paragraphs.join(' ')).join(' ');
  for (const tid of t.tyre_ids) {
    const x = tyres.find(y => y.id === tid);
    if (!x || !x.placeholder || x.reference || fold(x.name).split(' ').length > 1) continue;
    const brandWord = x.name.trim();
    const rx = new RegExp(`\\b${brandWord.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:nental)?\\s+((?:[A-Z][\\w*'’+-]*|\\d[\\w-]*)(?:\\s+(?:[A-Z][\\w*'’+-]*|\\d[\\w-]*)){0,3})`, 'g');
    const counts = {};
    for (const m of text.matchAll(rx)) {
      const model = clean(m[1]).replace(/\s+(?:er|har|og|som|i|på|med|får|ble|viser|scorer|bremser|tar|leverer|kommer|gjør|kan|vinner|imponerer|skuffer|[A-ZÆØÅ][a-zæøå]+(?:er|et|ene)\b).*$/, '');
      if (!model || /^(?:og|er|har|som|i|på|med)$/i.test(model)) continue;
      counts[model] = (counts[model] || 0) + 1;
    }
    const best = Object.entries(counts).sort((p, q) => q[1] - p[1] || q[0].length - p[0].length)[0];
    if (best && (best[1] >= 2 || /\d/.test(best[0]))) { x.name = `${x.brand === 'continental' ? 'Continental' : brandWord} ${best[0]}`; x.name_guessed = true; }
  }
}

// ---- derived: max points per discipline, ranks, relative-to-best ---------------------------
for (const t of tests.values()) {
  for (const [cls, c] of Object.entries(t.classes)) {
    const pool = c.tyre_ids.map(id => tyres.find(x => x.id === id));
    for (const key of Object.keys(DISCIPLINES)) {
      const ps = pool.map(x => x.scores[key]?.p).filter(v => v != null);
      if (!ps.length) continue;
      const declared = c.disciplines[key]?.max ?? pool.map(x => x.scores[key]?.max).find(Boolean);
      const mx = declared ?? Math.max(...ps);
      c.disciplines[key] = { max: mx };
      for (const x of pool) if (x.scores[key]) x.scores[key].max = mx;
      // "best in test" excludes reference tyres and disqualified ones (a Bridgestone with
      // over-long studs braked best on ice in 2026 but was thrown out of the test)
      const ms = pool.filter(x => x.measurements[key]?.value != null && !x.reference && !x.disqualified);
      if (ms.length) {
        const better = DISCIPLINES[key].better;
        const best = better === 'low' ? Math.min(...ms.map(x => x.measurements[key].value)) : Math.max(...ms.map(x => x.measurements[key].value));
        for (const x of pool) if (x.measurements[key]?.value != null) x.measurements[key].rel = +(better === 'low' ? x.measurements[key].value / best : best / x.measurements[key].value).toFixed(3);
        c.disciplines[key].best = best; c.disciplines[key].unit = ms[0].measurements[key].unit;
      }
    }
    pool.filter(x => !x.reference && x.points != null).sort((p, q) => q.points - p.points).forEach((x, i) => { x.rank ??= i + 1; });
    c.count = pool.length;
  }
  t.dimensions = [...t.dimensions];
  if (!t.dimension && t.dimensions.length) t.dimension = t.dimensions[0];
  if (!t.title) t.title = `${t.season === 'vinter' ? 'Vinterdekktest' : 'Sommerdekktest'} ${t.year}`;
  t.tyre_count = t.tyre_ids.length;
}

// ---- output ------------------------------------------------------------------------------------
const outTests = [...tests.values()].filter(t => t.tyre_ids.length).sort((p, q) => q.year - p.year || (p.season === 'vinter' ? -1 : 1));
const outArticles = articles.filter(a => a.kind !== 'other' || /dekk/i.test(a.title)).map(a => ({ id: String(a.id), url: a.url, title: a.title, kicker: a.kicker, published: a.published, kind: a.kind, test_id: a.year ? testKey(a) : null, seoTitle: seeds[a.id]?.seoTitle || null, description: seeds[a.id]?.description || a.subtitle || null }));
const catalog = {
  built_at: new Date().toISOString(),
  source: { name: 'Motor.no / Vi Bilägare', url: 'https://www.motor.no/tag/dekktester/' },
  disciplines: DISCIPLINES,
  tests: outTests, tyres: tyres.sort((p, q) => (q.points ?? -1) - (p.points ?? -1)), articles: outArticles,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(catalog));
const kb = Math.round(fs.statSync(OUT).size / 1024);
console.log(`\n${outTests.length} tests, ${tyres.length} tyres, ${outArticles.length} articles -> ${path.relative(root, OUT)} (${kb} kB)`);
for (const t of outTests) console.log(`  ${t.id.padEnd(12)} ${String(t.tyre_ids.length).padStart(3)} tyres  ${Object.entries(t.classes).map(([c, v]) => `${c}:${v.tyre_ids.length}`).join(' ')}  dim=${t.dimension || '?'}  meas=${Object.keys(t.disciplines).join(',') || '-'}`);
