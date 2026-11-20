'use strict';
// Agents' home folders (lib/sandbox-homes, and how lib/sandbox uses it): a labelled home volume per agent, an older
// unlabelled home moved into it only while rebuilding a box proved this hub's, a failed move falling back with a back-off,
// restarts part way, orphans, pruning, and removal / retire / sweep that never touch another copy's volume.
// A docker stand-in models boxes (id, name, state, labels, binds, home) and volumes (name -> labels | null, plus a `files`
// marker that tells copies apart); every call is recorded; nothing here reaches a real Docker.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { friendly } = require('../lib/timezone');
const { createSandbox, homeVolumeFor } = require('../lib/sandbox');
const { createHomes, sizeText } = require('../lib/sandbox-homes');

const IDLE_TOP = 'PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n';
const IMG1 = 'sha256:' + 'a'.repeat(64);
const alpha = { name: 'alpha', model: 'claude-sdk/claude-haiku-5-5', owner: 'owner1' };
const beta = { name: 'beta', model: 'claude-sdk/claude-haiku-5-5', owner: 'owner1' };
const NAME = 'hub-agent-alpha';
const OLDER = homeVolumeFor(alpha);           // the older (unlabelled) home's name
const OLD_ID = '0ld0ld01';
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const iso = (ms) => new Date(ms).toISOString();
const code = (c) => (e) => e.code === c;
const noSuchBox = (n) => Object.assign(new Error('docker failed'), { stderr: `Error response from daemon: No such container: ${n}`, code: 1 });
const noSuchVol = (n) => Object.assign(new Error('docker failed'), { stderr: `Error response from daemon: get ${n}: no such volume`, code: 1 });

// what a throwaway `docker run` is, from its arguments
function runKind(a) {
  const ei = a.indexOf('--entrypoint'), ep = ei < 0 ? '' : a[ei + 1];
  if (ep === 'tar') return 'tar';
  if (ep === 'sh') return 'sweep';
  const ci = a.indexOf('-c'), script = ci < 0 ? '' : String(a[ci + 1]);
  if (script.includes('tar --null')) return 'copy';
  if (script.startsWith('set -o pipefail; cd "$0"')) return 'manifest';
  if (script.includes('df -k --output=avail')) return 'space';
  if (script.includes('du -sk')) return 'size';
  if (script === 'set -o pipefail; find /home/agent -mindepth 1 -delete') return 'empty';
  return 'run?';
}
const mountsOf = (a) => a.filter((x, i) => a[i - 1] === '-v').map(String);

