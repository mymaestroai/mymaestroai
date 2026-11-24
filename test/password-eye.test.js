'use strict';
// password-eye.js: the show/hide eye on every typed-password field. The helper runs against a minimal element stub (no
// browser, no jsdom); the page checks are source checks in the ui-*.test.js pattern. Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

// ---- a minimal DOM: just what the helper touches -------------------------------------------------------------------
class El {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.doc = doc; this.attrs = {}; this.children = []; this.parentNode = null;
    this.listeners = {}; this.className = ''; this.innerHTML = ''; this.type = ''; this.value = ''; this.style = { setProperty() {} };
    this.selectionStart = 0; this.selectionEnd = 0; this.selectionDirection = 'none';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'type') this.type = String(v); if (k === 'class') this.className = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.children.indexOf(this); return p.children[i + 1] || null; }
  appendChild(c) { if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1); c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
    c.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, extra = {}) {   // the event runs on this element, then on the document (capture and bubble are not told apart)
    const ev = { type: t, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    (this.listeners[t] || []).forEach(fn => fn(ev));
    if (this.doc) (this.doc.listeners[t] || []).forEach(fn => fn(ev));
    return ev;
  }
  click() { return this.dispatch('click'); }
  focus() { this.doc.activeElement = this; }
  setSelectionRange(s, e, d) { this.selectionStart = s; this.selectionEnd = e; this.selectionDirection = d || 'none'; this.selectionResets = (this.selectionResets || 0) + 1; }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(sel) {
    assert.strictEqual(sel, 'input[data-eye]', 'the helper only asks for input[data-eye]');
    return [...this.walk()].filter(e => e.tagName === 'INPUT' && e.getAttribute('data-eye') !== null);
  }
}
function makeDoc() {
  const doc = new El('#document');
  doc.doc = null; doc.listeners = {};
  doc.createElement = (t) => new El(t, doc);
  doc.head = new El('head', doc); doc.body = new El('body', doc); doc.documentElement = doc;
  doc.children.push(doc.head, doc.body); doc.head.parentNode = doc; doc.body.parentNode = doc;
  doc.getElementById = (id) => [...doc.walk()].find(e => (e.id || e.attrs.id) === id) || null;
  doc.activeElement = null;
  return doc;
}
function input(doc, parent, attrs = {}) {
  const el = doc.createElement('input');
  el.setAttribute('type', 'password');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.appendChild(el);
  return el;
}
function fresh() {
  const doc = makeDoc();
  global.document = doc;
  delete require.cache[require.resolve('../password-eye.js')];
  const PasswordEye = require('../password-eye.js');
  return { doc, PasswordEye };
}
require('node:test').afterEach(() => { delete global.document; delete global.PasswordEye; });

const eyeOf = (el) => (el.nextSibling && /\bpw-eye\b/.test(el.nextSibling.className) ? el.nextSibling : null);

test('attach: one type="button" eye on a data-eye input, none on an API-key input', () => {
  const { doc, PasswordEye } = fresh();
  const form = doc.createElement('form'); doc.body.appendChild(form);
  const pw = input(doc, form, { id: 'a-pass', 'data-eye': '', autocomplete: 'new-password', name: 'password' });
  const key = input(doc, form, { id: 'k-key', autocomplete: 'off' });
  PasswordEye.attach(doc);
  PasswordEye.attach(doc);   // a second pass adds nothing
  const btn = eyeOf(pw);
  assert.ok(btn, 'the eye follows the input');
  assert.strictEqual(btn.tagName, 'BUTTON');
  assert.strictEqual(btn.getAttribute('type'), 'button');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Show password');
  assert.strictEqual(btn.getAttribute('aria-pressed'), 'false');
  assert.match(btn.innerHTML, /<svg/);
  assert.strictEqual(form.children.filter(c => c.tagName === 'BUTTON').length, 1, 'exactly one button');
  assert.strictEqual(eyeOf(key), null, 'a key field gets nothing');
  assert.strictEqual(form.children.indexOf(pw), 0, 'the input keeps its place');
  assert.strictEqual(pw.getAttribute('autocomplete'), 'new-password');
  assert.strictEqual(pw.getAttribute('name'), 'password');
  assert.ok(doc.getElementById('pw-eye-style'), 'one injected style with a fixed id');
  assert.strictEqual([...doc.walk()].filter(e => (e.id || e.attrs.id) === 'pw-eye-style').length, 1);
});

