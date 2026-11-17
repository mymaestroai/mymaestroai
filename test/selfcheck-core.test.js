'use strict';
// The self-check core with a fake model turn: the fake writes the files itself and reports what a gate and a client would.
// Folders, data and clocks are all temporary; nothing here touches a real install or a real data folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('selfcheck-core-iso-');
const L = (p) => require(path.join(ISO.lib, 'selfcheck', p));
const { createSelfCheck, validateSettings, DEFAULTS, getSelfCheck } = L('index.js');
const { createStore } = L('store.js');
const { makeFixtures, verifyIntact } = L('fixtures.js');

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sc-')));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
const NOON = Date.parse('2026-11-17T12:00:00Z');

// ── Harness ──
// opts.behave(kind, turnNo) -> undefined | 'skip' | 'noresult' | 'badtext' | 'fallback' | 'outside': what the fake does at a step.
function harness(opts = {}) {
  const root = path.join(TMP, `h${++seq}`);
  const hubRoot = path.join(root, 'hub'), hubHome = path.join(root, 'home'), dataDir = path.join(hubRoot, 'data');
  for (const d of [path.join(hubRoot, 'workspaces'), hubHome, dataDir]) fs.mkdirSync(d, { recursive: true });
  const h = { root, hubRoot, hubHome, dataDir, turns: [], pushes: [], clock: { t: NOON }, eights: [], settingsRaw: opts.settings, halt: null, notifyResult: { sent: 1, failed: 0 }, turnError: opts.turnError, errorKind: opts.errorKind || null };
  const random = (n) => { const v = [...Array(n)].map(() => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''); if (n === 8) h.eights.push(v); return v; };
  const D = (idx) => String(1000 + (parseInt(h.eights[h.eights.length - 2 + idx], 16) % 9000));

  async function runTurn(args) {
    const turnNo = h.turns.length;
    h.turns.push(args);
    if (h.turnError) return { reply: '', error: h.turnError, errorKind: 'model' };
    if (h.errorKind) { if (opts.abortFirst) h.sc.stop(); return { reply: '', error: 'stopped', errorKind: h.errorKind }; }
    if (opts.haltOnTurn && turnNo === opts.haltOnTurn) return { reply: '', error: 'halted', errorKind: 'halted' };
    if (opts.block) await opts.block;
    const { observe, prompt } = args;
    const steps = [];
    const reply = [];
    const dec = (tool, input, decision = 'allow', reason = '') => observe({ type: 'decision', tool, input, decision, cls: 'x', reason });
    const res = (tool, input, ok, text) => observe({ type: 'result', tool, input, ok, text });
    const folderOf = (p) => (p.startsWith(hubHome) ? 'home' : 'install');
    for (const line of prompt.split('\n').filter(l => /^\d+\. /.test(l))) {
      const n = Number(/^(\d+)\./.exec(line)[1]);
      steps.push(n);
      let m;
      let kind, run = null;
      if ((m = /^\d+\. Read (\S+\/call-recordings\/\S+) with/.exec(line))) {
        kind = 'refuse'; const p = m[1];
        run = (mode) => { if (mode === 'allow') { dec('Read', { file_path: p }, 'allow'); res('Read', { file_path: p }, true, 'x'); } else dec('Read', { file_path: p }, 'deny', 'call recordings are private'); reply.push(`${n}. refused: private`); };
      } else if ((m = /^\d+\. Read (\S+\/code\.png)/.exec(line))) {
        const p = m[1], f = folderOf(p); kind = `image@${f}`;
        run = () => { dec('Read', { file_path: p }); res('Read', { file_path: p }, true, '[image]'); reply.push(`${n}. done ${D(f === 'install' ? 0 : 1)}`); };
      } else if ((m = /^\d+\. Read (\S+\/read\.txt)/.exec(line))) {
        const p = m[1]; kind = `read@${folderOf(p)}`;
        run = () => { dec('Read', { file_path: p }); res('Read', { file_path: p }, true, `1\t${fs.readFileSync(p, 'utf8')}`); reply.push(`${n}. done`); };
      } else if ((m = /^\d+\. Read (\S+\/edit\.txt) .* change "(before-\w+)" to "(after-\w+)"/.exec(line))) {
        const p = m[1]; kind = `edit@${folderOf(p)}`;
        run = (mode) => {
          dec('Read', { file_path: p }); res('Read', { file_path: p }, true, fs.readFileSync(p, 'utf8'));
          dec('Edit', { file_path: p, old_string: m[2], new_string: m[3] });
          if (mode === 'noresult') return;
          fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace(m[2], m[3]));
          res('Edit', { file_path: p }, true, 'edited'); reply.push(`${n}. done`);
        };
      } else if ((m = /^\d+\. Write (\S+) with the Write tool, content exactly "(\w+)"/.exec(line))) {
        const p = m[1], W = m[2]; kind = `write@${folderOf(p)}`;
        run = (mode) => {
          dec('Write', { file_path: p, content: W });
          if (mode === 'noresult') return;
          if (mode === 'fallback') { const cmd = `printf %s ${W} > ${p}`; dec('Bash', { command: cmd }); fs.writeFileSync(p, W); res('Bash', { command: cmd }, true, ''); return; }
          fs.writeFileSync(p, W); res('Write', { file_path: p }, true, 'created'); reply.push(`${n}. done`);
        };
      } else if ((m = /^\d+\. Glob with the Glob tool, pattern "\*\.txt" in (\S+?)\.$/.exec(line))) {
        const dir = m[1]; kind = `glob@${folderOf(dir)}`;
        run = (mode) => { dec('Glob', { pattern: '*.txt', path: dir }); res('Glob', { pattern: '*.txt', path: dir }, true, mode === 'badtext' ? 'no files' : fs.readdirSync(dir).filter(f => f.endsWith('.txt')).join('\n')); reply.push(`${n}. done`); };
      } else if ((m = /^\d+\. Grep with the Grep tool for "selfcheck-key" in (\S+?)\.$/.exec(line))) {
        const dir = m[1]; kind = `grep@${folderOf(dir)}`;
        run = (mode) => { dec('Grep', { pattern: 'selfcheck-key', path: dir }); res('Grep', { pattern: 'selfcheck-key', path: dir }, true, mode === 'badtext' ? 'No matches found' : fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')); reply.push(`${n}. done`); };
      } else if ((m = /^\d+\. Bash: run exactly `(.+)`$/.exec(line))) {
        const cmd = m[1], mm = /^printf %s (\w+) > '([^']+)'$/.exec(cmd); kind = `bash@${folderOf(mm[2])}`;   // the path is single-quoted
        run = () => { dec('Bash', { command: cmd }); fs.writeFileSync(mm[2], mm[1]); res('Bash', { command: cmd }, true, ''); reply.push(`${n}. done`); };
      }
      if (!run) continue;
      const mode = opts.behave && opts.behave(kind, turnNo);
      if (mode === 'skip') continue;
      if (kind === 'refuse') { run(mode === 'allow' ? 'allow' : undefined); continue; }
      run(mode);
    }
    // an agent that wrote outside its folders
    if (opts.behave && opts.behave('outside', turnNo) === 'outside') { const p = path.join(hubRoot, 'workspaces', 'elsewhere.txt'); dec('Write', { file_path: p, content: 'x' }); res('Write', { file_path: p }, true, 'created'); }
    h.steps = steps;
    // the turn did its steps, then the provider failed: as in the hub, an errored turn brings back no reply
    if (opts.errorAfter) return { reply: '', error: opts.errorAfter, errorKind: 'model' };
    return { reply: reply.join('\n'), error: null, errorKind: null };
  }

  const sc = createSelfCheck({
    hubRoot, hubHome, dataDir, now: () => h.clock.t, log: (l) => { h.logs = (h.logs || []).concat(l); },
    settings: () => h.settingsRaw, runTurn,
    models: async () => opts.models || ['claude-sdk/claude-sonnet-4-5', 'claude-sdk/claude-haiku-4-5', 'claude-sdk/claude-haiku-3-5', 'openai/gpt-5'],
    leadModel: async () => opts.leadModel || null,
    realAgentNames: async () => opts.realAgentNames || [],
    sandboxAvailable: async () => (opts.boxed === false ? { ok: false } : { ok: true }),
    notify: async (payload) => { h.pushes.push(payload); return typeof h.notifyResult === 'function' ? h.notifyResult() : h.notifyResult; },
    halted: () => h.halt, zone: () => 'UTC', random,
    bashWritePaths: opts.bashWritePaths || undefined,
  });
  h.sc = sc;
  return h;
}
const statusOf = (lr) => Object.fromEntries(Object.entries(lr.classes).map(([c, r]) => [c, r.status]));
const allPass = { lead: 'pass', host: 'pass', boxed: 'pass', shared: 'pass' };

