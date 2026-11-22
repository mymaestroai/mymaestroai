'use strict';
// Settings small fixes (app.js): every Settings save goes through stSaveFetch (a time limit on the request and its
// answer); the main Save stops asking a hub that did not answer; OpenRouter ticks not saved yet survive a new Find;
// the Web search section's markup lets "Browser rendering" and the Jina switch each have their own row. The page code is
// lifted out of app.js and run against a small fake DOM and stand-in servers (the ui-dialog.test.js pattern).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ui = require('../lib/ui-dialog');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const at = (s, x, from = 0) => { const i = s.indexOf(x, from); assert.ok(i >= 0, `${x} found in app.js`); return i; };
const SAVE_FETCH = app.slice(at(app, '    // ── save fetch (begin) ──'), at(app, '    // ── save fetch (end) ──'));
assert.ok(SAVE_FETCH.includes('const ST_SAVE_TIMEOUT_MS = 30000;'), 'the limit is 30000 in app.js');
const FAST = SAVE_FETCH.replace('const ST_SAVE_TIMEOUT_MS = 30000;', 'const ST_SAVE_TIMEOUT_MS = 50;');
assert.notStrictEqual(FAST, SAVE_FETCH);
const TIMEOUT_TEXT = 'your Maestro did not answer within 30 seconds. Try again';

// ── A small DOM (the one of ui-dialog.test.js, with bare attributes such as checked / hidden, and the old children
// detached when innerHTML is written, as a page does) ──
function matchesSimple(el, sel) {
  sel = sel.trim();
  const nots = [];
  sel = sel.replace(/:not\(([^)]*)\)/g, (_, x) => { nots.push(x); return ''; });
  const m = sel.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!m) return false;
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  for (const part of (m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || [])) {
    if (part[0] === '.') { if (!el.classList.contains(part.slice(1))) return false; }
    else if (part[0] === '#') { if (el.getAttribute('id') !== part.slice(1)) return false; }
    else {
      const a = part.slice(1, -1).match(/^([\w-]+)(?:="([^"]*)")?$/);
      if (!el.hasAttribute(a[1])) return false;
      if (a[2] !== undefined && el.getAttribute(a[1]) !== a[2]) return false;
    }
  }
  return nots.every(n => !matchesSimple(el, n));
}
const splitSel = (s) => s.split(',').map(x => x.trim()).filter(Boolean);

