'use strict';
// The call's Display picker never says "not installed" for a list that is loading or failed (lib/ui-call-display.js):
// option text per list state, remembered names, back-off retry of a failed list, the Try again button, timers cleared at hang-up.
// Fake DOM, fake clock, fake players: these tests cannot prove how it looks in a browser.
const { test } = require('node:test');
const assert = require('node:assert');
Object.assign(globalThis, require('../lib/ui-voice'));
const CD = require('../lib/ui-call-display');

const tick = async (n = 30) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

function fakeDom() {
  const doc = { activeElement: null };
  class El {
    constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.className = ''; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this._text = ''; this.props = {}; this.style = { props: this.props, setProperty: (k, v) => { this.props[k] = v; } }; }
    get firstChild() { return this.children[0] || null; }
    get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
    set textContent(v) { this.children.forEach(c => { c.parentNode = null; }); this.children = []; this._text = String(v); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = this.children.indexOf(ref); c.parentNode = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k]; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
    focus() { doc.activeElement = this; }
    click() { const e = { preventDefault() {}, stopPropagation() {}, target: this }; for (const f of this.listeners.click || []) f(e); }
    all() { return this.children.flatMap(c => [c, ...c.all()]); }
    querySelectorAll(sel) { const tags = sel.split(',').map(x => x.trim().split('[')[0].toUpperCase()); return this.all().filter(n => tags.includes(n.tagName)); }
  }
  doc.createElement = (t) => new El(t);
  doc.body = new El('body');
  const find = (cls) => doc.body.all().filter(n => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  return { doc, find };
}
function memStorage(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }
function playerFactory(kind, log) {
  return (host, options) => {
    const p = { kind, host, options, calls: [], destroyed: false };
    const rec = (n) => (...a) => { p.calls.push([n, ...a]); };
    for (const n of ['setState', 'setAnalyser', 'setMicLevel', 'speechEvent', 'setLevel', 'cancelReaction', 'setHearing']) p[n] = rec(n);
    if (kind === 'orb') p.thinkingPulse = rec('thinkingPulse');
    p.react = () => true;
    p.destroy = () => { p.destroyed = true; };
    p.ready = Promise.resolve(p); p.ready.catch(() => {});
    log.push(p);
    return p;
  };
}
function clock() {
  const c = { t: 0, timers: [], id: 1 };
  c.setTimeout = (fn, ms) => { const id = c.id++; c.timers.push({ id, at: c.t + ms, fn }); return id; };
  c.clearTimeout = (id) => { c.timers = c.timers.filter(x => x.id !== id); };
  c.advance = async (ms) => { const end = c.t + ms; for (;;) { const d = c.timers.filter(x => x.at <= end).sort((a, b) => a.at - b.at)[0]; if (!d) break; c.timers = c.timers.filter(x => x !== d); c.t = d.at; d.fn(); await tick(); } c.t = end; await tick(); };
  return c;
}
const OWL = { id: 'owl', name: 'Owl', background: '#ffd6ab', hasReactions: false };
function world(o) {
  const dom = fakeDom(), clk = clock(), players = [], orbs = [];
  const storage = o.storage || memStorage(o.prefs ? { [CD.DISPLAY_STORE_KEY]: JSON.stringify(o.prefs) } : {});
  const page = dom.doc.createElement('div'), composer = dom.doc.createElement('div');   // the page's message box: with a dock the call bar (and its Display picker) is on screen while no character shows
  page.appendChild(composer); dom.doc.body.appendChild(page);
  const display = CD.createCallDisplay({
    window: { document: dom.doc }, document: dom.doc, storage, fetch: o.fetch, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
    agentDefault: o.agentDefault, dock: () => composer, adopt: () => [], onTalk() {}, onHangUp() {}, onChange() {},
    createVoiceOrb: playerFactory('orb', orbs), createFacePlayer: playerFactory('pack', players),
  });
  return { dom, clk, players, orbs, storage, display };
}
const okFetch = (body) => async () => ({ ok: true, status: 200, json: async () => body });
const pickerTexts = (w) => w.dom.find('ucd-display')[0].children.map(c => c.textContent);
const pickerLast = (w) => pickerTexts(w).slice(-1)[0];
const tryAgain = (w) => w.dom.find('cd-download-retry').filter(b => b.textContent === 'Try again')[0];
function selectFor(opts) {
  const dom = fakeDom(); const sel = dom.doc.createElement('select');
  CD.fillDisplaySelect(dom.doc, sel, opts);
  return sel.children.map(c => c.textContent);
}

