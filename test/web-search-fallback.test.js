'use strict';
// Web search: tell the owner plainly when search is the thin no-key fallback (DuckDuckGo alone), and keep setup in one
// place. Covers lib/web-search summary() and render(), the readiness 'search' item, and source pins on the Settings page.
// No network: createWebSearch gets injected settings, and the one search() call uses an injected fetch.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const iso = makeIsolatedInstall('ws-fallback-');
const { createWebSearch } = require(path.join(iso.inst, 'lib', 'web-search'));
const { createReadiness } = require(path.join(iso.inst, 'lib', 'readiness'));

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const byId = (r, id) => r.items.find(i => i.id === id);

function mk({ webSearch = {}, providerKeys = {}, fetchImpl } = {}) {
  return createWebSearch({
    getSetting: (k) => (k === 'webSearch' ? webSearch : undefined),
    getProviderKey: (p) => providerKeys[p] || '',
    getProviderUrl: () => '',
    fetchImpl: fetchImpl || (async () => { throw new Error('no network in this test'); }),
    dataDir: iso.data,
    log: () => {},
  });
}

// ── summary() ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('summary: no keys means DuckDuckGo alone, flagged as the fallback', () => {
  const s = mk().summary();
  assert.deepStrictEqual(s, { inUse: 'duckduckgo', inUseLabel: 'DuckDuckGo (scraped, no key)', off: false, fallbackOnly: true, perplexityKey: false, perplexityOn: false });
});

test('summary: a saved order with duplicates is read once per backend, so DuckDuckGo twice is still the fallback', () => {
  const ws = mk({ webSearch: { order: ['duckduckgo', 'duckduckgo'] } });
  assert.deepStrictEqual(ws.chain(), ['duckduckgo']);
  assert.strictEqual(ws.summary().fallbackOnly, true);
});

test('summary: off when the chain is empty; a Perplexity key with Perplexity turned off is set but not on', () => {
  const s = mk({ webSearch: { disabled: ['duckduckgo', 'perplexity'] }, providerKeys: { perplexity: 'pplx-example' } }).summary();
  assert.strictEqual(s.off, true);
  assert.strictEqual(s.perplexityKey, true);
  assert.strictEqual(s.perplexityOn, false);
});

test('summary: a Brave key puts Brave first and the fallback flag goes off', () => {
  const s = mk({ webSearch: { keys: { brave: 'k-example' } } }).summary();
  assert.strictEqual(s.inUse, 'brave');
  assert.strictEqual(s.inUseLabel, 'Brave Search API');
  assert.strictEqual(s.fallbackOnly, false);
  assert.strictEqual(s.perplexityKey, false);
});

test('summary: the Perplexity provider key counts, and leads when it comes first', () => {
  const s = mk({ webSearch: { order: ['perplexity', 'duckduckgo'] }, providerKeys: { perplexity: 'pplx-example' } }).summary();
  assert.strictEqual(s.perplexityKey, true);
  assert.strictEqual(s.inUse, 'perplexity');
  assert.strictEqual(s.fallbackOnly, false);
});

test('summary: DuckDuckGo switched off with nothing else leaves an empty chain, still flagged', () => {
  const ws = mk({ webSearch: { disabled: ['duckduckgo'] } });
  assert.deepStrictEqual(ws.chain(), []);
  const s = ws.summary();
  assert.strictEqual(s.inUse, null);
  assert.strictEqual(s.inUseLabel, null);
  assert.strictEqual(s.fallbackOnly, true);
});

test('status() carries the four summary fields', async () => {
  const st = await mk({ webSearch: { keys: { brave: 'k-example' } } }).status();
  assert.strictEqual(st.inUse, 'brave');
  assert.strictEqual(st.inUseLabel, 'Brave Search API');
  assert.strictEqual(st.fallbackOnly, false);
  assert.strictEqual(st.perplexityKey, false);
});

// ── render() ──────────────────────────────────────────────────────────────────────────────────────────────────────
const row = (backend) => ({ rank: 1, title: 'T', url: 'https://a.example/', snippet: '', date: '', backend });

