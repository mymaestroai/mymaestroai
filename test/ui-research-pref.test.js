'use strict';
// The person's deep research choice in Settings: desktop (app.js) and phone (mobile.html / mobile.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const mob = read('mobile.js');
const html = read('mobile.html');

// The source of one top-level function (by brace matching from its first "{" after the signature).
function fnSrc(src, name) {
  let i = src.indexOf('async function ' + name + '(');
  if (i < 0) i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'missing function ' + name);
  const open = src.indexOf('{', src.indexOf(')', i));
  let depth = 0, k = open;
  for (; k < src.length; k++) {
    const c = src[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(i, k + 1);
}
const lineOf = (src, startsWith) => { const l = src.split('\n').find(x => x.trim().startsWith(startsWith)); assert.ok(l, 'missing line ' + startsWith); return l; };

test('phone html: the row starts hidden in the Your notifications group; the sheet exists', () => {
  assert.match(html, /<button id="menu-research" hidden>Deep research: Ask each time<\/button>/);
  const g = html.indexOf('data-group="notify"'), next = html.indexOf('data-group="account"');
  const r = html.indexOf('id="menu-research"');
  assert.ok(g > 0 && r > g && r < next, 'inside the notify group');
  // menu split (gear = what you set, ⋯ = what you do): the group is "Your notifications" and ends with the row (Active at the top moved to This device)
  assert.ok(html.includes('id="menu-gt-notify">Your notifications<'));
  assert.ok(html.indexOf('id="menu-notify-prefs"') > g && html.indexOf('id="menu-notify-prefs"') < r);
  assert.ok(html.indexOf('id="menu-active-top"') < g && html.indexOf('id="menu-active-top"') > html.indexOf('data-group="device"'), 'Active at the top is in This device');
  assert.ok(!html.slice(g, next).includes('id="menu-active-top"') && !html.slice(g, next).includes('id="menu-notify-test"'));
  assert.ok(html.includes('<dialog id="research-sheet"'));
  assert.match(html, /#research-sheet button \{[^}]*min-height: 44px/);
  assert.match(html, /html\.mm-simple \.ss-rseg button \{[^}]*min-height: 48px/);
});

test('phone js: GET shows the row only when on; POST body is { choice }; menu groups are re-counted', () => {
  assert.ok(mob.includes("api('/api/research-pref')"));
  assert.match(mob, /api\('\/api\/research-pref', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ choice \}\) \}\)/);
  // menu split: an admin's Deep research choice is in Settings → Notifications, so the menu row is hidden for admins too
  assert.match(mob, /row\.hidden = !researchPrefOn \|\| !!\(hubMe && hubMe\.isAdmin\);/);
  assert.match(mob, /researchPrefOn = !!\(d && d\.on === true\);/);
  assert.match(fnSrc(mob, 'researchPrefPaintAll'), /typeof menuGroupsSync === 'function' && menuGroupsSync\(\)/);
  assert.ok(mob.includes("$('menu-research')?.addEventListener('click'"));
  assert.match(mob, /typeof researchPrefLoad === 'function' && researchPrefLoad\(\)/);
});

test('phone js: the Simple settings sheet gets the section after Appearance, only when on, via textContent', () => {
  const open = fnSrc(mob, 'simpleSettingsOpen');
  assert.match(open, /typeof researchSimplePaint === 'function' && researchSimplePaint\(d\)/);
  const paint = fnSrc(mob, 'researchSimplePaint');
  assert.match(paint, /'Deep research'/);
  assert.match(paint, /if \(!researchPrefOn\) return;/);
  assert.match(paint, /anchor\.after\(sec\)/);
  const a = open.indexOf('>Light or dark<'), s = open.indexOf('>Look of the interface<');
  assert.ok(a > 0 && s > a);
});

test('all research code uses textContent, never innerHTML', () => {
  for (const [src, names] of [[mob, ['researchSheetPaint', 'researchSimplePaint', 'researchPrefPaintAll', 'researchPick', 'researchPrefLoad']], [app, ['researchPrefPaint', 'researchPrefLoad']]]) {
    for (const n of names) assert.ok(!/innerHTML/.test(fnSrc(src, n)), n + ' must not use innerHTML');
  }
});

