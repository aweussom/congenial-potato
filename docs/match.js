/**
 * match.js — map shop product names to catalog tyres.
 *
 * Shared by the site's "Sjekk butikk" tab (paste text) and by the userscript /
 * Chrome extension that annotates shop pages (tools/build-userscript.mjs inlines
 * this file, so keep it dependency-free and ES2020-plain).
 *
 * How matching works
 *   1. Every catalog tyre gets a compact key: brand + model with everything but
 *      letters and digits removed, generic words (SUV, XL, EV, "med pigger", speed
 *      and load index, dimensions …) stripped. "Nokian Hakkapeliitta 10 SUV" and a
 *      shop's "Nokian Hakkapeliitta 10 SUV 205/55R16 94T XL" both become
 *      nokian|hakkapeliitta10.
 *   2. A product matches a tyre when the brands agree and the compact models are
 *      equal, one contains the other (variant suffix like SUV/EV), or differ by a
 *      single character (Motor's own typos: PremiumContent vs PremiumContact).
 *   3. Matches are grouped per tyre *model* across years so the caller can show
 *      "tested 2024 and 2026" in one badge.
 */

export const BRANDS = ['nokian', 'michelin', 'continental', 'bridgestone', 'goodyear', 'pirelli', 'hankook', 'kumho', 'nexen', 'nankang', 'nordman', 'gislaved', 'vredestein', 'falken', 'yokohama', 'toyo', 'firestone', 'dunlop', 'sava', 'linglong', 'landsail', 'triangle', 'goodride', 'maxxis', 'mazzini', 'radar', 'greenmax', 'leao', 'sailun', 'barum', 'wanli', 'davanti', 'kenda', 'duraturn', 'fulda', 'roadstone', 'nordexx', 'cooper', 'uniroyal', 'semperit', 'kleber', 'bfgoodrich', 'apollo', 'laufenn', 'westlake', 'zeetex', 'tracmax', 'hifly', 'gripmax', 'imperial', 'minerva', 'rotalla', 'ovation', 'matador', 'viking', 'debica', 'kormoran', 'riken', 'tigar', 'petlas', 'lassa', 'ceat', 'general', 'avon', 'marshal', 'momo', 'evergreen', 'aplus', 'jinyu', 'antares', 'sunny', 'sunfull', 'habilead', 'kapsen', 'arivo', 'atlas', 'giti', 'gtradial', 'maxtrek', 'firemax', 'sentury', 'delinte', 'ilink', 'lanvigator', 'austone', 'atlander', 'sonix', 'milever', 'dynamo', 'toyotires'];
const BRAND_ALIAS = { conti: 'continental', 'nokiantyres': 'nokian', 'nokiannordman': 'nordman', 'gtradial': 'gtradial', 'toyotires': 'toyo', 'ling long': 'linglong', 'good year': 'goodyear', 'contiwintercontact': 'continental' };
// Words that describe the variant/fitment, not the model
// "winter"/"vinter" are deliberately NOT here: they are part of model names (WinterCraft,
// Winter i*Pike, ContiWinterContact, GreenMax Winter Grip).
const GENERIC = /\b(suv|xl|fr|ev|rft|rof|runflat|run flat|tl|bsw|m\+s|3pmsf|med pigger|uten pigger|pigget|piggfri|piggfrie|piggfritt|piggdekk|studded|studless|nordic|friction|vinterdekk|sommerdekk|helårsdekk|helarsdekk|dekk|tyre|tire|tires|seal|silent|sound|comfort|soundcomfort|elt|elect|electric|ao|mo|n0|n1|n2|\*|c)\b/gi;

