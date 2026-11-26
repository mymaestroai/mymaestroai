'use strict';
// One theme per account in both modes: html.mm-light / html.mm-dark from hubSimple.apply (both modes), the early loader's cache
// (mmTheme), the normal-mode Appearance control, the single-colour-set line, and the one-time Quiet Page dark notice.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const S = require('../lib/ui-simple');
const L = require('../lib/ui-looks');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function fakeDoc() {
  const set = new Set(); const listeners = {};
  const mk = (tag) => {
    const el = { tag, children: [], dataset: {}, style: {}, attrs: {}, listeners: {}, parentNode: null, hidden: false, textContent: '', className: '', isConnected: true,
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; c.isConnected = false; return c; },
      addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
      click() { return Promise.all((this.listeners.click || []).map((f) => f())); } };
    return el;
  };
  const all = (el, out = []) => { out.push(el); el.children.forEach((c) => all(c, out)); return out; };
  return { set, mk, all,
    documentElement: { dataset: {}, classList: { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) } },
    createElement: mk,
    addEventListener(t, f) { (listeners[t] ||= []).push(f); },
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
    dispatchEvent(e) { for (const f of [...(listeners[e.type] || [])]) f(e); return true; } };
}
function fakeWin(dark) {
  const mq = { matches: !!dark, listeners: new Set(),
    addEventListener(t, f) { if (t === 'change') this.listeners.add(f); },
    removeEventListener(t, f) { if (t === 'change') this.listeners.delete(f); } };
  return { mq, matchMedia: () => mq, flip(d) { mq.matches = d; for (const f of [...mq.listeners]) f({ matches: d }); } };
}
function fakeStorage(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}
const cls = (doc) => [...doc.set].filter((c) => c !== 'mm-simple').sort();

test('apply: light / dark / auto set exactly one of mm-light, mm-dark in Advanced and Simple', () => {
  for (const uiMode of ['advanced', 'simple']) {
    for (const [theme, dark, want] of [['light', true, 'mm-light'], ['dark', false, 'mm-dark'], ['auto', true, 'mm-dark'], ['auto', false, 'mm-light']]) {
      const doc = fakeDoc();
      S.apply({ uiMode, theme }, { doc, win: fakeWin(dark), storage: fakeStorage() });
      assert.deepStrictEqual(cls(doc), [want], uiMode + ' ' + theme + ' ' + dark);
      assert.strictEqual(doc.set.has('mm-simple'), uiMode === 'simple');
    }
  }
});

test('apply: the prefers-color-scheme listener flips the class in both modes; a fixed theme keeps none', () => {
  for (const uiMode of ['advanced', 'simple']) {
    const doc = fakeDoc(), win = fakeWin(true);
    S.apply({ uiMode, theme: 'auto' }, { doc, win, storage: fakeStorage() });
    assert.deepStrictEqual(cls(doc), ['mm-dark']);
    win.flip(false); assert.deepStrictEqual(cls(doc), ['mm-light']);
    win.flip(true); assert.deepStrictEqual(cls(doc), ['mm-dark']);
    S.apply({ uiMode, theme: 'light' }, { doc, win, storage: fakeStorage() });
    assert.strictEqual(win.mq.listeners.size, 0);
    assert.deepStrictEqual(cls(doc), ['mm-light']);
  }
});

test('apply: no account yet -> no theme class; the cache is written for a known theme and cleared for none', () => {
  const doc = fakeDoc(), st = fakeStorage({ mmTheme: 'dark' });
  S.apply(null, { doc, win: fakeWin(false), storage: st });
  assert.deepStrictEqual(cls(doc), []);
  assert.strictEqual(st.m.get('mmTheme'), 'dark');   // an unknown account must not wipe it
  S.apply({ uiMode: 'advanced', theme: 'light' }, { doc, win: fakeWin(false), storage: st });
  assert.strictEqual(st.m.get('mmTheme'), 'light');
  S.apply({ uiMode: 'advanced', theme: 'auto' }, { doc, win: fakeWin(false), storage: st });
  assert.strictEqual(st.m.get('mmTheme'), 'auto');
  S.apply({ uiMode: 'advanced' }, { doc, win: fakeWin(false), storage: st });   // an account with no setting
  assert.strictEqual(st.m.has('mmTheme'), false);
  assert.doesNotThrow(() => S.apply({ uiMode: 'advanced', theme: 'dark' }, { doc, win: fakeWin(false), storage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } }));
});