test('render: an answer from DuckDuckGo says it is the free no-key fallback and thin', () => {
  const text = mk().render({ results: [row('duckduckgo')], tried: [], backend: 'duckduckgo' });
  assert.ok(text.endsWith('— 1 result(s) via DuckDuckGo, the free no-key fallback: results are thin'), text);
});

test('render: a keyed backend is named by its label, and what fell through is still listed', () => {
  const ws = mk();
  assert.ok(ws.render({ results: [row('brave')], tried: [], backend: 'brave' }).endsWith('— 1 result(s) via Brave Search API'));
  const t = ws.render({ results: [row('duckduckgo')], tried: [{ backend: 'brave', error: 'HTTP 429' }], backend: 'duckduckgo' });
  assert.ok(t.endsWith('results are thin; tried first: brave (HTTP 429)'), t);
});

test('render: through a real search with an injected fetch (DuckDuckGo page), the agent reads the fallback line', async () => {
  const html = '<table><tr><td><a class="result-link" href="https://example.org/a">Example A</a></td></tr><tr><td class="result-snippet">Snippet</td></tr></table>';
  const ws = mk({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => html }) });
  const r = await ws.search('anything');
  assert.strictEqual(r.backend, 'duckduckgo');
  assert.match(ws.render(r), /via DuckDuckGo, the free no-key fallback: results are thin$/);
});

test('render: the no-results line is unchanged', () => {
  assert.strictEqual(mk().render({ results: [], tried: [{ backend: 'duckduckgo', error: 'no results' }] }), '(no search results found — duckduckgo: no results)');
});

// ── readiness 'search' item ───────────────────────────────────────────────────────────────────────────────────────
const ready = (deps) => createReadiness({ hasUsers: () => true, listUsers: () => [{ login: 'owner', role: 'admin', totpEnabled: true }], ...deps }).check();