test('one save at a time and the previous choice goes back on failure (phone source)', () => {
  const pick = fnSrc(mob, 'researchPick');
  assert.match(pick, /if \(researchPrefSaving \|\| !researchPrefOn/);
  assert.match(pick, /researchPrefSaving = true;/);
  assert.match(pick, /researchPrefSaving = false;/);
  assert.match(pick, /if \(err\) researchPrefChoice = before;/);
  assert.match(pick, /'Could not save that'/);
  assert.match(pick, /\(d && d\.error\)/);
});

test('desktop: the control sits in the Notifications section of Settings, hidden until GET says on', () => {
  const n = app.indexOf('id="st-notify-section"'), r = app.indexOf('id="st-research-pref"'), m = app.indexOf('id="st-notify-mine"');
  assert.ok(n > 0 && r > n && r < m, 'inside st-notify-section, before the person\'s own notification list');
  assert.match(app, /<div id="st-research-pref" role="group" aria-label="Deep research" hidden><\/div>/);
  assert.match(app, /typeof researchPrefLoad === 'function' && researchPrefLoad\(\)/);
  const load = fnSrc(app, 'researchPrefLoad');
  assert.ok(load.includes("fetch('/api/research-pref', { credentials: 'include' })"));
  assert.match(load, /d\.on !== true\) \{ box\.hidden = true; return; \}/);
  const paint = fnSrc(app, 'researchPrefPaint');
  assert.ok(paint.includes("fetch('/api/research-pref', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ choice: want }) })"));
  assert.match(paint, /lab\.textContent = 'Deep research'/);
  assert.match(paint, /if \(researchPrefSaving\) \{ sel\.value = researchPrefChoice; return; \}/);
  assert.match(paint, /researchPrefChoice = before; hubToast\(String\(err\)\)/);
  assert.match(paint, /'Could not save that'/);
  assert.ok(app.includes("const RESEARCH_HINT = 'When a question needs research, your agents can offer a deep research run (a few minutes, many sources).';"));
  assert.ok(mob.includes("const RESEARCH_HINT = 'When a question needs research, your agents can offer a deep research run (a few minutes, many sources).';"));
});

test('no U+FE0F in the new code', () => {
  for (const [src, names] of [[mob, ['researchSheetPaint', 'researchSimplePaint', 'researchPick']], [app, ['researchPrefPaint', 'researchPrefLoad']]]) {
    for (const n of names) assert.ok(!fnSrc(src, n).includes('\uFE0F'), n);
  }
  assert.ok(!html.slice(html.indexOf('id="menu-research"'), html.indexOf('id="menu-research"') + 80).includes('\uFE0F'));
});

// ── pure helpers, run in a vm ──
for (const [name, src] of [['phone', mob], ['desktop', app]]) {
  test(`${name}: the label helper maps a choice to its text`, () => {
    const code = lineOf(src, 'const RESEARCH_CHOICES') + '\n' + fnSrc(src, 'researchChoiceLabel') + '\nthis.f = researchChoiceLabel;';
    const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx);
    assert.strictEqual(ctx.f('ask'), 'Ask each time');
    assert.strictEqual(ctx.f('always'), 'Always');
    assert.strictEqual(ctx.f('never'), 'Never');
    assert.strictEqual(ctx.f('bogus'), 'Ask each time');
    assert.strictEqual(ctx.f(undefined), 'Ask each time');
  });
}

