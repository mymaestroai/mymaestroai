'use strict';
// Whose box it is (lib/sandbox: identity, imageId, labelsFor, ownerOf, startBox, stop, remove, retire): every box this
// install makes carries labels (install id, data folder hash, settings hash); another copy's box is never touched.
// A docker stand-in models boxes by name and records every call; nothing here reaches a real Docker.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSandbox } = require('../lib/sandbox');

const IDLE_TOP = 'PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n';
const BUSY_TOP = 'PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n42 node server.js\n';
const alpha = { name: 'alpha', model: 'claude-sdk/claude-haiku-5-5', owner: 'owner1' };
const NAME = 'hub-agent-alpha';
const IMG1 = 'sha256:' + 'a'.repeat(64);
const IMG2 = 'sha256:' + 'b'.repeat(64);
const OTHER_INSTALL = 'c'.repeat(32);
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const noSuch = (name) => Object.assign(new Error(`docker failed`), { stderr: `Error response from daemon: No such container: ${name}`, code: 1 });
// What a Docker stand-in must answer since homes are labelled volumes: whose a volume is (volume inspect), making one
// (volume create keeps the labels of a volume that exists, like Docker), the home a box mounts, and the throwaway
// containers that move a home. `vols`: volume -> labels object or null (made without labels).
const labelsIn = (args) => { const l = {}; args.forEach((x, i) => { if (args[i - 1] === '--label') { const j = String(x).indexOf('='); l[String(x).slice(0, j)] = String(x).slice(j + 1); } }); return l; };
const { homeVolumeFor } = require('../lib/sandbox');
const noVolume = (v) => Object.assign(new Error(`Command failed: docker volume inspect ${v}`), { stderr: `Error response from daemon: get ${v}: no such volume` });
// the name of this install's labelled home for an agent: <older name>-<12 hex of the install id and data folder>
const labelledHomeOf = async (sb, agent) => { const l = (await sb.labelsFor(agent)).labels; return `${homeVolumeFor(agent)}-${crypto.createHash('sha256').update(`${l['agent-hub.install']}\n${l['agent-hub.home']}`).digest('hex').slice(0, 12)}`; };
// the labels of a home volume this install made for the agent
const oursOf = async (sb, agent) => { const l = (await sb.labelsFor(agent)).labels; return { 'agent-hub': 'home', 'agent-hub.agent': agent.name, 'agent-hub.install': l['agent-hub.install'], 'agent-hub.home': l['agent-hub.home'] }; };
// labelled: async (box id or name) => the labelled home of the agent a seeded box belongs to (a box made before the test, with today's settings)
function volumeStandIn(labelled, vols = {}) {
  const v = new Map(Object.entries(vols));
  const homeOf = new Map();   // box name -> the volume its create mounted as /home/agent
  const answer = async (args) => {
    if (args[0] === 'create') { const n = args[args.indexOf('--name') + 1]; const h = args.find((x, i) => args[i - 1] === '-v' && String(x).endsWith(':/home/agent')); if (h) homeOf.set(n, h.slice(0, -':/home/agent'.length)); return undefined; }
    if (args[0] === 'volume' && args[1] === 'inspect' && args[2] === '--format' && args[3] === '{{json .Labels}}') { if (!v.has(args[4])) throw noVolume(args[4]); return { stdout: JSON.stringify(v.get(args[4])) + '\n', stderr: '' }; }
    if (args[0] === 'volume' && args[1] === 'create') { const n = args[args.length - 1]; if (!v.has(n)) v.set(n, labelsIn(args)); return { stdout: n + '\n', stderr: '' }; }
    if (args[0] === 'inspect' && args.some(x => String(x).includes('{{range .Mounts}}{{if eq .Type "volume"}}'))) { const n = args[args.length - 1]; return { stdout: `/home/agent=${homeOf.get(n) || await labelled(n)}\n`, stderr: '' }; }
    if (args[0] === 'run' && args.includes('--rm') && String(args[args.indexOf('--name') + 1]).startsWith('hub-home-move-')) return { stdout: args.some(x => String(x).startsWith('set -o pipefail; cd "$0"')) ? 'h\n1\n' : '', stderr: '' };
    return undefined;
  };
  return { vols: v, homeOf, answer };
}

