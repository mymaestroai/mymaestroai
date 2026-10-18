'use strict';
// Web fetch (lib/web-fetch): HTML to markdown with links, headings, lists, tables and code kept; main-content pick;
// private-address refusal (including a public name resolving to a private address, and a redirect there); PDF via
// pdftotext; text and JSON; browser rendering for script-only pages; Jina fallback only when enabled; the cache; the
// tool text with paging; and the private-address policy by agent kind. No network: fetch, DNS, exec are fakes.
const { test } = require('node:test');
const assert = require('node:assert');
const { createWebFetch, htmlToMarkdown, isPrivateIp } = require('../lib/web-fetch');

const ARTICLE = `<!doctype html><html><head><title>Hub &amp; Spokes</title><style>p{}</style><script>var x=1</script></head>
<body><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav>
<header><h1>Site banner</h1></header>
<article>
<h1>Troubleshooting custom domains</h1>
<p>You can check for <strong>common errors</strong> and read the <a href="/pages/guide">guide</a> or <a href="https://example.com/x?y=1">another site</a>.</p>
<h2>Steps</h2>
<ol><li>Open settings</li><li>Press <em>Check again</em><ul><li>wait a minute</li></ul></li></ol>
<pre><code class="language-bash">dig +short example.com\nping x</code></pre>
<table><tr><th>Record</th><th>Value</th></tr><tr><td>A</td><td>185.199.108.153</td></tr><tr><td>CNAME</td><td>user.github.io | pipe</td></tr></table>
<blockquote>Quoted line</blockquote>
<p>Inline <code>code</code> and an image <img src="/img/a.png" alt="diagram"> and a <a href="#top">top</a> link and <a href="javascript:void(0)">js</a>.</p>
<p>${'filler text that makes the article the densest block on the page. '.repeat(8)}</p>
</article>
<footer>© footer</footer></body></html>`;

function rig(o = {}) {
  const calls = [];
  const pages = o.pages || {};
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const p = pages[String(url)];
    if (!p) return { ok: false, status: 404, url: String(url), headers: new Map(), arrayBuffer: async () => Buffer.alloc(0), text: async () => '' };
    if (p instanceof Error) throw p;
    const body = Buffer.isBuffer(p.body) ? p.body : Buffer.from(String(p.body || ''));
    const headers = new Map(Object.entries({ 'content-type': p.type || 'text/html; charset=utf-8', ...(p.headers || {}) }));
    return { ok: p.status ? p.status < 400 : true, status: p.status || 200, url: p.finalUrl || String(url), headers, arrayBuffer: async () => body, text: async () => body.toString() };
  };
  const dnsMap = { 'example.com': ['93.184.216.34'], 'docs.github.com': ['140.82.112.3'], 'evil.example': ['10.0.0.5'], 'tail.example': ['100.64.0.10'], ...(o.dns || {}) };
  const lookup = async (h) => { const a = dnsMap[h]; if (!a) { const e = new Error('ENOTFOUND'); e.code = 'ENOTFOUND'; throw e; } return a.map(address => ({ address })); };
  const execCalls = [];
  const exec = async (file, args) => { execCalls.push([file, ...args]); if (o.exec) return o.exec(file, args); if (file === 'pdftotext') return { stdout: 'PDF TEXT\fpage two' }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
  const settings = { webFetch: o.webFetch || {} };
  let t = 1_000_000;
  const wf = createWebFetch({
    getSetting: (k) => settings[k], fetchImpl, lookup, exec,
    renderer: o.renderer === undefined ? null : o.renderer,
    isMemberOwned: (a) => !!(a && a.owner === 'member1'),
    blockedPorts: () => new Set(o.blockedPorts || [18080]),
    log: () => {}, now: () => t,
  });
  return { wf, calls, execCalls, settings, tick: (ms) => { t += ms; } };
}

test('isPrivateIp covers loopback, RFC1918, link-local, CGNAT/Tailscale, multicast, IPv6 local and mapped v4', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:192.168.0.1']) assert.strictEqual(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '93.184.216.34', '100.128.0.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) assert.strictEqual(isPrivateIp(ip), false, ip);
});

