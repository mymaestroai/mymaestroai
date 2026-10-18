'use strict';
/**
 * Web fetch for every agent on every path: one tool (WebFetch) that returns a page as markdown with its links,
 * headings, lists, tables and code kept, so an agent can read a page and follow what it found.
 *
 *   - HTML   -> markdown (readability-style main-content pick, then a structural conversion; no extra packages)
 *   - PDF    -> text through pdftotext when installed
 *   - text, JSON, markdown -> as is; other binary types -> a one-line note
 *   - JavaScript-only pages -> rendered in a real browser (Playwright Firefox through lib/web-render.py) when the
 *     plain fetch comes back nearly empty and rendering is allowed (settings.webFetch.render: auto | off | always)
 *   - Jina Reader (r.jina.ai) as an optional remote fallback, off by default because it sends the URL off-box
 *   - private, loopback, link-local and Tailscale (100.64/10) addresses are refused unless the caller is allowed
 *     (settings.webFetch.allowPrivate: admin (default) | none | all); the hostname is resolved first, so a public
 *     name pointing at a private address is refused too
 *   - a short in-memory cache (settings.webFetch.cacheMinutes, default 10) so repeated reads do not hit the site
 */
const dns = require('dns').promises;
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_BYTES = 4 * 1024 * 1024;
const RENDER_SCRIPT = path.join(__dirname, 'web-render.py');
const STRIP = 'script, style, noscript, template, iframe, svg, canvas, video, audio, object, embed, form, input, button, select, textarea, nav, aside, footer, header, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [aria-hidden="true"], .sidebar, .nav, .navbar, .menu, .breadcrumb, .breadcrumbs, .cookie, .cookie-banner, .ad, .ads, .advertisement, .share, .social, .comments, #comments';
const MAIN = ['article', 'main', '[role="main"]', '#content', '#main', '.content', '.post', '.entry', '.article', '.markdown-body', '.post-content', '.entry-content'];

/** Private / local address ranges: anything an agent must not reach through the hub by default. */
function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    const v4 = mappedV4(low); if (v4) return isPrivateIp(v4);
    return /^f[cd]/.test(low) || /^fe[89ab]/.test(low) || /^ff/.test(low);
  }
  return true;
}

/** The IPv4 inside an IPv4-mapped IPv6 address, dotted (::ffff:1.2.3.4) or hex (::ffff:102:304, how URL parsers write it), else null. */
function mappedV4(low) {
  const dotted = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (dotted) return dotted[1];
  const hex = low.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!hex) return null;
  const a = parseInt(hex[1], 16), b = parseInt(hex[2], 16);
  return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
}

/** 169.254/16 (incl. cloud metadata) and fe80::/10, also when given as an IPv4-mapped IPv6 address. */
function isLinkLocal(ip) {
  if (!ip) return false;
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 169 && b === 254; }
  const low = String(ip).toLowerCase();
  const v4 = mappedV4(low); if (v4) return isLinkLocal(v4);
  return /^fe[89ab]/.test(low);
}

/** Ports that are the hub's own services on this machine: its listener and the local model proxy + engines. */
function defaultBlockedPorts() {
  const s = new Set();
  const hub = Number(process.env.PORT || 0); if (hub) s.add(hub);
  try {
    const lm = require('./local-models').getLocalModels().state();
    if (lm && lm.port) s.add(Number(lm.port));
    const start = Number(lm && lm.startPort) || 0;
    if (start) for (let p = start; p < start + 100; p++) s.add(p);
  } catch { /* local models not configured */ }
  return s;
}