function rig() {
  const dir = tmp('vh-');
  const r = {
    dir, calls: [], logs: [], boxes: new Map(), volumes: new Map(), t: 1700000000000, top: IDLE_TOP, imageId: IMG1,
    copyFail: null, copyTimeout: false, differ: null, raceForeign: false, failures: [], onTar: null, installOf: null,
  };
  r.dataDir = path.join(dir, 'data');
  const find = (ref) => {
    for (const [k, b] of r.boxes) if (b.state && b.id === ref) return [k, b];
    const b = r.boxes.get(ref);
    return b && b.state ? [ref, b] : null;
  };
  // r.fail(pred, err): the next call matching pred throws err (Docker failing a given call)
  r.fail = (pred, err) => r.failures.push({ pred, err });
  r.docker = async (args) => {
    r.calls.push(args);
    const hit = r.failures.findIndex(f => f.pred(args));
    if (hit >= 0) throw r.failures.splice(hit, 1)[0].err;
    const cmd = args[0];
    if (cmd === 'image') return { stdout: args.includes('--format') ? r.imageId + '\n' : '[]', stderr: '' };
    if (cmd === 'version') return { stdout: '27.0.0\n', stderr: '' };
    if (cmd === 'volume') {
      const v = args[args.length - 1];
      if (args[1] === 'inspect') {
        const vol = r.volumes.get(v);
        if (!vol) throw noSuchVol(v);
        return { stdout: JSON.stringify(vol.labels) + '\n', stderr: '' };
      }
      if (args[1] === 'create') {
        if (r.raceForeign && !r.volumes.has(v)) r.volumes.set(v, { labels: { 'agent-hub': 'home', 'agent-hub.install': 'f'.repeat(32), 'agent-hub.home': 'x'.repeat(64) }, files: 'THEIRS' });
        if (!r.volumes.has(v)) {   // real Docker exits 0 when the name exists and keeps the old labels
          const labels = {};
          args.forEach((x, i) => { if (args[i - 1] === '--label') { const k = x.indexOf('='); labels[x.slice(0, k)] = x.slice(k + 1); } });
          r.volumes.set(v, { labels, files: '' });
        }
        return { stdout: v + '\n', stderr: '' };
      }
      if (args[1] === 'rm') {
        if (!r.volumes.has(v)) throw noSuchVol(v);
        r.volumes.delete(v);
        return { stdout: v + '\n', stderr: '' };
      }
    }
    if (cmd === 'inspect' || (cmd === 'container' && args[1] === 'inspect')) {
      const fmt = String(args[args.indexOf('--format') + 1]);
      const ref = args[args.length - 1];
      const f = find(ref);
      if (args.includes('--type') && fmt.includes('.Mounts')) {   // homes.homeOfBox
        if (!f) throw noSuchBox(ref);
        return { stdout: f[1].home ? `/home/agent=${f[1].home}\n` : '', stderr: '' };
      }
      if (args.includes('--type')) {
        if (!f) throw noSuchBox(ref);
        return { stdout: `${f[1].id || f[0]} ${JSON.stringify(f[1].labels)}\n`, stderr: '' };
      }
      if (!f) throw noSuchBox(ref);
      const b = f[1];
      if (fmt.includes('.Mounts')) return { stdout: b.binds.slice().sort().map(x => `${x}\n`).join(''), stderr: '' };
      if (fmt.includes('.HostConfig.Init')) return { stdout: 'true\n', stderr: '' };
      if (fmt.includes('.State.Status')) return { stdout: b.state + '\n', stderr: '' };
      if (fmt.includes('.Image')) return { stdout: (b.image || r.imageId) + '\n', stderr: '' };
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'top') return { stdout: r.top, stderr: '' };
    if (cmd === 'create') {
      const name = args[args.indexOf('--name') + 1];
      if (r.boxes.get(name) && r.boxes.get(name).state) throw Object.assign(new Error('docker failed'), { stderr: `Conflict. The container name "/${name}" is already in use`, code: 1 });
      const labels = {}, binds = [];
      let home = null;
      args.forEach((x, i) => {
        if (args[i - 1] === '--label') { const k = String(x).indexOf('='); labels[String(x).slice(0, k)] = String(x).slice(k + 1); }
        if (args[i - 1] === '-v') {
          if (String(x).startsWith('/')) binds.push(String(x).split(':')[0]);
          else if (String(x).endsWith(':/home/agent')) home = String(x).slice(0, -':/home/agent'.length);
        }
      });
      if (home && !r.volumes.has(home)) r.volumes.set(home, { labels: null, files: '' });   // -v makes a missing volume, unlabelled
      r.boxes.set(name, { state: 'created', labels, binds, home, image: args[args.length - 1] });
      return { stdout: 'id\n', stderr: '' };
    }
    if (cmd === 'start') { const f = find(args[args.length - 1]); if (!f) throw noSuchBox(args[args.length - 1]); f[1].state = 'running'; return { stdout: '', stderr: '' }; }
    if (cmd === 'stop') { const f = find(args[args.length - 1]); if (f) f[1].state = 'exited'; return { stdout: '', stderr: '' }; }
    if (cmd === 'rm') {
      const ref = args[args.length - 1], f = find(ref);
      if (!f) throw noSuchBox(ref);
      if (!args.includes('-f') && f[1].state === 'running') throw Object.assign(new Error('docker failed'), { stderr: 'Error response from daemon: You cannot remove a running container', code: 1 });
      r.boxes.delete(f[0]);
      return { stdout: '', stderr: '' };
    }
    if (cmd === 'run') {
      const kind = runKind(args), ms = mountsOf(args);
      const volOf = (suffix) => { const m = ms.find(x => x.endsWith(suffix)); return m ? m.slice(0, -suffix.length) : null; };
      if (kind === 'copy') {
        const from = volOf(':/from:ro'), to = volOf(':/home/agent');
        r.volumes.get(to).files = 'PARTIAL';
        if (r.copyTimeout) throw Object.assign(new Error('Command failed: timed out'), { killed: true });
        if (r.copyFail) throw r.copyFail;
        r.volumes.get(to).files = r.volumes.get(from).files;
        return { stdout: '', stderr: '' };
      }
      if (kind === 'manifest') {
        const v = volOf(':/m:ro'), files = r.volumes.get(v).files + (r.differ === v ? '+different' : '');
        return { stdout: `${sha(files)}\n${files.length}\n`, stderr: '' };
      }
      if (kind === 'empty') { r.volumes.get(volOf(':/home/agent')).files = ''; return { stdout: '', stderr: '' }; }
      if (kind === 'space') return { stdout: `${r.homeKB === undefined ? 2048 : r.homeKB}\n${r.freeKB === undefined ? 100 * 1024 * 1024 : r.freeKB}\n`, stderr: '' };
      if (kind === 'size') return { stdout: '2048\n', stderr: '' };
      if (kind === 'sweep') {
        const v = volOf(':/box-home'), vol = r.volumes.get(v);
        if (!vol) throw noSuchVol(v);
        const had = !!vol.creds; vol.creds = false;
        return { stdout: had ? 'removed\n' : '', stderr: '' };
      }
      if (kind === 'tar') {
        const out = args[args.indexOf('-cf') + 1], bundle = volOf(':/bundle');
        if (r.onTar) r.onTar();
        fs.writeFileSync(path.join(bundle, path.basename(out)), 'tar of ' + volOf(':/box-home:ro'));
        return { stdout: '', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
    return { stdout: '', stderr: '' };   // exec, ps ...
  };
  r.mk = (over = {}) => createSandbox({
    docker: r.docker, uid: 1000, gid: 1000, image: 'sandbox-image:test', log: (...a) => r.logs.push(a.join(' ')), now: () => r.t,
    getSetting: () => undefined, isMemberOwned: () => true,
    rootsFor: () => [], workspaceFor: (a) => path.join(r.dir, 'workspaces', a.name),
    pauseRecord: path.join(r.dir, 'no-pause.json'),
    dataDir: r.dataDir, ...over,
  });
  r.sb = r.mk();
  // the install id exists after this; names and labels of this install's volumes follow from it
  r.ident = async () => {
    const l = (await r.sb.labelsFor(alpha)).labels;
    r.install = l['agent-hub.install']; r.hhome = l['agent-hub.home'];
    return r;
  };
  r.labFor = (agent) => `${homeVolumeFor(agent)}-${sha(`${r.install}\n${r.hhome}`).slice(0, 12)}`;
  r.ourLabels = (agent) => ({ 'agent-hub': 'home', 'agent-hub.agent': agent.name, 'agent-hub.install': r.install, 'agent-hub.home': r.hhome });
  r.foreignLabels = (agent) => ({ 'agent-hub': 'home', 'agent-hub.agent': agent.name, 'agent-hub.install': 'f'.repeat(32), 'agent-hub.home': 'e'.repeat(64) });
  r.vol = (name, labels = null, files = 'FILES:' + name) => { r.volumes.set(name, { labels, files }); return r.volumes.get(name); };
  // a box made before this change: labelled with this install, mounting the older unlabelled home
  r.old = async (state, extraBinds = [], id = OLD_ID) => {
    const labels = (await r.sb.labelsFor(alpha, null, OLDER)).labels;
    r.boxes.set(NAME, { state, id, labels, binds: [...r.sb.mountsFor(alpha), ...extraBinds], home: OLDER });
  };
  r.mark = () => r.calls.length;
  r.since = (n) => r.calls.slice(n);
  r.moves = () => { try { return JSON.parse(fs.readFileSync(path.join(r.dataDir, 'home-moves.json'), 'utf8')); } catch { return null; } };
  // records carry the install's id and data-folder hash (only this install's own are acted on); an entry that names its
  // own install/home keeps it (a record a copy carried over)
  r.stampOf = () => ({ install: fs.readFileSync(path.join(r.dataDir, 'install-id'), 'utf8').trim(), home: sha(fs.realpathSync(r.dataDir)) });
  r.writeMoves = (obj) => {
    fs.mkdirSync(r.dataDir, { recursive: true });
    const st = r.stampOf(), mark = (e) => (e && e.install ? e : { ...st, ...e });
    const o = { moves: {}, retired: [], orphans: [], failed: {}, ...obj };
    for (const k of ['moves', 'failed']) o[k] = Object.fromEntries(Object.entries(o[k]).map(([a, e]) => [a, mark(e)]));
    for (const k of ['retired', 'orphans']) o[k] = o[k].map(mark);
    fs.writeFileSync(path.join(r.dataDir, 'home-moves.json'), JSON.stringify(o));
  };
  return r;
}

// the calls that matter, in order
function seq(calls) {
  const out = [];
  for (const a of calls) {
    const c = a[0], last = a[a.length - 1];
    if (c === 'stop') out.push('stop:' + last);
    else if (c === 'rm') out.push(/^hub-home-move-/.test(last) ? 'killrm' : (a.includes('-f') ? 'rm-f:' : 'rm:') + last);
    else if (c === 'create') out.push('create');
    else if (c === 'start') out.push('start:' + last);
    else if (c === 'volume' && a[1] === 'create') out.push('volume-create');
    else if (c === 'volume' && a[1] === 'rm') out.push('volume-rm:' + last);
    else if (c === 'run') out.push(runKind(a));
  }
  return out;
}
const creates = (calls) => calls.filter(a => a[0] === 'create');
const volumeRms = (calls) => calls.filter(a => a[0] === 'volume' && a[1] === 'rm');
const recheck = (sb, extra = {}) => sb.ensure(alpha, { recheck: true, ...extra });
const homeOfCreate = (a) => { const i = a.findIndex((x, j) => a[j - 1] === '-v' && String(x).endsWith(':/home/agent')); return i < 0 ? null : String(a[i]).slice(0, -':/home/agent'.length); };
const boxCreates = (r) => creates(r.calls);

test('1. a new agent: the labelled home is created with the four labels BEFORE the box create, and the box mounts it; no orphan recorded', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  const vc = r.calls.findIndex(a => a[0] === 'volume' && a[1] === 'create'), bc = r.calls.findIndex(a => a[0] === 'create');
  assert.ok(vc >= 0 && bc > vc, 'volume create comes before the box create');
  assert.deepStrictEqual(r.calls[vc], ['volume', 'create', '--label', 'agent-hub=home', '--label', 'agent-hub.agent=alpha', '--label', `agent-hub.install=${r.install}`, '--label', `agent-hub.home=${r.hhome}`, lab]);
  assert.deepStrictEqual(r.volumes.get(lab).labels, r.ourLabels(alpha));
  const c = r.calls[bc];
  assert.ok(c.some((x, i) => c[i - 1] === '-v' && x === `${lab}:/home/agent`), `the box mounts ${lab}`);
  assert.ok(!c.some(x => String(x).startsWith(`${OLDER}:`)), 'not the older name');
  assert.deepStrictEqual(seq(r.calls), ['volume-create', 'create', `start:${NAME}`]);
  const m = r.moves();
  assert.ok(!m || m.orphans.length === 0, 'no orphan recorded');
  assert.ok(!r.sb.readinessItems().some(i => i.id.startsWith('sandbox-home-')));
});

test('2. volume create on a name that already exists with another install\'s labels (Docker keeps the old labels): EVOLFOREIGN, no box create', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  // the name appears (foreign) between the check and the create
  r.raceForeign = true;
  await assert.rejects(() => r.sb.ensure(alpha), code('EVOLFOREIGN'));
  assert.ok(r.calls.some(a => a[0] === 'volume' && a[1] === 'create'), 'the create was sent (and exited 0)');
  assert.strictEqual(boxCreates(r).length, 0, 'no box create');
  assert.deepStrictEqual(r.volumes.get(lab).files, 'THEIRS');
  assert.deepStrictEqual(volumeRms(r.calls), []);
  // already there foreign from the start: refused the same way
  const q = await rig().ident();
  q.vol(q.labFor(alpha), q.foreignLabels(alpha), 'THEIRS');
  await assert.rejects(() => q.sb.ensure(alpha), code('EVOLFOREIGN'));
  assert.strictEqual(boxCreates(q).length, 0);
  assert.strictEqual(q.calls.filter(a => a[0] === 'volume' && a[1] === 'create').length, 0, 'nothing to create: the name is taken');
});

test('3. adoption of an idle running box made before the change (recheck): stop, copy, two manifests, rm -f, create on the labelled home, start; older home kept 7 days', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('running');
  const m = r.mark();
  assert.strictEqual(await recheck(r.sb), NAME);
  const made = r.since(m);
  assert.deepStrictEqual(seq(made), ['stop:' + OLD_ID, 'volume-create', 'space', 'copy', 'manifest', 'manifest', 'rm-f:' + OLD_ID, 'create', `start:${NAME}`]);
  const copy = made.find(a => runKind(a) === 'copy');
  assert.ok(mountsOf(copy).includes(`${OLDER}:/from:ro`) && mountsOf(copy).includes(`${lab}:/home/agent`));
  assert.ok(copy.includes('--network') && copy[copy.indexOf('--network') + 1] === 'none');
  const [m1, m2] = made.filter(a => runKind(a) === 'manifest');
  assert.ok(mountsOf(m1).includes(`${OLDER}:/m:ro`) && mountsOf(m2).includes(`${lab}:/m:ro`), 'both sides compared');
  const c = boxCreates(r).pop();
  assert.strictEqual(homeOfCreate(c), lab, 'the new box is on the labelled home');
  assert.strictEqual(r.volumes.get(lab).files, 'ALPHA-FILES', 'the home was copied');
  assert.strictEqual(r.boxes.get(NAME).home, lab);
  const rec = r.moves();
  assert.deepStrictEqual(rec.moves, {}, 'no move left');
  assert.strictEqual(rec.retired.length, 1);
  assert.strictEqual(rec.retired[0].volume, OLDER);
  assert.strictEqual(rec.retired[0].agent, 'alpha');
  assert.strictEqual(rec.retired[0].at, iso(r.t));
  assert.deepStrictEqual(rec.failed, {});
  const item = r.sb.readinessItems().find(i => i.id === 'sandbox-home-kept-' + OLDER);
  assert.ok(item, 'Status item for the kept older home');
  assert.ok(item.title.includes(friendly(r.t + 7 * DAY, 'UTC', r.t)), item.title);   // a time for a person, in the hub's zone (UTC in tests)
  assert.ok(!/\d{4}-\d\d-\d\dT/.test(item.title + item.detail), 'no raw timestamps');
  assert.ok(r.volumes.has(OLDER) && r.volumes.get(OLDER).files === 'ALPHA-FILES', 'the older volume is still there');
  assert.deepStrictEqual(volumeRms(r.calls), []);
});

