'use strict';
// A character that is on the hub's list but not installed is downloaded on first use, with a visible percentage
// (lib/ui-call-display.js: fetchFaces, downloadText, createFaceDownload, paintDownloadNote, the call view's .cd-download line;
// app.js / mobile.js voice panels). Fake fetch, fake clock, fake DOM: these tests cannot prove how it looks in a browser.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
Object.assign(globalThis, require('../lib/ui-voice'));
const CD = require('../lib/ui-call-display');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const MB = 1000000;

function fakeDom() {
  const doc = { activeElement: null };
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.style = { setProperty() {} }; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? this.children.indexOf(ref) : -1; c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; delete this.value; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    focus() { doc.activeElement = this; }
    click() { for (const f of this.listeners.click || []) f({ preventDefault() {}, target: this }); }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
  }
  doc.createElement = (t) => new El(t);
  doc.body = new El('body');
  const find = (cls) => doc.body.all().filter(n => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  return { doc, El, find };
}
function clock() {
  const c = { t: 0, timers: [], id: 1 };
  c.setTimeout = (fn, ms) => { const id = c.id++; c.timers.push({ id, at: c.t + ms, fn }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter(x => x.id !== id); };
  c.advance = async (ms) => { const end = c.t + ms; for (;;) { const d = c.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!d) break; c.timers = c.timers.filter(x => x !== d); c.t = d.at; d.fn(); await tick(); } c.t = end; await tick(); };
  return c;
}
// A fake hub: /api/faces and /api/faces/<id>/download. `script` is the list of statuses the download endpoint answers in turn.
function fakeHub(o) {
  const x = Object.assign({ packs: [], available: [{ id: 'owl', name: 'Owl', size: 37 * MB }], script: [], post: 200 }, o);
  const hub = { calls: [], installed: x.packs.slice(), script: x.script.slice() };
  hub.fetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    hub.calls.push({ url, method, init });
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url === '/api/faces') return reply(200, { packs: hub.installed, available: hub.installed.some(p => p.id === 'owl') ? [] : x.available });
    if (/^\/api\/faces\/[a-z0-9-]+\/download$/.test(url)) {
      if (method === 'POST' && x.post !== 200) return reply(x.post, x.postBody || { error: 'nope' });
      const st = hub.script.length > 1 ? hub.script.shift() : hub.script[0];
      if (st && st.state === 'done') hub.installed = [{ id: 'owl', name: 'Owl', background: '#ffd6ab', hasReactions: true }];
      if (st && st.throws) throw new Error('offline');
      return reply(200, st);
    }
    return reply(404, {});
  };
  return hub;
}
const dl = (state, received, total, extra) => Object.assign({ id: 'owl', state, received: received * MB, total: total * MB }, extra);

// ── fetchFaces ──
test('fetchFaces returns installed packs and the catalogue packs to download; bad entries are dropped', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({
    packs: [{ id: 'owl', name: 'Owl' }, { id: 'Bad Id' }, null],
    available: [{ id: 'fox', name: '  Fox  ', size: 20 * MB }, { id: 'Bad Id', name: 'x', size: 5 }, { id: 'cat', name: 'Cat', size: 0 }, { id: 'dog', name: 'Dog', size: 1.5 }, { id: 'owl', name: 'Owl', size: 4 * MB }, { id: 'eel', size: 3 * MB }, 7],
  }) });
  const r = await CD.fetchFaces(f);
  assert.deepStrictEqual(r.packs.map(p => p.id), ['owl']);
  assert.deepStrictEqual(r.available, [{ id: 'fox', name: 'Fox', size: 20 * MB }, { id: 'eel', name: 'eel', size: 3 * MB }]);
});
test('fetchFaces on an old hub without "available" gives []; fetchPacks still returns the plain packs array', async () => {
  const f = async () => ({ ok: true, status: 200, json: async () => ({ packs: [{ id: 'owl', name: 'Owl' }] }) });
  assert.deepStrictEqual((await CD.fetchFaces(f)).available, []);
  const packs = await CD.fetchPacks(f);
  assert.ok(Array.isArray(packs) && packs[0].id === 'owl');
  await assert.rejects(() => CD.fetchFaces(async () => ({ ok: false, status: 500 })));
});