function makeDom() {
  const doc = { listeners: { capture: {}, bubble: {} }, activeElement: null };
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase(); this.children = []; this.parent = null; this.attrs = {}; this.listeners = {};
      this.value = ''; this.checked = false; this.open = false; this.hidden = false;
      const self = this;
      this.dataset = new Proxy({}, {
        get: (_, k) => self.attrs['data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase())],
        set: (_, k, v) => { self.attrs['data-' + String(k).replace(/[A-Z]/g, c => '-' + c.toLowerCase())] = String(v); return true; },
      });
      this.classList = { contains: (c) => (self.attrs.class || '').split(/\s+/).includes(c), add: (c) => { if (!self.classList.contains(c)) self.attrs.class = ((self.attrs.class || '') + ' ' + c).trim(); } };
    }
    get type() { return this.attrs.type || (this.tagName === 'INPUT' ? 'text' : ''); }
    set type(v) { this.attrs.type = v; }
    get name() { return this.attrs.name || ''; }
    get id() { return this.attrs.id || ''; }
    set id(v) { this.attrs.id = String(v); }
    set className(v) { this.attrs.class = v; }
    get isConnected() { let n = this; while (n) { if (n === doc.body || n === doc.head) return true; n = n.parent; } return false; }
    get firstElementChild() { return this.children[0] || null; }
    getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    hasAttribute(k) { return this.attrs[k] !== undefined; }
    appendChild(c) { if (c.parent) c.remove(); c.parent = this; this.children.push(c); return c; }
    remove() { if (!this.parent) return; this.parent.children = this.parent.children.filter(x => x !== this); this.parent = null; }
    contains(n) { while (n) { if (n === this) return true; n = n.parent; } return false; }
    matches(sel) { return splitSel(sel).some(s => (s === ':modal' ? !!this.modal : matchesSimple(this, s))); }
    closest(sel) { let n = this; while (n && n.tagName) { if (n.matches(sel)) return n; n = n.parent; } return null; }
    querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    getClientRects() { return this.hidden ? [] : [1]; }
    getBoundingClientRect() { return { left: 100, right: 300, top: 100, bottom: 300 }; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    focus() { doc.activeElement = this; dispatch(this, 'focusin', {}); }
    setSelectionRange() {}
    showModal() { this.open = true; this.modal = true; }
    show() { this.open = true; this.modal = false; }
    close() { this.open = false; this.modal = false; }
    set textContent(v) { this._text = String(v); this.children = []; }
    get textContent() { return this._text || ''; }
    get innerHTML() { return this._html || ''; }
    set innerHTML(html) {
      for (const c of this.children) c.parent = null;
      this.children = [];
      this._html = String(html);
      const stack = [this];
      for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
        if (m[1]) { stack.pop(); continue; }
        const e = new El(m[2]);
        for (const a of m[3].matchAll(/([\w-]+)="([^"]*)"/g)) e.attrs[a[1]] = a[2];
        for (const a of m[3].replace(/"[^"]*"/g, '""').matchAll(/(?:^|\s)([\w-]+)(?=\s|\/|$)/g)) if (e.attrs[a[1]] === undefined) e.attrs[a[1]] = '';   // bare attributes
        if (e.attrs.value !== undefined) e.value = e.attrs.value;
        if (e.attrs.checked !== undefined) e.checked = true;
        if (e.attrs.hidden !== undefined) e.hidden = true;
        stack[stack.length - 1].appendChild(e);
        if (!['input', 'br'].includes(m[2])) stack.push(e);
      }
    }
  }
  function dispatch(target, type, init = {}) {
    const ev = { type, target, defaultPrevented: false, stopped: false, immediate: false, ...init,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, stopImmediatePropagation() { this.stopped = true; this.immediate = true; } };
    for (const fn of doc.listeners.capture[type] || []) { fn(ev); if (ev.immediate) return ev; }
    let n = target;
    while (n && !ev.stopped) { for (const fn of (n.listeners && n.listeners[type]) || []) { fn(ev); if (ev.immediate) break; } n = n.parent; }
    if (!ev.stopped) for (const fn of doc.listeners.bubble[type] || []) { fn(ev); if (ev.immediate) break; }
    return ev;
  }
  doc.body = new El('body'); doc.head = new El('head');
  doc.createElement = (t) => new El(t);
  doc.getElementById = (id) => { const f = (n) => { for (const c of n.children) { if (c.getAttribute('id') === id) return c; const r = f(c); if (r) return r; } return null; }; return f(doc.head) || f(doc.body); };
  doc.addEventListener = (t, fn, capture) => { const k = capture ? 'capture' : 'bubble'; (doc.listeners[k][t] = doc.listeners[k][t] || []).push(fn); };
  doc.querySelectorAll = (sel) => doc.body.querySelectorAll(sel);
  doc.activeElement = doc.body;
  const win = { location: { href: 'http://hub.test/' }, addEventListener() {}, history: { state: null, pushState() {}, back() {} }, fetch: null };
  const el = (tag, attrs = {}, parent = doc.body) => { const e = new El(tag); Object.assign(e.attrs, attrs); parent.appendChild(e); return e; };
  const typeInto = (f, v) => { dispatch(f, 'pointerdown'); f.focus(); dispatch(f, 'keydown', { key: 'x' }); f.value = v; dispatch(f, 'input'); };
  // a user ticking / unticking a box
  const click = (f, on) => { dispatch(f, 'pointerdown'); f.checked = on; dispatch(f, 'change'); };
  return { doc, win, el, dispatch, typeInto, click, El };
}

// A fetch answer as the page sees it: the body is read as text.
const answerOf = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
// A request that never ends by itself, but fails with an AbortError when its signal aborts.
const hangs = (init) => new Promise((_, rej) => {
  init.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
});

