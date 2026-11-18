'use strict';
// A running agent box with the wrong folders (lib/sandbox startBox): rebuilt at a turn start when idle, held (never
// killed) when work runs in it and it still has a folder the agent may no longer use, left alone when it only lacks one.
// A docker stand-in answers everything; nothing here reaches a real Docker.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSandbox } = require('../lib/sandbox');
const { createReadiness } = require('../lib/readiness');

const IDLE_TOP = 'PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n';
const BUSY_TOP = 'PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n42 node server.js\n';
const alpha = { name: 'alpha', model: 'claude-sdk/claude-haiku-5-5', owner: 'owner1' };

// What a Docker stand-in must answer since boxes carry labels (whose box it is): the image's id, and a box's labels.
const IMG_ID = `sha256:${'cd'.repeat(32)}`;
const isImageId = (args) => args[0] === 'image' && args[1] === 'inspect' && args[2] === '--format' && args[3] === '{{.Id}}';
const isLabelsAsk = (args) => args[0] === 'inspect' && args[1] === '--type' && args[2] === 'container' && args[3] === '--format' && args[4] === '{{.Id}} {{json .Config.Labels}}';
const labelsIn = (args) => { const l = {}; args.forEach((x, i) => { if (args[i - 1] === '--label') { const j = String(x).indexOf('='); l[String(x).slice(0, j)] = String(x).slice(j + 1); } }); return l; };
const noBox = (name) => Object.assign(new Error(`Command failed: docker inspect ${name}`), { stderr: `Error response from daemon: No such container: ${name}` });

// o.top: string | () => string | Error; o.mountsError: inspect of .Mounts throws
function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-'));
  const root1 = path.join(dir, 'root1'), root2 = path.join(dir, 'root2'), other = path.join(dir, 'other');
  fs.mkdirSync(root1);
  const ws = (a) => path.join(dir, 'workspaces', a.name);
  const calls = [], logs = [];
  const r = { dir, root1, root2, other, calls, logs, top: IDLE_TOP, mountsError: false, state: 'running', binds: [], execGate: null, statusGate: null, execStarted: 0 };
  let made = null;   // the labels of the last create the stand-in saw (the one box it holds)
  const docker = async (args) => {
    calls.push(args);
    const cmd = args[0];
    if (isImageId(args)) return { stdout: IMG_ID + '\n', stderr: '' };
    if (isLabelsAsk(args)) {
      if (!r.state) throw noBox(args[5]);
      // a box that was there before the test (r.state is set at the start) was made with today's settings
      return { stdout: args[5] + ' ' + JSON.stringify(made || (await r.sb.labelsFor(alpha)).labels) + '\n', stderr: '' };
    }
    if (cmd === 'inspect') {
      const fmt = String(args[2]);
      if (fmt.includes('.Mounts')) { if (r.mountsError) throw new Error('context deadline exceeded'); return { stdout: r.binds.slice().sort().map(b => `${b}\n`).join(''), stderr: '' }; }
      if (fmt.includes('.HostConfig.Init')) return { stdout: 'true\n', stderr: '' };
      if (!r.state) throw new Error('No such container');
      if (r.statusGate) { const g = r.statusGate; r.statusGate = null; await g; }
      return { stdout: r.state + '\n', stderr: '' };
    }
    if (cmd === 'top') { const t = typeof r.top === 'function' ? r.top() : r.top; if (t instanceof Error) throw t; return { stdout: t, stderr: '' }; }
    if (cmd === 'create') { made = labelsIn(args); r.state = 'created'; r.binds = args.map((x, i) => args[i - 1] === '-v' && String(x).startsWith('/') ? String(x).split(':')[0] : null).filter(Boolean); return { stdout: 'id\n', stderr: '' }; }
    if (cmd === 'start') { r.state = 'running'; return { stdout: '', stderr: '' }; }
    if (cmd === 'rm') { r.state = null; made = null; return { stdout: '', stderr: '' }; }
    if (cmd === 'exec' && args.includes('bash')) { r.execStarted++; if (r.execGate) await r.execGate; return { stdout: 'ok\n', stderr: '' }; }
    return { stdout: '', stderr: '' };
  };
  const sb = createSandbox({
    docker, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bm-data-')), uid: 1000, gid: 1000, image: 'sandbox-image:test', log: (...a) => logs.push(a.join(' ')), now: () => 1700000000000,
    getSetting: () => undefined, isMemberOwned: () => true,   // members get no share/common
    rootsFor: () => [root1, root2], workspaceFor: ws,
    pauseRecord: path.join(dir, 'no-pause.json'),
  });
  r.sb = sb;
  r.want = () => sb.mountsFor(alpha);
  r.binds = sb.mountsFor(alpha);   // the box was made with today's folders (root2 not there yet)
  r.count = (c, flag) => calls.filter(a => a[0] === c && (!flag || a.includes(flag))).length;
  return r;
}
const recheck = (r, extra = {}) => r.sb.ensure(alpha, { recheck: true, ...extra });
const NAME = 'hub-agent-alpha';
const heldOf = (r) => r.sb.readinessItems();

