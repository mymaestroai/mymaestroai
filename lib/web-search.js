'use strict';
/**
 * Web search for every agent on every path: one tool (WebSearch), one result shape, a chain of backends behind it.
 *
 * Backends, in the owner's order (settings.webSearch.order), each used only when configured:
 *   brave       Brave Search API (independent index)           key: settings.webSearch.keys.brave  / BRAVE_SEARCH_API_KEY
 *   perplexity  Perplexity Search API (cited, fresh)           key: the hub's Perplexity provider key
 *   serper      Google results through serper.dev              key: settings.webSearch.keys.serper / SERPER_API_KEY
 *   tavily      Tavily (LLM-ready results)                      key: settings.webSearch.keys.tavily / TAVILY_API_KEY
 *   searxng     a self-hosted SearXNG meta-search instance      url: settings.webSearch.searxng.url / SEARXNG_URL
 *   duckduckgo  DuckDuckGo's lite page, scraped                 nothing; the zero-key floor
 *
 * search() walks the chain and returns the first backend that answers with results; errors and empty answers fall
 * through and are reported in `tried`. An agent may name a backend explicitly (e.g. perplexity) when it wants that
 * one. Every result row has the same shape: { rank, title, url, snippet, date, backend }.
 *
 * SearXNG can be run by the hub as a Docker container (hub-searxng) from the Settings page; see searxng.* below.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const BACKENDS = ['brave', 'perplexity', 'serper', 'tavily', 'searxng', 'duckduckgo'];
const DEFAULT_ORDER = [...BACKENDS];
const ENV_KEYS = { brave: 'BRAVE_SEARCH_API_KEY', serper: 'SERPER_API_KEY', tavily: 'TAVILY_API_KEY' };
const LABELS = {
  brave: 'Brave Search API', perplexity: 'Perplexity Search API', serper: 'Serper (Google results)',
  tavily: 'Tavily', searxng: 'SearXNG (self-hosted)', duckduckgo: 'DuckDuckGo (scraped, no key)',
};
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FRESH = new Set(['day', 'week', 'month', 'year']);
const SEARXNG = { container: 'hub-searxng', image: 'searxng/searxng:latest', port: 8888 };

function createWebSearch({
  getSetting = () => undefined,
  getProviderKey = () => '',
  getProviderUrl = () => '',
  fetchImpl = (...a) => globalThis.fetch(...a),
  docker = null,                       // async (args) => { stdout, stderr }; default: docker on PATH
  dataDir = path.join(__dirname, '..', 'data'),
  timeoutMs = 15000,
  log = (...a) => console.log(...a),
  now = () => Date.now(),
} = {}) {
  const execFileAsync = promisify(execFile);
  const runDocker = docker || (async (args, opts = {}) => execFileAsync('docker', args, { timeout: opts.timeout || 30000, maxBuffer: 4 * 1024 * 1024 }));

  function config() {
    const s = getSetting('webSearch') || {};
    const order = Array.isArray(s.order) && s.order.length ? s.order.filter(b => BACKENDS.includes(b)) : [...DEFAULT_ORDER];
    for (const b of DEFAULT_ORDER) if (!order.includes(b)) order.push(b);     // new backends join at the end
    return {
      order,
      keys: { ...(s.keys || {}) },
      searxng: { url: (s.searxng && s.searxng.url) || process.env.SEARXNG_URL || '', ...(s.searxng || {}) },
      maxResults: Number(s.maxResults) > 0 ? Number(s.maxResults) : 10,
      disabled: Array.isArray(s.disabled) ? s.disabled : [],
    };
  }
  function keyFor(b, cfg = config()) {
    if (b === 'perplexity') return getProviderKey('perplexity') || '';
    return (cfg.keys && cfg.keys[b]) || process.env[ENV_KEYS[b]] || '';
  }
  function searxngUrl(cfg = config()) { return String(cfg.searxng.url || '').replace(/\/+$/, ''); }
  /** Is backend b usable on this install: a key where one is needed, a URL for SearXNG, always for DuckDuckGo. */
  function configured(b, cfg = config()) {
    if (!BACKENDS.includes(b) || cfg.disabled.includes(b)) return false;
    if (b === 'duckduckgo') return true;
    if (b === 'searxng') return !!searxngUrl(cfg);
    return !!keyFor(b, cfg);
  }
  const chain = (cfg = config()) => cfg.order.filter(b => configured(b, cfg));

  async function getJson(url, init = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) } });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200).replace(/\s+/g, ' ')}` : ''}`);
      try { return JSON.parse(text); } catch { throw new Error(`not JSON: ${text.slice(0, 120).replace(/\s+/g, ' ')}`); }
    } finally { clearTimeout(t); }
  }
  async function getText(url, init = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { ...init, signal: ctl.signal, headers: { 'User-Agent': UA, ...(init.headers || {}) } });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return text;
    } finally { clearTimeout(t); }
  }
  const dateOf = (d) => { const s = String(d || '').trim(); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s.slice(0, 40); };
  const row = (o) => ({ title: String(o.title || '').trim(), url: String(o.url || '').trim(), snippet: String(o.snippet || '').replace(/\s+/g, ' ').trim(), date: dateOf(o.date) });
  const clean = (rows) => rows.filter(r => r.title && /^https?:\/\//i.test(r.url));

  // ── Backends: each returns [{ title, url, snippet, date }] or throws ───────────────────────────────────────────
  const backends = {
    async brave(query, { max, freshness }, cfg) {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query); u.searchParams.set('count', String(Math.min(max, 20)));
      if (freshness) u.searchParams.set('freshness', { day: 'pd', week: 'pw', month: 'pm', year: 'py' }[freshness]);
      const j = await getJson(u, { headers: { 'X-Subscription-Token': keyFor('brave', cfg), 'Accept-Encoding': 'gzip' } });
      return clean(((j.web && j.web.results) || []).map(r => row({ title: r.title, url: r.url, snippet: r.description, date: r.page_age || r.age })));
    },
    async perplexity(query, { max }, cfg) {
      const base = (getProviderUrl('perplexity') || 'https://api.perplexity.ai').replace(/\/+$/, '');
      const j = await getJson(`${base}/search`, { method: 'POST', headers: { Authorization: `Bearer ${keyFor('perplexity', cfg)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, max_results: Math.min(max, 20) }) });
      return clean((j.results || []).map(r => row({ title: r.title, url: r.url, snippet: r.snippet, date: r.date || r.last_updated })));
    },
    async serper(query, { max, freshness }, cfg) {
      const body = { q: query, num: Math.min(max, 20) };
      if (freshness) body.tbs = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }[freshness];
      const j = await getJson('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': keyFor('serper', cfg), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return clean((j.organic || []).map(r => row({ title: r.title, url: r.link, snippet: r.snippet, date: r.date })));
    },
    async tavily(query, { max, freshness }, cfg) {
      const body = { query, max_results: Math.min(max, 20), search_depth: 'basic' };
      if (freshness) { body.topic = 'news'; body.days = { day: 1, week: 7, month: 30, year: 365 }[freshness]; }
      const j = await getJson('https://api.tavily.com/search', { method: 'POST', headers: { Authorization: `Bearer ${keyFor('tavily', cfg)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return clean((j.results || []).map(r => row({ title: r.title, url: r.url, snippet: r.content, date: r.published_date })));
    },
    async searxng(query, { max, freshness }, cfg) {
      const u = new URL(`${searxngUrl(cfg)}/search`);
      u.searchParams.set('q', query); u.searchParams.set('format', 'json');
      if (freshness) u.searchParams.set('time_range', freshness);
      const j = await getJson(u);
      return clean((j.results || []).slice(0, max).map(r => row({ title: r.title, url: r.url, snippet: r.content, date: r.publishedDate })));
    },
    async duckduckgo(query, { max, freshness }) {
      const body = new URLSearchParams({ q: query, ...(freshness ? { df: freshness[0] } : {}) });
      const html = await getText('https://lite.duckduckgo.com/lite/', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);
      const links = $('a.result-link'); const snippets = $('td.result-snippet');
      const out = [];
      links.each((i, el) => {
        const url = ddgHref($(el).attr('href') || '');
        if (/^https?:\/\/([^/]+\.)?duckduckgo\.com\//i.test(url)) return;        // ad rows (y.js?ad_domain=...) are not results
        out.push(row({ title: $(el).text(), url, snippet: snippets.eq(i).text() }));
      });
      if (!out.length && /anomaly|captcha|bots/i.test(html)) throw new Error('DuckDuckGo asked for a captcha');
      return clean(out).slice(0, max);
    },
  };
  /** DuckDuckGo lite wraps links as //duckduckgo.com/l/?uddg=<url>; unwrap to the real address. */
  function ddgHref(href) {
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      if (/duckduckgo\.com$/.test(u.hostname) && u.searchParams.get('uddg')) return u.searchParams.get('uddg');
      return u.toString();
    } catch { return href; }
  }

  /**
   * search(query, { maxResults, freshness, backend }) -> { query, backend, results, tried, ms }
   * Walks the chain (or the one named backend); the first non-empty answer wins. Never throws for backend trouble:
   * an empty `results` with `tried` filled in says what was attempted.
   */
  async function search(query, { maxResults, freshness, backend } = {}) {
    const q = String(query || '').trim();
    if (!q) return { query: q, backend: null, results: [], tried: [], ms: 0 };
    const cfg = config();
    const max = Math.max(1, Math.min(Number(maxResults) || cfg.maxResults, 25));
    const fresh = FRESH.has(freshness) ? freshness : null;
    let order;
    if (backend) {
      if (!BACKENDS.includes(backend)) return { query: q, backend: null, results: [], tried: [{ backend, error: 'unknown backend' }], ms: 0 };
      if (!configured(backend, cfg)) return { query: q, backend: null, results: [], tried: [{ backend, error: 'not configured on this hub' }], ms: 0 };
      order = [backend];
    } else order = chain(cfg);
    const tried = [];
    const t0 = now();
    for (const b of order) {
      const ts = now();
      try {
        const rows = await backends[b](q, { max, freshness: fresh }, cfg);
        if (rows.length) {
          const results = rows.slice(0, max).map((r, i) => ({ rank: i + 1, ...r, backend: b }));
          return { query: q, backend: b, results, tried, ms: now() - t0 };
        }
        tried.push({ backend: b, error: 'no results', ms: now() - ts });
      } catch (e) {
        tried.push({ backend: b, error: String(e && e.message || e).slice(0, 200), ms: now() - ts });
        log(`[websearch] ${b} failed for "${q.slice(0, 60)}": ${e && e.message}`);
      }
    }
    return { query: q, backend: null, results: [], tried, ms: now() - t0 };
  }

  /** The text an agent reads: numbered results, then one line naming the backend (and what fell through). */
  function render(r) {
    if (!r.results.length) {
      const why = r.tried.length ? r.tried.map(t => `${t.backend}: ${t.error}`).join('; ') : 'no search backend is configured';
      return `(no search results found — ${why})`;
    }
    const lines = r.results.map(x => `[${x.rank}] ${x.title}\n    ${x.url}${x.date ? `\n    (${x.date})` : ''}${x.snippet ? `\n    ${x.snippet}` : ''}`);
    const skipped = r.tried.length ? `; tried first: ${r.tried.map(t => `${t.backend} (${t.error})`).join(', ')}` : '';
    return `${lines.join('\n\n')}\n\n— ${r.results.length} result(s) via ${r.backend}${skipped}`;
  }

  // ── SearXNG container (optional; the hub runs it for installs without a search key) ───────────────────────────
  const searxng = {
    ...SEARXNG,
    dir: path.join(dataDir, 'searxng'),
    /** Write the instance's settings.yml once: JSON output on, limiter off (loopback only), a random secret. */
    prepare() {
      fs.mkdirSync(searxng.dir, { recursive: true });
      const f = path.join(searxng.dir, 'settings.yml');
      if (!fs.existsSync(f)) {
        fs.writeFileSync(f, [
          '# Written by My Maestro AI. SearXNG merges this over its defaults (use_default_settings: true).',
          'use_default_settings: true',
          'server:',
          `  secret_key: "${crypto.randomBytes(24).toString('hex')}"`,
          '  limiter: false',
          '  image_proxy: false',
          'search:',
          '  formats:',
          '    - html',
          '    - json',
          '  safe_search: 0',
          'outgoing:',
          '  request_timeout: 6.0',
          '',
        ].join('\n'), { mode: 0o600 });
      }
      return f;
    },
    /** The command the hub runs as a job: pull the image, (re)create the container on loopback, wait for /healthz. */
    startCommand(port = SEARXNG.port) {
      const p = Number(port) || SEARXNG.port;
      searxng.prepare();
      return [
        `docker pull ${SEARXNG.image}`,
        `docker rm -f ${SEARXNG.container} >/dev/null 2>&1 || true`,
        `docker run -d --name ${SEARXNG.container} --restart unless-stopped -p 127.0.0.1:${p}:8080 -v ${JSON.stringify(searxng.dir)}:/etc/searxng -e BASE_URL=http://127.0.0.1:${p}/ ${SEARXNG.image}`,
        `for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:${p}/healthz && echo "searxng healthy on 127.0.0.1:${p}" && exit 0; sleep 2; done; echo "searxng did not answer /healthz in 60 s"; docker logs --tail 20 ${SEARXNG.container}; exit 1`,
      ].join(' && ');
    },
    async stop() { try { await runDocker(['rm', '-f', SEARXNG.container]); return true; } catch { return false; } },
    async status() {
      let container = null;
      try { const r = await runDocker(['inspect', '-f', '{{.State.Status}}', SEARXNG.container], { timeout: 10000 }); container = r.stdout.trim() || null; } catch { container = null; }
      const url = searxngUrl();
      let healthy = false;
      if (url) { try { const r = await fetchImpl(`${url}/healthz`, { signal: AbortSignal.timeout(3000) }); healthy = r.ok; } catch { healthy = false; } }
      return { container, url, healthy, image: SEARXNG.image, name: SEARXNG.container, defaultPort: SEARXNG.port };
    },
  };

  /** For the Settings page: every backend with whether it is usable here and why not. */
  async function status() {
    const cfg = config();
    const backendsOut = cfg.order.map(b => ({
      id: b, label: LABELS[b], configured: configured(b, cfg), disabled: cfg.disabled.includes(b),
      needs: b === 'duckduckgo' ? 'nothing' : b === 'searxng' ? 'a SearXNG URL (or the hub-run container)' : b === 'perplexity' ? 'the Perplexity provider key' : `an API key (${ENV_KEYS[b]} or the field below)`,
      hasKey: b === 'duckduckgo' || b === 'searxng' ? undefined : !!keyFor(b, cfg),
    }));
    return { order: cfg.order, chain: chain(cfg), maxResults: cfg.maxResults, backends: backendsOut, searxng: await searxng.status() };
  }

  return { BACKENDS, DEFAULT_ORDER, LABELS, ENV_KEYS, config, configured, chain, keyFor, search, render, status, searxng, backends };
}

let singleton = null;
function getWebSearch() {
  if (!singleton) {
    const settings = require('./settings');
    singleton = createWebSearch({
      getSetting: (k) => settings.getSetting(k),
      getProviderKey: (p) => settings.getProviderKey(p),
      getProviderUrl: (p) => settings.getProviderUrl(p),
    });
  }
  return singleton;
}

module.exports = { createWebSearch, getWebSearch, BACKENDS, DEFAULT_ORDER, LABELS, ENV_KEYS, SEARXNG };