// ── 1. stSaveFetch ──
function makeSaveFetch(fetch) {
  return new Function('fetch', `${FAST}\nreturn { stSaveFetch, ST_SAVE_TIMEOUT_TEXT };`)(fetch);
}
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

test('stSaveFetch: a request that never answers is aborted and rejects with the timeout text', async () => {
  let signal = null;
  const { stSaveFetch, ST_SAVE_TIMEOUT_TEXT } = makeSaveFetch((url, init) => { signal = init.signal; return hangs(init); });
  assert.strictEqual(ST_SAVE_TIMEOUT_TEXT, TIMEOUT_TEXT);
  const t0 = Date.now();
  await assert.rejects(() => stSaveFetch('/api/settings', { method: 'POST', body: '{}' }), { message: TIMEOUT_TEXT });
  assert.ok(Date.now() - t0 < 1000, 'it did not wait for the hub');
  assert.ok(signal && signal.aborted, 'the request was aborted');
});

test('stSaveFetch: a fetch that ignores the abort and answers late: the timeout still wins, the late answer is never used', async () => {
  unhandled.length = 0;
  let answeredAt = 0;
  const { stSaveFetch } = makeSaveFetch(async () => { await sleep(120); answeredAt = Date.now(); return answerOf({ ok: true }); });
  const t0 = Date.now();
  let used = false;
  await assert.rejects(() => stSaveFetch('/api/settings', {}).then((r) => { used = true; return r; }), { message: TIMEOUT_TEXT });
  const took = Date.now() - t0;
  assert.ok(took < 110, `rejected at about the limit, not at the late answer (took ${took} ms)`);
  await sleep(200);
  assert.ok(answeredAt > 0, 'the stub did answer, late');
  assert.strictEqual(used, false, 'the late answer was not used');
  assert.deepStrictEqual(unhandled, [], 'no unhandled rejection');
});

test('stSaveFetch: a normal answer comes back as { ok, status, json() } with the parsed body', async () => {
  const seen = [];
  const { stSaveFetch } = makeSaveFetch(async (url, init) => { seen.push({ url, method: init.method, body: init.body, signal: !!init.signal }); return answerOf({ ok: true, n: 3 }); });
  const r = await stSaveFetch('/api/settings', { method: 'POST', body: '{"a":1}' });
  assert.strictEqual(r.ok, true); assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await r.json(), { ok: true, n: 3 });
  assert.deepStrictEqual(seen, [{ url: '/api/settings', method: 'POST', body: '{"a":1}', signal: true }]);
  const bad = await makeSaveFetch(async () => answerOf({ error: 'nope' }, 400)).stSaveFetch('/x', {});
  assert.strictEqual(bad.ok, false); assert.strictEqual(bad.status, 400);
  assert.deepStrictEqual(await bad.json(), { error: 'nope' });
  await sleep(80);   // no timer left over fires a late abort or rejection
  assert.deepStrictEqual(unhandled, []);
});

test('stSaveFetch: an answer whose body never finishes times out too', async () => {
  const { stSaveFetch } = makeSaveFetch(async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }));
  await assert.rejects(() => stSaveFetch('/api/settings', {}), { message: TIMEOUT_TEXT });
});