// boxes: name -> { state: 'running'|'exited'|null, labels: object|null, binds: [...] }
function rig(o = {}) {
  const dir = tmp('bl-');
  const r = { dir, calls: [], logs: [], boxes: new Map(), imageId: IMG1, top: IDLE_TOP, labelsError: false, settings: {}, t: 1700000000000 };
  const live = (name) => { const b = r.boxes.get(name); return b && b.state ? b : null; };
  // a reference is a box's id (b.id, when the test gave one) or its name; a box with no id of its own has its name as id
  const find = (ref) => {
    for (const [k, b] of r.boxes) if (b.state && b.id === ref) return [k, b];
    const b = live(ref);
    return b ? [ref, b] : null;
  };
  // a box's home volume: the one its create mounted, or (a box seeded before the test, with today's settings) the labelled home of the sandbox that made it
  const vs = volumeStandIn(async (ref) => { const f = find(ref); return (f && f[1].home) || labelledHomeOf(r.sb, alpha); });
  r.vs = vs;
  r.onLabels = null;   // runs once, right after the labels of a box were answered (a test swaps the box there)
  r.docker = async (args) => {
    r.calls.push(args);
    const cmd = args[0];
    const vAnswer = await vs.answer(args); if (vAnswer) return vAnswer;
    if (cmd === 'image') {
      if (args.includes('--format')) return { stdout: r.imageId + '\n', stderr: '' };
      return { stdout: '[]', stderr: '' };
    }
    if (cmd === 'version') return { stdout: '27.0.0\n', stderr: '' };
    if (cmd === 'inspect' || (cmd === 'container' && args[1] === 'inspect')) {
      const fmt = String(args[args.indexOf('--format') + 1]);
      const name = args[args.length - 1];
      if (args.includes('--type')) {
        if (r.labelsError) throw new Error('Cannot connect to the Docker daemon');
        const f = find(name); if (!f) throw noSuch(name);
        const out = `${f[1].id || f[0]} ${JSON.stringify(f[1].labels)}\n`;   // null labels -> 'null'
        if (r.onLabels) { const fn = r.onLabels; r.onLabels = null; fn(); }
        return { stdout: out, stderr: '' };
      }
      const f = find(name); if (!f) throw noSuch(name);
      const b = f[1];
      if (fmt.includes('.Mounts')) return { stdout: b.binds.slice().sort().map(x => `${x}\n`).join(''), stderr: '' };
      if (fmt.includes('.HostConfig.Init')) return { stdout: (b.init === false ? 'false' : 'true') + '\n', stderr: '' };
      if (fmt.includes('.State.Status')) return { stdout: b.state + '\n', stderr: '' };
      if (fmt.includes('.Image')) return { stdout: (b.image || r.imageId) + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'top') return { stdout: r.top, stderr: '' };
    if (cmd === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const labels = {}, binds = [];
      args.forEach((x, i) => {
        if (args[i - 1] === '--label') { const k = String(x).indexOf('='); labels[String(x).slice(0, k)] = String(x).slice(k + 1); }
        if (args[i - 1] === '-v' && String(x).startsWith('/')) binds.push(String(x).split(':')[0]);
      });
      r.boxes.set(name, { state: 'created', labels, binds, image: args[args.length - 1] });
      return { stdout: 'id\n', stderr: '' };
    }
    if (cmd === 'start') { const f = find(args[args.length - 1]); if (!f) throw noSuch(args[args.length - 1]); f[1].state = 'running'; return { stdout: '', stderr: '' }; }
    if (cmd === 'stop') { const f = find(args[args.length - 1]); if (f) f[1].state = 'exited'; return { stdout: '', stderr: '' }; }
    if (cmd === 'rm') {
      const ref = args[args.length - 1], f = find(ref);
      if (!f) throw noSuch(ref);
      if (!args.includes('-f') && f[1].state === 'running') throw Object.assign(new Error('docker failed'), { stderr: 'Error response from daemon: You cannot remove a running container', code: 1 });
      r.boxes.delete(f[0]);
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };   // exec, volume rm, ps, unpause ...
  };
  r.mk = (over = {}) => createSandbox({
    docker: r.docker, uid: 1000, gid: 1000, image: 'sandbox-image:test', log: (...a) => r.logs.push(a.join(' ')), now: () => r.t,
    getSetting: (k) => r.settings[k], isMemberOwned: () => true,
    rootsFor: () => [], workspaceFor: (a) => path.join(r.dir, 'workspaces', a.name),
    pauseRecord: path.join(r.dir, 'no-pause.json'),
    dataDir: path.join(r.dir, 'data'), ...over,
  });
  r.dataDir = path.join(dir, 'data');
  r.sb = r.mk(o.sandbox || {});
  r.box = (state, labels, binds, name = NAME) => r.boxes.set(name, { state, labels, binds: binds || r.sb.mountsFor(alpha) });
  // a box this install made with today's settings
  r.ours = async (state = 'running', sb = r.sb) => { r.box(state, (await sb.labelsFor(alpha)).labels, sb.mountsFor(alpha)); r.boxes.get(NAME).home = await labelledHomeOf(sb, alpha); };
  r.count = (c, flag) => r.calls.filter(a => a[0] === c && (!flag || a.includes(flag))).length;
  r.has = (...cs) => r.calls.filter(a => cs.includes(a[0]));
  r.plainRm = () => r.calls.filter(a => a[0] === 'rm' && !a.includes('-f')).length;
  r.mark = () => r.calls.length;
  r.since = (n) => r.calls.slice(n);
  return r;
}
const recheck = (r, sb = r.sb, extra = {}) => sb.ensure(alpha, { recheck: true, ...extra });
const MUTATING = ['stop', 'rm', 'start', 'exec', 'create', 'unpause', 'volume', 'run'];
const touched = (calls) => calls.filter(a => MUTATING.includes(a[0]));
const onlyInspectTop = (calls) => calls.filter(a => a[0] !== 'inspect' && a[0] !== 'top' && a[0] !== 'image');
const code = (c) => (e) => e.code === c;
const creates = (r) => r.calls.filter(a => a[0] === 'create');
const labelOf = (createArgs, key) => { const x = createArgs.find(a => String(a).startsWith(`${key}=`)); return x && String(x).slice(key.length + 1); };

test('1. install id: made once at the first create, 32 hex, mode 0600; a second sandbox on the same dataDir reuses it', async () => {
  const r = rig();
  const file = path.join(r.dataDir, 'install-id');
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  const id = fs.readFileSync(file, 'utf8').trim();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(creates(r).length, 1);
  assert.strictEqual(labelOf(creates(r)[0], 'agent-hub.install'), id);
  r.boxes.delete(NAME);
  const sb2 = r.mk();
  assert.strictEqual(await sb2.ensure(alpha), NAME);
  assert.strictEqual(creates(r).length, 2);
  assert.strictEqual(labelOf(creates(r)[1], 'agent-hub.install'), id);
  assert.strictEqual(fs.readFileSync(file, 'utf8').trim(), id, 'file unchanged');
});

test('2. a malformed install-id file: ensure rejects EINSTALLID, nothing created, the file untouched', async () => {
  const r = rig();
  fs.mkdirSync(r.dataDir, { recursive: true });
  const file = path.join(r.dataDir, 'install-id');
  fs.writeFileSync(file, 'not-an-id');
  await assert.rejects(() => r.sb.ensure(alpha), code('EINSTALLID'));
  await assert.rejects(() => recheck(r), code('EINSTALLID'));
  assert.strictEqual(r.count('create'), 0);
  assert.deepStrictEqual(touched(r.calls), []);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'not-an-id');
});

