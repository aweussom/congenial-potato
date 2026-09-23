#!/usr/bin/env node
/**
 * Build the shop annotator in two flavours from one source:
 *   docs/dekktester-butikk.user.js   Tampermonkey / Violentmonkey userscript
 *   extension/content.js (+ manifest.json)  unpacked Chrome extension (MV3 content script)
 *
 * Both are `tools/annotator.js` with `docs/match.js` inlined (exports stripped), so the
 * matching logic is the same as on the site. Re-run after editing either file:
 *   node tools/build-userscript.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const matchSrc = fs.readFileSync(path.join(root, 'docs', 'match.js'), 'utf8').replace(/^export\s+/gm, '');
const annotator = fs.readFileSync(path.join(here, 'annotator.js'), 'utf8');
const SITE = 'https://aweussom.github.io/congenial-potato/';

const body = `(function () {
'use strict';
const SITE = ${JSON.stringify(SITE)};
// ---- match.js (inlined) ----
${matchSrc}
// ---- annotator ----
${annotator}
})();
`;

const header = `// ==UserScript==
// @name         Dekktester: testresultater i nettbutikken
// @namespace    https://github.com/aweussom/congenial-potato
// @version      ${pkg.version}
// @description  Viser Motor.no / Vi Bilägares testresultat (bremselengde på is / våt asfalt, poeng) ved hvert dekk hos dekkonline.com, thansen.no og dekk365.no
// @author       aweussom
// @match        https://www.dekkonline.com/*
// @match        https://dekkonline.com/*
// @match        https://www.thansen.no/*
// @match        https://www.dekk365.no/*
// @grant        none
// @run-at       document-idle
// @downloadURL  ${SITE}dekktester-butikk.user.js
// @updateURL    ${SITE}dekktester-butikk.user.js
// ==/UserScript==

`;
fs.writeFileSync(path.join(root, 'docs', 'dekktester-butikk.user.js'), header + body);

const ext = path.join(root, 'extension');
fs.mkdirSync(ext, { recursive: true });
fs.writeFileSync(path.join(ext, 'content.js'), body);
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({
  manifest_version: 3,
  name: 'Dekktester: testresultater i nettbutikken',
  version: pkg.version,
  description: 'Viser Motor.no / Vi Bilägares dekktest-resultat ved hvert dekk hos dekkonline.com, thansen.no og dekk365.no',
  content_scripts: [{
    matches: ['https://www.dekkonline.com/*', 'https://dekkonline.com/*', 'https://www.thansen.no/*', 'https://www.dekk365.no/*'],
    js: ['content.js'], run_at: 'document_idle',
  }],
  host_permissions: [SITE + '*'],
}, null, 2));
console.log(`wrote docs/dekktester-butikk.user.js (${Math.round((header + body).length / 1024)} kB) and extension/{content.js,manifest.json}`);
