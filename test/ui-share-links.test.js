'use strict';
// Share links in the Files panel (desktop app.js, phone mobile.js) and the Settings block. Offline: the shared block and the
// page hooks are cut out of the page source and run with stubs. Names in here are made up.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const mjs = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
const cut = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, from); const b = src.indexOf(to, a + from.length); assert.ok(b > a, to); return src.slice(a, b); };
const block = (src) => cut(src, '// ── share links (begin)', '// ── share links (end) ──').split('\n').map(l => (src === app ? l.replace(/^ {4}/, '') : l)).join('\n');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SETTINGS = { enabled: true, defaultHours: 24, maxHours: 168, choices: [1, 24, 168] };

// The shared block, with fetch / navigator / location stubbed per run.
function load(env = {}) {
  const calls = [];
  const fetch = env.fetch || (async () => ({ ok: true, json: async () => ({}) }));
  const wrapped = async (url, init) => { calls.push({ url, init }); return fetch(url, init); };
  const timers = [];
  const names = ['escapeHtml', 'fetch', 'navigator', 'location', 'document', 'setTimeout', 'clearTimeout'];
  const vals = [escapeHtml, wrapped, env.navigator || { clipboard: { writeText: async () => {} } }, { origin: 'https://hub.example' }, env.document || { execCommand: () => true },
    (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, () => {}];
  const api = new Function(...names, `${block(env.src || app)}
    return { shareLinkWhen, shareLinksState, shareLinkLabel, shareLinkDefaultHours, shareLinksLoad, shareLinksOn, shareLinkRequest, shareLinkFormHtml, shareLinkResultHtml, shareLinkCopy, shareLinkWire, shareLinksListHtml, shareRevokeClick, shareLinksListFill, shareSettingsHtml, shareSettingsSave, shareSettingsMount };`)(...vals);
  return { api, calls, timers };
}
// A tiny stand-in for an element tree: querySelector gives the same fake for a selector.
function fakeRoot() {
  const els = {};
  return { els, querySelector(s) { return els[s] || (els[s] = { textContent: '', innerHTML: '', value: '', checked: false, disabled: false, dataset: {}, focus() {}, select() {}, remove() {}, closest() { return null; } }); } };
}

test('both pages carry the same shared block between the share links markers', () => {
  // app.js is indented 4 more; template text may differ in white space only
  const flat = (t) => t.split('\n').map(l => l.trim()).join('\n');
  assert.strictEqual(flat(block(app)), flat(block(mjs)));
  assert.ok(block(app).includes('async function shareLinksJson('));
});

test('labels and default: 1 hour, 24 hours, 7 days, N hours; default = the server default when offered, else the largest choice below it', () => {
  const { api } = load();
  assert.deepStrictEqual([1, 24, 168, 72].map(api.shareLinkLabel), ['1 hour', '24 hours', '7 days', '72 hours']);
  assert.strictEqual(api.shareLinkDefaultHours(SETTINGS), 24);
  assert.strictEqual(api.shareLinkDefaultHours({ defaultHours: 72, choices: [1, 24] }), 24);
  const html = api.shareLinkFormHtml('notes.txt', SETTINGS);
  assert.match(html, /<option value="24" selected>24 hours<\/option>/);
  assert.match(html, /<option value="168">7 days<\/option>/);
  for (const s of ['Link works for', 'Only one download', 'Create link', 'notes.txt']) assert.ok(html.includes(s), s);
});

test('settings load once: the action needs enabled; a failed call or enabled:false hides it', async () => {
  let { api } = load({ fetch: async () => ({ ok: true, json: async () => ({ links: [], settings: SETTINGS }) }) });
  await api.shareLinksLoad(); assert.strictEqual(api.shareLinksOn(), true);
  ({ api } = load({ fetch: async () => ({ ok: true, json: async () => ({ links: [], settings: { ...SETTINGS, enabled: false } }) }) }));
  await api.shareLinksLoad(); assert.strictEqual(api.shareLinksOn(), false);
  ({ api } = load({ fetch: async () => { throw new Error('down'); } }));
  await api.shareLinksLoad(); assert.strictEqual(api.shareLinksOn(), false);
  ({ api } = load({ fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: 'No.' }) }) }));
  await api.shareLinksLoad(); assert.strictEqual(api.shareLinksOn(), false);
});