// ── the phone's save logic against a stubbed hub ──
function phone(apiImpl) {
  const toasts = [], calls = [];
  const ctx = {
    toast: (t) => toasts.push(t),
    $: () => null,   // no DOM in this sandbox: painting does nothing
    api: async (p, o) => { calls.push({ p, o }); return apiImpl(p, o); },
  };
  vm.createContext(ctx);
  const code = [lineOf(mob, 'const RESEARCH_CHOICES'), lineOf(mob, 'function researchChoiceLabel'), lineOf(mob, 'function researchMenuText'), lineOf(mob, 'function researchChoiceOk'), lineOf(mob, 'const RESEARCH_LEVELS'), lineOf(mob, 'function researchLevelOk'),
    'let researchPrefOn = false; let researchPrefChoice = "ask"; let researchPrefLevel = "quick"; let researchPrefSaving = false; let researchPrefReadSeq = 0;',
    'function researchPrefPaintAll() {}',
    fnSrc(mob, 'researchPrefLoad'), fnSrc(mob, 'researchPick'), fnSrc(mob, 'researchLevelPick'),
    'this.h = { load: researchPrefLoad, pick: researchPick, level: researchLevelPick, menu: researchMenuText, state: () => JSON.stringify({ on: researchPrefOn, choice: researchPrefChoice, level: researchPrefLevel, saving: researchPrefSaving }) };'].join('\n');
  vm.runInContext(code, ctx);
  const h = { load: ctx.h.load, pick: ctx.h.pick, level: ctx.h.level, menu: ctx.h.menu, state: () => JSON.parse(ctx.h.state()) };   // plain objects from this realm
  return { h, toasts, calls };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('unreadable'); return body; } });

test('phone: GET on shows the choice; off, failed and unreadable GET show nothing', async () => {
  let p = phone(async () => res(200, { on: true, choice: 'always' }));
  assert.strictEqual(await p.h.load(), true);
  assert.deepStrictEqual(p.h.state(), { on: true, choice: 'always', level: 'quick', saving: false });
  assert.strictEqual(p.calls[0].p, '/api/research-pref');
  for (const impl of [async () => res(200, { on: false, choice: 'never' }), async () => res(500, { error: 'x' }), async () => res(200, undefined), async () => { throw new Error('offline'); }]) {
    p = phone(impl);
    assert.strictEqual(await p.h.load(), false);
    assert.strictEqual(p.h.state().on, false);
  }
  p = phone(async () => res(200, { on: true, choice: 'weird' }));
  await p.h.load();
  assert.strictEqual(p.h.state().choice, 'ask');
});

test('phone: a pick POSTs { choice } and keeps it; a failed save puts the previous choice back with the server text', async () => {
  let p = phone(async (path, o) => (o && o.method === 'POST' ? res(200, { ok: true, choice: JSON.parse(o.body).choice }) : res(200, { on: true, choice: 'ask' })));
  await p.h.load();
  assert.strictEqual(await p.h.pick('never'), true);
  const post = p.calls.find(c => c.o && c.o.method === 'POST');
  assert.strictEqual(post.p, '/api/research-pref');
  assert.deepStrictEqual(JSON.parse(post.o.body), { choice: 'never' });
  assert.strictEqual(post.o.headers['Content-Type'], 'application/json');
  assert.strictEqual(p.h.state().choice, 'never');
  assert.strictEqual(p.toasts.at(-1), 'Deep research: Never');

  p = phone(async (path, o) => (o && o.method === 'POST' ? res(403, { error: 'Not allowed here' }) : res(200, { on: true, choice: 'always' })));
  await p.h.load();
  assert.strictEqual(await p.h.pick('never'), false);
  assert.strictEqual(p.h.state().choice, 'always');
  assert.strictEqual(p.toasts.at(-1), 'Not allowed here');

  p = phone(async (path, o) => { if (o && o.method === 'POST') throw new Error('offline'); return res(200, { on: true, choice: 'ask' }); });
  await p.h.load();
  assert.strictEqual(await p.h.pick('always'), false);
  assert.strictEqual(p.h.state().choice, 'ask');
  assert.strictEqual(p.toasts.at(-1), 'Could not save that');

  p = phone(async (path, o) => (o && o.method === 'POST' ? res(400, undefined) : res(200, { on: true, choice: 'ask' })));
  await p.h.load();
  await p.h.pick('always');
  assert.strictEqual(p.toasts.at(-1), 'Could not save that');
  assert.strictEqual(p.h.state().choice, 'ask');
});

test('phone: a choice made while a save is in flight is ignored', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const p = phone(async (path, o) => { if (o && o.method === 'POST') { await gate; return res(200, { ok: true, choice: JSON.parse(o.body).choice }); } return res(200, { on: true, choice: 'ask' }); });
  await p.h.load();
  const first = p.h.pick('always');
  assert.strictEqual(p.h.state().saving, true);
  assert.strictEqual(await p.h.pick('never'), false);   // ignored
  release();
  assert.strictEqual(await first, true);
  assert.strictEqual(p.calls.filter(c => c.o && c.o.method === 'POST').length, 1);
  assert.strictEqual(p.h.state().choice, 'always');
  assert.strictEqual(p.h.state().saving, false);
});

