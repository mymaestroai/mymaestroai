'use strict';
// The call's Display picker never says "not installed" for a list that is loading or failed (lib/ui-call-display.js):
// option text per list state, remembered names, back-off retry of a failed list, the Try now button, timers cleared at hang-up.
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
const tryAgain = (w) => w.dom.find('cd-download-retry').filter(b => b.textContent === 'Try now')[0];
function selectFor(opts) {
  const dom = fakeDom(); const sel = dom.doc.createElement('select');
  CD.fillDisplaySelect(dom.doc, sel, opts);
  return sel.children.map(c => c.textContent);
}

test('fillDisplaySelect: a stored pack the list lacks reads by list state, never "(not installed)"', () => {   // suffixes: loading / can't check / not here
  const base = { choice: 'pack:owl', packs: [], available: [] };
  assert.strictEqual(selectFor({ ...base, state: 'loading' }).slice(-1)[0], 'Owl · loading');
  assert.strictEqual(selectFor({ ...base, state: 'failed' }).slice(-1)[0], "Owl · can't check");
  assert.strictEqual(selectFor({ ...base, state: 'ready' }).slice(-1)[0], 'Owl · not here');
  assert.strictEqual(selectFor(base).slice(-1)[0], 'Owl · not here', 'an array of packs without a state is ready');
  assert.strictEqual(selectFor({ choice: 'pack:owl', packs: [{ id: 'owl', name: 'Barn Owl' }], state: 'ready' }).slice(-1)[0], 'Barn Owl', 'installed: its name, no suffix');
  assert.strictEqual(selectFor({ ...base, available: [{ id: 'owl', name: 'Owl', size: 37000000 }], state: 'ready' }).slice(-1)[0], 'Owl · downloads 37 MB');
  assert.strictEqual(selectFor({ ...base, state: 'failed', names: { owl: 'Night Owl' } }).slice(-1)[0], "Night Owl · can't check", 'a remembered name beats the capitalised id');
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
  assert.strictEqual(pickerLast(w), "Owl · can't check");
  assert.ok(/Couldn't reach your Maestro for the character list\. Trying again…/.test(w.display.info().note) && !/not installed/.test(w.display.info().note));
  await w.clk.advance(2900); assert.strictEqual(calls, 1, 'not before 3 s');
  await w.clk.advance(200); assert.strictEqual(calls, 2); assert.strictEqual(pickerLast(w), "Owl · can't check");
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

test('Try now shows only while the list failed, asks at once and starts the back-off over', async () => {
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
  await w.clk.advance(200); assert.strictEqual(w.display.info().packsState, 'failed'); assert.strictEqual(pickerLast(w), "Owl · can't check");
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
  assert.strictEqual(w.display.info().packsState, 'failed'); assert.strictEqual(pickerLast(w), "Owl · can't check");
  assert.strictEqual(w.display.info().packsFailKind, 'server');
  assert.ok(/Your Maestro had a problem sending the character list\. Trying again…/.test(w.display.info().note));
  assert.strictEqual(w.clk.timers.length, 1, 'a retry is scheduled'); assert.ok(!/not on this Maestro/.test(w.display.info().note + pickerLast(w)));
  w.display.release();
  await assert.rejects(CD.fetchFaces(okFetch({ packs: 'x' })), (e) => e.kind === 'server');
  const ok = await CD.fetchFaces(okFetch({ packs: [] })); assert.deepStrictEqual(ok.available, [], 'a missing available is [] (older hubs)');
});

test('fetchFaces kinds: 401 signin, 403 refused, other non-2xx and unreadable JSON server, a throw network', async () => {
  const kind = (f) => CD.fetchFaces(f).then(() => 'ok', (e) => e.kind);
  assert.strictEqual(await kind(async () => ({ ok: false, status: 401 })), 'signin');
  assert.strictEqual(await kind(async () => ({ ok: false, status: 403 })), 'refused', '403 is refused, NOT signin');
  assert.strictEqual(await kind(async () => ({ ok: false, status: 500 })), 'server');
  assert.strictEqual(await kind(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } })), 'server');
  assert.strictEqual(await kind(async () => { throw new TypeError('Failed to fetch'); }), 'network');
});

