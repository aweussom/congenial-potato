/**
 * Dekktester — static front end over site/data/catalog.json.
 *
 * Three tabs (Sommerdekk / Piggfrie / Piggdekk), one flat list of every tyre from
 * every year in that class, sorted on the discipline that matters:
 *   sommer   -> bremselengde på våt asfalt (vat_brems)
 *   pigg/piggfri -> bremselengde på is (is_brems)
 * Default order is the measured distance relative to the best tyre in the same
 * test; click headers to sort on relative braking distance, points, total
 * points, year or name. The search box filters brand/model as you type.
 * State lives in the URL hash: #/pigg?q=nokian&year=2024&sort=rel
 */

import { buildMatcher, extractFromText, summarise } from './match.js';

const PRIMARY = { sommer: 'vat_brems', piggfri: 'is_brems', pigg: 'is_brems' };
const TAB_LABEL = { sommer: 'Sommerdekk', piggfri: 'Piggfrie vinterdekk', pigg: 'Piggdekk' };
const CLASS_LABEL = { sommer: 'sommer', 'sommer-budsjett': 'sommer (budsjett)', pigg: 'pigg', piggfri: 'piggfri', vinter: 'vinter, klasse ukjent' };

let catalog = null;
let testsById = new Map();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fold = s => String(s ?? '').toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/å/g, 'a').normalize('NFD').replace(/\p{Diacritic}/gu, '');
const fmt = (v, d = 1) => v == null ? '' : Number(v).toLocaleString('nb-NO', { minimumFractionDigits: d, maximumFractionDigits: d });

