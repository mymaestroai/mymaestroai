/**
 * ui-file-card.js — download cards under an agent's reply (shared by the desktop page and the phone page).
 *
 * An agent that wrote a file says so with a path in its reply or a link to /api/files/download. This helper finds those
 * in the rendered message, asks the hub which of them are real readable files (POST /api/files/resolve, one request
 * for the whole message) and builds a card for each: icon, name, size, folder, a preview for pictures and PDFs and one
 * big Download button.
 *
 * Functions:
 *   candidatesFrom(root, opts)     up to 12 { key, item, anchorEl } from a rendered message element. Items: { abs } (a full path
 *                                  in a link or code span, spaces allowed inside), { path, agent|owner } (a download link) and,
 *                                  only when opts.agent is a non-empty string, { name, agent } (a code span holding just a file
 *                                  name; the hub looks for it in that agent's own folder and cards it only when it is unique)
 *   keyOf(item)                    the de-duplication / cache key of an item ('a:', 'd:' or 'n:' + agent + '|' + name)
 *   kindOf(name)                   'image' | 'pdf' | 'audio' | 'video' | 'archive' | 'text' | 'other'
 *   iconOf(kind)                   one emoji (never one that needs a variation selector)
 *   formatSize(bytes)              "512 B", "1.2 KB", "9.4 MB", "1.1 GB"
 *   cardHtml(result, { esc, phone })  the card's HTML; every value goes through esc
 *   resolveBatch(fetchFn, items)   one POST for the uncached items; results in the same order; never throws
 *
 * No DOM access at load. Browser: window.hubFileCard. Node (tests): module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubFileCard = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const MAX_ITEMS = 12;
  const DOWNLOAD_PATH = '/api/files/download';
  // A WHOLE path (a code span's text, a decoded href): starts with "/", every segment may hold spaces inside but never starts or ends
  // with one, no control characters, no "//", ends in a file name with an extension.
  const SEG = '[^/\\x00-\\x1f\\x7f ](?:[^/\\x00-\\x1f\\x7f]*[^/\\x00-\\x1f\\x7f ])?';
  const CODE_ABS = new RegExp('^/(?:' + SEG + '/)*' + SEG + '\\.[A-Za-z0-9]{1,8}$');
  const MAX_ABS_LEN = 1024;
  const isAbsPath = (s) => typeof s === 'string' && s.length <= MAX_ABS_LEN && CODE_ABS.test(s);
  // A bare file name (no folder): 3..255 characters, no "/" or "\", no control characters, not starting with "." or a space,
  // not ending with a space, at least one non-space before the extension, and a letter in the extension (so a version or a number such as
  // `5.10.0` or `3.14` is not taken for a file name).
  const BARE_NAME = /^[^/\\\x00-\x1f\x7f. ](?:[^/\\\x00-\x1f\x7f]*[^/\\\x00-\x1f\x7f ])?\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,8}$/;
  const isBareName = (s) => typeof s === 'string' && s.length >= 3 && s.length <= 255 && BARE_NAME.test(s) && /[^\s.]/.test(s.slice(0, s.lastIndexOf('.')));

  function keyOf(item) {
    if (!item) return '';
    if (item.abs) return 'a:' + item.abs;
    if (item.name && item.agent) return 'n:' + item.agent + '|' + item.name;
    return 'd:' + (item.agent || '') + '|' + (item.owner || '') + '|' + (item.path || '');
  }

  // The item for one link target (already stripped of the page's own origin), or null.
  function itemFromHref(href) {
    if (typeof href !== 'string') return null;
    href = href.trim();
    if (!href || href[0] !== '/' || href.startsWith('//')) return null;
    const q = href.indexOf('?'), h = href.indexOf('#');
    const cut = (i) => (i < 0 ? href.length : i);
    const pathname = href.slice(0, Math.min(cut(q), cut(h)));
    if (pathname === DOWNLOAD_PATH) {
      if (q < 0) return null;
      let params;
      try { params = new URLSearchParams(href.slice(q + 1, h > q ? h : undefined)); } catch { return null; }
      const path = params.get('path');
      if (!path) return null;
      const item = { path };
      if (params.get('agent')) item.agent = params.get('agent');
      if (params.get('owner')) item.owner = params.get('owner');
      return item;
    }
    let abs = pathname;
    try { abs = decodeURIComponent(pathname); } catch { return null; }
    return isAbsPath(abs) ? { abs } : null;
  }

  function sameOriginHref(href, root) {
    if (typeof href !== 'string') return null;
    const s = href.trim();
    if (/^https?:\/\//i.test(s)) {
      let origin = '';
      try { origin = (root && root.ownerDocument && root.ownerDocument.location && root.ownerDocument.location.origin) || (typeof location !== 'undefined' && location.origin) || ''; } catch { origin = ''; }
      if (!origin) return null;
      try { const u = new URL(s); return u.origin === origin ? u.pathname + u.search : null; } catch { return null; }
    }
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s)) return null;   // javascript:, data:, mailto:, any other scheme
    return s;
  }

  function candidatesFrom(root, opts) {
    const out = [], seen = new Set();
    const agent = opts && typeof opts.agent === 'string' && opts.agent ? opts.agent : '';
    if (!root || typeof root.querySelectorAll !== 'function') return out;
    const inPre = (el) => { try { return !!(el.closest && el.closest('pre')); } catch { return false; } };
    const add = (item, anchorEl) => {
      if (!item || out.length >= MAX_ITEMS) return;
      const key = keyOf(item);
      if (seen.has(key)) return;
      seen.add(key); out.push({ key, item, anchorEl });
    };
    for (const a of Array.from(root.querySelectorAll('a[href]'))) {
      if (out.length >= MAX_ITEMS) break;
      if (inPre(a)) continue;
      if (typeof a.querySelectorAll === 'function' && a.querySelectorAll('img').length) continue;   // a picture already shown inline
      const href = sameOriginHref(a.getAttribute('href'), root);
      if (href === null) continue;
      add(itemFromHref(href), a);
    }
    const names = [];   // bare names come after every link and full path, so code-like spans (`console.log`) never crowd out a real path
    for (const c of Array.from(root.querySelectorAll('code'))) {
      if (out.length >= MAX_ITEMS) break;
      if (inPre(c)) continue;
      const text = String(c.textContent || '').trim();
      if (isAbsPath(text)) add({ abs: text }, c);
      else if (agent && isBareName(text)) names.push([{ name: text, agent }, c]);
    }
    for (const [item, c] of names) { if (out.length >= MAX_ITEMS) break; add(item, c); }
    return out;
  }

  const EXT = {
    image: 'png jpg jpeg gif webp bmp svg avif ico heic tif tiff',
    pdf: 'pdf',
    audio: 'mp3 wav m4a ogg oga flac aac opus',
    video: 'mp4 mov webm mkv avi m4v',
    archive: 'zip gz tgz tar 7z rar bz2 xz',
    text: 'txt md csv tsv json log yml yaml xml html htm js mjs ts py sh css ini toml rtf',
  };
  const KIND_OF_EXT = {};
  for (const [kind, list] of Object.entries(EXT)) for (const e of list.split(' ')) KIND_OF_EXT[e] = kind;

  function kindOf(name) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return (m && KIND_OF_EXT[m[1].toLowerCase()]) || 'other';
  }

  const ICONS = { image: '\u{1F4F7}', pdf: '\u{1F4C4}', audio: '\u{1F3B5}', video: '\u{1F3AC}', archive: '\u{1F4E6}', text: '\u{1F4DD}', other: '\u{1F4CE}' };
  function iconOf(kind) { return ICONS[kind] || ICONS.other; }

  function formatSize(bytes) {
    let n = Number(bytes);
    if (!isFinite(n) || n < 0) n = 0;
    if (n < 1024) return Math.round(n) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB']; let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n < 10 ? n.toFixed(1) : n.toFixed(n < 100 ? 1 : 0)) + ' ' + units[i];
  }

  // Only the hub's own file routes go into an href or src.
  const safeUrl = (u) => (typeof u === 'string' && u.startsWith('/api/files/') ? u : '');

  function cardHtml(result, opts) {
    opts = opts || {};
    const rawEsc = typeof opts.esc === 'function' ? opts.esc : (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    const e = (v) => String(rawEsc(v == null ? '' : v)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');   // safe in an attribute too
    if (!result || result.ok === false) return '';
    const name = String(result.name || 'file');
    const kind = result.kind || kindOf(name);
    const rel = String(result.path || '');
    const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const download = safeUrl(result.download), inline = safeUrl(result.inline);
    let html = `<div class="file-card" data-kind="${e(kind)}">`;
    html += `<div class="fc-head"><span class="fc-icon">${iconOf(kind)}</span><div class="fc-meta"><div class="fc-name" title="${e(name)}">${e(name)}</div>`
      + `<div class="fc-sub">${e(formatSize(result.size))}${folder ? ' · ' + e(folder) : ''}</div></div></div>`;
    if (kind === 'image' && inline) html += `<img class="fc-preview" loading="lazy" src="${e(inline)}" alt="${e(name)}" style="max-height:160px">`;
    if (kind === 'pdf' && inline) html += `<a class="fc-preview-link" href="${e(inline)}" target="_blank" rel="noopener">Preview</a>`;
    if (download) {
      if (opts.phone) html += `<button type="button" class="fc-download" data-download="${e(download)}" data-name="${e(name)}" data-size="${e(result.size == null ? '' : result.size)}" data-mime="${e(result.mime || '')}">Download</button>`;
      else html += `<a class="fc-download" href="${e(download)}" download="${e(name)}">Download</a>`;
    }
    return html + '</div>';
  }

  const cache = new Map();   // key -> an ok result, for the page's life (a "not found" is asked again: the file may be written later)

  // items: candidates ({ key, item }) or bare items. Returns one result per item, in order; a failure is { ok: false }.
  async function resolveBatch(fetchFn, items) {
    const list = (Array.isArray(items) ? items : []).slice(0, MAX_ITEMS).map((x) => (x && x.item ? { key: x.key || keyOf(x.item), item: x.item } : { key: keyOf(x), item: x }));
    // A bare name is never cached: which file it means (or whether it is still the only one) can change, so it is asked afresh each time.
    const cacheable = (x) => !String(x.key).startsWith('n:');
    const results = list.map((x) => (cacheable(x) && cache.get(x.key)) || null);
    const todo = [];
    list.forEach((x, i) => { if (!results[i]) todo.push(i); });
    if (todo.length) {
      try {
        const r = await fetchFn('/api/files/resolve', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: todo.map((i) => list[i].item) }),
        });
        const data = r && r.ok ? await r.json() : null;
        const got = data && Array.isArray(data.items) ? data.items : [];
        todo.forEach((i, j) => {
          const res = got[j];
          if (res && res.ok) { results[i] = res; if (cacheable(list[i])) cache.set(list[i].key, res); }
          else results[i] = { ok: false, error: (res && res.error) || 'not found' };
        });
      } catch {
        for (const i of todo) results[i] = { ok: false, error: 'not found' };
      }
    }
    return results;
  }

  return { candidatesFrom, keyOf, kindOf, iconOf, formatSize, cardHtml, resolveBatch };
});