test('the note says why, by kind, and the picker stays "couldn\'t check"', async () => {
  const cases = [
    [async () => ({ ok: false, status: 401 }), "You're signed out here, so the character list couldn't load. Hang up, reload this page and sign in.", false],
    [async () => { throw new Error('x'); }, "Couldn't reach your Maestro for the character list. Trying again…", true],
    [async () => ({ ok: false, status: 502 }), 'Your Maestro had a problem sending the character list. Trying again…', true],
    [async () => ({ ok: false, status: 403 }), 'Your Maestro refused the request for the character list. Trying again…', true],
  ];
  for (const [fetch, text, button] of cases) {
    const w = world({ prefs: { choice: 'pack:owl' }, fetch }); w.display.start(); await tick();
    assert.strictEqual(noteText(w), text); assert.strictEqual(pickerLast(w), "Owl · can't check");
    assert.strictEqual(!!tryAgain(w) && tryAgain(w).hidden === false, button, 'Try now shows for every kind but signin: ' + text);
    w.display.release();
  }
});

test('a 403 is refused: it retries on the back-off timer like network/server (a sign-in refusal does not)', async () => {
  let calls = 0;
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: async () => { calls++; return { ok: false, status: 403 }; } }); w.display.start(); await tick();
  assert.strictEqual(w.display.info().packsFailKind, 'refused'); assert.strictEqual(w.clk.timers.length, 1);
  await w.clk.advance(3100); assert.strictEqual(calls, 2); assert.strictEqual(w.clk.timers.length, 1);
  w.display.release();
});

test('absent (the list answered without the character): the note shows on the call view and docked, with no button', async () => {
  const w = world({ prefs: { choice: 'pack:owl' }, fetch: okFetch({ packs: [{ id: 'fox', name: 'Fox' }] }) }); w.display.start(); await tick();
  const text = "The chosen character isn't on this Maestro, so no display is shown. Pick another one; your choice is kept.";
  assert.strictEqual(noteText(w), text);
  const box = w.dom.find('ucd-notebox')[0];
  assert.strictEqual(box.hidden, false); assert.ok(/ucd-absent/.test(box.className), 'docked CSS shows an absent note');
  assert.strictEqual(tryAgain(w).hidden, true);
  w.display.release();
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-call-display.css'), 'utf8');
  assert.ok(css.includes('.ucd-docked .ucd-notebox:not(.ucd-listfail):not(.ucd-absent) { display: none !important; }'), 'docked hides the wrapper only when neither failed nor absent');
});

test('loading note and panel words: the single … character everywhere', () => {
  assert.strictEqual(CD.displayNote(CD.resolveDisplay({ choice: 'pack:owl', packsState: 'loading' })), 'Looking for the chosen character…');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-call-display.js'), 'utf8');
  assert.ok(!/Looking for the chosen character\.\.\./.test(src) && !/couldn't check'|"Try again'|'Try again'/.test(src), 'old words are gone from the library');
});

test('docked CSS: a note grows the bar upward and never past the bottom (the bar row is last, the root never shrinks, siblings may shrink)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-call-display.css'), 'utf8');
  assert.ok(css.includes('.ucd-overlay.ucd-docked { flex-shrink: 0; margin-top: auto; }'), 'the docked root keeps its size and sits at the bottom');
  assert.ok(css.includes('.ucd-docked .ucd-bar { flex-shrink: 0; }'), 'the bar row never shrinks');
  assert.ok(css.includes(':where(:has(> .ucd-overlay.ucd-docked) > :not(.ucd-overlay)) { min-height: 0; }'), 'the stage above (the chat) shrinks instead of pushing the bar off screen');
  assert.ok(/\.ucd-docked \.ucd-notebox \{ position: static; flex: 1 1 100%; \}/.test(css), 'the docked note wrapper is in the flow of the stage (above the bar row), not over it');
  assert.ok(!/\.ucd-docked \.ucd-notebox[^{]*\{[^}]*position: (absolute|fixed)/.test(css), 'never positioned over the bar');
});