test('phone: a pick is ignored while the feature is off', async () => {
  const p = phone(async () => res(200, { on: false, choice: 'ask' }));
  await p.h.load();
  assert.strictEqual(await p.h.pick('never'), false);
  assert.strictEqual(p.calls.length, 1);
});

test('phone (review r1): a read that began before a save never repaints the older choice', async () => {
  let releaseGet;
  const getGate = new Promise(r => { releaseGet = r; });
  let gets = 0;
  const p = phone(async (path, o) => {
    if (o && o.method === 'POST') return res(200, { ok: true, choice: JSON.parse(o.body).choice });
    gets++;
    if (gets === 2) { await getGate; return res(200, { on: true, choice: 'ask' }); }   // the slow read still says ask
    return res(200, { on: true, choice: 'ask' });
  });
  await p.h.load();
  const slowRead = p.h.load();             // a read on its way (the menu opened)
  assert.strictEqual(await p.h.pick('never'), true);
  releaseGet();
  await slowRead;
  assert.strictEqual(p.h.state().choice, 'never', 'the older read did not put ask back');
});

// ── levels: Always yes runs Quick or Thorough ──
test('phone: the menu row text appends (Thorough) only for always + thorough', () => {
  const p = phone(async () => res(200, { on: true, choice: 'ask' }));
  assert.strictEqual(p.h.menu('always', 'thorough'), 'Deep research: Always (Thorough)');
  assert.strictEqual(p.h.menu('always', 'quick'), 'Deep research: Always');
  assert.strictEqual(p.h.menu('always'), 'Deep research: Always');
  assert.strictEqual(p.h.menu('ask', 'thorough'), 'Deep research: Ask each time');
  assert.strictEqual(p.h.menu('never', 'thorough'), 'Deep research: Never');
});

test('phone: GET reads alwaysLevel; a level pick POSTs { alwaysLevel }, toasts, and a failure puts the old level back', async () => {
  let p = phone(async (path, o) => (o && o.method === 'POST' ? res(200, { ok: true, choice: 'always', alwaysLevel: JSON.parse(o.body).alwaysLevel }) : res(200, { on: true, choice: 'always', alwaysLevel: 'quick' })));
  await p.h.load();
  assert.strictEqual(p.h.state().level, 'quick');
  assert.strictEqual(await p.h.level('thorough'), true);
  const post = p.calls.find(c => c.o && c.o.method === 'POST');
  assert.deepStrictEqual(JSON.parse(post.o.body), { alwaysLevel: 'thorough' });
  assert.strictEqual(post.p, '/api/research-pref');
  assert.strictEqual(p.h.state().level, 'thorough');
  assert.strictEqual(p.toasts.at(-1), 'Always yes: Thorough research.');
  assert.strictEqual(await p.h.level('bogus'), false);
  p = phone(async (path, o) => (o && o.method === 'POST' ? res(403, { error: 'Not allowed here' }) : res(200, { on: true, choice: 'always', alwaysLevel: 'thorough' })));
  await p.h.load();
  assert.strictEqual(p.h.state().level, 'thorough');
  assert.strictEqual(await p.h.level('quick'), false);
  assert.strictEqual(p.h.state().level, 'thorough');
  assert.strictEqual(p.toasts.at(-1), 'Not allowed here');
  p = phone(async (path, o) => { if (o && o.method === 'POST') throw new Error('offline'); return res(200, { on: true, choice: 'always' }); });
  await p.h.load();
  assert.strictEqual(p.h.state().level, 'quick', 'a missing alwaysLevel reads as quick');
  assert.strictEqual(await p.h.level('thorough'), false);
  assert.strictEqual(p.h.state().level, 'quick');
  assert.strictEqual(p.toasts.at(-1), 'Could not save that');
});

