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
  assert.strictEqual(L.rememberDefault('quiet', s, d), 'quiet');
  assert.strictEqual(s._m.get('mmLookDefault'), 'quiet');
  assert.strictEqual(d.documentElement.dataset.look, 'broadsheet', "this device's own choice stays");
  assert.strictEqual(L.rememberDefault('nope', s, d), null);
  assert.strictEqual(s._m.get('mmLookDefault'), 'quiet');
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
  const pages = ['index', 'mobile', 'agent-settings', 'changes', 'help', 'users', 'recordings', 'tiger-team', 'local-models', 'modules', 'welcome', 'login'];
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
  assert.match(server, /patch\.lookDefaultForNewMembers !== undefined && !require\('\.\/lib\/ui-looks'\)\.byId\(patch\.lookDefaultForNewMembers\)\) return jsonResponse\(res, 400/);
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
    assert.match(src, /L\.choose\(look\.id, window\.localStorage\)/, name);
    assert.match(src, /L\.apply\(document, look\.id\)/, name);
    assert.match(src, /createTextNode\('Aa'\)/, name);
    assert.match(src, /Applies to this device\. Simple mode works with every look\./, name);
    assert.match(src, /HubLooks\.rememberDefault\(/, name);
  }
  for (const [src, names] of [[app, ['lookPreviewBox', 'lookPickerBuild', 'lookSectionPaint']], [mob, ['lookSwatch', 'lookPickerPaint']]]) {
    for (const n of names) {
      const a = src.indexOf(`function ${n}(`);
      const body = src.slice(a, a + 3500);
      const end = body.search(/\n(?:    )?(?:function |const ST_GROUPS|\/\/ Profile)/);
      const fn = end > 0 ? body.slice(0, end + 1) : body;
      assert.doesNotMatch(fn, /innerHTML|insertAdjacentHTML/, `${n} builds no markup`);
    }
  }
  assert.match(app, /id="st-looks-section"><h4>Appearance<\/h4>/);
  assert.match(app, /Look for new members/);
  assert.match(app, /if \(!isHubAdmin\(\)\) return;\s*const row/);
  assert.match(mob, /id="prof-looks"/);
  assert.match(mob, /lookPickerPaint\(lh\)/);
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