test('fillDisplaySelect: a stored pack the list lacks reads by list state, never "(not installed)"', () => {
  const base = { choice: 'pack:owl', packs: [], available: [] };
  assert.strictEqual(selectFor({ ...base, state: 'loading' }).slice(-1)[0], 'Owl · loading');
  assert.strictEqual(selectFor({ ...base, state: 'failed' }).slice(-1)[0], "Owl · couldn't check");
  assert.strictEqual(selectFor({ ...base, state: 'ready' }).slice(-1)[0], 'Owl · not on this Maestro');
  assert.strictEqual(selectFor(base).slice(-1)[0], 'Owl · not on this Maestro', 'an array of packs without a state is ready');
  assert.strictEqual(selectFor({ choice: 'pack:owl', packs: [{ id: 'owl', name: 'Barn Owl' }], state: 'ready' }).slice(-1)[0], 'Barn Owl', 'installed: its name, no suffix');
  assert.strictEqual(selectFor({ ...base, available: [{ id: 'owl', name: 'Owl', size: 37000000 }], state: 'ready' }).slice(-1)[0], 'Owl · downloads 37 MB');
  assert.strictEqual(selectFor({ ...base, state: 'failed', names: { owl: 'Night Owl' } }).slice(-1)[0], "Night Owl · couldn't check", 'a remembered name beats the capitalised id');
  for (const state of ['loading', 'failed', 'ready']) for (const names of [undefined, { owl: 'Night Owl' }]) {
    for (const t of selectFor({ ...base, state, names })) assert.ok(!/not installed/.test(t), 'no option says not installed: ' + t);
  }
});

test('packLabel and the remembered names: capitalised id, 50 entries, 80 characters, slug ids only, storage faults tolerated', () => {
  assert.strictEqual(CD.packLabel('owl'), 'Owl');
  assert.strictEqual(CD.packLabel('owl', { owl: 'Night Owl' }), 'Night Owl');
  assert.strictEqual(CD.packLabel('owl', { fox: 'Fox' }), 'Owl');
  const s = memStorage();
  CD.rememberPackNames(s, { packs: [{ id: 'owl', name: 'Night Owl' }, { id: 'Bad Id', name: 'x' }], available: [{ id: 'fox', name: 'F'.repeat(200), size: 5 }] });
  const got = CD.loadPackNames(s);
  assert.deepStrictEqual(Object.keys(got).sort(), ['fox', 'owl']);
  assert.strictEqual(got.owl, 'Night Owl'); assert.strictEqual(got.fox.length, 80);
  const many = []; for (let i = 0; i < 60; i++) many.push({ id: 'p' + i, name: 'Pack ' + i });
  CD.rememberPackNames(s, { packs: many });
  const kept = CD.loadPackNames(s);
  assert.strictEqual(Object.keys(kept).length, 50); assert.ok(kept.p59 && !kept.p0, 'the oldest drop first');
  assert.doesNotThrow(() => CD.rememberPackNames({ getItem() { throw new Error('x'); }, setItem() { throw new Error('x'); } }, { packs: many }));
});

test('a list that fails twice then answers: the picker says couldn\'t check, then the name, and the view becomes the character', async () => {
  let calls = 0;
  const fetch = async () => { calls++; if (calls < 3) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ packs: [OWL] }) }; };
  const w = world({ prefs: { choice: 'pack:owl' }, fetch });
  w.display.start(); await tick();
  assert.strictEqual(calls, 1); assert.strictEqual(w.display.info().packsState, 'failed');
  assert.strictEqual(pickerLast(w), "Owl · couldn't check");
  assert.ok(/Couldn't reach your Maestro for the character list\. Trying again…/.test(w.display.info().note) && !/not installed/.test(w.display.info().note));
  await w.clk.advance(2900); assert.strictEqual(calls, 1, 'not before 3 s');
  await w.clk.advance(200); assert.strictEqual(calls, 2); assert.strictEqual(pickerLast(w), "Owl · couldn't check");
  await w.clk.advance(5000); assert.strictEqual(calls, 2, 'the next wait is 6 s');
  await w.clk.advance(1100); assert.strictEqual(calls, 3);
  assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(w.display.info().kind, 'pack'); assert.strictEqual(pickerLast(w), 'Owl');
  assert.strictEqual(w.clk.timers.length, 0, 'no retry left once the list is in');
  assert.strictEqual(CD.loadPackNames(w.storage).owl, 'Owl', 'the answered name is remembered');
  w.display.release();
});

