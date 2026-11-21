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
  assert.deepStrictEqual(s, { inUse: 'duckduckgo', inUseLabel: 'DuckDuckGo (scraped, no key)', fallbackOnly: true, perplexityKey: false });
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
  assert.strictEqual(it.detail, 'No search backend is set up, so agents that search through your Maestro get no results.');
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
  assert.match(app, /stSum\('tools', 'search', s\.fallbackOnly \? 'web search: free fallback' : `web search: \$\{s\.inUseLabel \|\| chain\}`, !!s\.fallbackOnly\)/);
});

test('?websearch=1 opens Settings at the web search section and is dropped from the address', () => {
  assert.match(app, /websearch: q\.get\('websearch'\) === '1'/);
  assert.match(app, /if \(t\.websearch\) openSettingsAt\('st-ws-section'\);/);
  assert.match(app, /own\.wallet \|\| own\.websearch\)\) \{/);
  assert.match(app, /'connectors', 'wallet', 'websearch'\]\) u\.searchParams\.delete\(k\)/);
});