test('4. adoption of a STOPPED box made before the change (plain ensure): same copy and check, no plain rm race, new box on the labelled home', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('exited');
  const m = r.mark();
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  const made = r.since(m);
  assert.deepStrictEqual(seq(made), ['volume-create', 'space', 'copy', 'manifest', 'manifest', 'rm-f:' + OLD_ID, 'create', `start:${NAME}`]);
  assert.strictEqual(made.filter(a => a[0] === 'rm' && !a.includes('-f')).length, 0, 'no plain rm');
  assert.strictEqual(made.filter(a => a[0] === 'stop').length, 0, 'it was stopped already');
  assert.strictEqual(homeOfCreate(boxCreates(r).pop()), lab);
  assert.strictEqual(r.volumes.get(lab).files, 'ALPHA-FILES');
  assert.strictEqual(r.moves().retired[0].volume, OLDER);
  assert.deepStrictEqual(volumeRms(r.calls), []);
});

// 5: a copy that fails, a manifest that differs, a copy that times out
for (const [n, label, setup, expectSeq, why] of [
  ['5a', 'the copy fails', (r) => { r.copyFail = Object.assign(new Error('docker failed'), { stderr: 'no space left on device', code: 1 }); },
    ['space', 'copy', 'killrm', 'size', 'empty'], /^the disk ran out of space during the copy$/],
  ['5b', 'the manifests differ', (r, lab) => { r.differ = lab; },
    ['space', 'copy', 'manifest', 'manifest', 'size', 'empty'], /not the same/],
  ['5c', 'the copy times out', (r) => { r.copyTimeout = true; },
    ['space', 'copy', 'killrm', 'size', 'empty'], /took longer/],
]) {
  test(`${n}. ${label}: the labelled home is emptied, a back-off of 1 h is recorded, the new box is made on the OLDER home with the current folders`, async () => {
    const r = await rig().ident();
    const lab = r.labFor(alpha), extra = '/srv/folder-no-longer-given';
    r.vol(OLDER, null, 'ALPHA-FILES');
    setup(r, lab);
    await r.old('running', [extra]);
    const m = r.mark();
    assert.strictEqual(await recheck(r.sb), NAME);
    const made = r.since(m);
    assert.deepStrictEqual(seq(made), ['stop:' + OLD_ID, 'volume-create', ...expectSeq, 'rm-f:' + OLD_ID, 'create', `start:${NAME}`]);
    const empty = made.find(a => runKind(a) === 'empty');
    assert.deepStrictEqual(mountsOf(empty), [`${lab}:/home/agent`], 'the labelled home is the one emptied');
    assert.strictEqual(r.volumes.get(lab).files, '', 'nothing of the partial copy is left');
    assert.strictEqual(r.volumes.get(OLDER).files, 'ALPHA-FILES', 'the older home is untouched');
    const c = boxCreates(r).pop();
    assert.strictEqual(homeOfCreate(c), OLDER, 'the new box is on the older home');
    assert.ok(!c.includes(`${extra}:${extra}`), 'the folder the agent may no longer use is not mounted');
    for (const f of r.sb.mountsFor(alpha)) assert.ok(c.includes(`${f}:${f}`), `${f} is mounted`);
    assert.strictEqual(c[c.length - 1], IMG1);
    assert.strictEqual(c.find(x => String(x).startsWith('agent-hub.args=')), `agent-hub.args=${(await r.sb.labelsFor(alpha, null, OLDER)).labels['agent-hub.args']}`);
    const nb = r.boxes.get(NAME);
    assert.ok(nb && nb.id === undefined && nb.home === OLDER, 'the old box is gone, a new one runs');
    const rec = r.moves();
    assert.deepStrictEqual(rec.moves, {});
    assert.deepStrictEqual(rec.retired, [], 'nothing retired after a failed move');
    const f = rec.failed.alpha;
    assert.strictEqual(f.count, 1);
    assert.strictEqual(f.at, iso(r.t));
    assert.strictEqual(f.nextAt, iso(r.t + HOUR));
    assert.match(f.why, why);
    assert.strictEqual(f.sizeKB, 2048);
    const item = r.sb.readinessItems().find(i => i.id === 'sandbox-home-move-alpha');
    assert.ok(item, 'Status item');
    assert.ok(item.detail.includes('failed 1 time'), item.detail);
    assert.ok(item.detail.includes(friendly(r.t + HOUR, 'UTC', r.t)), 'names the next try: ' + item.detail);
    assert.ok(!/\d{4}-\d\d-\d\dT/.test(item.detail), 'no raw timestamps: ' + item.detail);
    assert.ok(!r.sb.readinessItems().some(i => i.id.startsWith('sandbox-home-kept-')));
    assert.deepStrictEqual(volumeRms(r.calls), []);
  });
}