// ── run() ──
test('run: everything passes, nothing is pushed, and the stored file has the shape', async () => {
  const h = harness();
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(statusOf(lr), allPass);
  assert.strictEqual(lr.model, 'claude-sdk/claude-haiku-4-5', 'the newest haiku');
  assert.deepStrictEqual(h.pushes, []);
  assert.deepStrictEqual(h.turns.map(t => t.name), ['selfcheck-lead', 'selfcheck-host', 'selfcheck-boxed', 'selfcheck-shared']);
  assert.ok(h.turns.every(t => t.timeoutMs === 240000 && t.model === 'claude-sdk/claude-haiku-4-5' && typeof t.observe === 'function'));
  const st = h.sc.stored();
  assert.strictEqual(st.lastRun.id, lr.id);
  assert.strictEqual(st.lastRun.trigger, 'manual');
  assert.deepStrictEqual(Object.keys(st.lastRun.classes.host.actions).sort(), ['bash@home', 'bash@install', 'edit@home', 'edit@install', 'glob@home', 'glob@install', 'grep@home', 'grep@install', 'image@home', 'image@install', 'read@home', 'read@install', 'refuse', 'write@home', 'write@install']);
  assert.deepStrictEqual(st.lastRun.classes.host.actions.refuse, { ok: true, reason: '' });
  assert.deepStrictEqual(st.failingSince, {});
  assert.strictEqual(st.history.length, 1);
  assert.deepStrictEqual({ ...st.history[0], at: 'x' }, { id: lr.id, at: 'x', trigger: 'manual', summary: 'all passed' });
  assert.ok(!JSON.stringify(st).includes('"tried"'), 'only ok and reason are stored');
  assert.strictEqual(h.sc.isRunning(), false);
  const view = h.sc.view();
  assert.deepStrictEqual(Object.keys(view).sort(), ['failingSince', 'history', 'lastRun', 'readiness', 'running', 'settings', 'stuck']);
  assert.deepStrictEqual(view.stuck, {}, 'nothing stuck after a run that ran');
  assert.strictEqual(view.readiness[0].level, 'ok');
  assert.match(view.readiness[0].detail, /^All 4 kinds of agent work \(checked /);
});

test('records: each class is a full synthetic agent with its own folder and the refusing overrides', async () => {
  const h = harness();
  await h.sc.run({ trigger: 'manual' });
  const rec = Object.fromEntries(h.turns.map(t => [t.name, t.record]));
  const over = { send: 'deny', web: 'deny', admin: 'deny', destroy: 'deny', money: 'deny' };
  for (const c of ['lead', 'host', 'boxed', 'shared']) {
    const r = rec[`selfcheck-${c}`];
    assert.strictEqual(r.effort, 'low'); assert.strictEqual(r.owner, null);
    assert.deepStrictEqual(r.policy, { roots: [path.join(h.hubHome, 'selfcheck', c)], overrides: over });
    assert.strictEqual(r.model, 'claude-sdk/claude-haiku-4-5');
  }
  assert.deepStrictEqual([rec['selfcheck-lead'].category, rec['selfcheck-lead'].lead, rec['selfcheck-lead'].tools, rec['selfcheck-lead'].sandbox], ['primary', true, 'client', 'off']);
  assert.deepStrictEqual([rec['selfcheck-host'].category, rec['selfcheck-host'].lead, rec['selfcheck-host'].tools, rec['selfcheck-host'].sandbox], ['specialist', undefined, 'client', 'off']);
  assert.deepStrictEqual([rec['selfcheck-boxed'].tools, rec['selfcheck-boxed'].sandbox], ['hub', 'container']);
  assert.deepStrictEqual([rec['selfcheck-shared'].sharedWith, rec['selfcheck-shared'].tools], [['selfcheck:member'], 'client']);
});

test('one class fails: one push with the plain title; the same failure again is silent; passing and failing again pushes again', async () => {
  let bad = true;
  const h = harness({ behave: (kind) => (bad && kind === 'write@home' ? 'noresult' : undefined) });
  const lr = await h.sc.run({ trigger: 'nightly' });
  assert.deepStrictEqual(statusOf(lr), { ...allPass, lead: 'fail', host: 'fail', boxed: 'fail', shared: 'fail' }, 'the fake fails every class the same way');
  // every class fails here, so the push is a count; use a single class for the title check
  assert.strictEqual(h.pushes.length, 1);
  assert.strictEqual(h.pushes[0].title, 'Self-check: 4 problems with your agents');
  assert.strictEqual(h.pushes[0].url, '/?selfcheck=1'); assert.strictEqual(h.pushes[0].tag, 'selfcheck');

  const h2 = harness({ settings: { classes: ['host'] }, behave: (kind) => (bad && kind === 'write@home' ? 'noresult' : undefined) });
  bad = true;
  const r1 = await h2.sc.run({ trigger: 'nightly' });
  assert.strictEqual(r1.classes.host.actions['write@home'].reason, "Your Maestro's rules allowed it, but the Claude client refused it.");
  assert.strictEqual(h2.pushes.length, 1);
  assert.strictEqual(h2.pushes[0].title, "Self-check: ordinary agents on this computer can't write files outside the install folder");
  const lines = h2.pushes[0].body.split('\n');
  assert.strictEqual(lines[0], "Ordinary agents on this computer: write files outside the install folder: Your Maestro's rules allowed it, but the Claude client refused it. (since Tue 12:00 PM)");
  assert.strictEqual(lines[lines.length - 1], 'Open Settings → Status → Self-check.');
  const since = h2.sc.stored().failingSince;
  assert.deepStrictEqual(Object.keys(since), ['host/write@home']);

  // the same failure a day later: no new push, and the since-time stays
  h2.clock.t += 24 * 3600 * 1000;
  await h2.sc.run({ trigger: 'nightly' });
  assert.strictEqual(h2.pushes.length, 1);
  assert.deepStrictEqual(h2.sc.stored().failingSince, since);
  assert.deepStrictEqual(h2.sc.stored().notified, ['host/write@home']);

  // it passes: recovery is silent, the key is gone
  bad = false; h2.clock.t += 24 * 3600 * 1000;
  const ok = await h2.sc.run({ trigger: 'nightly' });
  assert.strictEqual(ok.classes.host.status, 'pass');
  assert.strictEqual(h2.pushes.length, 1);
  assert.deepStrictEqual([h2.sc.stored().failingSince, h2.sc.stored().notified], [{}, []]);

  // and fails again: told again, with a new since-time
  bad = true; h2.clock.t += 24 * 3600 * 1000;
  await h2.sc.run({ trigger: 'nightly' });
  assert.strictEqual(h2.pushes.length, 2);
  assert.notStrictEqual(h2.sc.stored().failingSince['host/write@home'], since['host/write@home']);
  assert.strictEqual(h2.sc.stored().history.length, 4);
});

test('a push that reached no device does not count as told; a missing push is tried again next run', async () => {
  const h = harness({ settings: { classes: ['lead'] }, behave: (kind) => (kind === 'edit@install' ? 'noresult' : undefined) });
  h.notifyResult = { sent: 0, failed: 2 };
  await h.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(h.sc.stored().notified, []);
  h.notifyResult = { error: 'no push service' };
  await h.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(h.sc.stored().notified, []);
  h.notifyResult = { sent: 0, failed: 0 };     // nobody to tell is not a failure to tell
  await h.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(h.sc.stored().notified, ['lead/edit@install']);
  assert.strictEqual(h.pushes.length, 3);
  await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(h.pushes.length, 3);
});

test('a model error is "couldn\'t run" with no push, and the class\'s earlier failures are kept as they were', async () => {
  const h = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'write@install' ? 'noresult' : undefined) });
  await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(h.pushes.length, 1);
  const was = h.sc.stored().failingSince, told = h.sc.stored().notified;
  assert.deepStrictEqual(Object.keys(was), ['host/write@install']);
  h.turnError = 'plan limit reached';
  h.clock.t += 3600000;
  const lr = await h.sc.run({ trigger: 'nightly' });
  assert.strictEqual(lr.classes.host.status, 'error');
  assert.strictEqual(lr.classes.host.note, "Couldn't run: plan limit reached");
  assert.strictEqual(h.pushes.length, 1, 'no push for a run that could not run');
  assert.deepStrictEqual([h.sc.stored().failingSince, h.sc.stored().notified], [was, told]);
  // the standing failure still warns (F3): the class that couldn't run says nothing about it
  const [item] = h.sc.readinessItems();
  assert.strictEqual(item.level, 'warn');
  assert.match(item.title, /^Self-check: ordinary agents on this computer can't write files in the install folder/);
  // and a clean harness with only the error: no failures at all
  const e = harness({ settings: { classes: ['host'] }, turnError: 'provider down' });
  await e.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual([e.pushes, e.sc.stored().failingSince], [[], {}]);
  assert.strictEqual(e.sc.stored().history[0].summary, 'skipped');
});

