'use strict';
// Settings clean-up p7, page text: no "(s)" in words a person reads, one plural helper, the renames, and isHubAdmin with an unknown person.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const FILES = ['app.js', 'mobile.js', 'mobile.html', 'local-models.html', 'tiger-team.html'];

// Collect the text of every quoted string and template literal (not comments, not ${...} code, not regex literals).
function stringsOf(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prev = '';   // last significant character outside strings/comments
  function template() {   // i is just past the opening backtick
    let s = '';
    while (i < n) {
      const c = src[i];
      if (c === '\\') { s += src[i + 1] || ''; i += 2; continue; }
      if (c === '`') { i++; out.push(s); return; }
      if (c === '$' && src[i + 1] === '{') { i += 2; code('}'); continue; }
      s += c; i++;
    }
  }
  function code(end) {
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
      if (c === "'" || c === '"') {
        let s = ''; i++;
        while (i < n && src[i] !== c && src[i] !== '\n') { if (src[i] === '\\') { s += src[i + 1] || ''; i += 2; } else { s += src[i]; i++; } }
        i++; out.push(s); prev = 'a'; continue;
      }
      if (c === '`') { i++; template(); prev = 'a'; continue; }
      if (c === '/' && /[(,=:[!&|?{};]|^$/.test(prev)) {   // a regex literal
        i++; let cls = false;
        while (i < n && src[i] !== '\n') { const d = src[i]; if (d === '\\') { i += 2; continue; } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; i++; }
        i++; prev = 'a'; continue;
      }
      if (c === '{') depth++;
      if (c === '}') { if (end === '}' && depth === 0) { i++; return; } depth--; }
      if (!/\s/.test(c)) prev = c;
      i++;
    }
  }
  code(null);
  return out;
}

const PLURAL_WORD = /[A-Za-z]\((s|es)\)/;

test('no "(s)" in any string the five page files show', () => {
  const bad = [];
  for (const f of ['app.js', 'mobile.js']) {
    for (const s of stringsOf(read(f))) if (PLURAL_WORD.test(s)) bad.push(f + ': ' + s.slice(0, 80));
  }
  for (const f of ['mobile.html', 'local-models.html', 'tiger-team.html']) {
    const html = read(f);
    const scripts = [];
    const text = html.replace(/<script[^>]*>([\s\S]*?)<\/script>/g, (m, body) => { scripts.push(body); return ''; }).replace(/<!--[\s\S]*?-->/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
    if (PLURAL_WORD.test(text)) bad.push(f + ' (markup): ' + (text.match(/.{0,30}[A-Za-z]\((s|es)\).{0,20}/) || [''])[0]);
    for (const body of scripts) for (const s of stringsOf(body)) if (PLURAL_WORD.test(s)) bad.push(f + ': ' + s.slice(0, 80));
  }
  assert.deepStrictEqual(bad, []);
});

test('the scanner itself finds a "(s)" in a quote and ignores code and comments', () => {
  assert.deepStrictEqual(stringsOf("x = 'a model(s)'; // 2 file(s)\nfoo(s); y = `${esc(s)} tool(s)`;").filter((t) => PLURAL_WORD.test(t)), ['a model(s)', ' tool(s)']);
});

// ── the helper ──
function loadPlural(src, name) {
  const m = new RegExp('function ' + name + '\\(n, one, many\\) \\{[^\\n]*\\}|const ' + name + ' = \\(n, one, many\\) => [^\\n]*;').exec(src);
  assert.ok(m, 'helper ' + name + ' is in the file');
  return vm.runInNewContext('(' + (m[0].startsWith('function') ? m[0] : m[0].replace(/^const \w+ = /, '').replace(/;$/, '')) + ')');
}

for (const f of ['app.js', 'mobile.js', 'local-models.html', 'tiger-team.html']) {
  test(`${f}: plural(n, one, many) gives real words`, () => {
    const plural = loadPlural(read(f), 'plural');
    assert.strictEqual(plural(1, 'agent', 'agents'), '1 agent');
    assert.strictEqual(plural(3, 'agent', 'agents'), '3 agents');
    assert.strictEqual(plural(0, 'agent', 'agents'), '0 agents');
    assert.strictEqual(plural(2, 'box', 'boxes'), '2 boxes');
    assert.strictEqual(plural(2, 'file'), '2 files');
  });
}

test('the counted strings use the helper', () => {
  const app = read('app.js');
  for (const s of ["plural(h.account.openPositions, 'open position', 'open positions')", "plural(d.warnings, 'warning', 'warnings')", "plural(d.infos, 'note', 'notes')", "plural(r.fixed.length, 'file', 'files')", "plural(n, 'result', 'results')", "plural(instructions.length, 'worker', 'workers')"]) assert.ok(app.includes(s), s);
  assert.ok(read('local-models.html').includes("plural(r.dirs.length, 'folder', 'folders')"));
  assert.ok(read('tiger-team.html').includes("plural(gw.alert_ids.length, 'related alert', 'related alerts')"));
  const mob = read('mobile.js');
  assert.ok(mob.includes("n === 1 ? 'photo' : 'photos'"));
  assert.ok(!mob.includes('photo(s)'));
});

// ── renames: the words a person sees are the mapping's new words ──
test('renamed words show in the page files', () => {
  const app = read('app.js'), mob = read('mobile.js'), mhtml = read('mobile.html'), lm = read('local-models.html');
  assert.ok(app.includes('>Role</label>'));                                              // OPT-0003
  assert.ok(app.includes('Pause before it answers') && mhtml.includes('Pause before it answers') && mob.includes('Pause before it answers'));   // OPT-0029
  assert.ok(app.includes('Wait when I pause to think') && mhtml.includes('Wait when I pause to think'));                                   // OPT-0030
  assert.ok(app.includes('How easily I can interrupt it') && mhtml.includes('How easily I can interrupt it') && mob.includes('How easily I can interrupt it'));   // OPT-0031
  assert.ok(lm.includes('<label>Size of its working memory</label>'));                    // OPT-0042
  assert.ok(app.includes('aria-label="Thinking effort"') && mhtml.includes('aria-label="Thinking effort"'));   // OPT-0057
  assert.ok(app.includes('>Clone an agent</span>'));                                      // OPT-0133
  assert.ok(app.includes('Two-factor sign-in <span class="sec-badge on">') && mob.includes('Two-factor sign-in: on'));   // OPT-0150
  assert.ok(app.includes("Protect Maestro\\'s own code") && mob.includes("Protect Maestro\\'s own code"));              // OPT-0153
  assert.ok(app.includes('💾 Save chat'));                                                // OPT-0174
  assert.ok(app.includes('🔎 Search this chat') && mhtml.includes('Search this chat'));   // OPT-0175
  assert.ok(app.includes('>Show agent work</button>'));                                   // OPT-0177
  assert.ok(app.includes("row('Voice on or off for everyone'"));                          // OPT-0227
  assert.ok(app.includes('Show busy agents at the top'));                                 // OPT-0447
  assert.ok(app.includes('Light or dark') && mob.includes('Light or dark'));              // OPT-0237
  assert.ok(app.includes('Look of the interface') && mob.includes('Look of the interface') && mhtml.includes('Look of the interface'));   // OPT-0284
  assert.ok(app.includes('Pause music for a clearer call') && mhtml.includes('Pause music for a clearer call'));   // OPT-0899
  for (const old of ["Pause before I'm done</", 'Wait for me to go on</', 'Interrupt sensitivity</', 'Two-factor authentication <span', 'Context window (tokens)']) {
    assert.ok(!app.includes(old) && !mhtml.includes(old) && !lm.includes(old), old);
  }
  assert.ok(!app.includes("Pause before I\\'m done"));
});

// ── isHubAdmin ──
function adminWith(state) {
  const src = read('app.js');
  const m = /function isHubAdmin\(\) \{[\s\S]*?\n    \}/.exec(src);
  assert.ok(m, 'isHubAdmin is in app.js');
  return vm.runInNewContext(`(${m[0]})`, { window: state });
}

test('isHubAdmin: unknown person is not an admin; a hub with no accounts is its owner\'s', () => {
  assert.strictEqual(adminWith({})() , false);                                              // /api/me failed (offline, 500): hubMe missing
  assert.strictEqual(adminWith({ hubMe: null })(), false);
  assert.strictEqual(adminWith({ hubMe: null, hubNoAccounts: false })(), false);
  assert.strictEqual(adminWith({ hubMe: null, hubNoAccounts: true })(), true);              // no accounts at all: the one person is the owner
  assert.strictEqual(adminWith({ hubMe: { accounts: false, user: null, isAdmin: false } })(), true);   // /api/me says accounts:false
  assert.strictEqual(adminWith({ hubMe: { accounts: true, isAdmin: true } })(), true);
  assert.strictEqual(adminWith({ hubMe: { accounts: true, isAdmin: false } })(), false);   // a member
  assert.strictEqual(adminWith({ hubMe: { accounts: true } })(), true);                     // an older answer without the flag
});