// ── round 4: the settings panels (run on the page code) ──
function panelHarness(file, o) {
  const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const i = src.indexOf('async function voiceDispPaintPanel'), j = src.indexOf('// One download per character id', i);
  const code = src.slice(i, j);
  const dom = fakeDom(), clk = clock();
  const sel = dom.doc.createElement('select'); sel.id = file === 'app.js' ? 'vp-display-c1' : 'vp-display';
  const wrap = dom.doc.createElement('div'), note = dom.doc.createElement('div'); note.id = file === 'app.js' ? 'vp-display-note-c1' : 'vp-display-note';
  wrap.appendChild(sel); wrap.appendChild(note); dom.doc.body.appendChild(wrap);
  const byId = (id) => (id === sel.id ? sel : id === note.id ? note : null);
  const storage = memStorage({ [CD.DISPLAY_STORE_KEY]: JSON.stringify({ choice: o.choice || 'pack:owl' }) });
  const voiceDisp = {};
  const env = { CallDisplay: CD, localStorage: storage, document: dom.doc, fetch: o.fetch, voiceDisp, voiceById: byId, $: byId, chats: { c1: { agent: 'a' } }, current: 'a',
    voiceDispAgentDefault: () => 'none', voiceDispRefillOnBlur() {}, voiceDispDownloadFor() {}, voiceDispPaintDownload() {} };
  const names = Object.keys(env);
  const fn = new Function(...names, code + '; return voiceDispPaintPanel;')(...names.map((k) => env[k]));
  const paint = (asked) => (file === 'app.js' ? fn('c1', asked) : fn(asked));
  return { paint, sel, note, voiceDisp, texts: () => sel.children.map((c) => c.textContent) };
}
for (const file of ['app.js', 'mobile.js']) {
  const panelBtn = (h) => h.note.cdListRetry;
  test(file + ' panel: each failure kind gives its first sentence and a Try now button (not for signin); Try now repaints at once with "Checking…"', async () => {
    const cases = [
      [{ ok: false, status: 401 }, "You're signed out here, so the character list couldn't load. Reload this page and sign in.", false],
      [new Error('down'), "Couldn't reach your Maestro for the character list.", true],
      [{ ok: false, status: 500 }, 'Your Maestro had a problem sending the character list.', true],
      [{ ok: false, status: 403 }, 'Your Maestro refused the request for the character list.', true],
    ];
    for (const [reply, text, button] of cases) {
      let calls = 0, hold = null;
      const h = panelHarness(file, { fetch: async () => { calls++; if (calls === 1) { if (reply instanceof Error) throw reply; return reply; } return new Promise((r) => { hold = r; }); } });
      await h.paint(); await tick();
      assert.strictEqual(h.note.textContent, text); assert.strictEqual(h.texts().slice(-1)[0], "Owl · can't check");
      const b = panelBtn(h);
      assert.strictEqual(!!b && b.parentNode === h.note.parentNode, button, 'button present for ' + text);
      if (!button) continue;
      assert.strictEqual(b.textContent, 'Try now'); assert.strictEqual(b.attrs['aria-label'], 'Try loading the character list now'); assert.strictEqual(b.disabled, false);
      b.click(); await tick();
      assert.strictEqual(calls, 2, 'the repaint asked at once');
      assert.strictEqual(h.note.textContent, 'Checking…'); assert.strictEqual(panelBtn(h).disabled, true, 'disabled while it runs');
      hold({ ok: true, status: 200, json: async () => ({ packs: [OWL] }) }); await tick();
      assert.strictEqual(h.note.textContent, ''); assert.strictEqual(panelBtn(h) || null, null, 'the button is gone once the list is in'); assert.strictEqual(h.texts().slice(-1)[0], 'Owl');
    }
  });
  test(file + ' panel: the interim paint reuses the last good list and clears a stale note; "loading" only for a chosen pack that list lacks', async () => {
    let step = 0, hold = null;
    const h = panelHarness(file, { choice: 'pack:owl', fetch: async () => { step++; if (step === 1) return { ok: true, status: 200, json: async () => ({ packs: [OWL, { id: 'fox', name: 'Fox' }] }) }; if (step === 2) throw new Error('down'); return new Promise((r) => { hold = r; }); } });
    await h.paint(); await tick(); assert.deepStrictEqual(h.texts().slice(-2), ['Owl', 'Fox']);
    await h.paint(); await tick(); assert.ok(/Couldn't reach/.test(h.note.textContent));
    h.paint(); await tick();   // third paint: the request hangs, the panel is on its interim paint
    assert.ok(h.texts().includes('Fox'), 'other installed characters stay during the repaint'); assert.ok(h.texts().includes('Owl'), 'the chosen one is in the last good list: not "loading"');
    assert.ok(!h.texts().some((t) => /loading/.test(t)), 'no loading suffix'); assert.strictEqual(h.note.textContent, '', 'the stale failure note is cleared');
    hold({ ok: true, status: 200, json: async () => ({ packs: [OWL, { id: 'fox', name: 'Fox' }] }) }); await tick();
    // a chosen pack the good list lacks: loading
    let hold2 = null;
    const g = panelHarness(file, { choice: 'pack:bat', fetch: (() => { let n = 0; return async () => { n++; if (n === 1) return { ok: true, status: 200, json: async () => ({ packs: [OWL] }) }; return new Promise((r) => { hold2 = r; }); }; })() });
    await g.paint(); await tick(); g.paint(); await tick();
    assert.ok(g.texts().includes('Owl') && g.texts().slice(-1)[0] === 'Bat · loading', g.texts().join('|'));
    hold2({ ok: true, status: 200, json: async () => ({ packs: [OWL] }) }); await tick();   // lets the request (and its deadline timer) finish
  });
}

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
  const h = worldWin({ fetch: async () => ({ ok: false, status: 401 }) }); h.display.start(); await tick();
  assert.ok(h.win.live() > 0); await h.display.hangUp(); assert.strictEqual(h.win.live(), 0, 'hang-up leaves no listener');
  assert.strictEqual(h.win.counts.add, h.win.counts.remove);
});

