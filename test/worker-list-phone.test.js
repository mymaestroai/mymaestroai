'use strict';
// The phone's worker list (mobile.js): workers seen live are tracked with the time they ended; a failure watched as it
// happens counts as seen; a reply that ends settles its running workers with an end time (so they leave the list);
// a slower "Open full run" never takes the screen from a later one; a worker opened again is painted again and a long
// live answer keeps updating; stopped is not failed; history opened afresh loads afresh. The page code runs here
// against stand-ins (a small element model stands in for the page).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const shared = { ...require('../lib/ui-worker-list'), ...require('../lib/ui-busy-workers') };

function extract(name, kind = 'function') {
  let at = kind === 'const' ? src.indexOf(`const ${name} =`) : src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  if (kind === 'const') return src.slice(at, src.indexOf('\n', at));
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

function phone() {
  const env = { refreshes: 0, shown: [], pending: [], inferred: [] };
  const body = `const { workerListPick } = shared;
    let current = 'maestro', wkTimer = null, wkView = null;
    const wkSeen = new Map();
    const wkRefreshSoon = () => { env.refreshes++; };
    const wkHist = { openSeq: 0, runs: new Map(), runReq: new Map(), gen: 0 };
    const wkFetchRun = (w) => new Promise((resolve) => env.pending.push({ w, resolve }));
    const wkShow = (view) => { wkView = view; wkHist.openSeq++; env.shown.push(view); };
    const $ = () => null;
    const wkInferEnd = (e, delay) => { env.inferred.push([e && e.id, delay]); };
    ${extract('wkState', 'const')}
    ${extract('wkTrack')}
    ${extract('wkPick')}
    ${extract('feedEnd')}
    ${extract('wkOpenRun')}
    const paintFeed = () => {};
    return { wkSeen, wkTrack, wkPick, feedEnd, wkOpenRun, wkState, setView: (v) => { wkView = v; }, hist: wkHist };`;
  return { env, api: new Function('shared', 'env', body)(shared, env) };
}

test('workers seen live are listed; a failure watched as it happens is seen; a reply ending settles its workers', () => {
  const { api, env } = phone();
  const holder = { agent: 'maestro', feed: { items: new Map() } };
  const it = (id, status, extra = {}) => ({ kind: 'worker', workerId: id, status, t0: Date.now() - 5000, t1: status === 'running' ? null : Date.now() - 1000, ...extra });
  const a = it('a', 'running'), b = it('b', 'running');
  holder.feed.items.set('w:a', a); holder.feed.items.set('w:b', b);
  api.wkTrack(holder, a); api.wkTrack(holder, b);
  assert.deepStrictEqual(api.wkPick().counts, { running: 2, done: 0, failed: 0 });
  // b fails while the person has it open: seen, so the chip does not turn red
  api.setView({ mode: 'worker', id: 'b' });
  b.status = 'failed'; b.t1 = Date.now();
  api.wkTrack(holder, b);
  assert.strictEqual(api.wkSeen.get('b').failSeen, true);
  api.setView(null);
  const r = api.wkPick();
  assert.deepStrictEqual([r.alert, r.gone], [false, ['b']], 'opened and left: it goes');
  // the reply ends with a still running: it is over, with an end time (so it leaves after its 2 minutes), shown as
  // "ended" until the hub says how it ended
  api.feedEnd(holder);
  assert.strictEqual(a.status, 'completed');
  assert.strictEqual(api.wkState(a), 'ended');
  assert.deepStrictEqual(env.inferred, [['a', 1500]]);
  assert.ok(a.t1 > 0);
  a.t1 = Date.now() - 3 * 60000;
  api.wkSeen.get('a').endSeen = null;
  assert.deepStrictEqual(api.wkPick().gone, ['a', 'b']);
});

test('a slower "Open full run" on the phone never takes the screen from a later one or from where the person went', async () => {
  const { api, env } = phone();
  const openA = api.wkOpenRun({ caller: 'maestro', workerId: 'A' });
  const openB = api.wkOpenRun({ caller: 'maestro', workerId: 'B' });
  env.pending[1].resolve({ rows: [], worker: { workerId: 'B' } }); await openB;
  env.pending[0].resolve({ rows: [], worker: { workerId: 'A' } }); await openA;
  assert.deepStrictEqual(env.shown.map(v => v.w.workerId), ['B']);
  const openC = api.wkOpenRun({ caller: 'maestro', workerId: 'C' });
  api.hist.openSeq++;   // the person went elsewhere (wkShow and wkClose do this)
  env.pending[2].resolve({ rows: [], worker: { workerId: 'C' } }); await openC;
  assert.deepStrictEqual(env.shown.map(v => v.w.workerId), ['B']);
});

function has(name) { return src.includes(`function ${name}(`); }

// A small element model: enough of the DOM for the sheet's painting code.
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.dataset = {}; this.className = ''; this.id = ''; this.text = ''; this.attrs = {}; this.listeners = {}; this.scrollTop = 0; this.clientHeight = 100; this.parent = null; this.doc = null; }
  get classList() {
    const el = this, set = () => new Set(el.className.split(/\s+/).filter(Boolean));
    return {
      contains: (c) => set().has(c),
      toggle: (c, on) => { const s = set(); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); el.className = [...s].join(' '); },
      add: (c) => { const s = set(); s.add(c); el.className = [...s].join(' '); },
      remove: (c) => { const s = set(); s.delete(c); el.className = [...s].join(' '); },
    };
  }
  get scrollHeight() { return Math.max(this.clientHeight, this.children.length * 50); }
  set textContent(v) { for (const c of this.children) c.parent = null; this.children = []; this.text = String(v); }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { this.textContent = v; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { for (const c of cs) this.appendChild(c); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  click() { for (const f of this.listeners.click || []) f({ target: this, detail: 0, stopPropagation() {}, preventDefault() {} }); }
  focus() { this.doc.activeElement = this; }
  contains(x) { for (let n = x; n; n = n.parent) if (n === this) return true; return false; }
  matches(sel) { return sel.startsWith('.') ? this.classList.contains(sel.slice(1)) : this.tagName === sel.toUpperCase(); }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  querySelectorAll(sel) { const out = []; const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

function sheet() {
  const env = { now: Date.now(), loads: [], toasts: [], busy: new Set(), byId: {}, timers: [], asked: [], records: {}, streams: new Map() };
  // GET /api/agents/<caller>/workers/<id>: env.records[id] = a worker entry; 'down' (no answer), 'e500' (a server
  // error), 'html404' (a 404 that is not the route's); absent = the route's own 404 (no record)
  env.json = async (url, opts) => {
    env.asked.push(url);
    const id = decodeURIComponent(url.split('/').pop());
    let r = env.records[id];
    if (Array.isArray(r)) r = r.length > 1 ? r.shift() : r[0];   // one answer per ask
    if (r === 'hang') return new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('The operation timed out.'))));
    if (r === 'down') throw new TypeError('Failed to fetch');
    if (r === 'e500') return { ok: false, status: 500, json: async () => ({ error: 'database is locked' }) };
    if (r === 'html404') return { ok: false, status: 404, json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (r === undefined) return { ok: false, status: 404, json: async () => ({ error: 'no such worker in that agent\'s history' }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, worker: r, rows: [] }) };
  };
  env.flush = async () => { while (env.timers.length) await env.timers.shift()(); };
  const doc = { activeElement: null, createElement: (t) => { const e = new El(t); e.doc = doc; return e; } };
  env.document = doc;
  const mk = (cls, tag = 'div') => { const e = doc.createElement(tag); e.className = cls; return e; };
  const sh = mk('rsn-sheet wk-sheet');
  const head = mk('rsn-sheet-head');
  head.append(mk('wk-back', 'button'), mk('rsn-sheet-title', 'span'), mk('rsn-sheet-count', 'span'), mk('rsn-sheet-close', 'button'));
  const body = mk('wk-body');
  sh.append(head, body);
  const btn = mk('', 'button');
  btn.appendChild(mk('wb-label', 'span'));
  env.byId = { 'wk-sheet': sh, 'chat-workers-btn': btn };
  env.cancel = async () => ({ status: 200, json: async () => ({ success: true }) });
  env.api = (url, opts) => (String(url).includes('/workers/') ? env.json(url, opts) : env.cancel(url, opts));
  env.aborts = [];
  const code = `const { workerListPick, workerButtonLabel, fmtWorkerClock, hubWorkerGroups, hubWorkerCount, fmtElapsedShort } = shared;
    const document = env.document, Date = { now: () => env.now, parse: (s) => globalThis.Date.parse(s) };
    const $ = (id) => env.byId[id] || null;
    let current = 'maestro', wkTimer = null, wkView = null, statusKnown = true;
    const live = {}, agents = [{ name: 'maestro' }, { name: 'counsel' }];
    const isBusy = (n) => env.busy.has(n), isAdmin = () => true, agentByName = (n) => agents.find(a => a.name === n) || null;
    const displayName = (n) => String(n || '').replace(/^./, c => c.toUpperCase()), shortModel = (m) => m, clipText = (t, n) => String(t).slice(0, n);
    const formatContent = (t) => t, renderVisualBlocks = () => {}, toast = (m) => env.toasts.push(m), paintFeed = () => {}, holderFeed = (h) => h.feed;
    const wkSheet = () => env.byId['wk-sheet'], wkPaintRun = () => {}, wkHistoryRender = () => {}, wkLoad = (reset) => { env.loads.push(reset); };
    const wkRefreshSoon = () => {}, wkName = (it) => it.description || 'Worker', api = (...a) => env.api(...a);
    const setTimeout = (fn) => { env.timers.push(fn); return 0; };
    const streams = env.streams, placeOf = () => 0;
    const AbortSignal = { timeout: () => { const c = new AbortController(); env.aborts.push(c); return c.signal; } };
    const wkHist = { caller: null, q: '', filter: 'all', items: [], next: null, loading: false, open: new Set(), runs: new Map(), error: '', gen: 0, listReq: 0, openSeq: 0, runReq: new Map() };
    const wkSeen = new Map();
    ${extract('wkState', 'const')}
    ${extract('wkKind', 'const')}
    ${extract('wkEl', 'const')}
    ${['wkTrack', 'wkPick', 'wkHubGroups', 'wkRefresh', 'wkShow', 'wkPaintList', 'wkStop', 'wkPaintWorker', 'wkHistoryShow', 'feedWorkerText', 'feedEnd', 'feedUpsert'].map(n => extract(n)).join('\n')}
    ${src.includes('const WK_HOW =') ? extract('WK_HOW', 'const') : ''}
    ${has('wkSettleAgent') ? extract('wkSettleAgent') : 'const wkSettleAgent = undefined;'}
    ${has('wkInferEnd') ? extract('wkInferEnd') : 'const wkInferEnd = undefined;'}
    return { wkSeen, live, wkTrack, wkRefresh, wkShow, wkState, feedWorkerText, feedEnd, feedUpsert, wkStop, wkSettleAgent, hist: wkHist, view: () => wkView };`;
  const api = new Function('shared', 'env', code)(shared, env);
  api.doc = doc;
  return { env, api, body, doc };
}
const worker = (id, status, extra = {}) => ({ kind: 'worker', workerId: id, status, t0: Date.now() - 5000, t1: status === 'running' ? null : Date.now() - 1000, tools: [], text: '', agent: 'temporal', ...extra });