// ── the row action ──
function rowsDesktop(on) {
  const src = cut(app, 'function filesRenderList()', 'async function filesCopy(');
  const list = { innerHTML: '', className: '' };
  const state = { path: 'docs', entries: [{ name: 'a.txt', type: 'file', size: 5 }, { name: 'sub', type: 'dir' }] };
  new Function('document', 'filesState', 'humanSize', 'filesJoin', 'esc', 'shareLinksOn', `${src}; filesRenderList();`)({ getElementById: () => list }, state, String, (d, n) => `${d}/${n}`, escapeHtml, () => on);
  return list.innerHTML.split('<tr data-i=').slice(1);
}
function rowsPhone(on) {
  const src = cut(mjs, 'function filesRenderList()', 'async function onFilesListClick(');
  const list = { innerHTML: '' };
  const state = { path: '', openRow: -1, entries: [{ name: 'a.txt', type: 'file', size: 5 }, { name: 'sub', type: 'dir' }] };
  const out = [];
  for (const i of [0, 1]) { state.openRow = i; new Function('$', 'filesState', 'humanSize', 'esc', 'shareLinksOn', `${src}; filesRenderList();`)(() => list, state, String, escapeHtml, () => on); out.push(list.innerHTML); }
  return out;
}
test('desktop: Share link only on files, only when enabled', () => {
  const [dir, file] = rowsDesktop(true);   // folders sort first
  assert.ok(file.includes('a.txt') && file.includes('onclick="shareLinkOpen(1)">Share link</button>'));
  assert.ok(!dir.includes('Share link'));
  assert.ok(rowsDesktop(false).every(r => !r.includes('Share link')));
});
test('phone: Share link only on files, only when enabled', () => {
  const [file, dir] = rowsPhone(true);
  assert.ok(file.includes('data-act="share">Share link</button>'));
  assert.ok(!dir.includes('Share link'));
  assert.ok(rowsPhone(false).every(r => !r.includes('Share link')));
  assert.match(mjs, /if \(act === 'share'\) return shareLinkOpen\(entry, rel\);/);
});

