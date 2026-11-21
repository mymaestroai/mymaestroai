'use strict';
// lib/client-watch: the hub spawns the Claude client itself, so a turn whose reply has ended but whose client is
// held open by a leftover shell command (the GP agent's 20-minute grep) gets that command killed and the turn can close.
// Real processes stand in for the client; the wiring into lib/sdk-chat is pinned at the source level.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const W = require('../lib/client-watch');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Process trees take a moment to appear under load: poll instead of trusting a fixed delay.
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

test('spawn returns the live child, consumes stderr, and reports exit; descendants are listed with ages and args', async () => {
  const errs = []; const logs = [];
  const w = W.forTurn({ agentName: 't', log: (m) => logs.push(m), onStderr: (d) => errs.push(String(d)) });
  // a "client" that starts a grandchild and keeps running
  const child = w.spawn({ command: 'bash', args: ['-c', 'echo oops 1>&2; sleep 7391 & sleep 7392'], cwd: process.cwd(), env: process.env });
  let exit = null;
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  assert.ok(child.pid > 0 && w.pid() === child.pid);
  // Wait for the sleepers themselves, as the client's own children. A bash child that has forked but not yet exec'd
  // still shows the whole command line, which contains both texts, so a text match alone can pass before they exist.
  const both = (list) => ['sleep 7391', 'sleep 7392'].every(a => list.some(k => k.args === a && k.ppid === child.pid));
  let kids = [], killed = null, exitBeforeKill = null;
  // every message carries the tree, what was killed and how the client ended, so a failure names its cause
  const why = (what) => `${what}: ${JSON.stringify({ kids, killed, exitBeforeKill, exit })}`;
  assert.ok(await until(async () => both(kids = await w.descendants())), why('both sleepers appeared'));
  assert.ok(kids.every(k => typeof k.etimes === 'number' && k.ppid === child.pid), why('ages and parents'));
  assert.match(errs.join(''), /oops/);
  exitBeforeKill = exit;
  killed = await w.killAll();
  assert.ok(killed.some(k => k.args === 'sleep 7391'), why('the grandchild is reported killed'));
  assert.ok(killed.some(k => k.args === '(client)'), why('the client is reported killed'));
  assert.ok(await until(async () => !alive(child.pid)), why('client killed'));
  assert.ok(await until(async () => !kids.some(k => alive(k.pid))), why('grandchildren killed too'));
});

test('expectExit: after the grace period, processes still under the client are killed, logged and reported', async () => {
  const logs = []; const events = [];
  const w = W.forTurn({ agentName: 'gp', log: (m) => logs.push(m), graceMs: 300, onLingering: (e) => events.push(e) });
  // bash stays the parent (a lone command would exec into sleep and look like a client with no children)
  const child = w.spawn({ command: 'bash', args: ['-c', 'sleep 7393 & wait'], cwd: process.cwd(), env: process.env });
  assert.ok(await until(async () => (await w.descendants()).length === 1), 'the sleeper appeared');
  w.expectExit();
  assert.ok(await until(async () => events.length === 1), 'the lingering sleeper was killed after the grace period');
  assert.ok(events[0].killed.some(k => /sleep 7393/.test(k.args)));
  assert.match(logs.join('\n'), /\[client-watch\] gp: the reply ended but 1 process\(es\) still run under the client; killing them/);
  // the "client" (bash -c) exits once its only child is gone
  assert.ok(await until(async () => !alive(child.pid)), 'the client could exit after the lingering command died');
  w.clear();
});

test('clear() before the grace period means nothing is touched; the abort signal kills the whole tree', async () => {
  const events = [];
  const w = W.forTurn({ agentName: 'x', log: () => {}, graceMs: 200, onLingering: (e) => events.push(e) });
  const ac = new AbortController();
  const child = w.spawn({ command: 'bash', args: ['-c', 'sleep 7394 & sleep 7395'], cwd: process.cwd(), env: process.env, signal: ac.signal });
  assert.ok(await until(async () => (await w.descendants()).length >= 2), 'sleepers appeared');
  w.expectExit(); w.clear();
  await sleep(500);
  assert.strictEqual(events.length, 0);
  assert.ok(alive(child.pid));
  const kids = await w.descendants();
  ac.abort();
  assert.ok(await until(async () => !alive(child.pid) && !kids.some(k => alive(k.pid))), 'abort killed client and children');
});

test('shortArgs trims the Claude shell-snapshot preamble', () => {
  const raw = "/bin/bash -c source /home/x/.claude/shell-snapshots/snapshot-bash-1.sh 2>/dev/null || true && shopt -u extglob 2>/dev/null || true && { \\builtin unalias -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp && grep -E \"x\" f.txt' < /dev/null";
  assert.match(W.shortArgs(raw), /^bash: cd \/tmp && grep/);
});

