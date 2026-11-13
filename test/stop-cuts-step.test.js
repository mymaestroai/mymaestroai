'use strict';
// Stop cuts the running step: a turn's abort signal reaches the shell command that turn is running (host shell,
// sandbox box, hub hands, MCP wrapper, gateway tool executor), kills the whole process group at once and the tool
// answers "Stopped by the person." Nothing here starts a server, a container or a real model turn.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHubTools, runShell } = require('../lib/hub-tools');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stop-step-'));
async function until(fn, ms = 3000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(25); } return false; }

test('runShell: an abort kills the command and its background child within 3 seconds and says aborted', async () => {
  const d = tmp();
  const pidFile = path.join(d, 'grandchild.pid');
  const ac = new AbortController();
  const started = Date.now();
  const p = runShell(`sleep 30 & echo $! > '${pidFile}'; sleep 30`, { cwd: d, timeoutMs: 60000, signal: ac.signal });
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()), 'the background child started');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  assert.ok(alive(grandchild));
  ac.abort();
  const r = await p;
  assert.strictEqual(r.aborted, true);
  assert.strictEqual(r.timedOut, false);
  assert.ok(Date.now() - started < 3000, `answered in ${Date.now() - started} ms`);
  assert.ok(await until(() => !alive(grandchild)), 'the background child is gone too');
  fs.rmSync(d, { recursive: true, force: true });
});

test('runShell: an already aborted signal never starts the command; the abort listener is removed when the child ends', async () => {
  const spawnImpl = () => { throw new Error('must not start'); };
  const ac = new AbortController(); ac.abort();
  const r = await runShell('echo hi', { signal: ac.signal, spawnImpl });
  assert.strictEqual(r.aborted, true);

  let added = 0, removed = 0;
  const fake = { aborted: false, addEventListener: () => { added++; }, removeEventListener: () => { removed++; } };
  const ok = await runShell('echo done', { signal: fake });
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(ok.aborted, false);
  assert.deepStrictEqual([added, removed], [1, 1]);
  assert.strictEqual((await runShell('echo plain')).aborted, false, 'no signal: as before');
});

test('Bash: Stop returns "Stopped by the person." plus the output so far, and the command is dead', async () => {
  const d = tmp();
  const t = createHubTools({ cwd: d, log: () => {} });
  const ac = new AbortController();
  const pidFile = path.join(d, 'bash.pid');
  const p = t.call('Bash', { command: `echo partial; echo $$ > '${pidFile}'; sleep 30`, timeout: 60000 }, { signal: ac.signal });
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()));
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  const started = Date.now();
  ac.abort();
  const r = await p;
  assert.ok(Date.now() - started < 3000);
  assert.match(r.text, /^Stopped by the person\./);
  assert.match(r.text, /partial/);
  assert.ok(await until(() => !alive(pid)));
  // without a signal nothing changes
  assert.strictEqual((await t.call('Bash', { command: 'echo fine' })).text, 'fine');
  fs.rmSync(d, { recursive: true, force: true });
});

test('hands.tools.call passes { signal } to the tool; a boxed Bash hands it to sandbox.exec and reports the stop', async () => {
  const seen = [];
  const ac = new AbortController();
  const box = { mounts: ['/tmp'], exec: async (cmd, o) => { seen.push(o); return { stdout: 'so far\n', stderr: '', code: null, aborted: true }; } };
  const t = createHubTools({ cwd: '/tmp', sandbox: box, log: () => {} });
  const r = await t.call('Bash', { command: 'sleep 99', timeout: 5000 }, { signal: ac.signal });
  assert.strictEqual(seen[0].signal, ac.signal);
  assert.strictEqual(r.text, 'Stopped by the person.\nso far');
  // no signal given: the options carry none (as before)
  seen.length = 0;
  box.exec = async (cmd, o) => { seen.push(o); return { stdout: 'x', stderr: '', code: 0 }; };
  await t.call('Bash', { command: 'ls', timeout: 5000 });
  assert.ok(!('signal' in seen[0]));
});