test('phone: a level pick shares the one-save-at-a-time rule, and an older read never puts the old level back', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const p = phone(async (path, o) => { if (o && o.method === 'POST') { await gate; return res(200, { ok: true, alwaysLevel: JSON.parse(o.body).alwaysLevel }); } return res(200, { on: true, choice: 'always', alwaysLevel: 'quick' }); });
  await p.h.load();
  const first = p.h.level('thorough');
  assert.strictEqual(await p.h.level('quick'), false);
  assert.strictEqual(await p.h.pick('never'), false);
  release();
  assert.strictEqual(await first, true);
  assert.strictEqual(p.calls.filter(c => c.o && c.o.method === 'POST').length, 1);
  let releaseGet;
  const getGate = new Promise(r => { releaseGet = r; });
  let gets = 0;
  const q = phone(async (path, o) => {
    if (o && o.method === 'POST') return res(200, { ok: true, alwaysLevel: JSON.parse(o.body).alwaysLevel });
    gets++;
    if (gets === 2) { await getGate; return res(200, { on: true, choice: 'always', alwaysLevel: 'quick' }); }
    return res(200, { on: true, choice: 'always', alwaysLevel: 'quick' });
  });
  await q.h.load();
  const slow = q.h.load();
  assert.strictEqual(await q.h.level('thorough'), true);
  releaseGet();
  await slow;
  assert.strictEqual(q.h.state().level, 'thorough');
});

// a tiny DOM: enough for the paint functions (createElement, appendChild, listeners, hidden)
function fakeDom() {
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.textContent = ''; this.value = ''; this.id = ''; this.className = ''; }
    get firstChild() { return this.children[0] || null; }
    appendChild(c) { this.children.push(c); if (this.tag === 'select' && c.tag === 'option' && !this.value) this.value = c.value; return c; }
    removeChild(c) { this.children = this.children.filter(x => x !== c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(t, f) { this.listeners[t] = f; }
    find(id) { if (this.id === id) return this; for (const c of this.children) { const f = c.find(id); if (f) return f; } return null; }
  }
  return { El, document: { createElement: (t) => new El(t) } };
}
function desktop(fetchImpl) {
  const dom = fakeDom();
  const toasts = [], calls = [];
  const ctx = { document: dom.document, hubToast: (t) => toasts.push(t), fetch: async (u, o) => { calls.push({ u, o }); return fetchImpl(u, o); } };
  vm.createContext(ctx);
  vm.runInContext([lineOf(app, 'const RESEARCH_CHOICES'), lineOf(app, 'const RESEARCH_HINT'), lineOf(app, 'function researchChoiceLabel'),
    'let researchPrefSaving = false; let researchPrefChoice = "ask"; let researchPrefLevel = "quick";',
    lineOf(app, 'const RESEARCH_LEVEL_HINT'), fnSrc(app, 'researchPrefPaint'), 'this.paint = (box, choice, level) => { researchPrefChoice = choice; researchPrefLevel = level; researchPrefPaint(box); };',
    'this.st = () => JSON.stringify({ choice: researchPrefChoice, level: researchPrefLevel, saving: researchPrefSaving });'].join('\n'), ctx);
  const box = new dom.El('div');
  return { ctx, box, toasts, calls, st: () => JSON.parse(ctx.st()), paint: (choice, level) => ctx.paint(box, choice, level) };
}
const flush = () => new Promise(r => setImmediate(r));

test('desktop: the "Always yes runs" select (Quick / Thorough) shows only while the choice is Always, with its hint', () => {
  const D = desktop(async () => res(200, {}));
  D.paint('ask', 'thorough');
  const lbox = D.box.find('st-research-level-box'), lsel = D.box.find('st-research-level');
  assert.ok(lbox && lsel);
  assert.strictEqual(lbox.hidden, true);
  assert.strictEqual(lsel.value, 'thorough', 'its value is kept while hidden');
  assert.deepStrictEqual(lsel.children.map(o => [o.value, o.textContent]), [['quick', 'Quick'], ['thorough', 'Thorough']]);
  assert.ok(lbox.children[0].children.some(c => c.textContent === 'Always yes runs'));
  assert.ok(lbox.children.some(c => c.textContent === 'Thorough reads the key sources in full and checks figures; it can take up to an hour.'));
  D.paint('always', 'quick');
  assert.strictEqual(D.box.find('st-research-level-box').hidden, false);
});

