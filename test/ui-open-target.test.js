'use strict';
// A notification tapped while the desktop page is open (2026-11): the service worker hands the target to the hub tab
// and the page confirms it took it. The page listens before its start-up awaits anything, so a tap while it loads is
// kept and runs once the agent list is in; a target past its deadline, for another origin or for another page is
// refused, so the worker opens a new tab instead and nothing happens twice.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseOpenTarget, createOpenTargets } = require('../lib/ui-open-target');

const ORIGIN = 'http://localhost:8888';
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const BEGIN = '// ── open-target helpers (begin) ──';
const END = '// ── open-target helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}
// A message as the page receives it: data plus the port the worker waits on.
function message(data) {
  const answers = [];
  return { e: { data, ports: [{ postMessage: (m) => answers.push(m) }] }, answers };
}

test('the open-target helpers are byte-identical in lib/ui-open-target.js and app.js', () => {
  assert.strictEqual(helperBlock(read('app.js'), '    '), helperBlock(read('lib/ui-open-target.js'), ''), 'app.js copy differs from lib/ui-open-target.js');
});

test('parseOpenTarget: the main page only, this origin only', () => {
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: '/?agent=forge' }, ORIGIN), { agent: 'forge', backups: false, update: false, security: false });
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: '/index.html?backups=1' }, ORIGIN), { agent: '', backups: true, update: false, security: false });
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: '/?update=1' }, ORIGIN), { agent: '', backups: false, update: true, security: false });
  assert.deepStrictEqual(parseOpenTarget({ type: 'open-target', url: `${ORIGIN}/?agent=my%20agent&security=1` }, ORIGIN), { agent: 'my agent', backups: false, update: false, security: true });
  for (const url of ['/users', '/mobile#chat=forge', 'https://example.com/?agent=forge', '//example.com/?agent=forge', '/\\example.com/?agent=x']) {
    assert.strictEqual(parseOpenTarget({ type: 'open-target', url }, ORIGIN), null, url);
  }
  assert.strictEqual(parseOpenTarget({ type: 'other', url: '/?agent=forge' }, ORIGIN), null);
  assert.strictEqual(parseOpenTarget({ type: 'open-target', url: 42 }, ORIGIN), null);
  assert.strictEqual(parseOpenTarget(null, ORIGIN), null);
});

test('a target that comes while the page loads is confirmed at once and runs when the page is ready, in order', () => {
  let clock = 1000; const ran = [];
  const t = createOpenTargets({ origin: ORIGIN, now: () => clock, run: (x) => ran.push(x.agent || (x.backups ? 'backups' : '?')) });
  const a = message({ type: 'open-target', url: '/?agent=forge', until: 1400 });
  const b = message({ type: 'open-target', url: '/?backups=1', until: 1400 });
  t.onMessage(a.e); t.onMessage(b.e);
  assert.deepStrictEqual(a.answers, [{ ok: true }]);
  assert.deepStrictEqual(b.answers, [{ ok: true }]);
  assert.deepStrictEqual(ran, [], 'nothing runs before the agent list is in');
  clock = 5000;   // the page takes its time to load: what it already confirmed still runs
  t.ready();
  assert.deepStrictEqual(ran, ['forge', 'backups']);
  const c = message({ type: 'open-target', url: '/?agent=dash', until: 5400 });
  t.onMessage(c.e);
  assert.deepStrictEqual(ran, ['forge', 'backups', 'dash'], 'once ready, at once');
  assert.deepStrictEqual(c.answers, [{ ok: true }]);
});

test('a late, foreign or malformed target is refused and never runs', () => {
  const ran = [];
  const t = createOpenTargets({ origin: ORIGIN, now: () => 2000, run: (x) => ran.push(x) });
  t.ready();
  for (const data of [
    { type: 'open-target', url: '/?agent=forge', until: 1999 },   // the worker is opening a new tab itself
    { type: 'open-target', url: '/?agent=forge' },                // no deadline
    { type: 'open-target', url: 'https://example.com/?agent=forge', until: 2400 },
    { type: 'open-target', url: '/users', until: 2400 },          // another page: the worker handles those itself
  ]) {
    const m = message(data);
    t.onMessage(m.e);
    assert.deepStrictEqual(m.answers, [{ ok: false }], JSON.stringify(data));
  }
  const other = message({ type: 'something-else', url: '/?agent=forge', until: 2400 });
  t.onMessage(other.e);
  assert.deepStrictEqual(other.answers, [], 'other messages are not answered');
  t.onMessage({ data: null }); t.onMessage(null);
  assert.deepStrictEqual(ran, []);
  // a message with no port (sent by something else) still works without throwing
  t.onMessage({ data: { type: 'open-target', url: '/?agent=forge', until: 2400 } });
  assert.strictEqual(ran.length, 1);
});

test('app.js listens before its start-up awaits anything, and drains taps once the agent list is in', () => {
  const app = read('app.js');
  const listen = app.indexOf("navigator.serviceWorker.addEventListener('message', (e) => openTargets.onMessage(e));");
  const start = app.indexOf("document.addEventListener('DOMContentLoaded', async () => {");
  assert.ok(listen > 0 && start > listen, 'the listener is registered while the script runs, not in the start-up handler');
  assert.ok(app.indexOf('navigator.serviceWorker.startMessages();', listen) < start, 'messages start flowing right away');
  const startup = app.slice(start, app.indexOf('\n    });\n', start));
  const agents = startup.indexOf('await Promise.all([loadAgents()]);');
  const own = startup.indexOf("runPageTarget(parseOpenTarget({ type: 'open-target', url: location.href }, location.origin));");
  const drain = startup.indexOf('openTargets.ready();');
  assert.ok(agents > 0 && own > agents && drain > own, 'the page address, then the waiting taps, after the agent list');
  assert.ok(!/location\.href = u\.pathname/.test(app), 'a message can no longer send the hub tab to another page');
  const run = app.slice(app.indexOf('async function runPageTarget(t) {'), app.indexOf('async function showOwnerViewOf(name) {'));
  assert.match(run, /if \(t\.backups\) openSettingsAt\('st-backups-section'\);/);
  assert.match(run, /if \(t\.update\) paintUpdateCard\(\)\.then\(\(\) => showUpdateCard\(\)\)/);
  assert.match(run, /if \(!a\) a = await showOwnerViewOf\(t\.agent\);/);
});
