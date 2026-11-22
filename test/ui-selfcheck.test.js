'use strict';
// Settings → Status → Self-check (app.js): the section, its rendering, Run now, saving the settings and the
// ?selfcheck=1 deep link. The page code is lifted out of app.js between its markers and run against a stand-in page
// and a stand-in server (the ui-*.test.js pattern); nothing here touches a hub.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const between = (a, b) => {
  const i = app.indexOf(a), j = app.indexOf(b);
  assert.ok(i > 0 && j > i, `${a} found`);
  return app.slice(i + a.length, j);
};
const BLOCK = between('// ── self-check page (begin) ──', '// ── self-check page (end) ──');
const ESC = app.match(/^\s*const esc = \(s\) => .*$/m)[0];
const SAVE_FETCH = between('// ── save fetch (begin) ──', '// ── save fetch (end) ──');

// A stand-in page: elements by id with the few fields the section uses.
function makePage(ids) {
  const els = {};
  for (const id of ids) {
    const classes = new Set();
    let html = '';
    els[id] = { id, textContent: '', value: '', checked: false, disabled: false,
      classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) },
      // like a page: writing innerHTML makes a new, closed <details>; querySelector finds it while the markup has one
      get innerHTML() { return html; },
      set innerHTML(v) { html = String(v); this.det = /<details class="sc-hist"/.test(html) ? { open: false, setAttribute(n) { if (n === 'open') this.open = true; } } : null; },
      querySelector(sel) { return sel === 'details.sc-hist' ? this.det || null : null; } };
    els[id].det = null;
  }
  return { els, document: { getElementById: (id) => els[id] || null } };
}
const IDS = ['st-sc-list', 'st-sc-msg', 'st-sc-run', 'st-sc-state', 'st-sc-save-state', 'st-sc-enabled', 'st-sc-after', 'st-sc-at', 'st-sc-model',
  'st-sc-c-lead', 'st-sc-c-host', 'st-sc-c-boxed', 'st-sc-c-shared'];

// Build the section's functions with a stand-in fetch (routes: 'METHOD /path' -> { status, body } or a function).
function build(routes, { ids = IDS } = {}) {
  const page = makePage(ids);
  const calls = [], sums = [], timers = [];
  const fetch = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    calls.push({ key, body: init.body ? JSON.parse(init.body) : undefined });
    let r = routes[key];
    if (typeof r === 'function') r = r();
    assert.ok(r, `no route for ${key}`);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const stSum = (g, k, text, crit) => sums.push({ g, k, text, crit });
  const guardLog = [];   // stand-in for the dialog guard: what the save settled
  const dialogGuard = { savePoint: (fields) => () => guardLog.push(`commit ${fields.length}`), markLoaded: (els) => guardLog.push(`loaded ${els.length}`) };
  const make = new Function('document', 'fetch', 'setTimeout', 'stSum', 'dialogGuard', `${ESC}\n${SAVE_FETCH}\n${BLOCK}\nreturn { scRender, loadSelfCheck, saveSelfCheckSettings, scFillSettings, scFailText, SC_POLL_MS, SC_POLL_MAX_MS };`);
  const S = make(page.document, fetch, setTimeout, stSum, dialogGuard);
  return { ...page, S, calls, sums, timers, guardLog };
}

const T0 = '2026-11-17T08:45:00.000Z';
const action = (ok, reason) => ({ ok, reason });
const allPass = () => ({
  settings: { enabled: true, afterStart: true, nightlyAt: '03:45', classes: ['lead', 'host', 'boxed', 'shared'], model: 'auto' },
  running: false,
  lastRun: { id: 'r1', trigger: 'nightly', startedAt: T0, finishedAt: T0, model: 'claude-sdk/haiku-x', note: '', classes: {
    lead: { status: 'pass', note: '', actions: { 'read@install': action(true, '') } },
    host: { status: 'pass', note: '', actions: {} },
    boxed: { status: 'pass', note: '', actions: {} },
    shared: { status: 'pass', note: '', actions: {} } } },
  failingSince: {}, history: [{ id: 'r0', at: T0, trigger: 'start', summary: 'all 4 kinds of agent work' }], readiness: [],
});