test('desktop: choosing Always shows the level select, another choice hides it; the level saves at once as { alwaysLevel }', async () => {
  const D = desktop(async (u, o) => { const b = JSON.parse(o.body); return res(200, { ok: true, choice: b.choice || 'always', alwaysLevel: b.alwaysLevel || 'quick' }); });
  D.paint('ask', 'quick');
  const sel = D.box.find('st-research-choice');
  sel.value = 'always'; await sel.listeners.change(); await flush();
  assert.strictEqual(D.box.find('st-research-level-box').hidden, false);
  const lsel = D.box.find('st-research-level');
  lsel.value = 'thorough'; await lsel.listeners.change(); await flush();
  assert.deepStrictEqual(JSON.parse(D.calls.at(-1).o.body), { alwaysLevel: 'thorough' });
  assert.strictEqual(D.calls.at(-1).u, '/api/research-pref');
  assert.strictEqual(D.st().level, 'thorough');
  assert.strictEqual(D.toasts.at(-1), 'Always yes: Thorough research.');
  assert.strictEqual(lsel.disabled, false);
  sel.value = 'never'; await sel.listeners.change(); await flush();
  assert.strictEqual(D.box.find('st-research-level-box').hidden, true);
  assert.strictEqual(D.box.find('st-research-level').value, 'thorough', 'kept');
});

test('desktop: a failed level save puts the old level back; one save at a time', async () => {
  const D = desktop(async () => res(500, { error: 'Could not save that one' }));
  D.paint('always', 'quick');
  const lsel = D.box.find('st-research-level');
  lsel.value = 'thorough'; await lsel.listeners.change(); await flush();
  assert.strictEqual(D.st().level, 'quick');
  assert.strictEqual(lsel.value, 'quick');
  assert.strictEqual(D.toasts.at(-1), 'Could not save that one');
  let release;
  const gate = new Promise(r => { release = r; });
  const E = desktop(async (u, o) => { await gate; return res(200, { ok: true, alwaysLevel: JSON.parse(o.body).alwaysLevel }); });
  E.paint('always', 'quick');
  const ls = E.box.find('st-research-level');
  ls.value = 'thorough'; const first = ls.listeners.change();
  assert.strictEqual(E.st().saving, true);
  ls.value = 'quick'; await ls.listeners.change();   // ignored
  assert.strictEqual(E.calls.length, 1);
  release(); await first;
  assert.strictEqual(E.st().level, 'thorough');
  assert.strictEqual(E.st().saving, false);
});