test('HTML becomes markdown with structure and absolute links, chrome stripped, the densest block chosen', () => {
  const { title, markdown } = htmlToMarkdown(ARTICLE, 'https://docs.github.com/en/pages/x');
  assert.strictEqual(title, 'Hub & Spokes');
  assert.match(markdown, /^# Troubleshooting custom domains\n\n/);
  assert.ok(!markdown.includes('Site banner') && !markdown.includes('Home') && !markdown.includes('footer'), 'nav/header/footer removed');
  assert.match(markdown, /\*\*common errors\*\* and read the \[guide\]\(https:\/\/docs\.github\.com\/pages\/guide\) or \[another site\]\(https:\/\/example\.com\/x\?y=1\)\./);
  assert.match(markdown, /## Steps\n\n1\. Open settings\n2\. Press \*Check again\*\n {2}- wait a minute/);
  assert.match(markdown, /```bash\ndig \+short example\.com\nping x\n```/);
  assert.match(markdown, /\| Record \| Value \|\n\| --- \| --- \|\n\| A \| 185\.199\.108\.153 \|\n\| CNAME \| user\.github\.io \\\| pipe \|/);
  assert.match(markdown, /> Quoted line/);
  assert.match(markdown, /Inline `code` and an image !\[diagram\]\(https:\/\/docs\.github\.com\/img\/a\.png\) and a top link and js\./);
  assert.ok(!/var x=1/.test(markdown), 'scripts dropped');
});

test('a page is fetched, converted, titled, and served from the cache until it expires', async () => {
  const { wf, calls, tick } = rig({ pages: { 'https://docs.github.com/en/pages/x': { body: ARTICLE } } });
  const p = await wf.fetchPage('https://docs.github.com/en/pages/x');
  assert.strictEqual(p.title, 'Hub & Spokes');
  assert.strictEqual(p.via, 'fetch');
  assert.strictEqual(p.cached, false);
  assert.strictEqual(p.contentType, 'text/html');
  assert.match(p.markdown, /^# Troubleshooting/);
  const again = await wf.fetchPage('https://docs.github.com/en/pages/x');
  assert.strictEqual(again.cached, true);
  assert.strictEqual(calls.length, 1);
  tick(11 * 60000);
  await wf.fetchPage('https://docs.github.com/en/pages/x');
  assert.strictEqual(calls.length, 2, 'refetched after the cache expired');
  assert.match(calls[0].init.headers['User-Agent'], /Mozilla/);
});

test('private, local and resolved-private addresses are refused by default; allowed when the caller says so', async () => {
  const { wf, calls } = rig({ pages: { 'http://127.0.0.1:9999/api/x': { body: '{"a":1}', type: 'application/json' }, 'https://evil.example/': { body: '<p>x</p>' }, 'https://tail.example/': { body: '<p>x</p>' } } });
  for (const u of ['http://127.0.0.1:9999/api/x', 'http://localhost/', 'http://hub.local/', 'http://192.168.1.10/', 'http://[::1]/', 'https://evil.example/', 'https://tail.example/']) {
    await assert.rejects(wf.fetchPage(u), /refused/, u);
  }
  assert.strictEqual(calls.length, 0, 'nothing was requested');
  await assert.rejects(wf.fetchPage('ftp://example.com/x'), /only http and https/);
  await assert.rejects(wf.fetchPage('not a url'), /not a valid URL/);
  await assert.rejects(wf.fetchPage('https://nowhere.example/'), /cannot resolve/);
  const ok = await wf.fetchPage('http://127.0.0.1:9999/api/x', { allowPrivate: true });
  assert.strictEqual(ok.via, 'text');
  assert.strictEqual(ok.markdown, '{\n  "a": 1\n}', 'JSON is pretty-printed');
});

test('a redirect to a private address is refused even when the first host is public', async () => {
  const { wf } = rig({ pages: { 'https://example.com/go': { body: '<p>secret</p>', finalUrl: 'http://192.168.1.1/admin' } } });
  await assert.rejects(wf.fetchPage('https://example.com/go'), /redirected to a refused address/);
});

test('PDFs go through pdftotext; a missing pdftotext is explained; plain text and binary are handled', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(100)]);
  const { wf, execCalls } = rig({ pages: { 'https://example.com/doc.pdf': { body: pdf, type: 'application/pdf' }, 'https://example.com/readme.txt': { body: 'plain  text', type: 'text/plain' }, 'https://example.com/a.zip': { body: Buffer.alloc(10), type: 'application/zip' } } });
  const p = await wf.fetchPage('https://example.com/doc.pdf');
  assert.strictEqual(p.via, 'pdf');
  assert.strictEqual(p.title, 'doc.pdf');
  assert.strictEqual(p.markdown, 'PDF TEXT\n\npage two');
  assert.strictEqual(execCalls[0][0], 'pdftotext');
  assert.strictEqual(execCalls[0][1], '-layout');
  assert.strictEqual((await wf.fetchPage('https://example.com/readme.txt')).markdown, 'plain  text');
  const z = await wf.fetchPage('https://example.com/a.zip');
  assert.match(z.markdown, /binary content: application\/zip, 10 bytes/);
  const noPdf = rig({ pages: { 'https://example.com/doc.pdf': { body: pdf, type: 'application/pdf' } }, exec: async () => { const e = new Error('spawn pdftotext ENOENT'); e.code = 'ENOENT'; throw e; } });
  await assert.rejects(noPdf.wf.fetchPage('https://example.com/doc.pdf'), /needs pdftotext/);
});