test('6. back-off: ours right after a failure; the copy is tried again after nextAt; three failures in a row -> 24 h; a success clears failed and the Status item', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.copyFail = new Error('docker failed');
  await r.old('running');
  const t0 = r.t;
  await recheck(r.sb);
  assert.strictEqual(r.moves().failed.alpha.count, 1);
  // right after: the fallback box counts as ours
  let m = r.mark();
  assert.strictEqual(await recheck(r.sb), NAME);
  assert.deepStrictEqual(seq(r.since(m)), [], 'no stop, rm, copy or create');
  r.t = t0 + HOUR - 1000;
  m = r.mark();
  await recheck(r.sb);
  assert.deepStrictEqual(seq(r.since(m)), [], 'still within the hour');
  // past nextAt: tried again, fails again
  r.t = t0 + HOUR + 1;
  m = r.mark();
  assert.strictEqual(await recheck(r.sb), NAME);
  let made = seq(r.since(m));
  assert.ok(made.includes('copy') && made.includes('create'), made.join(','));
  let f = r.moves().failed.alpha;
  assert.strictEqual(f.count, 2);
  assert.strictEqual(f.nextAt, iso(r.t + HOUR));
  // and a third time, for another reason (three in a row for the same reason would stop the tries): a day
  r.copyFail = null; r.copyTimeout = true;
  r.t += HOUR + 1;
  await recheck(r.sb);
  r.copyTimeout = false;
  f = r.moves().failed.alpha;
  assert.strictEqual(f.count, 3);
  assert.strictEqual(f.nextAt, iso(r.t + 24 * HOUR));
  assert.ok(r.sb.readinessItems().find(i => i.id === 'sandbox-home-move-alpha').detail.includes('failed 3 times'));
  // an hour later: still waiting
  r.t += HOUR + 1;
  m = r.mark();
  await recheck(r.sb);
  assert.deepStrictEqual(seq(r.since(m)), [], 'the daily back-off holds');
  // a day later, the copy works
  r.t += 24 * HOUR;
  r.copyFail = null;
  m = r.mark();
  assert.strictEqual(await recheck(r.sb), NAME);
  made = seq(r.since(m));
  assert.deepStrictEqual(made.filter(x => !x.startsWith('stop')), ['space', 'copy', 'manifest', 'manifest', 'rm-f:' + NAME, 'create', `start:${NAME}`]);
  const rec = r.moves();
  assert.deepStrictEqual(rec.failed, {}, 'failed cleared');
  assert.strictEqual(rec.retired.length, 1);
  assert.strictEqual(rec.retired[0].volume, OLDER);
  assert.strictEqual(homeOfCreate(boxCreates(r).pop()), lab);
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-home-move-alpha'), 'Status item gone');
});

// 7: a restart part way
test('7a. restart in step copying (stopped old box): the record is dropped and the move starts over', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.vol(lab, r.ourLabels(alpha), 'PARTIAL');
  await r.old('exited');
  r.writeMoves({ moves: { alpha: { step: 'copying', boxId: OLD_ID, box: NAME, from: OLDER, to: lab, at: iso(r.t - 1000) } } });
  const sb2 = r.mk();
  assert.strictEqual(await sb2.ensure(alpha), NAME);
  assert.deepStrictEqual(seq(r.calls), ['space', 'copy', 'manifest', 'manifest', 'rm-f:' + OLD_ID, 'create', `start:${NAME}`]);
  assert.ok(r.logs.some(l => /started over/.test(l)), r.logs.join('\n'));
  assert.deepStrictEqual(boxCreates(r).filter(c => homeOfCreate(c) === OLDER), [], 'never a create on the older home');
  assert.strictEqual(homeOfCreate(boxCreates(r)[0]), lab);
  assert.strictEqual(r.volumes.get(lab).files, 'ALPHA-FILES');
  assert.strictEqual(r.boxes.size, 1);
  const rec = r.moves();
  assert.deepStrictEqual(rec.moves, {});
  assert.strictEqual(rec.retired[0].volume, OLDER);
});

test('7b. restart in step verified: the old box id gets rm -f, the box is created on the labelled home, retired is recorded', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.vol(lab, r.ourLabels(alpha), 'ALPHA-FILES');
  await r.old('exited');
  r.writeMoves({ moves: { alpha: { step: 'verified', boxId: OLD_ID, box: NAME, from: OLDER, to: lab, at: iso(r.t - 1000) } } });
  const sb2 = r.mk();
  assert.strictEqual(await sb2.ensure(alpha), NAME);
  assert.deepStrictEqual(seq(r.calls), ['rm-f:' + OLD_ID, 'create', `start:${NAME}`]);
  assert.deepStrictEqual(boxCreates(r).filter(c => homeOfCreate(c) === OLDER), []);
  assert.strictEqual(homeOfCreate(boxCreates(r)[0]), lab);
  assert.strictEqual(r.boxes.size, 1);
  const rec = r.moves();
  assert.deepStrictEqual(rec.moves, {});
  assert.deepStrictEqual(rec.retired.map(x => x.volume), [OLDER]);
  assert.ok(r.volumes.has(OLDER));
});

test('7c. restart in step switched with no box: the box is created on the labelled home and retired is recorded', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.vol(lab, r.ourLabels(alpha), 'ALPHA-FILES');
  r.writeMoves({ moves: { alpha: { step: 'switched', boxId: OLD_ID, box: NAME, from: OLDER, to: lab, at: iso(r.t - 1000) } } });
  const sb2 = r.mk();
  assert.strictEqual(await sb2.ensure(alpha), NAME);
  assert.deepStrictEqual(seq(r.calls), ['create', `start:${NAME}`]);
  assert.strictEqual(homeOfCreate(boxCreates(r)[0]), lab);
  assert.strictEqual(r.boxes.size, 1);
  assert.deepStrictEqual(r.moves().moves, {});
  assert.deepStrictEqual(r.moves().retired.map(x => x.volume), [OLDER]);
  assert.ok(!r.moves().orphans.length, 'not taken for an orphan');
});

test('8. orphan: no box and an unlabelled older home: a new labelled home is made, the older one is never touched; Status names it with the docker volume rm command', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'SOMEONE-ELSES');
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  assert.deepStrictEqual(seq(r.calls), ['volume-create', 'create', `start:${NAME}`]);
  assert.strictEqual(homeOfCreate(boxCreates(r)[0]), lab);
  assert.deepStrictEqual(volumeRms(r.calls), []);
  assert.deepStrictEqual(r.calls.filter(a => a[0] === 'run'), [], 'no copy, no run mounting it');
  assert.ok(!r.calls.some(a => a[0] !== 'volume' && a.some(x => x === OLDER || String(x).startsWith(OLDER + ':'))), 'no other call names the older home');
  assert.deepStrictEqual(r.volumes.get(OLDER), { labels: null, files: 'SOMEONE-ELSES' });
  assert.deepStrictEqual(r.moves().orphans, [{ ...r.stampOf(), agent: 'alpha', volume: OLDER, to: lab }]);
  const item = r.sb.readinessItems().find(i => i.id === 'sandbox-home-orphan-' + OLDER);
  assert.ok(item, 'Status item');
  assert.ok(item.fix.includes(`docker volume rm ${OLDER}`), item.fix);
  // a second ensure of a new box: still never touched, listed once
  r.boxes.delete(NAME);
  await r.sb.ensure(alpha);
  assert.deepStrictEqual(volumeRms(r.calls), []);
  assert.strictEqual(r.moves().orphans.length, 1);
});

test('9a. another copy\'s labelled volume under the labelled name: never mounted, swept or removed (ensure, remove home:true, retire, sweepCredentials)', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(lab, r.foreignLabels(alpha), 'THEIRS').creds = true;
  await assert.rejects(() => r.sb.ensure(alpha), code('EVOLFOREIGN'));
  assert.strictEqual(boxCreates(r).length, 0);
  await r.sb.remove(alpha, { home: true });
  const into = tmp('vh-retire-');
  const res = await r.sb.retire(alpha, into);
  assert.strictEqual(res.result, 'none');
  const sw = await r.sb.sweepCredentials([alpha]);
  assert.deepStrictEqual(sw, { checked: 0, removed: [], failed: [] });
  assert.deepStrictEqual(volumeRms(r.calls), [], 'never removed');
  assert.deepStrictEqual(r.calls.filter(a => a[0] === 'run'), [], 'no container ever mounts it');
  assert.ok(!r.calls.some(a => a[0] !== 'volume' && a.some(x => String(x).includes(lab))), 'no call but the owner check names it');
  assert.deepStrictEqual(r.volumes.get(lab), { labels: r.foreignLabels(alpha), files: 'THEIRS', creds: true });
  assert.deepStrictEqual(fs.readdirSync(into), [], 'nothing archived');
});