test('1. a running box with the same folders is used as it is: no top, no rm, no create', async () => {
  const r = rig();
  assert.strictEqual(await recheck(r), NAME);
  assert.strictEqual(r.count('top') + r.count('rm') + r.count('create'), 0);
  assert.strictEqual(r.logs.filter(l => /making it again|lacks|warning/.test(l)).length, 0);
});

test('2. a running idle box missing a folder that now exists is made again once; plain and job-start calls change nothing', async () => {
  const r = rig();
  fs.mkdirSync(r.root2);   // created after the box
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  assert.strictEqual(await r.sb.ensure(alpha, { jobStart: true }), NAME);
  assert.strictEqual(r.count('rm') + r.count('create') + r.count('stop'), 0);
  assert.strictEqual(await recheck(r), NAME);
  assert.strictEqual(r.count('stop'), 1);
  assert.strictEqual(r.count('rm', '-f'), 1);
  const made = r.calls.find(a => a[0] === 'create');
  assert.ok(made, 'created again');
  assert.ok(made.includes(`${r.root2}:${r.root2}`), 'with the new folder');
  const lines = r.logs.filter(l => /alpha/.test(l) && /missing:/.test(l));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /extra: none/);
  assert.strictEqual(await recheck(r), NAME, 'now the same');
  assert.strictEqual(r.count('rm', '-f'), 1);
});

test('3. a running idle box with an extra folder is made again; the log says extra', async () => {
  const r = rig();
  r.binds = [...r.binds, r.other];
  await recheck(r);
  assert.strictEqual(r.count('rm', '-f'), 1);
  assert.strictEqual(r.count('create'), 1);
  assert.ok(r.logs.some(l => /extra: /.test(l) && l.includes(r.other)));
  assert.ok(!r.binds.includes(r.other));
});

async function heldCase(label, setup) {
  const r = rig();
  r.binds = [...r.binds, r.other];
  const opts = {};
  const done = await setup(r, opts);
  await assert.rejects(() => recheck(r, opts), (e) => e.code === 'EBOXHELD' && e.message.includes(r.other), `${label}: refused`);
  await assert.rejects(() => recheck(r, opts), (e) => e.code === 'EBOXHELD');
  assert.strictEqual(r.count('rm'), 0, `${label}: nothing removed`);
  assert.strictEqual(r.count('create'), 0);
  const items = heldOf(r);
  assert.strictEqual(items.length, 1, `${label}: one readiness item`);
  assert.strictEqual(items[0].level, 'warn');
  assert.match(items[0].title, /alpha/);
  assert.strictEqual(r.logs.filter(l => /^warning:/.test(l)).length, 1, `${label}: warned once`);
  if (done) await done();
  // idle now: the next recheck rebuilds and the item goes
  r.top = IDLE_TOP;
  assert.strictEqual(await recheck(r), NAME);
  assert.strictEqual(r.count('rm', '-f'), 1, `${label}: rebuilt once idle`);
  assert.deepStrictEqual(heldOf(r), []);
}
test('4a. busy by another process in top, extra folder: held, warned once, rebuilt when idle', () => heldCase('top', (r) => { r.top = BUSY_TOP; }));
test('4b. busy by an exec in flight, extra folder', () => heldCase('exec', async (r) => {
  let release; r.execGate = new Promise(res => { release = res; });
  const running = r.sb.exec(alpha, 'sleep 5');
  for (let i = 0; i < 50 && !r.execStarted; i++) await new Promise(res => setImmediate(res));
  assert.strictEqual(r.execStarted, 1);
  return async () => { release(); await running; };
}));
test('4c. busy by the busy() callback, extra folder', () => heldCase('busy()', (r, opts) => { let b = true; opts.busy = () => b; r.flip = () => { b = false; }; return async () => { r.flip(); }; }));
test('4d. top fails, extra folder: counts as busy', () => heldCase('top throws', (r) => { r.top = new Error('docker top failed'); }));
test('4e. busy() that throws counts as busy', () => heldCase('busy throws', (r, opts) => { let t = true; opts.busy = () => { if (t) throw new Error('x'); return false; }; return async () => { t = false; }; }));

