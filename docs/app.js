/**
 * Dekktester — static front end over site/data/catalog.json.
 *
 * Three tabs (Sommerdekk / Piggfrie / Piggdekk), one flat list of every tyre from
 * every year in that class, sorted on the discipline that matters:
 *   sommer   -> bremselengde på våt asfalt (vat_brems)
 *   pigg/piggfri -> bremselengde på is (is_brems)
 * Default order is the measured distance relative to the best tyre in the same
 * test (comparable across years); click headers to sort on metres, points, total
 * points, year or name. The search box filters brand/model as you type.
 * State lives in the URL hash: #/pigg?q=nokian&year=2024&sort=value
 */

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
  const tab = ['sommer', 'piggfri', 'pigg', 'tester'].includes(path) ? path : 'pigg';
  const p = new URLSearchParams(qs);
  return { tab, q: p.get('q') || '', year: p.get('year') || '', brand: p.get('brand') || '', dim: p.get('dim') || '', measured: p.get('measured') === '1', ref: p.get('ref') === '1', sort: p.get('sort') || 'rel', dir: p.get('dir') || '', open: p.get('open') || '' };
}
function writeHash(s) {
  const p = new URLSearchParams();
  for (const k of ['q', 'year', 'brand', 'dim', 'sort', 'dir', 'open']) if (s[k]) p.set(k, s[k]);
  if (s.measured) p.set('measured', '1');
  if (s.ref) p.set('ref', '1');
  const qs = p.toString();
  const next = `#/${s.tab}${qs ? '?' + qs : ''}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}
let state = readHash();

// ---- data helpers ------------------------------------------------------------------------------
function tyresForTab(tab) {
  if (tab === 'sommer') return catalog.tyres.filter(t => t.class === 'sommer' || t.class === 'sommer-budsjett');
  if (tab === 'pigg') return catalog.tyres.filter(t => t.class === 'pigg' || t.class === 'vinter');
  if (tab === 'piggfri') return catalog.tyres.filter(t => t.class === 'piggfri' || t.class === 'vinter');
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
  value: { label: 'Meter', dir: 1, key: (t, k) => primary(t, k).value },
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
function applyFilters(list) {
  const q = fold(state.q).trim().split(/\s+/).filter(Boolean);
  return list.filter(t => {
    if (!state.ref && t.reference) return false;
    if (state.measured && primary(t, PRIMARY[state.tab]).value == null) return false;
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
  const rows = sortTyres(applyFilters(all), key, state.sort, state.dir);
  document.getElementById('count').textContent = rows.length === all.length ? `${rows.length} dekk` : `${rows.length} av ${all.length} dekk`;
  const disc = catalog.disciplines[key];
  const unitLabel = state.tab === 'sommer' ? 'Bremselengde våt asfalt' : 'Bremselengde is';
  const th = (k, label, cls = '') => { const active = (state.sort || 'rel') === k; const d = active ? (state.dir === 'asc' ? 1 : state.dir === 'desc' ? -1 : SORTS[k].dir) : 0; return `<th class="${cls}${active ? ' sorted' : ''}" data-sort="${k}">${label}${active ? `<span class="dir">${d > 0 ? '▲' : '▼'}</span>` : ''}</th>`; };
  const measuredCount = rows.filter(t => primary(t, key).value != null).length;
  root.innerHTML = `
    <p class="intro"><strong>${TAB_LABEL[state.tab]}</strong> fra alle Motors tester, sortert på <strong>${unitLabel.toLowerCase()}</strong>.
      ${measuredCount} av ${rows.length} rader har målt bremselengde; resten har bare poeng og sorteres etter dem. «% av beste» er bremselengden i forhold til beste dekk i samme test.
      Klikk en rad for alle disipliner, pluss/minus og lenker.</p>
    <div class="tbl-wrap"><table class="tyres">
      <thead><tr>
        ${th('name', 'Dekk')}
        ${th('year', 'År', 'num')}
        ${th('dim', 'Dimensjon')}
        ${th('value', unitLabel + ' (m)', 'num')}
        ${th('rel', '% av beste', 'num')}
        ${th('points', 'Poeng brems', 'num')}
        ${th('total', 'Totalt', 'num')}
        <th title="Bremseprosedyre: fart, innendørs/utendørs, temperatur. Meter kan bare sammenlignes der denne er lik.">Prosedyre</th>
      </tr></thead>
      <tbody>${rows.map(t => rowHtml(t, key)).join('')}</tbody>
    </table>${rows.length ? '' : '<p class="empty">Ingen dekk matcher filteret.</p>'}</div>`;
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
function rowHtml(t, key) {
  const te = testOf(t); const p = primary(t, key); const { brand, model } = splitName(t);
  const badges = [
    t.reference ? '<span class="badge ref" title="Referansedekk: ikke en deltaker, kjørt for sammenligning">ref</span>' : '',
    t.disqualified ? '<span class="badge dq">disket</span>' : '',
    t.class === 'vinter' ? '<span class="badge unk" title="Kilden sier ikke om dette er pigg eller piggfritt">pigg/piggfri?</span>' : '',
    t.class === 'sommer-budsjett' ? '<span class="badge">budsjett</span>' : '',
    t.placeholder ? '<span class="badge unk" title="Bare kjent fra en tabell eller resultatliste, ingen egen artikkel">tabell</span>' : '',
  ].join('');
  const cond = p.cond || '';
  const proc = t.measurements?.[key]?.proc || (cond ? cond.slice(0, 40) + (cond.length > 40 ? '…' : '') : '');
  const open = state.open === t.id;
  const bar = p.rel != null ? `<span class="bar" style="width:${Math.min(60, Math.max(4, (p.rel - 0.95) * 300)).toFixed(0)}px"></span>` : '';
  return `<tr class="row" data-id="${esc(t.id)}">
      <td class="name"><span class="brand">${esc(brand)}</span> ${esc(model)}${badges}${t.verdict ? `<span class="verdict">${esc(t.verdict)}</span>` : ''}</td>
      <td class="num">${te?.year ?? ''}</td>
      <td class="dim">${esc(te?.dimension || '')}</td>
      <td class="num">${p.value != null ? fmt(p.value, p.value >= 100 ? 0 : 1) + (p.unit && p.unit !== 'm' ? ' ' + esc(p.unit) : '') : '<span class="muted">–</span>'}</td>
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
  const facts = Object.entries(t.facts || {}).filter(([k]) => !/^Pigger$/.test(k) || true).map(([k, v]) => `<tr><td class="k">${esc(k === 'pigger' ? 'Pigger' : k)}</td><td>${esc(v)}</td></tr>`).join('');
  const conds = [...new Set(Object.values(t.measurements || {}).map(m => m.conditions).filter(Boolean))];
  const mains = (te?.main_ids || []).map(id => catalog.articles.find(a => a.id === String(id))).filter(Boolean);
  const q = encodeURIComponent(displayName(t));
  return `<tr class="detail"><td colspan="8"><div class="detail"><div class="detail-grid">
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
  root.innerHTML = `<p class="intro">Alle testene katalogen bygger på. Motor tester sommerdekk i mars og vinterdekk i september, sammen med svenske Vi Bilägare siden 2019.</p>
  <div class="tests">${tests.map(te => {
    const arts = catalog.articles.filter(a => a.test_id === te.id && a.kind !== 'tyre');
    const cls = Object.entries(te.classes).map(([c, v]) => `${CLASS_LABEL[c] || c}: ${v.tyre_ids.length}`).join(', ');
    return `<div class="test"><h3>${te.url ? `<a href="${esc(te.url)}" target="_blank" rel="noopener">${esc(te.title)}</a>` : esc(te.title)}</h3>
      <div class="meta">${esc([te.dimension, te.car, te.location].filter(Boolean).join(' · '))} · ${esc(cls)}${Object.keys(te.disciplines).length ? ` · målte verdier for ${Object.keys(te.disciplines).length} disipliner` : ' · bare poeng'}</div>
      <ul>${arts.filter(a => a.kind !== 'main').slice(0, 30).map(a => `<li><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.kicker ? a.kicker.replace(/:$/, '') + ' ' : '')}${esc(a.title)}</a> <span class="muted">(${a.kind})</span></li>`).join('')}</ul></div>`;
  }).join('')}</div>`;
}
function render() {
  writeHash(state);
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', a.dataset.tab === state.tab));
  const root = document.getElementById('app');
  if (state.tab === 'tester') return renderTests(root);
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
  for (const [id, key] of [['f-year', 'year'], ['f-brand', 'brand'], ['f-dim', 'dim']]) document.getElementById(id).addEventListener('change', e => { state[key] = e.target.value; render(); });
  document.getElementById('f-measured').addEventListener('change', e => { state.measured = e.target.checked; render(); });
  document.getElementById('f-ref').addEventListener('change', e => { state.ref = e.target.checked; render(); });
  window.addEventListener('hashchange', () => { const s = readHash(); if (s.tab !== state.tab) { state = { ...state, tab: s.tab, open: '' }; q.value = state.q; } else state = s; render(); });
  render();
}
main().catch(e => { document.getElementById('app').innerHTML = `<p class="empty">Kunne ikke laste katalogen: ${esc(e.message)}</p>`; });