test('a view with every kind passing: last-checked line, four rows in order, "works" chips, earlier checks folded', () => {
  const t = build({});
  t.S.scRender(allPass());
  const h = t.els['st-sc-list'].innerHTML;
  assert.match(h, /Last checked .+ \(nightly\) with claude-sdk\/haiku-x/);
  const order = ['lead agents', 'ordinary agents on this computer', 'agents in a box', 'agents shared with a member'].map(s => h.indexOf(s));
  assert.ok(order.every(i => i > 0) && [...order].sort((a, b) => a - b).join() === order.join(), 'rows in the order lead, host, boxed, shared');
  assert.strictEqual((h.match(/>works</g) || []).length, 4);
  assert.match(h, /<details class="sc-hist"><summary>Earlier checks<\/summary>.*after a start: all 4 kinds of agent work/);
  assert.deepStrictEqual(t.sums.at(-1), { g: 'status', k: 'selfcheck', text: 'Self-check: all fine', crit: false });
});

test('no run yet: "Not checked yet."', () => {
  const t = build({});
  t.S.scRender({ settings: {}, running: false, lastRun: null, failingSince: {}, history: [] });
  assert.match(t.els['st-sc-list'].innerHTML, /Not checked yet\./);
});

test('one failure shows "<action words> <folder words>: <reason> (since <time>)" and marks the summary critical', () => {
  const t = build({});
  const v = allPass();
  v.lastRun.trigger = 'manual';
  v.lastRun.classes.host = { status: 'fail', note: '', actions: {
    'write@home': action(false, "allowed by your Maestro's rules but refused by the Claude client"),
    'read@install': action(true, ''),
    'refuse@': action(false, 'the safety rules let it read call recordings') } };
  v.failingSince = { 'host/write@home': '2026-11-16T08:45:00.000Z' };
  t.S.scRender(v);
  const h = t.els['st-sc-list'].innerHTML;
  const since = new Date('2026-11-16T08:45:00.000Z').toLocaleString();
  assert.ok(h.includes(`write files outside the install folder: allowed by your Maestro's rules but refused by the Claude client (since ${since})`), h);
  assert.ok(h.includes('keep call recordings private: the safety rules let it read call recordings'), 'the refuse check has no folder words');
  assert.ok(!h.includes('read files in the install folder'), 'a passing action is not listed');
  assert.match(h, />problem</);
  assert.match(h, /\(run by hand\)/);
  assert.deepStrictEqual(t.sums.at(-1), { g: 'status', k: 'selfcheck', text: 'Self-check: problem found', crit: true });
});