// ── 2. The main Save with a hub that does not answer ──
function mainSavePage({ answer }) {
  const a = at(app, '    // ── save fetch (begin) ──'), b = at(app, '    // A ChatGPT subscription runs');
  const c = at(app, '    async function saveWebSearch('), e = at(app, '    async function tryWebSearch(');
  const d = makeDom();
  const guard = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ov = d.el('div', { id: 'st-overlay' });
  const box = d.el('div', {}, ov);
  const f = {};
  for (const id of ['st-ws-key-brave', 'st-ws-key-serper', 'st-ws-key-tavily', 'st-ws-order', 'st-ws-searxng', 'st-wf-private', 'st-wf-render', 'st-hw-minutes', 'st-cap-agent', 'st-cap-hub']) f[id] = d.el('input', { id }, box);
  f['st-wf-jina'] = d.el('input', { id: 'st-wf-jina', type: 'checkbox' }, box);
  f['st-ws-state'] = d.el('div', { id: 'st-ws-state' }, box);
  f['st-saved'] = d.el('div', { id: 'st-saved' }, box);
  f['st-hw-minutes'].value = '5';
  const button = d.el('button', {}, ov);
  const fetchLog = [], alerts = [];
  const fetch = async (url, init) => {
    fetchLog.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return answer(url, init);
  };
  const document = Object.create(d.doc);
  document.querySelectorAll = (sel) => (sel.includes('^=') || sel.includes(' .') ? [] : d.doc.querySelectorAll(sel));
  const calls = { spend: 0 };
  const src = `${app.slice(a, b).replace('const ST_SAVE_TIMEOUT_MS = 30000;', 'const ST_SAVE_TIMEOUT_MS = 50;')}\n${app.slice(c, e)}\nreturn { saveSettings, saveWebSearch };`;
  const api = new Function('document', 'fetch', 'dialogGuard', 'PROVIDERS', 'workersAtOnceFromPage', 'loadWebSearchStatus', 'alert', 'setTimeout', 'hlFieldEls', 'scFieldEls',
    'saveClassifier', 'saveMemberPolicy', 'saveSandboxDefaults', 'saveLockboxDefault', 'savePlanWarn', 'saveSpendCaps', 'saveCredit', 'saveHealthSettings', 'saveSelfCheckSettings', src)(
    document, fetch, guard, [], () => undefined, () => {}, (m) => alerts.push(m), (fn, ms) => (ms === 2000 ? 0 : setTimeout(fn, ms)), () => [], () => [],
    async () => true, async () => true, async () => true, async () => true, async () => true, async () => { calls.spend++; return true; }, async () => true, async () => true, async () => true);
  guard.open(ov);
  return { d, guard, ov, f, fetchLog, alerts, api, calls, button };
}

test('main Save: a hub that does not answer the web search save: one alert, the rest not tried, nothing lost, the dialog usable again', async () => {
  let silent = true;
  const p = mainSavePage({ answer: (url, init) => (url === '/api/websearch/config' && silent ? hangs(init) : Promise.resolve(answerOf({ ok: true }))) });
  p.d.typeInto(p.f['st-ws-key-brave'], 'brave-test-1');
  p.d.typeInto(p.f['st-cap-agent'], '5');
  await p.api.saveSettings();
  assert.strictEqual(p.alerts.length, 1, 'one alert');
  assert.ok(p.alerts[0].includes('Web search and fetch: ' + TIMEOUT_TEXT), p.alerts[0]);
  assert.ok(p.alerts[0].includes('Spend caps: not tried, because your Maestro did not answer'), p.alerts[0]);
  assert.strictEqual(p.calls.spend, 0, 'the next section was not asked');
  assert.strictEqual(p.f['st-ws-key-brave'].value, 'brave-test-1', 'the typed key stays');
  assert.strictEqual(p.guard.changed(p.f['st-ws-key-brave']), true, 'and still counts as changed');
  assert.strictEqual(p.guard.isDirty(p.ov), true, 'Close would still ask');
  assert.ok(!p.ov.inert, 'the dialog takes typing again');
  assert.ok(!p.button.disabled, 'its buttons are back');
  // A second press, the hub answers now.
  silent = false;
  await p.api.saveSettings();
  assert.strictEqual(p.alerts.length, 1, 'no new alert');
  assert.strictEqual(p.f['st-ws-key-brave'].value, '');
  assert.strictEqual(p.f['st-ws-key-brave'].placeholder, 'set');
  assert.strictEqual(p.guard.changed(p.f['st-ws-key-brave']), false);
  assert.strictEqual(p.calls.spend, 1, 'the spend caps went in the second press');
});

