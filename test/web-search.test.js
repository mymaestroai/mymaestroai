'use strict';
// Web search (lib/web-search): the backend chain, configuration, each backend's response parsing, fall-through on
// errors and empty answers, explicit backend choice, rendering, and the SearXNG container helpers. No network: every
// backend is answered by a fake fetch keyed on the request URL.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createWebSearch, BACKENDS } = require('../lib/web-search');

const DDG_HTML = `<html><body><table>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa&rut=1">Example A</a></td></tr>
<tr><td class="result-snippet">Snippet for A</td></tr>
<tr><td><a class="result-link" href="https://example.org/b">Example B</a></td></tr>
<tr><td class="result-snippet">Snippet for B</td></tr>
<tr><td><a class="result-link" href="https://duckduckgo.com/y.js?ad_domain=ads.example&ad_provider=bingv7aa">Sponsored thing</a></td></tr>
<tr><td class="result-snippet">An advert</td></tr>
</table></body></html>`;

function rig(o = {}) {
  const calls = [];
  const answers = {
    'api.search.brave.com': () => ({ web: { results: [{ title: 'Brave 1', url: 'https://b.example/1', description: 'from brave', page_age: '2026-10-01T00:00:00' }] } }),
    'api.perplexity.ai': () => ({ results: [{ title: 'Pplx 1', url: 'https://p.example/1', snippet: 'from perplexity', date: '2026-09-30' }] }),
    'google.serper.dev': () => ({ organic: [{ title: 'Serper 1', link: 'https://s.example/1', snippet: 'from serper', date: 'Oct 2, 2026' }] }),
    'api.tavily.com': () => ({ results: [{ title: 'Tavily 1', url: 'https://t.example/1', content: 'from tavily', published_date: '2026-10-03' }] }),
    'searx.local': () => ({ results: [{ title: 'Searx 1', url: 'https://x.example/1', content: 'from searxng', publishedDate: '2026-10-04', engine: 'duckduckgo' }] }),
    'lite.duckduckgo.com': () => DDG_HTML,
    ...(o.answers || {}),
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ host: u.hostname, url: u.toString(), init });
    const a = answers[u.hostname];
    if (!a) return { ok: false, status: 404, text: async () => 'nope', url: u.toString(), headers: new Map() };
    const v = a(u, init);
    if (v instanceof Error) throw v;
    if (v && v.__status) return { ok: false, status: v.__status, text: async () => v.body || '', headers: new Map() };
    return { ok: true, status: 200, text: async () => (typeof v === 'string' ? v : JSON.stringify(v)), headers: new Map() };
  };
  const settings = { webSearch: o.webSearch || {} };
  const ws = createWebSearch({
    getSetting: (k) => settings[k],
    getProviderKey: (p) => (o.providerKeys || {})[p] || '',
    getProviderUrl: () => '',
    fetchImpl,
    docker: o.docker || (async () => { throw new Error('no docker'); }),
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ws-')),
    log: () => {},
  });
  return { ws, calls, settings };
}

test('with nothing configured the chain is DuckDuckGo alone, and it answers with unwrapped links', async () => {
  const { ws, calls } = rig();
  assert.deepStrictEqual(ws.chain(), ['duckduckgo']);
  const r = await ws.search('hub test');
  assert.strictEqual(r.backend, 'duckduckgo');
  assert.strictEqual(r.results.length, 2, 'the sponsored row is dropped');
  assert.ok(!r.results.some(x => /Sponsored/.test(x.title)));
  assert.strictEqual(r.results[0].url, 'https://example.org/a', 'the duckduckgo.com/l/?uddg= wrapper is removed');
  assert.strictEqual(r.results[0].snippet, 'Snippet for A');
  assert.strictEqual(r.results[1].rank, 2);
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /q=hub\+test/);
});

test('keys and the SearXNG URL make backends configured; the order is the owner\'s and new backends join at the end', () => {
  const { ws } = rig({ webSearch: { order: ['searxng', 'brave'], keys: { brave: 'bk' }, searxng: { url: 'http://searx.local/' } }, providerKeys: { perplexity: 'pk' } });
  assert.deepStrictEqual(ws.config().order, ['searxng', 'brave', 'perplexity', 'serper', 'tavily', 'duckduckgo']);
  assert.deepStrictEqual(ws.chain(), ['searxng', 'brave', 'perplexity', 'duckduckgo']);
  assert.strictEqual(ws.configured('serper'), false);
  assert.strictEqual(ws.configured('tavily'), false);
  assert.deepStrictEqual(BACKENDS, ['brave', 'perplexity', 'serper', 'tavily', 'searxng', 'duckduckgo']);
  assert.deepStrictEqual(Object.keys(ws.ENV_KEYS), ['brave', 'serper', 'tavily'], 'the config route reads ENV_KEYS off the instance');
});