// ---- state <-> hash -------------------------------------------------------------------------
function readHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const tab = ['sommer', 'piggfri', 'pigg', 'tester', 'butikk'].includes(path) ? path : 'pigg';
  const p = new URLSearchParams(qs);
  const sort = p.get('sort') || 'rel';
  return { tab, q: p.get('q') || '', year: p.get('year') || '', brand: p.get('brand') || '', dim: p.get('dim') || '', maxrel: p.get('maxrel') || '', measured: p.get('measured') === '1', ref: p.get('ref') === '1', sort: sort === 'value' ? 'rel' : sort, dir: p.get('dir') || '', open: p.get('open') || '', text: p.get('text') || '' };
}
function writeHash(s) {
  const p = new URLSearchParams();
  for (const k of ['q', 'year', 'brand', 'dim', 'maxrel', 'sort', 'dir', 'open']) if (s[k]) p.set(k, s[k]);
  // pasted shop text is never written back into the URL (it can be 100 kB); it lives in sessionStorage
  if (s.measured) p.set('measured', '1');
  if (s.ref) p.set('ref', '1');
  const qs = p.toString();
  const next = `#/${s.tab}${qs ? '?' + qs : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}
let state = readHash();

// ---- data helpers ------------------------------------------------------------------------------
function tyresForTab(tab) {
  const key = PRIMARY[tab];
  // Rows that only exist because one stray table row could not be matched to a tyre
  // (no points, no primary measurement) add noise without information; hide them.
  const informative = t => !t.placeholder || t.points != null || t.measurements?.[key]?.value != null;
  if (tab === 'sommer') return catalog.tyres.filter(t => (t.class === 'sommer' || t.class === 'sommer-budsjett') && informative(t));
  if (tab === 'pigg') return catalog.tyres.filter(t => (t.class === 'pigg' || t.class === 'vinter') && informative(t));
  if (tab === 'piggfri') return catalog.tyres.filter(t => (t.class === 'piggfri' || t.class === 'vinter') && informative(t));
  return [];
}
/** the one number this tab is about, for one tyre */
function primary(t, key) {
  const m = t.measurements?.[key]; const s = t.scores?.[key];
  return { value: m?.value ?? null, unit: m?.unit ?? null, rel: m?.rel ?? null, cond: m?.conditions ?? null, p: s?.p ?? null, max: s?.max ?? null, share: s?.p != null && s?.max ? s.p / s.max : null };
}
const testOf = t => testsById.get(t.test_id);
const displayName = t => t.name.replace(/\s*\((pigg|piggfri|vinter), ukjent modell\)\s*$/, '');
function splitName(t) {
  const name = displayName(t);
  const b = t.brand ? name.match(new RegExp('^' + t.brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')) : null;
  if (b) return { brand: name.slice(0, b[0].length), model: name.slice(b[0].length).trim() };
  const i = name.indexOf(' ');
  return i > 0 ? { brand: name.slice(0, i), model: name.slice(i + 1) } : { brand: name, model: '' };
}

// ---- sorting -----------------------------------------------------------------------------------
const SORTS = {
  rel: { label: '% av beste', dir: 1, key: (t, k) => primary(t, k).rel },
  points: { label: 'Poeng', dir: -1, key: (t, k) => primary(t, k).share },
  total: { label: 'Totalt', dir: -1, key: t => t.points },
  year: { label: 'År', dir: -1, key: t => testOf(t)?.year },
  name: { label: 'Dekk', dir: 1, key: t => fold(displayName(t)) },
  dim: { label: 'Dimensjon', dir: 1, key: t => testOf(t)?.dimension || '' },
};
function sortTyres(list, key, sortKey, dir) {
  const s = SORTS[sortKey] || SORTS.rel; const d = dir === 'asc' ? 1 : dir === 'desc' ? -1 : s.dir;
  const fallback = t => { const p = primary(t, key); return -(p.share ?? -1); }; // no measurement: order by points share
  return [...list].sort((a, b) => {
    const ka = s.key(a, key), kb = s.key(b, key);
    const na = ka == null || ka === '', nb = kb == null || kb === '';
    if (na && nb) return fallback(a) - fallback(b) || (b.points ?? -1) - (a.points ?? -1);
    if (na) return 1; if (nb) return -1;
    if (typeof ka === 'string') return d * ka.localeCompare(kb, 'nb');
    return d * (ka - kb) || (b.points ?? -1) - (a.points ?? -1);
  });
}

// ---- filtering --------------------------------------------------------------------------------
function applyFilters(list, tab = state.tab) {
  const q = fold(state.q).trim().split(/\s+/).filter(Boolean);
  return list.filter(t => {
    if (!state.ref && t.reference) return false;
    if (state.measured && primary(t, PRIMARY[tab]).value == null) return false;
    if (state.maxrel) { const rel = primary(t, PRIMARY[tab]).rel; if (rel == null || rel > Number(state.maxrel) + 1e-9) return false; }
    const te = testOf(t);
    if (state.year && String(te?.year) !== state.year) return false;
    if (state.brand && fold(t.brand) !== fold(state.brand)) return false;
    if (state.dim && te?.dimension !== state.dim) return false;
    if (q.length) { const hay = fold(`${t.name} ${t.brand} ${t.verdict || ''} ${te?.year || ''}`); if (!q.every(w => hay.includes(w))) return false; }
    return true;
  });
}
function fillSelect(id, values, current, labelFn = v => v) {
  const sel = document.getElementById(id); const first = sel.options[0].outerHTML;
  sel.innerHTML = first + values.map(v => `<option value="${esc(v)}"${String(v) === current ? ' selected' : ''}>${esc(labelFn(v))}</option>`).join('');
  sel.value = current;
}

// ---- rendering ----------------------------------------------------------------------------------
function relClass(rel) { if (rel == null) return ''; return rel <= 1.05 ? 'rel-good' : rel <= 1.15 ? 'rel-mid' : 'rel-bad'; }
function renderTable(root) {
  const key = PRIMARY[state.tab];
  const all = tyresForTab(state.tab);
  const years = [...new Set(all.map(t => testOf(t)?.year).filter(Boolean))].sort((a, b) => b - a);
  const brands = [...new Set(all.map(t => t.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const dims = [...new Set(all.map(t => testOf(t)?.dimension).filter(Boolean))].sort();
  fillSelect('f-year', years.map(String), state.year);
  fillSelect('f-brand', brands, state.brand, b => b.charAt(0).toUpperCase() + b.slice(1));
  fillSelect('f-dim', dims, state.dim);
  document.getElementById('f-maxrel').value = state.maxrel;
  const rows = sortTyres(applyFilters(all), key, state.sort, state.dir);
  document.getElementById('count').textContent = rows.length === all.length ? `${rows.length} dekk` : `${rows.length} av ${all.length} dekk`;
  const unitLabelFor = tab => tab === 'sommer' ? 'Bremselengde våt asfalt' : 'Bremselengde is';
  const unitLabel = unitLabelFor(state.tab);
  const th = (k, label, cls = '') => { const active = (state.sort || 'rel') === k; const d = active ? (state.dir === 'asc' ? 1 : state.dir === 'desc' ? -1 : SORTS[k].dir) : 0; return `<th class="${cls}${active ? ' sorted' : ''}" data-sort="${k}">${label}${active ? `<span class="dir">${d > 0 ? '▲' : '▼'}</span>` : ''}</th>`; };
  const head = sortable => `<thead><tr>
        ${sortable ? th('name', 'Dekk') : '<th>Dekk</th>'}
        ${sortable ? th('year', 'År', 'num') : '<th class="num">År</th>'}
        ${sortable ? th('dim', 'Dimensjon') : '<th>Dimensjon</th>'}
        ${sortable ? th('rel', '% av beste', 'num') : '<th class="num">% av beste</th>'}
        ${sortable ? th('points', 'Poeng brems', 'num') : '<th class="num">Poeng brems</th>'}
        ${sortable ? th('total', 'Totalt', 'num') : '<th class="num">Totalt</th>'}
        <th title="Bremseprosedyre: fart, innendørs/utendørs, temperatur. Meter kan bare sammenlignes der denne er lik.">Prosedyre</th>
      </tr></thead>`;
  const measuredCount = rows.filter(t => primary(t, key).value != null).length;
  // No hits here but a search text: show what the *other* tabs have, clearly marked, so a
  // summer-tyre name typed under Piggdekk still leads somewhere.
  let crossHtml = '';
  if (!rows.length && state.q.trim()) {
    const groups = Object.keys(PRIMARY).filter(tab => tab !== state.tab).map(tab => ({ tab, rows: sortTyres(applyFilters(tyresForTab(tab), tab), PRIMARY[tab], 'rel', '') })).filter(g => g.rows.length);
    crossHtml = groups.length
      ? groups.map(g => `<div class="cross-note">Ingen treff blant ${TAB_LABEL[state.tab].toLowerCase()} for «${esc(state.q)}», men <strong>${g.rows.length}</strong> under
            <a href="#/${g.tab}?q=${encodeURIComponent(state.q)}">${TAB_LABEL[g.tab]}</a>. Radene under er sortert på ${unitLabelFor(g.tab).toLowerCase()}.</div>
          <div class="tbl-wrap cross"><table class="tyres">${head(false)}
            <tbody>${g.rows.map(t => rowHtml(t, PRIMARY[g.tab], TAB_LABEL[g.tab])).join('')}</tbody></table></div>`).join('')
      : `<p class="empty">Ingen dekk matcher «${esc(state.q)}» i noen fane.</p>`;
  }
  root.innerHTML = `
    <p class="intro"><strong>${TAB_LABEL[state.tab]}</strong> fra alle Motors tester, sortert på <strong>${unitLabel.toLowerCase()}</strong>.
      ${measuredCount} av ${rows.length} rader har målt bremselengde; resten har bare poeng og sorteres etter dem. «% av beste» er bremselengden i forhold til beste dekk i samme test.
      Klikk en rad for alle disipliner, pluss/minus og lenker.</p>
    ${rows.length || !crossHtml ? `<div class="tbl-wrap"><table class="tyres">${head(true)}
      <tbody>${rows.map(t => rowHtml(t, key)).join('')}</tbody>
    </table>${rows.length ? '' : '<p class="empty">Ingen dekk matcher filteret.</p>'}</div>` : ''}
    ${crossHtml}`;
  root.querySelectorAll('th[data-sort]').forEach(h => h.addEventListener('click', () => {
    const k = h.dataset.sort;
    if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : state.dir === 'desc' ? '' : (SORTS[k].dir > 0 ? 'desc' : 'asc');
    else { state.sort = k; state.dir = ''; }
    render();
  }));
  root.querySelectorAll('tr.row').forEach(tr => tr.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    state.open = state.open === tr.dataset.id ? '' : tr.dataset.id;
    render();
  }));
}
function rowHtml(t, key, crossTab = null) {
  const te = testOf(t); const p = primary(t, key); const { brand, model } = splitName(t);
  const badges = [
    crossTab ? `<span class="badge cross" title="Dette dekket hører til en annen fane">${esc(crossTab)}</span>` : '',
    t.reference ? '<span class="badge ref" title="Referansedekk: ikke en deltaker, kjørt for sammenligning">ref</span>' : '',
    t.disqualified ? '<span class="badge dq">disket</span>' : '',
    t.class === 'vinter' ? '<span class="badge unk" title="Kilden sier ikke om dette er pigg eller piggfritt">pigg/piggfri?</span>' : '',
    t.class === 'sommer-budsjett' ? '<span class="badge">budsjett</span>' : '',
    t.placeholder ? '<span class="badge unk" title="Bare kjent fra en tabell eller resultatliste, ingen egen artikkel">tabell</span>' : '',
  ].join('');
  const cond = p.cond || '';
  const proc = t.measurements?.[key]?.proc || (cond ? '(se detaljer)' : '');
  const open = state.open === t.id;
  const bar = p.rel != null ? `<span class="bar" style="width:${Math.min(60, Math.max(4, (p.rel - 0.95) * 300)).toFixed(0)}px"></span>` : '';
  return `<tr class="row" data-id="${esc(t.id)}">
      <td class="name"><span class="brand">${esc(brand)}</span> ${esc(model)}${badges}${t.verdict ? `<span class="verdict">${esc(t.verdict)}</span>` : ''}</td>
      <td class="num">${te?.year ?? ''}</td>
      <td class="dim">${esc(te?.dimension || '')}</td>
      <td class="num ${relClass(p.rel)}">${p.rel != null ? bar + fmt((p.rel - 1) * 100, 0).replace(/^(\d)/, '+$1') + ' %' : ''}</td>
      <td class="num">${p.p != null ? `${p.p}${p.max ? '/' + p.max : ''}` : '<span class="muted">–</span>'}</td>
      <td class="num">${t.points ?? ''}</td>
      <td class="muted" title="${esc(cond)}">${esc(proc)}</td>
    </tr>${open ? detailHtml(t) : ''}`;
}
const GROUPS = [['is', 'Is'], ['sno', 'Snø'], ['vat', 'Våt asfalt'], ['torr', 'Tørr asfalt'], ['annet', 'Annet']];
function detailHtml(t) {
  const te = testOf(t); const D = catalog.disciplines;
  const rows = Object.entries(D).filter(([k]) => t.scores?.[k] || t.measurements?.[k]);
  const byGroup = GROUPS.map(([g, label]) => [label, rows.filter(([k]) => D[k].group === g)]).filter(([, r]) => r.length);
  const table = byGroup.map(([label, r]) => `<tr><td colspan="3"><strong>${label}</strong></td></tr>` + r.map(([k, d]) => {
    const s = t.scores?.[k]; const m = t.measurements?.[k];
    return `<tr><td class="k">${esc(d.label)}</td><td class="num">${m?.value != null ? fmt(m.value, m.value >= 100 ? 0 : 2).replace(/,00$/, '') + ' ' + esc(m.unit || '') + (m.rel != null ? ` <span class="muted">(${fmt((m.rel - 1) * 100, 0).replace(/^(\d)/, '+$1')} %)</span>` : '') : ''}</td><td class="num">${s ? `${s.p}${s.max ? '/' + s.max : ''} p` : ''}</td></tr>`;
  }).join('')).join('');
  const facts = Object.entries(t.facts || {}).map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const conds = [...new Set(Object.values(t.measurements || {}).map(m => m.conditions).filter(Boolean))];
  const mains = (te?.main_ids || []).map(id => catalog.articles.find(a => a.id === String(id))).filter(Boolean);
  const q = encodeURIComponent(displayName(t));
  return `<tr class="detail"><td colspan="7"><div class="detail"><div class="detail-grid">
    <div>
      <h4>${esc(te?.title || te?.id || '')}</h4>
      <p class="muted">${esc([te?.dimension, te?.car, te?.location].filter(Boolean).join(' · '))}${t.rank ? ` · plass ${t.rank}` : ''}${t.points != null ? ` · ${t.points} poeng` : ''}</p>
      ${t.plus ? `<p><span class="plus">+</span> ${esc(t.plus)}</p>` : ''}${t.minus ? `<p><span class="minus">−</span> ${esc(t.minus)}</p>` : ''}
      ${t.intro ? `<p class="body">${esc(t.intro)}</p>` : ''}
      ${(t.body || []).slice(0, 4).map(p => `<p class="body">${esc(p)}</p>`).join('')}
      <p class="links">${t.url ? `<a href="${esc(t.url)}" target="_blank" rel="noopener">Motors omtale ↗</a>` : ''}
        ${mains.map(a => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.kicker ? a.kicker.replace(/:$/, '') : 'Hovedartikkel')} ↗</a>`).join('')}
        <a href="https://www.prisjakt.no/search?search=${q}" target="_blank" rel="noopener">Prisjakt ↗</a>
        <a href="https://www.google.com/search?q=${q}+pris" target="_blank" rel="noopener">Google ↗</a></p>
    </div>
    <div><h4>Disipliner (målt · poeng)</h4><table class="small">${table || '<tr><td class="muted">Ingen delresultater funnet.</td></tr>'}</table>
      ${conds.length ? `<p class="cond">${conds.map(esc).join('<br>')}</p>` : ''}</div>
    ${facts ? `<div><h4>Fakta</h4><table class="small">${facts}</table></div>` : ''}
  </div></div></td></tr>`;
}
function renderTests(root) {
  document.getElementById('filters').classList.add('hidden');
  const tests = catalog.tests;
  const KIND = { main: 'hovedartikkel', detail: 'alle tall', discipline: 'disiplin', method: 'metode' };
  root.innerHTML = `<p class="intro">Alle testene katalogen bygger på. Motor tester sommerdekk i mars og vinterdekk i september, sammen med svenske Vi Bilägare siden 2019. Artiklene krever NAF-medlemskap.</p>
  <div class="tests">${tests.map(te => {
    const arts = catalog.articles.filter(a => a.test_id === te.id && KIND[a.kind]).sort((x, y) => (x.kind === 'main' ? 0 : 1) - (y.kind === 'main' ? 0 : 1) || (x.published || '').localeCompare(y.published || ''));
    const cls = Object.entries(te.classes).map(([c, v]) => `${CLASS_LABEL[c] || c}: ${v.tyre_ids.length}`).join(', ');
    return `<div class="test"><h3>${esc(te.title)}</h3>
      <div class="meta">${esc([te.dimension, te.car, te.location].filter(Boolean).join(' · '))} · ${esc(cls)}${Object.keys(te.disciplines).length ? ` · målte verdier for ${Object.keys(te.disciplines).length} disipliner` : ' · bare poeng'}</div>
      <ul>${arts.slice(0, 40).map(a => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.kicker ? a.kicker.replace(/:$/, '') + ' ' : '')}${esc(a.title)}</a> <span class="muted">(${KIND[a.kind]})</span></li>`).join('')}</ul></div>`;
  }).join('')}</div>`;
}
// ---- "Sjekk butikk": paste a shop page, see which tyres are tested --------------------------
let _matcher = null;
function renderShop(root) {
  document.getElementById('filters').classList.add('hidden');
  _matcher ??= buildMatcher(catalog);
  const saved = (() => { try { return sessionStorage.getItem('shopText') || ''; } catch { return ''; } })();
  const text = state.text || saved;
  root.innerHTML = `
    <p class="intro"><strong>Sjekk butikk.</strong> Åpne søket ditt hos Dekkonline, Thansen, Dekk365 eller en annen nettbutikk, marker alt (Ctrl+A), kopier (Ctrl+C) og lim inn her (Ctrl+V).
      Produktnavn og priser plukkes ut og slås opp mot Motors tester. Ingenting sendes noe sted; alt skjer i nettleseren din.</p>
    <textarea id="shop-text" class="shop-text" placeholder="Lim inn teksten fra butikkens søkeresultat her …" spellcheck="false">${esc(text)}</textarea>
    <div class="shop-actions"><button id="shop-run" class="btn">Sjekk mot testene</button> <button id="shop-clear" class="btn secondary">Tøm</button> <span id="shop-count" class="muted"></span></div>
    <div id="shop-result"></div>`;
  const ta = root.querySelector('#shop-text');
  const run = () => {
    const t = ta.value; try { sessionStorage.setItem('shopText', t); } catch { /* ignore */ }
    renderShopResult(root.querySelector('#shop-result'), root.querySelector('#shop-count'), t);
  };
  root.querySelector('#shop-run').addEventListener('click', run);
  root.querySelector('#shop-clear').addEventListener('click', () => { ta.value = ''; state.text = ''; try { sessionStorage.removeItem('shopText'); } catch { /* ignore */ } run(); });
  let deb = null; ta.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(run, 250); });
  if (text) run();
  else ta.focus();
}
function renderShopResult(box, countEl, text) {
  const products = extractFromText(text);
  if (!products.length) { box.innerHTML = text.trim() ? '<p class="empty">Fant ingen produktnavn i teksten. Prøv å kopiere hele siden (Ctrl+A, Ctrl+C).</p>' : ''; countEl.textContent = ''; return; }
  const rows = products.map(p => ({ p, hits: summarise(_matcher.match(p.raw)) }));
  const tested = rows.filter(r => r.hits.length);
  countEl.textContent = `${products.length} produkter funnet, ${tested.length} er testet av Motor`;
  const relCls = rel => rel == null ? '' : rel <= 1.05 ? 'rel-good' : rel <= 1.15 ? 'rel-mid' : 'rel-bad';
  const pct = rel => rel == null ? '' : fmt((rel - 1) * 100, 0).replace(/^(\d)/, '+$1') + ' %';
  const hitHtml = h => `<div class="hit"><a href="#/${h.class === 'sommer' || h.class === 'sommer-budsjett' ? 'sommer' : h.class === 'piggfri' ? 'piggfri' : 'pigg'}?q=${encodeURIComponent(h.name)}&open=${encodeURIComponent(h.id)}${h.reference ? '&ref=1' : ''}">${h.year} ${esc(CLASS_LABEL[h.class] || h.class)}</a>
      · ${esc(h.name)}${h.note ? ` <span class="badge unk" title="Testet variant skiller seg fra butikkens">${esc(h.note)}</span>` : ''}${h.disqualified ? ' <span class="badge dq">disket</span>' : ''}
      · <span class="${relCls(h.brake_rel)}">${h.brake_value != null ? `brems ${fmt(h.brake_value, 1)} ${esc(h.brake_unit || 'm')} (${pct(h.brake_rel)})` : (h.brake_points != null ? `brems ${h.brake_points}/${h.brake_max || '?'} p` : 'ingen bremsetall')}</span>
      ${h.points != null ? `· ${h.points} p${h.rank ? `, plass ${h.rank}` : ''}` : ''}${h.verdict ? ` · <em>${esc(h.verdict)}</em>` : ''}</div>`;
  const sortKey = r => { const best = r.hits.map(h => h.brake_rel).filter(v => v != null); return best.length ? Math.min(...best) : (r.hits.length ? 1.5 : 9); };
  rows.sort((a, b) => sortKey(a) - sortKey(b) || (a.p.price ?? 1e9) - (b.p.price ?? 1e9));
  box.innerHTML = `<div class="tbl-wrap"><table class="tyres shop"><thead><tr><th>Produkt i butikken</th><th class="num">Pris</th><th>Motors tester (nyeste først)</th></tr></thead><tbody>
    ${rows.map(r => `<tr class="${r.hits.length ? '' : 'untested'}"><td class="name"><span class="brand">${esc(r.p.name)}</span></td><td class="num">${r.p.price != null ? fmt(r.p.price, 0) + ' kr' : ''}</td>
      <td class="hits">${r.hits.length ? r.hits.slice(0, 4).map(hitHtml).join('') : '<span class="muted">ikke testet</span>'}</td></tr>`).join('')}
  </tbody></table></div>`;
}
function render() {
  writeHash(state);
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === state.tab));
  const root = document.getElementById('app');
  if (state.tab === 'tester') return renderTests(root);
  if (state.tab === 'butikk') return renderShop(root);
  document.getElementById('filters').classList.remove('hidden');
  renderTable(root);
}

// ---- boot ----------------------------------------------------------------------------------------
async function main() {
  const r = await fetch('data/catalog.json', { cache: 'no-cache' });
  catalog = await r.json();
  testsById = new Map(catalog.tests.map(t => [t.id, t]));
  document.getElementById('built').textContent = `Katalog bygget ${new Date(catalog.built_at).toLocaleString('nb-NO')} · ${catalog.tests.length} tester · ${catalog.tyres.length} dekk-resultater · ${catalog.articles.length} artikler.`;
  const q = document.getElementById('q'); q.value = state.q;
  document.getElementById('f-measured').checked = state.measured;
  document.getElementById('f-ref').checked = state.ref;
  let deb = null;
  q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => { state.q = q.value; state.open = ''; render(); }, 80); });
  document.getElementById('f-maxrel').value = state.maxrel;
  for (const [id, key] of [['f-year', 'year'], ['f-brand', 'brand'], ['f-dim', 'dim'], ['f-maxrel', 'maxrel']]) document.getElementById(id).addEventListener('change', e => { state[key] = e.target.value; render(); });
  document.getElementById('f-measured').addEventListener('change', e => { state.measured = e.target.checked; render(); });
  document.getElementById('f-ref').addEventListener('change', e => { state.ref = e.target.checked; render(); });
  window.addEventListener('hashchange', () => {
    const s = readHash(); const prev = state;
    state = s;
    // Keep filters when moving between tyre lists. Shop and test pages hide those
    // controls, so carrying their old values into a shop-result link can hide the
    // exact tyre the user clicked (for example a +122 % result after a +5 % filter).
    if (s.tab !== prev.tab && PRIMARY[s.tab] && PRIMARY[prev.tab]) {
      for (const k of ['q', 'brand', 'maxrel', 'measured', 'ref']) if (!s[k] && prev[k]) state[k] = prev[k];
    }
    q.value = state.q; document.getElementById('f-measured').checked = state.measured; document.getElementById('f-ref').checked = state.ref;
    render();
  });
  render();
}
main().catch(e => { document.getElementById('app').innerHTML = `<p class="empty">Kunne ikke laste katalogen: ${esc(e.message)}</p>`; });