test('a check that couldn\'t run 3 times in a row gets one push, a warning on Status, and starts over once it runs', async () => {
  const h = harness({ settings: { classes: ['host', 'lead'] }, turnError: 'Claude plan limit' });
  const first = h.clock.t;
  for (let i = 0; i < 2; i++) { await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000; }
  assert.deepStrictEqual(h.pushes, [], 'two in a row: still quiet');
  assert.strictEqual(h.sc.readinessItems()[0].level, 'info');
  await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000;
  assert.strictEqual(h.pushes.length, 1, 'the third one in a row: one push for both classes');
  assert.match(h.pushes[0].title, /^Self-check: /);
  assert.match(h.pushes[0].body, /The check of ordinary agents on this computer hasn't been able to run since .* \(Claude plan limit\)\./);
  assert.match(h.pushes[0].body, /The check of lead agents hasn't been able to run since/);
  const stuck = h.sc.stored().stuck;
  assert.deepStrictEqual([stuck.host.count, stuck.host.since, stuck.host.told], [3, new Date(first).toISOString(), true]);
  const [item] = h.sc.readinessItems();
  assert.strictEqual(item.level, 'warn');
  assert.ok(h.sc.view().stuck.host.count === 3);
  await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000;
  assert.strictEqual(h.pushes.length, 1, 'told once, not every night');
  // it runs again: the streak is gone; three more in a row tell again
  h.turnError = null;
  await h.sc.run({ trigger: 'manual' }); h.clock.t += 3600000;
  assert.deepStrictEqual(h.sc.stored().stuck, {});
  h.turnError = 'provider down';
  for (let i = 0; i < 3; i++) { await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000; }
  assert.strictEqual(h.pushes.length, 2);
  assert.match(h.pushes[1].body, /\(provider down\)/);
});

test('no model to test with, 3 runs in a row, is a push of its own; a halted hub never counts', async () => {
  const h = harness({ settings: { classes: ['host'], model: 'codex-cli/some-model' } });
  for (let i = 0; i < 3; i++) { await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000; }
  assert.strictEqual(h.pushes.length, 1);
  assert.strictEqual(h.pushes[0].title, "Self-check: it hasn't been able to run");
  assert.match(h.pushes[0].body, /^The self-check hasn't been able to run since .* \(There is no model to test with/);
  const g = harness({ settings: { classes: ['host'] }, turnError: 'x' });
  await g.sc.run({ trigger: 'nightly' });
  g.halt = 'halted by the owner';
  for (let i = 0; i < 4; i++) await g.sc.run({ trigger: 'nightly' });
  assert.strictEqual(g.sc.stored().stuck.host.count, 1, 'halted runs leave the streak as it was');
  assert.deepStrictEqual(g.pushes, []);
});

test('boxed is skipped, with a note, when Docker is not available', async () => {
  const h = harness({ boxed: false });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(statusOf(lr), { ...allPass, boxed: 'skipped' });
  assert.strictEqual(lr.classes.boxed.note, "Docker isn't available here, so agents in a box weren't checked.");
  assert.ok(!h.turns.some(t => t.name === 'selfcheck-boxed'));
  assert.deepStrictEqual(h.pushes, []);
  assert.match(h.sc.readinessItems()[0].detail, /Agents in a box weren't checked: Docker isn't available here/);
});

test('retry: only the steps the model skipped are asked again; the union of both turns is judged', async () => {
  const h = harness({ settings: { classes: ['host'] }, behave: (kind, turn) => (turn === 0 && (kind === 'glob@install' || kind === 'refuse') ? 'skip' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(h.turns.length, 2);
  assert.deepStrictEqual(h.steps, [5, 15], 'the second turn asked for steps 5 and 15 only (install glob, the refused read)');
  assert.ok(!/^1\. /m.test(h.turns[1].prompt) && /^5\. Glob/m.test(h.turns[1].prompt) && /^15\. Read .*call-recordings/m.test(h.turns[1].prompt));
  assert.strictEqual(lr.classes.host.status, 'pass');
  // a step that fails (not skips) is not retried
  const h2 = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'write@home' ? 'noresult' : undefined) });
  await h2.sc.run({ trigger: 'manual' });
  assert.strictEqual(h2.turns.length, 1);
  // still not tried after the retry: the class couldn't run (F1), not a failure, and no push
  const h3 = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'grep@home' ? 'skip' : undefined) });
  const r3 = await h3.sc.run({ trigger: 'manual' });
  assert.strictEqual(h3.turns.length, 2);
  assert.strictEqual(r3.classes.host.status, 'error');
  assert.strictEqual(r3.classes.host.note, "The agent didn't do every step (1 not tried: search files outside the install folder)");
  assert.deepStrictEqual([h3.pushes, h3.sc.stored().failingSince], [[], {}]);
  assert.strictEqual(h3.sc.stored().stuck.host.count, 1);
});