test('sandbox exec: the command runs as a recorded process-group leader and an abort kills that group inside the box', async () => {
  const { createSandbox } = require('../lib/sandbox');
  const calls = [];
  let hang = null, hangs = true;
  const docker = async (args, opts) => {
    calls.push({ args, opts });
    if (hangs && args[0] === 'exec' && args.includes('setsid')) { await new Promise((resolve) => { hang = resolve; }); return { stdout: '', stderr: '' }; }
    if (args[0] === 'inspect') return { stdout: 'running\n', stderr: '' };
    return { stdout: '', stderr: '' };
  };
  const dir = tmp();
  const creds = path.join(dir, 'c.json'); fs.writeFileSync(creds, '{}');
  const sb = createSandbox({ docker, wrapperDir: path.join(dir, 'w'), credentialsFile: creds, uid: 1000, gid: 1000, log: () => {}, workspaceFor: (a) => path.join(dir, 'ws', a.name), isMemberOwned: () => true, rootsFor: () => [dir] });
  const agent = { name: 'boxed', owner: 'sam', model: 'claude-sdk/claude-haiku-5-5' };
  fs.mkdirSync(path.join(dir, 'ws', 'boxed'), { recursive: true });
  const ac = new AbortController();
  const p = sb.exec(agent, 'sleep 100', { timeoutMs: 60000, signal: ac.signal });
  assert.ok(await until(() => calls.some(c => c.args.includes('setsid'))));
  const run = calls.find(c => c.args.includes('setsid'));
  assert.deepStrictEqual(run.args.slice(0, 8), ['exec', '-w', path.join(dir, 'ws', 'boxed'), 'hub-agent-boxed', 'setsid', '-w', 'bash', '-c']);
  assert.strictEqual(run.args[run.args.length - 1], 'sleep 100', 'the command is the last argument ($0 of the wrapper)');
  const script = run.args[8];
  const pidFile = (script.match(/echo \$\$ > (\/tmp\/\.hub-exec-[0-9a-f]+\.pid)/) || [])[1];
  assert.ok(pidFile, 'the leader records its pid in the box');
  assert.match(script, /bash -lc "\$0"/);
  assert.strictEqual(run.opts.signal, ac.signal, 'the local docker client gets the signal too');
  assert.ok(!calls.some(c => c.args.includes('sh') && c.args.includes('-c') && /kill/.test(c.args.join(' '))), 'no kill before the abort');

  const started = Date.now();
  ac.abort();
  const r = await p;
  assert.ok(Date.now() - started < 1000, 'exec answers at once, it does not wait for the grace period');
  assert.deepStrictEqual([r.aborted, r.code], [true, null]);
  const kill = calls.find(c => c.args[0] === 'exec' && c.args[2] === 'bash' && c.args[3] === '-c' && String(c.args[4]).includes('kill -TERM'));
  assert.ok(kill, 'the in-box kill ran');
  assert.deepStrictEqual(kill.args.slice(0, 4), ['exec', 'hub-agent-boxed', 'bash', '-c'], 'bash: dash kill rejects "--" before a group id');
  assert.ok(kill.args[4].includes(pidFile) && /kill -TERM -- -\$p/.test(kill.args[4]) && /sleep 2/.test(kill.args[4]) && /kill -KILL -- -\$p/.test(kill.args[4]) && /rm -f/.test(kill.args[4]), kill.args[4]);
  if (hang) hang();
  hangs = false;

  // a command that is not aborted is not killed
  calls.length = 0;
  const ok = await sb.exec(agent, 'echo hi', { signal: new AbortController().signal });
  assert.strictEqual(ok.code, 0);
  assert.ok(!calls.some(c => c.args[2] === 'sh'), 'no kill without an abort');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('raceStop: a tool that ignores Stop is answered at once; values and errors pass through; no listener is left behind', async () => {
  const { raceStop } = require('../lib/sdk-chat');
  const ac = new AbortController();
  const never = new Promise(() => {});
  const p = raceStop(never, ac.signal);
  ac.abort();
  assert.strictEqual(await p, 'Stopped by the person.');
  assert.strictEqual(await raceStop(never, ac.signal), 'Stopped by the person.', 'already aborted');
  const live = new AbortController();
  assert.strictEqual(await raceStop(Promise.resolve('result'), live.signal), 'result');
  await assert.rejects(raceStop(Promise.reject(new Error('tool failed')), live.signal), /tool failed/);
  assert.strictEqual(await raceStop(Promise.resolve('x'), null), 'x', 'no signal: the promise itself');
  let added = 0, removed = 0;
  const fake = { aborted: false, addEventListener: () => { added++; }, removeEventListener: () => { removed++; } };
  await raceStop(Promise.resolve('y'), fake);
  assert.deepStrictEqual([added, removed], [1, 1]);
});

test('buildHandsMcpServer: the MCP tool wrapper passes the turn signal to hands.tools.call', async () => {
  const { buildHandsMcpServer } = require('../lib/sdk-chat');
  const got = [];
  const turnTools = {
    specs: () => [{ name: 'Bash', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    call: async (name, args, opts) => { got.push({ name, args, opts }); return { text: 'done' }; },
  };
  const sdk = { tool: (name, desc, shape, handler) => ({ name, handler }), createSdkMcpServer: (o) => o };
  const ac = new AbortController();
  const server = buildHandsMcpServer(sdk, turnTools, { signal: ac.signal });
  const out = await server.tools[0].handler({ command: 'ls' });
  assert.strictEqual(got[0].opts.signal, ac.signal);
  assert.deepStrictEqual(out.content[0], { type: 'text', text: 'done' });
});

test('wiring in lib/sdk-chat.js: handsForTurn takes the turn signal at its three call sites; the gateway wrapper and executor use it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(src, /async function handsForTurn\(agentName, \{ consultationDepth = 0, signal = null \} = \{\}\)/);
  assert.ok(src.includes('await handsForTurn(agentName, { consultationDepth, signal })'), 'gateway');
  assert.strictEqual(src.split('await handsForTurn(agentName, { consultationDepth: options.consultationDepth || 0, signal: abortController.signal })').length - 1, 2, 'Claude client and Codex');
  assert.ok(src.includes('hands.tools.call(name, args || {}, { signal })'), 'gateway hands wrapper');
  assert.strictEqual(src.split('signal: abortController.signal });').length - 1 >= 2, true);
  assert.ok(src.includes('hands.tools, { blocked: blockedTools, signal: abortController.signal }'), 'Claude client MCP server');
  assert.ok(src.includes('sdkDisallowedFor(twVirtual.toolScope) : [], signal: abortController.signal }'), 'Codex MCP server');
  assert.ok(src.includes('await raceStop(invoke(), signal)'), 'the gateway tool executor races every tool against Stop');
});
