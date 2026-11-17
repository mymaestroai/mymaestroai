'use strict';
// Desktop page: download cards under replies, Recent from agents, Download as zip (app.js, index.html, static alias).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js'), html = read('index.html');
const staticFiles = require('../lib/static-files.js');

test('index.html loads /ui-file-card.js before app.js, and the alias serves lib/ui-file-card.js', () => {
  const at = (s) => html.indexOf(s);
  assert.ok(at('<script src="/ui-file-card.js"></script>') > 0, 'index.html loads the helper');
  assert.ok(at('/ui-file-card.js') < at('<script src="app.js">'), 'before app.js');
  const r = staticFiles.resolve('/ui-file-card.js');
  assert.ok(r && r.endsWith('lib/ui-file-card.js') && fs.existsSync(r));
  assert.strictEqual(staticFiles.resolve('/lib/ui-file-card.js'), null, 'only the alias');
});

test('app.js builds cards after a reply ends and when history is drawn, never per chunk, never throwing', () => {
  const fn = /async function attachFileCards\(el\) \{[\s\S]*?\n    \}\n/.exec(app);
  assert.ok(fn, 'attachFileCards exists');
  const body = fn[0];
  assert.match(body, /hubFileCard/); assert.match(body, /candidatesFrom\(/); assert.match(body, /resolveBatch\(/);
  assert.match(body, /cardHtml\(r, \{ esc, phone: false \}\)/); assert.match(body, /className = 'file-cards'/);
  assert.match(body, /try \{[\s\S]*catch/, 'wrapped in try/catch');
  assert.ok(/if \(!cands\.length\) return;[\s\S]*resolveBatch/.test(body), 'no candidates, no request');
  const calls = app.split('attachFileCards(').length - 2;   // minus the definition
  assert.ok(calls >= 5, 'called at the turn ends and in history (found ' + calls + ')');
  assert.match(app, /if \(msg\.role === 'assistant'\) attachFileCards\(document\.getElementById\(hid\)\)/, 'history');
  assert.match(app, /attachFileCards\(document\.getElementById\(t\.msgId\)\)/, 'automatic turn end');
  // not in a streaming repaint
  for (const name of ['updateMessage', 'updateMessageWithTools', 'renderSteps']) {
    const m = new RegExp('function ' + name + '\\([\\s\\S]*?\\n    \\}\\n').exec(app);
    assert.ok(m && !/attachFileCards/.test(m[0]), name + ' (runs per chunk) does not attach cards');
  }
});

test('Files panel: Recent from agents uses /api/files/recent through filesUrl, hides when empty, shows nothing on failure', () => {
  assert.match(app, /id="files-recent"/);
  const fn = /async function filesLoadRecent\(\) \{[\s\S]*?\n    \}\n/.exec(app);
  assert.ok(fn, 'filesLoadRecent exists');
  assert.match(fn[0], /filesUrl\('\/recent', \{ limit: 10 \}\)/);
  assert.match(fn[0], /catch \(e\) \{ data = null; \}/, 'a failure is swallowed');
  assert.match(fn[0], /box\.hidden = true/, 'hidden when empty');
  assert.match(fn[0], /<a class="fr-dl"[^`]*download=/, 'a normal download link');
  const refresh = /async function filesRefresh\(\) \{[\s\S]*?\n    \}\n/.exec(app)[0];
  assert.match(refresh, /filesLoadRecent\(\)/, 'refreshed with the panel (open, upload, rename, delete all go through filesRefresh)');
});

test('Files panel: Download as zip (toolbar and folder rows) checks first and shows the server message on a 413', async () => {
  assert.match(app, /id="files-zip-btn" onclick="filesZip\(filesState\.path\)"/);
  assert.match(app, /onclick="filesZip\(filesJoin\(filesState\.path, filesState\.entries\[\$\{i\}\]\.name\)\)"/, 'row action on a folder');
  const fn = /async function filesZip\(rel\) \{[\s\S]*?\n    \}\n/.exec(app);
  assert.ok(fn, 'filesZip exists'); assert.match(fn[0], /filesUrl\('\/zip', \{ path: rel \}\)/);

  // Run the real filesZip/filesApi/filesStatus/filesUrl/humanSize source against a fake page and fake fetch.
  const grab = (re) => { const m = re.exec(app); assert.ok(m, String(re)); return m[0]; };
  const src = [
    grab(/function filesAgentParam[^\n]*\n/), grab(/function filesUrl\([\s\S]*?\n    \}\n/), grab(/async function filesApi\([\s\S]*?\n    \}\n/),
    grab(/function humanSize\([\s\S]*?\n    \}\n/), grab(/function filesStatus\([\s\S]*?\n    \}\n/), fn[0],
  ].join('\n');
  const run = async (answer) => {
    const status = { text: '', cls: '', log: [] }, clicks = [], fetched = [];
    const statusEl = { set textContent(v) { status.text = v; status.log.push(v); }, get textContent() { return status.text; }, set className(v) { status.cls = v; }, get className() { return status.cls; } };
    const ctx = {
      filesState: { path: 'reports/q1', agent: 'helper', root: { label: 'Files' } }, filesOwnerParam: () => '', setTimeout: () => 0,
      document: { getElementById: () => statusEl, createElement: () => { const el = { click() { clicks.push({ href: el.href, download: el.download }); }, remove() {} }; return el; }, body: { appendChild() {} } },
      fetch: async (url, init) => { fetched.push({ url, init }); return { ok: answer.ok, status: answer.status, json: async () => answer.body }; },
    };
    vm.createContext(ctx); vm.runInContext(src + '\nthis.filesZip = filesZip;', ctx);
    await ctx.filesZip('reports/q1');
    return { status, clicks, fetched };
  };

  const big = await run({ ok: false, status: 413, body: { error: 'This folder is too big to download as one zip: 3,112 files and 4.1 GB (the limit is 2,000 files and 2 GB). Download its folders one at a time.', files: 3112 } });
  assert.deepStrictEqual(big.status.log[0], 'Checking the folder…');
  assert.ok(big.fetched[0].url.endsWith('&check=1') && big.fetched[0].url.includes('/api/files/zip?') && big.fetched[0].url.includes('path=reports%2Fq1'));
  assert.strictEqual(big.fetched[0].init.credentials, 'same-origin');
  assert.match(big.status.text, /too big to download as one zip: 3,112 files/);
  assert.strictEqual(big.status.cls, 'files-status error');
  assert.strictEqual(big.clicks.length, 0, 'a refused folder starts no download');

  const ok = await run({ ok: true, status: 200, body: { ok: true, files: 3, bytes: 5 * 1024 * 1024, maxFiles: 2000, maxBytes: 2 ** 31 } });
  assert.strictEqual(ok.clicks.length, 1);
  assert.ok(!/check=1/.test(ok.clicks[0].href) && ok.clicks[0].href.includes('/api/files/zip?') && ok.clicks[0].download === 'q1.zip', 'a plain link download of the real URL');
  assert.strictEqual(ok.status.text, 'Downloading q1.zip (3 files, 5.0 MB)');
});

// Recent: only the newest 5, then a link-styled "Show all (N)" that expands in place and is remembered for the session.
async function recentKit(n, storage) {
  const fn = /async function filesLoadRecent\(\) \{[\s\S]*?\n    \}\n/.exec(app)[0];
  const box = { hidden: true, innerHTML: '', onclick: null };
  const files = Array.from({ length: n }, (_, i) => ({ name: `f${i}.txt`, size: 10, folder: 'out', mtime: new Date().toISOString(), download: `/api/files/download?path=f${i}` }));
  const ctx = {
    document: { getElementById: () => box }, filesState: { agent: 'bob' }, filesApi: async () => ({ files }), filesUrl: () => '/x',
    esc: (s) => String(s), humanSize: () => '10 B', filesAgo: () => 'just now', ...(storage ? { sessionStorage: storage } : {}),
  };
  vm.createContext(ctx); vm.runInContext(fn + '\nthis.filesLoadRecent = filesLoadRecent;', ctx);
  await ctx.filesLoadRecent();
  const rows = () => (box.innerHTML.match(/class="fr-row"/g) || []).length;
  const press = () => box.onclick({ target: { closest: (sel) => (sel === 'button.fr-all' && /class="fr-all"/.test(box.innerHTML) ? {} : null) } });
  return { box, rows, press };
}
const memStore = (init = {}) => { const d = { ...init }; return { d, getItem: (k) => (k in d ? d[k] : null), setItem: (k, v) => { d[k] = String(v); } }; };

test('Recent: with 10 files the desktop draws 5 rows and a "Show all (10)" button (a real button, aria-expanded=false)', async () => {
  const { box, rows } = await recentKit(10, memStore());
  assert.strictEqual(rows(), 5);
  assert.match(box.innerHTML, /<button type="button" class="fr-all" aria-expanded="false">Show all \(10\)<\/button>/);
  assert.match(box.innerHTML, /f4\.txt/); assert.doesNotMatch(box.innerHTML, /f5\.txt/);
  assert.match(html, /#files-panel \.files-recent button\.fr-all \{[^}]*color: var\(--accent\)/, 'link-styled in the accent colour');
});

test('Recent: pressing "Show all" draws all 10 in place, drops the button and stores 1 in sessionStorage', async () => {
  const st = memStore();
  const { box, rows, press } = await recentKit(10, st);
  press();
  assert.strictEqual(rows(), 10);
  assert.doesNotMatch(box.innerHTML, /fr-all/);
  assert.strictEqual(st.d['hub-files-recent-all'], '1');
});

test('Recent: with the stored choice all 10 are drawn and there is no button; 5 files never show one', async () => {
  const a = await recentKit(10, memStore({ 'hub-files-recent-all': '1' }));
  assert.strictEqual(a.rows(), 10);
  assert.doesNotMatch(a.box.innerHTML, /fr-all/);
  const b = await recentKit(6, memStore());
  assert.strictEqual(b.rows(), 5);
  assert.match(b.box.innerHTML, /Show all \(6\)/);
  const c = await recentKit(5, memStore());
  assert.strictEqual(c.rows(), 5);
  assert.doesNotMatch(c.box.innerHTML, /fr-all/);
});

test('Recent: sessionStorage that throws (or is missing) still works, the choice just is not remembered', async () => {
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  for (const storage of [bad, null]) {
    const { box, rows, press } = await recentKit(10, storage);
    assert.strictEqual(rows(), 5);
    assert.match(box.innerHTML, /Show all \(10\)/);
    press();
    assert.strictEqual(rows(), 10);
    assert.doesNotMatch(box.innerHTML, /fr-all/);
  }
});