test('a sign-in refusal has no Try now button and keeps one set of listeners however often a focus fires', async () => {
  let calls = 0;
  const w = worldWin({ fetch: async () => { calls++; return { ok: false, status: 401 }; } }); w.display.start(); await tick();
  const first = w.win.live();
  assert.strictEqual(tryAgain(w).hidden, true, 'no Try now while signed out');
  w.win.fire('focus'); await tick(); w.win.fire('focus'); await tick();
  assert.strictEqual(calls, 3); assert.strictEqual(w.win.live(), first, 'never two sets'); assert.strictEqual(w.clk.timers.length, 0);
  w.display.release(); assert.strictEqual(w.win.live(), 0);
});

test('displayNote: "Trying again…" only where something retries; panels give the first sentence alone', () => {
  const r = (failKind) => CD.resolveDisplay({ choice: 'pack:owl', packs: [], packsState: 'failed', packsFailKind: failKind });
  assert.strictEqual(CD.displayNote(r('network'), { retrying: true }), "Couldn't reach your Maestro for the character list. Trying again…");
  assert.strictEqual(CD.displayNote(r('network'), { retrying: false }), "Couldn't reach your Maestro for the character list.");
  assert.strictEqual(CD.displayNote(r('server')), 'Your Maestro had a problem sending the character list.');
  assert.strictEqual(CD.displayNote(r('refused'), { retrying: true }), 'Your Maestro refused the request for the character list. Trying again…');
  assert.strictEqual(CD.displayNote(r('refused')), 'Your Maestro refused the request for the character list.');
  assert.strictEqual(CD.displayNote(r('signin'), { retrying: false }), "You're signed out here, so the character list couldn't load. Reload this page and sign in.");
  assert.strictEqual(CD.displayNote(r('signin'), { retrying: true }), "You're signed out here, so the character list couldn't load. Hang up, reload this page and sign in.");
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
  assert.strictEqual(noteText(w), 'Checking…'); assert.strictEqual(tryAgain(w).hidden, true, 'still no button for a sign-in refusal');
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

test('settings panels: a failed list after a good one shows the choice as can\'t check, and only the newest answer updates the cache (both pages)', () => {
  const fs = require('fs');
  for (const f of ['app.js', 'mobile.js']) {
    const src = fs.readFileSync(require('path').join(__dirname, '..', f), 'utf8');
    const i = src.indexOf('function voiceDispPaintPanel');
    assert.ok(i > 0, f + ': panel paint found');
    const body = src.slice(i, src.indexOf('\n}', i) > 0 ? i + 6000 : undefined);
    const tryLine = body.slice(body.indexOf('await CallDisplay.fetchFaces'));
    const catchPart = tryLine.slice(tryLine.indexOf('catch (e)'), tryLine.indexOf('\n'));
    assert.match(catchPart, /packs = \[\]; available = \[\];/, f + ': the failure path drops the cached list');
    assert.ok(!/lastGood/.test(tryLine.slice(0, tryLine.indexOf('catch (e)'))), f + ': the cache is not written before the freshness check');
    const gen = body.indexOf('a newer paint started meanwhile');
    const cache = body.indexOf("if (state === 'ready') voiceDisp.lastGood");
    assert.ok(gen > 0 && cache > gen, f + ': the cache is written after the freshness check');
  }
});