// ── creating a link ──
// Runs the page's own shareLinkOpen (and, on the desktop, its filesOwnerBody) with stubs, then presses Create.
async function create(page, c) {
  const lo = load({ fetch: async () => ({ ok: true, json: async () => ({ id: 'L1', path: '/s/abc_DEF-123', expiresAt: '2026-11-18T10:00:00.000Z', oneTime: true, name: 'a.txt', size: 5 }) }) });
  lo.api.shareLinksState.settings = SETTINGS;
  const r = fakeRoot();
  const st = { path: 'docs', agent: c.agent, entries: [{ name: 'a.txt', type: 'file' }] };
  const wire = (rt, o) => lo.api.shareLinkWire(rt, o);
  if (page === 'desktop') {
    const src = cut(app, 'function shareLinkOpen(i)', 'function shareLinksListOpen()') + cut(app, 'function filesOwnerBody()', 'function humanSize(');
    new Function('filesState', 'shareLinksOn', 'shareLinksState', 'shareOverlay', 'shareLinkFormHtml', 'shareLinkWire', 'filesJoin', 'dialogRequestClose', 'window', 'ownerView', `${src}; shareLinkOpen(0);`)(
      st, () => true, lo.api.shareLinksState, () => r, () => '', wire, (d, n) => (d ? `${d}/${n}` : n), () => {}, { hubMe: c.me }, () => c.view);
  } else {
    const src = cut(mjs, 'function shareLinkOpen(entry, rel)', 'function shareLinksListOpen()') + cut(mjs, 'function filesOwner()', 'function filesUrl(');
    new Function('shareLinksOn', 'shareLinksState', 'shareDialog', 'shareLinkFormHtml', 'shareLinkWire', 'filesState', 'dialogRequestClose', 'hubMe', 'ownerView', 'entry', 'rel', `${src}; shareLinkOpen(entry, rel);`)(
      () => true, lo.api.shareLinksState, () => r, () => '', wire, st, () => {}, c.me, () => c.view, { name: 'a.txt', type: 'file' }, 'docs/a.txt');
  }
  r.els['.sl-hours'] = { value: '168' }; r.els['.sl-once'] = { checked: true }; r.els['.sl-url'] = { value: '', select() {} };
  await r.querySelector('.sl-create').onclick();
  const post = lo.calls.find(x => x.url === '/api/share-links' && x.init && x.init.method === 'POST');
  return { lo, r, body: JSON.parse(post.init.body) };
}
for (const page of ['desktop', 'phone']) {
  test(`${page}: the request carries the panel's folder identity, path, hours and oneTime`, async () => {
    assert.deepStrictEqual((await create(page, { me: { isAdmin: true }, view: 'u-2', agent: 'scout' })).body, { owner: 'u-2', agent: 'scout', path: 'docs/a.txt', hours: 168, oneTime: true });
    assert.deepStrictEqual((await create(page, { me: { isAdmin: false }, view: 'u-2', agent: '' })).body, { path: 'docs/a.txt', hours: 168, oneTime: true });
    assert.strictEqual((await create(page, { me: { isAdmin: true }, view: 'infra', agent: '' })).body.owner, 'mine');
  });
}
test('the link shown is location.origin + path, with expiry, the sign-in line, Copy and Done', async () => {
  const { api } = load();
  const html = api.shareLinkResultHtml({ path: '/s/abc_DEF-123', expiresAt: '2026-11-18T10:00:00.000Z' }, 'https://hub.example');
  assert.match(html, /readonly[^>]*value="https:\/\/hub\.example\/s\/abc_DEF-123"/);
  assert.match(html, /Expires [^<]*2026/);
  assert.ok(html.includes("Opens for you when you're signed in to your Maestro.") && html.includes('>Copy<') && html.includes('>Done<'));
  const { r } = await create('desktop', { me: { isAdmin: false }, view: 'mine', agent: '' });
  assert.ok(r.els['.sl-body'].innerHTML.includes('value="https://hub.example/s/abc_DEF-123"'));
});
test('an error shows the server text in the dialog and re-enables Create', async () => {
  const lo = load({ fetch: async () => ({ ok: false, status: 429, json: async () => ({ error: 'Too many links this hour.' }) }) });
  const rr = fakeRoot();
  lo.api.shareLinkWire(rr, { identity: {}, path: 'a', close() {} });
  rr.els['.sl-hours'] = { value: '1' }; rr.els['.sl-once'] = { checked: false };
  await rr.querySelector('.sl-create').onclick();
  assert.strictEqual(rr.els['.sl-msg'].textContent, 'Too many links this hour.');
  assert.strictEqual(rr.els['.sl-create'].disabled, false);
});
test('Copy writes to the clipboard; without one it selects the text and tries the older copy', async () => {
  let wrote = null;
  let lo = load({ navigator: { clipboard: { writeText: async (t) => { wrote = t; } } } });
  const btn = { textContent: 'Copy' };
  assert.strictEqual(await lo.api.shareLinkCopy('https://hub.example/s/x', btn, {}), true);
  assert.strictEqual(wrote, 'https://hub.example/s/x'); assert.strictEqual(btn.textContent, 'Copied');
  let selected = 0, copied = 0;
  lo = load({ navigator: {}, document: { execCommand: (c) => { copied++; return c === 'copy'; } } });
  const input = { focus() {}, select() { selected++; } };
  assert.strictEqual(await lo.api.shareLinkCopy('t', { textContent: 'Copy' }, input), true);
  assert.ok(selected >= 1 && copied === 1);
  lo = load({ navigator: {}, document: { execCommand: () => false } });
  const b2 = { textContent: 'Copy' };
  assert.strictEqual(await lo.api.shareLinkCopy('t', b2, input), false);
  assert.strictEqual(b2.textContent, 'Select and copy');
});

