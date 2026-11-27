'use strict';
// The look registry and early loader (lib/ui-looks.js), its pages, its static files, the new-member default and the pickers.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const L = require('../lib/ui-looks');

// A fake storage and a fake document (just what apply() touches).
function fakeStorage(init = {}, { blocked = false } = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem(k) { if (blocked) throw new Error('blocked'); return m.has(k) ? m.get(k) : null; },
    setItem(k, v) { if (blocked) throw new Error('blocked'); m.set(k, String(v)); },
    removeItem(k) { if (blocked) throw new Error('blocked'); m.delete(k); },
    _m: m,
  };
}
function fakeDoc() {
  const head = { children: [], appendChild(n) { n.parentNode = head; head.children.push(n); return n; }, removeChild(n) { head.children = head.children.filter(c => c !== n); n.parentNode = null; return n; } };
  const html = { dataset: {} };
  const doc = {
    documentElement: html, head,
    createElement(tag) { const attrs = {}; return { tag, setAttribute(k, v) { attrs[k] = v; }, getAttribute(k) { return k === 'href' ? this.href : attrs[k]; }, parentNode: null }; },
    getElementById(id) { return head.children.find(c => c.id === id) || null; },
    getElementsByTagName() { return [head]; },
  };
  return doc;
}

test('registry: unique ids, Engineering first with no stylesheet, every other css path is a file under looks/', () => {
  const ids = L.LOOKS.map(l => l.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.deepStrictEqual(ids, ['engineering', 'broadsheet', 'quiet']);
  assert.strictEqual(L.LOOKS[0].id, 'engineering');
  assert.strictEqual(L.LOOKS[0].css, null);
  for (const l of L.LOOKS) {
    assert.ok(l.label && l.blurb && l.preview && l.preview.bg && l.preview.panel && l.preview.ink && l.preview.accent && ['sans', 'serif'].includes(l.preview.font), l.id);
    if (l.id === 'engineering') continue;
    assert.strictEqual(l.css, `/looks/${l.id}.css`);
    assert.ok(fs.statSync(path.join(ROOT, 'looks', `${l.id}.css`)).isFile(), l.id);
  }
  assert.strictEqual(L.STORE_KEY, 'mmLook');
  assert.strictEqual(L.DEFAULT_KEY, 'mmLookDefault');
  assert.strictEqual(L.byId('quiet').label, 'Quiet Page');
  assert.strictEqual(L.byId('nope'), null);
  assert.strictEqual(L.byId(undefined), null);
});

test('resolve and current: Engineering by default, a stored choice beats the person default, junk falls back', () => {
  assert.strictEqual(L.resolve({}), 'engineering');
  assert.strictEqual(L.resolve(), 'engineering');
  assert.strictEqual(L.resolve({ personDefault: 'quiet' }), 'quiet');
  assert.strictEqual(L.resolve({ choice: 'broadsheet', personDefault: 'quiet' }), 'broadsheet');
  assert.strictEqual(L.resolve({ choice: 'x', personDefault: 'quiet' }), 'quiet');
  assert.strictEqual(L.resolve({ choice: 'x', personDefault: 'y' }), 'engineering');
  assert.strictEqual(L.current(fakeStorage()), 'engineering');
  assert.strictEqual(L.current(fakeStorage({ mmLookDefault: 'quiet' })), 'quiet');
  assert.strictEqual(L.current(fakeStorage({ mmLook: 'broadsheet', mmLookDefault: 'quiet' })), 'broadsheet');
  assert.strictEqual(L.current(fakeStorage({ mmLook: 'gone', mmLookDefault: 'quiet' })), 'quiet');
  assert.strictEqual(L.current(fakeStorage({ mmLook: 'gone' })), 'engineering');
  assert.strictEqual(L.current(fakeStorage({}, { blocked: true })), 'engineering');
  assert.strictEqual(L.current(null), 'engineering');
});

test('choose: writes the device choice, refuses an invalid id, survives blocked storage', () => {
  const s = fakeStorage();
  assert.strictEqual(L.choose('quiet', s), 'quiet');
  assert.strictEqual(s._m.get('mmLook'), 'quiet');
  assert.strictEqual(L.choose('x.css', s), null);
  assert.strictEqual(L.choose('', s), null);
  assert.strictEqual(s._m.get('mmLook'), 'quiet');
  assert.doesNotThrow(() => L.choose('quiet', fakeStorage({}, { blocked: true })));
});

test('apply: sets data-look, adds, replaces and removes the one stylesheet link', () => {
  const d = fakeDoc();
  assert.strictEqual(L.apply(d, 'engineering'), 'engineering');
  assert.strictEqual(d.documentElement.dataset.look, 'engineering');
  assert.strictEqual(d.head.children.length, 0);
  assert.strictEqual(L.apply(d, 'broadsheet'), 'broadsheet');
  assert.strictEqual(d.documentElement.dataset.look, 'broadsheet');
  assert.strictEqual(d.head.children.length, 1);
  assert.strictEqual(d.head.children[0].id, 'mm-look-css');
  assert.strictEqual(d.head.children[0].rel, 'stylesheet');
  assert.strictEqual(d.head.children[0].href, '/looks/broadsheet.css');
  L.apply(d, 'broadsheet');
  assert.strictEqual(d.head.children.length, 1, 'the same look again adds nothing');
  L.apply(d, 'quiet');
  assert.strictEqual(d.head.children.length, 1, 'replaced, not stacked');
  assert.strictEqual(d.head.children[0].href, '/looks/quiet.css');
  L.apply(d, 'engineering');
  assert.strictEqual(d.head.children.length, 0, 'Engineering removes the link');
  assert.strictEqual(L.apply(d, 'bogus'), 'engineering');
  assert.strictEqual(d.documentElement.dataset.look, 'engineering');
  assert.strictEqual(L.apply(null, 'quiet'), 'quiet');
});

test('rememberDefault: caches the person default; shows it only when this device has no choice', () => {
  let d = fakeDoc(), s = fakeStorage();
  assert.strictEqual(L.rememberDefault('quiet', s, d), 'quiet');
  assert.strictEqual(s._m.get('mmLookDefault'), 'quiet');
  assert.strictEqual(d.documentElement.dataset.look, 'quiet');
  d = fakeDoc(); s = fakeStorage({ mmLook: 'broadsheet' });
  L.apply(d, 'broadsheet');
  assert.strictEqual(L.rememberDefault('quiet', s, d), 'broadsheet', 'returns the look in force: the device\'s own choice');
  assert.strictEqual(s._m.get('mmLookDefault'), 'quiet');
  assert.strictEqual(d.documentElement.dataset.look, 'broadsheet', "this device's own choice stays");
  // Review r1: an account without a (valid) default clears the cached one; this device's own choice still stays.
  assert.strictEqual(L.rememberDefault('nope', s, d), 'broadsheet');
  assert.strictEqual(s._m.has('mmLookDefault'), false);
  assert.strictEqual(d.documentElement.dataset.look, 'broadsheet');
  assert.doesNotThrow(() => L.rememberDefault('quiet', fakeStorage({}, { blocked: true }), fakeDoc()));
});

test('the loader applies the stored look at load in a browser, and a blocked storage means Engineering', () => {
  const vm = require('vm');
  const src = read('lib/ui-looks.js');
  const run = (storage) => {
    const doc = fakeDoc();
    const win = { document: doc, localStorage: storage };
    vm.runInNewContext(src, { window: win });
    return { win, doc };
  };
  let r = run(fakeStorage({ mmLook: 'quiet' }));
  assert.strictEqual(r.doc.documentElement.dataset.look, 'quiet');
  assert.strictEqual(r.doc.head.children[0].href, '/looks/quiet.css');
  assert.ok(r.win.HubLooks && r.win.HubLooks.LOOKS.length === 3);
  r = run(fakeStorage({}, { blocked: true }));
  assert.strictEqual(r.doc.documentElement.dataset.look, 'engineering');
  assert.strictEqual(r.doc.head.children.length, 0);
  const blockedWin = { document: fakeDoc() };
  Object.defineProperty(blockedWin, 'localStorage', { get() { throw new Error('SecurityError'); } });
  vm.runInNewContext(src, { window: blockedWin });
  assert.strictEqual(blockedWin.document.documentElement.dataset.look, 'engineering');
});

test('every page loads /ui-looks.js in its <head> before its first <style>', () => {
  // agent-settings is a redirect page now (P4-2): it draws nothing of its own and uses system colours, so it has no interface style to load
  const pages = ['index', 'mobile', 'changes', 'help', 'users', 'recordings', 'tiger-team', 'local-models', 'modules', 'welcome', 'login', 'remote-desktop'];
  for (const p of pages) {
    const html = read(`${p}.html`);
    const tag = '<script src="/ui-looks.js"></script>';
    const head = html.indexOf('<head');
    const headEnd = html.indexOf('</head>');
    const at = html.indexOf(tag);
    const style = html.indexOf('<style');
    assert.ok(at > head && at < headEnd, `${p}: in <head>`);
    assert.ok(at < style, `${p}: before the first <style>`);
    assert.strictEqual(html.split(tag).length - 1, 1, `${p}: once`);
  }
});

test('static files: /ui-looks.js and the registry look stylesheets only; reachable before sign-in', () => {
  const sf = require('../lib/static-files');
  const real = (p) => { const r = sf.resolve(p); return r && path.relative(ROOT, fs.realpathSync(r)); };
  assert.strictEqual(real('/ui-looks.js'), path.join('lib', 'ui-looks.js'));
  assert.strictEqual(real('/looks/broadsheet.css'), path.join('looks', 'broadsheet.css'));
  assert.strictEqual(real('/looks/quiet.css'), path.join('looks', 'quiet.css'));
  assert.strictEqual(sf.resolve('/looks/x.css'), null);
  assert.strictEqual(sf.resolve('/looks/engineering.css'), null, 'Engineering has no stylesheet');
  assert.strictEqual(sf.resolve('/looks/quiet.js'), null);
  assert.strictEqual(sf.resolve('/looks/../server.js'), null);
  assert.strictEqual(sf.resolve('/looks/%2e%2e/server.js'), null);
  assert.strictEqual(sf.resolve('/looks/'), null);
  assert.strictEqual(sf.resolve('/looks/a/quiet.css'), null);
  const access = require('../lib/access');
  for (const p of ['/ui-looks.js', '/looks/broadsheet.css', '/looks/quiet.css']) assert.strictEqual(access.classifyRoute(p, 'GET').kind, 'public', p + ' needs no sign-in');
});

test('the new-member default: the setting is validated, a new member gets it, an existing user is unchanged, the me-record carries it', () => {
  const server = read('server.js');
  // the check moved to lib/settings-apply cleanSettingsPatch (POST /api/settings answers its status 400 with its error): test the real function
  assert.match(server, /require\('\.\/lib\/settings-apply'\)\.cleanSettingsPatch\(patch,/);
  { const { callSettingsApply } = require('./helpers/isolated-settings-apply');   // the real function, run in a throwaway install
    const cleanSettingsPatch = (...a) => callSettingsApply('cleanSettingsPatch', a);
    const bad = cleanSettingsPatch({ lookDefaultForNewMembers: 'no-such-look' }, {});
    assert.strictEqual(bad.status, 400); assert.match(bad.errors[0], /lookDefaultForNewMembers must be one of/);
    const good = cleanSettingsPatch({ lookDefaultForNewMembers: require('../lib/ui-looks').LOOKS[0].id }, {});
    assert.deepStrictEqual(good.errors, []); }
  assert.match(server, /const rec = req\.hubUser \? hubAuth\.getUser\(req\.hubUser\.id\) : null; if \(rec && rec\.look\) out\.look = rec\.look;/);
  const { makeIsolatedInstall } = require('./helpers/isolated-install');
  const ISO = makeIsolatedInstall('ui-looks-iso-');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-looks-'));
  process.env.HUB_AUTH_DIR = TMP;
  const A = require(path.join(ISO.lib, 'auth'));
  let setting = 'quiet';
  const dir = fs.mkdtempSync(path.join(TMP, 'a-'));
  const auth = A.createAuth({ dataDir: dir, log: () => {}, lookForNewMembers: () => setting });
  // An account made before looks existed: no look, and none is added later.
  const old = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'correct horse battery 42' });
  assert.ok(old.ok);
  assert.strictEqual(auth.getUser(old.user.id).look, undefined, 'an admin account gets no look');
  const sam = auth.createUser({ login: 'sam@example.com', name: 'Sam', role: 'member', password: 'correct horse battery 43' });
  assert.ok(sam.ok);
  assert.strictEqual(auth.getUser(sam.user.id).look, 'quiet');
  setting = 'broadsheet';
  const pat = auth.createUser({ login: 'pat@example.com', name: 'Pat', role: 'member', password: 'correct horse battery 44' });
  assert.strictEqual(auth.getUser(pat.user.id).look, 'broadsheet');
  assert.strictEqual(auth.getUser(sam.user.id).look, 'quiet', 'an existing member is unchanged when the setting changes');
  setting = 'garbage';
  const kim = auth.createUser({ login: 'kim@example.com', name: 'Kim', role: 'member', password: 'correct horse battery 45' });
  assert.strictEqual(auth.getUser(kim.user.id).look, 'engineering', 'a bad stored value means Engineering');
  // A member who joins through an invite gets it too.
  setting = 'quiet';
  const inv = auth.createInvite({ login: 'lee@example.com', name: 'Lee', role: 'member', by: old.user.id });
  const acc = auth.acceptInvite(inv.token, { password: 'correct horse battery 46', name: 'Lee' });
  assert.ok(acc.ok);
  assert.strictEqual(auth.getUser(acc.user.id).look, 'quiet');
});

