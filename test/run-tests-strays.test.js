'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { findByMarker, findInCgroup, stopAll } = require('../scripts/stray-processes');

const LINUX = process.platform === 'linux';

// A fake /proc entry. stat after ") ": state, ppid, then 17 more fields, then field 22 (start time).
function fakeProc(root, pid, { ppid = 1, start = 100, state = 'S', env = null, comm = 'sleep', cgroup = null } = {}) {
  const d = path.join(root, String(pid));
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, 'stat'), `${pid} (my (cmd)) ${state} ${ppid} ` + Array.from({ length: 17 }, () => '0').join(' ') + ` ${start} 0 0`);
  if (env !== null) fs.writeFileSync(path.join(d, 'environ'), env);
  fs.writeFileSync(path.join(d, 'comm'), comm + '\n');
  fs.writeFileSync(path.join(d, 'cmdline'), comm + '\0--token=secret-test\0');
  if (cgroup) fs.writeFileSync(path.join(d, 'cgroup'), `0::${cgroup}\n`);
  return d;
}

describe('run-tests stray processes', () => {
  it('a. a fake /proc: findByMarker finds exactly the process with the marker, by pid and program name only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-'));
    try {
      fakeProc(root, 4001, { env: 'A=1\0HUB_TEST_RUN=abc123\0B=2\0', start: 777 });
      fakeProc(root, 4002, { env: 'HUB_TEST_RUN=other\0' });
      fs.mkdirSync(path.join(fakeProc(root, 4003, {}), 'environ'));   // reading a directory fails: unreadable
      fakeProc(root, 4004, { env: 'HUB_TEST_RUN=abc123\0' });          // this process (self): never listed
      fs.mkdirSync(path.join(root, 'self'));                          // not a pid
      const found = findByMarker('abc123', { procRoot: root, self: 4004 });
      assert.deepStrictEqual(found, [{ pid: 4001, name: 'sleep', start: '777' }]);
      assert.ok(!JSON.stringify(found).includes('secret-test'), 'no command line in what is reported');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('b. stopAll signals only processes that still have the start time read at the scan', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-stop-'));
    try {
      fakeProc(root, 5001, { start: 10 });
      fakeProc(root, 5002, { start: 99 });      // pid reused since the scan: another start time
      fakeProc(root, 5003, { start: 30, state: 'Z' });
      const sent = [];
      const n = stopAll([{ pid: 5001, start: '10' }, { pid: 5002, start: '20' }, { pid: 5003, start: '30' }, { pid: 5004, start: '40' }],
        { procRoot: root, waitMs: 120, kill: (pid, sig) => sent.push(`${pid} ${sig}`) });
      assert.strictEqual(n, 1);
      assert.deepStrictEqual(sent, ['5001 SIGTERM', '5001 SIGKILL'], 'the fake process never goes away, so it also gets SIGKILL');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('c. a real stray with the marker is found and stopped', { skip: LINUX ? false : 'needs /proc' }, async () => {
    const id = 'test' + Math.random().toString(16).slice(2, 10);
    const child = cp.spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore', env: { ...process.env, HUB_TEST_RUN: id } });
    const exited = new Promise((r) => child.once('exit', r));
    try {
      const found = findByMarker(id);
      assert.deepStrictEqual(found.map((p) => [p.pid, p.name]), [[child.pid, 'sleep']]);
      assert.strictEqual(stopAll(found), 1);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      assert.strictEqual(findByMarker(id).length, 0, 'gone afterwards');
    } finally {
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  it('d. a fake /proc: findInCgroup names only later processes in the same cgroup, never an ancestor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-proc-cg-'));
    try {
      const JOB = '/app.slice/hub-job-x.scope';
      fakeProc(root, 10, { start: 100, cgroup: JOB, comm: 'bash' });             // the job's wrapper: an ancestor
      fakeProc(root, 20, { ppid: 10, start: 200, cgroup: JOB, comm: 'node' });   // this process (self)
      fakeProc(root, 30, { start: 300, cgroup: JOB, comm: 'bash' });             // reparented leftover: started after, same cgroup
      fakeProc(root, 40, { start: 50, cgroup: JOB, comm: 'strace' });            // same cgroup, started before the run
      fakeProc(root, 50, { start: 400, cgroup: '/other.scope' });                // started after, other cgroup
      fakeProc(root, 60, { start: 500, cgroup: JOB });                           // excluded by the caller (already stopped)
      fakeProc(root, 70, { start: 600, cgroup: JOB, state: 'Z' });               // a zombie
      assert.deepStrictEqual(findInCgroup('200', { procRoot: root, self: 20, exclude: [60] }), [{ pid: 30, name: 'bash' }]);
      assert.deepStrictEqual(findInCgroup(null, { procRoot: root, self: 20 }), [], 'no start time: no report');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('e. run-tests.js marks its run, names strays by pid and program, and keeps the tests\' exit status', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
    assert.match(src, /crypto\.randomBytes\(8\)\.toString\('hex'\)/);
    assert.match(src, /HUB_TEST_RUN:\s*RUN_ID/);
    assert.match(src, /strayMod\.findByMarker\(RUN_ID\)/);
    assert.match(src, /run-tests: a test left process \$\{p\.pid\} \(\$\{p\.name\}\) running/);
    assert.match(src, /try \{ stopStrays\(\); \} catch/);
    assert.match(src, /\nprocess\.exit\(refused\.length \? 1 : r\.status === null \? 1 : r\.status\);\s*$/);
  });
});
