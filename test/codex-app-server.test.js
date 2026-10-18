'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const as = require('../lib/codex-cli/app-server');

// ── transport setting ────────────────────────────────────────────────────

test('transportFor: app-server by default, exec on request', () => {
  assert.strictEqual(as.transportFor({}), 'app-server');
  assert.strictEqual(as.transportFor({ HUB_CODEX_TRANSPORT: 'exec' }), 'exec');
  assert.strictEqual(as.transportFor({ HUB_CODEX_TRANSPORT: ' EXEC ' }), 'exec');
  assert.strictEqual(as.transportFor({ HUB_CODEX_TRANSPORT: 'app-server' }), 'app-server');
});

test('threadParams / turnInput / isSteerRefusal', () => {
  const p = as.threadParams({ model: 'gpt-x', cwd: '/w', sandbox: 'danger-full-access', instructions: 'be good', bridge: { file: '/b.json' }, nodePath: '/node', ephemeral: true });
  assert.strictEqual(p.model, 'gpt-x');
  assert.strictEqual(p.approvalPolicy, 'never');
  assert.strictEqual(p.developerInstructions, 'be good');
  assert.strictEqual(p.ephemeral, true);
  assert.strictEqual(p.config.mcp_servers['agent-hub'].command, '/node');
  assert.strictEqual(p.config.mcp_servers['agent-hub'].env.HUB_CODEX_BRIDGE_FILE, '/b.json');
  assert.strictEqual(as.threadParams({ cwd: '/w' }).sandbox, 'read-only');
  assert.deepStrictEqual(as.turnInput('hi', ['/a.png']), [{ type: 'text', text: 'hi' }, { type: 'localImage', path: '/a.png' }]);
  assert.deepStrictEqual(as.turnInput('', []), []);
  assert.strictEqual(as.isSteerRefusal({ rpcMessage: 'expected active turn id abc' }), true);
  assert.strictEqual(as.isSteerRefusal(new Error('socket closed')), false);
});

// ── notification mapper ──────────────────────────────────────────────────