test('the admin setting reaches the server through the settings route that validates it, and defaults to Engineering', () => {
  const app = read('app.js');
  assert.match(app, /lookDefaultForNewMembers: sel\.value/);
  assert.match(app, /window\.HubLooks\.byId\(data && data\.lookDefaultForNewMembers\) \? data\.lookDefaultForNewMembers : 'engineering'/);
  assert.match(read('lib/auth.js'), /getSetting\('lookDefaultForNewMembers', 'engineering'\)/);
});

test('pickers: app.js and mobile.js choose through HubLooks, build previews from text nodes, and the pages remember the default', () => {
  const app = read('app.js'), mob = read('mobile.js');
  for (const [name, src] of [['app.js', app], ['mobile.js', mob]]) {
    assert.match(src, /L\.choose\(look\.id, L\.storageOf\(window\)\)/, name);   // review r1: guarded storage
    assert.match(src, /L\.apply\(document, look\.id\)/, name);
    assert.match(src, /createTextNode\('Aa'\)/, name);
    assert.match(src, /Applies to this device\. Simple mode works with every interface style\./, name);
    assert.match(src, /HubLooks\.rememberDefault\(/, name);
  }
  for (const [src, names] of [[app, ['lookPreviewBox', 'lookPickerBuild', 'lookSectionPaint']], [mob, ['lookSwatch', 'lookPickerPaint']]]) {
    for (const n of names) {
      const a = src.indexOf(`function ${n}(`);
      const body = src.slice(a, a + 3500);
      const end = body.search(/\n(?:    )?(?:function |const STG |\/\/ Profile)/);
      const fn = end > 0 ? body.slice(0, end + 1) : body;
      assert.doesNotMatch(fn, /innerHTML|insertAdjacentHTML/, `${n} builds no markup`);
    }
  }
  assert.match(app, /id="st-looks-section"><h4>Appearance<\/h4>/);
  assert.match(app, /'Interface style for new members'/);
  assert.match(app, /if \(!isHubAdmin\(\)\) return;\s*const row/);
  assert.match(mob, /id="prof-looks"/);
  assert.match(mob, /lookPickerPaint\(d\.querySelector\('#ss-style'\)\)/);   // the Simple sheet's picker (was an inline section; now markup right after Appearance)
  assert.match(mob, /gridTemplateColumns = 'repeat\(3, 1fr\)'/);
});

test('no emoji with a variation selector in the files this feature adds', () => {
  for (const f of ['lib/ui-looks.js', 'test/ui-looks.test.js', 'looks/broadsheet.css', 'looks/quiet.css']) assert.ok(!read(f).includes(String.fromCharCode(0xFE0F)), f);
});

test('the attach button carries a class, and every light look gives it dark text (the message box makes buttons white for the accent Send)', () => {
  assert.match(read('app.js'), /<button class="attach-btn" onclick="document\.getElementById\('file-input-/);
  assert.doesNotMatch(read('index.html'), /\.attach-btn/, 'Engineering keeps today\'s rule set');
  for (const id of ['broadsheet', 'quiet']) {
    const css = read(`looks/${id}.css`);
    assert.match(css, new RegExp(`html\\[data-look="${id}"\\]:not\\(\\.mm-simple\\) \\.input-area button\\.attach-btn \\{ color: var\\(--text\\); \\}`), id);
  }
});

test('review r1: a shared browser does not keep the last person\'s default (an account without one gets Engineering)', () => {
  const s = fakeStorage({ mmLookDefault: 'quiet' }), d = fakeDoc();
  L.apply(d, L.current(s));
  assert.strictEqual(d.documentElement.dataset.look, 'quiet', 'the page opens in the cached default');
  assert.strictEqual(L.rememberDefault(undefined, s, d), 'engineering');
  assert.strictEqual(s._m.has('mmLookDefault'), false);
  assert.strictEqual(d.documentElement.dataset.look, 'engineering');
  assert.strictEqual(d.getElementById('mm-look-css'), null);
  assert.strictEqual(L.current(s), 'engineering', 'and the next load starts in Engineering');
  const blocked = fakeStorage({}, { blocked: true }), d2 = fakeDoc();
  L.apply(d2, 'quiet');
  assert.strictEqual(L.rememberDefault(null, blocked, d2), 'engineering');
  assert.strictEqual(d2.documentElement.dataset.look, 'engineering', 'blocked storage: this page still shows Engineering');
  for (const [name, src] of [['app.js', read('app.js')], ['mobile.js', read('mobile.js')]]) {
    assert.match(src, /if \(window\.HubLooks && (?:window\.)?hubMe\) window\.HubLooks\.rememberDefault\((?:window\.)?hubMe\.look, window\.HubLooks\.storageOf\(window\)\)/, `${name} reconciles on every account load`);
  }
});

test('review r1: storage that throws on read or on write never breaks a picker, and the pressed card is the look in force', () => {
  const win = {};
  Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
  assert.strictEqual(L.storageOf(win), null);
  assert.strictEqual(L.storageOf(null), null);
  const ok = fakeStorage();
  assert.strictEqual(L.storageOf({ localStorage: ok }), ok);
  const d = fakeDoc();
  assert.strictEqual(L.applied(d), 'engineering');
  const readOnly = fakeStorage();
  readOnly.setItem = () => { throw new Error('QuotaExceeded'); };
  assert.strictEqual(L.choose('quiet', readOnly), 'quiet');
  L.apply(d, 'quiet');
  assert.strictEqual(L.current(readOnly), 'engineering', 'the choice was not stored');
  assert.strictEqual(L.applied(d), 'quiet', 'but the page shows Quiet, and the picker marks Quiet');
  d.documentElement.dataset.look = 'bogus';
  assert.strictEqual(L.applied(d), 'engineering');
  const app = read('app.js'), mob = read('mobile.js');
  for (const [src, fn] of [[app, 'lookPickerBuild'], [mob, 'lookPickerPaint']]) {
    const a = src.indexOf(`function ${fn}(`), z = src.indexOf('note.className', a);
    assert.ok(a > 0 && z > a && z - a < 4000, `${fn} found, with its note`);
    const body = src.slice(a, z);
    assert.doesNotMatch(body, /window\.localStorage/, `${fn} reads storage only through HubLooks`);
    assert.match(body, /const cur = L\.applied\(document\);/, fn);
    assert.match(body, /\.find\(x => x\.dataset\.look === look\.id\);\s*if \(again\) again\.focus\(\);/, `${fn} keeps keyboard focus on the chosen card`);
  }
});

test('review r1: while the page is parsing, the loader writes the look\'s stylesheet into the head (it holds the first paint)', () => {
  const vm = require('vm');
  const src = read('lib/ui-looks.js');
  const run = (stored) => {
    const doc = fakeDoc();
    doc.readyState = 'loading';
    doc.written = [];
    doc.write = (h) => doc.written.push(h);
    vm.runInNewContext(src, { window: { document: doc, localStorage: fakeStorage(stored) } });
    return doc;
  };
  let doc = run({ mmLook: 'broadsheet' });
  assert.deepStrictEqual(doc.written, ['<link rel="stylesheet" id="mm-look-css" href="/looks/broadsheet.css">']);
  assert.strictEqual(doc.head.children.length, 0);
  assert.strictEqual(doc.documentElement.dataset.look, 'broadsheet');
  doc = run({ mmLook: '"><script>x</script>' });
  assert.deepStrictEqual(doc.written, [], 'an unknown stored value is Engineering: nothing written');
  assert.strictEqual(doc.documentElement.dataset.look, 'engineering');
  doc = run({});
  assert.deepStrictEqual(doc.written, []);
  const later = fakeDoc();
  later.readyState = 'complete'; later.write = () => { throw new Error('must not write after parsing'); };
  L.apply(later, 'quiet', { parsing: true });
  assert.strictEqual(later.head.children[0].href, '/looks/quiet.css', 'after parsing: a normal link');
});

test('review r1: look stylesheets are served for their exact names only', () => {
  const { resolve } = require('../lib/static-files');
  assert.ok(resolve('/looks/broadsheet.css'));
  assert.strictEqual(resolve('/looks/broadsheet.CSS'), null);
  assert.strictEqual(resolve('/looks/nope.css'), null);
});

test('full width: no look narrows the chat, the message box or the strip above it (as in Engineering)', () => {
  // The part a rule styles is its last compound selector (a descendant such as `.input-area textarea` is not the column).
  const PARTS = /(\.messages|#messages|\.input-area|\.composer|#composer|\.handoff-cards|\.ho-strip|\.chat-busy-card|\.chat-panel|\.chat-area|\.main)(?![\w-])[^\s>+~]*$/;
  const chatSel = { test: (sel) => sel.split(',').some(one => PARTS.test(one.trim())) };
  for (const look of L.LOOKS.filter(l => l.css)) {
    const css = read(look.css.replace(/^\//, '')).replace(/\/\*[\s\S]*?\*\//g, '');
    const cmw = [...css.matchAll(/--chat-max-width\s*:\s*([^;]+);/g)].map(m => m[1].trim());
    assert.ok(cmw.every(v => v === 'none'), `${look.id}: --chat-max-width is Engineering's none (${cmw.join(', ')})`);
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim(), body = m[2];
      if (!chatSel.test(sel)) continue;
      for (const d of body.matchAll(/(?:^|;)\s*(max-width|width|max-inline-size|inline-size)\s*:\s*([^;]+)/g)) {
        assert.ok(/^(none|100%|auto)$/.test(d[2].trim()), `${look.id}: ${sel} sets ${d[1]}: ${d[2].trim()}`);
      }
      assert.doesNotMatch(body, /margin(-inline|-left|-right|-inline-start|-inline-end)?\s*:\s*[^;]*\bauto\b/, `${look.id}: ${sel} centres itself with auto margins`);
    }
  }
});

test('full width: a collapsed sidebar keeps no border in any look (Engineering\'s .sidebar.collapsed has none)', () => {
  // A rule on the sidebar itself (its last compound selector holds .sidebar) applies to the collapsed sidebar unless it is
  // limited to :not(.collapsed); its border must then be none. Descendants of the sidebar are not the sidebar.
  const onSidebar = (one) => { const last = one.trim().split(/[\s>+~]+/).pop(); return /\.sidebar(?![\w-])/.test(last) ? last : null; };
  const borderValues = (body) => [...body.matchAll(/(?:^|;)\s*(border|border-right|border-inline-end)\s*:\s*([^;]+)/g)].map(m => m[2].trim().replace(/\s*!important$/, ''));
  const bad = (css) => {
    const out = [];
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const one of m[1].split(',')) {
        const last = onSidebar(one);
        if (!last || /:not\(\.collapsed\)/.test(last)) continue;
        if (borderValues(m[2]).some(v => !/^(none|0)$/.test(v))) out.push(one.trim());
      }
    }
    return out;
  };
  for (const look of L.LOOKS.filter(l => l.css)) {
    const css = read(look.css.replace(/^\//, '')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.deepStrictEqual(bad(css), [], `${look.id}: a rule that reaches the collapsed sidebar draws a border`);
  }
  // the rule itself, on samples
  assert.deepStrictEqual(bad('x .sidebar { border-right: 1px solid red; }'), ['x .sidebar']);
  assert.deepStrictEqual(bad('x .sidebar.collapsed { border-right: 1px solid red; }'), ['x .sidebar.collapsed']);
  assert.deepStrictEqual(bad('x .sidebar.collapsed { border-right: none; } x .sidebar.narrow { border-right: none; }'), []);
  assert.deepStrictEqual(bad('x .sidebar:not(.collapsed) { border-right: 1px solid red; } x .sidebar .item { border-right: 1px solid red; }'), []);
  assert.deepStrictEqual(bad('x .sidebar { border: 1px solid red; }'), ['x .sidebar']);
});

test('people read "Interface style", never "Look": every label and sentence of the pickers, Appearance, Profile, the Simple sheet and the phone menu', () => {
  const app = read('app.js'), mob = read('mobile.js'), html = read('mobile.html');
  const fn = (src, name) => { const a = src.indexOf(`function ${name}(`); assert.ok(a >= 0, name); const b = src.indexOf('\nfunction ', a + 10), c = src.indexOf('\n    function ', a + 10); const ends = [b, c].filter(x => x > a); return src.slice(a, ends.length ? Math.min(...ends) : a + 4000); };
  const regions = [
    ['app.js lookPickerBuild', fn(app, 'lookPickerBuild')], ['app.js lookSectionPaint', fn(app, 'lookSectionPaint')],
    ['mobile.js lookPickerPaint', fn(mob, 'lookPickerPaint')], ['mobile.js openProfileSheet', fn(mob, 'openProfileSheet')],
    ['mobile.js menuLookName', fn(mob, 'menuLookName')],
    ['mobile.js Simple sheet', mob.slice(mob.indexOf('id="ss-style-sec"') - 200, mob.indexOf('id="ss-style-sec"') + 400)],
    ['mobile.html menu', html.slice(html.indexOf('id="menu-look"') - 20, html.indexOf('id="menu-look-pick"') + 40)],
  ];
  // What a person reads: quoted text with a space, a one-word label, or markup text between tags (not ids, classes or selectors).
  const words = (src) => [
    ...[...src.matchAll(/(['"`])((?:(?!\1)[^\\\n])*)\1/g)].map(m => m[2]).filter(t => /\s/.test(t) || /^[A-Z][a-z]+$/.test(t)),
    ...[...src.matchAll(/>([^<>{}]+)</g)].map(m => m[1].trim()).filter(Boolean),
  ];
  for (const [where, src] of regions) {
    assert.ok(src.length > 40, where);
    const bad = words(src).filter(t => /\b[Ll]ooks?\b/.test(t) && !/data-look|menu-look|looks-restart|st-look/.test(t));
    assert.deepStrictEqual(bad, [], `${where} shows the old word`);
  }
  for (const l of L.LOOKS) assert.doesNotMatch(`${l.label} ${l.blurb}`, /\blooks?\b/i, `${l.id}: its name and description in the picker`);
  assert.match(html, /&#x1F3A8; Interface style<\/span>/);
  assert.match(mob, /<div class="ss-title">Interface style<\/div>/);
  assert.match(mob, /<div class="sec-title">Interface style<\/div>/);
});
