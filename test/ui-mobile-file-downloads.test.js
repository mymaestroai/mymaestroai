'use strict';
// Phone: easier file downloads. Download cards under a reply, the Save / Share sheet (fetch with the app's own session,
// navigator.share with the file only, blob fallback), and the Files sheet's "Recent from agents" and "Download as zip".
// mobile.js is not run as a page: its functions are cut out of the source and run in a vm with stand-ins for the page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js'), html = read('mobile.html');
const H = require('../lib/ui-file-card.js');

function grab(name) {
  const m = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(js);
  if (!m) throw new Error(`mobile.js has no function ${name}`);
  const end = js.indexOf('\n}\n', m.index);
  return js.slice(m.index, end + 2);
}
function grabConst(name) {
  const m = new RegExp(`^const ${name} = .*;$`, 'm').exec(js);
  if (!m) throw new Error(`mobile.js has no const ${name}`);
  return m[0];
}
function load(parts, names, globals) {
  const code = `(function () { ${parts.join('\n')}\n return { ${names.join(', ')} }; })()`;
  return vm.runInNewContext(code, { AbortController, Blob, File, setTimeout, clearTimeout, URL, Promise, ...globals });
}
const tick = () => new Promise((r) => setImmediate(r));

const CONSTS = ['DL_MAX_BYTES', 'DL_TIMEOUT_MS', 'DL_TOO_BIG', 'DL_FAILED'].map(grabConst);
function readerKit() {
  return load([...CONSTS, grab('humanSize'), grab('dlStatusMessage'), grab('dlProgressText'), grab('dlNextStep'), grab('dlPreviewUrl'), grab('dlReadFile'),
    grab('dlShareFiles'), grab('dlCanShareFile'), grab('dlSaveViaLink')],
  ['DL_MAX_BYTES', 'DL_TOO_BIG', 'DL_FAILED', 'dlStatusMessage', 'dlProgressText', 'dlNextStep', 'dlPreviewUrl', 'dlReadFile', 'dlShareFiles', 'dlCanShareFile', 'dlSaveViaLink'],
  { window: { hubFileCard: H } });
}
function resp({ status = 200, headers = {}, chunks = [] } = {}) {
  const state = { reads: 0, cancelled: false };
  const r = {
    ok: status >= 200 && status < 300, status,
    headers: { get: (k) => (headers[String(k).toLowerCase()] !== undefined ? headers[String(k).toLowerCase()] : null) },
    body: { getReader() { let i = 0; return { read: async () => { state.reads++; return i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }; }, cancel: async () => { state.cancelled = true; } }; } },
  };
  return { r, state };
}
const bytes = (n) => new Uint8Array(n);