test('mapper: streamed text, tools, user messages, usage, turn end', () => {
  const st = as.newMapperState();
  const m = (method, params) => as.notificationToActions(method, params, st);
  assert.deepStrictEqual(m('item/started', { item: { type: 'agentMessage', id: 'a1' } }), [{ kind: 'text_begin', id: 'a1' }]);
  assert.deepStrictEqual(m('item/agentMessage/delta', { itemId: 'a1', delta: 'Hel' }), [{ kind: 'text', text: 'Hel', delta: true }]);
  // already streamed: completed carries nothing
  assert.deepStrictEqual(m('item/completed', { item: { type: 'agentMessage', id: 'a1', text: 'Hello' } }), []);
  // never streamed: completed carries the whole text
  assert.deepStrictEqual(m('item/completed', { item: { type: 'agentMessage', id: 'a2', text: 'Whole' } }), [{ kind: 'text', text: 'Whole' }]);
  assert.deepStrictEqual(m('item/started', { item: { type: 'reasoning', id: 'r' } }), [{ kind: 'thinking' }]);
  const um = m('item/started', { item: { type: 'userMessage', id: 'u1', clientId: 'c1', content: [{ type: 'text', text: 'stop now' }] } });
  assert.deepStrictEqual(um, [{ kind: 'user_message', id: 'u1', clientId: 'c1', text: 'stop now' }]);

  const ts = m('item/started', { item: { type: 'commandExecution', id: 't1', command: 'ls' } });
  assert.strictEqual(ts[0].kind, 'tool_start');
  const tr = m('item/completed', { item: { type: 'commandExecution', id: 't1', command: 'ls', aggregatedOutput: 'x', exitCode: 0 } });
  assert.strictEqual(tr[0].kind, 'tool_result');
  assert.strictEqual(tr[0].id, 't1');

  m('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7 } } });
  m('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 150, cachedInputTokens: 0, outputTokens: 3 } } });
  assert.deepStrictEqual(m('error', { error: { message: 'retrying' }, willRetry: true }), [{ kind: 'error', message: 'retrying', soft: true }]);
  const end = m('turn/completed', { turn: { id: 'T', status: 'completed' } });
  assert.deepStrictEqual(end[0], { kind: 'usage', perTurn: true, usage: { input_tokens: 250, cached_input_tokens: 40, output_tokens: 10, context_tokens: 150 } });
  assert.deepStrictEqual(end[1], { kind: 'turn_done', status: 'completed', turnId: 'T', error: null });

  const failed = as.notificationToActions('turn/completed', { turn: { id: 'T', status: 'failed', error: { message: 'boom' } } }, as.newMapperState());
  assert.deepStrictEqual(failed.map((a) => a.kind), ['usage', 'error', 'turn_done']);
  assert.strictEqual(failed[2].error, 'boom');
});

// ── SteerPump ────────────────────────────────────────────────────────────

function fakeSession({ refuse = () => false, onSteer = () => {} } = {}) {
  let n = 0;
  return {
    steerable: true,
    sent: [],
    async steer(text) {
      this.sent.push(text);
      const clientId = `c${++n}`;
      onSteer(text, clientId);
      if (refuse(text)) return { ok: false, refused: true, error: 'expected active turn id' };
      return { ok: true, clientId };
    },
  };
}
function queue(items) { const q = [...items]; return { q, drain: () => q.splice(0) }; }

test('SteerPump: delivered only after the echo (clientId or text)', async () => {
  const session = fakeSession();
  const { q, drain } = queue([{ message: 'one' }, { message: 'two' }]);
  const delivered = [];
  const pump = new as.SteerPump({ session, drain, format: (i) => `[X]: ${i.message}`, onDelivered: (i) => delivered.push(i.message) });
  pump.start();
  await pump.chain;
  assert.deepStrictEqual(session.sent, ['[X]: one', '[X]: two']);
  assert.deepStrictEqual(delivered, []);
  assert.strictEqual(pump.undelivered().length, 2);
  pump.onUserMessage({ clientId: 'c1', text: '[X]: one' });
  pump.onUserMessage({ clientId: null, text: '[X]: two' });  // text match fallback
  assert.deepStrictEqual(delivered, ['one', 'two']);
  // a late arrival is steered on notify()
  q.push({ message: 'three' });
  pump.notify();
  await pump.chain;
  pump.onUserMessage({ clientId: 'c3', text: '[X]: three' });
  assert.deepStrictEqual(delivered, ['one', 'two', 'three']);
  assert.deepStrictEqual(await pump.finish(), []);
});

test('SteerPump: echo that arrives before the steer reply still counts', async () => {
  let pump;
  const session = fakeSession({ onSteer: (text, clientId) => pump.onUserMessage({ clientId, text }) });
  const { drain } = queue([{ message: 'early' }]);
  const delivered = [];
  pump = new as.SteerPump({ session, drain, format: (i) => i.message, onDelivered: (i) => delivered.push(i.message) });
  pump.start();
  await pump.chain;
  assert.deepStrictEqual(delivered, ['early']);
  assert.deepStrictEqual(await pump.finish(), []);
});

test('SteerPump: refused and unconfirmed items come back from finish()', async () => {
  const session = fakeSession({ refuse: (t) => t === 'no' });
  const { drain } = queue([{ message: 'no' }, { message: 'silent' }]);
  const pump = new as.SteerPump({ session, drain, format: (i) => i.message, onDelivered: () => assert.fail('nothing was echoed') });
  pump.start();
  await pump.chain;
  const left = await pump.finish();
  assert.deepStrictEqual(left.map((i) => i.message).sort(), ['no', 'silent']);
  assert.deepStrictEqual(pump.undelivered(), []);
});

test('SteerPump: nothing is taken from the queue before start() or after finish()', async () => {
  const session = fakeSession();
  const { q, drain } = queue([{ message: 'wait' }]);
  const pump = new as.SteerPump({ session, drain, format: (i) => i.message, onDelivered: () => {} });
  pump.notify();
  await pump.chain;
  assert.strictEqual(q.length, 1);
  pump.start();
  await pump.chain;
  assert.strictEqual(q.length, 0);
  await pump.finish();
  q.push({ message: 'late' });
  pump.notify();
  await pump.chain;
  assert.strictEqual(q.length, 1, 'after finish the item stays queued for the follow-up turn');
});

test('SteerPump: turn no longer steerable → items fail over', async () => {
  const session = fakeSession();
  session.steerable = false;
  const { q, drain } = queue([{ message: 'x' }]);
  const pump = new as.SteerPump({ session, drain, format: (i) => i.message, onDelivered: () => {} });
  pump.start();
  await pump.chain;
  assert.strictEqual(q.length, 1, 'not drained while nothing is steerable');
  assert.deepStrictEqual(await pump.finish(), []);
});

// ── client + session against a fake app-server ──────────────────────────

// A tiny stand-in for `codex app-server`: speaks the subset of the protocol the hub uses.
const FAKE_SERVER = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const mode = process.env.FAKE_MODE || '';
if (mode === 'die') { process.stderr.write('fatal: cannot start\n'); process.exit(3); }
let turn = null, n = 0, initialized = false;
const log = [];
rl.on('line', (line) => {
  const m = JSON.parse(line);
  log.push(m.method || ('reply:' + m.id));
  if (m.method === 'initialized') { initialized = true; return; }
  if (m.id != null && !m.method) { out({ method: 'test/log', params: { reply: m } }); return; }
  switch (m.method) {
    case 'initialize': return out({ id: m.id, result: { userAgent: 'fake' } });
    case 'thread/resume':
      if (m.params.threadId === 'gone') return out({ id: m.id, error: { code: -32600, message: 'thread not found' } });
      return out({ id: m.id, result: { thread: { id: m.params.threadId } } });
    case 'thread/start': return out({ id: m.id, result: { thread: { id: 'th-new', sawInstructions: !!m.params.developerInstructions } } });
    case 'turn/start': {
      turn = 'turn-' + (++n);
      out({ id: m.id, result: { turn: { id: turn } } });
      const text = m.params.input[0].text;
      out({ method: 'item/started', params: { threadId: m.params.threadId, turnId: turn, item: { type: 'userMessage', id: 'u0', content: [{ type: 'text', text }] } } });
      // a server→client request the hub must refuse rather than hang on
      out({ id: 900, method: 'item/commandExecution/requestApproval', params: {} });
      out({ method: 'item/started', params: { threadId: m.params.threadId, turnId: turn, item: { type: 'agentMessage', id: 'a1' } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: m.params.threadId, turnId: turn, itemId: 'a1', delta: 'working' } });
      if (text === 'quick') {
        out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: turn, status: 'completed' } } });
        turn = null;
      }
      return;
    }
    case 'turn/steer': {
      if (m.params.expectedTurnId !== turn) return out({ id: m.id, error: { code: -32600, message: 'expected active turn id ' + m.params.expectedTurnId } });
      out({ id: m.id, result: { turnId: turn } });
      const t = m.params.input[0].text;
      out({ method: 'item/started', params: { threadId: m.params.threadId, turnId: turn, item: { type: 'userMessage', id: 'u' + m.id, clientId: m.params.clientUserMessageId, content: [{ type: 'text', text: t }] } } });
      out({ method: 'item/agentMessage/delta', params: { threadId: m.params.threadId, turnId: turn, itemId: 'a1', delta: ' ack:' + t } });
      if (/finish/.test(t)) {
        out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: turn, status: 'completed' } } });
        turn = null;
      }
      return;
    }
    case 'turn/interrupt':
      out({ id: m.id, result: {} });
      out({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: turn, status: 'interrupted' } } });
      turn = null;
      return;
    case 'test/state': return out({ id: m.id, result: { initialized, log } });
    default: return out({ id: m.id, error: { code: -32601, message: 'unknown ' + m.method } });
  }
});
`;

function fakeBin(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-app-fake-'));
  const script = path.join(dir, 'server.js');
  fs.writeFileSync(script, FAKE_SERVER);
  const bin = path.join(dir, 'codex');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}"\n`, { mode: 0o755 });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { bin, dir };
}