test('3. create carries install, home, args, agent-hub and agent labels; the last argument is the image id', async () => {
  const r = rig();
  await r.sb.ensure(alpha);
  const c = creates(r);
  assert.strictEqual(c.length, 1);
  const a = c[0];
  assert.deepStrictEqual(a.slice(0, 3), ['create', '--name', NAME]);
  assert.strictEqual(labelOf(a, 'agent-hub'), 'sandbox');
  assert.strictEqual(labelOf(a, 'agent-hub.agent'), 'alpha');
  assert.strictEqual(labelOf(a, 'agent-hub.install'), fs.readFileSync(path.join(r.dataDir, 'install-id'), 'utf8').trim());
  assert.strictEqual(labelOf(a, 'agent-hub.home'), sha(fs.realpathSync(r.dataDir)));
  assert.match(labelOf(a, 'agent-hub.args'), /^[0-9a-f]{64}$/);
  assert.strictEqual(a[a.length - 1], IMG1);
  assert.notStrictEqual(a[a.length - 1], 'sandbox-image:test');
  assert.ok(!a.includes('sandbox-image:test'), 'the tag is not an argument at all');
  assert.strictEqual(r.boxes.get(NAME).labels['agent-hub.args'], labelOf(a, 'agent-hub.args'));
  assert.strictEqual((await r.sb.labelsFor(alpha)).labels['agent-hub.args'], labelOf(a, 'agent-hub.args'));
});

test('4. the args label follows sandboxMemory, the image id and the network; equal when nothing changes', async () => {
  const r = rig();
  const args = async (a = alpha) => (await r.sb.labelsFor(a)).labels['agent-hub.args'];
  const base = await args();
  assert.strictEqual(await args(), base, 'nothing changed');
  r.settings.sandboxMemory = '8g';
  const mem = await args();
  assert.notStrictEqual(mem, base, 'memory');
  r.settings.sandboxMemory = undefined;
  assert.strictEqual(await args(), base, 'memory back');
  r.imageId = IMG2; r.t += 61000;
  const img = await args();
  assert.notStrictEqual(img, base, 'image id');
  assert.notStrictEqual(img, mem);
  r.imageId = IMG1; r.t += 61000;
  assert.strictEqual(await args(), base, 'image back');
  const none = await args({ ...alpha, model: 'other-provider/some-model' });
  assert.notStrictEqual(none, base, 'network none vs bridge');
  assert.strictEqual(await args({ ...alpha, model: 'claude-sdk/other-model' }), base, 'another bridge model: equal');
});