test('a worker opened again is painted again, and a live answer past the hub cap keeps updating', () => {
  const { api, body } = sheet();
  const holder = { agent: 'maestro', feed: { items: new Map(), byWorker: new Map() } };
  const a = worker('a', 'running', { text: 'x'.repeat(16000), description: 'Research' });
  holder.feed.byWorker.set('a', a);
  api.wkTrack(holder, a);
  api.wkShow({ mode: 'worker', id: 'a', back: { mode: 'list' } });
  assert.ok(body.querySelector('.wk-text'), 'painted the first time');
  api.wkShow({ mode: 'list' });
  assert.ok(body.querySelector('.wk-row'), 'the list is on screen');
  api.wkShow({ mode: 'worker', id: 'a', back: { mode: 'list' } });
  assert.ok(body.querySelector('.wk-text'), 'painted again, not blank');
  // the hub keeps the newest 16,000 characters: the length stops changing, the words do not; the keyboard stays on Stop
  body.querySelector('.wk-stop-one').focus();
  api.feedWorkerText(holder, 'a', 'y'.repeat(50), true);
  assert.strictEqual(a.text.length, 16000);
  assert.ok(body.querySelector('.wk-text').textContent.endsWith('y'.repeat(50)), 'the view shows the newest words');
  assert.ok(body.contains(api.doc.activeElement) && api.doc.activeElement.classList.contains('wk-stop-one'), 'focus kept on Stop');
});

