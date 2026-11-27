'use strict';
// Phase 5a round 3: the resume pacer works by item identity; a spend-caps Save never clears a cap it did not change;
// the Settings Stop dialog names the jobs kept running; the panel lists research reports being delivered.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('p5a3-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const { createResumePacer } = L('resume-pacer');
const { ScheduledTasks } = L('scheduled-tasks');
const { ConsultQueue } = L('consult-queue');
const REAL = path.join(__dirname, '..');
const real = (rel) => fs.readFileSync(path.join(REAL, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5a3-'));
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const T0 = Date.parse('2026-11-20T12:00:00Z');

function mkTasks(dir, clock, extra = {}) {
  const refusal = { v: null }; const woken = []; const busy = new Set();
  const st = new ScheduledTasks({ dataDir: dir, tz: 'America/New_York', now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 600000, agentExists: async () => true,
    isAgentActive: (a) => busy.has(a), haltRefusal: () => refusal.v, notify: async (agent, message, onReply, meta) => { woken.push({ at: clock.t, agent, taskId: meta && meta.taskId }); }, ...extra });
  return { st, refusal, woken, busy };
}

test('pacer: suspend for 16 minutes after Resume, then three held tasks still go one at a time, 30 s apart', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 't1')); const clock = { t: T0 };
  const { st, refusal, woken } = mkTasks(dir, clock);
  const ids = [];
  for (const [who, when] of [['alice', 'in 1 hour'], ['bob', 'in 2 hours'], ['carol', 'in 3 hours']]) ids.push((await st.create({ requester: who, when, prompt: who })).id);
  refusal.v = 'hub is halted'; clock.t = T0 + 5 * 3600000; await st.tick();
  assert.equal(st.heldList().length, 3);
  refusal.v = null; assert.equal(st.release(), 3);
  clock.t += 16 * 60000;                       // the laptop slept for 16 minutes: no timeout may let them all go together
  await st.tick();
  assert.equal(woken.length, 1, 'only the first');
  await st.tick(); assert.equal(woken.length, 1);
  clock.t += 31000; await st.tick();
  assert.equal(woken.length, 2);
  clock.t += 31000; await st.tick();
  assert.deepEqual(woken.map((w) => w.taskId), ids);
  for (let i = 1; i < woken.length; i++) assert.ok(woken[i].at - woken[i - 1].at >= 30000);
  assert.equal(createResumePacer({ file: path.join(dir, 'resume-pacer.json'), now: () => clock.t }).isOpen(), false, 'the window closed with the last released task');
  st.stop();
});

test('pacer: tasks that were not released are not paced and do not use the slots of busy released ones', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 't2')); const clock = { t: T0 };
  const { st, refusal, woken, busy } = mkTasks(dir, clock);
  const a = await st.create({ requester: 'alice', when: 'in 1 hour', prompt: 'a' });
  const b = await st.create({ requester: 'bob', when: 'in 1 hour', prompt: 'b' });
  refusal.v = 'hub is halted'; clock.t = T0 + 2 * 3600000; await st.tick();
  refusal.v = null; busy.add('alice'); busy.add('bob');
  st.release();
  const c = await st.create({ requester: 'carol', when: 'in 10 minutes', prompt: 'c' });
  const d = await st.create({ requester: 'dave', when: 'in 10 minutes', prompt: 'd' });
  clock.t += 11 * 60000; await st.tick();
  assert.deepEqual(woken.filter((w) => w.agent === 'carol' || w.agent === 'dave').map((w) => w.taskId).sort(), [c.id, d.id].sort(), 'both new wakes went at once');
  assert.equal(woken.filter((w) => w.agent === 'alice' || w.agent === 'bob').length, 0, 'the busy ones still wait');
  busy.clear(); clock.t += 2000; await st.tick();
  assert.equal(woken.filter((w) => w.agent === 'alice' || w.agent === 'bob').length, 1, 'one released task at a time');
  clock.t += 31000; await st.tick();
  assert.deepEqual(woken.filter((w) => w.agent === 'alice' || w.agent === 'bob').map((w) => w.taskId).sort(), [a.id, b.id].sort());
  st.stop();
});