test('level code: sheet buttons are "Always yes runs: Quick/Thorough" with aria-pressed, only for Always; textContent only; GET reads alwaysLevel', () => {
  const buttons = fnSrc(mob, 'researchLevelButtons');
  assert.match(buttons, /if \(researchPrefChoice !== 'always'\) return;/);
  assert.match(buttons, /'Always yes runs: ' \+ l/);
  assert.match(buttons, /setAttribute\('aria-pressed', String\(v === researchPrefLevel\)\)/);
  assert.match(fnSrc(mob, 'researchSheetPaint'), /researchLevelButtons\(d,/);
  assert.match(fnSrc(mob, 'onResearchSheetClick'), /researchLevelPick\(lv\.dataset\.researchLevel\)/);
  assert.match(fnSrc(mob, 'researchPrefLoad'), /d\.alwaysLevel === 'thorough'/);
  assert.match(app, /researchPrefLevel = d\.alwaysLevel === 'thorough' \? 'thorough' : 'quick';/);
  for (const n of ['researchLevelButtons', 'researchLevelPick']) { assert.ok(!/innerHTML/.test(fnSrc(mob, n)), n); assert.ok(!fnSrc(mob, n).includes('\uFE0F'), n); }
  assert.ok(!fnSrc(app, 'researchPrefPaint').includes('\uFE0F'));
});

// ── POST /api/research-pref: choice and alwaysLevel together are ONE write; a failure saves neither ──
{
  const nodeFs = require('node:fs');
  const nodeOs = require('node:os');
  const nodePath = require('node:path');
  const serverSrc = nodeFs.readFileSync(nodePath.join(__dirname, '..', 'server.js'), 'utf8');
  const prefsMod = require('../lib/research-prefs');
  const routeFn = () => {
    const start = serverSrc.indexOf("if (pathname === '/api/research-pref' && (req.method === 'GET' || req.method === 'POST')) {");
    assert.ok(start > 0, 'the route is in server.js');
    const end = serverSrc.indexOf("// This person's time zone", start);
    const body = serverSrc.slice(start, end);
    return new Function('pathname', 'req', 'res', 'hubAuth', 'jsonResponse', 'readBody', 'require', `return (async () => { ${body} return 'not handled'; })();`);
  };
  async function post(prefs, payload) {
    const out = {};
    const req = { method: 'POST', hubUser: { id: 'u1' }, hubIdentKind: 'user' };
    const fakeRequire = (m) => (m === './lib/research-prefs' ? { getResearchPrefs: () => prefs, CHOICES: prefsMod.CHOICES, LEVELS: prefsMod.LEVELS } : { isOn: () => true });
    await routeFn()('/api/research-pref', req, out, { hasUsers: () => true }, (res, code, data) => { res.code = code; res.data = data; return 'sent'; }, async () => JSON.stringify(payload), fakeRequire);
    return out;
  }
  const tmpFile = () => nodePath.join(nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'rp-')), 'research-prefs.json');

  test('route: choice and alwaysLevel in one POST are saved in one write', async () => {
    const file = tmpFile();
    const prefs = prefsMod.createResearchPrefs({ file });
    const orig = nodeFs.writeFileSync;
    let writes = 0;
    nodeFs.writeFileSync = function (f, ...rest) { if (String(f).startsWith(file)) writes++; return orig.call(this, f, ...rest); };
    let out;
    try { out = await post(prefs, { choice: 'always', alwaysLevel: 'thorough' }); } finally { nodeFs.writeFileSync = orig; }
    assert.equal(out.code, 200);
    assert.deepEqual(out.data, { ok: true, choice: 'always', alwaysLevel: 'thorough' });
    assert.equal(writes, 1, 'one write for both');
    const again = prefsMod.createResearchPrefs({ file });
    assert.equal(again.choiceOf('u1'), 'always'); assert.equal(again.alwaysLevelOf('u1'), 'thorough');
  });
  test('route: a bad part saves neither (400), and a write that fails saves neither (500)', async () => {
    const file = tmpFile();
    const prefs = prefsMod.createResearchPrefs({ file });
    const bad = await post(prefs, { choice: 'always', alwaysLevel: 'deep' });
    assert.equal(bad.code, 400);
    assert.equal(prefs.choiceOf('u1'), 'ask'); assert.equal(prefs.alwaysLevelOf('u1'), 'quick');
    assert.equal(nodeFs.existsSync(file), false);
    // the file cannot be written (its folder is a regular file): neither value is kept, in memory or on disk
    const blocker = tmpFile(); nodeFs.writeFileSync(blocker, 'x');
    const broken = prefsMod.createResearchPrefs({ file: nodePath.join(blocker, 'sub', 'research-prefs.json') });
    const out = await post(broken, { choice: 'never', alwaysLevel: 'thorough' });
    assert.equal(out.code, 500);
    assert.equal(broken.choiceOf('u1'), 'ask'); assert.equal(broken.alwaysLevelOf('u1'), 'quick');
  });
  test('prefs.setChoiceAndLevel: validates both first; never starts the reminder clock for a non-never choice; keeps an existing never clock', () => {
    let t = 5000;
    const prefs = prefsMod.createResearchPrefs({ file: tmpFile(), now: () => t });
    assert.throws(() => prefs.setChoiceAndLevel('k', 'maybe', 'quick'), /choice must be/);
    assert.throws(() => prefs.setChoiceAndLevel('k', 'ask', 'deep'), /level must be/);
    assert.equal(prefs.choiceOf('k'), 'ask');
    prefs.setChoiceAndLevel('k', 'never', 'thorough');
    assert.equal(prefs.choiceOf('k'), 'never'); assert.equal(prefs.alwaysLevelOf('k'), 'thorough');
    t = 9000;
    prefs.setChoiceAndLevel('k', 'never', 'quick');
    assert.equal(prefs.remindDue('k', 4001), false, 'the clock from the first never is kept (5000 + 4001 > 9000)');
    assert.equal(prefs.remindDue('k', 4000), true);
  });
}