test('the back-off runs 3, 6, 12, 24 s and then every 30 s while the call lasts', async () => {
  let calls = 0;
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: async () => { calls++; throw new Error('down'); } });
  w.display.start(); await tick();
  for (const wait of [3000, 6000, 12000, 24000, 30000, 30000]) {
    const before = calls;
    await w.clk.advance(wait - 100); assert.strictEqual(calls, before, 'not before ' + wait);
    await w.clk.advance(100); assert.strictEqual(calls, before + 1, 'a retry after ' + wait);
  }
  w.display.release();
});

test('a remembered name is shown while the list loads and after it fails', async () => {
  const s = memStorage({ [CD.DISPLAY_STORE_KEY]: JSON.stringify({ choice: 'pack:owl' }) });
  CD.rememberPackNames(s, { packs: [{ id: 'owl', name: 'Night Owl' }] });
  let never; const w = world({ storage: s, fetch: () => new Promise((r) => { never = r; }) });
  w.display.start(); await tick();
  assert.strictEqual(pickerLast(w), 'Night Owl · loading');
  w.display.release();
});

test('Try again shows only while the list failed, asks at once and starts the back-off over', async () => {
  let calls = 0, fail = true;
  const fetch = async () => { calls++; if (fail) throw new Error('offline'); return { ok: true, status: 200, json: async () => ({ packs: [OWL] }) }; };
  let hold; const slow = () => new Promise((r) => { hold = r; });
  // loading: hidden
  const l = world({ prefs: { choice: 'pack:owl' }, fetch: slow }); l.display.start(); await tick();
  assert.strictEqual(l.display.info().packsState, 'loading'); assert.strictEqual(tryAgain(l).hidden, true); l.display.release();
  // failed: shown; pressing it fetches now
  const w = world({ prefs: { choice: 'pack:owl' }, fetch }); w.display.start(); await tick();
  const b = tryAgain(w); assert.ok(b && b.tagName === 'BUTTON'); assert.strictEqual(b.hidden, false);
  await w.clk.advance(3100); assert.strictEqual(calls, 2); await w.clk.advance(6100); assert.strictEqual(calls, 3);   // the back-off is now 12 s away
  const before = calls; b.click(); assert.strictEqual(calls, before + 1, 'a request went out at once'); await tick();
  assert.strictEqual(w.clk.timers.length, 1); assert.strictEqual(w.clk.timers[0].at - w.clk.t, 3000, 'the back-off started over at 3 s');
  fail = false; b.click(); await tick();
  assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(tryAgain(w).hidden, true, 'hidden again once the list is in');
  w.display.release();
  // a call that wants no character never shows it
  const n = world({ prefs: { choice: 'orb' }, fetch }); n.display.start(); await tick();
  assert.strictEqual(tryAgain(n).hidden, true); n.display.release();
});

test('no retry timer survives hang-up or release', async () => {
  const mk = () => world({ prefs: { choice: 'pack:owl' }, fetch: async () => { throw new Error('down'); } });
  const a = mk(); a.display.start(); await tick(); assert.strictEqual(a.clk.timers.length, 1, 'one retry waiting');
  a.display.hangUp(); await a.clk.advance(5000); assert.strictEqual(a.clk.timers.length, 0, 'none pending after the end');
  const b = mk(); b.display.start(); await tick(); b.display.release(); assert.strictEqual(b.clk.timers.length, 0);
});