async function openFake(t, extraEnv = {}) {
  const { bin, dir } = fakeBin(t);
  const s = await as.CodexAppSession.open({ bin, cwd: dir, env: { ...process.env, ...extraEnv }, agentName: 'test', version: '9.9.9' });
  t.after(() => s.close());
  return s;
}

test('session: handshake, new thread, resume, resume fallback', async (t) => {
  const s = await openFake(t);
  const st = await s.client.request('test/state', {});
  assert.strictEqual(st.initialized, true);
  assert.deepStrictEqual(st.log.slice(0, 2), ['initialize', 'initialized']);

  assert.deepStrictEqual(await s.openThread({ cwd: '/w', instructions: 'x' }), { threadId: 'th-new', resumed: false });
  assert.deepStrictEqual(await s.openThread({ resumeId: 'th-old', cwd: '/w' }), { threadId: 'th-old', resumed: true });
  const fb = await s.openThread({ resumeId: 'gone', cwd: '/w' });
  assert.strictEqual(fb.threadId, 'th-new');
  assert.strictEqual(fb.resumed, false);
  assert.match(fb.resumeError, /thread not found/);
});

test('session: open() rejects when the app-server dies at start', async (t) => {
  const { bin, dir } = fakeBin(t);
  await assert.rejects(
    as.CodexAppSession.open({ bin, cwd: dir, env: { ...process.env, FAKE_MODE: 'die' }, agentName: 'test' }),
    /exited \(code 3\).*cannot start/,
  );
});