// ── 3. OpenRouter ticks not saved yet ──
function orPage() {
  const a = at(app, '    let orView = null;'), b = at(app, '    async function saveQuestionAfter(');
  const d = makeDom();
  const guard = ui.createDialogGuard({ doc: d.doc, win: d.win });
  const ov = d.el('div', { id: 'st-overlay' });
  const box = d.el('div', {}, ov);
  const body = d.el('div', { id: 'st-or-body' }, box);
  guard.open(ov);
  const posts = [], toasts = [];
  let reply = null, getReply = null;
  const fetch = async (url, init) => {
    if (!init || !init.body) return getReply(url);   // the list (GET): { ok, status, json() }
    posts.push({ url, body: JSON.parse(init.body) });
    return reply(JSON.parse(init.body), url);
  };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const src = `${FAST}\nlet __modelListCache = null;\n${app.slice(a, b)}\nreturn { renderOpenRouterBox, saveOpenRouter, loadOpenRouterBox, setView: (v) => { orView = v; } };`;
  const api = new Function('document', 'fetch', 'dialogGuard', 'esc', 'hubToast', 'stSum', src)(d.doc, fetch, guard, esc, (m) => toasts.push(m), () => {});
  const models = [{ id: 'vendor/a', name: 'A', tools: true, created: 3 }, { id: 'vendor/b', name: 'B', tools: true, created: 2 }, { id: 'other/c', name: 'C', tools: true, created: 1 }];
  api.setView({ hasKey: true, chosen: ['vendor/a'], custom: true, models });
  api.renderOpenRouterBox({ fresh: true });
  const pick = (id) => d.doc.querySelectorAll('.st-or-pick').find(x => x.value === id);
  const hiddenRows = () => d.doc.querySelectorAll('.or-row').filter(r => r.hidden);
  const setFind = (v) => { d.doc.getElementById('st-or-q').value = v; api.renderOpenRouterBox(); };   // what the Find input does
  return { d, guard, ov, body, posts, toasts, api, models, pick, hiddenRows, setFind, setReply: (fn) => { reply = (b, u) => { const r = fn(b, u); return r && typeof r.then === 'function' ? r.then(answerOf) : answerOf(r); }; }, setGetReply: (fn) => { getReply = fn; } };
}

test('OpenRouter: a tick a new Find hides stays as a hidden row, counts as a change, and goes in the Save with the visible ones', async () => {
  const p = orPage();
  assert.strictEqual(p.pick('vendor/a').checked, true);
  assert.strictEqual(p.pick('vendor/b').checked, false);
  p.d.click(p.pick('vendor/b'), true);
  p.setFind('other');
  const hb = p.pick('vendor/b');
  assert.ok(hb, 'vendor/b is still on the page');
  assert.strictEqual(hb.parent.hidden, true, 'in a hidden row');
  assert.strictEqual(hb.checked, true, 'still ticked');
  assert.strictEqual(p.hiddenRows().length, 1, 'only the change is kept, not the saved ticks');
  assert.ok(p.body.innerHTML.includes('1 change not saved yet'), 'the Offered line counts it');
  assert.strictEqual(p.guard.isDirty(p.ov), true, 'Close would ask');
  p.d.click(p.pick('other/c'), true);
  p.setFind('other');   // a further render keeps both
  assert.ok(p.body.innerHTML.includes('2 changes not saved yet'));
  p.setReply((posted) => ({ ok: true, chosen: posted.models, models: p.models }));
  const done = await p.api.saveOpenRouter(true);
  assert.strictEqual(done, true);
  assert.strictEqual(p.posts.length, 1);
  assert.strictEqual(p.posts[0].url, '/api/openrouter');
  assert.deepStrictEqual([...p.posts[0].body.models].sort(), ['other/c', 'vendor/a', 'vendor/b']);
  assert.strictEqual(p.hiddenRows().length, 0, 'after the answer the box is drawn fresh: no hidden rows');
  assert.ok(!p.body.innerHTML.includes('not saved yet'));
  assert.strictEqual(p.guard.isDirty(p.ov), false, 'the dialog is clean');
  assert.strictEqual(p.pick('other/c').checked, true);
});