test('a null or missing agent default resolves to none without throwing', async () => {
  assert.strictEqual(CD.resolveDisplay({ choice: 'follow', agentDefault: null, packs: [] }).kind, 'none');
  assert.strictEqual(CD.resolveDisplay({ choice: 'follow', agentDefault: undefined }).kind, 'none');
  for (const agentDefault of [null, undefined, () => null, () => { throw new Error('no agent'); }]) {
    const dom = fakeDom(), clk = clock();
    const d = CD.createCallDisplay({ window: { document: dom.doc }, document: dom.doc, storage: memStorage(), fetch: okFetch({ packs: [] }), setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout, agentDefault, onHangUp() {}, createVoiceOrb: playerFactory('orb', []), createFacePlayer: playerFactory('pack', []) });
    assert.doesNotThrow(() => d.start()); await tick();
    assert.strictEqual(d.info().resolved.kind, 'none'); assert.strictEqual(d.info().kind, 'none'); d.release();
  }
});

// ── round 2: a deadline, malformed replies, reasons, sign-in, panel wording ──
const never = () => new Promise(() => {});
const noteText = (w) => w.dom.find('ucd-note')[0].textContent;
function fakeWindow() {
  const l = {}, counts = { add: 0, remove: 0 };
  const win = { document: null, addEventListener(t, f) { counts.add++; (l[t] = l[t] || []).push(f); }, removeEventListener(t, f) { counts.remove++; if (l[t]) l[t] = l[t].filter(x => x !== f); } };
  win.live = () => ['focus', 'online', 'visibilitychange'].reduce((n, t) => n + (l[t] || []).length, 0);   // the display's own resize listener is not counted
  win.fire = (t) => { for (const f of [...(l[t] || [])]) f(); };
  win.counts = counts;
  return win;
}
function worldWin(o) {
  const dom = fakeDom(), clk = clock(), win = fakeWindow(); win.document = dom.doc;
  const storage = memStorage({ [CD.DISPLAY_STORE_KEY]: JSON.stringify({ choice: 'pack:owl' }) });
  const page = dom.doc.createElement('div'), composer = dom.doc.createElement('div'); page.appendChild(composer); dom.doc.body.appendChild(page);
  const display = CD.createCallDisplay({
    window: win, document: dom.doc, storage, fetch: o.fetch, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout,
    dock: () => composer, adopt: () => [], onTalk() {}, onHangUp() {}, onChange() {},
    createVoiceOrb: playerFactory('orb', []), createFacePlayer: playerFactory('pack', []),
  });
  return { dom, clk, win, display };
}

test('a body that never arrives hits the 10 s deadline: loading, then couldn\'t check, then the owl once the next try answers', async () => {
  let calls = 0;
  const fetch = async () => { calls++; if (calls === 1) return { ok: true, status: 200, json: never }; return { ok: true, status: 200, json: async () => ({ packs: [OWL] }) }; };
  const w = world({ prefs: { choice: 'pack:owl' }, fetch });
  w.display.start(); await tick();
  assert.strictEqual(pickerLast(w), 'Owl · loading');
  await w.clk.advance(9900); assert.strictEqual(pickerLast(w), 'Owl · loading', 'still waiting before 10 s');
  await w.clk.advance(200); assert.strictEqual(w.display.info().packsState, 'failed'); assert.strictEqual(pickerLast(w), "Owl · couldn't check");
  assert.strictEqual(w.display.info().packsFailKind, 'network');
  await w.clk.advance(3100); assert.strictEqual(calls, 2);
  assert.strictEqual(pickerLast(w), 'Owl'); assert.strictEqual(w.display.info().kind, 'pack');
  w.display.release();
});

test('fetchFaces: the deadline covers the body, aborts the request, and a late body is ignored', async () => {
  const clk = clock(); let signal, release;
  const f = async (u, init) => { signal = init.signal; return { ok: true, status: 200, json: () => new Promise((r) => { release = r; }) }; };
  const p = CD.fetchFaces(f, { timeoutMs: 500, setTimeout: clk.setTimeout, clearTimeout: clk.clearTimeout });
  const out = p.then(() => 'ok', (e) => e.kind); await tick(); await clk.advance(600);
  assert.strictEqual(await out, 'network');
  if (signal) assert.strictEqual(signal.aborted, true);
  release({ packs: [OWL] }); await tick();   // late: nothing throws, nothing changes
  assert.strictEqual(clk.timers.length, 0);
});