// ── the list ──
const EVIL = '<img src=x onerror=alert(1)>';
test('the list shows name, expiry, one download, downloads, the creator for admins; escapes every value', () => {
  const { api } = load();
  const links = [
    { id: 'a1', name: EVIL, expiresAt: '2026-11-18T10:00:00Z', oneTime: true, downloads: 0, creator: { id: 'u1', name: 'Ann' }, mine: true },
    { id: 'b"2', name: 'b.txt', expiresAt: '2026-11-19T10:00:00Z', oneTime: false, downloads: 1, creator: { id: 'u2', name: '<b>Bo</b>' }, mine: false },
  ];
  const html = api.shareLinksListHtml(links, true);
  assert.ok(!html.includes('<img') && html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('<b>Bo') && html.includes('by &lt;b&gt;Bo&lt;/b&gt;'));
  assert.ok(html.includes('one download') && html.includes('0 downloads') && html.includes('1 download'));
  assert.ok(html.includes('data-id="b&quot;2"') && (html.match(/>Revoke</g) || []).length === 2 && html.includes('expires '));
  assert.ok(!api.shareLinksListHtml(links, false).includes('by '), 'members do not see creators');
  assert.strictEqual(api.shareLinksListHtml([], true), 'No shared links.');
});
test('Revoke needs two presses within 3 s; the first only turns the button into "Revoke?"', () => {
  const { api, timers } = load();
  const btn = { dataset: { id: 'a1' }, textContent: 'Revoke' };
  const revoked = [];
  api.shareRevokeClick(btn, (id) => revoked.push(id));
  assert.strictEqual(btn.textContent, 'Revoke?'); assert.deepStrictEqual(revoked, []); assert.strictEqual(timers[0].ms, 3000);
  timers[0].fn(); assert.strictEqual(btn.textContent, 'Revoke'); assert.strictEqual(btn.dataset.armed, '');
  api.shareRevokeClick(btn, (id) => revoked.push(id)); assert.deepStrictEqual(revoked, []);
  api.shareRevokeClick(btn, (id) => revoked.push(id)); assert.deepStrictEqual(revoked, ['a1']);
});
test('the list dialog posts the revoke on the second press and removes the row, then says "No shared links."', async () => {
  const lo = load({ fetch: async (url) => ({ ok: true, json: async () => (url === '/api/share-links' ? { links: [{ id: 'a1', name: 'a', expiresAt: '2026-11-18T10:00:00Z', downloads: 0, mine: true, creator: { name: 'Ann' } }], settings: SETTINGS } : { ok: true }) }) });
  const row = { removed: false, remove() { this.removed = true; } };
  const box = { textContent: '', innerHTML: '', querySelector: () => (row.removed ? null : row) };
  const root = { querySelector: (s) => (s === '.sl-list' ? box : { textContent: '' }) };
  await lo.api.shareLinksListFill(root, false);
  assert.match(box.innerHTML, /data-sl-revoke/);
  const btn = { dataset: { id: 'a1' }, textContent: 'Revoke', closest: (s) => (s === '.sl-row' ? row : btn), disabled: false };
  box.onclick({ target: btn });
  assert.ok(!lo.calls.some(c => /revoke/.test(c.url)), 'the first press revokes nothing');
  box.onclick({ target: btn });
  await new Promise(r => setImmediate(r));
  assert.ok(lo.calls.some(c => c.url === '/api/share-links/a1/revoke' && c.init.method === 'POST'));
  assert.ok(row.removed); assert.strictEqual(box.textContent, 'No shared links.');
});