test('F1: not-tried steps next to a real failure: the class fails with the tried steps only; three untried runs in a row push once', async () => {
  const h = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'grep@home' || kind === 'glob@home' ? 'skip' : kind === 'write@install' ? 'noresult' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'fail');
  assert.ok(!('grep@home' in lr.classes.host.actions) && !('glob@home' in lr.classes.host.actions), 'untried steps are left out');
  assert.strictEqual(lr.classes.host.actions['write@install'].ok, false);
  assert.strictEqual(h.pushes.length, 1);
  const g = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'grep@home' ? 'skip' : undefined) });
  for (let i = 0; i < 2; i++) { await g.sc.run({ trigger: 'nightly' }); g.clock.t += 3600000; }
  assert.deepStrictEqual(g.pushes, [], 'two in a row: quiet');
  await g.sc.run({ trigger: 'nightly' });
  assert.strictEqual(g.pushes.length, 1);
  assert.match(g.pushes[0].body, /hasn't been able to run since/);
});

test('B2: a model error after steps that already failed keeps them: fail and a push; an error with only passing steps is error and no push', async () => {
  // the turn does an allowed refuse and a Write that never comes back, then the harness reports a model error
  const wrapped = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'refuse' ? 'allow' : kind === 'write@install' ? 'noresult' : undefined), errorAfter: 'provider hiccup' });
  const lr = await wrapped.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'fail');
  assert.match(lr.classes.host.note, /^The turn stopped early \(provider hiccup\), but these had already failed\./);
  assert.strictEqual(lr.classes.host.actions.refuse.ok, false);
  assert.strictEqual(lr.classes.host.actions['write@install'].ok, false);
  assert.ok(!('bash@home' in lr.classes.host.actions) || lr.classes.host.actions['bash@home'].ok === true, 'only tried steps are listed');
  assert.strictEqual(wrapped.pushes.length, 1);
  assert.strictEqual(wrapped.turns.length, 1, 'no retry after an error');
  // only passing steps, then the error: error, no push
  const ok = harness({ settings: { classes: ['host'] }, errorAfter: 'provider hiccup', behave: (kind) => (kind === 'grep@home' || kind === 'glob@home' ? 'skip' : undefined) });
  const lr2 = await ok.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr2.classes.host.status, 'error');
  assert.strictEqual(lr2.classes.host.note, "Couldn't run: provider hiccup");
  assert.deepStrictEqual([ok.pushes, ok.sc.stored().failingSince], [[], {}]);
});

test('B2: a turn cut off by an error right after an allowed call does not call that call refused; the same shape without an error does', async () => {
  // the Write in the install folder is allowed and is the last thing the turn does; every later step is skipped
  const ORDER = ['read@install', 'image@install', 'write@install'];
  const behave = (kind) => (kind === 'write@install' ? 'noresult' : ORDER.includes(kind) ? undefined : 'skip');
  const cut = harness({ settings: { classes: ['host'] }, behave, errorAfter: 'connection reset' });
  const lr = await cut.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'error', 'cut off: not a refusal');
  assert.strictEqual(lr.classes.host.note, "Couldn't run: connection reset");
  assert.deepStrictEqual(cut.pushes, []);
  // without the error the client did end the turn there: that is a refusal (after the retry turn)
  const plain = harness({ settings: { classes: ['host'] }, behave: (kind, turnNo) => (turnNo > 1 ? 'skip' : behave(kind)) });
  const lr2 = await plain.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr2.classes.host.status, 'fail');
  assert.match(lr2.classes.host.actions['write@install'].reason, /allowed it, but the Claude client refused it|allowed it, but the tool refused it/);
});

test('r2: a turn that broke off before its answer does not fail the picture step for want of digits', async () => {
  // every step works, then the provider fails: the reply (and so the digits) never comes
  const h = harness({ settings: { classes: ['host'] }, errorAfter: 'stream closed' });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'error', 'nothing settled failed');
  assert.deepStrictEqual(h.pushes, []);
  // ...but with a settled failure beside it, the picture step is left out, not listed as failed
  const g = harness({ settings: { classes: ['host'] }, errorAfter: 'stream closed', behave: (kind) => (kind === 'grep@home' ? 'badtext' : undefined) });
  const lr2 = await g.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr2.classes.host.status, 'fail');
  assert.ok(!('image@install' in lr2.classes.host.actions) && !('image@home' in lr2.classes.host.actions));
  assert.deepStrictEqual(Object.entries(lr2.classes.host.actions).filter(([, a]) => !a.ok).map(([k]) => k), ['grep@home']);
});

test('r2: an old failure stays until that same step is checked and passes; a run that never reached it keeps it (and its notice)', async () => {
  // one harness; its options are read at run time, so the second run can behave differently
  let phase = 1;
  const o = { settings: { classes: ['host'] }, behave: (kind) => (phase === 1 ? (kind === 'grep@home' ? 'badtext' : undefined) : (kind === 'grep@home' ? 'skip' : kind === 'write@install' ? 'noresult' : undefined)) };
  const h = harness(o);
  await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000;
  const since0 = h.sc.stored().failingSince['host/grep@home'];
  assert.ok(since0); assert.strictEqual(h.pushes.length, 1);
  // next night: write@install fails, grep@home is never reached, then the provider fails
  phase = 2; o.errorAfter = 'stream closed';
  const lr = await h.sc.run({ trigger: 'nightly' });
  assert.strictEqual(lr.classes.host.status, 'fail', 'write@install settled as failed');
  assert.ok(!('grep@home' in lr.classes.host.actions), 'grep@home was not settled this time');
  const st = h.sc.stored();
  assert.strictEqual(st.failingSince['host/grep@home'], since0, 'never reached this time: still failing since the first time');
  assert.ok(st.notified.includes('host/grep@home'), 'and still counted as told');
  assert.strictEqual(h.pushes.length, 2, 'one new push, for write@install only');
  assert.doesNotMatch(h.pushes[1].body, /search files outside/);
  // a later run that checks read@home and passes ends it
  phase = 3; o.errorAfter = null; o.behave = () => undefined;
  await h.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(h.sc.stored().failingSince, {});
});

test('r2: a read-only command on bash.txt after the scripted one does not fail the Bash step', async () => {
  const { verifyClass, shellWritePaths } = L('verify.js');
  const folders = { install: '/w/ws', home: '/w/home' };
  const fx = { R: 'r', D: '1234', E: 'e', G: 'g', K: 'k', W: 'w', B: 'b0b0' };
  const scriptedBash = { install: "printf %s b0b0 > '/w/ws/bash.txt'", home: "printf %s b0b0 > '/w/home/bash.txt'" };
  const ev = [];
  const both = (tool, input, text = '') => { ev.push({ type: 'decision', tool, input, decision: 'allow', rule: 'allow' }); ev.push({ type: 'result', tool, input, ok: true, text }); };
  both('Bash', { command: scriptedBash.install });
  both('Bash', { command: 'cat /w/ws/bash.txt' }, 'b0b0');
  const v = verifyClass({ events: ev, reply: '', fixtures: { install: fx, home: fx }, folders, refusePath: '/w/rec/x.txt', scriptedBash, readFile: (p) => (p === '/w/ws/bash.txt' ? 'b0b0' : null), bashWritePaths: shellWritePaths });
  assert.strictEqual(v.actions['bash@install'].ok, true, v.actions['bash@install'].reason);
  // a second command that WRITES bash.txt still fails the step
  const ev2 = [];
  const both2 = (tool, input) => { ev2.push({ type: 'decision', tool, input, decision: 'allow', rule: 'allow' }); ev2.push({ type: 'result', tool, input, ok: true, text: '' }); };
  both2('Bash', { command: scriptedBash.install });
  both2('Bash', { command: 'echo other > /w/ws/bash.txt' });
  const v2 = verifyClass({ events: ev2, reply: '', fixtures: { install: fx, home: fx }, folders, refusePath: '/w/rec/x.txt', scriptedBash, readFile: () => 'b0b0', bashWritePaths: shellWritePaths });
  assert.strictEqual(v2.actions['bash@install'].ok, false);
});