// ── downloadText ──
test('downloadText: the line for every state', () => {
  assert.strictEqual(CD.downloadText({ state: 'downloading', received: 15.4 * MB + 0.2 * MB, total: 37 * MB }, 'Owl'), 'Downloading the owl… 42% · 16 of 37 MB');
  assert.strictEqual(CD.downloadText({ state: 'downloading', received: 15.4 * MB, total: 37 * MB }, 'Owl'), 'Downloading the owl… 41% · 15 of 37 MB');
  assert.strictEqual(CD.downloadText({ state: 'downloading', received: 15.6 * MB, total: 37 * MB }, 'Owl'), 'Downloading the owl… 42% · 16 of 37 MB');
  assert.strictEqual(CD.downloadText({ state: 'downloading', received: 15 * MB, total: 36 * MB }, 'Owl'), 'Downloading the owl… 41% · 15 of 36 MB', 'the percent is floored');
  assert.strictEqual(CD.downloadText({ state: 'downloading', received: 0, total: 0 }, 'Owl'), 'Downloading the owl…', 'no total yet: no invented percent');
  assert.strictEqual(CD.downloadText({ state: 'installing' }, 'Owl'), 'Installing the owl…');
  assert.strictEqual(CD.downloadText({ state: 'failed', error: 'disk full' }, 'Owl'), 'Could not download the owl: disk full');
  assert.strictEqual(CD.downloadText({ state: 'busy', error: 'The fox is downloading.' }, 'Owl'), 'The fox is downloading.');
  assert.strictEqual(CD.downloadText({ state: 'done' }, 'Owl'), '');
  assert.strictEqual(CD.downloadText({ state: 'idle' }, 'Owl'), '');
  assert.strictEqual(CD.downloadText(null, 'Owl'), '');
});