test('pacer: a restart keeps the ids; a released task that no longer exists is removed at the next look', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 't3')); const clock = { t: T0 };
  const m1 = mkTasks(dir, clock);
  const a = await m1.st.create({ requester: 'alice', when: 'in 1 hour', prompt: 'a' });
  const b = await m1.st.create({ requester: 'bob', when: 'in 1 hour', prompt: 'b' });
  m1.refusal.v = 'hub is halted'; clock.t = T0 + 2 * 3600000; await m1.st.tick();
  m1.refusal.v = null; m1.st.release(); m1.st.stop();
  const file = path.join(dir, 'resume-pacer.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).ids.length, 2);
  // the task is cancelled while the hub is down
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'scheduled-tasks.json'), 'utf8').toString());
  assert.ok(doc.pending.length === 2);
  doc.pending = doc.pending.filter((p) => p.taskId !== b.id);
  fs.writeFileSync(path.join(dir, 'scheduled-tasks.json'), JSON.stringify(doc));
  const m2 = mkTasks(dir, clock);
  const pacer = createResumePacer({ file, now: () => clock.t });
  assert.equal(pacer.status().pending, 2);
  await m2.st.tick();   // sends alice's, prunes bob's
  assert.deepEqual(m2.woken.map((w) => w.taskId), [a.id]);
  assert.equal(createResumePacer({ file, now: () => clock.t }).isOpen(), false, 'the missing task was removed, so the window closed');
  m2.st.stop();
});

test('pacer: an expired consult does not cost a slot, and the window closes when the last released request is gone', async () => {
  const file = path.join(tmp, 'c.json'); const c = { t: T0 };
  const pacer = createResumePacer({ file: path.join(tmp, 'cp.json'), now: () => c.t });
  const q = new ConsultQueue({ file, now: () => c.t });
  const stale = q.enqueue({ from: 'a', to: 'x', prompt: 'old' }); c.t += 7 * 3600000;   // older than the 6 h limit
  const fresh = q.enqueue({ from: 'b', to: 'y', prompt: 'new' }); const fresh2 = q.enqueue({ from: 'c', to: 'z', prompt: 'newer' });
  const ids = q.ids(); assert.equal(ids.length, 3);
  pacer.add(ids);
  const ran = [];
  const drain = () => q.drain({ isActive: () => false, isHeld: (j) => pacer.wait(`consult:${j.id}`) > 0,
    run: async (j) => { const w = pacer.take(`consult:${j.id}`); if (w > 0) { const e = new Error('pace'); e.busy = true; throw e; } ran.push(j.id); return 'ok'; } });
  await drain();
  assert.equal(ran.length, 1, 'the expired one went to the mailbox without taking the slot; one request ran');
  assert.equal(pacer.status().lastDispatchAt, c.t);
  await drain(); assert.equal(ran.length, 1, 'the next one waits its 30 s');
  c.t += 31000; await drain();
  assert.equal(ran.length, 2);
  pacer.prune('consult:', q.ids());
  assert.equal(pacer.isOpen(), false);
  void stale; void fresh; void fresh2;
});

test('pacer: ids dropped or pruned leave the set; only released ids are paced', () => {
  const c = { t: T0 }; const p = createResumePacer({ file: path.join(tmp, 'p4.json'), now: () => c.t });
  p.add(['task:1', 'job:2:result', 'consult:3']);
  assert.equal(p.take('task:1'), 0);
  assert.equal(p.take('other'), 0, 'not released: never paced');
  assert.equal(p.status().lastDispatchAt, T0, 'and it did not use the slot');
  assert.equal(p.wait('job:2:result'), 30000);
  p.drop('job:2:result');
  p.prune('consult:', []);
  assert.equal(p.isOpen(), false, 'the window closes when the last released item is dropped');
  c.t += 24 * 3600000; p.add('consult:9'); assert.equal(p.take('consult:9'), 0, 'no expiry from a long wait');
});