test('the style: Edge reveal hidden, 36px target on phones, theme colours', () => {
  const { PasswordEye } = fresh();
  assert.match(PasswordEye._css, /::-ms-reveal/);
  assert.match(PasswordEye._css, /--pw-eye-w: 36px/);
  assert.match(PasswordEye._css, /var\(--text-dim/);
  assert.match(PasswordEye._css, /currentColor/);
  assert.match(PasswordEye._css, /padding-right/);
});

test('a click toggles password <-> text and the labels; the press does not move focus; the caret survives', () => {
  const { doc, PasswordEye } = fresh();
  const pw = input(doc, doc.body, { id: 'login-password', 'data-eye': '' });
  PasswordEye.attach(doc);
  const btn = eyeOf(pw);
  pw.focus(); pw.selectionStart = 2; pw.selectionEnd = 5; pw.selectionDirection = 'forward';
  assert.strictEqual(btn.dispatch('mousedown').defaultPrevented, true, 'mousedown does not take focus');
  assert.strictEqual(btn.dispatch('pointerdown').defaultPrevented, true);
  const ev = btn.click();
  assert.strictEqual(ev.defaultPrevented, true, 'never a form submit');
  assert.strictEqual(pw.type, 'text');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Hide password');
  assert.strictEqual(btn.getAttribute('aria-pressed'), 'true');
  assert.match(btn.innerHTML, /pw-eye-icon-hide/, 'eye-off icon while shown');
  assert.strictEqual(doc.activeElement, pw, 'focus stayed on the input');
  assert.deepStrictEqual([pw.selectionStart, pw.selectionEnd, pw.selectionDirection], [2, 5, 'forward'], 'selection restored');
  btn.click();
  assert.strictEqual(pw.type, 'password');
  assert.strictEqual(btn.getAttribute('aria-label'), 'Show password');
  assert.strictEqual(btn.getAttribute('aria-pressed'), 'false');
  assert.match(btn.innerHTML, /pw-eye-icon-show/);
});

test('without focus in the field the toggle does not steal it', () => {
  const { doc, PasswordEye } = fresh();
  const pw = input(doc, doc.body, { 'data-eye': '' });
  const other = doc.createElement('input'); doc.body.appendChild(other); other.focus();
  PasswordEye.attach(doc);
  eyeOf(pw).click();
  assert.strictEqual(pw.type, 'text');
  assert.strictEqual(doc.activeElement, other);
});

test('only the clicked field changes', () => {
  const { doc, PasswordEye } = fresh();
  const a = input(doc, doc.body, { id: 'p1', 'data-eye': '' });
  const b = input(doc, doc.body, { id: 'p2', 'data-eye': '' });
  PasswordEye.attach(doc);
  eyeOf(a).click();
  assert.strictEqual(a.type, 'text');
  assert.strictEqual(b.type, 'password');
});

test('form submit, form reset and dialog close put the field back to password; so does hideAll', () => {
  const { doc, PasswordEye } = fresh();
  const form = doc.createElement('form'); doc.body.appendChild(form);
  const dlg = doc.createElement('dialog'); doc.body.appendChild(dlg);
  const modal = doc.createElement('div'); doc.body.appendChild(modal);
  const a = input(doc, form, { id: 'f1', 'data-eye': '' });
  const b = input(doc, dlg, { id: 'd1', 'data-eye': '' });
  const c = input(doc, modal, { id: 'm1', 'data-eye': '' });
  const d = input(doc, form, { id: 'f2', 'data-eye': '' });
  PasswordEye.attach(doc);
  for (const el of [a, b, c, d]) eyeOf(el).click();
  assert.deepStrictEqual([a, b, c, d].map(e => e.type), ['text', 'text', 'text', 'text']);
  form.dispatch('submit');
  assert.deepStrictEqual([a.type, d.type], ['password', 'password'], 'submit hides the form\'s fields');
  assert.strictEqual(b.type, 'text', 'other forms and dialogs are untouched by it');
  eyeOf(a).click();
  form.dispatch('reset');
  assert.strictEqual(a.type, 'password', 'reset hides it');
  dlg.dispatch('close');
  assert.strictEqual(b.type, 'password', 'a closing dialog hides its fields');
  assert.strictEqual(c.type, 'text');
  PasswordEye.hideAll(modal);
  assert.strictEqual(c.type, 'password', 'hideAll(root)');
  assert.strictEqual(eyeOf(c).getAttribute('aria-label'), 'Show password');
  assert.strictEqual(eyeOf(c).getAttribute('aria-pressed'), 'false');
  eyeOf(a).click(); eyeOf(c).click();
  PasswordEye.hideAll();
  assert.deepStrictEqual([a.type, c.type], ['password', 'password'], 'hideAll() covers the document');
});

test('a re-created field starts hidden, with its own eye', () => {
  const { doc, PasswordEye } = fresh();
  const box = doc.createElement('div'); doc.body.appendChild(box);
  const first = input(doc, box, { id: 'bk-pw1', 'data-eye': '' });
  PasswordEye.attach(doc);
  eyeOf(first).click();
  assert.strictEqual(first.type, 'text');
  box.children.length = 0;   // the page rebuilds the dialog
  const again = input(doc, box, { id: 'bk-pw1', 'data-eye': '' });
  again.type = 'text';        // even one that was written as shown
  PasswordEye.attach(box);
  assert.strictEqual(again.type, 'password');
  assert.ok(eyeOf(again));
  assert.strictEqual(eyeOf(again).getAttribute('aria-pressed'), 'false');
  assert.strictEqual(box.children.filter(c => c.tagName === 'BUTTON').length, 1);
});

test('watch(): attaches now and is safe to call twice', () => {
  const { doc, PasswordEye } = fresh();
  const pw = input(doc, doc.body, { 'data-eye': '' });
  PasswordEye.watch(); PasswordEye.watch();
  assert.ok(eyeOf(pw));
  assert.strictEqual(doc.body.children.filter(c => c.tagName === 'BUTTON').length, 1);
});

test('watch(): fields added later (dialogs built in script) get their eye through the MutationObserver; text nodes are ignored', () => {
  const { doc } = fresh();
  let observer = null, made = 0;
  global.MutationObserver = class { constructor(cb) { this.cb = cb; observer = this; made++; } observe() { this.on = true; } };
  try {
    delete require.cache[require.resolve('../password-eye.js')];
    const PasswordEye = require('../password-eye.js');
    PasswordEye.watch(); PasswordEye.watch();
    assert.strictEqual(made, 1, 'one observer');
    assert.ok(observer.on, 'observing');
    const wrapper = doc.createElement('div'); doc.body.appendChild(wrapper); wrapper.nodeType = 1;
    const nested = input(doc, wrapper, { id: 'nested', 'data-eye': '' });
    const lone = input(doc, doc.body, { id: 'lone', 'data-eye': '' }); lone.nodeType = 1;
    observer.cb([{ addedNodes: [wrapper, lone, { nodeType: 3 }] }]);
    assert.ok(eyeOf(nested), 'a field inside an added block');
    assert.ok(eyeOf(lone), 'an added field');
  } finally { delete global.MutationObserver; }
});

// ---- served, loaded, marked --------------------------------------------------------------------------------------
test('lib/static-files serves password-eye.js; it is public so the sign-in and setup pages can load it', () => {
  const { resolve, TOP_FILES } = require('../lib/static-files');
  const r = resolve('/password-eye.js');
  assert.ok(r && r.endsWith(path.sep + 'password-eye.js'));
  assert.ok(fs.statSync(r).isFile());
  assert.ok(TOP_FILES.has('password-eye.js'));
  assert.strictEqual(require('../lib/access').classifyRoute('/password-eye.js', 'GET').kind, 'public');
});

const PAGES = ['login.html', 'welcome.html', 'users.html', 'modules.html', 'index.html', 'mobile.html'];
test('every page with a typed-password field loads the helper and starts it once the page is ready', () => {
  for (const f of PAGES) {
    const src = read(f);
    assert.match(src, /<script src="\/password-eye\.js"><\/script>/, `${f} loads the helper`);
    assert.match(src, /DOMContentLoaded', function \(\) \{ PasswordEye\.watch\(\); \}/, `${f} calls PasswordEye.watch()`);
    assert.ok(src.indexOf('/password-eye.js') < src.indexOf('PasswordEye.watch()'), `${f}: load, then start`);
  }
  const idx = read('index.html'); assert.ok(idx.indexOf('/password-eye.js') < idx.indexOf('<script src="app.js">'));
  const mob = read('mobile.html'); assert.ok(mob.indexOf('/password-eye.js') < mob.indexOf('<script src="mobile.js">'));
});

test('the phone service worker version moved (mobile.html and mobile.js changed); the shell list stays the page and its script', () => {
  const sw = read('sw.js');
  assert.match(sw, /const SHELL = \['\/mobile\.html', '\/mobile\.js'\];/, 'helper scripts are not precached (as with the /ui-*.js files)');
  assert.match(sw, /const VERSION = 'hub-mobile-v90'/);
});

// The password-type inputs the source holds today: typed passwords (account, backup, restore, step-up, keystore
// passphrases, connector passphrases) must carry data-eye; API keys, tokens and provider secrets must not.
const TYPED = {
  'login.html': ['login-password', 'invite-password', 'invite-password2'],
  'welcome.html': ['r-pw', 'rc-pass', 'a-pass', 'a-pass2'],
  'users.html': ['create-password', 'p-pw', 'p-pw2'],
  'modules.html': ['${cls}-pass su-pass'],
  'app.js': ['sec-pw-current', 'sec-pw-new', 'sec-pw-new2', 'sec-2fa-password', 'bk-pw1', 'bk-pw2', 'bk-acct', '${id}-acct', 'bk-pw-old', 'bk-pw-new1', 'bk-pw-new2',
    'bk-fin-old', 'bk-fin-new', 'bk-sk-pw', 'bk-su-pw', 'bk-r-pw', 'bk-c-pw', 'w-pass', 'w-pass' /* create form, then unlock box */, 'w-pass2', 'w-reveal-pass', 'pk-pass', 'x-pass', 'h-pass', 'fw-pass', 'st-a2fa-pw',
    'st-cx-gpass-${hubEsc(g.id)}', 'st-cx-gdel-${hubEsc(g.id)}', 'st-cx-pass-${id}', 'st-cx-g-pass', 'st-cx-g-pass2', 'st-cx-f-curpass', 'st-cx-f-newpass', 'st-cx-f-newpass2'],
  'mobile.js': ['wl-pass', 'wl-pk-pass', 'sec-pw-current', 'sec-pw-new', 'sec-pw-new2', 'sec-2fa-password'],
};
const KEYS = {
  'welcome.html': ['k-key'],
  'modules.html': ['sec-${esc(x.name)}'],   // a connector's secret values (service keys, tokens)
  'app.js': ['st-key-${p.id}', 'st-ws-key-${id}', 'cx-secret-value'],
  'comms-panel.js': ['comms-token'],
};
const passwordInputs = (file) => (read(file).match(/<input\b[^>]*\btype="password"[^>]*>/g) || []).map((tag) => {
  const id = /\bid="([^"]*)"/.exec(tag); const cls = /\bclass="([^"]*)"/.exec(tag);
  return { tag, name: id ? id[1] : cls ? cls[1] : '(none)', eye: /\sdata-eye(\s|>|=)/.test(tag) };
});

test('every typed-password input has data-eye; no API-key / token / secret input has it; nothing is undecided', () => {
  const files = new Set([...Object.keys(TYPED), ...Object.keys(KEYS)]);
  for (const f of files) {
    const found = passwordInputs(f);
    const typed = TYPED[f] || [], keys = KEYS[f] || [];
    assert.deepStrictEqual(found.map(x => x.name).sort(), [...typed, ...keys].sort(), `${f}: the password inputs are exactly the ones this test lists (a new one needs a decision)`);
    for (const x of found) {
      if (typed.includes(x.name)) assert.ok(x.eye, `${f}: ${x.name} is a typed password and needs data-eye`);
      else assert.ok(!x.eye, `${f}: ${x.name} is a key/token field and must not have data-eye`);
    }
  }
});

test('no other file builds a password input in script', () => {
  const skip = new Set(['node_modules', 'test', 'data', '.git', 'docs', 'vendor', 'workspaces', 'sandbox']);
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') || skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|js)$/.test(e.name) && !Object.keys(TYPED).concat(Object.keys(KEYS)).includes(path.relative(root, p)) && e.name !== 'password-eye.js') {
        if (/<input\b[^>]*\btype="password"|\btype\s*:\s*['"]password['"]|\.type\s*=\s*'password'/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    }
  };
  walk(root);
  assert.deepStrictEqual(hits, [], 'a password input in a file this test does not list');
});

test('the phone wallet sheet empties a shown field too and hides it again when it closes', () => {
  const m = read('mobile.js');
  const close = m.slice(m.indexOf('function walletClose('), m.indexOf('function walletSheet('));
  assert.ok(close.indexOf('PasswordEye.hideAll(sh)') > 0 && close.indexOf('PasswordEye.hideAll(sh)') < close.indexOf("querySelectorAll('input[type=\"password\"]')"), 'hidden again first, so the next line finds every field');
  assert.match(close, /typeof PasswordEye !== 'undefined'/);
});

test('the styles that target password inputs also reach a field that is currently shown (type text)', () => {
  assert.match(read('login.html'), /input\[type="password"\], input\[data-eye\] \{/);
  assert.match(read('welcome.html'), /input\[type="password"\], input\[data-eye\], select/);
  assert.match(read('users.html'), /\.row input\[data-eye\] \{ flex: 1 1 160px; \}/);
  assert.match(read('modules.html'), /input\[type="password"\], input\[data-eye\], input\[type="number"\], textarea, select \{/);
  assert.match(read('mobile.html'), /\.wl-body input\[data-eye\]/);
  const idx = read('index.html');
  for (const sel of ['.st-row input[data-eye]', '.bk-modal input[data-eye]', '.cx-actions input[data-eye]']) assert.ok(idx.includes(sel), sel);
});

test('r2 layout: a wrapped input that carries an inline margin gets it set to 0 (the wrapper has it now, so the gap is not doubled); no margin: nothing touched', () => {
  const { doc, PasswordEye } = fresh();
  recordingSpans(doc);
  withStyles((styles) => {
    const col = doc.createElement('div'); doc.body.appendChild(col);
    const pw = input(doc, col, { 'data-eye': '' });
    pw.style = { margin: '4px 0px 0px 8px', setProperty() {} };
    styles.set(col, { display: 'flex', flexDirection: 'column' });
    styles.set(pw, { display: 'block', margin: '4px 0px 0px 8px' });
    PasswordEye.attach(doc);
    assert.strictEqual(pw.parentNode.written.margin, '4px 0px 0px 8px', 'the wrapper carries the margin');
    assert.strictEqual(pw.style.margin, '0', 'the input does not');
  });
  const f2 = fresh(); recordingSpans(f2.doc);
  withStyles((styles) => {
    const col = f2.doc.createElement('div'); f2.doc.body.appendChild(col);
    const pw = input(f2.doc, col, { 'data-eye': '' });
    pw.style = { margin: '', setProperty() {} };
    styles.set(col, { display: 'grid' });
    styles.set(pw, { display: 'block', margin: '0px' });
    f2.PasswordEye.attach(f2.doc);
    assert.strictEqual(pw.style.margin, '', 'no margin to move: untouched');
  });
});

test('r2 layout: the two-factor code field in the .bk-two rows is still targeted now that the eye sits between the two inputs', () => {
  const idx = read('index.html');
  assert.ok(idx.includes('.bk-modal .bk-two > input:last-child { flex: 0 0 130px; }'));
  assert.ok(!/\.bk-two input:nth-child\(2\)/.test(idx), 'the old selector would hit the eye button');
  const app = read('app.js');
  const rows = app.match(/class="bk-two">.*$/gm) || [];
  assert.ok(rows.length >= 3, `${rows.length} rows`);
  for (const r of rows) {
    const html = r.replace(/\$\{totp \? (?:`[^`]*`|'[^']*') : ''\}/, '@@CODE@@');
    assert.match(html, /^class="bk-two"><input type="password" data-eye /, 'the password input comes first');
    assert.ok(!/<input type="password"/.test(html.slice(html.indexOf('@@CODE@@') >= 0 ? html.indexOf('@@CODE@@') : html.length)), 'no password input after the code field');
  }
});

test('an eye field never feeds spell checkers or the phone keyboard: spellcheck, autocorrect, autocapitalize and grammar add-ons off', () => {
  const { doc, PasswordEye } = fresh();
  const pw = input(doc, doc.body, { 'data-eye': '' });
  const key = input(doc, doc.body, { id: 'api-key' });
  PasswordEye.attach(doc);
  assert.strictEqual(pw.getAttribute('spellcheck'), 'false');
  assert.strictEqual(pw.getAttribute('autocorrect'), 'off');
  assert.strictEqual(pw.getAttribute('autocapitalize'), 'off');
  assert.strictEqual(pw.getAttribute('data-gramm'), 'false');
  assert.strictEqual(key.getAttribute('spellcheck'), null, 'a field without data-eye is left exactly as it was');
});

// ---- R1: layout decided from the parent; hidden again on the person's actions ----------------------------------------
function withStyles(fn) {
  const styles = new Map();   // element -> computed style
  globalThis.getComputedStyle = (el) => styles.get(el) || { display: 'block', flexDirection: '', columnGap: '0' };
  try { fn(styles); } finally { delete globalThis.getComputedStyle; }
}
function recordingSpans(doc) {   // every created span keeps what is written to its inline style
  const make = doc.createElement;
  doc.createElement = (t) => {
    const el = make(t);
    if (t === 'span') { el.written = {}; el.style = { setProperty(k, v) { el.written[k] = v; } }; }
    return el;
  };
}

test('layout: a flex row parent is never wrapped, even when the input reports display block', () => {
  const { doc, PasswordEye } = fresh();
  withStyles((styles) => {
    const row = doc.createElement('div'); doc.body.appendChild(row);
    const pw = input(doc, row, { 'data-eye': '' });
    styles.set(row, { display: 'flex', flexDirection: 'row', columnGap: '8px' });
    styles.set(pw, { display: 'block' });   // a flex item is blockified
    PasswordEye.attach(doc);
    assert.strictEqual(pw.parentNode, row, 'not wrapped');
    assert.ok(eyeOf(pw), 'the eye is the next sibling');
    // a flex parent whose direction is empty behaves as a row too
    const row2 = doc.createElement('div'); doc.body.appendChild(row2);
    const pw2 = input(doc, row2, { 'data-eye': '' });
    styles.set(row2, { display: 'inline-flex', flexDirection: '' });
    styles.set(pw2, { display: 'block' });
    PasswordEye.attach(doc);
    assert.strictEqual(pw2.parentNode, row2);
  });
});

test('layout: a grid parent and a column flex parent are wrapped; a plain parent only for a block input', () => {
  const { doc, PasswordEye } = fresh();
  withStyles((styles) => {
    const grid = doc.createElement('div'); doc.body.appendChild(grid);
    const col = doc.createElement('div'); doc.body.appendChild(col);
    const plainInline = doc.createElement('div'); doc.body.appendChild(plainInline);
    const plainBlock = doc.createElement('div'); doc.body.appendChild(plainBlock);
    const g = input(doc, grid, { 'data-eye': '' }), c = input(doc, col, { 'data-eye': '' });
    const pi = input(doc, plainInline, { 'data-eye': '' }), pb = input(doc, plainBlock, { 'data-eye': '' });
    styles.set(grid, { display: 'grid' });
    styles.set(col, { display: 'flex', flexDirection: 'column' });
    styles.set(plainInline, { display: 'block' }); styles.set(pi, { display: 'inline-block' });
    styles.set(plainBlock, { display: 'block' }); styles.set(pb, { display: 'block' });
    PasswordEye.attach(doc);
    assert.match(g.parentNode.className, /\bpw-eye-wrap\b/, 'grid parent');
    assert.match(c.parentNode.className, /\bpw-eye-wrap\b/, 'column flex parent');
    assert.strictEqual(pi.parentNode, plainInline, 'inline input in a normal parent: row form');
    assert.match(pb.parentNode.className, /\bpw-eye-wrap\b/, 'block input in a normal parent');
  });
});

test('layout: a wrapped input hands its flex, max-width, min-width, margin, grid placement and inline width to the wrapper', () => {
  const { doc, PasswordEye } = fresh();
  recordingSpans(doc);
  withStyles((styles) => {
    const col = doc.createElement('div'); doc.body.appendChild(col);
    const pw = input(doc, col, { 'data-eye': '' });
    pw.style = { width: '70%', setProperty() {} };
    styles.set(col, { display: 'flex', flexDirection: 'column' });
    styles.set(pw, { display: 'block', flexGrow: '1', flexShrink: '1', flexBasis: '160px', maxWidth: '420px', minWidth: '120px', margin: '4px 0px 0px 8px', gridColumn: '1 / 3', gridRow: '2' });
    PasswordEye.attach(doc);
    const w = pw.parentNode;
    assert.match(w.className, /\bpw-eye-wrap\b/);
    assert.deepStrictEqual(w.written, { flex: '1 1 160px', width: '70%', 'max-width': '420px', 'min-width': '120px', margin: '4px 0px 0px 8px', 'grid-column': '1 / 3', 'grid-row': '2' });
  });
  // without an inline width, no width is copied
  const f2 = fresh(); recordingSpans(f2.doc);
  withStyles((styles) => {
    const col = f2.doc.createElement('div'); f2.doc.body.appendChild(col);
    const pw = input(f2.doc, col, { 'data-eye': '' });
    styles.set(col, { display: 'grid' });
    styles.set(pw, { display: 'block', flexGrow: '0', flexShrink: '1', flexBasis: 'auto', maxWidth: 'none', width: '300px' });
    f2.PasswordEye.attach(f2.doc);
    assert.strictEqual(pw.parentNode.written.width, undefined);
    assert.strictEqual(pw.parentNode.written['max-width'], undefined);
  });
});

test('a click on any other button, [role=button], submit or button input hides every shown field; the eyes themselves do not', () => {
  const { doc, PasswordEye } = fresh();
  const a = input(doc, doc.body, { id: 'p1', 'data-eye': '' });
  const b = input(doc, doc.body, { id: 'p2', 'data-eye': '' });
  const btn = doc.createElement('button'); doc.body.appendChild(btn);
  const inner = doc.createElement('span'); btn.appendChild(inner);
  const roleBtn = doc.createElement('div'); roleBtn.setAttribute('role', 'button'); doc.body.appendChild(roleBtn);
  const sub = doc.createElement('input'); sub.setAttribute('type', 'submit'); doc.body.appendChild(sub);
  const bi = doc.createElement('input'); bi.setAttribute('type', 'button'); doc.body.appendChild(bi);
  const plain = doc.createElement('div'); doc.body.appendChild(plain);
  PasswordEye.attach(doc);
  const show = () => { for (const el of [a, b]) if (el.type !== 'text') eyeOf(el).click(); };
  show();
  assert.deepStrictEqual([a.type, b.type], ['text', 'text'], 'showing the second field does not hide the first');
  eyeOf(b).click();
  assert.deepStrictEqual([a.type, b.type], ['text', 'password'], 'a click on the second field\'s eye only toggles it');
  eyeOf(b).click();
  plain.click();
  assert.deepStrictEqual([a.type, b.type], ['text', 'text'], 'a click on plain content does not');
  btn.click();
  assert.deepStrictEqual([a.type, b.type], ['password', 'password'], 'another button');
  for (const el of [roleBtn, sub, bi, inner]) {
    show();
    el.click();
    assert.deepStrictEqual([a.type, b.type], ['password', 'password'], el.tagName + ' ' + (el.getAttribute('role') || el.getAttribute('type') || ''));
  }
  a.value = 'secret'; show(); btn.click();
  assert.strictEqual(a.value, 'secret', 'the value is untouched');
});

test('Enter in a shown field hides it; other keys and other fields do not', () => {
  const { doc, PasswordEye } = fresh();
  const a = input(doc, doc.body, { id: 'p1', 'data-eye': '' });
  const b = input(doc, doc.body, { id: 'p2', 'data-eye': '' });
  PasswordEye.attach(doc);
  eyeOf(a).click(); eyeOf(b).click();
  a.dispatch('keydown', { key: 'a' });
  assert.strictEqual(a.type, 'text');
  a.dispatch('keydown', { key: 'Enter' });
  assert.strictEqual(a.type, 'password');
  assert.strictEqual(b.type, 'text', 'only the field Enter was pressed in');
  assert.strictEqual(eyeOf(a).getAttribute('aria-pressed'), 'false');
});

test('pagehide and visibilitychange to hidden hide every shown field; visibilitychange to visible does not', () => {
  const { doc, PasswordEye } = fresh();
  const a = input(doc, doc.body, { id: 'p1', 'data-eye': '' });
  const b = input(doc, doc.body, { id: 'p2', 'data-eye': '' });
  PasswordEye.attach(doc);
  eyeOf(a).click(); eyeOf(b).click();
  doc.visibilityState = 'visible'; doc.dispatch('visibilitychange');
  assert.deepStrictEqual([a.type, b.type], ['text', 'text']);
  doc.visibilityState = 'hidden'; doc.dispatch('visibilitychange');
  assert.deepStrictEqual([a.type, b.type], ['password', 'password']);
  eyeOf(a).click(); eyeOf(b).click();
  doc.dispatch('pagehide');
  assert.deepStrictEqual([a.type, b.type], ['password', 'password']);
});

test('a stacked field that already has focus keeps it, with its caret, when it is wrapped for the eye', () => {
  const { doc, PasswordEye } = fresh();
  const realAppend = El.prototype.appendChild;
  const realInsert = El.prototype.insertBefore;
  // As in a browser: moving the focused element out of its place blurs it.
  El.prototype.appendChild = function (c) { if (c.doc && c.doc.activeElement === c) c.doc.activeElement = null; return realAppend.call(this, c); };
  El.prototype.insertBefore = function (c, r) { if (c.doc && c.doc.activeElement === c) c.doc.activeElement = null; return realInsert.call(this, c, r); };
  globalThis.getComputedStyle = () => ({ display: 'grid', flexDirection: '', columnGap: '0' });
  try {
    const box = doc.createElement('div'); doc.body.appendChild(box);
    const pw = input(doc, box, { 'data-eye': '' });
    pw.focus(); pw.selectionStart = 3; pw.selectionEnd = 3; pw.selectionDirection = 'none';
    PasswordEye.attach(doc);
    assert.match(pw.parentNode.className, /\bpw-eye-wrap\b/, 'the stacked field was wrapped');
    assert.strictEqual(doc.activeElement, pw, 'focus came back to the field');
    assert.strictEqual(pw.selectionStart, 3);
    assert.strictEqual(pw.selectionEnd, 3);
  } finally {
    El.prototype.appendChild = realAppend;
    El.prototype.insertBefore = realInsert;
    delete globalThis.getComputedStyle;
  }
});