// ── createFaceDownload ──
test('createFaceDownload: POSTs once, polls every 500 ms, reports 10% -> 60% -> installing -> done and stops polling', async () => {
  const hub = fakeHub({ script: [dl('downloading', 4, 40), dl('downloading', 24, 40), dl('installing', 40, 40), dl('done', 40, 40)] });
  const clk = clock(), seen = [];
  const d = CD.createFaceDownload({ fetch: hub.fetch, id: 'owl', name: 'Owl', onUpdate: (s) => seen.push(CD.downloadText(s, 'Owl') || s.state), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await d.start(); await tick();
  const post = hub.calls[0];
  assert.deepStrictEqual([post.url, post.method, post.init.credentials, post.init.headers['Content-Type'], post.init.body], ['/api/faces/owl/download', 'POST', 'same-origin', 'application/json', '{}']);
  assert.deepStrictEqual(seen, ['Downloading the owl… 10% · 4 of 40 MB']);
  await clk.advance(499); assert.strictEqual(hub.calls.length, 1, 'no poll before 500 ms');
  await clk.advance(1);
  assert.strictEqual(hub.calls[1].method, 'GET'); assert.strictEqual(hub.calls[1].url, '/api/faces/owl/download');
  await clk.advance(500); await clk.advance(500);
  assert.deepStrictEqual(seen, ['Downloading the owl… 10% · 4 of 40 MB', 'Downloading the owl… 60% · 24 of 40 MB', 'Installing the owl…', 'done']);
  const n = hub.calls.length;
  await clk.advance(5000);
  assert.strictEqual(hub.calls.length, n, 'no polling after done');
  assert.strictEqual(d.status.state, 'done');
});
test('createFaceDownload: failed shows the error and retry() POSTs again; busy stops; stop() ends the polling', async () => {
  const hub = fakeHub({ script: [dl('failed', 1, 40, { error: 'disk full' })] });
  const clk = clock(), seen = [];
  const d = CD.createFaceDownload({ fetch: hub.fetch, id: 'owl', onUpdate: (s) => seen.push(s.state + ':' + (s.error || '')), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await d.start(); await clk.advance(3000);
  assert.deepStrictEqual(seen, ['failed:disk full']);
  assert.strictEqual(hub.calls.length, 1, 'a failed download is not polled');
  hub.script = [dl('downloading', 8, 40)];
  await d.retry(); assert.strictEqual(hub.calls[1].method, 'POST', 'retry POSTs again');
  assert.strictEqual(seen[1], 'downloading:');
  d.stop(); const n = hub.calls.length; await clk.advance(3000);
  assert.strictEqual(hub.calls.length, n, 'stop() ends the polling');

  const busy = fakeHub({ post: 409, postBody: { state: 'busy', error: 'The fox is downloading.' } });
  const got = []; const b = CD.createFaceDownload({ fetch: busy.fetch, id: 'owl', onUpdate: (s) => got.push(s), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await b.start(); await clk.advance(3000);
  assert.deepStrictEqual([got.length, got[0].state, got[0].error], [1, 'busy', 'The fox is downloading.']);
  assert.strictEqual(busy.calls.length, 1, 'busy is not polled');
});
test('createFaceDownload: a network error is a plain failure, a 404 says the character is not on the hub', async () => {
  const clk = clock(), seen = [];
  const d = CD.createFaceDownload({ fetch: async () => { throw new Error('ECONNRESET'); }, id: 'owl', onUpdate: (s) => seen.push(s), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await d.start();
  assert.strictEqual(seen[0].state, 'failed'); assert.ok(seen[0].error && !/ECONNRESET/.test(seen[0].error), 'a plain message, not the raw error');
  const nf = []; const e = CD.createFaceDownload({ fetch: fakeHub({ post: 404, postBody: { error: 'x' } }).fetch, id: 'owl', onUpdate: (s) => nf.push(s), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await e.start(); assert.strictEqual(nf[0].state, 'failed'); assert.ok(/not available/.test(nf[0].error));
});

test('createFaceDownload: every request has a 15 s deadline that becomes a retryable failure; stop() aborts the request in the air', async () => {
  const clk = clock(), seen = [], signals = [];
  const hang = (url, init) => { signals.push(init.signal); return new Promise(() => {}); };
  const d = CD.createFaceDownload({ fetch: hang, id: 'owl', onUpdate: (s) => seen.push(s), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  d.start(); await tick();
  await clk.advance(14999); assert.strictEqual(seen.length, 0, 'still waiting');
  await clk.advance(1);
  assert.deepStrictEqual([seen.length, seen[0].state, seen[0].error], [1, 'failed', 'The hub did not answer; try again.']);
  if (signals[0]) assert.strictEqual(signals[0].aborted, true, 'the request was aborted');
  assert.strictEqual(CD.downloadText(seen[0], 'Owl'), 'Could not download the owl: The hub did not answer; try again.');
  // a poll that hangs too
  const hub = fakeHub({ script: [dl('downloading', 4, 40)] }); const seen2 = [];
  let hangNext = false;
  const f2 = (url, init) => (hangNext && (init.method || 'GET') === 'GET' ? new Promise(() => {}) : hub.fetch(url, init));
  const e = CD.createFaceDownload({ fetch: f2, id: 'owl', onUpdate: (s) => seen2.push(s.state), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await e.start(); hangNext = true; await clk.advance(500); await clk.advance(15000);
  assert.deepStrictEqual(seen2, ['downloading', 'failed']);
  // stop() aborts the request in the air and nothing is reported
  const sigs = []; const seen3 = [];
  const g = CD.createFaceDownload({ fetch: (u, init) => { sigs.push(init.signal); return new Promise(() => {}); }, id: 'owl', onUpdate: (s) => seen3.push(s), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  g.start(); await tick(); g.stop();
  if (sigs[0]) assert.strictEqual(sigs[0].aborted, true, 'stop() aborted it');
  await clk.advance(20000); assert.strictEqual(seen3.length, 0);
});
test('createFaceDownload: a poll answering idle while downloading (the hub restarted) becomes a retryable failure', async () => {
  const hub = fakeHub({ script: [dl('downloading', 4, 40), { id: 'owl', state: 'idle', received: 0, total: 40 * MB }] });
  const clk = clock(), seen = [];
  const d = CD.createFaceDownload({ fetch: hub.fetch, id: 'owl', onUpdate: (s) => seen.push(s.state + ':' + (s.error || '')), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  await d.start(); await clk.advance(500); await clk.advance(3000);
  assert.deepStrictEqual(seen, ['downloading:', 'failed:The download stopped (your Maestro may have restarted). Try again.']);
  assert.strictEqual(hub.calls.length, 2, 'not polled after the failure');
});

// ── sharedFaceDownload ──
test('sharedFaceDownload: one object per id; start() joins a running one, retry() restarts it for every listener, the last unsubscribe frees it', async () => {
  CD.__resetSharedDownloadsForTests();
  const hub = fakeHub({ script: [dl('downloading', 4, 40)] }), clk = clock();
  const mk = () => CD.sharedFaceDownload({ fetch: hub.fetch, id: 'owl', name: 'Owl', setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const a = mk(), b = mk(); const sa = [], sb = [];
  const offA = a.subscribe((s) => sa.push(s.state)), offB = b.subscribe((s) => sb.push(s.state));
  await a.start(); await b.start(); await tick();
  assert.strictEqual(hub.calls.filter(c => c.method === 'POST').length, 1, 'the second start() joined');
  assert.deepStrictEqual([sa, sb], [['downloading'], ['downloading']]);
  assert.strictEqual(b.status.state, 'downloading');
  offA(); offA(); await clk.advance(500); assert.deepStrictEqual(sb, ['downloading', 'downloading'], 'the other listener still hears it');
  assert.strictEqual(sa.length, 1);
  offB(); const n = hub.calls.length; await clk.advance(3000);
  assert.strictEqual(hub.calls.length, n, 'no listeners left: polling stopped');
  assert.notStrictEqual(mk().status, b.status, 'a fresh object after the last listener left');
  CD.__resetSharedDownloadsForTests();
});
test('call view + voice panel share one download: POST fails for both, Retry from the panel runs it, the call switches to the character', async () => {
  CD.__resetSharedDownloadsForTests();
  const clk = clock(); let phase = 'fail';
  const hub = fakeHub({ script: [dl('downloading', 10, 40), dl('done', 40, 40)] });
  const inner = hub.fetch;
  const fetch = async (url, init) => {
    if (/download$/.test(url) && (init && init.method) === 'POST' && phase === 'fail') { hub.calls.push({ url, method: 'POST', init }); return { ok: false, status: 500, json: async () => ({ error: 'disk full' }) }; }
    return inner(url, init);
  };
  const dom = fakeDom(), players = [], orbs = [];
  const mkp = (kind, log) => (host, options) => { const p = { kind, options, destroyed: false, setState() {}, setAnalyser() {}, react: () => false, destroy() { p.destroyed = true; }, ready: Promise.resolve() }; if (kind === 'orb') p.thinkingPulse = () => {}; log.push(p); return p; };
  const display = CD.createCallDisplay({ window: { document: dom.doc }, document: dom.doc, storage: { getItem: () => JSON.stringify({ choice: 'pack:owl' }), setItem() {} }, fetch, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, agentDefault: () => 'none', createVoiceOrb: mkp('orb', orbs), createFacePlayer: mkp('pack', players) });
  await display.ensurePacks(); await tick();
  const panel = []; const handle = CD.sharedFaceDownload({ fetch, id: 'owl', name: 'Owl', setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const off = handle.subscribe((s) => panel.push(s.state));
  assert.strictEqual(display.info().download.state, 'failed', 'the call shows the failure');
  assert.strictEqual(handle.status.state, 'failed', 'and so does the panel');
  assert.strictEqual(orbs.length, 1);
  phase = 'ok'; handle.retry(); await tick();
  assert.deepStrictEqual(panel, ['downloading']);
  assert.strictEqual(display.info().download.state, 'downloading', 'the call hears the retry');
  await clk.advance(500); await tick(20);
  assert.deepStrictEqual(panel, ['downloading', 'done']);
  assert.strictEqual(display.info().resolved.kind, 'pack', 'the call switched to the pack');
  assert.strictEqual(players.length, 1); assert.ok(orbs[0].destroyed);
  off(); display.release(); CD.__resetSharedDownloadsForTests();
});

// ── select, resolve ──
test('fillDisplaySelect lists a downloadable character after the installed ones, with its size', () => {
  const dom = fakeDom(), sel = dom.doc.createElement('select');
  CD.fillDisplaySelect(dom.doc, sel, { choice: 'pack:fox', packs: [{ id: 'owl', name: 'Owl' }], available: [{ id: 'fox', name: 'Fox', size: 37 * MB + 1 }] });
  assert.deepStrictEqual(sel.children.map(o => [o.value, o.textContent]), [['follow', 'Follow agent default'], ['none', 'None'], ['orb', 'Orb'], ['pack:owl', 'Owl'], ['pack:fox', 'Fox · downloads 37 MB']]);
  assert.strictEqual(sel.value, 'pack:fox');
  CD.fillDisplaySelect(dom.doc, sel, { choice: 'pack:ghost', packs: [], available: [{ id: 'fox', name: 'Fox', size: 5 * MB }] });
  assert.ok(sel.children.some(o => o.textContent === 'ghost (not installed)'), 'an unknown saved choice is still shown as not installed');
  CD.fillDisplaySelect(dom.doc, sel, { choice: 'orb', packs: [] });
  assert.strictEqual(sel.children.length, 3, 'no available list (old hub): as before');
});
test('resolveDisplay: a character that can be downloaded shows the Orb meanwhile; every other case is as before', () => {
  const av = [{ id: 'owl', name: 'Owl', size: 5 }];
  const r = CD.resolveDisplay({ choice: 'pack:owl', packs: [], available: av });
  assert.deepStrictEqual([r.kind, r.missing, r.pending, r.wanted, r.downloadable], ['orb', false, false, 'owl', true]);
  assert.strictEqual(CD.resolveDisplay({ choice: 'follow', agentDefault: 'pack:owl', packs: [], available: av }).downloadable, true, 'the agent default too');
  assert.strictEqual(CD.resolveDisplay({ choice: 'pack:owl', packs: [{ id: 'owl', name: 'Owl' }], available: av }).kind, 'pack', 'installed wins');
  const miss = CD.resolveDisplay({ choice: 'pack:ghost', packs: [], available: av });
  assert.deepStrictEqual([miss.kind, miss.missing, miss.downloadable], ['none', true, undefined]);
  assert.strictEqual(CD.resolveDisplay({ choice: 'pack:owl', packs: [], available: av, packsState: 'loading' }).kind, 'none', 'still loading: as before');
  assert.strictEqual(CD.resolveDisplay({ choice: 'pack:owl', packs: [], packsState: 'failed', available: av }).downloadable, undefined, 'a failed list is not a download offer');
});

// ── paintDownloadNote ──
test('paintDownloadNote: live text, a progress bar under the note, Retry on failure, removed when done', () => {
  const dom = fakeDom(), box = dom.doc.createElement('div'), note = dom.doc.createElement('div'); box.appendChild(note);
  let retried = 0;
  assert.strictEqual(CD.paintDownloadNote(dom.doc, note, dl('downloading', 15, 37), 'Owl', () => { retried++; }), true);
  assert.strictEqual(note.textContent, 'Downloading the owl… 40% · 15 of 37 MB');
  const bar = box.children[1]; assert.strictEqual(bar.tagName, 'PROGRESS'); assert.strictEqual(bar.value, 40); assert.strictEqual(bar.max, 100);
  CD.paintDownloadNote(dom.doc, note, dl('downloading', 30, 37), 'Owl'); assert.strictEqual(box.children.length, 2, 'the same bar is updated, not duplicated'); assert.strictEqual(bar.value, 81);
  CD.paintDownloadNote(dom.doc, note, { state: 'failed', error: 'offline' }, 'Owl', () => { retried++; });
  assert.strictEqual(note.textContent, 'Could not download the owl: offline');
  const btn = box.children[1]; assert.strictEqual(btn.tagName, 'BUTTON'); assert.strictEqual(btn.textContent, 'Retry'); btn.click(); assert.strictEqual(retried, 1);
  assert.strictEqual(CD.paintDownloadNote(dom.doc, note, { state: 'done' }, 'Owl'), false);
  assert.strictEqual(box.children.length, 1, 'bar and button are gone');
});

// ── the call view ──
function callWorld(hub, o) {
  const dom = fakeDom(), clk = clock(), players = [], orbs = [];
  const mk = (kind, log) => (host, options) => { const p = { kind, options, destroyed: false, setState() {}, setAnalyser() {}, react: () => false, destroy() { p.destroyed = true; }, ready: Promise.resolve() }; if (kind === 'orb') p.thinkingPulse = () => {}; log.push(p); return p; };
  const display = CD.createCallDisplay({
    window: { document: dom.doc }, document: dom.doc, storage: { getItem: () => JSON.stringify({ choice: (o && o.choice) || 'pack:owl' }), setItem() {} },
    fetch: hub.fetch, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, agentDefault: () => 'none',
    createVoiceOrb: mk('orb', orbs), createFacePlayer: mk('pack', players),
  });
  return { dom, clk, display, players, orbs };
}
test('call view: a downloadable choice shows the Orb and a download line, then switches to the character when it is done', async () => {
  const hub = fakeHub({ script: [dl('downloading', 10, 40), dl('downloading', 30, 40), dl('installing', 40, 40), dl('done', 40, 40)] });
  const w = callWorld(hub);
  w.display.start && w.display.start();
  await w.display.ensurePacks(); await tick();
  assert.strictEqual(w.orbs.length, 1, 'the Orb shows meanwhile');
  assert.strictEqual(w.players.length, 0);
  assert.ok(hub.calls.some(c => c.method === 'POST' && c.url === '/api/faces/owl/download'), 'the download started by itself');
  const line = w.dom.find('cd-download')[0];
  assert.ok(line && !line.hidden, 'the download line is shown');
  assert.strictEqual(line.all().find(n => n.className === 'cd-download-text').textContent, 'Downloading the owl… 25% · 10 of 40 MB');
  const bar = line.all().find(n => n.tagName === 'PROGRESS'); assert.strictEqual(bar.value, 25);
  await w.clk.advance(500);
  assert.strictEqual(line.all().find(n => n.className === 'cd-download-text').textContent, 'Downloading the owl… 75% · 30 of 40 MB');
  await w.clk.advance(500);
  assert.strictEqual(line.all().find(n => n.className === 'cd-download-text').textContent, 'Installing the owl…');
  await w.clk.advance(500); await tick(20);
  assert.strictEqual(w.display.info().resolved.kind, 'pack', 'the view switches to the installed character');
  assert.strictEqual(w.players.length, 1);
  assert.ok(w.orbs[0].destroyed, 'the Orb is gone');
  assert.strictEqual(line.hidden, true, 'the line is hidden once it is installed');
  const n = hub.calls.length; await w.clk.advance(3000);
  assert.strictEqual(hub.calls.filter(c => c.url === '/api/faces/owl/download').length, hub.calls.slice(0, n).filter(c => c.url === '/api/faces/owl/download').length, 'no more polling');
  w.display.release();
});
test('call view: a failed download shows the message and a Retry button; the call is not blocked and Retry starts again', async () => {
  const hub = fakeHub({ script: [dl('failed', 2, 40, { error: 'no space left' })] });
  const w = callWorld(hub);
  await w.display.ensurePacks(); await tick();
  assert.strictEqual(w.orbs.length, 1, 'the Orb still shows');
  const line = w.dom.find('cd-download')[0];
  assert.strictEqual(line.all().find(n => n.className === 'cd-download-text').textContent, 'Could not download the owl: no space left');
  const retry = w.dom.find('cd-download-retry')[0]; assert.ok(retry && !retry.hidden);
  hub.script = [dl('downloading', 4, 40)];
  retry.click(); await tick();
  assert.strictEqual(hub.calls.filter(c => c.method === 'POST').length, 2, 'Retry POSTs again');
  assert.ok(/Downloading the owl… 10%/.test(line.all().find(n => n.className === 'cd-download-text').textContent));
  w.display.release();
});
test('call view: nothing to download when the character is installed or the choice is the Orb', async () => {
  const installed = fakeHub({ packs: [{ id: 'owl', name: 'Owl' }], available: [] });
  const a = callWorld(installed); await a.display.ensurePacks(); await tick();
  assert.strictEqual(a.players.length, 1); assert.ok(!installed.calls.some(c => /download/.test(c.url)));
  const orb = fakeHub(); const b = callWorld(orb, { choice: 'orb' }); await b.display.ensurePacks(); await tick();
  assert.ok(!orb.calls.some(c => /download/.test(c.url)), 'the Orb needs no download');
  a.display.release(); b.display.release();
});

// ── the pages (source wiring) ──
test('desktop voice panel: fetchFaces, available into the select and resolveDisplay, one page-wide download map, progress + Retry in the note', () => {
  const src = read('app.js');
  const i = src.indexOf('async function voiceDispPaintPanel(chatId)'), j = src.indexOf('function voiceDispSetCaptions', i);
  assert.ok(i > 0 && j > i);
  const body = src.slice(i, j);
  assert.ok(/CallDisplay\.fetchFaces\(/.test(body) && !/fetchPacks/.test(body));
  assert.ok(/fillDisplaySelect\(document, sel, \{ choice: prefs\.choice, packs, available \}\)/.test(body));
  assert.ok(/resolveDisplay\(\{[^}]*available[^}]*\}\)/.test(body));
  assert.ok(/resolved\.downloadable === true/.test(body) && /voiceDisp\.downloads/.test(body) && /sharedFaceDownload\(/.test(body));
  assert.ok(/paintDownloadNote\(document, note,/.test(body), 'the note area shows the live text, a progress bar and Retry');
  assert.ok(/vp-display-note-\$\{chatId\}/.test(body));
  assert.ok(/prev\.dl\.retry\(\)/.test(body) && /choosing it again tries again/.test(body), 'choosing a failed character again starts a new download at once');
});
test('phone voice sheet: the same, and the call screen gets it through createCallDisplay', () => {
  const src = read('mobile.js');
  const i = src.indexOf('async function voiceDispPaintPanel()'), j = src.indexOf('function voiceDispSetCaptions', i);
  assert.ok(i > 0 && j > i);
  const body = src.slice(i, j);
  assert.ok(/CallDisplay\.fetchFaces\(/.test(body) && !/fetchPacks/.test(body));
  assert.ok(/fillDisplaySelect\(document, sel, \{ choice: prefs\.choice, packs, available \}\)/.test(body));
  assert.ok(/resolved\.downloadable === true/.test(body) && /voiceDisp\.downloads/.test(body) && /sharedFaceDownload\(/.test(body) && /paintDownloadNote\(document, note,/.test(body));
  assert.ok(/CallDisplay\.createCallDisplay\(\{[^]*?fetch: \(\.\.\.a\) => fetch\(\.\.\.a\)/.test(src), 'the call screen display has a fetch for the download');
  assert.ok(/\.cd-download-retry/.test(read('lib/ui-call-display.css')) && /\.cd-download \{/.test(read('lib/ui-call-display.css')));
});
test('agent settings: the default call display lists downloadable characters with their size and saves pack:<id>', () => {
  const html = read('agent-settings.html');
  assert.ok(/callDisplayOptions\(current, packs, available\)/.test(html) && /r\.available/.test(html));
  assert.ok(/' · downloads ' \+ mb \+ ' MB'/.test(html));
  const m = html.match(/function callDisplayOptions\(current, packs, available\) \{[\s\S]*?\n  \}\n/);
  assert.ok(m, 'function found');
  const fn = new Function("const CALL_DISPLAY_FIXED = [{ value: 'none', label: 'None' }, { value: 'orb', label: 'Orb' }];" + m[0] + '; return callDisplayOptions;')();
  const opts = fn('none', [{ id: 'owl', name: 'Owl' }], [{ id: 'fox', name: 'Fox', size: 20 * MB }, { id: 'owl', name: 'Owl', size: 3 * MB }]);
  assert.deepStrictEqual(opts.map(o => [o.value, o.label]), [['none', 'None'], ['orb', 'Orb'], ['pack:owl', 'Owl'], ['pack:fox', 'Fox · downloads 20 MB']]);
  assert.strictEqual(fn('none', [], undefined).length, 2, 'an old hub without the list: as before');
});
test('the phone service worker cache is bumped for the new mobile.js', () => {
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v69'/);
});