test('9b. another copy\'s labelled volume under the older name: never mounted, swept or removed; the labelled home of this install is used', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, r.foreignLabels(alpha), 'THEIRS').creds = true;
  assert.strictEqual(await r.sb.ensure(alpha), NAME);
  assert.strictEqual(homeOfCreate(boxCreates(r)[0]), lab);
  assert.deepStrictEqual(r.moves() && r.moves().orphans || [], [], 'a foreign volume is not even an orphan');
  const sw = await r.sb.sweepCredentials([alpha]);
  assert.strictEqual(sw.checked, 1, 'only this install\'s home');
  await r.sb.remove(alpha, { home: true });
  const into = tmp('vh-retire-');
  await r.sb.retire(alpha, into);
  assert.deepStrictEqual(volumeRms(r.calls).map(a => a[a.length - 1]), [lab], 'only the labelled home goes');
  for (const a of r.calls.filter(a => a[0] === 'run')) assert.ok(!mountsOf(a).some(x => x.startsWith(OLDER + ':')), 'never mounted');
  assert.ok(r.volumes.has(OLDER) && r.volumes.get(OLDER).files === 'THEIRS' && r.volumes.get(OLDER).creds === true);
});

test('10. prune: a retired entry older than 7 days is removed with volume rm (never -f) only while the labelled home is ours; at most once an hour unless forced', async () => {
  const r = await rig().ident();
  const labA = r.labFor(alpha), labB = r.labFor(beta), gamma = { name: 'gamma' }, labG = r.labFor(gamma);
  const homes = createHomes({ run: r.docker, identity: () => ({ install: r.install, home: r.hhome }), image: 'sandbox-image:test', uid: 1000, gid: 1000, log: (...a) => r.logs.push(a.join(' ')), now: () => r.t, dataDir: r.dataDir, legacyName: homeVolumeFor });
  r.vol(labA, r.ourLabels(alpha)); r.vol('older-a-1'); r.vol('older-a-2'); r.vol('older-b'); r.vol('older-c');
  r.vol(labG, r.foreignLabels(gamma));
  const entry = (agent, volume, to, ageDays) => ({ agent: agent.name, volume, to, at: iso(r.t - ageDays * DAY) });
  r.writeMoves({ retired: [entry(alpha, 'older-a-1', labA, 8), entry(alpha, 'older-a-2', labA, 3), entry(beta, 'older-b', labB, 8), entry(gamma, 'older-c', labG, 8)] });
  await homes.prune();
  assert.deepStrictEqual(volumeRms(r.calls), [['volume', 'rm', 'older-a-1']], 'never -f, only the old one whose new home is ours');
  assert.deepStrictEqual(r.moves().retired.map(x => x.volume), ['older-a-2', 'older-b', 'older-c']);
  assert.ok(r.volumes.has('older-a-2') && r.volumes.has('older-b') && r.volumes.has('older-c'));
  // the labelled home of beta appears: kept entries stay while younger / foreign, but not within the hour
  r.vol(labB, r.ourLabels(beta));
  r.t += 1000;
  let m = r.mark();
  await homes.prune();
  assert.deepStrictEqual(r.since(m), [], 'at most once an hour');
  m = r.mark();
  await homes.prune({ force: true });
  assert.deepStrictEqual(volumeRms(r.since(m)), [['volume', 'rm', 'older-b']], 'forced: now beta\'s new home is ours');
  assert.ok(r.volumes.has('older-c'), 'foreign new home: kept');
  assert.ok(r.volumes.has('older-a-2'), 'younger: kept');
  r.t += HOUR + 1;
  m = r.mark();
  await homes.prune();
  assert.ok(r.since(m).length > 0, 'an hour later it looks again');
  assert.deepStrictEqual(r.moves().retired.map(x => x.volume), ['older-a-2', 'older-c']);
  // the youngest becomes 7 days old
  r.t += 5 * DAY;
  await homes.prune({ force: true });
  assert.ok(!r.volumes.has('older-a-2'));
  assert.ok(volumeRms(r.calls).every(a => !a.includes('-f') && a.length === 3));
});

test('11. remove(alpha, {home:true}) on a box made before the change: the labelled home (ours), the older home the box mounted, and the kept older homes; an orphan of another agent is untouched', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.vol(lab, r.ourLabels(alpha));
  r.vol('kept-older-alpha-home');
  r.vol('hub-agent-beta-home', null, 'BETA');           // an orphan of another agent
  r.vol('kept-older-beta-home');
  r.writeMoves({
    retired: [{ agent: 'alpha', volume: 'kept-older-alpha-home', to: lab, at: iso(r.t - DAY) }, { agent: 'beta', volume: 'kept-older-beta-home', to: 'x', at: iso(r.t - DAY) }],
    orphans: [{ agent: 'beta', volume: 'hub-agent-beta-home', to: 'x' }],
  });
  await r.old('running');
  const m = r.mark();
  await r.sb.remove(alpha, { home: true });
  assert.deepStrictEqual(seq(r.since(m)), ['stop:' + OLD_ID, 'rm-f:' + OLD_ID, 'volume-rm:' + lab, 'volume-rm:' + OLDER, 'volume-rm:kept-older-alpha-home']);
  assert.ok(!r.boxes.has(NAME));
  assert.deepStrictEqual([...r.volumes.keys()].sort(), ['hub-agent-beta-home', 'kept-older-beta-home']);
  assert.strictEqual(r.volumes.get('hub-agent-beta-home').files, 'BETA');
  assert.deepStrictEqual(r.moves().retired.map(x => x.agent), ['beta']);
  assert.ok(volumeRms(r.calls).every(a => !a.includes('-f')));
  // no box that proves the older home: it is left (an orphan nothing proves)
  const q = await rig().ident();
  q.vol(q.labFor(alpha), q.ourLabels(alpha));
  q.vol(OLDER, null, 'MAYBE-NOT-OURS');
  await q.sb.remove(alpha, { home: true });
  assert.deepStrictEqual(volumeRms(q.calls).map(a => a[a.length - 1]), [q.labFor(alpha)]);
  assert.ok(q.volumes.has(OLDER));
});

test('12a. retire on a box made before the change: the home the box used is archived (tar mounts it read-only), noted in .box-home-volume, removed after', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('running');
  const into = tmp('vh-retire-');
  let noteAtTar = null;
  r.onTar = () => { try { noteAtTar = fs.readFileSync(path.join(into, '.box-home-volume'), 'utf8'); } catch {} };
  const m = r.mark();
  const res = await r.sb.retire(alpha, into);
  assert.strictEqual(res.result, 'removed; home kept as box-home.tar');
  assert.deepStrictEqual(seq(r.since(m)), ['rm-f:' + OLD_ID, 'tar', 'volume-rm:' + OLDER]);
  const tar = r.since(m).find(a => runKind(a) === 'tar');
  assert.ok(mountsOf(tar).includes(`${OLDER}:/box-home:ro`), 'mounted read-only');
  assert.strictEqual(noteAtTar, OLDER, 'noted before the box went and the copy ran');
  assert.ok(fs.existsSync(path.join(into, 'box-home.tar')));
  assert.ok(!r.volumes.has(OLDER), 'the older home is removed after the archive');
  assert.ok(!fs.existsSync(path.join(into, '.box-home-volume')), 'the note goes once the volume is gone');
  assert.ok(!r.calls.some(a => a[0] === 'volume' && a[1] === 'rm' && a.includes(lab)));
});

test('12b. a second retire try after the box is gone still knows the older home from the note', async () => {
  const r = await rig().ident();
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('exited');
  const into = tmp('vh-retire-');
  r.fail(a => a[0] === 'volume' && a[1] === 'rm', Object.assign(new Error('docker failed'), { stderr: 'Error response from daemon: volume is in use', code: 1 }));
  await assert.rejects(() => r.sb.retire(alpha, into), /in use|docker failed/);
  assert.ok(!r.boxes.has(NAME), 'the box is gone');
  assert.strictEqual(fs.readFileSync(path.join(into, '.box-home-volume'), 'utf8'), OLDER);
  assert.ok(r.volumes.has(OLDER));
  const m = r.mark();
  const res = await r.sb.retire(alpha, into);
  assert.strictEqual(res.result, 'removed; home kept as box-home.tar');
  assert.deepStrictEqual(seq(r.since(m)), ['volume-rm:' + OLDER], 'the archive is already there; the older home goes');
  assert.ok(!r.volumes.has(OLDER));
  assert.ok(!fs.existsSync(path.join(into, '.box-home-volume')));
});