test('environment variables configure keyed backends too', async () => {
  process.env.SERPER_API_KEY = 'env-serper';
  try {
    const { ws, calls } = rig({ webSearch: { order: ['serper'] } });
    assert.strictEqual(ws.configured('serper'), true);
    const r = await ws.search('x', { freshness: 'week' });
    assert.strictEqual(r.backend, 'serper');
    assert.strictEqual(calls[0].init.headers['X-API-KEY'], 'env-serper');
    assert.match(calls[0].init.body, /"tbs":"qdr:w"/);
  } finally { delete process.env.SERPER_API_KEY; }
});

test('every backend parses into the same row shape', async () => {
  const { ws } = rig({ webSearch: { keys: { brave: 'b', serper: 's', tavily: 't' }, searxng: { url: 'http://searx.local' } }, providerKeys: { perplexity: 'p' } });
  const expect = { brave: ['Brave 1', 'https://b.example/1', 'from brave', '2026-10-01'], perplexity: ['Pplx 1', 'https://p.example/1', 'from perplexity', '2026-09-30'], serper: ['Serper 1', 'https://s.example/1', 'from serper', 'Oct 2, 2026'], tavily: ['Tavily 1', 'https://t.example/1', 'from tavily', '2026-10-03'], searxng: ['Searx 1', 'https://x.example/1', 'from searxng', '2026-10-04'] };
  for (const [b, [title, url, snippet, date]] of Object.entries(expect)) {
    const r = await ws.search('q', { backend: b });
    assert.strictEqual(r.backend, b, b);
    assert.deepStrictEqual(r.results[0], { rank: 1, title, url, snippet, date, backend: b }, b);
  }
});

test('the chain falls through on HTTP errors, thrown errors and empty answers, and reports what it tried', async () => {
  const { ws } = rig({
    webSearch: { order: ['brave', 'serper', 'tavily', 'duckduckgo'], keys: { brave: 'b', serper: 's', tavily: 't' } },
    answers: {
      'api.search.brave.com': () => ({ __status: 429, body: 'rate limited' }),
      'google.serper.dev': () => new Error('socket hang up'),
      'api.tavily.com': () => ({ results: [] }),
    },
  });
  const r = await ws.search('fallthrough');
  assert.strictEqual(r.backend, 'duckduckgo');
  assert.deepStrictEqual(r.tried.map(t => t.backend), ['brave', 'serper', 'tavily']);
  assert.match(r.tried[0].error, /HTTP 429: rate limited/);
  assert.match(r.tried[1].error, /socket hang up/);
  assert.strictEqual(r.tried[2].error, 'no results');
  const text = ws.render(r);
  assert.match(text, /\[1\] Example A\n {4}https:\/\/example\.org\/a\n {4}Snippet for A/);
  assert.match(text, /— 2 result\(s\) via duckduckgo; tried first: brave \(HTTP 429: rate limited\), serper \(socket hang up\), tavily \(no results\)/);
});

test('when everything fails the result is empty and the rendering says why; a captcha page is an error, not silence', async () => {
  const { ws } = rig({ answers: { 'lite.duckduckgo.com': () => '<html><body>anomaly detected, please solve the captcha</body></html>' } });
  const r = await ws.search('blocked');
  assert.strictEqual(r.backend, null);
  assert.strictEqual(r.results.length, 0);
  assert.match(r.tried[0].error, /captcha/);
  assert.match(ws.render(r), /\(no search results found — duckduckgo: DuckDuckGo asked for a captcha\)/);
  const none = createWebSearch({ getSetting: () => ({ disabled: ['duckduckgo'] }), fetchImpl: async () => { throw new Error('must not be called'); }, log: () => {} });
  assert.match(none.render(await none.search('x')), /no search backend is configured/);
});