test('spend caps: Save sends only the caps the person changed, the boxes stay disabled until loaded, the route keeps what is not sent', () => {
  const app = real('app.js'), server = real('server.js');
  for (const id of ['st-cap-agent', 'st-cap-hub', 'st-cap-month', 'st-cap-month-day']) assert.match(app, new RegExp(`id="${id}"[^>]*\\sdisabled>`), `${id} starts disabled`);
  assert.match(app, /function capLoaded\(inp, text\)/);
  assert.match(app, /inp\.dataset\.loaded !== undefined/);
  assert.match(app, /if \(capChanged\(document\.getElementById\('st-cap-month'\)\)\) send\.monthlyUsd/);
  assert.match(app, /if \(capChanged\(document\.getElementById\('st-cap-month-day'\)\)\) send\.monthlyResetDay/);
  assert.match(app, /body: JSON\.stringify\(send\)/);
  assert.ok(!/JSON\.stringify\(\{ perAgentDailyUsd, hubDailyUsd, monthlyUsd, monthlyResetDay \}\)/.test(app));
  const route = server.slice(server.indexOf("pathname === '/api/ledger/caps'"), server.indexOf("pathname === '/api/hub/pacing/reset'"));
  assert.match(route, /body\.perAgentDailyUsd !== undefined \? num\(body\.perAgentDailyUsd\) : num\(before\.perAgentDailyUsd\)/);
  assert.match(route, /body\.hubDailyUsd !== undefined \? num\(body\.hubDailyUsd\) : num\(before\.hubDailyUsd\)/);
  assert.match(route, /let monthly = \{ monthlyUsd: before\.monthlyUsd \?\? null/);
});

test('spend caps route (the real expressions): a request without the monthly or daily keys leaves them as stored', () => {
  const server = real('server.js');
  const route = server.slice(server.indexOf("pathname === '/api/ledger/caps'"), server.indexOf("pathname === '/api/hub/pacing/reset'"));
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const before = { perAgentDailyUsd: 5, hubDailyUsd: 20, monthlyUsd: 100, monthlyResetDay: 3 };
  // evaluate the same field expressions the route uses
  const m = route.match(/updateSettings\(\{ ledger: \{([\s\S]*?)\} \}\);/);
  assert.ok(m);
  const fn = new Function('body', 'before', 'num', 'monthly', `return {${m[1]}};`);
  const out = fn({ perAgentDailyUsd: '7' }, before, num, { monthlyUsd: before.monthlyUsd, monthlyResetDay: before.monthlyResetDay });
  assert.deepEqual(out, { perAgentDailyUsd: 7, hubDailyUsd: 20, monthlyUsd: 100, monthlyResetDay: 3 });
  assert.equal(fn({ hubDailyUsd: '' }, before, num, { monthlyUsd: 100, monthlyResetDay: 3 }).hubDailyUsd, null, 'an explicit blank clears');
});

test('Settings Stop confirm names the jobs marked Keep running; the panel lists research reports being delivered', () => {
  const app = real('app.js');
  assert.match(app, /j\.status === 'running' && j\.keep === true/);
  assert.match(app, /Jobs marked Keep running' \+ \(keptJobs\.length \? ` \(\$\{keptJobs\.length\}: \$\{keptJobs\.map\(\(j\) => j\.name \|\| j\.id\)\.join\(', '\)\}\)` : ''\) \+ ' stay running; everything else stops\.'/);
  assert.match(app, /if \(!confirm\('Stop ALL agents\?[^\n]*' \+ keptLine\)\) return;/);
  assert.match(app, /Still finishing: jobs [^\n]*research reports being delivered \$\{esc\(names\(fin\.research/);
});

test('spend-gate says the cap is not enforced without the hub ledger', () => {
  assert.match(real('lib/spend-gate.js'), /without the hub's ledger[^\n]*not enforced/);
});

// ── Round 4 ──
test('release(): tasks that came due after the last tick are queued, held and paced with the rest (30 s apart)', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r4a')); const clock = { t: T0 };
  const { st, refusal, woken } = mkTasks(dir, clock);
  const ids = [];
  for (const who of ['alice', 'bob']) ids.push((await st.create({ requester: who, when: 'in 1 hour', prompt: who })).id);
  refusal.v = 'hub is halted';
  clock.t = T0 + 2 * 3600000;                  // both came due after the last tick: the scheduler has not seen them
  refusal.v = null;
  assert.equal(st.release(), 2, 'both are released');
  await st.tick();
  assert.equal(woken.length, 1, 'only one goes at once');
  clock.t += 31000; await st.tick();
  assert.equal(woken.length, 2);
  assert.ok(woken[1].at - woken[0].at >= 30000);
  st.stop();
});

test('spend caps: an unedited box takes the server value (focused or not); an edited one keeps the typed value; Save sends only edited changes', () => {
  const app = real('app.js');
  const src = (name) => { const i = app.indexOf(`function ${name}(`); let d = 0, j = app.indexOf('{', i); const s = j; for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; } return app.slice(i, j + 1); };
  const mk = (value) => { const l = {}; return { value, dataset: {}, disabled: true, addEventListener: (ev, f) => { l[ev] = f; }, type: (v) => { l.input(); this.value = v; }, l }; };
  const { capLoaded, capChanged } = new Function(`${src('capLoaded')}\n${src('capChanged')}\nreturn { capLoaded, capChanged };`)();
  const agent = mk('50'); const hub = mk('');
  capLoaded(agent, '50'); capLoaded(hub, '');
  assert.equal(capChanged(agent), false);
  capLoaded(agent, '25');                        // the server now says 25; the person never touched the box
  assert.equal(agent.value, '25'); assert.equal(agent.dataset.loaded, '25');
  hub.value = '7'; hub.l.input();                // the person edits the other cap
  assert.equal(capChanged(hub), true); assert.equal(capChanged(agent), false, 'the untouched cap is not sent');
  capLoaded(hub, '3');                           // a repaint: the typed value stays, the baseline moves
  assert.equal(hub.value, '7'); assert.equal(hub.dataset.loaded, '3'); assert.equal(capChanged(hub), true);
  assert.match(app, /delete el\.dataset\.edited/, 'a successful Save clears the edited marks');
});

test('haltHub shows the confirmation at once: nothing awaited before it, the keep sentence always there', () => {
  const app = real('app.js');
  const i = app.indexOf('async function haltHub()');
  const body = app.slice(i, app.indexOf('async function resumeHub()'));
  const beforeConfirm = body.slice(0, body.indexOf('confirm('));
  assert.ok(!/\bawait\b/.test(beforeConfirm) && !/fetch\(/.test(beforeConfirm), 'no await or fetch before the confirm');
  assert.ok(body.indexOf('confirm(') < body.indexOf("fetch('/api/hub/halt'"));
  assert.match(beforeConfirm, /stay running; everything else stops\./);
});

test('jobs: the reconcile report and the reply report for one job have distinct pacer ids', () => {
  const src = real('lib/jobs.js');
  assert.match(src, /idSuffix: 'reply'/);
  assert.match(src, /_pacerId\(p\) \{[^\n]*p\.idSuffix/);
});

test('spend caps Save: an edit typed while the request is in flight stays edited; typing the loaded value back clears the mark', () => {
  const app = real('app.js');
  const body = app.slice(app.indexOf('async function saveSpendCaps'), app.indexOf('async function saveSpendCaps') + 5000);
  const snap = body.indexOf('capSnapshot = ');
  assert.ok(snap > 0 && snap < body.indexOf("stSaveFetch('/api/ledger/caps'"), 'values are snapshotted before the POST');
  assert.match(body, /if \(\(el\.dataset\.inputs \|\| '0'\) === inputs\) delete el\.dataset\.edited;/);
  assert.ok(!/for \(const id of \['st-cap-agent'[^\n]*delete el\.dataset\.edited/.test(body), 'no unconditional clearing loop');
  const i = app.indexOf('function capLoaded(');
  let d = 0, j = app.indexOf('{', i); for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; }
  const capLoaded = new Function(`${app.slice(i, j + 1)}\nreturn capLoaded;`)();
  const l = {}; const inp = { value: '5', dataset: {}, disabled: true, addEventListener: (ev, f) => { l[ev] = f; } };
  capLoaded(inp, '5');
  inp.value = '9'; l.input(); assert.equal(inp.dataset.edited, '1');
  inp.value = ' $5 '; l.input(); assert.equal(inp.dataset.edited, undefined, 'back to the loaded value: no longer edited');
});

test('spend caps Save (deferred response): $50 loaded, $100 saved, $50 typed meanwhile -> box keeps $50, stays edited, next Save sends 50', async () => {
  const app = real('app.js');
  const src = (name, pre = '') => { const i = app.indexOf(`${pre}function ${name}(`); let d = 0, j = app.indexOf(') {', i) + 2; for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; } return app.slice(i, j + 1); };
  const mkEl = (id) => { const l = {}; return { id, value: '', dataset: {}, disabled: true, addEventListener: (ev, f) => { l[ev] = f; }, l }; };
  const els = Object.fromEntries(['st-cap-agent', 'st-cap-hub', 'st-cap-month', 'st-cap-month-day'].map(id => [id, mkEl(id)]));
  const btn = { disabled: false, className: '', textContent: '' };
  const bodies = []; let release;
  const stSaveFetch = (url, o) => { bodies.push(JSON.parse(o.body)); return new Promise(res => { release = () => res({ ok: true, json: async () => ({ caps: { perAgentDailyUsd: 0, hubDailyUsd: 0 }, monthly: { cap: 100, resetDay: 1, total: 0, pct: 0, until: '2026-12-01T00:00:00Z' } }) }); }); };
  const line = { textContent: '', style: {} };
  const doc = { getElementById: (id) => id === 'st-caps-save' ? btn : id === 'st-month-spend' ? line : els[id] || null };
  const code = `${src('capLoaded')}\n${src('capChanged')}\n${src('paintMonthlyCap')}\n${src('saveSpendCaps', 'async ')}\nreturn { capLoaded, saveSpendCaps };`;
  const { capLoaded, saveSpendCaps } = new Function('document', 'stSaveFetch', 'dialogGuard', 'spendToday', 'stSum', 'usd', 'monthDateText', 'alert', 'setTimeout', 'refreshSpendToday', code)(
    doc, stSaveFetch, { savePoint: () => () => {} }, null, () => {}, (n) => `$${n}`, () => '', () => {}, () => 0, async () => {});
  capLoaded(els['st-cap-month'], '50');
  const m = els['st-cap-month'];
  m.value = '100'; m.l.input();
  const p = saveSpendCaps({ quiet: true });
  assert.deepEqual(bodies[0], { monthlyUsd: '100' });
  m.value = '50'; m.l.input();            // typed while the request is pending (equals the old loaded value)
  release(); await p;
  assert.equal(m.value, '50', 'the draft is kept');
  assert.equal(m.dataset.edited, '1', 'and it is edited against the acknowledged $100');
  const p2 = saveSpendCaps({ quiet: true });
  assert.deepEqual(bodies[1], { monthlyUsd: '50' });
  release(); await p2;
});

test('spend caps Save: a background repaint of a box omitted from the POST is not a user edit', async () => {
  const app = real('app.js');
  const src = (name, pre = '') => { const i = app.indexOf(`${pre}function ${name}(`); let d = 0, j = app.indexOf(') {', i) + 2; for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; } return app.slice(i, j + 1); };
  const mkEl = (id) => { const l = {}; return { id, value: '', dataset: {}, disabled: true, addEventListener: (ev, f) => { l[ev] = f; }, l }; };
  const els = Object.fromEntries(['st-cap-agent', 'st-cap-hub', 'st-cap-month', 'st-cap-month-day'].map(id => [id, mkEl(id)]));
  const btn = { disabled: false, className: '', textContent: '' };
  const bodies = []; let release;
  const stSaveFetch = (url, o) => { bodies.push(JSON.parse(o.body)); return new Promise(res => { release = () => res({ ok: true, json: async () => ({ caps: { perAgentDailyUsd: 0, hubDailyUsd: 20 }, monthly: { cap: 100, resetDay: 1, total: 0, pct: 0, until: '2026-12-01T00:00:00Z' } }) }); }); };
  const line = { textContent: '', style: {} };
  const doc = { getElementById: (id) => id === 'st-caps-save' ? btn : id === 'st-month-spend' ? line : els[id] || null };
  const code = `${src('capLoaded')}\n${src('capChanged')}\n${src('paintMonthlyCap')}\n${src('saveSpendCaps', 'async ')}\nreturn { capLoaded, saveSpendCaps };`;
  const { capLoaded, saveSpendCaps } = new Function('document', 'stSaveFetch', 'dialogGuard', 'spendToday', 'stSum', 'usd', 'monthDateText', 'alert', 'setTimeout', 'refreshSpendToday', code)(
    doc, stSaveFetch, { savePoint: () => () => {} }, null, () => {}, (n) => `$${n}`, () => '', () => {}, () => 0, async () => {});
  capLoaded(els['st-cap-hub'], '20'); capLoaded(els['st-cap-month'], '50');
  const m = els['st-cap-month'], h = els['st-cap-hub'];
  m.value = '100'; m.l.input();
  const p = saveSpendCaps({ quiet: true });
  assert.deepEqual(bodies[0], { monthlyUsd: '100' });
  capLoaded(h, '10');                      // another admin lowered the daily cap; the spend refresh repaints the unedited box
  assert.equal(h.value, '10');
  h.value = '20'; h.l.input();             // the person types $20 (the old value) after seeing $10
  release(); await p;                      // the stale acknowledgment (hub $20) arrives
  assert.equal(h.dataset.loaded, '10', 'the stale ack does not move the hub box baseline');
  assert.equal(h.value, '20'); assert.equal(h.dataset.edited, '1');
  m.value = '60'; m.l.input();
  const p2 = saveSpendCaps({ quiet: true });
  assert.deepEqual(bodies[1], { hubDailyUsd: 20, monthlyUsd: '60' }, 'the next Save still sends the hub daily cap the hub enforces at $10');
  release(); await p2;
  capLoaded(h, '5');
  assert.equal(h.dataset.loaded, '5');
});

test('spend caps Save: a daily-only save with a stale monthly ack leaves the monthly summary alone; a monthly save refreshes it from one fresh read', async () => {
  const app = real('app.js');
  const src = (name, pre = '') => { const i = app.indexOf(`${pre}function ${name}(`); let d = 0, j = app.indexOf(') {', i) + 2; for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; } return app.slice(i, j + 1); };
  const mkEl = (id) => { const l = {}; return { id, value: '', dataset: {}, disabled: true, addEventListener: (ev, f) => { l[ev] = f; }, l }; };
  const els = Object.fromEntries(['st-cap-agent', 'st-cap-hub', 'st-cap-month', 'st-cap-month-day'].map(id => [id, mkEl(id)]));
  const btn = { disabled: false, className: '', textContent: '' };
  const bodies = [];
  const stSaveFetch = (url, o) => { bodies.push(JSON.parse(o.body)); return Promise.resolve({ ok: true, json: async () => ({ caps: { perAgentDailyUsd: 0, hubDailyUsd: 7 }, monthly: { cap: 10, resetDay: 1, total: 1, pct: 10, until: '2026-12-01T00:00:00Z' } }) }); };   // the monthly part is stale ($10; the hub holds $100)
  const line = { textContent: 'Spent this month: $40 of $100 (40%)', style: {} };
  const doc = { getElementById: (id) => id === 'st-caps-save' ? btn : id === 'st-month-spend' ? line : els[id] || null };
  let refreshes = 0;
  const refreshSpendToday = async () => { refreshes++; line.textContent = 'Spent this month: $41 of $100 (41%)'; };
  const code = `${src('capLoaded')}\n${src('capChanged')}\n${src('paintMonthlyCap')}\n${src('saveSpendCaps', 'async ')}\nreturn { capLoaded, saveSpendCaps };`;
  const { capLoaded, saveSpendCaps } = new Function('document', 'stSaveFetch', 'dialogGuard', 'spendToday', 'stSum', 'usd', 'monthDateText', 'alert', 'setTimeout', 'refreshSpendToday', code)(
    doc, stSaveFetch, { savePoint: () => () => {} }, null, () => {}, (n) => `$${n}`, () => '', () => {}, () => 0, refreshSpendToday);
  capLoaded(els['st-cap-hub'], '5'); capLoaded(els['st-cap-month'], '100');
  els['st-cap-hub'].value = '7'; els['st-cap-hub'].l.input();
  assert.equal(await saveSpendCaps({ quiet: true }), true);
  assert.deepEqual(bodies[0], { hubDailyUsd: 7 });
  assert.equal(line.textContent, 'Spent this month: $40 of $100 (40%)', 'the summary text is unchanged');
  assert.equal(els['st-cap-month'].dataset.loaded, '100', 'and the monthly box baseline did not move');
  assert.equal(refreshes, 0, 'no monthly refresh for a daily-only save');
  els['st-cap-month'].value = '100.5'; els['st-cap-month'].l.input();
  await saveSpendCaps({ quiet: true });
  assert.deepEqual(bodies[1], { monthlyUsd: '100.5' });
  assert.equal(refreshes, 1, 'a monthly save refreshes once');
  assert.equal(line.textContent, 'Spent this month: $41 of $100 (41%)', 'the summary comes from the fresh read, not the acknowledgment');
});

test('scheduler: tasks queued while halted are held at once, so a Resume before the first delivery tick paces them', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'r4b')); const clock = { t: T0 };
  const { st, refusal } = mkTasks(dir, clock);
  const t = await st.create({ requester: 'alice', when: 'in 1 hour', prompt: 'x' });
  refusal.v = 'hub is halted';
  clock.t = T0 + 2 * 3600000;
  st.start(); st.stop();
  const p = st.pending.find(x => x.taskId === t.id);
  assert.ok(p && p.haltHeld, 'held at start, before any delivery tick');
  assert.match(real('app.js'), /Every running turn, worker and research run is stopped/);
  const hh = real('app.js'); const hb = hh.slice(hh.indexOf('async function haltHub()'), hh.indexOf('async function resumeHub()'));
  assert.ok(!/worker, job and research/.test(hb), 'the confirm does not say every job stops (the keep sentence follows)');
});