test('13. sweepCredentials: sweeps the labelled home (ours) and the older unlabelled one, skips a foreign-labelled one, never removes a volume', async () => {
  const r = await rig().ident();
  const labA = r.labFor(alpha), labB = r.labFor(beta);
  r.vol(labA, r.ourLabels(alpha)).creds = true;
  r.vol(OLDER, null).creds = true;
  r.vol(labB, r.foreignLabels(beta)).creds = true;   // beta's older home is absent
  const m = r.mark();
  const out = await r.sb.sweepCredentials([alpha, beta]);
  const swept = r.since(m).filter(a => runKind(a) === 'sweep').map(a => mountsOf(a)[0]);
  assert.deepStrictEqual(swept, [`${labA}:/box-home`, `${OLDER}:/box-home`]);
  assert.strictEqual(out.checked, 2);
  assert.deepStrictEqual(out.removed, ['alpha'], 'each agent named once, however many of its homes held a copy');
  assert.deepStrictEqual(out.failed, []);
  assert.deepStrictEqual(volumeRms(r.calls), []);
  assert.strictEqual(r.volumes.get(labB).creds, true, 'the foreign volume was not touched');
  assert.ok(r.volumes.has(labA) && r.volumes.has(OLDER) && r.volumes.has(labB));
});

test('14a. home-moves.json is written with mode 0600 (and stays so when rewritten); no temporary file is left', async () => {
  const dir = tmp('vh-rec-'), r = rig();
  r.install = 'a'.repeat(32); r.hhome = 'b'.repeat(64);
  const dataDir = path.join(dir, 'data');
  const homes = createHomes({ run: r.docker, identity: () => ({ install: r.install, home: r.hhome }), image: 'sandbox-image:test', uid: 1000, gid: 1000, log: (...a) => r.logs.push(a.join(' ')), now: () => r.t, dataDir, legacyName: homeVolumeFor });
  r.vol(OLDER, null);
  await homes.noteOrphan(alpha);
  const file = path.join(dataDir, 'home-moves.json');
  assert.strictEqual(homes.file, file);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orphans.map(x => x.volume), [OLDER]);
  r.vol(homeVolumeFor(beta), null);
  await homes.noteOrphan(beta);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orphans.length, 2);
  assert.deepStrictEqual(fs.readdirSync(dataDir), ['home-moves.json']);
});

test('14b. a damaged home-moves.json is read as empty and logged, never thrown', async () => {
  const dir = tmp('vh-rec-'), r = rig();
  r.install = 'a'.repeat(32); r.hhome = 'b'.repeat(64);
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'home-moves.json');
  fs.writeFileSync(file, 'this is { not json');
  const homes = createHomes({ run: r.docker, identity: () => ({ install: r.install, home: r.hhome }), image: 'sandbox-image:test', uid: 1000, gid: 1000, log: (...a) => r.logs.push(a.join(' ')), now: () => r.t, dataDir, legacyName: homeVolumeFor });
  assert.deepStrictEqual(homes.readinessItems(), []);
  assert.strictEqual(homes.pending(alpha), null);
  assert.strictEqual(homes.mayTry(alpha), true);
  assert.strictEqual(homes.backoffHome(alpha), null);
  assert.strictEqual(await homes.resume(alpha), 'none');
  assert.ok(r.logs.some(l => l.includes('could not read') && l.includes(file)), r.logs.join('\n'));
  // not an object at all, or the wrong shapes inside: also empty, never thrown
  for (const text of ['null', '[]', '{"moves":5,"retired":"x","orphans":{},"failed":[]}']) {
    fs.writeFileSync(file, text);
    assert.deepStrictEqual(homes.readinessItems(), [], text);
    assert.strictEqual(homes.pending(alpha), null, text);
  }
  // the next write replaces the damaged file with a valid one
  fs.writeFileSync(file, 'garbage');
  r.vol(OLDER, null);
  await homes.noteOrphan(alpha);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).orphans.map(x => x.volume), [OLDER]);
});

// Round-1 review fixes: records a copy carried are inert; a failed move survives a failed create; kept homes are
// removed only while still unlabelled; a move needs room for a second copy.
test('22. a record a copy of data/ carried (another data folder) is inert: no rm of its box, its kept homes and Status untouched', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.vol('kept-by-the-original', null, 'X');
  await r.old('running');
  const theirs = { install: r.install, home: 'e'.repeat(64) };   // same id, another data folder: the original install
  r.writeMoves({
    moves: { alpha: { ...theirs, step: 'verified', boxId: 'feedbeef99', box: NAME, from: OLDER, to: lab, at: iso(r.t - 1000) } },
    retired: [{ ...theirs, agent: 'alpha', volume: 'kept-by-the-original', to: lab, at: iso(r.t - 30 * DAY) }],
    failed: { alpha: { ...theirs, why: 'x', count: 2, at: iso(r.t), nextAt: iso(r.t + DAY), from: OLDER, to: lab } },
  });
  const sb2 = r.mk();
  await recheck(sb2);
  assert.ok(!r.calls.some(a => a.includes('feedbeef99')), 'the recorded box id of the other install is never acted on');
  assert.deepStrictEqual(volumeRms(r.calls), [], 'nothing removed');
  await sb2.remove(alpha, { home: true }).catch(() => {});
  assert.ok(!volumeRms(r.calls).some(a => a.includes('kept-by-the-original')), 'Reset with home leaves the other install\'s kept home');
  assert.ok(!sb2.readinessItems().some(i => /^sandbox-home-(move|kept)-/.test(i.id)), 'no Status items from records not this install\'s');
});

test('23. restart in step verified when the recorded box is now another install\'s: nothing removed, the record dropped', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.vol(lab, r.ourLabels(alpha), 'ALPHA-FILES');
  r.boxes.set(NAME, { state: 'running', id: 'otherbox01', home: OLDER, binds: r.sb.mountsFor(alpha),
    labels: { 'agent-hub': 'sandbox', 'agent-hub.agent': 'alpha', 'agent-hub.install': 'c'.repeat(32), 'agent-hub.home': 'd'.repeat(64), 'agent-hub.args': 'f'.repeat(64) } });
  r.writeMoves({ moves: { alpha: { step: 'verified', boxId: 'otherbox01', box: NAME, from: OLDER, to: lab, at: iso(r.t - 1000) } } });
  const sb2 = r.mk();
  await assert.rejects(() => recheck(sb2), (e) => e.code === 'EBOXFOREIGN');
  assert.ok(!r.calls.some(a => (a[0] === 'rm' || a[0] === 'stop') && a.includes('otherbox01')), 'never stopped or removed');
  assert.deepStrictEqual(r.moves().moves, {}, 'the record is dropped');
});

test('24. a failed move, then the create fails: the next start still puts the box on the older home, also after the back-off', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('running');
  r.copyFail = Object.assign(new Error('docker failed'), { stderr: 'no space left on device', code: 1 });
  r.fail((a) => a[0] === 'create', Object.assign(new Error('docker failed'), { stderr: 'Error response from daemon: create failed', code: 1 }));
  await assert.rejects(() => recheck(r.sb));
  assert.ok(!r.boxes.get(NAME), 'the old box is gone and no new one was made');
  r.t += 2 * DAY;   // well past the back-off
  r.copyFail = null;
  assert.strictEqual(await recheck(r.sb), NAME);
  assert.strictEqual(homeOfCreate(boxCreates(r).pop()), OLDER, 'back on the older home, never the emptied labelled one');
  assert.strictEqual(r.volumes.get(OLDER).files, 'ALPHA-FILES');
  assert.strictEqual(r.volumes.get(lab).files, '');
});