test('readiness: the fallback alone is a warning with the cost in the fix and a link to the Settings box', async () => {
  const it = byId(await ready({ searchSummary: () => ({ inUse: 'duckduckgo', inUseLabel: 'DuckDuckGo (scraped, no key)', fallbackOnly: true, chain: ['duckduckgo'] }) }), 'search');
  assert.strictEqual(it.level, 'warn');
  assert.strictEqual(it.title, 'Web search is using the free fallback; results are thin');
  assert.match(it.detail, /every search goes to DuckDuckGo \(scraped, no key\): a few thin results, sometimes none\. Agents on the Claude client use Claude's own search\.$/);
  assert.match(it.fix, /\$5 per 1,000 searches/);
  assert.match(it.fix, /Perplexity key you use for models counts too/);
  assert.deepStrictEqual(it.action, { label: 'Open web search settings', href: '/?websearch=1' });
});

test('readiness: the default (nothing passed) is the fallback warning, and an old searchChain-only caller still works', async () => {
  assert.strictEqual(byId(await ready({}), 'search').level, 'warn');
  const it = byId(await ready({ searchChain: () => ['brave', 'duckduckgo'] }), 'search');
  assert.strictEqual(it.level, 'ok');
  assert.match(it.detail, /^In use: Brave Search API \(then duckduckgo\)\.$/);
});

test('readiness: a keyed backend is ok and names the label and what follows', async () => {
  const it = byId(await ready({ searchSummary: () => ({ inUse: 'brave', inUseLabel: 'Brave Search API', fallbackOnly: false, chain: ['brave', 'duckduckgo'] }) }), 'search');
  assert.strictEqual(it.level, 'ok');
  assert.strictEqual(it.title, 'Web search ready');
  assert.strictEqual(it.detail, 'In use: Brave Search API (then duckduckgo).');
  const alone = byId(await ready({ searchSummary: () => ({ inUse: 'serper', inUseLabel: 'Serper (Google results)', fallbackOnly: false, chain: ['serper'] }) }), 'search');
  assert.strictEqual(alone.detail, 'In use: Serper (Google results).');
});

test('readiness: an empty chain says web search is off', async () => {
  const it = byId(await ready({ searchSummary: () => ({ inUse: null, inUseLabel: null, fallbackOnly: true, chain: [] }) }), 'search');
  assert.strictEqual(it.level, 'warn');
  assert.strictEqual(it.title, 'Web search is off');
  assert.strictEqual(it.detail, 'No search service is available, so agents that search through your Maestro get no results.');
  assert.strictEqual(it.fix, 'Add a search key (Brave, Serper or Tavily) in Settings → Web search and fetch, or ask your lead agent to switch DuckDuckGo back on.');
  assert.deepStrictEqual(it.action, { label: 'Open web search settings', href: '/?websearch=1' });
});

// ── the Settings page (source pins) ───────────────────────────────────────────────────────────────────────────────
test('Settings: In use row, Test web search button, Brave link and cost, Perplexity status', () => {
  assert.match(app, /id="st-ws-inuse"/);
  assert.match(app, /id="st-ws-test"/);
  assert.match(app, /<button class="st-test-btn" onclick="testWebSearch\(\)">Test web search<\/button>/);
  assert.match(app, /async function testWebSearch\(\)/);
  assert.match(app, /query: 'weather forecast tomorrow', maxResults: 10/);
  assert.match(app, /Answered by \$\{WS_LABELS\[r\.backend\] \|\| r\.backend\}\$\{r\.backend === 'duckduckgo' \? ', the free no-key fallback' : ''\}: \$\{n\} result\(s\) in/);
  assert.match(app, /<a href="https:\/\/brave\.com\/search\/api\/" target="_blank" rel="noopener">brave\.com\/search\/api<\/a>/);
  assert.match(app, /\$5 per 1,000 searches, \$5 of free credit each month \(about 1,000 searches\); Brave asks for a card/);
  assert.match(app, /id="st-ws-pplx"/);
  assert.match(app, /Your Perplexity key is set, so searches can use it\./);
  assert.match(app, /No Perplexity key; add one under LLM Providers to use Perplexity search\./);
  assert.match(app, /Web search is using the free fallback; results are thin\. Add a search key for much better research\./);
});

// ── the Settings status rows, run from app.js's own code against stub elements ───────────────────────────────────────
function loadStatusWith(respond) {
  const start = app.indexOf('    const WS_LABELS = {');
  const end = app.indexOf('    async function saveWebSearch() {');
  assert.ok(start > 0 && end > start, 'the web search status block is found in app.js');
  const els = {};
  for (const id of ['st-ws-status', 'st-ws-inuse', 'st-ws-pplx']) els[id] = { id, textContent: 'Checking…', innerHTML: '' };
  const sums = [];
  const document = { getElementById: (id) => els[id] || null };
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const stSum = (...a) => sums.push(a);
  const fetch = async () => respond();
  const run = new Function('document', 'esc', 'stSum', 'fetch', `${app.slice(start, end)}\nreturn loadWebSearchStatus();`);
  return run(document, esc, stSum, fetch).then(() => ({ els, sums }));
}
const okJson = (search) => ({ ok: true, status: 200, json: async () => ({ ok: true, search, fetch: {} }) });

test('Settings status: an error answer (503) is "unavailable", never "off", and clears the Perplexity line', async () => {
  const { els, sums } = await loadStatusWith(() => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }));
  assert.strictEqual(els['st-ws-inuse'].textContent, 'Search status unavailable.');
  assert.doesNotMatch(els['st-ws-inuse'].innerHTML, /off/);
  assert.strictEqual(els['st-ws-pplx'].textContent, '');
  assert.deepStrictEqual(sums, [['tools', 'search', 'web search: status unavailable', false]]);
});

test('Settings status: a good read then a failed refresh on the same page replaces the old summary and rows', async () => {
  const start = app.indexOf('    const WS_LABELS = {');
  const end = app.indexOf('    async function saveWebSearch() {');
  const els = {};
  for (const id of ['st-ws-status', 'st-ws-inuse', 'st-ws-pplx']) els[id] = { id, textContent: 'Checking…', innerHTML: '' };
  const sums = [];
  const answers = [okJson({ chain: ['duckduckgo'], backends: [], perplexityKey: true, perplexityOn: false, off: false, fallbackOnly: true }), { ok: false, status: 503, json: async () => ({}) }];
  const load = new Function('document', 'esc', 'stSum', 'fetch', `${app.slice(start, end)}\nreturn loadWebSearchStatus;`)(
    { getElementById: (id) => els[id] || null }, (s) => String(s), (...a) => sums.push(a), async () => answers.shift());
  await load();
  assert.deepStrictEqual(sums[0], ['tools', 'search', 'web search: free fallback', true]);
  assert.match(els['st-ws-pplx'].textContent, /set, but Perplexity search is turned off/);
  await load();
  assert.deepStrictEqual(sums[1], ['tools', 'search', 'web search: status unavailable', false]);
  assert.strictEqual(els['st-ws-inuse'].textContent, 'Search status unavailable.');
  assert.strictEqual(els['st-ws-pplx'].textContent, '');
});