test('mobile.html loads /ui-file-card.js before mobile.js and has the Save / Share dialog and the card CSS', () => {
  const card = html.indexOf('<script src="/ui-file-card.js"></script>');
  const mob = html.indexOf('<script src="mobile.js"></script>');
  assert.ok(card > 0 && mob > card, '/ui-file-card.js comes before mobile.js');
  assert.match(html, /<dialog id="dl-sheet" data-no-dirty><\/dialog>/);
  assert.match(html, /\.file-card \.fc-download \{[^}]*min-height: 44px;/, 'a big Download button');
  assert.match(html, /\.file-card \.fc-preview \{[^}]*max-height: 160px;/);
  assert.match(html, /#dl-sheet \.dl-btns button \{ min-height: 44px;/);
});

test('cards are attached on history and when a reply is final, never per streaming chunk, never from the tool or reasoning panels', () => {
  assert.match(grab('renderEntry'), /attachFileCards\(b\.el, b\.body\)/, 'a saved reply drawn from history');
  assert.match(grab('renderArchived'), /attachFileCards\(b\.el, b\.body\)/);
  assert.match(grab('feedEnd'), /attachFileCards\(holder\.bubble\.el, holder\.bubble\.body\)/, 'the turn ended');
  for (const per of ['paintReply', 'setReplyText', 'paintReattach', 'readStream']) assert.doesNotMatch(grab(per), /attachFileCards/, `${per} runs per chunk`);
  const a = grab('attachFileCards');
  assert.match(a, /cardHtml\(r, \{ esc, phone: true \}\)/, 'the phone form of the card');
  assert.match(a, /querySelectorAll\('\.feed, \.tsn, \.rsn, \.reattach, \.copy, \.code-copy, \.note'\)\.forEach/, 'tool and reasoning panels are skipped');
  assert.match(a, /catch \(e\) \{/, 'never throws into the chat code');
});

test('attachFileCards: no candidates makes no request; a card box goes right after the body, once', async () => {
  const mk = (withLink) => {
    const body = { _after: null, cloneNode() { return { querySelectorAll: () => ({ forEach() {} }), _c: withLink }; }, after(x) { this._after = x; } };
    const el = { isConnected: true, classList: { contains: (c) => c === 'assistant' }, querySelector: () => null, _box: null, body };
    return { el, body };
  };
  let posts = 0;
  const fakeH = { candidatesFrom: (s) => (s._c ? [{ key: 'k', item: { abs: '/x/a.pdf' } }] : []), resolveBatch: async () => { posts++; return [{ ok: true }]; }, cardHtml: () => '<div class="file-card"></div>' };
  const doc = { createElement: () => ({ dataset: {}, set innerHTML(v) { this._h = v; } }) };
  const kit = load([grab('attachFileCards')], ['attachFileCards'], { window: { hubFileCard: fakeH }, esc: (s) => s, document: doc, fetch: () => {} });
  const none = mk(false);
  await kit.attachFileCards(none.el, none.body);
  assert.strictEqual(posts, 0, 'no candidates, no request');
  assert.strictEqual(none.body._after, null);
  const one = mk(true);
  await kit.attachFileCards(one.el, one.body);
  assert.strictEqual(posts, 1);
  assert.strictEqual(one.body._after.className, 'file-cards');
  assert.strictEqual(one.body._after._h, '<div class="file-card"></div>');
});

test('the Save / Share sheet is a labelled modal dialog on the existing dialogGuard (Back, Escape and Close close it)', () => {
  const o = grab('openDownloadSheet');
  assert.match(o, /setAttribute\('role', 'dialog'\)/);
  assert.match(o, /setAttribute\('aria-modal', 'true'\)/);
  assert.match(o, /setAttribute\('aria-labelledby', 'dl-title'\)/);
  assert.match(o, /dialogGuard\.open\(sh, \{ close: dlClose \}\)/);
  assert.match(o, /\$\('dl-close'\)\.addEventListener\('click', \(\) => dialogRequestClose\(sh, 'close'\)\)/);
  assert.match(o, /Save \/ Share/);
  assert.match(grab('dlClose'), /dialogGuard\.closed\(sh\)/);
  assert.match(o, /\$\{preview \? '<button type="button" id="dl-preview">Preview<\/button>' : ''\}/, 'Preview only when there is an inline form');
});

test('Preview is offered for pictures and PDFs only (never an svg, never other kinds)', () => {
  const k = readerKit();
  const u = '/api/files/download?agent=a&path=x';
  assert.strictEqual(k.dlPreviewUrl(u, 'photo.png'), u + '&inline=1');
  assert.strictEqual(k.dlPreviewUrl(u, 'report.PDF'), u + '&inline=1');
  assert.strictEqual(k.dlPreviewUrl(u, 'logo.svg'), '');
  assert.strictEqual(k.dlPreviewUrl(u, 'notes.txt'), '');
  assert.strictEqual(k.dlPreviewUrl(u, 'song.mp3'), '');
});

test('the fetch uses the app\'s own session: same-origin credentials, redirect error, no-store, an abort signal', async () => {
  const k = readerKit();
  const seen = [];
  const ctl = new AbortController();
  const { r } = resp({ headers: { 'content-length': '3', 'content-type': 'text/plain' }, chunks: [bytes(3)] });
  const out = await k.dlReadFile('/api/files/download?path=a.txt', { ctl, fetchFn: async (u, o) => { seen.push([u, o]); return r; } });
  assert.strictEqual(seen[0][0], '/api/files/download?path=a.txt');
  assert.deepStrictEqual(Object.keys(seen[0][1]).sort(), ['cache', 'credentials', 'redirect', 'signal']);
  assert.strictEqual(seen[0][1].credentials, 'same-origin');
  assert.strictEqual(seen[0][1].redirect, 'error');
  assert.strictEqual(seen[0][1].cache, 'no-store');
  assert.strictEqual(seen[0][1].signal, ctl.signal);
  assert.strictEqual(out.size, 3);
  assert.match(grab('dlReadFile'), /const timer = setTimeout\(\(\) => \{ timedOut = true; ctl\.abort\(\); \}, DL_TIMEOUT_MS\)/);
  assert.match(grabConst('DL_TIMEOUT_MS'), /120000/);
});

test('more than 100 MiB is refused from Content-Length before reading, and while reading', async () => {
  const k = readerKit();
  assert.strictEqual(k.DL_MAX_BYTES, 100 * 1024 * 1024);
  assert.strictEqual(k.DL_TOO_BIG, 'This file is larger than 100 MB. Open the hub on a computer to download it.');
  const big = resp({ headers: { 'content-length': String(100 * 1024 * 1024 + 1) }, chunks: [bytes(1)] });
  const ctl = new AbortController();
  await assert.rejects(k.dlReadFile('/api/files/x', { ctl, fetchFn: async () => big.r }), (e) => e.userMessage === k.DL_TOO_BIG);
  assert.strictEqual(big.state.reads, 0, 'not one byte is read once Content-Length says too big');
  assert.ok(ctl.signal.aborted);
  // no Content-Length: counted while reading (fake chunks that only claim a size)
  const grow = resp({ chunks: [{ byteLength: 60 * 1024 * 1024 }, { byteLength: 41 * 1024 * 1024 }, bytes(1)] });
  const ctl2 = new AbortController();
  await assert.rejects(k.dlReadFile('/api/files/x', { ctl: ctl2, fetchFn: async () => grow.r }), (e) => e.userMessage === k.DL_TOO_BIG);
  assert.strictEqual(grow.state.reads, 2, 'stops at the chunk that passes the limit');
  assert.ok(grow.state.cancelled && ctl2.signal.aborted);
});

test('status messages: 401 sign in again, 403 cannot open, 404 gone, anything else or cut short "didn\'t finish"', async () => {
  const k = readerKit();
  assert.strictEqual(k.dlStatusMessage(401), 'Sign in again, then try once more.');
  assert.strictEqual(k.dlStatusMessage(403), "You can't open this file.");
  assert.strictEqual(k.dlStatusMessage(404), 'The file is no longer there.');
  assert.strictEqual(k.dlStatusMessage(500), "The download didn't finish. Try again.");
  for (const [status, text] of [[401, 'Sign in again, then try once more.'], [403, "You can't open this file."], [404, 'The file is no longer there.'], [502, "The download didn't finish. Try again."]]) {
    await assert.rejects(k.dlReadFile('/api/files/x', { ctl: new AbortController(), fetchFn: async () => resp({ status }).r }), (e) => e.userMessage === text, String(status));
  }
  const short = resp({ headers: { 'content-length': '10' }, chunks: [bytes(4)] });
  await assert.rejects(k.dlReadFile('/api/files/x', { ctl: new AbortController(), fetchFn: async () => short.r }), (e) => e.userMessage === k.DL_FAILED, 'incomplete');
  await assert.rejects(k.dlReadFile('/api/files/x', { ctl: new AbortController(), fetchFn: async () => { throw new TypeError('network'); } }), (e) => e.userMessage === k.DL_FAILED, 'network error');
  assert.strictEqual(k.dlProgressText(3.1 * 1024 * 1024, 9.4 * 1024 * 1024), 'Preparing… 3.1 MB of 9.4 MB');
});

test('closing the sheet aborts the fetch, quietly', async () => {
  const k = readerKit();
  const ctl = new AbortController();
  const p = k.dlReadFile('/api/files/x', { ctl, fetchFn: (u, o) => new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
  ctl.abort();   // what dlClose does
  await assert.rejects(p, (e) => e.quiet === true && e.name === 'AbortError' && !e.userMessage);
  const dl = vm.runInNewContext(`(function(){ ${grabConst('dlState')}\n ${grab('dlClose')}\n return { dlState, dlClose }; })()`, { $: () => null, dialogGuard: { closed() {} } });
  const c2 = new AbortController();
  dl.dlState.ctl = c2;
  dl.dlClose();
  assert.ok(c2.signal.aborted, 'dlClose aborts the running fetch');
  assert.strictEqual(dl.dlState.ctl, null);
});

test('the next step: share when files can be shared, blob fallback when not, tap on NotAllowedError, quiet close on AbortError', () => {
  const k = readerKit();
  assert.strictEqual(k.dlNextStep({ canShareFiles: true }), 'share');
  assert.strictEqual(k.dlNextStep({ canShareFiles: false }), 'fallback');
  assert.strictEqual(k.dlNextStep({ canShareFiles: true, errorName: 'NotAllowedError' }), 'tap');
  assert.strictEqual(k.dlNextStep({ canShareFiles: true, errorName: 'AbortError' }), 'close');
  assert.strictEqual(k.dlNextStep({ canShareFiles: true, errorName: 'DataError' }), 'failed');
  const file = { name: 'a.pdf' };
  assert.strictEqual(k.dlCanShareFile({ canShare: () => true, share() {} }, file), true);
  assert.strictEqual(k.dlCanShareFile({ canShare: () => false, share() {} }, file), false);
  assert.strictEqual(k.dlCanShareFile({}, file), false);
  assert.strictEqual(k.dlCanShareFile({ canShare() { throw new Error('x'); }, share() {} }, file), false);
});

test('navigator.share gets the file only: never a url, never a text', () => {
  const k = readerKit();
  const calls = [];
  const file = { name: 'a.pdf' };
  k.dlShareFiles({ share: (arg) => { calls.push(arg); return Promise.resolve(); } }, file);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(Object.keys(calls[0]), ['files']);
  assert.strictEqual(calls[0].files.length, 1);
  assert.strictEqual(calls[0].files[0], file);
  assert.doesNotMatch(grab('dlShareFiles') + grab('dlTapSave') + grab('dlStart'), /share\(\{[^}]*\b(url|text|title)\b/);
  assert.match(grab('dlStart'), /new File\(\[got\.blob\], dlState\.name, \{ type: dlFileType\(dlState\.mime, got\.blob\.type\) \}\)/);
});

test('the File\'s type has no MIME parameters (iOS canShare accepts text files); empty falls back to octet-stream', async () => {
  const k = load([grab('dlFileType')], ['dlFileType']);
  assert.strictEqual(k.dlFileType('text/plain; charset=utf-8', ''), 'text/plain');
  assert.strictEqual(k.dlFileType('', 'text/csv;charset=utf-8'), 'text/csv', 'the blob type when the row gave none');
  assert.strictEqual(k.dlFileType('application/pdf', 'x/y'), 'application/pdf');
  assert.strictEqual(k.dlFileType('', ''), 'application/octet-stream');
  assert.strictEqual(k.dlFileType('; charset=utf-8', ''), 'application/octet-stream');
  // end to end through dlStart: the File handed to share has the bare type
  const shared = [];
  const els = { 'dl-go': { disabled: false, textContent: '' }, 'dl-msg': { textContent: '', className: '' }, 'dl-sheet': { open: true, close() {} } };
  const kit = vm.runInNewContext(`(function(){ ${CONSTS.join('\n')}\n ${grabConst('dlState')}\n ${['humanSize', 'dlFileType', 'dlProgressText', 'dlNextStep', 'dlShareFiles', 'dlCanShareFile', 'dlSay', 'dlGoPaint', 'dlClose', 'dlOnShareError', 'dlStart'].map(grab).join('\n')}
    dlState.url = '/api/files/download?path=a.txt'; dlState.name = 'a.txt'; dlState.mime = 'text/plain; charset=utf-8';
    return { dlStart }; })()`, {
    $: (id) => els[id] || null, dialogGuard: { closed() {} }, Promise, AbortController, File, Blob, setTimeout, clearTimeout, URL,
    dlReadFile: async () => ({ blob: new Blob(['hi'], { type: 'text/plain; charset=utf-8' }), size: 2, total: 2 }),
    navigator: { canShare: (a) => { shared.push(['can', a.files[0].type]); return true; }, share: (a) => { shared.push(['share', a.files[0].type]); return Promise.resolve(); } },
  });
  // dlReadFile is a global stand-in here: the kit's own copy is not loaded
  await kit.dlStart(); await tick();
  assert.deepStrictEqual(shared, [['can', 'text/plain'], ['share', 'text/plain']]);
});

function tapKit(shareImpl) {
  const els = { 'dl-go': { disabled: false, textContent: 'Save / Share' }, 'dl-msg': { textContent: '', className: '' } };
  const sheet = { open: true, closed: 0, close() { this.open = false; this.closed++; } };
  const guard = { closed: 0 };
  const calls = [];
  const kit = vm.runInNewContext(`(function(){ ${CONSTS.join('\n')}\n ${grabConst('dlState')}\n ${['dlNextStep', 'dlShareFiles', 'dlSay', 'dlGoPaint', 'dlClose', 'dlOnShareError', 'dlTapSave'].map(grab).join('\n')}
    return { dlState, dlTapSave, dlOnShareError }; })()`, {
    $: (id) => (id === 'dl-sheet' ? sheet : els[id] || null), dialogGuard: { closed: () => { guard.closed++; } }, Promise,
    navigator: { share: (arg) => { calls.push(arg); return shareImpl(); } },
  });
  return { kit, els, sheet, guard, calls };
}

test('NotAllowedError (a stale tap) turns the button into "Tap to save"; the fresh tap calls share synchronously in the handler', async () => {
  const stale = Object.assign(new Error('not allowed'), { name: 'NotAllowedError' });
  let mode = 'stale';
  const t = tapKit(() => (mode === 'stale' ? Promise.reject(stale) : Promise.resolve()));
  const file = { name: 'a.pdf' };
  t.kit.dlState.file = file;
  t.kit.dlOnShareError(stale);   // the first share, after preparing, was refused
  assert.strictEqual(t.kit.dlState.tap, true);
  assert.strictEqual(t.els['dl-go'].textContent, 'Tap to save');
  assert.strictEqual(t.els['dl-go'].disabled, false);
  assert.strictEqual(t.sheet.open, true, 'the sheet stays open');
  mode = 'ok';
  t.kit.dlTapSave();   // the click handler runs this
  assert.strictEqual(t.calls.length, 1, 'share was called before any await, inside the tap');
  assert.deepStrictEqual(Object.keys(t.calls[0]), ['files'], 'the file only: no url, no text');
  assert.strictEqual(t.calls[0].files.length, 1);
  assert.strictEqual(t.calls[0].files[0], file);
  await tick();
  assert.strictEqual(t.sheet.open, false, 'shared: the sheet closes');
  assert.doesNotMatch(grab('dlTapSave'), /await |async /);
  assert.match(grab('dlTapSave'), /const p = dlShareFiles\(navigator, file\);\s*dlState\.busy = true/);
  assert.match(grab('openDownloadSheet'), /if \(dlState\.tap && dlState\.file\) dlTapSave\(\); else dlStart\(\);/);
});

test('AbortError (the person cancelled the share sheet) closes quietly with no error line', async () => {
  const t = tapKit(() => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })));
  t.kit.dlState.file = { name: 'a.pdf' };
  t.kit.dlTapSave();
  await tick();
  assert.strictEqual(t.sheet.open, false);
  assert.strictEqual(t.guard.closed, 1);
  assert.strictEqual(t.els['dl-msg'].textContent, '', 'no message');
  assert.notStrictEqual(t.els['dl-msg'].className, 'dl-msg err');
});

test('the blob fallback saves through the blob\'s own object URL, never the private URL, and revokes it after a minute', () => {
  const k = readerKit();
  const made = [], revoked = [], timers = [];
  const a = { click() { this.clicked = true; }, remove() { this.removed = true; } };
  const env = {
    document: { createElement: () => a, body: { appendChild() {} } },
    URL: { createObjectURL: (f) => { made.push(f); return 'blob:https://hub.example/1234'; }, revokeObjectURL: (u) => revoked.push(u) },
    setTimeout: (fn, ms) => timers.push([fn, ms]),
  };
  const file = { name: 'report.pdf' };
  k.dlSaveViaLink(file, env);
  assert.strictEqual(a.href, 'blob:https://hub.example/1234');
  assert.strictEqual(a.download, 'report.pdf');
  assert.ok(a.clicked && a.removed);
  assert.deepStrictEqual(made, [file]);
  assert.strictEqual(timers[0][1], 60000);
  timers[0][0]();
  assert.deepStrictEqual(revoked, ['blob:https://hub.example/1234']);
  assert.doesNotMatch(grab('dlSaveViaLink'), /dlState|\/api\/files|\burl\b/, 'the private URL is nowhere in the fallback');
});

test('Recent from agents: /api/files/recent?limit=10, hidden when empty, quiet on failure, each row opens the sheet; refreshed by filesRefresh', () => {
  const r = grab('filesLoadRecent');
  assert.match(r, /filesApi\(filesUrl\('\/recent', \{ limit: 10 \}\)\)/);
  assert.match(r, /if \(!files\.length\) \{ box\.hidden = true; box\.innerHTML = ''; return; \}/);
  assert.match(r, /catch \{ data = null; \}/);
  assert.match(r, /Recent from agents/);
  assert.match(grab('onFilesRecentClick'), /openDownloadSheet\(\{ url: f\.download,/);
  assert.match(grab('filesRefresh'), /filesRenderList\(\);\s*filesLoadRecent\(\);/);
  assert.match(js, /<div class="fs-recent" id="fs-recent" hidden><\/div>\s*<div class="fs-crumbs" id="fs-crumbs">/, 'at the top of the sheet');
  assert.match(js, /\$\('fs-recent'\)\.addEventListener\('click', onFilesRecentClick\)/);
});

test('Recent: a server failure shows nothing; files are listed with a Download button each', async () => {
  const box = { hidden: false, innerHTML: 'old' };
  const mk = (api) => load([grab('humanSize'), grab('filesAgo'), grab('filesLoadRecent')], ['filesLoadRecent'], {
    $: () => box, filesState: { agent: 'bob', recent: [] }, filesApi: api, filesUrl: (r, p) => `/api/files${r}?agent=bob&limit=${p.limit}`, esc: (s) => String(s).replace(/</g, '&lt;'),
  });
  await mk(async () => { throw new Error('boom'); }).filesLoadRecent();
  assert.strictEqual(box.hidden, true);
  assert.strictEqual(box.innerHTML, '');
  await mk(async (u) => { assert.strictEqual(u, '/api/files/recent?agent=bob&limit=10'); return { files: [{ name: 'a<b>.pdf', size: 2048, folder: 'out', mtime: new Date().toISOString(), download: '/api/files/download?path=out%2Fa.pdf' }, { name: 'evil', download: 'https://x.test/e' }] }; }).filesLoadRecent();
  assert.strictEqual(box.hidden, false);
  assert.match(box.innerHTML, /Recent from agents/);
  assert.match(box.innerHTML, /a&lt;b>\.pdf/);
  assert.strictEqual((box.innerHTML.match(/class="fr-dl"/g) || []).length, 1, 'a download outside /api/files/ is dropped');
});

test('Download as zip: header button and each folder row; the check=1 call runs first and its refusal shows on the sheet\'s message line; ok starts a normal download link', async () => {
  assert.match(js, /<button id="fs-zip" title="Download the folder being shown as one zip file">Download as zip<\/button>/);
  assert.match(js, /\$\('fs-zip'\)\.addEventListener\('click', \(\) => filesZip\(filesState\.path\)\)/);
  assert.match(grab('filesRenderList'), /\$\{isDir \? `<button data-act="zip">Download as zip<\/button>` : `<button data-act="download">Download<\/button>`\}/);
  assert.match(grab('onFilesListClick'), /if \(act === 'zip'\) \{ filesZip\(rel\); return; \}/);
  assert.match(grab('onFilesListClick'), /if \(act === 'download'\) \{ openDownloadSheet\(/);
  assert.doesNotMatch(grab('onFilesListClick'), /window\.open\(filesUrl\('\/download'/, 'a file row\'s download opens the sheet, not a new tab');
  const filesUrl = (route, params) => `/api/files${route}?agent=bob&${new URLSearchParams(params).toString()}`;
  const zipKit = (apiImpl, extra = {}) => {
    const msgs = [], anchors = [], urls = [], sheets = [];
    const kit = load([grabConst('DL_MAX_BYTES'), grabConst('DL_ZIP_TOO_BIG'), grab('humanSize'), grab('filesZip')], ['filesZip', 'DL_ZIP_TOO_BIG'], {
      filesState: { path: 'out', root: { label: 'Bob' } }, filesUrl,
      filesApi: async (u, o) => { urls.push([u, o]); return apiImpl(u); }, filesMsg: (t, k) => msgs.push([t, k]),
      openDownloadSheet: (o) => sheets.push(o),
      document: { createElement: () => { const a = { click() { this.clicked = true; }, remove() {} }; anchors.push(a); return a; }, body: { appendChild() {} } },
      ...extra,
    });
    return { kit, msgs, anchors, urls, sheets };
  };
  const run = async (apiImpl) => { const z = zipKit(apiImpl); await z.kit.filesZip('out/reports'); return z; };
  const refused = await run(async () => { throw new Error('This folder is too big to download as one zip: 3,112 files and 4.1 GB (the limit is 2,000 files and 2 GB). Download its folders one at a time.'); });
  assert.strictEqual(refused.urls[0][0], '/api/files/zip?agent=bob&path=out%2Freports&check=1');
  assert.deepStrictEqual(refused.msgs[refused.msgs.length - 1], ['This folder is too big to download as one zip: 3,112 files and 4.1 GB (the limit is 2,000 files and 2 GB). Download its folders one at a time.', 'err']);
  assert.ok(!refused.anchors.some((a) => a.href), 'no download starts on a refusal');
  assert.strictEqual(refused.sheets.length, 0, 'no sheet on a refusal');
  assert.match(grab('filesZip'), /filesApi\(url \+ '&check=1', \{ credentials: 'same-origin' \}\)/);
});

test('phone "Download as zip": up to 100 MiB opens the Save / Share sheet on the zip URL (no check, "about N"); bigger shows the too-big line; never an anchor navigation', async () => {
  const filesUrl = (route, params) => `/api/files${route}?agent=bob&${new URLSearchParams(params).toString()}`;
  const ok = (bytes) => async () => ({ ok: true, files: 3, bytes });
  const mk = (bytes) => {
    const sheets = [], anchors = [], opened = [];
    const kit = load([grabConst('DL_MAX_BYTES'), grabConst('DL_ZIP_TOO_BIG'), grab('humanSize'), grab('filesZip')], ['filesZip', 'DL_ZIP_TOO_BIG'], {
      filesState: { path: 'out', root: { label: 'Bob' } }, filesUrl, filesApi: ok(bytes), filesMsg() {},
      openDownloadSheet: (o) => sheets.push(o), window: { open: (...a) => opened.push(a) }, location: { assign: (...a) => opened.push(a) },
      document: { createElement: () => { const a = {}; anchors.push(a); return a; }, body: { appendChild() {} } },
    });
    return { kit, sheets, anchors, opened };
  };
  const small = mk(4096); await small.kit.filesZip('out/reports');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(small.sheets)), [{ url: '/api/files/zip?agent=bob&path=out%2Freports', name: 'reports.zip', size: 4096, mime: 'application/zip', approx: true }]);
  assert.ok(!small.sheets[0].url.includes('check=1'));
  const edge = mk(100 * 1024 * 1024); await edge.kit.filesZip('out/reports');
  assert.strictEqual(edge.sheets[0].approx, true, 'exactly 100 MiB is still allowed');
  assert.ok(!edge.sheets[0].blocked);
  const big = mk(100 * 1024 * 1024 + 1); await big.kit.filesZip('out/reports');
  assert.strictEqual(big.kit.DL_ZIP_TOO_BIG, 'This folder is larger than 100 MB. Download it as a zip on a computer.');
  assert.strictEqual(big.sheets.length, 1);
  assert.strictEqual(big.sheets[0].blocked, big.kit.DL_ZIP_TOO_BIG, 'the too-big line goes on the sheet\'s message line');
  for (const m of [small, edge, big]) assert.deepStrictEqual([m.anchors.length, m.opened.length], [0, 0], 'no anchor, no window, no navigation to the zip URL');
  assert.doesNotMatch(grab('filesZip'), /createElement|\.click\(\)|window\.open|location/, 'filesZip never navigates');
  assert.doesNotMatch(js, /\.href = url; a\.download = `\$\{folder\}\.zip`/);
  // the sheet itself: "about N" for an approximate size, the blocked line, and no Save / Share while blocked
  const o = grab('openDownloadSheet');
  assert.match(o, /dlState\.approx \? 'about ' : ''/);
  assert.match(o, /if \(dlState\.blocked\) \{ dlSay\(dlState\.blocked, 'err'\); dlGoPaint\(\); \}/);
  assert.match(grab('dlGoPaint'), /b\.disabled = !!dlState\.busy \|\| !!dlState\.blocked/);
  assert.match(grab('dlStart'), /if \(dlState\.busy \|\| dlState\.blocked\) return;/);
});

test('a card\'s Download button opens the sheet; sw.js needs no change (its SHELL lists no other /ui-*.js file)', () => {
  assert.match(js, /closest\('button\.fc-download'\)[\s\S]{0,200}openDownloadSheet\(\{ url: b\.dataset\.download, name: b\.dataset\.name,/);
  assert.match(read('sw.js'), /const SHELL = \['\/mobile\.html', '\/mobile\.js'\];/);
  assert.doesNotMatch(read('sw.js'), /'\/ui-[a-z-]+\.js'/, 'no /ui-*.js asset is precached');
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v106';/, 'VERSION moved with the password eye (mobile.html and mobile.js changed); the shell list did not');
});

test('nothing added here carries an emoji variation selector (U+FE0F)', () => {
  const added = ['dlStatusMessage', 'dlReadFile', 'openDownloadSheet', 'dlStart', 'dlTapSave', 'filesLoadRecent', 'filesZip', 'attachFileCards', 'dlFileType'].map(grab).join('');
  assert.ok(!added.includes('\uFE0F'));
  const cssStart = html.indexOf('/* Recent from agents, and the zip buttons */');
  const cssEnd = html.indexOf('/* Recall sheet');
  assert.ok(cssStart > 0 && cssEnd > cssStart && !html.slice(cssStart, cssEnd).includes('\uFE0F'));
});

// Recent: only the newest 3, then a link-styled "Show all (N)" that expands in place and is remembered for the session.
function recentKit(n, storage) {
  const box = { hidden: true, innerHTML: '', onclick: null };
  const files = Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, size: 10, folder: 'out', mtime: new Date().toISOString(), download: `/api/files/download?path=f${i}` }));
  const kit = load([grab('humanSize'), grab('filesAgo'), grab('filesLoadRecent')], ['filesLoadRecent'], {
    $: () => box, filesState: { agent: 'bob', recent: [] }, filesApi: async () => ({ files }), filesUrl: () => '/x', esc: (s) => String(s),
    ...(storage ? { sessionStorage: storage } : {}),
  });
  const rows = () => (box.innerHTML.match(/class="fr-row"/g) || []).length;
  const press = () => box.onclick({ target: { closest: (sel) => (sel === 'button.fr-all' && /class="fr-all"/.test(box.innerHTML) ? {} : null) } });
  return { box, kit, rows, press };
}
const memStore = (init = {}) => { const d = { ...init }; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; };

test('Recent: with 10 files the phone draws 3 rows and a "Show all (10)" button (a real button, aria-expanded=false)', async () => {
  const { box, kit, rows } = recentKit(10, memStore());
  await kit.filesLoadRecent();
  assert.strictEqual(rows(), 3);
  assert.match(box.innerHTML, /<button type="button" class="fr-all" aria-expanded="false">Show all \(10\)<\/button>/);
  assert.match(box.innerHTML, /f0\.txt/); assert.doesNotMatch(box.innerHTML, /f3\.txt/);
});

test('Recent: pressing "Show all" draws all 10 in place, drops the button and stores 1 in sessionStorage', async () => {
  const st = memStore();
  const { box, kit, rows, press } = recentKit(10, st);
  await kit.filesLoadRecent();
  press();
  assert.strictEqual(rows(), 10);
  assert.doesNotMatch(box.innerHTML, /fr-all/);
  assert.strictEqual(st.d['hub-files-recent-all'], '1');
});

test('Recent: with the stored choice all 10 are drawn and there is no button; 3 files never show one', async () => {
  const a = recentKit(10, memStore({ 'hub-files-recent-all': '1' }));
  await a.kit.filesLoadRecent();
  assert.strictEqual(a.rows(), 10);
  assert.doesNotMatch(a.box.innerHTML, /fr-all/);
  const b = recentKit(4, memStore());
  await b.kit.filesLoadRecent();
  assert.strictEqual(b.rows(), 3);
  assert.match(b.box.innerHTML, /Show all \(4\)/);
  const c = recentKit(3, memStore());
  await c.kit.filesLoadRecent();
  assert.strictEqual(c.rows(), 3);
  assert.doesNotMatch(c.box.innerHTML, /fr-all/);
});

test('Recent: sessionStorage that throws (or is missing) still works, the choice just is not remembered', async () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  for (const storage of [bad, null]) {
    const { box, kit, rows, press } = recentKit(10, storage);
    await kit.filesLoadRecent();
    assert.strictEqual(rows(), 3);
    assert.match(box.innerHTML, /Show all \(10\)/);
    press();
    assert.strictEqual(rows(), 10);
    assert.doesNotMatch(box.innerHTML, /fr-all/);
  }
});