test('stopped is not failed; a row from another chat says whose it is; the list keeps the keyboard where it was', () => {
  const { api, body, doc } = sheet();
  const b = worker('b', 'failed', { cancelled: true, description: 'Stopped one' });
  const c = worker('c', 'running', { description: 'Running one' });
  api.wkTrack({ agent: 'counsel' }, b);
  api.wkTrack({ agent: 'maestro' }, c);
  assert.strictEqual(api.wkState(b), 'stopped');
  api.wkShow({ mode: 'list' });
  const rows = body.querySelectorAll('.wk-row');
  const rowB = rows.find(r => r.dataset.wid === 'b');
  assert.match(rowB.textContent, /stopped \d+:\d\d ago/);
  assert.match(rowB.textContent, /for Counsel/);
  assert.doesNotMatch(rows.find(r => r.dataset.wid === 'c').textContent, /for Maestro/, 'the open chat is not named');
  rowB.focus();
  api.wkRefresh();
  assert.ok(body.contains(doc.activeElement), 'focus is on the repainted list');
  assert.strictEqual(doc.activeElement.dataset.wid, 'b');
});

test('workers running hub-wide that no card shows are listed under the agent that started them, and counted on the button', () => {
  const { api, body, env } = sheet();
  const since = new Date(env.now - 65000).toISOString();
  api.live['tw-counsel-1-ab12'] = { busy: true, busySince: since, worker: true, parent: 'counsel', label: 'Read the file', model: 'claude-sdk/claude-sonnet-5-5' };
  api.live['tw-counsel-2-cd34'] = { busy: true, busySince: since, worker: true, parent: 'counsel', label: 'Check the dates', model: 'claude-sdk/claude-sonnet-5-5' };
  api.live['tw-maestro-3-ef56'] = { busy: false, busySince: null, worker: true, parent: 'maestro', label: 'Done one', model: '' };
  const own = worker('tw-counsel-2-cd34', 'running', { description: 'Check the dates' });
  api.wkTrack({ agent: 'counsel' }, own);
  api.wkShow({ mode: 'list' });
  const hub = body.querySelectorAll('.wk-hub');
  assert.strictEqual(hub.length, 1, 'the worker this page shows as its own row is not listed twice; an idle one is not listed');
  assert.match(hub[0].textContent, /Read the file/);
  assert.match(hub[0].textContent, /1:05/);
  assert.match(hub[0].textContent, /temporary/);
  assert.ok(body.querySelectorAll('.wk-group').some(g => /Started by Counsel/.test(g.textContent)));
  assert.match(env.byId['chat-workers-btn'].textContent, /^2 working/);
});

