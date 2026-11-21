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

test('phone html: the row starts hidden in the Notifications and view group; the sheet exists', () => {
  assert.match(html, /<button id="menu-research" hidden>Deep research: Ask each time<\/button>/);
  const g = html.indexOf('data-group="notify"'), next = html.indexOf('data-group="account"');
  const r = html.indexOf('id="menu-research"');
  assert.ok(g > 0 && r > g && r < next, 'inside the notify group');
  assert.ok(html.indexOf('id="menu-notify-prefs"') < r && r < html.indexOf('id="menu-active-top"'));
  assert.ok(html.includes('<dialog id="research-sheet"'));
  assert.match(html, /#research-sheet button \{[^}]*min-height: 44px/);
  assert.match(html, /html\.mm-simple \.ss-rseg button \{[^}]*min-height: 48px/);
});

test('phone js: GET shows the row only when on; POST body is { choice }; menu groups are re-counted', () => {
  assert.ok(mob.includes("api('/api/research-pref')"));
  assert.match(mob, /api\('\/api\/research-pref', \{ method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ choice \}\) \}\)/);
  assert.match(mob, /row\.hidden = !researchPrefOn;/);
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
  const a = open.indexOf('>Appearance<'), s = open.indexOf('>Interface style<');
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
  const code = [lineOf(mob, 'const RESEARCH_CHOICES'), lineOf(mob, 'function researchChoiceLabel'), lineOf(mob, 'function researchMenuText'), lineOf(mob, 'function researchChoiceOk'),
    'let researchPrefOn = false; let researchPrefChoice = "ask"; let researchPrefSaving = false;',
    'function researchPrefPaintAll() {}',
    fnSrc(mob, 'researchPrefLoad'), fnSrc(mob, 'researchPick'),
    'this.h = { load: researchPrefLoad, pick: researchPick, state: () => JSON.stringify({ on: researchPrefOn, choice: researchPrefChoice, saving: researchPrefSaving }) };'].join('\n');
  vm.runInContext(code, ctx);
  const h = { load: ctx.h.load, pick: ctx.h.pick, state: () => JSON.parse(ctx.h.state()) };   // plain objects from this realm
  return { h, toasts, calls };
}
const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new Error('unreadable'); return body; } });

test('phone: GET on shows the choice; off, failed and unreadable GET show nothing', async () => {
  let p = phone(async () => res(200, { on: true, choice: 'always' }));
  assert.strictEqual(await p.h.load(), true);
  assert.deepStrictEqual(p.h.state(), { on: true, choice: 'always', saving: false });
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