test('5. busy with only a missing folder: used as it is, no rm, no readiness item, logged once', async () => {
  const r = rig();
  fs.mkdirSync(r.root2);
  r.top = BUSY_TOP;
  assert.strictEqual(await recheck(r), NAME);
  assert.strictEqual(await recheck(r), NAME);
  assert.strictEqual(r.count('rm'), 0);
  assert.deepStrictEqual(heldOf(r), []);
  const lines = r.logs.filter(l => /lacks folders/.test(l));
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /node server\.js/);
});

test('6. job start: an extra folder is refused without top or rm; only missing, or the same folders, start', async () => {
  const r = rig();
  r.binds = [...r.binds, r.other];
  await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), (e) => e.code === 'EBOXHELD' && /background jobs/.test(e.message));
  assert.strictEqual(r.count('top') + r.count('rm'), 0);
  const m = rig();
  fs.mkdirSync(m.root2);
  assert.strictEqual(await m.sb.ensure(alpha, { jobStart: true }), NAME);
  assert.strictEqual(m.count('top') + m.count('rm'), 0);
  const s = rig();
  assert.strictEqual(await s.sb.ensure(alpha, { jobStart: true }), NAME);
});

test('7. folders that cannot be read: no new turn hands and no new job in that box (review r1), nothing removed, logged once', async () => {
  const r = rig();
  r.mountsError = true;
  await assert.rejects(() => recheck(r), (e) => e.code === 'EBOXUNCHECKED');
  await assert.rejects(() => recheck(r), (e) => e.code === 'EBOXUNCHECKED');
  await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), (e) => e.code === 'EBOXUNCHECKED');
  assert.strictEqual(r.count('rm') + r.count('top') + r.count('stop'), 0, 'running work is left alone');
  assert.strictEqual(r.logs.filter(l => /could not check its folders/.test(l)).length, 1);
  assert.strictEqual(await r.sb.ensure(alpha), NAME, 'a plain ensure (a command of a turn already under way) is as before');
  // a box held for an extra folder stays closed while its folders can't be read
  const h = rig();
  h.binds = [...h.binds, h.other];
  h.top = BUSY_TOP;
  await assert.rejects(() => recheck(h), (e) => e.code === 'EBOXHELD');
  h.mountsError = true;
  await assert.rejects(() => recheck(h), (e) => e.code === 'EBOXUNCHECKED');
  await assert.rejects(() => h.sb.ensure(alpha, { jobStart: true }), (e) => e.code === 'EBOXUNCHECKED');
  // Docker answers again: checked as usual, and the log line can come back next time
  r.mountsError = false;
  assert.strictEqual(await recheck(r), NAME);
  r.mountsError = true;
  await assert.rejects(() => recheck(r), (e) => e.code === 'EBOXUNCHECKED');
  assert.strictEqual(r.logs.filter(l => /could not check its folders/.test(l)).length, 2);
});

test('7b. only the box\'s own init and keep-alive count as idle (review r1): look-alike names, copies and an empty list are work', async () => {
  const cases = [
    ['PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n9 python3 /work/train.py --output /work/tini-results\n', 'python3 /work/train.py'],
    ['PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n8 /work/tini --serve\n', '/work/tini'],
    ['PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n8 sleep infinity\n', 'sleep infinity'],
    ['PID ARGS\n', 'Docker listed nothing'],
    ['PID ARGS\n1 /sbin/docker-init -- docker-entrypoint.sh sleep infinity\n', 'unexpected process list'],
    ['PID ARGS\n7 sleep infinity\n', 'unexpected process list'],
    ['PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n9 bash -c x\u001b[31mred\n', 'bash -c x [31mred'],
  ];
  for (const [top, holder] of cases) {
    const r = rig();
    r.binds = [...r.binds, r.other];
    r.top = top;
    await assert.rejects(() => recheck(r), (e) => e.code === 'EBOXHELD', holder);
    assert.strictEqual(r.count('rm') + r.count('stop'), 0, `${holder}: nothing killed`);
    assert.ok(r.sb.readinessItems()[0].detail.includes(holder), `${holder}: named on Status`);
    assert.ok(!/[\u0000-\u001f]/.test(r.sb.readinessItems()[0].detail), 'no control characters');
  }
  // idle boxes: what Docker really shows for one made with --init from the sandbox image (taken from a real box), and
  // tini as the init: rebuilt
  for (const top of [
    'PID                 COMMAND\n2885964             /sbin/docker-init -- docker-entrypoint.sh sleep infinity\n2885978             sleep infinity\n',
    'PID ARGS\n1 /sbin/tini -- sleep infinity\n7 sleep infinity\n',
  ]) {
    const r = rig();
    r.binds = [...r.binds, r.other];
    r.top = top;
    assert.strictEqual(await recheck(r), NAME);
    assert.strictEqual(r.count('rm', '-f'), 1, top);
  }
  // an agent's own entrypoint-looking command is still work
  const w = rig();
  w.binds = [...w.binds, w.other];
  w.top = 'PID ARGS\n1 /sbin/docker-init -- docker-entrypoint.sh sleep infinity\n7 sleep infinity\n9 docker-entrypoint.sh sleep infinity\n';
  await assert.rejects(() => recheck(w), (e) => e.code === 'EBOXHELD');
});