test('early loader: the cached theme is applied before first paint (auto follows the device); blocked or empty storage -> no class', () => {
  const run = (v, dark) => { const doc = fakeDoc(); const r = L.applyCachedTheme(doc, fakeWin(dark), fakeStorage(v ? { mmTheme: v } : {})); return [r, cls(doc)]; };
  assert.deepStrictEqual(run('light', true), ['light', ['mm-light']]);
  assert.deepStrictEqual(run('dark', false), ['dark', ['mm-dark']]);
  assert.deepStrictEqual(run('auto', true), ['dark', ['mm-dark']]);
  assert.deepStrictEqual(run('auto', false), ['light', ['mm-light']]);
  assert.deepStrictEqual(run(null, true), [null, []]);
  assert.deepStrictEqual(run('bogus', true), [null, []]);
  const doc = fakeDoc();
  assert.strictEqual(L.applyCachedTheme(doc, fakeWin(true), { getItem() { throw new Error('blocked'); } }), null);
  assert.deepStrictEqual(cls(doc), []);
  assert.strictEqual(L.applyCachedTheme(doc, fakeWin(true), null), null);
  // it runs in the loader, right after the look is applied
  assert.match(read('lib/ui-looks.js'), /api\.applyCachedTheme\(root\.document, root, store\)/);
});