test('a real agent named like a check agent: that kind is skipped with a note, and no turn runs for it', async () => {
  const h = harness({ settings: { classes: ['host', 'lead'] }, realAgentNames: ['main', 'selfcheck-host'] });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'skipped');
  assert.match(lr.classes.host.note, /^An agent named selfcheck-host is in your agent list, so this kind wasn't checked\./);
  assert.strictEqual(lr.classes.lead.status, 'pass');
  assert.deepStrictEqual(h.turns.map(t => t.name), ['selfcheck-lead']);
});

test('r2: a halt during the retry keeps what the first turn already settled', async () => {
  // turn 0: write@install fails (no result) and glob@home is skipped, so a retry follows; the retry is halted
  const h = harness({ settings: { classes: ['host'] }, haltOnTurn: 1, behave: (kind) => (kind === 'glob@home' ? 'skip' : kind === 'write@install' ? 'noresult' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'fail');
  assert.strictEqual(lr.classes.host.actions['write@install'].ok, false);
  assert.match(lr.classes.host.note, /halted during the check/);
  assert.strictEqual(h.pushes.length, 1);
  // with nothing settled, the same halt is a plain skip
  const g = harness({ settings: { classes: ['host'] }, haltOnTurn: 1, behave: (kind) => (kind === 'glob@home' ? 'skip' : undefined) });
  const lr2 = await g.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr2.classes.host.status, 'skipped');
});

test('F2/F5: a halted turn, or an unavailable one after our own stop(), is skipped and never counts toward the streak; other errors still count', async () => {
  const h = harness({ settings: { classes: ['host'] }, errorKind: 'halted' });
  for (let i = 0; i < 4; i++) { const lr = await h.sc.run({ trigger: 'nightly' }); h.clock.t += 3600000; assert.strictEqual(lr.classes.host.status, 'skipped'); }
  assert.strictEqual(h.pushes.length, 0);
  assert.deepStrictEqual(h.sc.stored().stuck, {});
  assert.strictEqual(h.sc.stored().lastRun.classes.host.note, 'Your Maestro was halted during the check.');
  // a mid-run halt after two errors does not move the count
  const g = harness({ settings: { classes: ['host'] }, turnError: 'x' });
  await g.sc.run({ trigger: 'nightly' }); g.clock.t += 3600000;
  g.turnError = null; g.errorKind = 'halted';
  await g.sc.run({ trigger: 'nightly' });
  assert.strictEqual(g.sc.stored().stuck.host.count, 1);
  // unavailable with our own abort: skipped; without it: error
  const u = harness({ settings: { classes: ['host'] }, errorKind: 'unavailable' });
  const lr = await u.sc.run({ trigger: 'nightly' });
  assert.strictEqual(lr.classes.host.status, 'error');
  const s = harness({ settings: { classes: ['host'] }, errorKind: 'unavailable', abortFirst: true });
  const lr2 = await s.sc.run({ trigger: 'nightly' });
  assert.strictEqual(lr2.classes.host.status, 'skipped');
  assert.strictEqual(lr2.classes.host.note, 'The check was stopped.');
  assert.deepStrictEqual(s.sc.stored().stuck, {});
});

test('F3: a halted run only adds a history line; the last result, failingSince and notified stay, and readiness still warns', async () => {
  const h = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'write@install' ? 'noresult' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  const before = h.sc.stored();
  h.halt = 'hub is halted'; h.clock.t += 3600000;
  await h.sc.run({ trigger: 'nightly' });
  const after = h.sc.stored();
  assert.strictEqual(after.lastRun.id, lr.id);
  assert.deepStrictEqual([after.failingSince, after.notified, after.stuck || {}], [before.failingSince, before.notified, before.stuck || {}]);
  assert.strictEqual(after.history[0].summary, 'skipped (halted)');
  assert.strictEqual(after.history.length, 2);
  assert.strictEqual(h.sc.readinessItems()[0].level, 'warn');
  // standing keys warn even when the stored last run has no failing class
  const k = harness({ settings: { classes: ['host'] } });
  await k.sc.run({ trigger: 'manual' });
  const { createStore } = L('store.js');
  const st = createStore({ dir: k.dataDir, now: () => k.clock.t, log: () => {} });
  st.set({ failingSince: { 'host/read@home': '2026-11-16T03:45:00.000Z' } });
  const [item] = createSelfCheck({ hubRoot: k.hubRoot, hubHome: k.hubHome, dataDir: k.dataDir, now: () => k.clock.t, zone: () => 'UTC' }).readinessItems();
  assert.strictEqual(item.level, 'warn');
  assert.match(item.title, /ordinary agents on this computer can't read files in the install folder|can't read files outside the install folder/);
  assert.match(item.detail, /since /);
});

test('F8: one unknown or bad key does not reset the other settings; the problem is logged once', () => {
  const h = harness({ settings: { enabled: false, foo: 1 } });
  assert.strictEqual(h.sc.settings().enabled, false);
  assert.strictEqual(h.sc.settings().nightlyAt, DEFAULTS.nightlyAt);
  const g = harness({ settings: { enabled: false, nightlyAt: 'x', afterStart: false } });
  assert.deepStrictEqual([g.sc.settings().enabled, g.sc.settings().afterStart, g.sc.settings().nightlyAt], [false, false, DEFAULTS.nightlyAt]);
  g.sc.settings(); g.sc.settings();
  assert.strictEqual((g.logs || []).filter(l => /nightlyAt/.test(l)).length, 1, 'logged once');
  assert.strictEqual(validateSettings({ foo: 1 }).ok, false, 'the PUT check still refuses an unknown key');
});

test('the Nov 10 fallback is caught end to end: a Bash printf standing in for a broken Write fails the class', async () => {
  const h = harness({ settings: { classes: ['host'] }, behave: (kind) => (kind === 'write@home' ? 'fallback' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.actions['write@home'].ok, false);
  assert.match(lr.classes.host.actions['write@home'].reason, /done another way/);
  assert.strictEqual(h.pushes.length, 1);
});

test('a glob result without the nonce fails the class; a gate allow on call recordings fails it with a push', async () => {
  const h = harness({ settings: { classes: ['lead'] }, behave: (kind) => (kind === 'glob@install' ? 'badtext' : kind === 'refuse' ? 'allow' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.lead.actions['glob@install'].reason, 'The tool ran but returned something else.');
  assert.strictEqual(lr.classes.lead.actions.refuse.reason, "Your Maestro's safety rules let it read call recordings.");
  assert.strictEqual(h.pushes.length, 1);
  assert.strictEqual(h.pushes[0].title, 'Self-check: 2 problems with your agents');
  assert.ok(h.pushes[0].body.includes("Lead agents: keep call recordings private: Your Maestro's safety rules let it read call recordings."));
});

test('an agent that wrote outside its folders fails the class: key <class>/outside, pushed', async () => {
  const h = harness({ settings: { classes: ['shared'] }, behave: (kind) => (kind === 'outside' ? 'outside' : undefined) });
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.shared.status, 'fail');
  assert.match(lr.classes.shared.note, /^A check agent wrote outside its check folders: .*elsewhere\.txt\.$/);
  assert.deepStrictEqual(Object.keys(h.sc.stored().failingSince), ['shared/outside']);
  assert.strictEqual(h.pushes.length, 1);
  assert.match(h.pushes[0].title, /^Self-check: agents shared with a member wrote outside their check folders$/);
  assert.match(h.sc.readinessItems()[0].title, /wrote outside their check folders/);
});

test('settings: disabled -> null for start/nightly, a coded throw for manual; halted -> noted, no turn, no push; one at a time', async () => {
  const h = harness({ settings: { enabled: false } });
  assert.strictEqual(await h.sc.run({ trigger: 'start' }), null);
  assert.strictEqual(await h.sc.run({ trigger: 'nightly' }), null);
  assert.throws(() => h.sc.run({ trigger: 'manual' }), (e) => e.code === 'disabled');
  assert.strictEqual(h.turns.length, 0);

  const g = harness(); g.halt = 'hub is halted';
  const lr = await g.sc.run({ trigger: 'nightly' });
  assert.strictEqual(lr.note, "Your Maestro was halted; the check didn't run.");
  assert.deepStrictEqual([g.turns.length, g.pushes.length], [0, 0]);
  assert.strictEqual(g.sc.stored().history[0].summary, 'skipped (halted)');

  let release; const block = new Promise(r => { release = r; });
  const b = harness({ settings: { classes: ['lead'] }, block });
  const first = b.sc.run({ trigger: 'manual' });
  assert.strictEqual(b.sc.isRunning(), true);
  const second = b.sc.run({ trigger: 'manual' });
  assert.deepStrictEqual(second, { running: true, id: second.id });
  assert.match(second.id, /^sc-/);
  assert.strictEqual(b.sc.view().running, true);
  release();
  const done = await first;
  assert.strictEqual(done.id, second.id, 'the id returned is the running run\'s');
  assert.strictEqual(b.sc.isRunning(), false);
});

test('history keeps the last 14, newest first', async () => {
  const h = harness({ settings: { classes: ['lead'] } });
  for (let i = 0; i < 16; i++) { h.clock.t += 60000; await h.sc.run({ trigger: 'manual' }); }
  const hist = h.sc.stored().history;
  assert.strictEqual(hist.length, 14);
  assert.ok(Date.parse(hist[0].at) > Date.parse(hist[13].at));
});

// ── Model choice ──
test('model choice: newest haiku, else newest sonnet, else the lead\'s own model, else none; an explicit model as given', async () => {
  const pick = async (opts, settings) => { const h = harness({ ...opts, settings: { classes: ['lead'], ...(settings || {}) } }); const lr = await h.sc.run({ trigger: 'manual' }); return { lr, h }; };
  assert.strictEqual((await pick({ models: ['claude-sdk/claude-haiku-3-5', 'claude-sdk/claude-haiku-4-5', 'claude-sdk/claude-sonnet-4-5'] })).lr.model, 'claude-sdk/claude-haiku-4-5');
  assert.strictEqual((await pick({ models: ['claude-sdk/claude-sonnet-4', 'claude-sdk/claude-sonnet-4-5', 'openai/gpt-5'] })).lr.model, 'claude-sdk/claude-sonnet-4-5');
  // no Claude sign-in: the lead's own model if it is on the list and runs on the hub
  assert.strictEqual((await pick({ models: ['openai/gpt-5', 'lmstudio/qwen'], leadModel: 'lmstudio/qwen' })).lr.model, 'lmstudio/qwen');
  for (const lead of ['codex-cli/gpt-5', 'codex/x', 'perplexity/sonar', 'claude-sdk/claude-opus-4', 'lmstudio/not-listed']) {
    const { lr, h } = await pick({ models: ['openai/gpt-5', 'lmstudio/qwen', 'claude-sdk/claude-opus-4'], leadModel: lead });
    assert.strictEqual(lr.model, null, lead);
    assert.strictEqual(lr.classes.lead.status, 'skipped');
    assert.strictEqual(lr.classes.lead.note, 'There is no model to test with: sign in to Claude, or give your lead agent a model your Maestro runs itself.');
    assert.strictEqual(h.turns.length, 0); assert.strictEqual(h.pushes.length, 0);
  }
  // explicit
  assert.strictEqual((await pick({}, { model: 'openai/gpt-5' })).lr.model, 'openai/gpt-5');
  for (const m of ['codex-cli/gpt-5', 'codex/gpt', 'perplexity/sonar']) {
    const { lr } = await pick({}, { model: m });
    assert.strictEqual(lr.model, null); assert.strictEqual(lr.classes.lead.status, 'skipped');
  }
});

// ── Settings ──
test('validateSettings: defaults, merges, and refusals', () => {
  assert.deepStrictEqual(validateSettings({}), { ok: true, value: { enabled: true, afterStart: true, nightlyAt: '03:45', classes: ['lead', 'host', 'boxed', 'shared'], model: 'auto' } });
  assert.deepStrictEqual({ ...DEFAULTS, classes: [...DEFAULTS.classes] }, validateSettings({}).value);
  assert.deepStrictEqual(validateSettings({ nightlyAt: '00:00', classes: ['host'], model: 'claude-sdk/claude-haiku-4-5', enabled: false }).value, { enabled: false, afterStart: true, nightlyAt: '00:00', classes: ['host'], model: 'claude-sdk/claude-haiku-4-5' });
  assert.strictEqual(validateSettings({ nightlyAt: '23:59' }).ok, true);
  const bad = [{ extra: 1 }, { enabled: 'yes' }, { afterStart: 1 }, { nightlyAt: '24:00' }, { nightlyAt: '3:45' }, { nightlyAt: '03:60' }, { nightlyAt: 345 },
    { classes: [] }, { classes: 'lead' }, { classes: ['lead', 'lead'] }, { classes: ['lead', 'ghost'] }, { model: '' }, { model: 5 }, { model: '-x' }, { model: 'a b' }, { model: 'x'.repeat(121) }, null, [], 'text'];
  for (const b of bad) { const r = validateSettings(b); assert.strictEqual(r.ok, false, JSON.stringify(b)); assert.ok(typeof r.error === 'string' && r.error); }
  assert.strictEqual(validateSettings({ model: 'x'.repeat(120) }).ok, true);
  assert.strictEqual(validateSettings({ model: 'lmstudio/qwen3:8b[1m]' }).ok, true);
});

test('settings(): the raw object over the defaults; a bad stored object falls back to the defaults', () => {
  const h = harness({ settings: { nightlyAt: '01:15' } });
  assert.deepStrictEqual(h.sc.settings(), { ...validateSettings({}).value, nightlyAt: '01:15' });
  h.settingsRaw = { nightlyAt: 'later' };
  assert.deepStrictEqual(h.sc.settings(), validateSettings({}).value);
  h.settingsRaw = undefined;
  assert.deepStrictEqual(h.sc.settings(), validateSettings({}).value);
});

// ── Fixtures ──
const fixturesIn = (h, cls = 'host') => makeFixtures({ hubRoot: h.hubRoot, hubHome: h.hubHome, cls, random: (n) => '0123456789abcdef'.repeat(2).slice(0, n) });

test('fixtures: both folders, 0700, fresh files, write.txt and bash.txt absent', () => {
  const h = harness();
  const fx = fixturesIn(h);
  assert.strictEqual(fx.ok, true);
  assert.strictEqual(fx.folders.install, path.join(h.hubRoot, 'workspaces', 'selfcheck-host'));
  assert.strictEqual(fx.folders.home, path.join(h.hubHome, 'selfcheck', 'host'));
  for (const dir of Object.values(fx.folders)) {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o700);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['code.png', 'edit.txt', 'glob', 'grep', 'read.txt']);
    assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'glob')).sort(), [`g-${fx.fixtures[dir === fx.folders.install ? 'install' : 'home'].G}.txt`, 'a.log', 'b.md'].sort());
    assert.strictEqual(fs.statSync(path.join(dir, 'read.txt')).mode & 0o777, 0o600);
  }
  const f = fx.fixtures.install;
  assert.strictEqual(fs.readFileSync(path.join(fx.folders.install, 'read.txt'), 'utf8'), `selfcheck read ${f.R}\n`);
  assert.strictEqual(fs.readFileSync(path.join(fx.folders.install, 'edit.txt'), 'utf8'), `status: before-${f.E}\n`);
  assert.strictEqual(fs.readFileSync(path.join(fx.folders.install, 'grep', `notes-${f.K}.txt`), 'utf8'), `line one\nselfcheck-key: ${f.K}\nline three\n`);
  assert.ok(/^[1-9]\d{3}$/.test(f.D));
  assert.strictEqual(verifyIntact(fx), true);
});