test('5. the image id is cached for 60 s by now(), then asked again', async () => {
  const r = rig();
  const asks = () => r.calls.filter(a => a[0] === 'image' && a[1] === 'inspect' && a.includes('--format') && a.includes('{{.Id}}')).length;
  await r.sb.ensure(alpha);
  assert.strictEqual(asks(), 1);
  assert.deepStrictEqual(r.calls.find(a => a[0] === 'image'), ['image', 'inspect', '--format', '{{.Id}}', 'sandbox-image:test']);
  await recheck(r);
  await r.sb.labelsFor(alpha);
  r.t += 59000;
  await recheck(r);
  assert.strictEqual(asks(), 1, 'within 60 s');
  r.t += 2000;
  await recheck(r);
  assert.strictEqual(asks(), 2, 'after 61 s');
});

test('6. a running box that is ours, same folders: returned as it is, no stop, rm, create or top', async () => {
  const r = rig();
  await r.ours('running');
  const m = r.mark();
  assert.strictEqual(await recheck(r), NAME);
  const made = r.since(m);
  assert.deepStrictEqual(made.filter(a => ['stop', 'rm', 'create', 'top', 'start'].includes(a[0])), []);
  assert.ok(made.some(a => a[0] === 'inspect' && a.includes('--type')), 'its labels were read');
});

test('7. ours but made with other settings (memory, or image), idle: one stop, one rm -f, one create; logged as needing a rebuild', async () => {
  for (const change of [(r) => { r.settings.sandboxMemory = '8g'; }, (r) => { r.imageId = IMG2; r.t += 61000; }]) {
    const r = rig();
    await r.ours('running');
    change(r);
    const m = r.mark();
    assert.strictEqual(await recheck(r), NAME);
    const made = r.since(m);
    assert.strictEqual(made.filter(a => a[0] === 'stop').length, 1);
    assert.strictEqual(made.filter(a => a[0] === 'rm').length, 1);
    assert.strictEqual(made.filter(a => a[0] === 'rm' && a.includes('-f')).length, 1);
    assert.strictEqual(made.filter(a => a[0] === 'create').length, 1);
    assert.ok(r.logs.some(l => /alpha/.test(l) && /needs to be rebuilt/.test(l)), r.logs.join('\n'));
    const c = made.find(a => a[0] === 'create');
    assert.strictEqual(c[c.length - 1], r.imageId);
    assert.strictEqual(labelOf(c, 'agent-hub.args'), (await r.sb.labelsFor(alpha)).labels['agent-hub.args']);
    assert.strictEqual(await recheck(r), NAME, 'now ours again');
    assert.strictEqual(r.count('rm', '-f'), 1);
  }
});

test('8. ours but stale and busy: EBOXHELD, nothing stopped, removed or created; Status item; job start refused too', async () => {
  const cases = [
    ['top', (r) => { r.top = BUSY_TOP; }, {}],
    ['busy()', () => {}, { busy: () => true }],
  ];
  for (const [label, setup, extra] of cases) {
    const r = rig();
    await r.ours('running');
    r.settings.sandboxMemory = '8g';
    setup(r);
    const m = r.mark();
    await assert.rejects(() => recheck(r, r.sb, extra), code('EBOXHELD'), label);
    await assert.rejects(() => recheck(r, r.sb, extra), code('EBOXHELD'), label);
    await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), code('EBOXHELD'), label);
    assert.deepStrictEqual(touched(r.since(m)), [], `${label}: no stop/rm/create/start/exec`);
    const item = r.sb.readinessItems().find(i => i.id === 'sandbox-held-alpha');
    assert.ok(item, `${label}: Status item`);
    assert.ok(item.detail.includes('needs to be rebuilt'), item.detail);
    assert.strictEqual(r.sb.readinessItems().filter(i => i.id.startsWith('sandbox-foreign-')).length, 0);
  }
  // idle again: rebuilt and the item goes
  const r = rig();
  await r.ours('running');
  r.settings.sandboxMemory = '8g';
  r.top = BUSY_TOP;
  await assert.rejects(() => recheck(r), code('EBOXHELD'));
  r.top = IDLE_TOP;
  assert.strictEqual(await recheck(r), NAME);
  assert.strictEqual(r.count('rm', '-f'), 1);
  assert.deepStrictEqual(r.sb.readinessItems(), []);
});