/** HTML -> { title, markdown }. Picks the densest main-content container, then converts structure to markdown. */
function htmlToMarkdown(html, baseUrl = '') {
  const cheerio = require('cheerio');
  const $ = cheerio.load(String(html || ''));
  const title = $('title').first().text().replace(/\s+/g, ' ').trim();
  $(STRIP).remove();
  let root = null, best = 0;
  for (const sel of MAIN) {
    $(sel).each((_, el) => { const n = $(el).text().replace(/\s+/g, ' ').trim().length; if (n > best && n > 200) { best = n; root = el; } });
  }
  if (!root) root = $('body')[0] || $.root()[0];
  const abs = (u) => { if (!u) return ''; try { return new URL(u, baseUrl || undefined).toString(); } catch { return u; } };
  const inlineText = (s) => String(s).replace(/\s+/g, ' ');

  function conv(node, ctx = {}) {
    if (!node) return '';
    if (node.type === 'text') return inlineText(node.data);
    if (node.type !== 'tag' && node.type !== 'root') return '';
    const tag = node.name;
    const kids = () => (node.children || []).map(c => conv(c, ctx)).join('');
    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
        const t = kids().trim(); return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t}\n\n` : '';
      }
      case 'p': case 'div': case 'section': case 'article': case 'main': case 'body': case 'figure': case 'figcaption': case 'details': case 'summary': case 'dl': case 'dd': case 'dt': case 'address': {
        const t = kids(); return t.trim() ? `\n\n${t.trim()}\n\n` : '';
      }
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': { const t = kids().trim(); return t ? `**${t}**` : ''; }
      case 'em': case 'i': { const t = kids().trim(); return t ? `*${t}*` : ''; }
      case 'code': {
        if (ctx.pre) return (node.children || []).map(c => c.type === 'text' ? c.data : conv(c, ctx)).join('');
        const t = kids().trim(); return t ? `\`${t.replace(/`/g, '`')}\`` : '';
      }
      case 'pre': {
        const raw = (node.children || []).map(c => c.type === 'text' ? c.data : conv(c, { ...ctx, pre: true })).join('').replace(/^\n+|\n+$/g, '');
        const lang = (($(node).find('code').attr('class') || '').match(/language-([\w-]+)/) || [])[1] || '';
        return raw ? `\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n\n` : '';
      }
      case 'blockquote': { const t = kids().trim(); return t ? `\n\n${t.split('\n').map(l => `> ${l}`).join('\n')}\n\n` : ''; }
      case 'a': {
        const t = kids().trim(); const href = abs($(node).attr('href'));
        if (!t) return '';
        if (!href || /^(javascript:|#|mailto:)/i.test($(node).attr('href') || '')) return t;
        return `[${t}](${href})`;
      }
      case 'img': { const alt = ($(node).attr('alt') || '').trim(); const src = abs($(node).attr('src')); return alt && src ? `![${alt}](${src})` : ''; }
      case 'ul': case 'ol': {
        const items = []; let n = 0;
        $(node).children('li').each((_, li) => {
          n++;
          const inner = (li.children || []).map(c => conv(c, { ...ctx, depth: (ctx.depth || 0) + 1 })).join('').trim().replace(/\n{2,}/g, '\n');
          if (!inner) return;
          const pad = '  '.repeat(ctx.depth || 0);
          const lines = inner.split('\n');
          // Continuation lines are indented under the bullet; nested lists already carry their own indentation.
          items.push(`${pad}${tag === 'ol' ? `${n}.` : '-'} ${lines[0]}${lines.length > 1 ? '\n' + lines.slice(1).map(l => (/^\s/.test(l) ? l : `${pad}  ${l}`)).join('\n') : ''}`);
        });
        return items.length ? `\n\n${items.join('\n')}\n\n` : '';
      }
      case 'li': return kids();
      case 'table': {
        const rows = [];
        $(node).find('tr').each((_, tr) => {
          const cells = []; $(tr).children('th, td').each((__, td) => cells.push(inlineText((td.children || []).map(c => conv(c, ctx)).join('')).trim().replace(/\|/g, '\\|')));
          if (cells.some(c => c)) rows.push(cells);
        });
        if (!rows.length) return '';
        const w = Math.max(...rows.map(r => r.length));
        const line = (r) => `| ${Array.from({ length: w }, (_, i) => r[i] || '').join(' | ')} |`;
        return `\n\n${line(rows[0])}\n| ${Array.from({ length: w }, () => '---').join(' | ')} |\n${rows.slice(1).map(line).join('\n')}\n\n`;
      }
      case 'tr': case 'td': case 'th': case 'thead': case 'tbody': case 'tfoot': return kids();
      default: return kids();
    }
  }
  let md = conv(root);
  // Trailing spaces go; a single stray leading space (from inline whitespace) goes; real indentation (nested lists,
  // code blocks) stays.
  md = md.replace(/[ \t]+\n/g, '\n').replace(/\n (?=\S)/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, markdown: md };
}

