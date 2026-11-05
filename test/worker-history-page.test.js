'use strict';
// The worker history panel on the desktop page: a new search, filter or caller drops answers meant for the old view;
// more pages never drop a run being opened; a slower "Open full run" never takes the screen from a later one, nor
// from a chat the person went to meanwhile. The page code runs here against stand-ins.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function extract(src, name) {
  let at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  if (src.slice(at - 6, at) === 'async ') at -= 6;
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const decl = app.slice(app.indexOf('    const workerHistory = {'), app.indexOf('\n', app.indexOf('    const workerHistory = {')));

function page() {
  const pending = [];   // [url, resolve, reject]
  const env = { opened: [], chats: {}, renders: 0, activeChat: 'c1' };
  env.filesApi = (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject }));
  env.whRender = () => { env.renders++; };
  env.document = { getElementById: (id) => (id === 'wh-list' ? {} : null) };
  env.switchToChat = (id) => { env.opened.push(id); env.activeChat = id; try { api.workerHistory.openSeq++; } catch {} };
  for (const n of ['renderWorkerChatPanel', 'appendMessage', 'updateMessageWithTools', 'appendSystemNotice', 'setStatus']) env[n] = () => 'm1';
  env.workerKindLabel = (x) => x; env.fmtWorkerClock = () => '0:01';
  const body = `const { filesApi, whRender, document, switchToChat, renderWorkerChatPanel, appendMessage, updateMessageWithTools, appendSystemNotice, setStatus, workerKindLabel, fmtWorkerClock, chats } = env;
    let activeChat = env.activeChat;
    ${decl}
    let whSeq = 0;
    ${['whLoad', 'whFetchRun', 'whOpenRun'].map(n => extract(app, n)).join('\n')}
    return { workerHistory, whLoad, whFetchRun, whOpenRun };`;
  const api = new Function('env', body)(env);
  const answer = (match, data) => { const i = pending.findIndex(p => p.url.includes(match)); assert.ok(i >= 0, `a request for ${match}`); const [p] = pending.splice(i, 1); p.resolve(data); };
  return { env, api, pending, answer };
}
const tick = () => new Promise(r => setImmediate(r));
const run = (wid, prompt) => ({ ok: true, worker: { workerId: wid, caller: 'maestro', description: wid, prompt, outcome: 'done', answer: `${wid} answer` }, rows: [{ kind: 'system', tool: 'worker', text: prompt }] });

test('a new search drops the old view\'s answers; more pages do not drop a run being opened', async () => {
  const { api, answer, pending } = page();
  api.workerHistory.caller = 'maestro';
  api.whLoad(true);
  answer('/api/agents/maestro/workers', { ok: true, workers: [{ workerId: 'a', caller: 'maestro' }], next: 'x|maestro|1' });
  await tick(); await tick();
  // a run is being fetched while the next page loads: both land
  const fetching = api.whFetchRun({ caller: 'maestro', workerId: 'a' });
  api.whLoad(false);
  answer('before=', { ok: true, workers: [{ workerId: 'b', caller: 'maestro' }], next: null });
  await tick();
  answer('/workers/a', run('a', 'brief a'));
  assert.strictEqual((await fetching).worker.workerId, 'a');
  assert.ok(api.workerHistory.runs.has('maestro|a'), 'kept after another page loaded');
  assert.deepStrictEqual(api.workerHistory.items.map(w => w.workerId), ['a', 'b']);
  // a new search while a page and a run are on their way: neither old answer is shown
  api.whLoad(false);   // nothing more: no request
  const late = api.whFetchRun({ caller: 'maestro', workerId: 'c' });
  api.workerHistory.q = 'needle';
  api.whLoad(true);
  answer('/workers/c', run('c', 'brief c'));
  assert.strictEqual(await late, null, 'meant for the old view');
  assert.ok(!api.workerHistory.runs.has('maestro|c'));
  answer('q=needle', { ok: true, workers: [{ workerId: 'n', caller: 'maestro' }], next: null });
  await tick(); await tick();
  assert.deepStrictEqual(api.workerHistory.items.map(w => w.workerId), ['n']);
  assert.strictEqual(pending.length, 0);
});

test('a slower "Open full run" never takes the screen from a later one, or from a chat the person went to', async () => {
  const { api, env, answer } = page();
  api.workerHistory.caller = 'maestro';
  const openA = api.whOpenRun({ caller: 'maestro', workerId: 'A', description: 'A' });
  const openB = api.whOpenRun({ caller: 'maestro', workerId: 'B', description: 'B' });
  answer('/workers/B', run('B', 'brief B'));
  await openB;
  answer('/workers/A', run('A', 'brief A'));
  await openA;
  assert.strictEqual(env.opened.length, 1, 'only the later open took the screen');
  assert.match(env.opened[0], /^whist-/);
  assert.strictEqual(env.chats[env.opened[0]].workerId, 'B');
  // open C, then go to a chat before it arrives: C never takes the screen
  const openC = api.whOpenRun({ caller: 'maestro', workerId: 'C', description: 'C' });
  env.switchToChat('c1');
  answer('/workers/C', run('C', 'brief C'));
  await openC;
  assert.deepStrictEqual(env.opened.slice(1), ['c1']);
  // the full brief comes from the run, not from the list's short copy
  const openD = api.whOpenRun({ caller: 'maestro', workerId: 'D', description: 'D', prompt: 'short' });
  answer('/workers/D', run('D', 'the whole brief, every word'));
  await openD;
  assert.strictEqual(env.chats[env.opened[env.opened.length - 1]].workerId, 'D');
});

test('two fetches of one worker (expand, then Open full run): the newer answer stays, an older one arriving later does not replace it', async () => {
  const { api, pending } = page();
  api.workerHistory.caller = 'maestro';
  const w = { caller: 'maestro', workerId: 'r' };
  const older = api.whFetchRun(w, { fresh: true });
  const newer = api.whFetchRun(w, { fresh: true });
  const done = { ...run('r', 'brief'), worker: { ...run('r', 'brief').worker, outcome: 'done', answer: 'final answer' } };
  const running = { ...run('r', 'brief'), worker: { ...run('r', 'brief').worker, outcome: null, answer: null } };
  // the second request answers first (finished), then the first one's older snapshot arrives
  assert.strictEqual(pending.length, 2);
  const [first, second] = pending.splice(0, 2);
  second.resolve(done); await newer;
  first.resolve(running); await older;
  assert.strictEqual(api.workerHistory.runs.get('maestro|r').worker.answer, 'final answer');
});