test('9. another install\'s box is never touched: recheck, job start, stopped plain ensure, stop, remove, retire', async () => {
  const r = rig();
  fs.mkdirSync(path.join(r.dir, 'retire'));
  const retireDir = path.join(r.dir, 'retire');
  await r.sb.labelsFor(alpha);   // the install id exists
  r.box('running', { 'agent-hub': 'sandbox', 'agent-hub.agent': 'alpha', 'agent-hub.install': OTHER_INSTALL, 'agent-hub.home': sha('/elsewhere/data'), 'agent-hub.args': 'f'.repeat(64) });
  const m = r.mark();
  await assert.rejects(() => recheck(r), code('EBOXFOREIGN'));
  await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), code('EBOXFOREIGN'));
  r.boxes.get(NAME).state = 'exited';
  await assert.rejects(() => r.sb.ensure(alpha), code('EBOXFOREIGN'));
  await assert.rejects(() => r.sb.stop(alpha), code('EBOXFOREIGN'));
  await assert.rejects(() => r.sb.remove(alpha, { home: true }), code('EBOXFOREIGN'));
  assert.deepStrictEqual(touched(r.since(m)), [], 'no stop, rm, start, exec, create, unpause, volume, run at all');
  assert.deepStrictEqual(r.since(m).filter(a => a[0] === 'top'), []);
  const item = r.sb.readinessItems().find(i => i.id === 'sandbox-foreign-alpha');
  assert.ok(item, 'Status item');
  assert.ok(item.detail.includes(NAME) && item.title.includes('alpha'));
  assert.strictEqual(r.boxes.get(NAME).state, 'exited');
  const m2 = r.mark();
  const res = await r.sb.retire(alpha, retireDir);
  assert.ok(/^left:/.test(res.result), res.result);
  assert.deepStrictEqual(r.since(m2).filter(a => ['rm', 'volume', 'run', 'stop', 'create', 'start'].includes(a[0])), []);
  assert.deepStrictEqual(fs.readdirSync(retireDir), [], 'nothing written into the bundle folder');
  assert.ok(r.boxes.get(NAME), 'the box is still there');
});

test('10. same install id at another data folder: foreign to that copy (never touched), ours to the first', async () => {
  const r = rig();
  const dirB = path.join(r.dir, 'dataB');
  const sbA = r.mk({ dataDir: path.join(r.dir, 'dataA') });
  await r.ours('running', sbA);
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirB, 'install-id'), fs.readFileSync(path.join(r.dir, 'dataA', 'install-id')));
  const sbB = r.mk({ dataDir: dirB });
  const m = r.mark();
  await assert.rejects(() => recheck(r, sbB), code('EBOXFOREIGN'));
  await assert.rejects(() => sbB.ensure(alpha, { jobStart: true }), code('EBOXFOREIGN'));
  assert.deepStrictEqual(touched(r.since(m)), []);
  assert.ok(sbB.readinessItems().some(i => i.id === 'sandbox-foreign-alpha'));
  const m2 = r.mark();
  assert.strictEqual(await recheck(r, sbA), NAME);
  assert.deepStrictEqual(r.since(m2).filter(a => ['stop', 'rm', 'create', 'top'].includes(a[0])), []);
  assert.deepStrictEqual(sbA.readinessItems(), []);
});

const PROOF = { 'agent-hub': 'sandbox', 'agent-hub.agent': 'alpha' };   // what a box made before install labels carried

test('11. no install label, proved ours (agent-hub=sandbox, agent-hub.agent=alpha, its workspace bound): idle rebuilt, busy held, stopped made again with a plain rm; labels {} or null: foreign, untouched', async () => {
  for (const labels of [PROOF]) {
    const tag = JSON.stringify(labels);
    // running, idle
    let r = rig();
    r.box('running', labels);
    let m = r.mark();
    assert.strictEqual(await recheck(r), NAME, tag);
    let made = r.since(m);
    assert.strictEqual(made.filter(a => a[0] === 'stop').length, 1, tag);
    assert.strictEqual(made.filter(a => a[0] === 'rm' && a.includes('-f')).length, 1, tag);
    assert.strictEqual(made.filter(a => a[0] === 'create').length, 1, tag);
    assert.ok(labelOf(made.find(a => a[0] === 'create'), 'agent-hub.install'), 'the new box is labelled');
    // running, busy
    r = rig();
    r.box('running', labels);
    r.top = BUSY_TOP;
    m = r.mark();
    await assert.rejects(() => recheck(r), code('EBOXHELD'), tag);
    assert.deepStrictEqual(touched(r.since(m)), [], tag);
    assert.ok(r.sb.readinessItems().some(i => i.id === 'sandbox-held-alpha'), tag);
    // stopped, plain ensure
    r = rig();
    r.box('exited', labels);
    m = r.mark();
    assert.strictEqual(await r.sb.ensure(alpha), NAME, tag);
    made = r.since(m);
    assert.strictEqual(made.filter(a => a[0] === 'rm').length, 1, tag);
    assert.strictEqual(r.plainRm(), 1, 'plain rm, not -f');
    assert.strictEqual(made.filter(a => a[0] === 'create').length, 1, tag);
    assert.ok(made.findIndex(a => a[0] === 'rm') < made.findIndex(a => a[0] === 'create'));
    assert.strictEqual(made.filter(a => a[0] === 'stop').length, 0, tag);
  }
  // labels {} or null (with the right folders) prove nothing: foreign, whatever the state
  for (const labels of [{}, null]) {
    const tag = JSON.stringify(labels);
    for (const state of ['running', 'exited']) {
      const r = rig();
      r.box(state, labels);
      const m = r.mark();
      await assert.rejects(() => recheck(r), code('EBOXFOREIGN'), `${tag} ${state} recheck`);
      await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), code('EBOXFOREIGN'), `${tag} ${state} jobStart`);
      // a plain ensure checks a stopped box only (a running one is checked at a recheck or job start)
      if (state === 'exited') await assert.rejects(() => r.sb.ensure(alpha), code('EBOXFOREIGN'), `${tag} ${state} ensure`);
      assert.deepStrictEqual(touched(r.since(m)), [], tag);
      assert.ok(r.sb.readinessItems().some(i => i.id === 'sandbox-foreign-alpha'), tag);
      assert.strictEqual(r.boxes.get(NAME).state, state, tag);
    }
  }
});