test('Settings status: a 200 answer without a chain is "unavailable" too', async () => {
  const { els } = await loadStatusWith(() => ({ ok: true, status: 200, json: async () => ({ ok: true, search: {} }) }));
  assert.strictEqual(els['st-ws-inuse'].textContent, 'Search status unavailable.');
});

test('Settings status: an older server listing DuckDuckGo twice still shows the fallback warning', async () => {
  const { els, sums } = await loadStatusWith(() => okJson({ chain: ['duckduckgo', 'duckduckgo'], backends: [] }));
  assert.match(els['st-ws-inuse'].innerHTML, /using the free fallback/);
  assert.deepStrictEqual(sums[0], ['tools', 'search', 'web search: free fallback', true]);
});

test('Settings status: an empty chain says web search is off, not the free fallback', async () => {
  const { els, sums } = await loadStatusWith(() => okJson({ chain: [], backends: [], inUse: null, inUseLabel: null, off: true, fallbackOnly: true, perplexityKey: false, perplexityOn: false }));
  assert.match(els['st-ws-inuse'].innerHTML, /Web search is off/);
  assert.doesNotMatch(els['st-ws-inuse'].innerHTML, /free fallback/);
  assert.deepStrictEqual(sums[0], ['tools', 'search', 'web search: off', true]);
});

test('Settings status: an older server (chain and backends only) still shows the fallback warning and the Perplexity key', async () => {
  const { els, sums } = await loadStatusWith(() => okJson({ chain: ['duckduckgo'], backends: [{ id: 'perplexity', configured: false, disabled: true, hasKey: true }, { id: 'duckduckgo', configured: true }] }));
  assert.match(els['st-ws-inuse'].innerHTML, /using the free fallback; results are thin/);
  assert.deepStrictEqual(sums[0], ['tools', 'search', 'web search: free fallback', true]);
  assert.strictEqual(els['st-ws-pplx'].textContent, 'Your Perplexity key is set, but Perplexity search is turned off here.');
});

test('Settings status: a keyed chain names the first backend and what follows, with no warning', async () => {
  const { els, sums } = await loadStatusWith(() => okJson({ chain: ['brave', 'duckduckgo'], backends: [], inUse: 'brave', inUseLabel: 'Brave Search API', off: false, fallbackOnly: false, perplexityKey: true, perplexityOn: false }));
  assert.strictEqual(els['st-ws-inuse'].innerHTML, 'In use now: Brave Search API (then DuckDuckGo (scraped, no key))');
  assert.deepStrictEqual(sums[0], ['tools', 'search', 'web search: Brave Search API', false]);
  assert.strictEqual(els['st-ws-pplx'].textContent, 'Your Perplexity key is set, but Perplexity search is turned off here.');
});

test('Settings status: a failed status request says so instead of leaving "Checking…"', async () => {
  const { els } = await loadStatusWith(() => { throw new Error('offline'); });
  assert.strictEqual(els['st-ws-inuse'].textContent, 'Search status unavailable.');
  assert.strictEqual(els['st-ws-status'].textContent, 'Could not read the web search status.');
});

test('?websearch=1 opens Settings at the web search section and is dropped from the address', () => {
  assert.match(app, /websearch: q\.get\('websearch'\) === '1'/);
  assert.match(app, /if \(t\.websearch\) openSettingsAt\('st-ws-section'\);/);
  assert.match(app, /own\.wallet \|\| own\.websearch\)\) \{/);
  assert.match(app, /'connectors', 'wallet', 'websearch'\]\) u\.searchParams\.delete\(k\)/);
});