test('fixtures: a symlinked class folder is refused, at any level, and the link target is left alone', () => {
  for (const where of ['home-class', 'home-selfcheck', 'install-class', 'glob']) {
    const h = harness();
    const target = path.join(h.root, 'target'); fs.mkdirSync(target);
    const link = { 'home-class': path.join(h.hubHome, 'selfcheck', 'host'), 'home-selfcheck': path.join(h.hubHome, 'selfcheck'), 'install-class': path.join(h.hubRoot, 'workspaces', 'selfcheck-host'), glob: path.join(h.hubRoot, 'workspaces', 'selfcheck-host', 'glob') }[where];
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    const fx = fixturesIn(h);
    assert.strictEqual(fx.ok, false, where);
    assert.strictEqual(fx.note, `A check folder is a link, so this check was not run: ${link}`);
    assert.deepStrictEqual(fs.readdirSync(target), [], 'nothing was written through the link');
  }
});

test('run: a symlinked check folder makes that class an error with the plain note, and no turn runs for it', async () => {
  const h = harness({ settings: { classes: ['host', 'lead'] } });
  const target = path.join(h.root, 'target'); fs.mkdirSync(target);
  fs.mkdirSync(path.join(h.hubHome, 'selfcheck'), { recursive: true });
  fs.symlinkSync(target, path.join(h.hubHome, 'selfcheck', 'host'));
  const lr = await h.sc.run({ trigger: 'manual' });
  assert.strictEqual(lr.classes.host.status, 'error');
  assert.match(lr.classes.host.note, /^A check folder is a link, so this check was not run: /);
  assert.strictEqual(lr.classes.lead.status, 'pass');
  assert.deepStrictEqual(h.turns.map(t => t.name), ['selfcheck-lead']);
  assert.deepStrictEqual(h.pushes, []);
});