test('12. no install label and a folder outside this hub\'s and the agent\'s: foreign, untouched', async () => {
  const r = rig();
  r.box('running', PROOF, [...r.sb.mountsFor(alpha), '/srv/other-copy/workspaces/alpha']);
  const m = r.mark();
  await assert.rejects(() => recheck(r), code('EBOXFOREIGN'));
  await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), code('EBOXFOREIGN'));
  assert.deepStrictEqual(onlyInspectTop(r.since(m)), []);
  assert.ok(r.sb.readinessItems().some(i => i.id === 'sandbox-foreign-alpha' && i.detail.includes('/srv/other-copy/workspaces/alpha')));
  r.boxes.get(NAME).state = 'exited';
  const m2 = r.mark();
  await assert.rejects(() => r.sb.ensure(alpha), code('EBOXFOREIGN'));
  assert.deepStrictEqual(touched(r.since(m2)), []);
});

test('13. ownRoots: a label-less box with an extra folder under one is stale (rebuilt when idle), not foreign', async () => {
  const someDir = path.join(tmp('bl-roots-'), 'mine');
  const extra = path.join(someDir, 'old-workspace');
  const r = rig({ sandbox: { ownRoots: () => [someDir] } });
  r.box('running', PROOF, [...r.sb.mountsFor(alpha), extra]);
  const m = r.mark();
  assert.strictEqual(await recheck(r), NAME);
  const made = r.since(m);
  assert.strictEqual(made.filter(a => a[0] === 'stop').length, 1);
  assert.strictEqual(made.filter(a => a[0] === 'rm' && a.includes('-f')).length, 1);
  assert.strictEqual(made.filter(a => a[0] === 'create').length, 1);
  assert.deepStrictEqual(r.sb.readinessItems(), []);
  assert.ok(!r.boxes.get(NAME).binds.includes(extra));
  // without that root the same box is foreign
  const d = rig();
  d.box('running', PROOF, [...d.sb.mountsFor(alpha), extra]);
  const m2 = d.mark();
  await assert.rejects(() => recheck(d), code('EBOXFOREIGN'));
  assert.deepStrictEqual(touched(d.since(m2)), []);
});

test('14. the labels inspect fails: EBOXUNCHECKED for recheck and job start, nothing stopped, removed or created', async () => {
  const r = rig();
  await r.ours('running');
  r.labelsError = true;
  const m = r.mark();
  await assert.rejects(() => recheck(r), code('EBOXUNCHECKED'));
  await assert.rejects(() => r.sb.ensure(alpha, { jobStart: true }), code('EBOXUNCHECKED'));
  assert.deepStrictEqual(touched(r.since(m)), []);
  assert.deepStrictEqual(r.since(m).filter(a => a[0] === 'top'), []);
  r.boxes.get(NAME).state = 'exited';
  const m2 = r.mark();
  await assert.rejects(() => r.sb.ensure(alpha), code('EBOXUNCHECKED'));
  await assert.rejects(() => r.sb.stop(alpha), code('EBOXUNCHECKED'));
  assert.deepStrictEqual(touched(r.since(m2)), []);
  r.labelsError = false;
  assert.strictEqual(await r.sb.ensure(alpha), NAME, 'Docker answers again');
});

test('15. a foreign box that is gone: the next recheck makes a new box and the Status item goes', async () => {
  const r = rig();
  await r.sb.labelsFor(alpha);
  r.box('running', { 'agent-hub.install': OTHER_INSTALL, 'agent-hub.home': 'x' });
  await assert.rejects(() => recheck(r), code('EBOXFOREIGN'));
  assert.ok(r.sb.readinessItems().some(i => i.id === 'sandbox-foreign-alpha'));
  r.boxes.set(NAME, { state: null, labels: null, binds: [] });
  const m = r.mark();
  assert.strictEqual(await recheck(r), NAME);
  const made = r.since(m);
  assert.strictEqual(made.filter(a => a[0] === 'create').length, 1);
  assert.strictEqual(made.filter(a => a[0] === 'rm' || a[0] === 'stop').length, 0);
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-foreign-alpha'));
  assert.strictEqual(labelOf(made.find(a => a[0] === 'create'), 'agent-hub.install'), (await r.sb.labelsFor(alpha)).labels['agent-hub.install']);
});