test('8. two concurrent rechecks on an idle drifted box: one rm -f and one create', async () => {
  const r = rig();
  fs.mkdirSync(r.root2);
  const [a, b] = await Promise.all([recheck(r), recheck(r)]);
  assert.strictEqual(a, NAME); assert.strictEqual(b, NAME);
  assert.strictEqual(r.count('rm', '-f'), 1);
  assert.strictEqual(r.count('create'), 1);
});

test('9. a recheck that arrives while a plain ensure is in flight still does its own check', async () => {
  const r = rig();
  fs.mkdirSync(r.root2);
  let release; r.statusGate = new Promise(res => { release = res; });
  const plain = r.sb.ensure(alpha);
  const checked = recheck(r);
  await new Promise(res => setImmediate(res));
  assert.strictEqual(r.count('rm'), 0, 'waits for the plain one');
  release();
  await Promise.all([plain, checked]);
  assert.strictEqual(r.count('rm', '-f'), 1);
  assert.strictEqual(r.count('create'), 1);
});

test('10. wiring: handsForTurn rechecks, boxFor starts jobs, the chat notice names the held box', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /await sb\.ensure\(agent, \{ recheck: true, busy: \(\) => temporalWorkers\.listVirtual\(\)\.some\(v => v && v\.parent === agent\.name\) \}\)/);
  assert.match(src, /const name = await sb\.ensure\(agent, \{ jobStart: true \}\);/);
  assert.ok(!/sb\.ensure\(agent\)/.test(src), 'no plain ensure left at the two call sites');
  const start = src.indexOf('function sandboxWithheldNotice');
  const end = src.indexOf('\n}\n', start);
  const notice = new Function('process', src.slice(start, end + 2) + '\nreturn sandboxWithheldNotice;')(process);
  assert.match(notice('EBOXHELD'), /a folder it may no longer use/);
  assert.match(notice('EBOXHELD'), /Settings → Status/);
  assert.doesNotMatch(notice('EBOXHELD'), /Docker/);
});

test('11. readiness shows the sandbox items', async () => {
  const item = { id: 'sandbox-held-x', level: 'warn', title: 't', detail: 'd', fix: 'f' };
  const r = await createReadiness({
    platform: 'linux', sandboxItems: () => [item], hasUsers: () => true, listUsers: () => [], setupNeeded: () => false,
    agents: async () => [], sandboxStatus: async () => ({ docker: true, imageReady: true }),
    fetchStatus: async () => ({ renderer: true, pdftotext: true }), searchChain: () => ['duckduckgo'], supervisor: () => 'systemd',
  }).check();
  const got = r.items.find(i => i.id === 'sandbox-held-x');
  assert.ok(got); assert.strictEqual(got.level, 'warn');
  const none = await createReadiness({ platform: 'linux', agents: async () => [], sandboxStatus: async () => ({ docker: true, imageReady: true }) }).check();
  assert.ok(!none.items.some(i => /^sandbox-held-/.test(i.id)));
});

test('12. a held box that is removed, or made again by another path, no longer shows on Status', async () => {
  const r = rig();
  r.binds = [...r.binds, r.other];
  r.top = BUSY_TOP;
  await assert.rejects(() => recheck(r), (e) => e.code === 'EBOXHELD');
  assert.strictEqual(heldOf(r).length, 1);
  await r.sb.remove(alpha);   // the settings page removes the box when the agent's folders change
  assert.deepStrictEqual(heldOf(r), []);
  // held again, then the box disappears and a plain ensure (a job, a command) makes a new one
  r.state = 'running'; r.binds = [...r.sb.mountsFor(alpha), r.other];
  await assert.rejects(() => recheck(r), (e) => e.code === 'EBOXHELD');
  assert.strictEqual(heldOf(r).length, 1);
  r.state = null;
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  assert.deepStrictEqual(heldOf(r), []);
});
