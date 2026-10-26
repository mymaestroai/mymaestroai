'use strict';
// Review fixes for the About box (PR #29): Copy details works on an http:// address on the home network (desktop and
// phone, also inside a modal dialog), keyboard focus stays inside the desktop About box and goes back where it came
// from, an earlier opening that is still loading never fills a newer box, and GET /api/version never fails on the
// restart scan nor puts an error message (which could name a file) in its answer. Pinned here; the browser proof
// (workspaces/maestro/pr29-fix-proof.py on a throwaway copy) shows them working.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mjs = read('mobile.js');

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let i = src.indexOf('{', src.indexOf(')', at)); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

test('desktop Copy details falls back to the older copy, inside its dialog, when the Clipboard API is missing', () => {
  const f = extract(app, 'filesCopy');
  assert.match(f, /if \(!ok\) \{/);
  assert.match(f, /\(\(btn && btn\.closest\('dialog, \.question-overlay'\)\) \|\| document\.body\)\.appendChild\(ta\);/);
  assert.match(f, /ok = document\.execCommand\('copy'\);/);
  assert.match(f, /back\.focus\(\{ preventScroll: true \}\)/, 'focus goes back to the button');
});

test('phone copy fallback goes inside the open (modal) dialog', () => {
  const f = extract(mjs, 'legacyCopy');
  assert.match(f, /document\.querySelector\('dialog:modal'\)/);
  assert.match(f, /\(host \|\| document\.querySelector\('dialog\[open\]'\) \|\| document\.body\)\.appendChild\(ta\);/);
  assert.ok(!/document\.body\.appendChild\(ta\)/.test(f), 'never straight into the (inert) page');
});

test('desktop About: Tab stays inside, Esc always closes, focus goes back to the opener, stale openings stop', () => {
  const f = extract(app, 'openAboutDialog');
  assert.match(f, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(\); return; \}/);
  assert.match(f, /document\.addEventListener\('keydown', onKey, true\);/, 'held on the page, wherever focus is');
  assert.match(f, /document\.removeEventListener\('keydown', onKey, true\);\s*overlay\.remove\(\);/, 'and let go on close');
  assert.match(f, /t\.closest\('\[class\*="overlay"\], dialog, \[role="dialog"\], \[aria-modal="true"\]'\)\) return;/, 'any other box or panel keeps its keys');
  assert.match(f, /if \(e\.key !== 'Tab'\) return;[\s\S]*f\[i < 0 \? 0 : \(i \+ \(e\.shiftKey \? -1 : 1\) \+ f\.length\) % f\.length\]\.focus\(\);/);
  assert.match(f, /opener\.offsetParent !== null \? opener : document\.getElementById\('more-btn'\)/, 'focus back to the opener, or ⋯ when its menu closed');
  assert.match(f, /if \(!overlay\.isConnected\) return;/);
  assert.ok(!/document\.getElementById\('about-(body|update|copy)'\)/.test(f), 'lookups are scoped to this overlay');
  assert.ok(!/overlay\.remove\(\); if \(ub/.test(f), 'Update closes through close()');
});

test('phone About: an earlier opening still loading never fills a newer sheet', () => {
  const f = extract(mjs, 'openAboutSheet');
  assert.match(f, /d\._opening = opening;/);
  assert.match(f, /if \(!d\.open \|\| d\._opening !== opening\) return;/);
});

test('GET /api/version: the restart scan cannot fail it, and an error answer names nothing on the computer', () => {
  assert.match(read('lib/hub-map.js'), /let restartPending = null;[\s\S]{0,120}try \{ restartPending = !!codeChanged\(\); \} catch \(e\) \{/, 'a failed scan is unknown, not no');
  const { versionDetailsText } = require('../lib/ui-version-label');
  assert.ok(versionDetailsText({ version: '5.7.3', restartPending: null }).includes('Restart pending: unknown'));
  assert.ok(versionDetailsText({ version: '5.7.3', restartPending: false }).includes('Restart pending: no'));
  const s = read('server.js');
  assert.match(s, /pathname === '\/api\/version'[\s\S]{0,400}jsonResponse\(res, 500, \{ error: 'Could not read the version' \}\)/);
  assert.ok(!/pathname === '\/api\/version'[\s\S]{0,400}error: e\.message/.test(s));
  const { createHubMap } = require('../lib/hub-map');
  const v = createHubMap({ root, startedAt: new Date(), gitInfo: '2522a10 2026-10-26', gitBranch: 'dev', version: '5.7.3' }).versionInfo();
  assert.deepStrictEqual(Object.keys(v).sort(), ['branch', 'channel', 'commit', 'commitDate', 'node', 'restartPending', 'startedAt', 'version']);
  assert.strictEqual(typeof v.restartPending, 'boolean');
});
