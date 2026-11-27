'use strict';
// agent-settings.html is a small redirect page (P4-2): old links (notices, bookmarks) are sent on to the agent card or to Settings.
// Its inline script runs in node's vm against stubs for location, fetch and the screen. Offline.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'agent-settings.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
const RECORDS = JSON.parse(fs.readFileSync(path.join(root, 'templates/settings-records.json'), 'utf8'));
const LIST = Array.isArray(RECORDS) ? RECORDS : RECORDS.records;

const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

/** Run the page for a URL ('?agent=hazel', '#rec=OPT-0048'). opts: phone, referrer, keepDesktop, records (a list or 'fail'). */
async function run(search, hash, opts = {}) {
  const replaced = [];
  const msg = { children: [], _t: '', set textContent(v) { this._t = v; this.children = []; }, get textContent() { return this._t + this.children.map((c) => c.textContent || c.text || '').join(''); }, appendChild(c) { this.children.push(c); } };
  const document = {
    referrer: opts.referrer || '',
    getElementById: (id) => (id === 'msg' ? msg : null),
    createTextNode: (text) => ({ text }),
    createElement: () => ({ attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, textContent: '' }),
  };
  const fetched = [];
  const window = {
    location: { search, hash, replace: (u) => replaced.push(u) },
    localStorage: { getItem: (k) => (k === 'hub-keep-desktop' && opts.keepDesktop ? '1' : null) },
    screen: opts.phone ? { width: 390, height: 844 } : { width: 1920, height: 1080 },
    matchMedia: (q) => ({ matches: opts.phone ? /coarse/.test(q) : /fine/.test(q) }),
    navigator: { maxTouchPoints: opts.phone ? 5 : 0 },
  };
  const fetch = async (url) => {
    fetched.push(url);
    if (opts.records === 'fail') throw new Error('offline');
    return { ok: true, json: async () => ({ records: opts.records || LIST }) };
  };
  const ctx = vm.createContext({ window, document, fetch, URLSearchParams, encodeURIComponent, setTimeout, clearTimeout });
  vm.runInContext(script, ctx);
  await tick();
  return { replaced, fetched, msg, last: replaced[replaced.length - 1] };
}

test('the page is small and keeps no old settings code', () => {
  assert.ok(page.split('\n').length < 150, 'lines: ' + page.split('\n').length);
  assert.doesNotMatch(page, /saveAgentVoice|saveLockbox|loadModels|apiFetch/);
});

test('a model offer notice link (#rec=OPT-0048, homed on the card) opens the card at that row', async () => {
  const r = await run('?agent=hazel', '#rec=OPT-0048');
  assert.deepStrictEqual(r.replaced, ['/#agent-card=hazel&row=OPT-0048']);
  assert.deepStrictEqual(r.fetched, ['/api/settings-records']);
  assert.match(r.msg.textContent, /Opening hazel/);
});

test('the box link (#rec=OPT-0053) opens the card at that row', async () => {
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-0053')).replaced, ['/#agent-card=hazel&row=OPT-0053']);
});

test('a record homed in Settings (OPT-0014) goes to Settings at that record, not to the card', async () => {
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-0014')).replaced, ['/#settings-for=OPT-0014']);
});

test('no hash, or a section word, opens the card; nothing is fetched', async () => {
  const r = await run('?agent=hazel', '');
  assert.deepStrictEqual(r.replaced, ['/#agent-card=hazel']);
  assert.strictEqual(r.fetched.length, 0);
  assert.deepStrictEqual((await run('?agent=hazel', '#voice')).replaced, ['/#agent-card=hazel']);
});

test('no agent name or a bad one goes to the app, with no fetch and no injected text', async () => {
  for (const q of ['', '?agent=', '?agent=' + encodeURIComponent('a b'), '?agent=' + encodeURIComponent('<script>x</script>'), '?agent=' + 'a'.repeat(65), '?agent=' + encodeURIComponent('../x')]) {
    const r = await run(q, '#rec=OPT-0048');
    assert.deepStrictEqual(r.replaced, ['/'], q);
    assert.strictEqual(r.fetched.length, 0);
  }
});

test('a malformed record id is ignored (the card at the agent)', async () => {
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-12;x')).replaced, ['/#agent-card=hazel']);
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=%3Cb%3E')).replaced, ['/#agent-card=hazel']);
});

test('if the records can not be read the card is the guess, with the row', async () => {
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-0014', { records: 'fail' })).replaced, ['/#agent-card=hazel&row=OPT-0014']);
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-9999', { records: [] })).replaced, ['/#agent-card=hazel&row=OPT-9999']);
});

test('a phone (small touch screen, or arriving from the phone page) goes to /mobile', async () => {
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-0048', { phone: true })).replaced, ['/mobile#agent-card=hazel&row=OPT-0048']);
  assert.deepStrictEqual((await run('?agent=hazel', '#rec=OPT-0014', { phone: true })).replaced, ['/mobile#settings-for=OPT-0014']);
  assert.deepStrictEqual((await run('?agent=hazel', '', { phone: true })).replaced, ['/mobile#agent-card=hazel']);
  assert.deepStrictEqual((await run('', '', { phone: true })).replaced, ['/mobile']);
  assert.deepStrictEqual((await run('?agent=hazel', '', { referrer: 'https://hub.example/mobile' })).replaced, ['/mobile#agent-card=hazel']);
  assert.deepStrictEqual((await run('?agent=hazel', '', { phone: true, keepDesktop: true })).replaced, ['/#agent-card=hazel'], 'the person chose the full site');
});

test('the page says where it is going and links to it; it replaces the location once', async () => {
  const r = await run('?agent=hazel', '#rec=OPT-0048');
  assert.strictEqual(r.replaced.length, 1);
  const link = r.msg.children.find((c) => c.attrs && c.attrs.href);
  assert.strictEqual(link.attrs.href, r.last);
  assert.match(r.msg.textContent, /Opening hazel.s settings/);
});

test('the server still serves the page under both names', () => {
  const access = fs.readFileSync(path.join(root, 'lib/access.js'), 'utf8');
  assert.match(access, /\/agent-settings\.html/);
  assert.match(fs.readFileSync(path.join(root, 'lib/static-files.js'), 'utf8'), /agent-settings/);
});