test('a worker whose caller has finished never stays "working", and an end the page only inferred shows how it really ended', async () => {
  const { api, env } = sheet();
  const at = new Date(env.now - 60000).toISOString();
  const tick = (ms) => { env.now += ms; api.wkRefresh(); };
  // idle caller: asked after 12 s, not before; a recorded outcome wins, with its real end time
  const d = worker('d', 'running');
  api.wkTrack({ agent: 'maestro' }, d);
  env.busy.add('maestro');
  api.wkRefresh(); tick(60000);
  assert.strictEqual(env.timers.length, 0, 'not asked while its caller is busy');
  env.busy.delete('maestro');
  api.wkRefresh(); tick(5000);
  assert.strictEqual(env.timers.length, 0, 'a short pause is not an end');
  tick(8000);
  env.records.d = { workerId: 'd', outcome: 'failed', error: 'Gemini 402', startedAt: at, durationMs: 20000 };
  api.wkShow({ mode: 'worker', id: 'd', back: { mode: 'list' } });   // the person has it open as its failure is learned
  await env.flush();
  assert.deepStrictEqual([api.wkState(d), d.error, d.t1], ['failed', 'Gemini 402', Date.parse(at) + 20000], 'its real outcome and end time, not "done"');
  assert.strictEqual(api.wkSeen.get('d').failSeen, true, 'watched as it was learned: seen, the chip stays calm');
  api.wkShow({ mode: 'list' });
  // an idle caller alone never ends a worker without a recorded outcome: still running by its record, no record, a
  // server error, a 404 that is not the route's, no answer: all unchanged, asked again a minute later, however long
  const g = worker('g', 'running');
  api.wkTrack({ agent: 'maestro' }, g);
  for (const r of [{ workerId: 'g', outcome: null, startedAt: at }, undefined, 'e500', 'html404', 'down', { workerId: 'g', outcome: null, startedAt: at }]) {
    if (r === undefined) delete env.records.g; else env.records.g = r;
    env.asked.length = 0;
    tick(61000); tick(13000);
    await env.flush();
    assert.strictEqual(env.asked.length, 1, `asked once a minute (${JSON.stringify(r)})`);
    assert.strictEqual(api.wkState(g), 'running', `unchanged (${JSON.stringify(r)})`);
  }
  // a reply that ended (feedEnd): "ended" at once; a server error or no answer keeps it pending and it is asked again
  // a minute later, even after it left the list; then the record's outcome
  const holder = { agent: 'maestro', feed: { items: new Map(), byWorker: new Map() } };
  const h = api.feedUpsert(holder, { kind: 'worker', id: 'w:h', workerId: 'h', status: 'started', description: 'H' });
  api.feedEnd(holder);
  assert.strictEqual(api.wkState(h), 'ended', 'until the hub answers');
  env.records.h = 'e500';
  await env.flush();
  assert.strictEqual(api.wkState(h), 'ended');
  tick(150000);
  assert.ok(api.wkSeen.has('h'), 'kept while its end is being checked');
  env.records.h = { workerId: 'h', outcome: 'stopped', startedAt: at, durationMs: 4000 };
  await env.flush();
  assert.strictEqual(api.wkState(h), 'stopped');
  // a 404 that is not the route's (a page from something in front of the hub) is no answer either: asked again
  const h3 = api.feedUpsert(holder, { kind: 'worker', id: 'w:h3', workerId: 'h3', status: 'started', description: 'H3' });
  env.records.h3 = 'html404';
  api.feedEnd(holder);
  await env.flush();
  env.records.h3 = { workerId: 'h3', outcome: 'failed', error: 'x', startedAt: at, durationMs: 1000 };
  tick(61000);
  await env.flush();
  assert.strictEqual(api.wkState(h3), 'failed', "asked again after a 404 that was not the route's");
  // a reply that ended, and the hub keeps no record: ended (no success mark); the record says still running (the
  // stream dropped, the turn goes on): running again
  const k = api.feedUpsert(holder, { kind: 'worker', id: 'w:k', workerId: 'k', status: 'started', description: 'K' });
  const k2 = api.feedUpsert(holder, { kind: 'worker', id: 'w:k2', workerId: 'k2', status: 'started', description: 'K2' });
  env.records.k2 = { workerId: 'k2', outcome: null, startedAt: at };
  api.feedEnd(holder);
  await env.flush();
  assert.deepStrictEqual([api.wkState(k), api.wkState(k2)], ['ended', 'running']);
  // only this page's side of a reply ended (a person's Stop, a stream cut off without the hub's final marker): its
  // workers keep running here; the hub's record decides, and no record leaves them as they are
  const holder2 = { agent: 'maestro', feed: { items: new Map(), byWorker: new Map() } };
  const m1 = api.feedUpsert(holder2, { kind: 'worker', id: 'w:m1', workerId: 'm1', status: 'started', description: 'M1' });
  const m2 = api.feedUpsert(holder2, { kind: 'worker', id: 'w:m2', workerId: 'm2', status: 'started', description: 'M2' });
  env.records.m2 = { workerId: 'm2', outcome: 'stopped', startedAt: at, durationMs: 2000 };
  api.feedEnd(holder2, 'maybe');
  assert.deepStrictEqual([api.wkState(m1), api.wkState(m2)], ['running', 'running'], 'not ended by this page alone');
  await env.flush();
  assert.deepStrictEqual([api.wkState(m1), api.wkState(m2)], ['running', 'stopped']);
  // the real end arriving after a guessed one: its own end time, and the list's clock from it
  const done = new Date(env.now - 30000).toISOString();
  api.feedUpsert(holder, { kind: 'worker', id: 'w:k', workerId: 'k', status: 'failed', error: 'boom', doneTs: done });
  assert.deepStrictEqual([api.wkState(k), k.t1, api.wkSeen.get('k').endSeen], ['failed', Date.parse(done), null]);
  // the end of turn A: a worker of turn B, or of no known turn, ends only on a recorded outcome; one whose reply this
  // page is still streaming is left to that stream; a worker of turn A with no record reads "ended"
  const b1 = worker('b1', 'running'), own = worker('own', 'running'), live = worker('live', 'running'), a1 = worker('a1', 'running');
  const liveRec = { agent: 'counsel' };
  api.wkTrack({ agent: 'counsel', turnId: 'B' }, b1);
  api.wkTrack({ agent: 'counsel' }, own);
  api.wkTrack(liveRec, live);
  api.wkTrack({ agent: 'counsel', turnId: 'A' }, a1);
  env.streams.set('counsel', liveRec);
  env.busy.add('counsel');
  env.asked.length = 0;
  api.wkSettleAgent('counsel', 'A');
  await env.flush();
  assert.deepStrictEqual(env.asked.map(u => u.split('/').pop()), ['b1', 'own', 'a1'], 'the live stream is left alone');
  assert.deepStrictEqual([api.wkState(b1), api.wkState(own), api.wkState(live), api.wkState(a1)], ['running', 'running', 'running', 'ended']);
  env.records.b1 = { workerId: 'b1', outcome: 'stopped', startedAt: at, durationMs: 1000 };
  api.wkSettleAgent('counsel', 'B');
  await env.flush();
  assert.strictEqual(api.wkState(b1), 'stopped');
  // Stop answered "not running": the hub runs nothing under that id, so a record that still says running reads ended;
  // a recorded outcome wins; no error is shown
  const f = worker('f', 'running'), f2 = worker('f2', 'running');
  api.wkTrack({ agent: 'maestro' }, f);
  api.wkTrack({ agent: 'maestro' }, f2);
  env.cancel = async () => ({ status: 404, json: async () => ({ success: false, error: 'not running' }) });
  env.records.f = { workerId: 'f', outcome: null, startedAt: at };
  env.records.f2 = { workerId: 'f2', outcome: 'done', startedAt: at, durationMs: 3000 };
  await api.wkStop(api.wkSeen.get('f'));
  await api.wkStop(api.wkSeen.get('f2'));
  await env.flush();
  assert.deepStrictEqual([api.wkState(f), api.wkState(f2), env.toasts], ['ended', 'done', []]);
});