test('16. a stopped box that is ours with matching labels and folders: started, nothing removed or created', async () => {
  const r = rig();
  await r.ours('exited');
  const m = r.mark();
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  const made = r.since(m);
  assert.strictEqual(made.filter(a => a[0] === 'start').length, 1);
  assert.deepStrictEqual(made.filter(a => ['rm', 'create', 'stop', 'unpause'].includes(a[0])), []);
  assert.strictEqual(r.boxes.get(NAME).state, 'running');
});

const ID_A = 'c0ffee01', ID_B = 'badc0de2';
const refsOf = (calls, cmd) => calls.filter(a => a[0] === cmd).map(a => a[a.length - 1]);

test('17. id pinning: stop and rm (rebuild, sb.stop, sb.remove) go to the container id the labels check returned, never to the name', async () => {
  // idle stale box rebuilt
  let r = rig();
  await r.ours('running');
  r.boxes.get(NAME).id = ID_A;
  r.settings.sandboxMemory = '8g';
  let m = r.mark();
  assert.strictEqual(await recheck(r), NAME);
  let made = r.since(m);
  assert.deepStrictEqual(refsOf(made, 'stop'), [ID_A]);
  assert.deepStrictEqual(refsOf(made, 'rm'), [ID_A]);
  assert.ok(made.filter(a => a[0] === 'rm')[0].includes('-f'));
  assert.ok(!made.some(a => (a[0] === 'stop' || a[0] === 'rm') && a.includes(NAME)), 'no stop or rm names the box');
  assert.strictEqual(made.filter(a => a[0] === 'create').length, 1);
  // a stopped stale box: plain rm of the id
  r = rig();
  await r.ours('exited');
  r.boxes.get(NAME).id = ID_A;
  r.settings.sandboxMemory = '8g';
  m = r.mark();
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  made = r.since(m);
  assert.deepStrictEqual(refsOf(made, 'rm'), [ID_A]);
  assert.strictEqual(r.plainRm(), 1);
  // a stopped ours box is started by id
  r = rig();
  await r.ours('exited');
  r.boxes.get(NAME).id = ID_A;
  m = r.mark();
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  made = r.since(m);
  assert.deepStrictEqual(refsOf(made, 'start'), [ID_A]);
  // sb.stop and sb.remove on an ours box
  r = rig();
  await r.ours('running');
  r.boxes.get(NAME).id = ID_A;
  m = r.mark();
  await r.sb.stop(alpha);
  made = r.since(m);
  assert.deepStrictEqual(refsOf(made, 'stop'), [ID_A]);
  assert.strictEqual(r.boxes.get(NAME).state, 'exited', 'the stand-in mapped the id to the box');
  r = rig();
  await r.ours('running');
  r.boxes.get(NAME).id = ID_A;
  m = r.mark();
  await r.sb.remove(alpha);
  made = r.since(m);
  assert.deepStrictEqual(refsOf(made, 'stop'), [ID_A]);
  assert.deepStrictEqual(refsOf(made, 'rm'), [ID_A]);
  assert.ok(!made.some(a => (a[0] === 'stop' || a[0] === 'rm') && a.includes(NAME)));
  assert.ok(!r.boxes.has(NAME), 'the box is gone');
});

test('18. a box swapped under the same name between the check and the action: the action hits the checked id; the new box is never stopped or removed', async () => {
  const r = rig();
  await r.ours('running');
  r.boxes.get(NAME).id = ID_A;
  r.settings.sandboxMemory = '8g';   // stale: rebuilt when idle
  // right after the labels of box A were answered, another copy replaces the box under the same name
  r.onLabels = () => {
    r.boxes.set(NAME, { state: 'running', id: ID_B, binds: r.sb.mountsFor(alpha),
      labels: { 'agent-hub': 'sandbox', 'agent-hub.agent': 'alpha', 'agent-hub.install': OTHER_INSTALL, 'agent-hub.home': sha('/elsewhere/data'), 'agent-hub.args': 'f'.repeat(64) } });
  };
  const m = r.mark();
  try { await recheck(r); } catch { /* the rm of the gone id A may fail: nothing else matters here */ }
  const made = r.since(m);
  assert.ok(refsOf(made, 'rm').length >= 1, 'an rm was sent');
  assert.deepStrictEqual([...new Set(refsOf(made, 'rm'))], [ID_A], 'every rm targets A');
  assert.deepStrictEqual([...new Set(refsOf(made, 'stop'))].filter(x => x !== ID_A), [], 'every stop targets A');
  assert.ok(!made.some(a => (a[0] === 'stop' || a[0] === 'rm' || a[0] === 'start') && (a.includes(NAME) || a.includes(ID_B))), 'nothing names the box or B');
  const b = r.boxes.get(NAME);
  assert.ok(b && b.id === ID_B, 'box B is still there');
  assert.strictEqual(b.state, 'running', 'and never stopped');
});