test('wiring: the SDK path spawns the client through the watch, arms it on end_turn, clears it on result and in cleanup', () => {
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /const turnWatch = clientWatch\.forTurn\(\{\s*\n\s*agentName, onStderr: sdkStderr,/);
  assert.match(sdk, /spawnClaudeCodeProcess: turnWatch\.spawn,/);
  assert.match(sdk, /if \(msg\.message\.stop_reason === 'end_turn'\) turnWatch\.expectExit\(\);/);
  assert.match(sdk, /else if \(msg\.type === 'result'\) \{\s*\n\s*turnWatch\.clear\(\);/);
  assert.match(sdk, /clearInterval\(heartbeatTimer\);\s*\n\s*try \{ turnWatch\.clear\(\); \} catch \{\}/);
  assert.match(sdk, /A shell command this agent started kept running after its reply/);
});

test('hub Bash kills the whole process group on timeout, so nothing outlives the call', async () => {
  const { runShell } = require('../lib/hub-tools');
  const { spawn, execFileSync } = require('child_process');
  // runShell starts the shell detached, so its pid is the call's process group: look only at that group, never at
  // other processes that happen to run the same text (another copy of this file, for one)
  let group = null;
  const spawnImpl = (...a) => { const c = spawn(...a); group = c.pid; return c; };
  const r = await runShell('sleep 7396 & sleep 7397', { timeoutMs: 400, spawnImpl });
  assert.strictEqual(r.timedOut, true);
  assert.ok(group > 0);
  const members = () => execFileSync('ps', ['-eo', 'pid=,pgid=,stat=,args=']).toString().split('\n')
    .map(l => l.trim().split(/\s+/)).filter(f => Number(f[1]) === group && !/^Z/.test(f[2] || '')).map(f => f.slice(3).join(' '));
  assert.ok(await until(async () => members().length === 0), `no process of the call survived the timeout: ${JSON.stringify(members())}`);
  const ok = await runShell('echo hi; echo err 1>&2; exit 2', { timeoutMs: 5000 });
  assert.deepStrictEqual([ok.stdout.trim(), ok.stderr.trim(), ok.code, ok.timedOut], ['hi', 'err', 2, false]);
});

test('parseEtime: [[dd-]hh:]mm:ss to seconds, null when malformed', () => {
  assert.strictEqual(W.parseEtime('05:07'), 307);
  assert.strictEqual(W.parseEtime('1:02:03'), 3723);
  assert.strictEqual(W.parseEtime('2-03:04:05'), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.strictEqual(W.parseEtime('  05:07\n'), 307);
  for (const bad of ['61:00', '00:60', '1-24:00:00', 'abc', '1:2:3:4', '', '99999999999999999999:00']) {
    assert.strictEqual(W.parseEtime(bad), null, JSON.stringify(bad));
  }
});

test('processTable on darwin asks ps for etime, converts it, and skips malformed rows', async () => {
  let seen = null;
  const exec = async (cmd, args) => {
    seen = { cmd, args };
    return { stdout: [
      '  100     1 2-03:04:05 /usr/bin/node server.js --port 8888',
      '  101   100    1:02:03 bash -c sleep 5',
      '  102   100      05:07 grep -r some pattern here',
      '  103   100    99:99 broken row',
      '  104   100  notatime weird',
      ''].join('\n') };
  };
  const rows = await W.processTable(exec, 'darwin');
  assert.strictEqual(seen.cmd, 'ps');
  assert.deepStrictEqual(seen.args, ['-eo', 'pid=,ppid=,etime=,args=']);
  assert.deepStrictEqual(rows, [
    { pid: 100, ppid: 1, etimes: 2 * 86400 + 3 * 3600 + 4 * 60 + 5, args: '/usr/bin/node server.js --port 8888' },
    { pid: 101, ppid: 100, etimes: 3723, args: 'bash -c sleep 5' },
    { pid: 102, ppid: 100, etimes: 307, args: 'grep -r some pattern here' },
  ]);
});

test('processTable on linux keeps asking for etimes and parses as before', async () => {
  let seen = null;
  const exec = async (cmd, args) => { seen = args; return { stdout: '  10     1   42 node a b\n  11    10    7 sleep 1\n' }; };
  const rows = await W.processTable(exec, 'linux');
  assert.deepStrictEqual(seen, ['-eo', 'pid=,ppid=,etimes=,args=']);
  assert.deepStrictEqual(rows, [{ pid: 10, ppid: 1, etimes: 42, args: 'node a b' }, { pid: 11, ppid: 10, etimes: 7, args: 'sleep 1' }]);
});

test('descendants and killTree on darwin walk a fake table and kill deepest first', async () => {
  const exec = async (cmd, args) => {
    assert.deepStrictEqual(args, ['-eo', 'pid=,ppid=,etime=,args=']);
    return { stdout: ' 500 1 10:00 client\n 501 500 00:30 child\n 502 501 00:05 grandchild\n 900 1 01:00 unrelated\n' };
  };
  const list = await W.descendants(500, exec, 'darwin');
  assert.deepStrictEqual(list.map(r => r.pid), [501, 502]);
  const order = [];
  const killed = await W.killTree(500, { exec, platform: 'darwin', includeSelf: true, kill: (p) => order.push(p) });
  assert.deepStrictEqual(order, [502, 501, 500]);
  assert.strictEqual(killed.length, 3);
});