test('25. a kept older home that has since been labelled (another copy made a volume of that name) is never removed', async () => {
  const r = await rig().ident();
  const lab = r.labFor(alpha);
  r.vol(lab, r.ourLabels(alpha), 'ALPHA-FILES');
  r.vol('kept-a', r.foreignLabels(alpha), 'THEIRS');
  r.vol('kept-b', r.foreignLabels(alpha), 'THEIRS');
  r.writeMoves({ retired: [{ agent: 'alpha', volume: 'kept-a', to: lab, at: iso(r.t - 8 * DAY) }, { agent: 'alpha', volume: 'kept-b', to: lab, at: iso(r.t - 1 * DAY) }] });
  const sb2 = r.mk();
  await sb2.ensure(alpha);   // runs prune
  assert.deepStrictEqual(volumeRms(r.calls), [], 'prune leaves it');
  await sb2.remove(alpha, { home: true });
  assert.ok(!volumeRms(r.calls).some(a => a.includes('kept-a') || a.includes('kept-b')), 'Reset with home leaves them too');
  assert.deepStrictEqual(r.moves().retired.filter(x => x.install === r.install), [], 'no longer listed');
});

test('26. not enough free disk space for a second copy: no copy at all, the box stays on its older home, Status says why', async () => {
  const r = await rig().ident();
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('running');
  r.homeKB = 4 * 1024 * 1024; r.freeKB = 8 * 1024 * 1024;   // 4 GB home, 8 GB free: 1.2 x 4 GB + 5 GB reserve doesn't fit
  assert.strictEqual(await recheck(r.sb), NAME);
  assert.ok(!r.calls.some(a => a[0] === 'run' && String(a[a.indexOf('-c') + 1] || '').includes('tar --null')), 'no copy');
  assert.strictEqual(homeOfCreate(boxCreates(r).pop()), OLDER);
  const f = r.moves().failed.alpha;
  assert.match(f.why, /enough free disk space/);
  assert.match(f.why, /the home folder holds 4 GB, 8 GB are free, 9\.8 GB are needed/);
});

test('sizes read as people say them: KB, MB, then GB with one decimal place below 10 GB', () => {
  const MBk = 1024, GBk = 1024 * 1024;
  assert.strictEqual(sizeText(0), '0 KB');
  assert.strictEqual(sizeText(800), '800 KB');
  assert.strictEqual(sizeText(512 * MBk), '512 MB');
  assert.strictEqual(sizeText(1023 * MBk), '1023 MB');
  assert.strictEqual(sizeText(GBk - 100), '1 GB', 'what rounds to 1024 MB reads as 1 GB');
  assert.strictEqual(sizeText(1536 * MBk), '1.5 GB');
  assert.strictEqual(sizeText(5120 * MBk), '5 GB');
  assert.strictEqual(sizeText(9.8 * GBk), '9.8 GB');
  assert.strictEqual(sizeText(9.97 * GBk), '10 GB');
  assert.strictEqual(sizeText(120.4 * GBk), '120 GB');
});

// Follow-ups: the free-space check counts sparse files at full length; three failures in a row for the same reason stop
// the automatic tries; an admin's "Move now" tries once.
const BUSY_TOP = 'PID ARGS\n1 /sbin/docker-init -- sleep infinity\n7 sleep infinity\n42 node server.js\n';
const spaceRun = (calls) => calls.find(a => runKind(a) === 'space');

test('27. the free-space check uses the apparent size (tar writes a sparse file at its full length)', async () => {
  const r = await rig().ident();
  r.vol(OLDER, null, 'ALPHA-FILES');
  await r.old('running');
  await recheck(r.sb);
  const sp = spaceRun(r.calls);
  assert.ok(sp, 'a space check ran');
  assert.match(String(sp[sp.indexOf('-c') + 1]), /du -sk --apparent-size \/from/);
});