test('another account or sign-out: the cached theme never carries over', () => {
  const st = fakeStorage({ mmTheme: 'dark' });
  S.apply({ uiMode: 'advanced', theme: 'light' }, { doc: fakeDoc(), win: fakeWin(true), storage: st });   // the next person's load overwrites
  assert.strictEqual(st.m.get('mmTheme'), 'light');
  L.forgetTheme(st); assert.strictEqual(st.m.has('mmTheme'), false);
  assert.doesNotThrow(() => L.forgetTheme({ removeItem() { throw new Error('blocked'); } }));
  assert.doesNotThrow(() => L.forgetTheme(null));
  const app = read('app.js'), mob = read('mobile.js');
  assert.match(app, /async function signOut\(\) \{\n\s+try \{ if \(window\.HubLooks\) window\.HubLooks\.forgetTheme/);
  assert.match(mob, /async function signOut\(\) \{\n\s+try \{ if \(window\.HubLooks\) window\.HubLooks\.forgetTheme/);
  assert.match(app, /r\.status === 401\) \{\n\s+try \{ if \(window\.HubLooks\) window\.HubLooks\.forgetTheme/);
  assert.match(mob, /redirectingToLogin = true;\n\s+try \{ if \(window\.HubLooks\) window\.HubLooks\.forgetTheme/);
});

test('single colour set line: per look, none for Quiet Page', () => {
  assert.strictEqual(L.singleSetLine('engineering'), 'Engineering is always dark');
  assert.strictEqual(L.singleSetLine('broadsheet'), 'Broadsheet House is always light');
  assert.strictEqual(L.singleSetLine('quiet'), null);
  assert.strictEqual(L.singleSetLine('nope'), null);
});

test('themeControl: Light / Dark / Match device, saves, applies at once, reverts on failure, line follows the look', async () => {
  const doc = fakeDoc(); doc.documentElement.dataset.look = 'engineering';
  global.window = { HubLooks: { singleSetLine: L.singleSetLine, applied: () => doc.documentElement.dataset.look } };
  const me = { uiMode: 'advanced', theme: 'auto' }; const saved = []; let fail = false; let errs = 0;
  const ctl = S.themeControl(doc, { me: () => me, save: async (v) => { saved.push(v); if (fail) throw new Error('x'); }, onError: () => errs++ });
  const els = doc.all(ctl.el);
  const btns = els.filter((e) => e.tag === 'button');
  assert.deepStrictEqual(btns.map((b) => b.textContent), ['Light', 'Dark', 'Match device']);
  assert.strictEqual(els.find((e) => e.className === 'mm-theme-title').textContent, 'Appearance');
  const line = els.find((e) => e.className === 'mm-theme-line');
  assert.strictEqual(line.textContent, 'Engineering is always dark');
  doc.documentElement.dataset.look = 'quiet'; doc.dispatchEvent({ type: 'mm-look-change' });
  assert.strictEqual(line.hidden, true);
  doc.documentElement.dataset.look = 'broadsheet'; doc.dispatchEvent({ type: 'mm-look-change' });
  assert.strictEqual(line.textContent, 'Broadsheet House is always light');
  let heard = 0; doc.addEventListener('mm-theme-change', () => heard++);
  await btns[0].click();
  assert.deepStrictEqual(saved, ['light']); assert.strictEqual(me.theme, 'light');
  assert.ok(doc.set.has('mm-light') && !doc.set.has('mm-dark')); assert.strictEqual(heard, 1);
  assert.strictEqual(btns[0].attrs['aria-pressed'], 'true');
  fail = true; await btns[1].click();
  assert.strictEqual(me.theme, 'light'); assert.ok(doc.set.has('mm-light')); assert.strictEqual(errs, 1);
  delete global.window;
});

test('notice: shows only for normal mode + quiet + resolves dark + not seen', () => {
  const yes = { simple: false, look: 'quiet', resolved: 'dark', seen: false };
  assert.strictEqual(S.noticeShows(yes), true);
  for (const k of [{ simple: true }, { look: 'engineering' }, { look: 'broadsheet' }, { resolved: 'light' }, { resolved: null }, { seen: true }]) assert.strictEqual(S.noticeShows({ ...yes, ...k }), false, JSON.stringify(k));
  assert.strictEqual(S.NOTICE_TEXT, 'Quiet Page now has a dark version and follows your theme.');
  const build = (st, lookId, classes, me) => {
    const doc = fakeDoc(); classes.forEach((c) => doc.set.add(c));
    global.window = { HubLooks: { applied: () => lookId } };
    const el = S.themeNotice(doc, { me: () => me, save: async () => {}, storage: st });
    return { doc, el };
  };
  const me = { user: { id: 'u1' }, theme: 'dark' };
  try {
    assert.strictEqual(build(fakeStorage(), 'quiet', ['mm-simple', 'mm-dark'], me).el, null);
    assert.strictEqual(build(fakeStorage(), 'engineering', ['mm-dark'], me).el, null);
    assert.strictEqual(build(fakeStorage(), 'quiet', ['mm-light'], me).el, null);
    assert.strictEqual(build(fakeStorage({ 'mm-theme-notice:u1': '1' }), 'quiet', ['mm-dark'], me).el, null);
    assert.strictEqual(build(fakeStorage({ 'mm-theme-notice:u2': '1' }), 'quiet', ['mm-dark'], me).el !== null, true, 'seen is per account');
    assert.strictEqual(build({ getItem() { throw new Error('blocked'); } }, 'quiet', ['mm-dark'], me).el, null, 'blocked storage: never shown');
    // a choice stores seen
    let st = fakeStorage(); let b = build(st, 'quiet', ['mm-dark'], me);
    const btns = b.doc.all(b.el).filter((e) => e.tag === 'button');
    assert.deepStrictEqual(btns.map((x) => x.textContent), ['Light', 'Dark', 'Match device', '×']);
    return btns[0].click().then(() => {
      assert.strictEqual(st.m.get('mm-theme-notice:u1'), '1'); 
      // × stores seen
      st = fakeStorage(); b = build(st, 'quiet', ['mm-dark'], me);
      b.doc.all(b.el).filter((e) => e.tag === 'button' && e.textContent === '×')[0].click();
      assert.strictEqual(st.m.get('mm-theme-notice:u1'), '1');
    }).finally(() => { delete global.window; });
  } catch (e) { delete global.window; throw e; }
});

test('pages: Appearance before Interface style on desktop and phone, notice placed in the banner stack / Agents screen', () => {
  const app = read('app.js'), mob = read('mobile.js');
  const a = app.slice(app.indexOf('function lookSectionPaint'));
  assert.ok(a.indexOf('themeControl') > 0 && a.indexOf('themeControl') < a.indexOf("'Interface style for new members'"));
  assert.match(a, /host\.insertBefore\(ap\.el, picker\)/);
  // The theme line sits in the banner stack before readiness: ui-system-health.test.js pins readiness, health, security as the stack's tail.
  assert.match(app, /'hub-setup-notice', 'hub-theme-notice', 'hub-readiness-notice', 'hub-health-notice', 'hub-security-notice'\]\) \{/);
  assert.match(app, /try \{ themeNoticeShow\(\); \}/);
  const p = mob.slice(mob.indexOf('<div class="sec-section" id="prof-theme-sec" hidden>'));
  assert.ok(p.indexOf('prof-theme-sec') < p.indexOf('Interface style</div>'));
  assert.ok(mob.indexOf("simpleThemeCtl(themeNoticeGone)") < mob.indexOf("lookPickerPaint($('prof-looks'))"));
  assert.match(mob, /themeNoticeShow\(\); \} catch/);
  // phone: inside #screen-agents next to the health notice, not in the chat screen's composer
  assert.match(mob, /\$\('screen-agents'\), first = \$\('health-notice'\)/);
});

test('inline styles take var(--on-accent, #fff); every .mm-light rule is Simple-only', () => {
  const app = read('app.js'), mob = read('mobile.js');
  for (const s of [app, mob]) {
    assert.ok(s.includes('.dlg-discard-keep{background:var(--accent,#3D7BFF);border-color:var(--accent,#3D7BFF);color:var(--on-accent,#fff)}'));
    assert.ok(!s.includes('dlg-discard-keep{background:var(--accent,#3D7BFF);border-color:var(--accent,#3D7BFF);color:#fff}'));
  }
  assert.match(read('index.html'), /:root \{\n\s+--on-accent: #fff;/);
  assert.match(read('mobile.html'), /--on-accent: #fff;/);
  for (const f of ['index.html', 'mobile.html', 'looks/broadsheet.css']) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]*\.mm-light[^{}]*)\{/g)) for (const sel of m[1].split(',')) if (sel.includes('.mm-light')) assert.ok(/\.mm-simple\.mm-light/.test(sel), f + ': ' + sel.trim());
  }
});