test('session: server requests are refused, turn runs to completion', async (t) => {
  const s = await openFake(t);
  await s.openThread({ cwd: '/w' });
  const actions = [];
  const r = await s.runTurn({ input: as.turnInput('quick'), onAction: (a) => actions.push(a) });
  assert.deepStrictEqual(r, { status: 'completed', error: null });
  assert.ok(actions.some((a) => a.kind === 'text' && a.text === 'working'));
  assert.ok(actions.some((a) => a.kind === 'usage' && a.perTurn));
  assert.strictEqual(s.steerable, false);
  const st = await s.client.request('test/state', {});
  assert.ok(st.log.includes('reply:900'), 'approval request got an answer');
});

test('session + pump: an interjection is steered into the running turn and the turn ends', async (t) => {
  const s = await openFake(t);
  await s.openThread({ cwd: '/w' });
  const q = [{ message: 'please finish' }];
  const delivered = [];
  const pump = new as.SteerPump({ session: s, drain: () => q.splice(0), format: (i) => i.message, onDelivered: (i) => delivered.push(i.message) });
  let text = '';
  const r = await s.runTurn({
    input: as.turnInput('long job'),
    onAction: (a) => { if (a.kind === 'text') text += a.text; if (a.kind === 'user_message') pump.onUserMessage(a); },
    onStarted: () => pump.start(),
  });
  assert.strictEqual(r.status, 'completed');
  assert.deepStrictEqual(delivered, ['please finish']);
  assert.match(text, /ack:please finish/);
  assert.deepStrictEqual(await pump.finish(), []);
  // after the turn, steer is refused locally (no running turn)
  const late = await s.steer('too late');
  assert.deepStrictEqual([late.ok, late.refused], [false, true]);
});

test('session: a steer against a finished turn id is a refusal', async (t) => {
  const s = await openFake(t);
  await s.openThread({ cwd: '/w' });
  // Pretend a turn is still running after the server finished it.
  await s.runTurn({ input: as.turnInput('quick'), onAction: () => {} });
  s.turnId = 'turn-1';
  const r = await s.steer('hello');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.refused, true);
  s.turnId = null;
});

test('session: abort sends turn/interrupt and the turn ends interrupted', async (t) => {
  const s = await openFake(t);
  await s.openThread({ cwd: '/w' });
  const ac = new AbortController();
  const r = await s.runTurn({ input: as.turnInput('long job'), onAction: () => {}, signal: ac.signal, onStarted: () => setTimeout(() => ac.abort(), 20) });
  assert.strictEqual(r.status, 'interrupted');
  const st = await s.client.request('test/state', {});
  assert.ok(st.log.includes('turn/interrupt'));
});

test('session: the process exiting mid-turn fails the turn and pending requests', async (t) => {
  const s = await openFake(t);
  await s.openThread({ cwd: '/w' });
  const r = await s.runTurn({ input: as.turnInput('long job'), onAction: () => {}, onStarted: () => process.kill(s.client.child.pid, 'SIGKILL') });
  assert.strictEqual(r.status, 'failed');
  assert.match(r.error, /exited/);
  await assert.rejects(s.client.request('test/state', {}), /not running/);
});