test('a script-only page is rendered in the browser when rendering is auto and a renderer exists; never when off', async () => {
  const shell = `<html><head><title>App</title><script src="a.js"></script><script src="b.js"></script><script>boot()</script></head><body><div id="root"></div></body></html>`;
  const rendered = `<html><head><title>App (rendered)</title></head><body><main><h1>Dashboard</h1><p>${'Real content. '.repeat(40)}</p></main></body></html>`;
  let renders = 0;
  const r1 = rig({ pages: { 'https://example.com/app': { body: shell } }, renderer: async () => { renders++; return rendered; } });
  const p = await r1.wf.fetchPage('https://example.com/app');
  assert.strictEqual(renders, 1);
  assert.strictEqual(p.via, 'browser');
  assert.strictEqual(p.title, 'App (rendered)');
  assert.match(p.markdown, /^# Dashboard/);
  const r2 = rig({ pages: { 'https://example.com/app': { body: shell } }, renderer: async () => { throw new Error('must not render'); }, webFetch: { render: 'off' } });
  const q = await r2.wf.fetchPage('https://example.com/app');
  assert.strictEqual(q.via, 'fetch');
  assert.match(q.markdown, /no readable content extracted/);
  const r3 = rig({ pages: { 'https://example.com/app': { body: shell } }, renderer: null });
  assert.strictEqual((await r3.wf.fetchPage('https://example.com/app')).via, 'fetch', 'no renderer: plain result');
  // render: true forces the browser even for a page with content, and is cached separately
  const r4 = rig({ pages: { 'https://docs.github.com/en/pages/x': { body: ARTICLE } }, renderer: async () => rendered });
  const plain = await r4.wf.fetchPage('https://docs.github.com/en/pages/x');
  const forced = await r4.wf.fetchPage('https://docs.github.com/en/pages/x', { render: true });
  assert.strictEqual(plain.via, 'fetch'); assert.strictEqual(forced.via, 'browser'); assert.strictEqual(forced.cached, false);
});

test('Jina Reader is used only when enabled, and never for refused addresses', async () => {
  const pages = { 'https://r.jina.ai/https://example.com/blocked': { body: 'Title: From Jina\n\nMarkdown body', type: 'text/markdown' } };
  const off = rig({ pages });
  await assert.rejects(off.wf.fetchPage('https://example.com/blocked'), /HTTP 404/);
  const on = rig({ pages, webFetch: { jina: true } });
  const p = await on.wf.fetchPage('https://example.com/blocked');
  assert.strictEqual(p.via, 'jina');
  assert.strictEqual(p.title, 'From Jina');
  await assert.rejects(on.wf.fetchPage('http://192.168.0.1/'), /refused/);
  assert.ok(!on.calls.some(c => c.url.includes('r.jina.ai/http://192.168')), 'the private URL never left the box');
});

test('the tool text pages long content with offset, names the source after a redirect, and reflects allowPrivate', async () => {
  const long = `<html><head><title>Long</title></head><body><main><p>${Array.from({ length: 2000 }, (_, i) => `w${i}`).join(' ')}</p></main></body></html>`;
  const { wf } = rig({ pages: { 'https://example.com/long': { body: long, finalUrl: 'https://example.com/long/' } } });
  const first = await wf.toolText({ url: 'https://example.com/long', max_length: 1000 });
  assert.match(first, /^# Long\n\nw0 w1 w2 /);
  assert.match(first, /\.\.\. \(\d+ more characters; call again with offset: 1000\)/);
  assert.match(first, /— fetched from https:\/\/example\.com\/long\//);
  const second = await wf.toolText({ url: 'https://example.com/long', max_length: 1000, offset: 1000 });
  assert.ok(!/w0 w1 /.test(second), 'continues from the offset');
  assert.match(second, /^# Long\n\n\S/);
  assert.match(second, /offset: 2000/);
  await assert.rejects(wf.toolText({ url: 'http://127.0.0.1:9999/' }, {}), /refused/);
});

test('allowPrivateFor follows settings.webFetch.allowPrivate and the agent\'s kind', () => {
  const admin = { name: 'maestro', owner: null }, member = { name: 'kid', owner: 'member1' };
  const d = rig();
  // Default since the 2026-10-16 review (F21): nobody reaches private addresses until the owner opts in.
  assert.strictEqual(d.wf.allowPrivateFor(admin), false);
  assert.strictEqual(d.wf.allowPrivateFor(member), false);
  d.settings.webFetch = { allowPrivate: 'admin' };
  assert.strictEqual(d.wf.allowPrivateFor(admin), true);
  assert.strictEqual(d.wf.allowPrivateFor(member), false);
  d.settings.webFetch = { allowPrivate: 'none' };
  assert.strictEqual(d.wf.allowPrivateFor(admin), false);
  d.settings.webFetch = { allowPrivate: 'all' };
  assert.strictEqual(d.wf.allowPrivateFor(member), true);
  assert.deepStrictEqual(d.wf.config(), { allowPrivate: 'all', render: 'auto', jina: false, cacheMinutes: 10, maxLength: 20000 });
});

test('oversized bodies and HTTP errors are reported as errors', async () => {
  const { wf } = rig({ pages: { 'https://example.com/big': { body: Buffer.alloc(5 * 1024 * 1024), headers: { 'content-length': String(5 * 1024 * 1024) } }, 'https://example.com/500': { body: 'boom', status: 500 } } });
  await assert.rejects(wf.fetchPage('https://example.com/big'), /too large/);
  await assert.rejects(wf.fetchPage('https://example.com/500'), /HTTP 500/);
});

test('the gateway tool definitions use the new modules and expose the new parameters', () => {
  const { BUILTIN_TOOLS } = require('../lib/provider-tools');
  assert.deepStrictEqual(BUILTIN_TOOLS.WebSearch.parameters.properties.backend.enum, ['brave', 'perplexity', 'serper', 'tavily', 'searxng', 'duckduckgo']);
  assert.deepStrictEqual(BUILTIN_TOOLS.WebSearch.parameters.properties.freshness.enum, ['day', 'week', 'month', 'year']);
  assert.ok(BUILTIN_TOOLS.WebFetch.parameters.properties.offset && BUILTIN_TOOLS.WebFetch.parameters.properties.render);
  assert.strictEqual(BUILTIN_TOOLS.WebFetch.handler.length, 2, 'takes (args, ctx)');
  assert.match(BUILTIN_TOOLS.WebFetch.handler.toString(), /toolText\(\{ url, max_length, offset, render \}, ctx \|\| \{\}\)/);
  const fs = require('fs'); const path = require('path');
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /try \{ allowPrivate = require\('\.\/web-fetch'\)\.getWebFetch\(\)\.allowPrivateFor\(agent\); \} catch \{\}\s*\n[\s\S]*?const tools = hubToolsLib\.createHubTools\(\{ cwd, sandbox: box, allowPrivate,/, 'the per-turn hands decide allowPrivate per agent');
  const settings = fs.readFileSync(path.join(__dirname, '..', 'lib', 'settings.js'), 'utf8');
  assert.match(settings, /s\.webSearch\.keys[\s\S]*maskKey\(String\(v\)\)/, 'search keys are masked for the UI');
});

test('never reachable, whatever the private-address setting: link-local/metadata addresses and the hub\'s own ports on private addresses (review F21)', async () => {
  const { wf } = rig({ blockedPorts: [9999, 18080], dns: { 'self.example': ['127.0.0.1'], 'meta.example': ['169.254.169.254'] }, pages: { 'http://127.0.0.1:8080/x': { body: '<p>engine page</p>' } } });
  for (const u of ['http://127.0.0.1:9999/api/health', 'http://localhost:9999/', 'http://self.example:9999/x', 'http://192.168.1.5:18080/v1/models', 'http://[::ffff:127.0.0.1]:9999/']) {
    await assert.rejects(wf.fetchPage(u, { allowPrivate: true }), /hub's own services/, u);
  }
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://meta.example/', 'http://metadata.google.internal/computeMetadata/v1/', 'http://[fe80::1]/']) {
    await assert.rejects(wf.fetchPage(u, { allowPrivate: true }), /link-local/, u);
  }
  // a private address on another port is still the owner's call (allowPrivate true here)
  const r = await wf.fetchPage('http://127.0.0.1:8080/x', { allowPrivate: true });
  assert.match(r.markdown || r.text || JSON.stringify(r), /engine page/);
  // and a public site is unaffected
  await assert.rejects(wf.fetchPage('https://example.com/nothing', { allowPrivate: false }), /HTTP 404/);
});