// ── Settings ──
test('Settings block posts shareLinks { enabled, defaultHours, maxHours }; admins only', async () => {
  const lo = load();
  const html = lo.api.shareSettingsHtml();
  for (const s of ['Allow share links', 'Default time', 'Longest allowed', 'Shared links']) assert.ok(html.includes(s), s);
  const els = { '.sl-set-on': { checked: true }, '.sl-set-def': { value: '24' }, '.sl-set-max': { value: '72' }, '.sl-set-msg': { textContent: '' } };
  await lo.api.shareSettingsSave({ querySelector: (s) => els[s] });
  const post = lo.calls.find(c => c.url === '/api/settings');
  assert.deepStrictEqual(JSON.parse(post.init.body), { shareLinks: { enabled: true, defaultHours: 24, maxHours: 72 } });
  assert.strictEqual(els['.sl-set-msg'].textContent, 'Saved.');
  assert.match(app, /id="st-security-section" data-no-dirty>[\s\S]*?id="st-share-block"[^\n]*\$\{shareSettingsHtml\(\)\}/);
  assert.match(app, /shareSettingsMount\(document\.getElementById\('st-share-block'\), shareLinksListOpen\)/);
  assert.match(mjs, /hubMe && hubMe\.isAdmin \? `<div class="sec-section" id="sec-share" data-no-dirty>\$\{shareSettingsHtml\(\)\}/);
  assert.match(mjs, /shareSettingsMount\(\$\('sec-share'\), shareLinksListOpen\)/);
});
test('desktop and phone both have the row action, the Shared links entry and the load on open', () => {
  assert.ok(app.includes('onclick="shareLinkOpen(${i})">Share link</button>') && app.includes('id="files-shared-btn" onclick="shareLinksListOpen()"') && app.includes('      shareLinksInit();\n      await filesRefresh();'));
  assert.ok(mjs.includes('<button id="fs-shared" hidden>Shared links</button>') && mjs.includes("$('fs-shared').addEventListener('click', shareLinksListOpen)") && mjs.includes('  if (!wasOpen) shareLinksInit();'));
  assert.ok(app.includes('function shareLinksListOpen()') && mjs.includes('function shareLinksListOpen()'));
});

// ── review follow-ups ──
test('the phone Security share block and both Share link forms opt out of the discard guard', () => {
  assert.match(mjs, /id="sec-share" data-no-dirty>/);
  assert.match(app, /id="st-security-section" data-no-dirty>/);
  const { api } = load();
  assert.match(api.shareLinkFormHtml('a.txt', SETTINGS), /^<div class="sec-section" data-no-dirty>/);
  assert.match(api.shareLinkResultHtml({ path: '/s/x', expiresAt: '2026-11-18T10:00:00Z' }, 'https://hub.example'), /^<div class="sec-section" data-no-dirty>/);
});

test('default hours: the largest choice not above the stored default, else the smallest', () => {
  for (const src of [app, mjs]) {
    const { api } = load({ src });
    assert.strictEqual(api.shareLinkDefaultHours({ defaultHours: 72, choices: [1, 24, 168] }), 24);
    assert.strictEqual(api.shareLinkDefaultHours({ defaultHours: 24, choices: [1, 24, 168] }), 24);
    assert.strictEqual(api.shareLinkDefaultHours({ defaultHours: 0.5, choices: [24, 1, 168] }), 1);
    assert.strictEqual(api.shareLinkDefaultHours({ defaultHours: 500, choices: [1, 24, 168] }), 168);
    assert.match(api.shareLinkFormHtml('a', { defaultHours: 72, choices: [1, 24, 168] }), /<option value="24" selected>/);
  }
});

// A root with the selects, like the real one: the value is whatever was set last.
function settingsRoot() {
  const mk = () => ({ innerHTML: '', value: '', onchange: null });
  const els = { '.sl-set-on': { checked: false, onchange: null }, '.sl-set-def': mk(), '.sl-set-max': mk(), '.sl-set-list': {}, '.sl-set-msg': { textContent: '' } };
  return { els, style: { display: 'flex' }, querySelector: (s) => els[s] };
}
const optValues = (el) => [...el.innerHTML.matchAll(/value="(\d+)"/g)].map(m => Number(m[1]));
test('Settings: a stored maxHours or defaultHours that is not listed is added as an option and kept', async () => {
  for (const src of [app, mjs]) {
    const lo = load({ src, fetch: async () => ({ ok: true, json: async () => ({ links: [], settings: { enabled: true, defaultHours: 72, maxHours: 100, choices: [1, 24] } }) }) });
    const root = settingsRoot();
    await lo.api.shareSettingsMount(root, () => {});
    assert.deepStrictEqual(optValues(root.els['.sl-set-max']), [1, 24, 72, 100, 168]);
    assert.strictEqual(root.els['.sl-set-max'].value, '100');
    assert.deepStrictEqual(optValues(root.els['.sl-set-def']), [1, 24, 72]);
    assert.strictEqual(root.els['.sl-set-def'].value, '72');
    assert.ok(root.els['.sl-set-max'].innerHTML.includes('>72 hours<') && root.els['.sl-set-max'].innerHTML.includes('>100 hours<'));
    // listed values stay as they were
    const lo2 = load({ src, fetch: async () => ({ ok: true, json: async () => ({ links: [], settings: { enabled: true, defaultHours: 24, maxHours: 72, choices: [1, 24] } }) }) });
    const r2 = settingsRoot(); await lo2.api.shareSettingsMount(r2, () => {});
    assert.deepStrictEqual(optValues(r2.els['.sl-set-max']), [1, 24, 72, 168]);
    assert.deepStrictEqual(optValues(r2.els['.sl-set-def']), [1, 24]); assert.strictEqual(r2.els['.sl-set-def'].value, '24');
    // lowering the longest time below an odd default drops it from the list
    const r3 = settingsRoot(); await lo.api.shareSettingsMount(r3, () => {});
    r3.els['.sl-set-max'].value = '24'; r3.els['.sl-set-max'].onchange();
    assert.deepStrictEqual(optValues(r3.els['.sl-set-def']), [1, 24]); assert.strictEqual(r3.els['.sl-set-def'].value, '24');
  }
});

test('Settings block is hidden with style.display (an inline display:flex beats hidden) and shown again as it was', async () => {
  for (const src of [app, mjs]) {
    let ok = false;
    const lo = load({ src, fetch: async () => (ok ? { ok: true, json: async () => ({ links: [], settings: SETTINGS }) } : { ok: false, status: 500, json: async () => ({}) }) });
    const root = settingsRoot();
    await lo.api.shareSettingsMount(root, () => {});
    assert.strictEqual(root.style.display, 'none'); assert.ok(!root.hidden);
    await lo.api.shareSettingsMount(root, () => {});   // still failing: stays hidden and remembers the original
    ok = true;
    await lo.api.shareSettingsMount(root, () => {});
    assert.strictEqual(root.style.display, 'flex');
  }
  assert.match(app, /id="st-share-block" style="display:flex/);
});

// ── phone: the settings load once per sheet opening ──
test('phone: openFilesSheet loads the share settings only when the sheet goes from closed to open', () => {
  const src = cut(mjs, 'function openFilesSheet(path)', '\n}\n') + '\n}';
  let inits = 0, refreshes = 0;
  const sheet = { open: false, dataset: { ready: '1' }, showModal() { this.open = true; } };
  const open = new Function('$', 'filesState', 'shareLinksInit', 'filesRefresh', `${src}; return openFilesSheet;`)(
    (id) => (id === 'files-sheet' ? sheet : { classList: { remove() {} } }), { path: '', openRow: 0 }, () => { inits++; }, () => { refreshes++; });
  open(); open('docs'); open('docs/sub');
  assert.deepStrictEqual([inits, refreshes], [1, 3], 'one settings load, a refresh per tap');
  sheet.open = false; open();
  assert.strictEqual(inits, 2, 'a new opening loads again');
});
test('phone: a failed refresh keeps the settings already loaded; a first failure leaves them null', async () => {
  const src = cut(mjs, 'function shareLinksInit()', '\n}\n') + '\n}';
  const run = async (settings, fail) => {
    const state = { settings }, btn = { hidden: true };
    const load_ = async () => { if (fail) { state.settings = null; return null; } state.settings = SETTINGS; return { settings: SETTINGS }; };
    new Function('shareLinksState', 'shareLinksLoad', '$', 'filesState', `${src}; shareLinksInit();`)(state, load_, () => btn, { entries: [] });
    await new Promise(x => setImmediate(x));
    return { state, btn };
  };
  let r = await run(SETTINGS, true);
  assert.strictEqual(r.state.settings, SETTINGS); assert.strictEqual(r.btn.hidden, false);
  r = await run(null, true);
  assert.strictEqual(r.state.settings, null); assert.strictEqual(r.btn.hidden, true);
  r = await run(null, false);
  assert.strictEqual(r.state.settings, SETTINGS);
});

test('expiry reads like the link page on both pages ("Nov 18, 2026, 5:32 AM EST"): no seconds, a zone name', () => {
  const like = /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s?[AP]M \S+$/;
  for (const src of [app, mjs]) {
    const { api } = load({ src });
    for (const t of ['2026-11-18T10:32:10.000Z', Date.UTC(2026, 0, 2, 3, 4, 59)]) {
      const s = api.shareLinkWhen(t);
      assert.match(s, like, s);
      assert.ok(!/:\d{2}:\d{2}/.test(s), 'no seconds: ' + s);
    }
    assert.strictEqual(api.shareLinkWhen('not a date'), 'not a date');
    assert.strictEqual(api.shareLinkWhen(undefined), '');
  }
});