test('fixtures: verifyIntact catches a changed, replaced or linked fixture', () => {
  const h = harness();
  const fx = fixturesIn(h);
  const f = path.join(fx.folders.home, 'read.txt');
  const original = fs.readFileSync(f);
  fs.writeFileSync(f, 'changed'); assert.strictEqual(verifyIntact(fx), false, 'changed bytes');
  fs.writeFileSync(f, original); assert.strictEqual(verifyIntact(fx), true);
  const g = path.join(fx.folders.install, 'code.png'), png = fs.readFileSync(g);
  fs.unlinkSync(g); assert.strictEqual(verifyIntact(fx), false, 'missing');
  fs.symlinkSync(path.join(fx.folders.home, 'code.png'), g); assert.strictEqual(verifyIntact(fx), false, 'a link, even to the same bytes');
  fs.unlinkSync(g); fs.writeFileSync(g, png); assert.strictEqual(verifyIntact(fx), true);
});

test('fixtures: verifyIntact refuses anything, a link above all, where the turn will create write.txt or bash.txt', () => {
  const h = harness();
  const fx = fixturesIn(h);
  assert.strictEqual(verifyIntact(fx), true);
  // A link at write.txt would carry the check's Write to wherever it points (a lead-like check may write widely).
  const elsewhere = path.join(h.root, 'elsewhere.txt'); fs.writeFileSync(elsewhere, 'keep');
  const w = path.join(fx.folders.home, 'write.txt');
  fs.symlinkSync(elsewhere, w); assert.strictEqual(verifyIntact(fx), false, 'a link at write.txt');
  fs.unlinkSync(w); assert.strictEqual(verifyIntact(fx), true);
  const b = path.join(fx.folders.install, 'bash.txt');
  fs.symlinkSync(path.join(h.root, 'nowhere'), b); assert.strictEqual(verifyIntact(fx), false, 'a dangling link at bash.txt');
  fs.unlinkSync(b); fs.writeFileSync(b, 'planted'); assert.strictEqual(verifyIntact(fx), false, 'a plain file at bash.txt');
  fs.unlinkSync(b); assert.strictEqual(verifyIntact(fx), true);
  assert.strictEqual(fs.readFileSync(elsewhere, 'utf8'), 'keep');
});

test('prompt: the Bash step single-quotes its path, so a space or a quote in the hub home still names one file', () => {
  const { scriptedBash } = L('prompt.js');
  assert.strictEqual(scriptedBash('/x/Application Support/selfcheck/host', 'ab12'), "printf %s ab12 > '/x/Application Support/selfcheck/host/bash.txt'");
  assert.strictEqual(scriptedBash("/x/it's/host", 'ab12'), "printf %s ab12 > '/x/it'\\''s/host/bash.txt'");
});

test('run: a fixture changed between making and the turn stops that class as an error, and no turn runs', async () => {
  const h = harness({ settings: { classes: ['host', 'lead'] } });
  // the first time anything looks at the home read.txt after it was written is verifyIntact: change it right there
  const real = fs.lstatSync, target = path.join(h.hubHome, 'selfcheck', 'host', 'read.txt');
  let tampered = false;
  fs.lstatSync = function (p, ...rest) { if (!tampered && p === target) { tampered = true; fs.writeFileSync(target, 'tampered'); } return real.call(this, p, ...rest); };
  let lr;
  try { lr = await h.sc.run({ trigger: 'manual' }); } finally { fs.lstatSync = real; }
  assert.ok(tampered);
  assert.strictEqual(lr.classes.host.status, 'error');
  assert.strictEqual(lr.classes.host.note, 'The check files were changed by something else before the check ran, so it was stopped.');
  assert.strictEqual(lr.classes.lead.status, 'pass', 'the next class still runs');
  assert.deepStrictEqual(h.turns.map(t => t.name), ['selfcheck-lead']);
  assert.deepStrictEqual(h.pushes, []);
});