test('28. three failures in a row for the same reason: no more automatic tries; Status offers Move now (admins)', async () => {
  const r = await rig().ident();
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.copyFail = Object.assign(new Error('docker failed'), { stderr: 'tar: x: Cannot open: Permission denied', code: 2 });
  await r.old('running');
  await recheck(r.sb);
  for (let i = 0; i < 2; i++) { r.t += 25 * HOUR; await recheck(r.sb); }
  const f = r.moves().failed.alpha;
  assert.strictEqual(f.count, 3); assert.strictEqual(f.same, 3); assert.strictEqual(f.kind, 'copy'); assert.strictEqual(f.stopped, true);
  const item = r.sb.readinessItems().find(i => i.id === 'sandbox-home-move-alpha');
  assert.match(item.title, /isn't being moved any more/);
  assert.match(item.detail, /3 times in a row for the same reason/);
  assert.deepStrictEqual(item.action, { label: 'Move now', api: '/api/sandbox/agents/alpha/move-home', method: 'POST' });
  // days later: no try at all, and the box on the older home stays as it is
  r.t += 30 * DAY;
  const m = r.mark();
  assert.strictEqual(await recheck(r.sb), NAME);
  assert.deepStrictEqual(seq(r.since(m)), [], 'no stop, copy, rm or create');
});

test('29. a different reason starts the count again: copy, copy, timeout does not stop; timeout three times does', async () => {
  const r = await rig().ident();
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.copyFail = new Error('docker failed');
  await r.old('running');
  await recheck(r.sb);
  r.t += 2 * HOUR; await recheck(r.sb);
  r.copyFail = null; r.copyTimeout = true;
  r.t += 2 * HOUR; await recheck(r.sb);
  let f = r.moves().failed.alpha;
  assert.strictEqual(f.kind, 'timeout'); assert.strictEqual(f.same, 1); assert.ok(!f.stopped);
  assert.ok(!r.sb.readinessItems().find(i => i.id === 'sandbox-home-move-alpha').action, 'no Move now while it still tries');
  for (let i = 0; i < 2; i++) { r.t += 25 * HOUR; await recheck(r.sb); }
  f = r.moves().failed.alpha;
  assert.strictEqual(f.same, 3); assert.strictEqual(f.stopped, true);
});

async function stoppedRig() {
  const r = await rig().ident();
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.copyFail = new Error('docker failed');
  await r.old('running');
  await recheck(r.sb);
  for (let i = 0; i < 2; i++) { r.t += 25 * HOUR; await recheck(r.sb); }
  assert.strictEqual(r.moves().failed.alpha.stopped, true);
  return r;
}

test('30. Move now on an idle box: one try, it works, the box is on the labelled home and the failure is gone', async () => {
  const r = await stoppedRig();
  r.copyFail = null;
  const res = await r.sb.moveHomeNow(alpha);
  assert.deepStrictEqual(res, { ok: true, moved: true });
  assert.strictEqual(homeOfCreate(boxCreates(r).pop()), r.labFor(alpha));
  assert.deepStrictEqual(r.moves().failed, {});
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-home-move-alpha'));
});

test('31. Move now while work runs in the box: nothing tried, the stop stays; a try that fails the same way stops again', async () => {
  const r = await stoppedRig();
  const before = r.moves().failed.alpha;
  r.top = BUSY_TOP;
  const m = r.mark();
  const res = await r.sb.moveHomeNow(alpha);
  assert.strictEqual(res.ok, false); assert.match(res.error, /^Nothing was tried/);
  assert.deepStrictEqual(seq(r.since(m)), [], 'nothing stopped, copied, removed or created');
  assert.deepStrictEqual(r.moves().failed.alpha, before, 'the record is as it was');
  const busyCb = await r.sb.moveHomeNow(alpha, { busy: () => true });
  assert.match(busyCb.error, /^Nothing was tried/);
  r.top = IDLE_TOP;
  const again = await r.sb.moveHomeNow(alpha);   // copyFail is still set: the same reason
  assert.strictEqual(again.ok, false); assert.match(again.error, /^The move failed again/);
  const f = r.moves().failed.alpha;
  assert.strictEqual(f.same, 4); assert.strictEqual(f.stopped, true);
});

test('32. Move now with no failed move waiting: refused, nothing done', async () => {
  const r = await rig().ident();
  const m = r.mark();
  const res = await r.sb.moveHomeNow(alpha);
  assert.strictEqual(res.ok, false); assert.match(res.error, /No move of alpha's home folder is waiting/);
  assert.deepStrictEqual(r.since(m), []);
});

test('33. the Move now route is for admins only', () => {
  const { classifyRoute } = require('../lib/access');
  assert.deepStrictEqual(classifyRoute('/api/sandbox/agents/alpha/move-home', 'POST'), { kind: 'admin' });
});

test('34. Move now for an agent that does not work in a box: refused, the record untouched, no Docker call', async () => {
  const r = await stoppedRig();
  const before = r.moves().failed.alpha;
  const host = r.mk({ getSetting: (k) => (k === 'sandboxDefaults' ? { member: 'off', admin: 'off' } : undefined) });
  const m = r.mark();
  const res = await host.moveHomeNow(alpha);
  assert.strictEqual(res.ok, false); assert.match(res.error, /doesn't work in a box/);
  assert.deepStrictEqual(r.since(m), []);
  assert.deepStrictEqual(r.moves().failed.alpha, before);
});

test('35. two Move now presses at once: the second is refused; with the box busy the stop stays exactly as it was', async () => {
  const r = await stoppedRig();
  const before = r.moves().failed.alpha;
  r.top = BUSY_TOP;
  const p1 = r.sb.moveHomeNow(alpha), p2 = r.sb.moveHomeNow(alpha);
  const [a, b] = await Promise.all([p1, p2]);
  assert.match(a.error, /^Nothing was tried/);
  assert.strictEqual(b.ok, false); assert.match(b.error, /already under way/);
  assert.deepStrictEqual(r.moves().failed.alpha, before, 'stopped, as before');
  const third = await r.sb.moveHomeNow(alpha);   // the lock is released afterwards
  assert.match(third.error, /^Nothing was tried/);
});

test('36. Move now when the agent has no box: refused, no box made, the record untouched', async () => {
  const r = await stoppedRig();
  const before = r.moves().failed.alpha;
  r.boxes.clear();
  const m = r.mark();
  const res = await r.sb.moveHomeNow(alpha);
  assert.strictEqual(res.ok, false); assert.match(res.error, /has no box right now/);
  assert.deepStrictEqual(seq(r.since(m)), [], 'no create or start');
  assert.deepStrictEqual(r.moves().failed.alpha, before);
});

test('37. Move now when the older home is gone: the failure ends, its Status item goes, nothing else is done', async () => {
  const r = await stoppedRig();
  r.volumes.delete(OLDER);
  const m = r.mark();
  const res = await r.sb.moveHomeNow(alpha);
  assert.strictEqual(res.ok, true); assert.strictEqual(res.moved, false); assert.match(res.note, /no longer there/);
  assert.deepStrictEqual(seq(r.since(m)), []);
  assert.deepStrictEqual(r.moves().failed, {});
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-home-move-alpha'));
});

test('38. after a Move now that found the box busy, Status shows no box waiting to be rebuilt', async () => {
  const r = await stoppedRig();
  r.top = BUSY_TOP;
  await r.sb.moveHomeNow(alpha);
  assert.ok(!r.sb.readinessItems().some(i => i.id === 'sandbox-held-alpha'), 'no held item');
  assert.ok(r.sb.readinessItems().some(i => i.id === 'sandbox-home-move-alpha' && i.action), 'the stopped item with Move now stays');
});

// Texts: times in the person's zone, failure reasons in plain words, accurate refusals; the held entry kept when it has
// another reason than the move.
const RAW_TIME = /\d{4}-\d\d-\d\dT\d\d:\d\d/;

test('39. Status times are written in the hub zone for a person ("Nov 18, 10:35 AM EST"), never as raw timestamps', async () => {
  const r = await rig().ident();
  const NY = 'America/New_York';
  const sb = r.mk({ timeZone: () => NY });
  r.vol(OLDER, null, 'ALPHA-FILES');
  r.writeMoves({
    failed: { alpha: { why: 'x', kind: 'copy', same: 1, count: 1, at: iso(r.t), nextAt: iso(r.t + HOUR), from: OLDER, to: 'y' } },
    retired: [{ agent: 'alpha', volume: 'kept-a', to: 'y', at: iso(r.t) }],
  });
  const items = sb.readinessItems().filter(i => /^sandbox-/.test(i.id));
  assert.ok(items.length >= 2);
  for (const i of items) assert.ok(!RAW_TIME.test(i.title + ' ' + i.detail), `${i.id}: ${i.title} ${i.detail}`);
  const moveItem = items.find(i => i.id === 'sandbox-home-move-alpha');
  assert.ok(moveItem.detail.includes(friendly(r.t, NY, r.t)) && moveItem.detail.includes(friendly(r.t + HOUR, NY, r.t)), moveItem.detail);
  assert.match(friendly(r.t, NY, r.t), /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d\d [AP]M E[SD]T$/);
  const kept = items.find(i => i.id === 'sandbox-home-kept-kept-a');
  assert.ok(kept.title.includes(friendly(r.t + 7 * DAY, NY, r.t)), kept.title);
});

for (const [n, stderr, want] of [
  ['40a', 'tar: cache/locked.bin: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors', "a file in the home folder can't be read: cache/locked.bin"],
  ['40b', 'tar: ./notes.txt: file changed as we read it', 'a file in the home folder changed during the copy: notes.txt'],
  ['40c', 'tar: x: Cannot write: No space left on device', 'the disk ran out of space during the copy'],
  ['40d', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', "Docker didn't answer"],
  ['40e', 'something odd happened', 'the copy failed; Docker said: something odd happened'],
  ['40f', 'tar: ./a.log: file changed as we read it\ntar: big.bin: Cannot write: No space left on device', 'the disk ran out of space during the copy'],
  ['40g', 'docker: permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock', "your Maestro isn't allowed to use Docker"],
  ['40h', 'tar: ./.docker/config.json: Cannot open: Permission denied\ntar: Exiting with failure status due to previous errors', "a file in the home folder can't be read: .docker/config.json"],
  ['40i', 'tar: ./docker.sock: socket ignored\ntar: big.bin: Cannot write: No space left on device', 'the disk ran out of space during the copy'],
]) {
  test(`${n}. a failed copy is explained in plain words first: ${want}`, async () => {
    const r = await rig().ident();
    r.vol(OLDER, null, 'ALPHA-FILES');
    r.copyFail = Object.assign(new Error('docker failed'), { stderr, code: 2 });
    await r.old('running');
    await recheck(r.sb);
    assert.strictEqual(r.moves().failed.alpha.why, want);
    assert.ok(r.sb.readinessItems().find(i => i.id === 'sandbox-home-move-alpha').detail.includes(`: ${want}`));
  });
}

test('41. a busy Move now leaves a held entry that has another reason (a folder the agent may no longer use)', async () => {
  const r = await stoppedRig();
  r.boxes.get(NAME).binds.push('/srv/folder-no-longer-given');   // a grant taken back while the box ran
  r.top = BUSY_TOP;
  const res = await r.sb.moveHomeNow(alpha);
  assert.match(res.error, /something is running in alpha's box/);
  const h = r.sb.readinessItems().find(i => i.id === 'sandbox-held-alpha');
  assert.ok(h, 'the box is still shown as waiting to be rebuilt');
  assert.ok(h.detail.includes('/srv/folder-no-longer-given'), h.detail);
  assert.ok(!RAW_TIME.test(h.detail), 'its time is written for a person: ' + h.detail);
});

test('42. Move now refusals say what actually stopped it', async () => {
  let r = await stoppedRig();
  r.top = BUSY_TOP;
  assert.strictEqual((await r.sb.moveHomeNow(alpha)).error, "Nothing was tried: something is running in alpha's box. Press Move now again when it's idle.");
  r = await stoppedRig();
  r.fail((a) => a[0] === 'inspect' && a.includes('--type') && String(a[a.indexOf('--format') + 1]).includes('Labels'), new Error('Cannot connect to the Docker daemon'));
  assert.strictEqual((await r.sb.moveHomeNow(alpha)).error, "Nothing was tried: Docker didn't answer. Try again in a moment.");
  assert.strictEqual(r.moves().failed.alpha.stopped, true, 'the stop stays');
  r = await stoppedRig();
  r.boxes.get(NAME).labels = { ...r.boxes.get(NAME).labels, 'agent-hub.install': 'c'.repeat(32) };
  assert.match((await r.sb.moveHomeNow(alpha)).error, /isn't this Maestro's/);
});