test('a 200 without a packs array is a failure, never "not on this Maestro"', async () => {
  let calls = 0;
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; } });
  w.display.start(); await tick();
  assert.strictEqual(w.display.info().packsState, 'failed'); assert.strictEqual(pickerLast(w), "Owl · couldn't check");
  assert.strictEqual(w.display.info().packsFailKind, 'server');
  assert.ok(/Your Maestro had a problem sending the character list\. Trying again…/.test(w.display.info().note));
  assert.strictEqual(w.clk.timers.length, 1, 'a retry is scheduled'); assert.ok(!/not on this Maestro/.test(w.display.info().note + pickerLast(w)));
  w.display.release();
  await assert.rejects(CD.fetchFaces(okFetch({ packs: 'x' })), (e) => e.kind === 'server');
  const ok = await CD.fetchFaces(okFetch({ packs: [] })); assert.deepStrictEqual(ok.available, [], 'a missing available is [] (older hubs)');
});

test('fetchFaces kinds: 401/403 signin, other non-2xx and unreadable JSON server, a throw network', async () => {
  const kind = (f) => CD.fetchFaces(f).then(() => 'ok', (e) => e.kind);
  assert.strictEqual(await kind(async () => ({ ok: false, status: 401 })), 'signin');
  assert.strictEqual(await kind(async () => ({ ok: false, status: 403 })), 'signin');
  assert.strictEqual(await kind(async () => ({ ok: false, status: 500 })), 'server');
  assert.strictEqual(await kind(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })), 'server');
  assert.strictEqual(await kind(async () => { throw new TypeError('Failed to fetch'); }), 'network');
});

test('the note says why, by kind, and the picker stays "couldn\'t check"', async () => {
  const cases = [
    [async () => ({ ok: false, status: 401 }), "Couldn't get the character list: you're signed out here. Reload this page and sign in, then press Try again."],
    [async () => { throw new Error('x'); }, "Couldn't reach your Maestro for the character list. Trying again…"],
    [async () => ({ ok: false, status: 502 }), 'Your Maestro had a problem sending the character list. Trying again…'],
  ];
  for (const [fetch, text] of cases) {
    const w = world({ prefs: { choice: 'pack:owl' }, fetch }); w.display.start(); await tick();
    assert.strictEqual(noteText(w), text); assert.strictEqual(pickerLast(w), "Owl · couldn't check"); w.display.release();
  }
});

test('a sign-in refusal schedules no timer; a focus retries; hang-up leaves no listener', async () => {
  let calls = 0, ok = false;
  const fetch = async () => { calls++; return ok ? { ok: true, status: 200, json: async () => ({ packs: [OWL] }) } : { ok: false, status: 401 }; };
  const w = worldWin({ fetch }); w.display.start(); await tick();
  assert.strictEqual(w.clk.timers.length, 0, 'no back-off timer'); assert.strictEqual(w.win.live() > 0, true);
  await w.clk.advance(120000); assert.strictEqual(calls, 1, 'never retried by time');
  w.win.fire('focus'); await tick(); assert.strictEqual(calls, 2); assert.strictEqual(w.clk.timers.length, 0);
  assert.strictEqual(w.win.live(), 2, 'one set only: focus + online on the window (the fake document has no listener methods)');
  ok = true; w.win.fire('online'); await tick(); assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(w.win.live(), 0, 'removed on success');
  w.display.release();
  const h = worldWin({ fetch: async () => ({ ok: false, status: 403 }) }); h.display.start(); await tick();
  assert.ok(h.win.live() > 0); await h.display.hangUp(); assert.strictEqual(h.win.live(), 0, 'hang-up leaves no listener');
  assert.strictEqual(h.win.counts.add, h.win.counts.remove);
});

test('a sign-in refusal keeps one set of listeners however often it fails; Try again asks at once', async () => {
  let calls = 0;
  const w = worldWin({ fetch: async () => { calls++; return { ok: false, status: 401 }; } }); w.display.start(); await tick();
  const first = w.win.live();
  const b = tryAgain(w); assert.strictEqual(b.hidden, false); b.click(); await tick(); b.click(); await tick();
  assert.strictEqual(calls, 3); assert.strictEqual(w.win.live(), first, 'never two sets');
  w.display.release(); assert.strictEqual(w.win.live(), 0);
});