test('an explicitly named backend is used alone; unknown or unconfigured names are refused without a network call', async () => {
  const { ws, calls } = rig({ webSearch: { keys: { brave: 'b' } }, providerKeys: { perplexity: 'p' } });
  const r = await ws.search('q', { backend: 'perplexity' });
  assert.strictEqual(r.backend, 'perplexity');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].host, 'api.perplexity.ai');
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer p');
  const bad = await ws.search('q', { backend: 'bing' });
  assert.deepStrictEqual(bad.tried, [{ backend: 'bing', error: 'unknown backend' }]);
  const off = await ws.search('q', { backend: 'tavily' });
  assert.deepStrictEqual(off.tried, [{ backend: 'tavily', error: 'not configured on this hub' }]);
  assert.strictEqual(calls.length, 1, 'no further requests');
});

test('max_results and freshness are passed on and capped', async () => {
  const { ws, calls } = rig({ webSearch: { keys: { brave: 'b' }, searxng: { url: 'http://searx.local' } } });
  await ws.search('q', { backend: 'brave', maxResults: 99, freshness: 'month' });
  const u = new URL(calls[0].url);
  assert.strictEqual(u.searchParams.get('count'), '20');
  assert.strictEqual(u.searchParams.get('freshness'), 'pm');
  await ws.search('q', { backend: 'searxng', freshness: 'bogus' });
  assert.strictEqual(new URL(calls[1].url).searchParams.get('time_range'), null, 'unknown freshness is dropped');
  assert.strictEqual(new URL(calls[1].url).searchParams.get('format'), 'json');
  const empty = await ws.search('   ');
  assert.strictEqual(empty.results.length, 0);
  assert.strictEqual(calls.length, 2);
});

test('status lists every backend with whether it is usable and what it needs; keys never appear', async () => {
  const { ws } = rig({ webSearch: { keys: { brave: 'secret-brave-key' } } });
  const s = await ws.status();
  assert.deepStrictEqual(s.chain, ['brave', 'duckduckgo']);
  const brave = s.backends.find(b => b.id === 'brave');
  assert.strictEqual(brave.configured, true);
  assert.strictEqual(brave.hasKey, true);
  assert.match(s.backends.find(b => b.id === 'serper').needs, /SERPER_API_KEY/);
  assert.strictEqual(s.backends.find(b => b.id === 'duckduckgo').needs, 'nothing');
  assert.ok(!JSON.stringify(s).includes('secret-brave-key'));
  assert.strictEqual(s.searxng.container, null);
  assert.strictEqual(s.searxng.healthy, false);
});

test('the SearXNG helper writes a settings.yml with JSON output on and builds a loopback-only docker command', async () => {
  const dockerCalls = [];
  const { ws } = rig({ docker: async (args) => { dockerCalls.push(args); if (args[0] === 'inspect') return { stdout: 'running\n' }; return { stdout: '' }; }, webSearch: { searxng: { url: 'http://127.0.0.1:8888' } }, answers: { '127.0.0.1': () => '' } });
  const cmd = ws.searxng.startCommand(8899);
  const yml = fs.readFileSync(path.join(ws.searxng.dir, 'settings.yml'), 'utf8');
  assert.match(yml, /use_default_settings: true/);
  assert.match(yml, /formats:\n {4}- html\n {4}- json/);
  assert.match(yml, /secret_key: "[0-9a-f]{48}"/);
  assert.match(yml, /limiter: false/);
  assert.match(cmd, /docker pull searxng\/searxng:latest/);
  assert.match(cmd, /-p 127\.0\.0\.1:8899:8080/);
  assert.match(cmd, /--name hub-searxng/);
  assert.match(cmd, /healthz/);
  assert.ok(!/0\.0\.0\.0/.test(cmd), 'never exposed beyond loopback');
  const first = fs.statSync(path.join(ws.searxng.dir, 'settings.yml')).mtimeMs;
  ws.searxng.startCommand(); // second call keeps the existing file (and its secret)
  assert.strictEqual(fs.readFileSync(path.join(ws.searxng.dir, 'settings.yml'), 'utf8'), yml);
  assert.ok(first);
  const st = await ws.searxng.status();
  assert.strictEqual(st.container, 'running');
  assert.strictEqual(st.healthy, true, 'healthz answered 200');
  assert.strictEqual(await ws.searxng.stop(), true);
  assert.deepStrictEqual(dockerCalls.at(-1), ['rm', '-f', 'hub-searxng']);
});