test('a skipped boxed kind says "not checked" with its note; an errored kind says "couldn\'t run"', () => {
  const t = build({});
  const v = allPass();
  v.lastRun.classes.boxed = { status: 'skipped', note: 'Docker or the sandbox image is not there', actions: {} };
  v.lastRun.classes.shared = { status: 'error', note: 'the plan limit was reached', actions: {} };
  t.S.scRender(v);
  const h = t.els['st-sc-list'].innerHTML;
  assert.match(h, /agents in a box<\/b> <span class="sc-chip sc-idle">not checked<\/span><\/div><div class="sc-note">Docker or the sandbox image is not there</);
  assert.match(h, /agents shared with a member<\/b> <span class="sc-chip sc-idle">couldn't run<\/span><\/div><div class="sc-note">the plan limit was reached</);
  assert.strictEqual(t.sums.at(-1).text, 'Self-check: all fine', 'two kinds passed and nothing failed');
  // no kind passed or failed: "couldn't run"
  v.lastRun.classes.lead = { status: 'error', note: 'x', actions: {} };
  v.lastRun.classes.host = { status: 'skipped', note: 'y', actions: {} };
  t.S.scRender(v);
  assert.strictEqual(t.sums.at(-1).text, "Self-check: couldn't run");
  assert.strictEqual(t.sums.at(-1).crit, false);
});

test('F3: the summary says "problem found" for a stuck count of 3 or a standing failingSince, even when no kind failed in the last run', () => {
  const t = build({});
  const stuck = allPass(); stuck.stuck = { host: { count: 3, since: T0, reason: 'x' } };
  t.S.scRender(stuck);
  assert.deepStrictEqual(t.sums.at(-1), { g: 'status', k: 'selfcheck', text: 'Self-check: problem found', crit: true });
  const standing = allPass(); standing.failingSince = { 'host/read@home': T0 };
  t.S.scRender(standing);
  assert.deepStrictEqual(t.sums.at(-1), { g: 'status', k: 'selfcheck', text: 'Self-check: problem found', crit: true });
  const two = allPass(); two.stuck = { host: { count: 2, since: T0 } };
  t.S.scRender(two);
  assert.strictEqual(t.sums.at(-1).text, 'Self-check: all fine');
  // a halted run left everything skipped: couldn't run, not "all fine"
  const none = allPass();
  for (const k of Object.keys(none.lastRun.classes)) none.lastRun.classes[k] = { status: 'skipped', note: 'halted', actions: {} };
  t.S.scRender(none);
  assert.strictEqual(t.sums.at(-1).text, "Self-check: couldn't run");
});

test('F4: a page opened during a run follows it for up to 6 minutes; "Earlier checks" stays open across a redraw', async () => {
  const running = { ...allPass(), running: true };
  const t = build({ 'GET /api/selfcheck': () => ({ status: 200, body: running }) });
  await t.S.loadSelfCheck();   // opened, not Run now
  assert.strictEqual(t.timers.at(-1) && t.timers.at(-1).ms, 3000, 'polls while the hub says it runs');
  assert.strictEqual(t.els['st-sc-run'].disabled, true);
  // it keeps going on its own poll...
  t.timers.at(-1).fn(); await new Promise(r => setImmediate(r));
  assert.strictEqual(t.timers.length, 2);
  // ...and the open panel survives the redraw
  t.els['st-sc-list'].det.open = true;
  t.timers.at(-1).fn(); await new Promise(r => setImmediate(r));
  assert.strictEqual(t.els['st-sc-list'].det.open, true, 'still open after the poll redrew the list');
  // a closed one stays closed
  t.els['st-sc-list'].det.open = false;
  t.timers.at(-1).fn(); await new Promise(r => setImmediate(r));
  assert.strictEqual(t.els['st-sc-list'].det.open, false);
});

test('F4: the poll still stops after 6 minutes of a run that does not end', async () => {
  const running = { ...allPass(), running: true };
  const t = build({ 'GET /api/selfcheck': () => ({ status: 200, body: running }) });
  const realNow = Date.now; let now = realNow();
  Date.now = () => now;
  try {
    await t.S.loadSelfCheck();
    const n0 = t.timers.length;
    now += t.S.SC_POLL_MAX_MS + 1000;
    t.timers.at(-1).fn(); await new Promise(r => setImmediate(r));
    assert.strictEqual(t.timers.length, n0, 'no further poll');
    assert.match(t.els['st-sc-msg'].textContent, /Still running after 6 minutes/);
  } finally { Date.now = realNow; }
});

test('a check that hasn\'t been able to run 3 times in a row is shown as a problem; fewer, and nothing is added', () => {
  const t = build({});
  const v = allPass();
  v.stuck = { shared: { count: 3, since: '2026-11-17T08:45:00Z', reason: 'Claude <plan> limit', told: true }, lead: { count: 2, since: '2026-11-17T08:45:00Z', reason: 'x' } };
  t.S.scRender(v);
  const h = t.els['st-sc-list'].innerHTML;
  assert.match(h, /<div class="sc-fail">The check of agents shared with a member hasn't been able to run since [^<]+ \(Claude &lt;plan&gt; limit\)\.<\/div>/);
  assert.ok(!/The check of lead agents/.test(h), 'two in a row: not yet');
});

test('every string from the server is escaped: a reason, a note, a model and a history summary come out as text', () => {
  const t = build({});
  const v = allPass();
  v.lastRun.model = '<b>m</b>';
  v.lastRun.note = '<img src=x>';
  v.lastRun.classes.lead = { status: 'fail', note: '<script>1</script>', actions: { 'write@install': action(false, '<img src=x onerror=1>') } };
  v.history = [{ at: T0, trigger: '<i>', summary: '<img src=x>' }];
  t.S.scRender(v);
  const h = t.els['st-sc-list'].innerHTML;
  assert.ok(!/<img|<script|<b>m|<i>/.test(h), `no server markup survives: ${h}`);
  assert.ok(h.includes('&lt;img src=x onerror=1&gt;') && h.includes('&lt;script&gt;1&lt;/script&gt;') && h.includes('&lt;b&gt;m&lt;/b&gt;'));
});

test('Run now while the hub answers 409 running shows "A check is already running." and keeps following the run', async () => {
  const running = { ...allPass(), running: true };
  const t = build({ 'POST /api/selfcheck/run': { status: 409, body: { error: 'running' } }, 'GET /api/selfcheck': { status: 200, body: running } });
  await t.S.loadSelfCheck(true);
  assert.strictEqual(t.els['st-sc-msg'].textContent, 'A check is already running.');
  assert.strictEqual(t.els['st-sc-run'].disabled, true, 'the button is off while a check runs');
  assert.strictEqual(t.els['st-sc-state'].textContent, 'Running…');
  assert.strictEqual(t.timers.at(-1).ms, 3000, 'polls every 3 s');
  // the run ends: the "already running" note goes away
  running.running = false;
  t.timers.at(-1).fn(); await new Promise(r => setImmediate(r));
  assert.strictEqual(t.els['st-sc-msg'].textContent, '');
  assert.strictEqual(t.els['st-sc-run'].disabled, false);
});

test('Run now: 409 disabled says the self-check is turned off; 202 polls until it stops running and re-enables the button', async () => {
  const off = build({ 'POST /api/selfcheck/run': { status: 409, body: { error: 'disabled' } } });
  await off.S.loadSelfCheck(true);
  assert.strictEqual(off.els['st-sc-msg'].textContent, 'The self-check is turned off.');
  assert.strictEqual(off.els['st-sc-run'].disabled, false);
  assert.deepStrictEqual(off.calls.map(c => c.key), ['POST /api/selfcheck/run'], 'no list fetch after a refusal');

  let n = 0;
  const t = build({ 'POST /api/selfcheck/run': { status: 202, body: { started: true } }, 'GET /api/selfcheck': () => ({ status: 200, body: { ...allPass(), running: ++n < 3 } }) });
  await t.S.loadSelfCheck(true);
  assert.strictEqual(t.els['st-sc-run'].disabled, true);
  const flush = () => new Promise(r => setImmediate(r));
  t.timers.at(-1).fn(); await flush();
  t.timers.at(-1).fn(); await flush();
  assert.strictEqual(n, 3);
  assert.strictEqual(t.els['st-sc-run'].disabled, false, 'enabled again when the run is over');
  assert.strictEqual(t.els['st-sc-state'].textContent, '');
  assert.match(t.els['st-sc-list'].innerHTML, /Last checked/);
});

test('a failed load says "Couldn\'t load the self-check: <error>" with the error escaped by textContent', async () => {
  const t = build({ 'GET /api/selfcheck': { status: 403, body: { error: 'admin only' } } });
  await t.S.loadSelfCheck();
  assert.strictEqual(t.els['st-sc-msg'].textContent, "Couldn't load the self-check: admin only");
});

test('saving sends only the keys that changed, and nothing at all when nothing changed', async () => {
  const s0 = allPass().settings;
  const t = build({ 'PUT /api/selfcheck/settings': { status: 200, body: { settings: { ...s0, afterStart: false, nightlyAt: '04:10' } } } });
  t.S.scFillSettings(s0);
  await t.S.saveSelfCheckSettings();
  assert.strictEqual(t.calls.length, 0);
  assert.strictEqual(t.els['st-sc-save-state'].textContent, 'Nothing to save.');
  t.els['st-sc-after'].checked = false;
  t.els['st-sc-at'].value = '04:10';
  await t.S.saveSelfCheckSettings();
  assert.deepStrictEqual(t.calls, [{ key: 'PUT /api/selfcheck/settings', body: { afterStart: false, nightlyAt: '04:10' } }]);
  assert.strictEqual(t.els['st-sc-save-state'].textContent, 'Saved.');
  assert.deepStrictEqual(t.guardLog, ['commit 8', 'commit 8'], 'nothing to save, then refilled from the answer: the form is settled');
  // the next save compares with what the hub answered
  t.calls.length = 0;
  await t.S.saveSelfCheckSettings();
  assert.strictEqual(t.calls.length, 0);
});

test('saving: a field edited while the save runs keeps the newer text; the others show the answer', async () => {
  const s0 = allPass().settings;
  let t;
  t = build({ 'PUT /api/selfcheck/settings': () => { t.els['st-sc-model'].value = 'claude-sdk/haiku-y'; return { status: 200, body: { settings: { ...s0, nightlyAt: '04:10' } } }; } });
  t.S.scFillSettings(s0);
  t.els['st-sc-at'].value = '04:10';
  await t.S.saveSelfCheckSettings();
  assert.strictEqual(t.els['st-sc-at'].value, '04:10');
  assert.strictEqual(t.els['st-sc-model'].value, 'claude-sdk/haiku-y', 'the edit made during the save is kept');
  assert.deepStrictEqual(t.guardLog, ['commit 8']);
});

test('saving: a changed model and a changed set of kinds go in order; an empty model means auto', async () => {
  const s0 = allPass().settings;
  const t = build({ 'PUT /api/selfcheck/settings': { status: 200, body: { settings: s0 } } });
  t.S.scFillSettings(s0);
  assert.strictEqual(t.els['st-sc-model'].value, '', 'auto shows as the placeholder');
  t.els['st-sc-model'].value = ' claude-sdk/haiku-x ';
  t.els['st-sc-c-boxed'].checked = false;
  await t.S.saveSelfCheckSettings();
  assert.deepStrictEqual(t.calls[0].body, { classes: ['lead', 'host', 'shared'], model: 'claude-sdk/haiku-x' });
});

test('saving refuses to untick every kind of agent and says why, without asking the hub', async () => {
  const s0 = allPass().settings;
  const t = build({});
  t.S.scFillSettings(s0);
  for (const k of ['lead', 'host', 'boxed', 'shared']) t.els[`st-sc-c-${k}`].checked = false;
  await t.S.saveSelfCheckSettings();
  assert.strictEqual(t.calls.length, 0);
  assert.strictEqual(t.els['st-sc-save-state'].textContent, 'Keep at least one kind of agent ticked.');
});

test('a refused save (400) shows the hub\'s words and keeps the form', async () => {
  const s0 = allPass().settings;
  const t = build({ 'PUT /api/selfcheck/settings': { status: 400, body: { error: 'nightlyAt must be HH:MM' } } });
  t.S.scFillSettings(s0);
  t.els['st-sc-at'].value = '25:99';
  await t.S.saveSelfCheckSettings();
  assert.strictEqual(t.els['st-sc-save-state'].textContent, 'Not saved: nightlyAt must be HH:MM');
  assert.strictEqual(t.els['st-sc-at'].value, '25:99');
  assert.deepStrictEqual(t.guardLog, [], 'a refused save leaves the form changed (Close still asks)');
});

test('the deep link: ?selfcheck=1 is parsed, opens Settings → Status at the section, and is dropped from the address after', () => {
  const helpers = between('// ── open-target helpers (begin) ──', '// ── open-target helpers (end) ──');
  const { parseOpenTarget } = new Function(`${helpers}\nreturn { parseOpenTarget };`)();
  const t = parseOpenTarget({ type: 'open-target', url: '/?selfcheck=1' }, 'http://localhost:8888');
  assert.strictEqual(t.selfcheck, true);
  assert.strictEqual(t.memory, false);
  assert.strictEqual(parseOpenTarget({ type: 'open-target', url: '/?selfcheck=0' }, 'http://localhost:8888').selfcheck, false);
  assert.ok(app.includes("if (t.selfcheck) openSettingsAt('st-selfcheck-section');"), 'runPageTarget opens the section');
  assert.match(app, /own\.memory \|\| own\.selfcheck \|\| own\.health \|\| own\.connectors/, 'a one-shot link');
  assert.match(app, /for \(const k of \['update', 'backups', 'security', 'memory', 'selfcheck', 'health', 'connectors', 'wallet', 'websearch'\]\) u\.searchParams\.delete\(k\)/);
});

test('the section is drawn after Memory in the Status group, for admins only, with the controls the spec lists', () => {
  const start = app.indexOf('async function openSettings() {');
  const src = app.slice(start, app.indexOf('// Auto model classifier (lib/classifier): settings', start));
  const at = src.indexOf('id="st-selfcheck-section"');
  assert.ok(at > src.indexOf('id="st-memory-section"') && at < src.indexOf('id="st-updates-section"'), 'after Memory, before Updates');
  assert.match(src.slice(0, at).split('\n').slice(-3).join('\n'), /isHubAdmin\(\)/, 'gated to admins');
  const sec = src.slice(at, src.indexOf('id="st-updates-section"'));
  for (const s of ['<h4>Self-check</h4>', 'id="st-sc-list"', 'id="st-sc-msg" class="st-hint mh-msg" role="status"', 'onclick="loadSelfCheck(true)">Run now', 'id="st-sc-state"',
    'class="st-test-btn" id="st-sc-run"', 'Run checks', 'After every start', 'type="time" id="st-sc-at"', 'Kinds of agent', 'placeholder="auto"', 'auto picks the cheapest Claude model.',
    'onclick="saveSelfCheckSettings()">Save', 'You hear about it only when something fails.']) assert.ok(sec.includes(s), s);
  assert.match(src, /ST_GROUPS|stSum/, 'settings source loaded');
  assert.ok(/id: 'status'[^\n]*'st-memory-section', 'st-selfcheck-section', 'st-components-section', 'st-updates-section'/.test(app), 'in the Status group');
});

test('narrow screens: the rows wrap and long reasons break', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(index, /\.sc-row \{[^}]*overflow-wrap: anywhere/);
  assert.match(index, /\.sc-head \{[^}]*flex-wrap: wrap/);
  assert.match(index, /\.sc-fail[^{]*\{[^}]*overflow-wrap: anywhere/);
  assert.match(index, /\.sc-kinds \{ flex-wrap: wrap; \}/);
});