function createWebFetch({
  getSetting = () => undefined,
  fetchImpl = (...a) => globalThis.fetch(...a),
  lookup = (host) => dns.lookup(host, { all: true }),
  exec = null,                               // async (file, args, opts) => { stdout } ; default child_process.execFile
  renderer = undefined,                      // async (url) => html | null ; default: Playwright Firefox via web-render.py
  isMemberOwned = () => false,               // agent record -> owned by a member (not an admin)
  blockedPorts = defaultBlockedPorts,        // () => Set of ports never fetched on private addresses (the hub's own services)
  pythonCandidates = [path.join(os.homedir(), '.venvs', 'hf', 'bin', 'python'), 'python3'],
  timeoutMs = 15000,
  log = (...a) => console.log(...a),
  now = () => Date.now(),
} = {}) {
  const execFileAsync = exec || promisify(execFile);
  const cache = new Map();
  let python = undefined;                    // resolved lazily: path | null

  function config() {
    const s = getSetting('webFetch') || {};
    return {
      allowPrivate: ['admin', 'none', 'all'].includes(s.allowPrivate) ? s.allowPrivate : 'none',   // default none since the 2026-10-16 review (F21); the owner opts in
      render: ['auto', 'off', 'always'].includes(s.render) ? s.render : 'auto',
      jina: !!s.jina,
      cacheMinutes: Number.isFinite(Number(s.cacheMinutes)) ? Number(s.cacheMinutes) : 10,
      maxLength: Number(s.maxLength) > 0 ? Number(s.maxLength) : 20000,
    };
  }

  /** Whether a fetch on behalf of `agent` may reach private addresses, per settings.webFetch.allowPrivate. */
  function allowPrivateFor(agent) {
    const mode = config().allowPrivate;
    if (mode === 'all') return true;
    if (mode === 'none') return false;
    return !isMemberOwned(agent);
  }

  /**
   * Never reachable through the hub, whatever the private-address setting (review F21): link-local / cloud-metadata
   * addresses, and the hub's own port and local model servers on loopback or private addresses (a fetch there is a
   * request made as the hub itself).
   */
  async function checkAlways(hostname, port) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    let ips = [];
    if (net.isIP(h)) ips = [h];
    else if (!h || h === 'localhost' || h.endsWith('.localhost')) ips = ['127.0.0.1'];
    else { try { const a = await lookup(h); ips = (Array.isArray(a) ? a : [a]).map(x => x.address || x); } catch { ips = []; } }
    if (h === 'metadata.google.internal' || ips.some(isLinkLocal)) throw new Error(`refused: ${h} is a link-local (metadata) address`);
    const blocked = blockedPorts();
    if (blocked.has(Number(port)) && ips.some(ip => isPrivateIp(ip))) throw new Error(`refused: port ${port} on ${h} is one of the hub's own services`);
  }

  async function checkHost(hostname, allowPrivate) {
    const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');   // URL gives IPv6 hosts in brackets
    if (allowPrivate) return;
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) throw new Error(`refused: ${h || '(empty host)'} is a local address`);
    if (net.isIP(h)) { if (isPrivateIp(h)) throw new Error(`refused: ${h} is a private address`); return; }
    let addrs;
    try { addrs = await lookup(h); } catch (e) { throw new Error(`cannot resolve ${h}: ${e.code || e.message}`); }
    const list = (Array.isArray(addrs) ? addrs : [addrs]).map(a => a.address || a);
    if (!list.length) throw new Error(`cannot resolve ${h}`);
    const bad = list.find(isPrivateIp);
    if (bad) throw new Error(`refused: ${h} resolves to the private address ${bad}`);
  }

  async function findPython() {
    if (python !== undefined) return python;
    for (const p of pythonCandidates) {
      try { await execFileAsync(p, ['-I', '-c', 'import playwright.sync_api'], { timeout: 20000 }); python = p; return p; } catch {}
    }
    python = null; return null;
  }
  const defaultRenderer = async (url) => {
    const p = await findPython();
    if (!p || !fs.existsSync(RENDER_SCRIPT)) return null;
    const r = await execFileAsync(p, ['-I', RENDER_SCRIPT, url], { timeout: 45000, maxBuffer: MAX_BYTES * 2 });
    return r.stdout || null;
  };
  const render = renderer === undefined ? defaultRenderer : renderer;
  async function rendererAvailable() { if (renderer !== undefined) return !!renderer; return !!(await findPython()) && fs.existsSync(RENDER_SCRIPT); }

  async function download(url, allowPrivate) {
    let u;
    try { u = new URL(url); } catch { throw new Error('not a valid URL'); }
    if (!/^https?:$/.test(u.protocol)) throw new Error(`only http and https are fetched (got ${u.protocol})`);
    const portOf = (x) => Number(x.port) || (x.protocol === 'https:' ? 443 : 80);
    await checkAlways(u.hostname, portOf(u));
    await checkHost(u.hostname, allowPrivate);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      // Redirects are followed by fetch itself; a redirect to a private address is caught by checking the final URL.
      const r = await fetchImpl(u.toString(), { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.8' } });
      const finalUrl = r.url || u.toString();
      if (finalUrl !== u.toString()) { try { const fu = new URL(finalUrl); await checkAlways(fu.hostname, portOf(fu)); await checkHost(fu.hostname, allowPrivate); } catch (e) { throw new Error(`redirected to a refused address: ${e.message}`); } }
      const type = String(r.headers.get('content-type') || '').toLowerCase();
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_BYTES) throw new Error(`too large (${len} bytes; limit ${MAX_BYTES})`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BYTES) throw new Error(`too large (>${MAX_BYTES} bytes)`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { finalUrl, type, buf, status: r.status };
    } finally { clearTimeout(t); }
  }

  async function pdfText(buf) {
    const tmp = path.join(os.tmpdir(), `hub-fetch-${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    try {
      fs.writeFileSync(tmp, buf, { mode: 0o600 });
      const r = await execFileAsync('pdftotext', ['-layout', tmp, '-'], { timeout: 30000, maxBuffer: MAX_BYTES * 2 });
      return r.stdout || '';
    } catch (e) {
      if (e && e.code === 'ENOENT') throw new Error('PDF reading needs pdftotext (poppler-utils) on the hub machine');
      throw new Error(`pdftotext failed: ${e.message}`);
    } finally { try { fs.unlinkSync(tmp); } catch {} }
  }

  /** Nearly nothing readable came back: a JavaScript shell, a bot wall, or a page that only exists in the browser. */
  function looksEmpty(md) {
    const text = md.replace(/[#*`>\-|\[\]()!]/g, '').replace(/\s+/g, ' ').trim();
    return text.length < 400;
  }

  /**
   * fetchPage(url, { allowPrivate, render, maxLength, offset }) ->
   *   { url, finalUrl, title, contentType, markdown, length, truncated, offset, cached, via }
   * `via` names what produced the text: fetch | browser | jina | pdf | text.
   */
  async function fetchPage(url, { allowPrivate = false, render: wantRender, maxLength, offset = 0 } = {}) {
    const cfg = config();
    const limit = Math.max(500, Math.min(Number(maxLength) || cfg.maxLength, 200000));
    const off = Math.max(0, Number(offset) || 0);
    const forceRender = wantRender === true || cfg.render === 'always';
    const key = `${forceRender ? 'r:' : ''}${url}`;
    const hit = cache.get(key);
    let page;
    if (hit && now() - hit.ts < cfg.cacheMinutes * 60000) page = { ...hit.page, cached: true };
    else {
      page = await produce(url, { allowPrivate, forceRender, cfg });
      if (cfg.cacheMinutes > 0) { cache.set(key, { ts: now(), page }); if (cache.size > 200) cache.delete(cache.keys().next().value); }
    }
    const full = page.markdown;
    const slice = full.slice(off, off + limit);
    return { ...page, markdown: slice, length: full.length, offset: off, truncated: off + limit < full.length };
  }

  async function produce(url, { allowPrivate, forceRender, cfg }) {
    let d;
    try { d = await download(url, allowPrivate); }
    catch (e) {
      if (cfg.jina && !/refused|private|local address|valid URL|only http/.test(e.message)) return jina(url, e);
      throw e;
    }
    const base = { url, finalUrl: d.finalUrl, contentType: d.type.split(';')[0].trim(), cached: false };
    if (/application\/pdf/.test(d.type) || (d.buf.slice(0, 5).toString() === '%PDF-')) {
      const text = (await pdfText(d.buf)).replace(/\f/g, '\n\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      return { ...base, title: path.basename(new URL(d.finalUrl).pathname) || 'document.pdf', markdown: text || '(no text in this PDF; it may be scanned)', via: 'pdf' };
    }
    const isHtml = /text\/html|application\/xhtml/.test(d.type) || /^\s*<(!doctype|html)/i.test(d.buf.slice(0, 200).toString());
    if (!isHtml) {
      if (/^text\/|json|xml|javascript|yaml|csv|markdown/.test(d.type)) {
        let text = d.buf.toString('utf8');
        if (/json/.test(d.type)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch {} }
        return { ...base, title: '', markdown: text.trim(), via: 'text' };
      }
      return { ...base, title: '', markdown: `(binary content: ${base.contentType || 'unknown type'}, ${d.buf.length} bytes; not readable as text)`, via: 'binary' };
    }
    const html = d.buf.toString('utf8');
    let { title, markdown } = htmlToMarkdown(html, d.finalUrl);
    let via = 'fetch';
    if (cfg.render !== 'off' && (forceRender || looksEmpty(markdown))) {
      try {
        const rendered = await render(d.finalUrl);
        if (rendered) {
          const r2 = htmlToMarkdown(rendered, d.finalUrl);
          if (forceRender || r2.markdown.length > markdown.length) { title = r2.title || title; markdown = r2.markdown; via = 'browser'; }
        }
      } catch (e) { log(`[webfetch] browser render failed for ${url}: ${e.message}`); }
    }
    if (!markdown.trim() && cfg.jina) return jina(url, new Error('empty page'));
    if (!markdown.trim()) markdown = '(no readable content extracted; the page may need JavaScript — try render: true, or it may block automated readers)';
    return { ...base, title, markdown, via };
  }

  async function jina(url, cause) {
    const r = await fetchImpl(`https://r.jina.ai/${url}`, { signal: AbortSignal.timeout(timeoutMs * 2), headers: { Accept: 'text/markdown', 'User-Agent': UA } });
    if (!r.ok) throw new Error(`${cause.message}; Jina Reader answered HTTP ${r.status}`);
    const text = (await r.text()).trim();
    const title = (text.match(/^Title:\s*(.+)$/m) || [])[1] || '';
    return { url, finalUrl: url, contentType: 'text/markdown', title, markdown: text, via: 'jina', cached: false };
  }

  /** The WebFetch tool body: text for the model. ctx.allowPrivate is decided by the caller (agent role + settings). */
  async function toolText(args = {}, ctx = {}) {
    const p = await fetchPage(String(args.url || ''), { allowPrivate: !!ctx.allowPrivate, render: args.render === true, maxLength: args.max_length, offset: args.offset });
    const head = p.title ? `# ${p.title}\n\n` : '';
    const note = p.truncated ? `\n\n... (${p.length - p.offset - p.markdown.length} more characters; call again with offset: ${p.offset + p.markdown.length})` : '';
    const via = p.via === 'browser' ? ' (rendered in a browser)' : p.via === 'jina' ? ' (via Jina Reader)' : p.via === 'pdf' ? ' (PDF text)' : '';
    const src = p.finalUrl && p.finalUrl !== p.url ? `\n\n— fetched from ${p.finalUrl}${via}` : via ? `\n\n—${via}` : '';
    return `${head}${p.markdown}${note}${src}`;
  }

  async function status() {
    return { ...config(), renderer: await rendererAvailable(), pdftotext: await execFileAsync('pdftotext', ['-v'], { timeout: 5000 }).then(() => true, (e) => !(e && e.code === 'ENOENT')), cacheEntries: cache.size };
  }
  function clearCache() { cache.clear(); }

  return { config, allowPrivateFor, checkHost, fetchPage, toolText, status, clearCache, htmlToMarkdown, isPrivateIp, rendererAvailable };
}

let singleton = null;
function getWebFetch() {
  if (!singleton) {
    const settings = require('./settings');
    let adminIds = () => new Set();
    try { const auth = require('./auth'); adminIds = () => { try { return new Set(auth.getAuth().admins().map(u => u.id)); } catch { return new Set(); } }; } catch {}
    singleton = createWebFetch({
      getSetting: (k) => settings.getSetting(k),
      isMemberOwned: (a) => !!(a && a.owner && !adminIds().has(String(a.owner))),
    });
  }
  return singleton;
}

module.exports = { createWebFetch, getWebFetch, htmlToMarkdown, isPrivateIp, isLinkLocal, defaultBlockedPorts, UA, MAX_BYTES };
