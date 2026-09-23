// Shop annotator body. Runs inside the IIFE that build-userscript.mjs wraps around
// match.js + this file, so `buildMatcher`, `summarise`, `brandOf`, `SITE` are in scope.
//
// Strategy: find product *titles* rather than product cards. A title is a short text
// that names a brand and a model. Each shop has a cheap selector for its title element;
// unknown pages fall back to scanning text nodes that start with a brand name. The
// badge is inserted right after the title and links to the tyre on the site.
// The catalog is fetched from GitHub Pages (CORS-open) and cached for a day.

const CATALOG_URL = SITE + 'data/catalog.json';
const CACHE_KEY = 'dekktester.catalog.v1';
const DAY = 24 * 3600 * 1000;

const SHOPS = [
  { host: /dekkonline\.com$/, titles: () => [...document.querySelectorAll('[itemtype*="schema.org/Product"]')].map(card => {
      const a = card.querySelector('.result-list-prod-name a, .advertised-search-list-prod-title a, a[href*="/rshop/"]');
      const brand = (card.querySelector('[itemprop="brand"]') || {}).textContent || '';
      const model = (card.querySelector('meta[itemprop="name"]') || {}).content || (a ? a.textContent : '');
      return a ? { el: a, name: `${brand} ${model}`.replace(/\s+/g, ' ').trim() } : null;
    }).filter(Boolean) },
  { host: /thansen\.no$/, titles: () => [...document.querySelectorAll('.ProductTitle__title, .ProductCard__title a')].map(a => ({ el: a, name: a.getAttribute('title') || a.textContent })) },
  // dekk365 has two .lnk-product-view per product (image + title); keep the one with text
  { host: /dekk365\.no$/, titles: () => [...document.querySelectorAll('a.lnk-product-view')].filter(a => a.textContent.trim().length > 3 && a.textContent.trim().length < 80).map(a => ({ el: a, name: a.textContent })) },
];
function genericTitles() {
  const out = []; const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const s = n.textContent.trim();
    if (s.length < 6 || s.length > 80 || !brandOf(s)) continue;
    const el = n.parentElement; if (!el || seen.has(el) || el.closest('select, option, nav, footer, [data-dekktester]')) continue;
    if (!/^(h\d|a|span|strong|b|div|p|td|li)$/i.test(el.tagName)) continue;
    seen.add(el); out.push({ el, name: s });
  }
  return out;
}

async function loadCatalog() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c && Date.now() - c.at < DAY) return c.data;
  } catch { /* ignore */ }
  const r = await fetch(CATALOG_URL, { cache: 'no-cache' });
  const data = await r.json();
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), data })); } catch { /* quota: fine, just refetch next time */ }
  return data;
}

const css = `
.dkt-badge{display:inline-flex;gap:.35em;align-items:center;margin:.15em .4em;padding:.1em .5em;border-radius:1em;font:600 12px/1.6 system-ui,sans-serif;text-decoration:none!important;border:1px solid #999;color:#222!important;background:#f3f3f3;vertical-align:middle;white-space:nowrap}
.dkt-badge.good{border-color:#1e8e3e;background:#e6f4ea;color:#0b5b24!important}
.dkt-badge.mid{border-color:#b26a00;background:#fdf1dc;color:#7a4a00!important}
.dkt-badge.bad{border-color:#c5221f;background:#fce8e6;color:#8a1a17!important}
.dkt-badge.none{border-style:dashed;color:#666!important;background:transparent}
.dkt-badge small{font-weight:400;opacity:.8}
`;

function badgeFor(hits, name) {
  const a = document.createElement('a');
  a.setAttribute('data-dekktester', '1'); a.target = '_blank'; a.rel = 'noopener';
  if (!hits.length) {
    a.className = 'dkt-badge none'; a.textContent = 'ikke testet av Motor';
    a.href = `${SITE}#/pigg?q=${encodeURIComponent(name)}`; a.title = 'Fant ingen Motor-test av dette dekket';
    return a;
  }
  const h = hits[0];
  const rel = h.brake_rel; const cls = rel == null ? '' : rel <= 1.05 ? 'good' : rel <= 1.15 ? 'mid' : 'bad';
  const tab = h.class === 'sommer' || h.class === 'sommer-budsjett' ? 'sommer' : h.class === 'piggfri' ? 'piggfri' : 'pigg';
  const brake = h.brake_value != null ? `${tab === 'sommer' ? 'våt' : 'is'} ${h.brake_value.toLocaleString('nb-NO', { maximumFractionDigits: 1 })} m${rel != null ? ` (${rel >= 1 ? '+' : ''}${Math.round((rel - 1) * 100)} %)` : ''}`
    : h.brake_points != null ? `${tab === 'sommer' ? 'våt' : 'is'} brems ${h.brake_points}/${h.brake_max || '?'} p` : '';
  a.className = `dkt-badge ${cls}`;
  a.href = `${SITE}#/${tab}?q=${encodeURIComponent(h.name)}&open=${encodeURIComponent(h.id)}`;
  a.innerHTML = `Motor ${h.year}${hits.length > 1 ? `<small>+${hits.length - 1}</small>` : ''} · ${brake}${h.points != null ? ` · ${h.points} p` : ''}${h.disqualified ? ' · disket' : ''}${h.note ? ' · ' + h.note.replace('variant: ', '≈') : ''}`;
  a.title = hits.map(x => `${x.year} ${x.class}: ${x.name}${x.verdict ? ' – ' + x.verdict : ''}${x.brake_value != null ? ` · brems ${x.brake_value} ${x.brake_unit || 'm'}` : ''}${x.points != null ? ` · ${x.points} p` : ''}`).join('\n');
  return a;
}

let matcher = null;
function annotate() {
  const shop = SHOPS.find(s => s.host.test(location.hostname));
  const titles = (shop ? shop.titles() : genericTitles())
    .filter(t => t.el && t.name && brandOf(t.name) && !t.el.nextElementSibling?.hasAttribute?.('data-dekktester') && !t.el.querySelector('[data-dekktester]'));
  let n = 0;
  for (const t of titles) {
    const hits = summarise(matcher.match(t.name));
    const badge = badgeFor(hits, t.name);
    t.el.insertAdjacentElement('afterend', badge); n++;
  }
  return n;
}

(async () => {
  if (document.getElementById('dkt-style')) return;
  const style = document.createElement('style'); style.id = 'dkt-style'; style.textContent = css; document.head.appendChild(style);
  try { matcher = buildMatcher(await loadCatalog()); } catch (e) { console.warn('[dekktester] catalog load failed', e); return; }
  annotate();
  // SPAs (thansen, dekk365) re-render the list on filter changes: re-annotate on DOM changes, debounced.
  let t = null;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { try { annotate(); } catch (e) { console.warn('[dekktester]', e); } }, 400); }).observe(document.body, { childList: true, subtree: true });
})();