test('worker history opened afresh loads afresh; Back from an old run keeps the list and its place', () => {
  const { api, env, body } = sheet();
  api.hist.items = [{ caller: 'maestro', workerId: 'old', startedAt: new Date().toISOString() }];
  api.wkShow({ mode: 'history', back: { mode: 'list' } });
  assert.deepStrictEqual(env.loads, [true], 'a fresh opening asks the hub again');
  env.loads.length = 0;
  api.hist.items = [{ caller: 'maestro', workerId: 'old', startedAt: new Date().toISOString() }];
  api.wkShow({ mode: 'history', keep: true, scroll: 240, back: { mode: 'list' } });
  assert.deepStrictEqual(env.loads, [], 'Back from a run keeps what was loaded');
  assert.strictEqual(body.scrollTop, 240);
});

test('a check that never answers is cut off by its time limit; a turn end that arrives while a check is out is not lost', async () => {
  const { api, env } = sheet();
  const at = new Date(env.now - 60000).toISOString();
  const tick = (ms) => { env.now += ms; api.wkRefresh(); };
  // a check that never answers is cut off by its time limit: nothing changes, and it is asked again a minute later
  const hang = worker('hang', 'running');
  api.wkTrack({ agent: 'counsel' }, hang);
  env.records.hang = 'hang';
  tick(1000); tick(13000);
  assert.strictEqual(env.timers.length, 1);
  const out = env.timers.shift()();
  env.aborts.pop().abort();
  await out;
  assert.deepStrictEqual([api.wkState(hang), api.wkSeen.get('hang').checking], ['running', false]);
  env.records.hang = { workerId: 'hang', outcome: 'done', startedAt: at, durationMs: 1000 };
  tick(61000);
  await env.flush();
  assert.strictEqual(api.wkState(hang), 'done', 'asked again after the time limit');
  // a turn's end arriving while a check is out is not lost behind that check's older answer: asked once more
  const late = worker('late', 'running');
  api.wkTrack({ agent: 'maestro' }, late);
  env.busy.add('maestro');
  env.records.late = [{ workerId: 'late', outcome: null, startedAt: at }, { workerId: 'late', outcome: 'stopped', startedAt: at, durationMs: 1000 }];
  api.wkSettleAgent('maestro', null);   // an end the page cannot match: 'maybe'
  api.wkSettleAgent('maestro', null);   // the turn's own end arrives while that check is out
  await env.flush();
  assert.strictEqual(api.wkState(late), 'stopped', 'the second end was asked about after the first answer');
});