test('displayNote: "Trying again…" only where something retries; panels say to reopen', () => {
  const r = (failKind) => CD.resolveDisplay({ choice: 'pack:owl', packs: [], packsState: 'failed', packsFailKind: failKind });
  assert.strictEqual(CD.displayNote(r('network'), { retrying: true }), "Couldn't reach your Maestro for the character list. Trying again…");
  assert.strictEqual(CD.displayNote(r('network'), { retrying: false }), "Couldn't reach your Maestro for the character list. Reopen this panel to try again.");
  assert.strictEqual(CD.displayNote(r('server')), 'Your Maestro had a problem sending the character list. Reopen this panel to try again.');
  assert.strictEqual(CD.displayNote(r('signin'), { retrying: false }), "Couldn't get the character list: you're signed out here. Reload this page and sign in, then reopen this panel.");
  assert.strictEqual(CD.displayNote(r('signin'), { retrying: true }), "Couldn't get the character list: you're signed out here. Reload this page and sign in, then press Try again.");
  assert.strictEqual(CD.displayNote(r('signin')), CD.displayNote(r('signin'), { retrying: false }), 'default: nothing retries');
});

// ── round 3: a Try again that is in flight shows "Checking…" and disables the button ──
test('Try again with a fetch that never answers: button disabled, note "Checking…"; after the deadline the failure note and an enabled button are back', async () => {
  let calls = 0;
  const fetch = () => { calls++; return calls === 1 ? Promise.reject(new Error('offline')) : never(); };
  const w = world({ prefs: { choice: 'pack:owl' }, fetch }); w.display.start(); await tick();
  const failed = noteText(w); assert.ok(/Couldn't reach your Maestro/.test(failed));
  const b = tryAgain(w); assert.strictEqual(b.disabled, false);
  b.click(); await tick();
  assert.strictEqual(calls, 2); assert.strictEqual(b.disabled, true, 'disabled while checking'); assert.strictEqual(noteText(w), 'Checking…'); assert.strictEqual(w.display.info().note, 'Checking…');
  await w.clk.advance(9900); assert.strictEqual(noteText(w), 'Checking…', 'still checking before the deadline'); assert.strictEqual(b.disabled, true);
  await w.clk.advance(200);
  assert.strictEqual(w.display.info().packsState, 'failed'); assert.strictEqual(noteText(w), failed, 'the failure sentence is back'); assert.strictEqual(b.disabled, false);
  w.display.release();
});

test('a focus after a sign-in refusal shows "Checking…" until the answer; an automatic retry does not', async () => {
  let calls = 0, hold;
  const fetch = () => { calls++; return calls === 1 ? Promise.resolve({ ok: false, status: 401 }) : new Promise((r) => { hold = r; }); };
  const w = worldWin({ fetch }); w.display.start(); await tick();
  assert.ok(/signed out here/.test(noteText(w)));
  w.win.fire('focus'); await tick();
  assert.strictEqual(noteText(w), 'Checking…'); assert.strictEqual(tryAgain(w).disabled, true);
  hold({ ok: true, status: 200, json: async () => ({ packs: [OWL] }) }); await tick();
  assert.strictEqual(w.display.info().packsState, 'ready'); assert.strictEqual(tryAgain(w).hidden, true);
  w.display.release();
  const auto = world({ prefs: { choice: 'pack:owl' }, fetch: (() => { let n = 0; return () => (++n === 1 ? Promise.reject(new Error('x')) : never()); })() }); auto.display.start(); await tick();
  await auto.clk.advance(3100); assert.ok(!/Checking/.test(noteText(auto)), 'the timer retry keeps the failure sentence'); assert.strictEqual(tryAgain(auto).disabled, false);
  auto.display.release();
});

// ── round 3: a focused picker is refilled on blur with the latest result, not before a newer paint ──
function between(src, a, b) { const i = src.indexOf(a); const j = src.indexOf(b, i); assert.ok(i >= 0 && j > i, 'markers ' + a); return src.slice(i, j); }
const fs = require('fs'), path = require('path');
function blurHarness(srcName, startMark, endMark, mkEnv) {
  const src = fs.readFileSync(path.join(__dirname, '..', srcName), 'utf8');
  const code = between(src, startMark, endMark);
  return code;
}
test('both pages: a picker skipped while focused gets one blur listener that refills it with the latest result, guarded by the paint generation (source)', () => {
  const app = blurHarness('app.js', 'const voiceDispPendingBlur', 'function voiceDispSetCaptions');
  const mob = blurHarness('mobile.js', 'const voiceDispPendingBlur', 'function voiceDispSetCaptions');
  for (const [name, code] of [['app.js', app], ['mobile.js', mob]]) {
    assert.ok(/sel\.addEventListener\('blur'[\s\S]*\{ once: true \}/.test(code), name + ': a one-time blur listener');
    assert.ok(/if \(have\) \{ have\.args = args; have\.isLatest = isLatest; return; \}/.test(code), name + ': a newer pending result replaces the old, never a second listener');
    assert.ok(/sel\.isConnected === false \|\| !ent\.isLatest\(\)/.test(code), name + ': connected and latest checks on blur');
    assert.ok(/CallDisplay\.fillDisplaySelect\(document, sel, ent\.args\)/.test(code), name + ': refills with the remembered result');
    assert.ok(/voiceDispRefillOnBlur\(sel, args, \(\) =>/.test(code), name + ': fillAll hands the skipped picker over');
  }
  assert.ok(/voiceDisp\.paintGen\.get\(chatId\) === my/.test(app), 'desktop generation check');
  assert.ok(/voiceDisp\.paintGen === my/.test(mob), 'phone generation check');
});
test('the blur refill behaves: latest result wins, one listener, stale or disconnected select untouched (run on the page code)', () => {
  for (const [file, gen] of [['app.js', 'cur'], ['mobile.js', 'cur']]) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const i = src.indexOf('const voiceDispPendingBlur'), j = src.indexOf('voiceDispPendingBlur.set(sel, ent);', i);
    const head = src.slice(i, src.indexOf('async function voiceDispPaintPanel', i));
    const filled = [];
    const CallDisplay = { fillDisplaySelect: (d, s, a) => filled.push([s, a.state]) };
    const fn = new Function('CallDisplay', 'document', head + '; return voiceDispRefillOnBlur;')(CallDisplay, {});
    const mk = () => { const s = { isConnected: true, n: 0, l: [], addEventListener(t, f) { assert.strictEqual(t, 'blur'); s.n++; s.l.push(f); } }; return s; };
    const s = mk(); let g = 1;
    fn(s, { state: 'loading' }, () => g === 1); fn(s, { state: 'ready' }, () => g === 1);
    assert.strictEqual(s.n, 1, file + ': one listener'); s.l[0]();
    assert.deepStrictEqual(filled.map(x => x[1]), ['ready'], file + ': the latest result');
    const t = mk(); fn(t, { state: 'ready' }, () => g === 1); g = 2; t.l[0]();
    assert.strictEqual(filled.length, 1, file + ': a newer paint happened: nothing');
    const u = mk(); g = 3; fn(u, { state: 'ready' }, () => g === 3); u.isConnected = false; u.l[0]();
    assert.strictEqual(filled.length, 1, file + ': disconnected: nothing');
    assert.ok(j > i);
  }
});

test('Try again sits in the note\'s wrapper right after the note; docked, a failed list shows the wrapper', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: async () => ({ ok: false, status: 500 }) }); w.display.start(); await tick();
  const box = w.dom.find('ucd-notebox')[0], note = w.dom.find('ucd-note')[0];
  assert.deepStrictEqual(box.children.map(c => c.className.split(' ')[0]), ['ucd-note', 'cd-download-retry']);
  assert.ok(/ucd-listfail/.test(box.className) && box.hidden === false);
  w.display.release();
  const ok = world({ prefs: { choice: 'pack:owl' }, fetch: okFetch({ packs: [OWL] }) }); ok.display.start(); await tick();
  const b2 = ok.dom.find('ucd-notebox')[0]; assert.ok(!/ucd-listfail/.test(b2.className)); assert.strictEqual(b2.hidden, true); ok.display.release();
});
