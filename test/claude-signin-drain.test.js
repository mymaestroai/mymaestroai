'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { supervise } = require('../lib/claude-signin-supervisor');
const { createSignIn, authStatus } = require('../lib/claude-signin');
const turn = () => new Promise(resolve => setImmediate(resolve));

function clock() {
  let time = 0, seq = 0;
  const timers = new Map();
  function setTimer(fn, ms) {
    const id = ++seq;
    timers.set(id, { at: time + ms, fn });
    return id;
  }
  function advance(ms) {
    const until = time + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      const [id, task] = next;
      timers.delete(id);
      time = task.at;
      task.fn();
    }
    time = until;
  }
  return { setTimer, clearTimer: id => timers.delete(id), advance };
}

function rig(kind, verify) {
  const c = clock();
  const signals = [], probes = [];
  let present = true, leader, worker;
  function spawn() {
    leader = new EventEmitter();
    const channel = new EventEmitter();
    leader.pid = 1234;
    leader.connected = channel.connected = true;
    leader.stdin = new EventEmitter();
    leader.stdout = new EventEmitter();
    leader.stderr = new EventEmitter();
    leader.send = (m, cb) => { channel.emit('message', m); cb?.(); };
    channel.send = (m, cb) => { leader.emit('message', m); cb?.(); };
    leader.disconnect = () => { channel.connected = false; channel.emit('disconnect'); };
    worker = new EventEmitter();
    supervise({
      channel, spawn: () => worker, setTimer: c.setTimer,
      kill(pid, sig) {
        assert.equal(pid, 0); // destructive signals from inside the group only
        signals.push(sig);
        if (sig === 'SIGKILL') { leader.connected = false; leader.emit('exit', null, sig); }
      }
    });
    return leader;
  }
  const engine = createSignIn({
    ...c, spawn, platform: 'linux', env: () => ({}),
    findClient: () => kind === 'installer' ? null : { bin: 'fake' },
    authStatus: async () => ({ loggedIn: true }), verify,
    kill(pid, sig) {
      assert.equal(pid, -1234);
      assert.equal(sig, 0); // parent must only probe
      probes.push(pid);
      if (!present) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    }
  });
  return { c, engine, signals, probes, worker: () => worker,
    stdout: () => leader.stdout, gone: () => { present = false; } };
}

for (const kind of ['installer', 'client']) {
  test(kind + ': cancellation drains the group after the payload leader exits', async () => {
    const r = rig(kind);
    const a = await r.engine.start();
    await turn();
    r.engine.cancel(a.id);
    r.worker().emit('exit', null, 'SIGTERM');
    assert.deepEqual(r.signals, ['SIGTERM']);
    assert.equal((await r.engine.start()).reason, 'busy');
    r.c.advance(3000);
    assert.deepEqual(r.signals, ['SIGTERM', 'SIGKILL']);
    assert.ok(r.probes.length);
    r.c.advance(16000); // no arbitrary unlock while a member remains
    assert.equal((await r.engine.start()).reason, 'busy');
    r.gone();
    r.c.advance(500);
    await turn();
    const b = await r.engine.start();
    assert.equal(b.ok, true);
    r.engine.cancel(b.id);
  });
}

test('an aborted verifier that never settles has a bounded lease', async () => {
  let observed;
  const r = rig('client', ({ signal }) => {
    observed = signal;
    return new Promise(() => {});
  });
  const a = await r.engine.start();
  await turn();
  r.stdout().emit('data', 'Login successful\n');
  await turn();
  r.engine.cancel(a.id);
  assert.equal(observed.aborted, true);
  r.gone();
  r.c.advance(14999);
  await turn();
  assert.equal((await r.engine.start()).reason, 'busy');
  r.c.advance(1);
  await turn();
  const b = await r.engine.start();
  assert.equal(b.ok, true);
  r.engine.cancel(b.id);
});

test('status exits with inherited stdout still open', async () => {
  const c = clock(), child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => assert.fail('status already exited');
  const answer = authStatus({ ...c, bin: 'fake', spawn: () => child });
  child.stdout.emit('data', '{"loggedIn":true}');
  child.emit('exit', 0);
  c.advance(500);
  assert.equal((await answer).loggedIn, true);
});

test('aborted status is bounded even without exit or close', async () => {
  const c = clock(), child = new EventEmitter(), ctl = new AbortController();
  const signals = [];
  child.stdout = new EventEmitter();
  child.kill = s => signals.push(s);
  const answer = authStatus({ ...c, signal: ctl.signal, spawn: () => child });
  ctl.abort();
  c.advance(500);
  assert.deepEqual(await answer, { loggedIn: null, method: null });
  assert.deepEqual(signals, ['SIGKILL']);
});