test('applySnapshot namedOnly: workers missing from a named-only map stay, and keys the map lacks are not wiped', () => {
  const body = `const live = {}; let statusKnown = false; let current = null; const hubTurns = {};
    const paintStatus = () => {}; const reattachIfIdle = () => {};
    ${extract('busyIsWorker')}
    ${extract('setLive')}
    const wkSeen = new Map(); let wkGoneState = {}; const wkInferEnd = () => {};
    ${extract('workerGoneStep')}
    ${extract('applySnapshot')}
    return { live, applySnapshot };`;
  const { live, applySnapshot } = new Function(body)();
  applySnapshot({ lead: { busy: true, consultedBy: 'helper', activity: 'consulted by helper' }, 'tw-lead-1-aa': { busy: true, worker: true, parent: 'lead', label: 'job', model: 'm' } });
  assert.strictEqual(live.lead.consultedBy, 'helper');
  applySnapshot({ lead: { busy: true, busySince: null, activity: 'consulted by helper' } }, false, { namedOnly: true });
  assert.ok(live['tw-lead-1-aa'], 'worker kept');
  assert.strictEqual(live['tw-lead-1-aa'].parent, 'lead');
  assert.strictEqual(live.lead.consultedBy, 'helper', 'consultedBy kept');
  applySnapshot({ lead: { busy: true } });
  assert.ok(!live['tw-lead-1-aa'], 'a full snapshot still drops it');
  assert.strictEqual(live.lead.consultedBy, null);
});

test('phone: loadAgents passes namedOnly; the hub-row lookup stops when something else is open; focus handles hub rows', () => {
  assert.ok(src.includes('applySnapshot(map, false, { namedOnly: true });'));
  assert.ok(src.includes('current !== parent || wkView !== null) return;'));
  assert.ok(src.includes('dataset.hubId === focused.hubId'));
});
