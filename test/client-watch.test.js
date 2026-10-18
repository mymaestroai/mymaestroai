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
  assert.ok(child.pid > 0 && w.pid() === child.pid);
  assert.ok(await until(async () => (await w.descendants()).length >= 2), 'both sleepers appeared');
  const kids = await w.descendants();
  assert.ok(kids.some(k => /sleep 7391/.test(k.args)) && kids.some(k => /sleep 7392/.test(k.args)), JSON.stringify(kids));
  assert.ok(kids.every(k => typeof k.etimes === 'number' && k.ppid === child.pid));
  assert.match(errs.join(''), /oops/);
  const killed = await w.killAll();
  await sleep(300);
  assert.ok(!alive(child.pid), 'client killed');
  assert.ok(killed.some(k => /sleep 7391/.test(k.args)) && killed.some(k => k.args === '(client)'));
  assert.ok(!kids.some(k => alive(k.pid)), 'grandchildren killed too');
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
  const r = await runShell('sleep 7396 & sleep 7397', { timeoutMs: 400 });
  assert.strictEqual(r.timedOut, true);
  await sleep(300);
  const { execFileSync } = require('child_process');
  const left = execFileSync('ps', ['-eo', 'args=']).toString().split('\n').filter(l => /^sleep 739[67]$/.test(l.trim()));
  assert.deepStrictEqual(left, [], 'no sleeper survived the timeout');
  const ok = await runShell('echo hi; echo err 1>&2; exit 2', { timeoutMs: 5000 });
  assert.deepStrictEqual([ok.stdout.trim(), ok.stderr.trim(), ok.code, ok.timedOut], ['hi', 'err', 2, false]);
});