test('fixtures: only names the module writes are deleted; a stranger\'s file survives a re-make', () => {
  const h = harness();
  const first = fixturesIn(h);
  const dir = first.folders.home;
  const keep = [path.join(dir, 'keep.txt'), path.join(dir, 'glob', 'mine.txt'), path.join(dir, 'grep', 'notes.txt'), path.join(dir, 'glob', 'g-xyz.log')];
  for (const k of keep) fs.writeFileSync(k, 'mine');
  fs.mkdirSync(path.join(dir, 'sub')); fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'mine');
  fs.writeFileSync(path.join(dir, 'write.txt'), 'left over'); fs.writeFileSync(path.join(dir, 'bash.txt'), 'left over');
  fs.writeFileSync(path.join(dir, 'glob', 'g-0123456789ab.txt'), 'old');     // a glob fixture of an earlier run: ours, goes
  fs.writeFileSync(path.join(dir, 'grep', 'notes-aaaa.txt'), 'old');
  const second = makeFixtures({ hubRoot: h.hubRoot, hubHome: h.hubHome, cls: 'host', random: (n) => 'f'.repeat(n) });
  assert.strictEqual(second.ok, true);
  for (const k of keep) assert.strictEqual(fs.readFileSync(k, 'utf8'), 'mine', k);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'sub', 'deep.txt'), 'utf8'), 'mine');
  assert.ok(!fs.existsSync(path.join(dir, 'write.txt')) && !fs.existsSync(path.join(dir, 'bash.txt')), 'leftovers of the turn are gone');
  assert.ok(!fs.existsSync(path.join(dir, 'glob', 'g-0123456789ab.txt')) && !fs.existsSync(path.join(dir, 'grep', 'notes-aaaa.txt')));
  assert.strictEqual(verifyIntact(second), true);
  assert.strictEqual(verifyIntact(first), false, 'the earlier state no longer matches');
});

test('fixtures: a missing workspaces folder is refused, not created', () => {
  const h = harness();
  fs.rmSync(path.join(h.hubRoot, 'workspaces'), { recursive: true });
  const fx = fixturesIn(h);
  assert.strictEqual(fx.ok, false);
  assert.match(fx.note, /missing/);
  assert.ok(!fs.existsSync(path.join(h.hubRoot, 'workspaces')));
});

// ── Store ──
test('store: a missing file is empty; save writes atomically; no temp files stay', () => {
  const dir = path.join(TMP, `store${++seq}`); fs.mkdirSync(dir);
  const s = createStore({ dir });
  assert.deepStrictEqual(s.get(), { lastRun: null, failingSince: {}, notified: [], history: [] });
  assert.strictEqual(s.has(), false);
  assert.strictEqual(s.set({ lastRun: { id: 'x' } }), true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'selfcheck.json'), 'utf8')).lastRun, { id: 'x' });
  assert.deepStrictEqual(fs.readdirSync(dir), ['selfcheck.json']);
  assert.strictEqual(createStore({ dir }).get().lastRun.id, 'x');
  assert.strictEqual(fs.statSync(path.join(dir, 'selfcheck.json')).mode & 0o777, 0o600);
});

test('store: a corrupt file is kept aside and treated as empty', () => {
  const dir = path.join(TMP, `store${++seq}`); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'selfcheck.json'), '{ not json');
  const logs = [];
  const s = createStore({ dir, now: () => NOON, log: (l) => logs.push(l) });
  assert.deepStrictEqual(s.get().history, []);
  const names = fs.readdirSync(dir);
  assert.ok(!names.includes('selfcheck.json'));
  const aside = names.find(n => n.startsWith('selfcheck.json.corrupt-'));
  assert.ok(aside, names.join());
  assert.strictEqual(aside, 'selfcheck.json.corrupt-2026-11-17T12-00-00-000Z');
  assert.strictEqual(fs.readFileSync(path.join(dir, aside), 'utf8'), '{ not json');
  assert.ok(logs.length);
  assert.strictEqual(s.set({ history: [{ id: 'a' }] }), true);
  // an array is not a store either
  const dir2 = path.join(TMP, `store${++seq}`); fs.mkdirSync(dir2);
  fs.writeFileSync(path.join(dir2, 'selfcheck.json'), '[]');
  assert.deepStrictEqual(createStore({ dir: dir2 }).get().history, []);
  assert.ok(fs.readdirSync(dir2).some(n => n.startsWith('selfcheck.json.corrupt-')));
});

test('store: another read error refuses to write rather than overwrite', () => {
  const dir = path.join(TMP, `store${++seq}`); fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, 'selfcheck.json'));             // reading it is EISDIR
  const logs = [];
  const s = createStore({ dir, log: (l) => logs.push(l) });
  assert.strictEqual(s.set({ lastRun: { id: 'x' } }), false);
  assert.ok(fs.statSync(path.join(dir, 'selfcheck.json')).isDirectory());
  assert.ok(logs.length);
});

test('store: a failed write keeps the copy in memory as it was', () => {
  const dir = path.join(TMP, `store${++seq}`); fs.mkdirSync(dir);
  const s = createStore({ dir, log: () => {} });
  assert.strictEqual(s.set({ history: [{ id: 'one' }] }), true);
  fs.mkdirSync(path.join(dir, 'x'));
  const s2 = createStore({ dir: path.join(dir, 'selfcheck.json', 'nope'), log: () => {} });   // a folder under a file: the write fails
  assert.strictEqual(s2.set({ history: [{ id: 'two' }] }), false);
  assert.deepStrictEqual(s2.get().history, []);
  assert.deepStrictEqual(s.get().history, [{ id: 'one' }]);
});

// ── Readiness ──
test('readiness: none before a run, a warning with up to 3 failures, one push line per fresh failure (three at most)', async () => {
  const h = harness({ settings: { classes: ['host'] }, behave: (kind) => (['write@home', 'edit@home'].includes(kind) ? 'noresult' : ['glob@install', 'grep@home'].includes(kind) ? 'badtext' : undefined) });
  assert.deepStrictEqual(h.sc.readinessItems(), []);
  await h.sc.run({ trigger: 'manual' });
  const [item] = h.sc.readinessItems();
  assert.strictEqual(item.id, 'selfcheck'); assert.strictEqual(item.level, 'warn');
  assert.strictEqual(item.title, "Self-check: ordinary agents on this computer can't list files in the install folder");
  assert.strictEqual(item.detail.split('\n').length, 3, 'up to 3 failures');
  assert.strictEqual(item.fix, 'Settings → Status → Self-check says what failed and since when.');
  assert.deepStrictEqual(item.action, { label: 'Open Self-check', href: '/?selfcheck=1' });
  assert.strictEqual(h.pushes[0].title, 'Self-check: 4 problems with your agents');
  assert.strictEqual(h.pushes[0].body.split('\n').length, 4, 'three failure lines and the Settings line');
});

test('loading lib/selfcheck/index.js loads none of the hub\'s heavy modules; getSelfCheck is lazy', () => {
  assert.strictEqual(typeof getSelfCheck, 'function');
  const loaded = Object.keys(require.cache).filter(f => f.startsWith(ISO.lib + path.sep)).map(f => path.relative(ISO.lib, f));
  for (const heavy of ['sdk-chat.js', 'agents.js', 'push.js', 'settings.js', 'sandbox.js', 'tool-policy.js']) assert.ok(!loaded.includes(heavy), `${heavy} was loaded`);
});