test('19. no install label: ours only with positive proof (labels, agent name, own workspace bound, other folders its own or under ownRoots)', async () => {
  const root = tmp('bl-own-');
  const rigWith = () => rig({ sandbox: { ownRoots: () => [root] } });
  // (i) the proof: stale, rebuilt when idle
  let r = rigWith();
  r.box('running', PROOF);
  let m = r.mark();
  assert.strictEqual(await recheck(r), NAME);
  let made = r.since(m);
  assert.strictEqual(made.filter(a => a[0] === 'rm' && a.includes('-f')).length, 1);
  assert.strictEqual(made.filter(a => a[0] === 'create').length, 1);
  assert.deepStrictEqual(r.sb.readinessItems(), []);
  const foreign = async (label, labels, binds) => {
    const f = rigWith();
    f.box('running', labels, binds);
    const mk = f.mark();
    await assert.rejects(() => recheck(f), code('EBOXFOREIGN'), `${label} recheck`);
    await assert.rejects(() => f.sb.ensure(alpha, { jobStart: true }), code('EBOXFOREIGN'), `${label} jobStart`);
    f.boxes.get(NAME).state = 'exited';
    await assert.rejects(() => f.sb.ensure(alpha), code('EBOXFOREIGN'), `${label} stopped ensure`);
    await assert.rejects(() => f.sb.stop(alpha), code('EBOXFOREIGN'), `${label} stop`);
    await assert.rejects(() => f.sb.remove(alpha), code('EBOXFOREIGN'), `${label} remove`);
    assert.deepStrictEqual(touched(f.since(mk)), [], `${label}: no stop/rm/start/create/exec`);
    assert.ok(f.boxes.get(NAME), `${label}: still there`);
    assert.ok(f.sb.readinessItems().some(i => i.id === 'sandbox-foreign-alpha'), label);
  };
  // (ii) another agent's name in the label
  await foreign('agent=beta', { ...PROOF, 'agent-hub.agent': 'beta' }, undefined);
  // (iii) the right labels, no binds at all
  await foreign('no binds', PROOF, []);
  // (iv) the right labels, every bind under ownRoots, but not alpha's own workspace (a nested copy's)
  const nested = path.join(root, 'copy', 'app', 'workspaces', 'alpha');
  assert.notStrictEqual(nested, rigWith().sb.mountsFor(alpha)[0]);
  await foreign('nested copy workspace', PROOF, [nested]);
  // also: the agent-hub label missing or other
  await foreign('agent-hub label other', { ...PROOF, 'agent-hub': 'other' }, undefined);
});

test('20. a malformed install-id adds a Status item naming the file; a valid id and a successful ensure clear it', async () => {
  const r = rig();
  fs.mkdirSync(r.dataDir, { recursive: true });
  const file = path.join(r.dataDir, 'install-id');
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-install-id'), 'none before any try');
  fs.writeFileSync(file, 'not-an-id');
  await assert.rejects(() => r.sb.ensure(alpha), code('EINSTALLID'));
  const item = r.sb.readinessItems().find(i => i.id === 'sandbox-install-id');
  assert.ok(item, 'Status item');
  assert.ok(item.detail.includes(file), item.detail);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'not-an-id', 'never overwritten by the product');
  assert.strictEqual(r.count('create'), 0);
  // the operator fixes the file
  const good = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(file, good + '\n');
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-install-id'), 'item gone');
  assert.strictEqual(labelOf(creates(r)[0], 'agent-hub.install'), good);
});

test('21. retire: no box when it was checked, then another copy makes one under the name: it is never inspected or removed', async () => {
  const r = rig();
  let swapped = false;
  // the labels check finds no box; right after, another install's box appears under the same name
  const docker = async (args) => {
    try { return await r.docker(args); }
    catch (e) {
      if (!swapped && args[0] === 'inspect' && args.includes('--type')) {
        swapped = true;
        r.boxes.set(NAME, { state: 'running', id: 'feedbeef03', binds: [path.join(r.dir, 'workspaces', 'alpha')],
          labels: { 'agent-hub': 'sandbox', 'agent-hub.agent': 'alpha', 'agent-hub.install': OTHER_INSTALL, 'agent-hub.home': sha('/elsewhere/data'), 'agent-hub.args': 'f'.repeat(64) } });
      }
      throw e;
    }
  };
  const sb = r.mk({ docker });
  const into = tmp('bl-retire-');
  const m = r.mark();
  await sb.retire(alpha, into, { keepHome: true });   // the home volume is the next job's; this test is about the box
  assert.ok(swapped, 'the box appeared after the check');
  const after = r.since(m);
  assert.deepStrictEqual(after.filter(a => a[0] === 'rm' || a[0] === 'stop'), [], 'nothing stopped or removed');
  assert.deepStrictEqual(after.filter(a => a[0] === 'container' && a[1] === 'inspect'), [], 'the new box is not looked at');
  const b = r.boxes.get(NAME);
  assert.ok(b && b.id === 'feedbeef03' && b.state === 'running', 'the other copy\'s box is still there and running');
});