test('OpenRouter: a saved tick unticked and then hidden by a Find is not in the posted models', async () => {
  const p = orPage();
  p.d.click(p.pick('vendor/a'), false);
  p.setFind('other');
  assert.strictEqual(p.pick('vendor/a').checked, false, 'the hidden row holds the unticked state');
  assert.strictEqual(p.guard.isDirty(p.ov), true);
  assert.ok(p.body.innerHTML.includes('1 change not saved yet'));
  p.setReply((posted) => ({ ok: true, chosen: posted.models, models: p.models }));
  assert.strictEqual(await p.api.saveOpenRouter(true), true);
  assert.ok(!p.posts[0].body.models.includes('vendor/a'), 'vendor/a is left out');
  assert.strictEqual(p.guard.isDirty(p.ov), false);
});

test('OpenRouter: an unticked and re-ticked box is no change; Refresh (a render, not a fresh one) keeps ticks', () => {
  const p = orPage();
  p.d.click(p.pick('vendor/b'), true);
  p.d.click(p.pick('vendor/b'), false);
  p.api.renderOpenRouterBox();
  assert.ok(!p.body.innerHTML.includes('not saved yet'));
  p.d.click(p.pick('vendor/b'), true);
  p.api.renderOpenRouterBox({});   // Refresh the list
  assert.strictEqual(p.pick('vendor/b').checked, true);
  assert.ok(p.body.innerHTML.includes('1 change not saved yet'));
  p.api.renderOpenRouterBox({ fresh: true });   // Settings opened again
  assert.strictEqual(p.pick('vendor/b').checked, false);
  assert.ok(!p.body.innerHTML.includes('not saved yet'));
});

