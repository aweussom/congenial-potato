#!/usr/bin/env node
/**
 * Stage 2: raw HTML -> per-article structured JSON (crawler/parsed/<id>.json).
 *
 * This is deliberately a *generic* extractor: it pulls out everything in a motor.no
 * article that can carry test data, without yet deciding what a "test" or a "tyre"
 * is. Stage 3 (build-catalog.mjs) does the interpretation. Keeping the two apart
 * means we can re-run the interpretation cheaply while tuning it.
 *
 * What we extract per article:
 *   meta        JSON-LD NewsArticle: headline, description, published/modified,
 *               author, keywords, section, isAccessibleForFree, url, id
 *   kicker/title/subtitle from the article header
 *   headings    ordered h1-h4 in <main>
 *   paragraphs  body text paragraphs (ads, nav, "les også" widgets removed)
 *   factboxes   text of .factbox elements
 *   plusminus   "Pluss: … Minus: …" verdict lines when present
 *   motortest   the Labrador "motortest" widget used on per-tyre pages:
 *               { name, points, load_speed_index, facts{…}, groups{Is:{Bremselengde:15,…},…} }
 *   tables      every <table>: header row, rows, and the nearest preceding heading
 *               (h2/h3) + the nearest preceding "section" heading in CAPS
 *               (e.g. PIGGFRIE DEKK / PIGGDEKK) so measurement tables can be
 *               attributed to a discipline and tyre class.
 *   cards       teaser cards inside the article (score + verdict + href) — how the
 *               2021+ main articles link to the per-tyre sub-articles
 *   links       all motor.no article links in the content area
 *
 * Usage: node crawler/parse.mjs [--raw crawler/raw] [--out crawler/parsed] [--only 367185,367635]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const RAW = path.resolve(root, opt('--raw', 'crawler/raw'));
const OUT = path.resolve(root, opt('--out', 'crawler/parsed'));
const ONLY = opt('--only', null)?.split(',').map(s => s.trim()).filter(Boolean);

const clean = s => String(s ?? '').replace(/­/g, '').replace(/\s+/g, ' ').trim();
const idOf = u => { const m = String(u).match(/\/(\d{5,7})(?:[?#]|$)/); return m ? m[1] : null; };
const numNo = s => { const m = clean(s).replace(/\s/g, '').match(/^-?\d+(?:[.,]\d+)?$/); return m ? Number(m[0].replace(',', '.')) : null; };

export function parseArticle(html, id) {
  const $ = cheerio.load(html);
  const out = { id, parsed_at: new Date().toISOString() };

  // ---- JSON-LD ------------------------------------------------------------------
  $('script[type="application/ld+json"]').each((_, s) => {
    try {
      const j = JSON.parse($(s).contents().text());
      const arr = Array.isArray(j) ? j : [j];
      for (const x of arr) if (x && x['@type'] === 'NewsArticle') {
        out.meta = {
          headline: clean(x.headline), description: clean(x.description), url: x.url,
          published: x.datePublished, modified: x.dateModified,
          authors: (Array.isArray(x.author) ? x.author : [x.author]).filter(Boolean).map(a => clean(a.name)),
          keywords: clean(x.keywords).split(',').map(k => k.trim()).filter(Boolean),
          section: x.articleSection, free: x.isAccessibleForFree,
          image: Array.isArray(x.image) ? x.image[0]?.url : x.image?.url,
        };
      }
    } catch { /* ignore broken ld+json */ }
  });

  const main = $('main').length ? $('main') : $('body');
  // Strip noise before text extraction.
  main.find('script, style, noscript, iframe, .google-ad, .adunit, .ad-label, [class*="adnami"], .cookie, nav').remove();
  // Sidebar / "read more" chrome lives in section.related, .front_rows and the
  // article scroller ("Les alle biltestene på Motor"). Drop it up front so headings,
  // cards and links only reflect the article's own content.
  main.find('section.related, .front_rows, .articlescroller, .row.social').remove();

  // ---- header ----------------------------------------------------------------------
  out.kicker = clean(main.find('.kicker, [itemprop="alternativeHeadline"], .articleHeader .kicker').first().text()) || null;
  out.title = clean(main.find('h1').first().text()) || out.meta?.headline || null;
  out.subtitle = clean(main.find('.subtitle, [itemprop="description"], .articleHeader .subtitle').first().text()) || out.meta?.description || null;
  out.headings = main.find('h1, h2, h3, h4').map((_, h) => ({ tag: h.tagName.toLowerCase(), text: clean($(h).text()) })).get().filter(h => h.text);

  // ---- motortest widget (per-tyre pages) ----------------------------------------
  // Markup (Labrador "motortest" element):
  //   <div id="motortest_N" class="motortest … test-winterTire|test-summerTire">
  //     <section class="title"><h1 class="test-title">Nokian Hakkapeliitta 9</h1>
  //        <h3 class="test-score"><span>84</span> poeng</h3>
  //        <p class="intro"><span class="test-key-value"><span class="test-key">Last- og hastighetsindeks:</span><span class="test-value">94T</span></span></p>
  //     <section><h3 class="test-subtitle">Fakta</h3> …key/value pairs…, <p>intro text</p>, optional table rows
  //     <section><h3 class="test-subtitle">Is</h3> Akselerasjon:9 Bremselengde:10 Kjøreegenskaper:10   (etc.)
  out.motortest = null;
  const mt = main.find('.motortest, [id^="motortest"]').first();
  if (mt.length) {
    const widget = {
      name: clean(mt.find('.test-title').first().text()) || null,
      points: numNo(mt.find('.test-score span').first().text()) ?? numNo((clean(mt.find('.test-score').text()).match(/(\d+)/) || [])[1]),
      // test-winterTire / test-summerTire on tyre pages; Motor's car tests use the same
      // widget with another test-* class, so `kind` null means "not a tyre".
      kind: /summerTire/i.test(mt.attr('class') || '') ? 'sommer' : /winterTire/i.test(mt.attr('class') || '') ? 'vinter' : null,
      widget_class: (mt.attr('class') || '').split(/\s+/).filter(c => /^test-/.test(c)).join(' ') || null,
      intro: null, facts: {}, groups: {},
    };
    const pairsIn = (scope, target) => {
      scope.find('.test-key-value').each((_, kv) => {
        const k = clean($(kv).find('.test-key').text()).replace(/:$/, '');
        const v = clean($(kv).find('.test-value').text());
        if (!k) return;
        const n = numNo(v);
        target[k] = n ?? v;
      });
    };
    pairsIn(mt.find('section.title'), widget.facts);
    mt.find('section').not('.title').each((_, sec) => {
      const $sec = $(sec);
      const group = clean($sec.find('.test-subtitle').first().text()) || 'Annet';
      if (group === 'Fakta') {
        pairsIn($sec, widget.facts);
        const intro = clean($sec.find('p p, p.description > p').first().text());
        if (intro) widget.intro = intro;
        // extra rows (2026+): "Mønsterdybde mm 8,9 / Gummihardhet (Shore) 54 / Veislitasje A+", often in a table or tab-separated text
        $sec.find('tr').each((_, tr) => { const c = $(tr).children().map((_, x) => clean($(x).text())).get(); if (c.length >= 2 && c[0]) widget.facts[c[0]] = numNo(c[1]) ?? c[1]; });
        const t = clean($sec.text());
        const fx = t.match(/Mønsterdybde mm\s*([\d,.]+)/); if (fx) widget.facts['Mønsterdybde mm'] = numNo(fx[1]);
        const gh = t.match(/Gummihardhet \(Shore\)\s*(\d+)/); if (gh) widget.facts['Gummihardhet (Shore)'] = Number(gh[1]);
        const vs = t.match(/Veislitasje\s*([A-Z]\+?)\b/); if (vs) widget.facts['Veislitasje'] = vs[1];
        return;
      }
      widget.groups[group] ??= {};
      pairsIn($sec, widget.groups[group]);
    });
    out.motortest = widget;
  }

  // ---- "brand value" text runs (2017-2018 discipline articles) ------------------------
  // The old per-discipline articles ("Bremsing på glatt is", "Bremsing på våt asfalt" …)
  // carried a results table whose markup did not survive a CMS migration; what is left
  // is a flat run of text like "Dekk Bremselengde (m) Goodyear 39,9 Nokian 40,0 …" inside
  // .bodytext. We pull out every run of >= 5 (name, number) pairs and keep the label
  // text that precedes it (unit lives there: "(m)", "(sek)", "(dB)" …).
  out.runs = [];
  {
    const bodyText = clean(main.find('.bodytext').text() || '');
    const pairRx = /([A-ZÆØÅ][A-Za-zÆØÅæøå'’*\-]+(?:\s(?:[A-Z][A-Za-z\-]*|\d+[A-Za-z]*))?)\s(\d{1,3}(?:[.,]\d{1,2})?)(?=\s|$)/g;
    let m, run = [], runStart = -1, lastEnd = -1;
    const flush = () => {
      if (run.length >= 5) {
        const before = bodyText.slice(Math.max(0, runStart - 160), runStart);
        const lab = before.match(/(?:Dekk\s+)?([^.!?]*?(?:\((?:m|meter|sek|s|dB|l\/100 ?km|kWh\/100 ?km|km\/t|poeng|%|N|mm)\)|Bremselengde|Poeng|Rullemotstand|Støy|Forbruk|Tid|Akselerasjon)[^.!?]*?)\s*$/i);
        out.runs.push({ label: lab ? clean(lab[1]) : clean(before.slice(-60)), items: run });
      }
      run = []; runStart = -1;
    };
    while ((m = pairRx.exec(bodyText))) {
      if (lastEnd >= 0 && m.index - lastEnd > 3) flush();
      if (!run.length) runStart = m.index;
      // "Karakter Continental 9" / "Dekk Goodyear 39,9": the first word is a column label, not part of the brand
      const name = m[1].replace(/^(Karakter|Dekk|Poeng|Plass|Tid|Meter|Sek|Snitt|Resultat)\s+/i, '');
      run.push({ name, value: Number(m[2].replace(',', '.')) });
      lastEnd = pairRx.lastIndex;
    }
    flush();
  }

  // ---- plus/minus verdict -------------------------------------------------------------
  // "PLUSS: Vintergrep, kjøreglede. MINUS: Vannplaning, styrefølelse på tørr vei." — each part
  // is one sentence; take up to the first period (or 200 chars) after MINUS.
  const pm = clean(main.text()).match(/(?:PLUSS|Pluss)\s*:\s*(.+?)\s*(?:MINUS|Minus)\s*:\s*(.{1,200}?(?:\.|$))/);
  out.plusminus = pm ? { plus: clean(pm[1]).slice(0, 300), minus: clean(pm[2]).slice(0, 300) } : null;

  // ---- factboxes --------------------------------------------------------------------
  out.factboxes = main.find('.factbox').map((_, f) => clean($(f).text())).get().filter(Boolean);

  // ---- tables, with heading context ------------------------------------------------
  out.tables = [];
  main.find('table').each((_, t) => {
    const rows = $(t).find('tr').toArray()
      .map(tr => $(tr).children('td,th').toArray().map(c => clean($(c).text())))
      .filter(r => r.length && r.some(Boolean));
    if (!rows.length) return;
    // nearest preceding heading (h2/h3/h4, or a short "Label:" paragraph) and the nearest
    // preceding ALL-CAPS heading, which the 2024+ detail articles use as class headers
    // (PIGGFRIE DEKK / PIGGDEKK).
    let heading = null, section = null, caption = clean($(t).find('caption').text()) || null;
    const lead = []; // paragraphs between the heading and the table: test conditions ("Innendørs, -5 til -6°", "ABS-bremsing 25–5 km/t …")
    const before = []; // the few headings preceding the table, nearest first (a table titled just "Resultater" gets its discipline from the one before)
    const all = main.find('h1, h2, h3, h4, table, p');
    const idx = all.index(t);
    for (let i = idx - 1; i >= 0 && (heading === null || section === null || before.length < 3); i--) {
      const el = all.eq(i); const tag = el.get(0).tagName.toLowerCase(); const text = clean(el.text());
      if (!text) continue;
      const isHeading = /^h[1-4]$/.test(tag);
      if (isHeading && before.length < 3) before.push(text);
      // Keep the paragraphs under the two nearest headings: the detail articles put the
      // discipline name in one heading, the conditions in paragraphs, then a second
      // heading right above the table ("Bremsing på is, 25–5 km/t").
      if (before.length < 2 && tag === 'p' && text.length < 400 && !/^Kommentar/i.test(text)) lead.unshift(text);
      if (heading === null && isHeading) heading = text;
      if (section === null && isHeading && text.length < 40 && text === text.toUpperCase() && /[A-ZÆØÅ]{4,}/.test(text) && !/^(PLUSS|MINUS)/.test(text)) section = text;
      if (heading === null && tag === 'p' && text.length < 60 && /:$/.test(text)) heading = text.replace(/:$/, '');
      if (tag === 'table' && heading === null) break; // another table in between: no shared heading
    }
    out.tables.push({ heading, headings_before: before, section, caption, lead: lead.slice(-3), header: rows[0], rows: rows.slice(1) });
  });

  // ---- teaser cards inside content ----------------------------------------------------
  // Content cards (Labrador teaser elements). The 2021+ main test articles link each
  // per-tyre sub-article through one of these, with the tyre's total score as a label:
  //   <article data-instance="208152" data-tag="205/55 r 16,goodyear,piggdekk,vinterdekk2021,…">
  //     <a href="/tester/…/208152"> … <div class="label" data-label-key="testresult" data-label-value="87">
  //     <h2 class="headline">Testvinner med godt grep</h2>
  out.cards = [];
  const flow = main.find('h1, h2, h3, h4, article'); // for "which ALL-CAPS section heading precedes this card"
  main.find('article').each((_, a) => {
    const $a = $(a);
    const href = $a.find('a[href]').first().attr('href');
    if (!href || !idOf(href)) return;
    let cardSection = null;
    for (let i = flow.index(a) - 1; i >= 0; i--) {
      const el = flow.eq(i); if (el.get(0).tagName.toLowerCase() === 'article') continue;
      const text = clean(el.text());
      if (text && text.length < 40 && text === text.toUpperCase() && /[A-ZÆØÅ]{4,}/.test(text)) { cardSection = text; break; }
    }
    const label = $a.find('[data-label-key="testresult"]').first().attr('data-label-value');
    const text = clean($a.text());
    const lead = text.match(/^(\d{1,3})\s/);
    out.cards.push({
      id: idOf(href), href: href.startsWith('http') ? href : `https://www.motor.no${href}`,
      instance: $a.attr('data-instance') || null,
      tags: ($a.attr('data-tag') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      section: $a.attr('data-section') || null,
      under: cardSection,
      score: label != null && label !== '' ? Number(label) : (lead ? Number(lead[1]) : null),
      kicker: clean($a.find('.kicker').text()) || null,
      title: clean($a.find('.headline, h2, h3, h4').first().text()) || null,
      subtitle: clean($a.find('.subtitle').first().text()) || null,
      paywall: $a.hasClass('paywall'),
      text: text.slice(0, 220),
    });
  });

  // ---- body paragraphs ------------------------------------------------------------------
  const body = main.find('.bodytext').length ? main.find('.bodytext') : main;
  out.paragraphs = body.find('p, li, h2, h3').map((_, p) => clean($(p).text())).get().filter(t => t && t.length > 1);
  out.text = clean(main.text());

  // ---- links --------------------------------------------------------------------------------
  const links = new Set();
  main.find('a[href*="motor.no/"]').each((_, a) => { const h = $(a).attr('href'); if (idOf(h)) links.add(h.split('?')[0]); });
  out.links = [...links];

  // ---- tags (bottom of article) ----------------------------------------------------------
  out.tags = main.find('a[href*="/tag/"]').map((_, a) => clean($(a).text()).toLowerCase()).get().filter(Boolean);
  return out;
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('parse.mjs')) {
  fs.mkdirSync(OUT, { recursive: true });
  const files = fs.readdirSync(RAW).filter(f => /^\d+\.html$/.test(f)).filter(f => !ONLY || ONLY.includes(f.replace('.html', '')));
  let n = 0, withWidget = 0, withTables = 0;
  for (const f of files) {
    const id = f.replace('.html', '');
    const html = fs.readFileSync(path.join(RAW, f), 'utf8');
    const parsed = parseArticle(html, id);
    fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(parsed, null, 1));
    n++; if (parsed.motortest) withWidget++; if (parsed.tables.length) withTables++;
  }
  console.log(`parsed ${n} articles -> ${path.relative(root, OUT)} (${withWidget} with motortest widget, ${withTables} with tables)`);
}