export function fold(s) {
  return String(s || '').toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/[’'`´]/g, '').replace(/[^a-z0-9+*\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
/** strip dimension, load/speed index, price and other fitment noise from a product string */
export function stripFitment(s) {
  return String(s || '')
    .replace(/\b\d{3}\s*\/\s*\d{2}\s*[-–]?\s*[rR]?\s*\d{2}(?:[a-z])?\b/g, ' ')  // 205/55 R16, 205/55-16, 205/55R16
    // load/speed index: 94T, 91H, 104/102R — but not model codes like "10p" or "RS2"
    .replace(/\b(\d{2,3})(?:\/(\d{2,3}))?\s?([a-zA-Z])\b/g, (m, li, li2, sp) => (Number(li) >= 60 && Number(li) <= 130 && /^[thvwyqrszjkl]$/i.test(sp)) ? ' ' : m)
    .replace(/\b(?:nok|kr)\.?\s*[\d .,]+|[\d .,]+\s*kr(?:\/stk)?\b/gi, ' ')          // prices
    .replace(/\(\d[\d\s]*\s*(?:kg|km\/t)\)/gi, ' ')
    .replace(/\b(?:loadindex|maks|lasteindeks|hastighet)\b[^|]*/gi, ' ')
    .replace(/\|\s*\d{2,3}\s*\|\s*[A-Z]\b/g, ' ')                                    // dekk365: "| 94 | T (190 km/t)"
    .replace(/\b\d{10,}\b/g, ' ')                                                    // article numbers
    .replace(/\|.*$/, ' ');                                                          // anything after a pipe is fitment
}
export function brandOf(s) {
  const f = fold(stripFitment(s)).replace(/\s+/g, ' ');
  const compact = f.replace(/[^a-z0-9]/g, '');
  const first = f.split(' ')[0];
  // "conti" only as a whole word or glued to a Continental family (ContiWinterContact); never "Continue …"
  if (first === 'conti' || /^conti(winter|premium|ice|viking|sport|eco|cross|all|van)/.test(compact)) return 'continental';
  for (const [a, b] of Object.entries(BRAND_ALIAS)) if (a !== 'conti' && compact.startsWith(a.replace(/\s/g, ''))) return b;
  for (const b of BRANDS) if (compact.startsWith(b) && (compact.length === b.length || !/^[a-z]/.test(compact.slice(b.length)) || first === b || first.startsWith(b))) return b;
  // brand somewhere inside the string ("Dekk 205/55-16 91T Barum POLARIS 6")
  for (const b of BRANDS) if (new RegExp(`(^|\\s)${b}(\\s|$)`).test(f)) return b;
  for (const [a, b] of Object.entries(BRAND_ALIAS)) if (new RegExp(`(^|\\s)${a}(\\s|$)`).test(f)) return b;
  return null;
}
/** compact model key: letters+digits only, brand and generic words removed */
export function modelKey(s, brand) {
  let f = fold(stripFitment(s));
  f = f.replace(GENERIC, ' ');
  if (brand) {
    f = f.replace(new RegExp(`(^|\\s)${brand}(\\s|$)`, 'g'), ' ');
    for (const [a, b] of Object.entries(BRAND_ALIAS)) if (b === brand) f = f.replace(new RegExp(`(^|\\s)${a}(\\s|$)`, 'g'), ' ');
    if (brand === 'continental') f = f.replace(/\bconti(?=[a-z])/g, '');   // ContiWinterContact -> WinterContact
    if (brand === 'nordman') f = f.replace(/\bnokian\b/g, ' ');
  }
  f = f.replace(/\bgt radial\b/g, ' ').replace(/\bnokian tyres\b/g, ' ');
  f = f.replace(/\bhkpl\b/g, 'hakkapeliitta').replace(/\bhakkapeliita\b/g, 'hakkapeliitta').replace(/\bultra grip\b/g, 'ultragrip').replace(/\bx ice\b/g, 'xice').replace(/\bice zero\b/g, 'icezero').replace(/\bi\*?pike\b/g, 'ipike').replace(/\bi\*?cept\b/g, 'icept').replace(/\bwinter ?craft\b/g, 'wintercraft').replace(/\bviking ?contact\b/g, 'vikingcontact').replace(/\bpremium ?contact\b/g, 'premiumcontact').replace(/\bpremiumcontent\b/g, 'premiumcontact').replace(/\bice ?contact\b/g, 'icecontact').replace(/\bgreen-?max\b/g, 'greenmax').replace(/\bblizzak\b/g, 'blizzak');
  return f.replace(/[^a-z0-9]/g, '');
}
function editDistanceLE1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Build a matcher over a catalog (site/data/catalog.json).
 * Returns { match(name) -> [{tyre, test, score, variantNote}], groups(matches) }.
 */
export function buildMatcher(catalog) {
  const tests = new Map(catalog.tests.map(t => [t.id, t]));
  // Reference tyres are included too (a cheap EU tyre like ContiWinterContact TS860 was
  // Motor's reference in 2019 and has real numbers) but flagged so the caller can say so.
  const entries = catalog.tyres.filter(t => t.brand && t.name && t.name.split(' ').length > 1 && !/referanse|ref-?dekk|ukjent modell/i.test(t.name))
    .map(t => ({ tyre: t, test: tests.get(t.test_id), brand: t.brand, key: modelKey(t.name, t.brand) }))
    .filter(e => e.key.length >= 2 && e.key !== e.brand);
  function match(name) {
    const brand = brandOf(name); if (!brand) return [];
    const key = modelKey(name, brand); if (!key) return [];
    const out = [];
    for (const e of entries) {
      if (e.brand !== brand) continue;
      let score = 0, note = null;
      if (e.key === key) score = 3;
      else if (key.startsWith(e.key) || e.key.startsWith(key)) {
        // one is a prefix of the other: "hakkapeliitta10" vs "hakkapeliitta10ev" fine,
        // but "hakkapeliitta1" vs "hakkapeliitta10" is a different tyre — the extra part
        // must not begin with a digit continuing a number.
        const longer = key.length > e.key.length ? key : e.key, shorter = longer === key ? e.key : key;
        const rest = longer.slice(shorter.length);
        if (!/^\d/.test(rest) || !/\d$/.test(shorter)) { score = 2; note = rest ? `variant: ${rest}` : null; }
      } else if (key.length >= 8 && editDistanceLE1(key, e.key)) score = 1.5;
      else if (key.length >= 4 && /\d/.test(key) && e.key.endsWith(key)) { score = 1.5; note = 'kortform'; } // "Goodride Z-506" vs "IceMaster Spike Z-506"
      if (score && e.tyre.reference) { score -= 0.25; note = [note, 'referansedekk'].filter(Boolean).join(', '); }
      if (score) out.push({ tyre: e.tyre, test: e.test, score, note });
    }
    return out.sort((a, b) => b.score - a.score || (b.test?.year || 0) - (a.test?.year || 0));
  }
  return { match, entries };
}

/** Summarise a list of matches for a badge: latest test first, one line per test. */
export function summarise(matches, primaryFor = cls => (cls === 'sommer' || cls === 'sommer-budsjett') ? 'vat_brems' : 'is_brems') {
  const best = matches.length ? Math.max(...matches.map(m => m.score)) : 0;
  return matches.filter(m => m.score >= best - 0.5).map(m => {
    const key = primaryFor(m.tyre.class); const meas = m.tyre.measurements?.[key]; const sc = m.tyre.scores?.[key];
    return {
      id: m.tyre.id, year: m.test?.year, season: m.test?.season, class: m.tyre.class, name: m.tyre.name, url: m.tyre.url,
      points: m.tyre.points, rank: m.tyre.rank, verdict: m.tyre.verdict, disqualified: !!m.tyre.disqualified,
      brake_value: meas?.value ?? null, brake_unit: meas?.unit ?? null, brake_rel: meas?.rel ?? null,
      brake_points: sc?.p ?? null, brake_max: sc?.max ?? null, note: m.note, score: m.score,
    };
  });
}

/**
 * Pull product candidates out of pasted page text. Works line-oriented: a line that
 * starts with (or contains) a brand is a product title; the nearest price on the
 * same or following lines is attached. Handles the three shops' layouts:
 *   dekkonline: "Goodride" / "IceMaster Spike Z-506" / "205/55 R16 94T XL med pigger" / "1.011 kr"
 *   thansen:    "Continental - 205/55-16 91H ContiWinterContact TS860" / "NOK 909,30"
 *   dekk365:    "Nokian Hakkapeliitta 01" / "205/55R16 | 94 | T (190 km/t) | XL" / "1 940 kr/stk"
 */
export function extractFromText(text) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const isBrandOnly = l => BRANDS.includes(fold(l).replace(/\s/g, '')) || Object.keys(BRAND_ALIAS).includes(fold(l).replace(/\s/g, ''));
  const priceRx = /(?:nok|kr)\.?\s*([\d][\d .]*(?:,\d\d)?)|([\d][\d .]*(?:,\d\d)?)\s*(?:kr|,-)(?:\/stk)?/i;
  const out = []; const seen = new Set();
  const junk = /anmeldelse|meninger|filter|merke$|kategori|varemerke|obs!|[.!?](\s|$)|^(alle|velg|vis|les|se|kjøp|sammenlign)\b|\bfra\b.*\bkr\b/i;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.length > 120) continue;
    let name = null;
    if (isBrandOnly(line) && lines[i + 1] && lines[i + 1].length < 60 && !/^\d/.test(lines[i + 1]) && !isBrandOnly(lines[i + 1]) && !junk.test(lines[i + 1])) { name = `${line} ${lines[i + 1]}`; i++; }
    else if (brandOf(line) && !junk.test(line)) name = line;
    if (!name) continue;
    const brand = brandOf(name); const key = modelKey(name, brand);
    if (!key || key === brand || key.length < 2) continue;
    const dedupe = `${brand}|${key}`; if (seen.has(dedupe)) continue; seen.add(dedupe);
    let price = null;
    for (let j = i; j < Math.min(lines.length, i + 12); j++) {
      const m = lines[j].match(priceRx);
      if (m) { const n = Number((m[1] || m[2]).replace(/[ .]/g, '').replace(',', '.')); if (n >= 300 && n < 20000) { price = n; break; } }
      if (j > i && brandOf(lines[j]) && !isBrandOnly(lines[j - 1] || '')) break; // next product
    }
    out.push({ name: stripFitment(name).replace(/\s+/g, ' ').replace(/^dekk\s+/i, '').replace(/\s-\s/g, ' ').trim(), raw: name, brand, price });
  }
  return out;
}