// ── 4. The Web search section's markup ──
test('Web search section: Browser rendering has its own row, the Jina switch another, and the selects can shrink', () => {
  const a = at(app, '<div class="st-section" id="st-ws-section">');
  const sec = app.slice(a, at(app, 'id="st-ws-status"', a));
  const rows = sec.split('<div class="st-row"').slice(1);
  const rowOf = (needle) => { const r = rows.filter(x => x.includes(needle)); assert.strictEqual(r.length, 1, `${needle} is in exactly one row`); return r[0]; };
  const render = rowOf("selWs('st-wf-render'");
  assert.ok(/<label[^>]*>Browser rendering<\/label>/.test(render), 'Browser rendering is the label of its row');
  assert.ok(!render.includes("selWs('st-wf-private'") && !render.includes('id="st-wf-jina"'), 'the render row holds only the render select');
  const jina = rowOf('id="st-wf-jina"');
  const priv = rowOf("selWs('st-wf-private'");
  assert.notStrictEqual(jina, priv, 'Jina is not in the private addresses row');
  assert.notStrictEqual(jina, render, 'Jina is not in the render row');
  assert.ok(!jina.includes('st-wf-private') && !jina.includes('st-wf-render'));
  const selWs = app.match(/const selWs = \(id, opts, cur\) => `<select id="\$\{id\}" style="([^"]*)"/);
  assert.ok(selWs, 'selWs found');
  assert.ok(/(^|;)min-width:0(;|$)/.test(selWs[1]) && /(^|;)max-width:100%(;|$)/.test(selWs[1]), selWs[1]);
});

test('Web search section: the SearXNG row wraps its buttons and its field can shrink; the fetch row\'s render switch takes only its own width', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const line = (needle) => { const l = app.split('\n').filter(x => x.includes(needle)); assert.strictEqual(l.length, 1, needle); return l[0]; };
  const sx = line('id="st-ws-searxng"');
  assert.match(sx, /<div class="st-row" style="flex-wrap:wrap;row-gap:6px">/);
  assert.match(sx, /id="st-ws-searxng"[^>]*style="flex:1 1 180px;min-width:0;max-width:260px"/);
  const tf = line('id="st-wf-try"');
  assert.match(tf, /id="st-wf-try"[^>]*style="flex:1;min-width:0"/);
  assert.match(tf, /<label style="flex:0 0 auto;display:flex;gap:4px;align-items:center"><input type="checkbox" id="st-wf-try-render">/);
});

// ── review r1 ──
test('OpenRouter: a failed Refresh keeps the list and the ticks not saved yet; the error goes to a toast', async () => {
  const p = orPage();
  p.pick('vendor/b').checked = true; p.d.fire && p.d.fire(p.pick('vendor/b'), 'change');
  p.setFind('vendor'); p.setFind('');
  p.setGetReply(async () => ({ ok: false, status: 502, json: async () => ({}) }));
  await p.api.loadOpenRouterBox(true);
  assert.ok(p.pick('vendor/b'), 'the rows are still there');
  assert.strictEqual(p.pick('vendor/b').checked, true, 'the tick is kept');
  assert.ok(p.body.innerHTML.includes('1 change not saved yet'));
  assert.strictEqual(p.guard.isDirty(p.ov), true, 'Close would still ask');
  assert.ok(p.toasts.some(t => /Could not load the OpenRouter list: HTTP 502/.test(t)), p.toasts.join(' | '));
});

test('OpenRouter: Refresh after someone else changed the offer is not an edit of this person; their own ticks stay', async () => {
  const p = orPage();
  p.pick('other/c').checked = true; p.setFind('');   // this person ticks other/c
  // Meanwhile the saved offer gained vendor/b elsewhere; Refresh brings it.
  p.setGetReply(async () => ({ ok: true, status: 200, json: async () => ({ hasKey: true, custom: true, chosen: ['vendor/a', 'vendor/b'], models: p.models }) }));
  await p.api.loadOpenRouterBox(true);
  assert.strictEqual(p.pick('vendor/b').checked, true, 'vendor/b shows as saved, ticked');
  assert.strictEqual(p.pick('other/c').checked, true, 'their own tick is kept');
  assert.ok(p.body.innerHTML.includes('1 change not saved yet'), 'only their own change counts');
  p.setReply((b) => ({ ok: true, chosen: b.models, custom: true, hasKey: true, models: p.models }));
  await p.api.saveOpenRouter(true);
  assert.deepStrictEqual([...p.posts[0].body.models].sort(), ['other/c', 'vendor/a', 'vendor/b'], 'vendor/b is not removed');
});

test('OpenRouter: a tick made while "Save the ticked models" is waiting stays ticked and unsaved after the answer', async () => {
  const p = orPage();
  let release;
  p.setReply((b) => new Promise(r => { release = () => r({ ok: true, chosen: b.models, custom: true, hasKey: true, models: p.models }); }));
  p.pick('vendor/b').checked = true;
  const saving = p.api.saveOpenRouter(true);
  await new Promise(r => setImmediate(r));
  p.pick('other/c').checked = true;   // ticked while the save waits
  release();
  assert.strictEqual(await saving, true);
  assert.deepStrictEqual([...p.posts[0].body.models].sort(), ['vendor/a', 'vendor/b']);
  assert.strictEqual(p.pick('vendor/b').checked, true, 'saved');
  assert.strictEqual(p.pick('other/c').checked, true, 'the newer tick is kept');
  assert.ok(p.body.innerHTML.includes('1 change not saved yet'));
  assert.strictEqual(p.guard.isDirty(p.ov), true, 'and Close would ask');
});

test('main Save: does not start while a Settings save is still reading its answer (after the headers)', async () => {
  let finish;
  const p = mainSavePage({ answer: (url) => (url === '/api/websearch/config'
    ? Promise.resolve({ ok: true, status: 200, text: () => new Promise(r => { finish = () => r(JSON.stringify({ ok: true })); }) })
    : Promise.resolve(answerOf({ ok: true }))) });
  p.d.typeInto(p.f['st-ws-key-brave'], 'brave-test-1');
  const own = p.api.saveWebSearch();   // the section's own button; its answer body is still arriving
  await new Promise(r => setImmediate(r));
  await p.api.saveSettings();
  assert.deepStrictEqual(p.fetchLog.map(x => x.url), ['/api/websearch/config'], 'the main Save sent nothing');
  assert.deepStrictEqual(p.alerts, ['A save in Settings is still running. Press Save again when it is done.']);
  finish(); await own;
  await p.api.saveSettings();
  assert.ok(p.fetchLog.some(x => x.url === '/api/settings'), 'the next press saves');
});
