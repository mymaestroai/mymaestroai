'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const recovery = require('../lib/tiger-team-recovery');
const artifacts = require('../lib/tiger-team-artifacts');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-preserve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new recovery.CheckpointStore(dir);
  const state = { id: 'team', status: 'running', calls: { a: { key: 'a', agent: 'part', tools: {} } } };
  return { dir, store, state };
}

test('SIGKILL after acknowledged journal writes preserves text, tool deltas, results and raw artifacts', async t => {
  const { dir, store } = fixture(t);
  const modulePath = require.resolve('../lib/tiger-team-recovery');
  const code = `
    const { CheckpointStore } = require(${JSON.stringify(modulePath)});
    const store = new CheckpointStore(${JSON.stringify(dir)});
    const state = { id:'team', status:'running', calls:{a:{key:'a', agent:'part', tools:{done:{name:'Read', status:'completed', result:'FULL'.repeat(10000)}}}} };
    store.save('team', state);
    const artifact = store.artifact('team', 'raw'.repeat(100000));
    store.append('team', state, {type:'artifact', artifact});
    store.append('team', state, {type:'model_chunk',callKey:'a',chunk:{choices:[{delta:{content:'Durable 🧪 text'}}]}});
    store.append('team', state, {type:'model_chunk',callKey:'a',chunk:{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'{"partial":'}}]}}]}});
    process.send('acknowledged'); setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let err = ''; child.stderr.on('data', b => err += b);
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('Child exited: ' + err); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const restored = store.read('team');
  assert.equal(restored.calls.a.partialText, 'Durable 🧪 text');
  assert.equal(restored.calls.a.fullResponse, 'Durable 🧪 text');
  assert.equal(restored.calls.a.tools.done.result.length, 40000);
  const events = [...store.events('team')];
  assert.equal(events.at(-1).chunk.choices[0].delta.tool_calls[0].function.arguments, '{"partial":');
  assert.equal(store.readArtifact('team', events[0].artifact.hash), 'raw'.repeat(100000));
  store.save('team', restored);
  assert.equal(store.read('team').calls.a.fullResponse, 'Durable 🧪 text', 'replay must not duplicate checkpointed deltas');
});

test('partial unacknowledged journal tail is repaired without losing committed events', t => {
  const { dir, store, state } = fixture(t);
  store.save('team', state);
  store.append('team', state, { type: 'model_chunk', callKey: 'a', chunk: { choices: [{ delta: { content: 'first' } }] } });
  fs.appendFileSync(path.join(dir, 'team.events.jsonl'), '{"torn');
  const restored = store.read('team');
  store.append('team', restored, { type: 'model_chunk', callKey: 'a', chunk: { choices: [{ delta: { content: ' second' } }] } });
  assert.equal(store.read('team').calls.a.fullResponse, 'first second');
  assert.equal([...store.events('team')].length, 2);
});

test('journal refuses corrupt committed records rather than silently dropping evidence', t => {
  const { dir, store, state } = fixture(t); store.save('team', state);
  fs.writeFileSync(path.join(dir, 'team.events.jsonl'), '{bad}\n');
  assert.throws(() => store.read('team'), SyntaxError);
});

test('queued directives survive session replacement; storage failure is not acknowledged', t => {
  const { store, state } = fixture(t);
  recovery.attachSession(state, {});
  recovery.queueDirective(store, 'team', state, 'Keep this instruction');
  const restored = recovery.restore(store.read('team'));
  recovery.attachSession(restored, { pendingMessages: [] });
  assert.deepEqual(restored.session.pendingMessages, ['Keep this instruction']);
  assert.equal(restored.userDirectives[0].message, 'Keep this instruction');
  assert.throws(() => recovery.queueDirective({ save() { throw new Error('disk full'); } }, 'team', restored, 'not acknowledged'), /disk full/);
  assert.deepEqual(restored.pendingMessages, ['Keep this instruction']);
});

test('unresolved outcomes block follow-up until explicit verified reconciliation', t => {
  const { store, state } = fixture(t);
  state.calls.a.tools.x = { name: 'Write', status: 'in_flight', arguments: '{"file":"a"}' };
  assert.throws(() => recovery.requireReconciled(state), { code: 'TT_RECONCILIATION_REQUIRED' });
  assert.throws(() => recovery.reconcile(state, { callKey: 'a', toolId: 'x', result: 'verified', evidence: '' }), /evidence/);
  recovery.reconcile(state, { callKey: 'a', toolId: 'x', result: 'File verified on disk', evidence: 'Operator inspected file hash' });
  store.save('team', state);
  assert.doesNotThrow(() => recovery.requireReconciled(store.read('team')));
  assert.equal(store.read('team').calls.a.tools.x.reconciliation.evidence, 'Operator inspected file hash');
});

test('paged artifact retrieval reconstructs exact full evidence and rejects paths/checksum changes', t => {
  const { store, state, dir } = fixture(t);
  const text = 'Evidence 🧪\n'.repeat(30000);
  const item = store.artifact('team', text);
  let result = '', offset = 0;
  do { const page = recovery.archivePage(store, 'team', state, { artifact: item.hash, offset, limit: 17001 }); result += page.text; offset = page.next_offset; } while (offset !== null);
  assert.equal(result, text);
  assert.throws(() => store.readArtifact('team', '../secret'), /Invalid/);
  const file = path.join(dir, 'team.artifacts', item.hash + '.txt');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, 'changed');
  assert.throws(() => store.readArtifact('team', item.hash), /checksum/);
});

test('artifact context isolates parallel calls and fails closed on storage errors', async () => {
  const first = [], second = [];
  await Promise.all([
    artifacts.run({ preserve: value => first.push(value) }, async () => { await new Promise(r => setImmediate(r)); artifacts.preserve('first', 'test'); }),
    artifacts.run({ preserve: value => second.push(value) }, async () => { artifacts.preserve('second', 'test'); }),
  ]);
  assert.deepEqual(first, ['first']); assert.deepEqual(second, ['second']);
  assert.equal(artifacts.preserve('normal', 'test'), 'normal');
  assert.throws(() => artifacts.run({ preserve() { throw new Error('disk full'); } }, () => artifacts.preserve('no ack')), { code: 'TT_PERSISTENCE_FAILED' });
});

test('pre-truncation Read and Bash outputs are retained, with ordinary preview bounds unchanged', async t => {
  const { dir } = fixture(t);
  const { BUILTIN_TOOLS } = require('../lib/provider-tools');
  const file = path.join(dir, 'long.txt'); const text = 'X'.repeat(70000); fs.writeFileSync(file, text);
  const captured = [];
  const context = { preserve(value, label) { captured.push({ value, label }); } };
  const read = await artifacts.run(context, () => BUILTIN_TOOLS.Read.handler({ file_path: file }));
  assert.ok(read.length < text.length);
  assert.ok(captured.some(c => c.label.startsWith('Read:full:') && c.value.endsWith(text)));
  const bash = await artifacts.run(context, () => BUILTIN_TOOLS.Bash.handler({ command: `cat '${file}'` }));
  assert.ok(bash.length < text.length);
  assert.ok(captured.some(c => c.label === 'Bash:success' && c.value === text));
  await assert.rejects(artifacts.run({ preserve() { throw new Error('disk full'); } }, () => BUILTIN_TOOLS.Read.handler({ file_path: file })), { code: 'TT_PERSISTENCE_FAILED' });
});

test('actual production tool loop survives SIGKILL after displayed text and reuses durable tool work', async t => {
  const { dir, store } = fixture(t);
  const harnessPath = path.join(__dirname, 'tiger-team-tool-loop.test.js');
  const prefix = fs.readFileSync(harnessPath, 'utf8').split('\nconst tool = ')[0];
  const recoveryPath = require.resolve('../lib/tiger-team-recovery');
  const body = `
    const store = new (require(${JSON.stringify(recoveryPath)}).CheckpointStore)(${JSON.stringify(dir)});
    const h = harness(n => ({events: n === 1
      ? [{choices:[{delta:{tool_calls:[{index:0,id:'saved-op',function:{name:'Write',arguments:'{}'}}]},finish_reason:'tool_calls'}]}]
      : [{choices:[{delta:{content:'Already displayed partial'},finish_reason:null}]}]}), {Write: async()=> 'Durable tool result'});
    const state = h.ctx.activeTigerTeams.get('tt');
    h.ctx.ttStore = store; h.ctx.checkpointTeam = () => store.save('tt', state);
    h.ctx.sendSSE = (res, event) => {
      if (event.content === 'Already displayed partial') {
        process.send('displayed'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
      }
    };
    h.run().catch(e=>{console.error(e);process.exit(1)});
  `;
  const script = `const {createRequire}=require('node:module'); new Function('require','__dirname',${JSON.stringify(prefix + body)})(createRequire(${JSON.stringify(harnessPath)}),${JSON.stringify(__dirname)});`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = ''; child.stderr.on('data', b => stderr += b);
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(stderr); })]);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  const state = store.read('tt');
  assert.equal(state.calls['coord-call'].partialText, 'Already displayed partial');
  assert.equal(state.calls['coord-call'].tools['saved-op'].result, 'Durable tool result');
  const { createRequire } = require('node:module');
  const resume = new Function('require', '__dirname', prefix + '\nreturn harness;')(createRequire(harnessPath), __dirname);
  let repeats = 0;
  const h = resume(() => ({ events: [{ choices: [{ delta: { content: ' and continued' }, finish_reason: 'stop' }] }] }), { Write: async () => { repeats++; return 'BAD'; } });
  Object.assign(h.call, state.calls['coord-call']);
  assert.equal(await h.run(), 'Already displayed partial and continued');
  assert.equal(repeats, 0);
  assert.ok(h.requests[0].some(m => m.role === 'tool' && m.content === 'Durable tool result'));
});
