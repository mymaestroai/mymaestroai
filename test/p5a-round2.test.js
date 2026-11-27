'use strict';
// Phase 5a round 2: the monthly cap on every paid call outside the gateway, fail-closed reads, a cap lowered below the spend;
// Stop: the admission races, jobs refused while halted, the one resume pacer, release without resumeHub, research "delivering",
// merged counts after a restart, worker names, and the lead's texts. Throwaway install: nothing under the real data/ is touched.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('p5a2-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const read = (rel) => fs.readFileSync(path.join(inst.lib, rel), 'utf8');
const sdk = L('sdk-chat');
const hubHalt = L('hub-halt').getHubHalt();
const { createLedger } = L('ledger');
const { createImageGen } = L('image-gen');
const { createWebSearch } = L('web-search');
const { createClassifier } = L('classifier');
const { createResumePacer } = L('resume-pacer');
const { ScheduledTasks } = L('scheduled-tasks');
const { JobRunner } = L('jobs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p5a2-'));
after(() => { try { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); } catch {} fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
const CAP = 'Your monthly pay-per-use cap of $50 is used up ($51 spent since Nov 1). X uses a pay-per-use model, so it can\'t answer until Dec 1 or until you raise the monthly cap in Settings.';
const T0 = Date.parse('2026-11-20T12:00:00Z');

// ── cap 1: paid calls outside the gateway ─────────────────────────────────────────────────────────────
test('image-gen: once the cap is used up nothing is sent and the cap sentence is the error', async () => {
  let fetched = 0;
  const gen = createImageGen({ fetchImpl: async () => { fetched++; return { ok: false, status: 500, json: async () => ({}) }; }, getProviderKey: () => 'k', spendRefusal: () => CAP });
  for (const provider of ['openai', 'google']) await assert.rejects(gen.generate({ agentName: 'a', root: tmp, prompt: 'a cat', provider }), (e) => e.message === CAP);
  assert.equal(fetched, 0);
  const open = createImageGen({ fetchImpl: async () => { fetched++; return { ok: false, status: 500, json: async () => ({}) }; }, getProviderKey: () => 'k', spendRefusal: () => null });
  await assert.rejects(open.generate({ agentName: 'a', root: tmp, prompt: 'a cat', provider: 'openai' }), /refused/);
  assert.equal(fetched, 1, 'without the cap the request is sent');
});

test('web search: paid backends are skipped at the cap (the cap sentence is the result), the free ones still answer', async () => {
  const hosts = [];
  const fetchImpl = async (url) => { hosts.push(new URL(String(url)).hostname); return { ok: true, status: 200, headers: new Map(), text: async () => '<html></html>' }; };
  const mk = (spendRefusal, order) => createWebSearch({ getSetting: (k) => ({ webSearch: { order, keys: { brave: 'k', serper: 'k', tavily: 'k' } } })[k], getProviderKey: () => 'k', fetchImpl, spendRefusal, dataDir: fs.mkdtempSync(path.join(tmp, 'ws')), log: () => {} });
  const paid = mk((a) => (['brave', 'serper', 'tavily', 'perplexity'].includes(a.provider) ? CAP : null), ['brave', 'serper', 'tavily', 'perplexity']);
  const r = await paid.search('hub');
  assert.equal(r.results.length, 0);
  assert.equal(paid.render(r), CAP, 'a refused search returns the cap sentence as the tool result');
  assert.ok(!hosts.some((h) => /brave|serper|tavily|perplexity/.test(h)), `no paid request was sent: ${hosts}`);
  hosts.length = 0;
  const free = mk(() => CAP, ['brave', 'duckduckgo']);   // everything "paid" refused; DuckDuckGo is free and is still tried
  await free.search('hub');
  assert.ok(hosts.includes('lite.duckduckgo.com'), 'the free fallback is still tried');
});

test('classifier: the Perplexity decision call is not sent at the cap', async () => {
  let fetched = 0;
  const cl = createClassifier({ getSetting: (k) => ({ autoClassifier: { backend: 'perplexity' } })[k], getProviderKey: () => 'k', fetchImpl: async () => { fetched++; return { ok: false, status: 500 }; }, log: () => {}, spendRefusal: () => CAP });
  await cl.classify({ text: 'hello there', agent: 'a' }).catch(() => null);
  assert.equal(fetched, 0);
});

test('the other direct paid fetches are gated: Mythos (Anthropic), the Perplexity key test, the Anthropic model probe', () => {
  const mythos = read('mythos-client.js');
  assert.equal([...mythos.matchAll(/require\('\.\/spend-gate'\)\.refusal\(\{ provider: 'anthropic'/g)].length, 2, 'both Mythos entry points');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), /require\('\.\/lib\/spend-gate'\)\.refusal\(\{ provider: 'perplexity', model: 'perplexity\/sonar' \}\)/);
  assert.match(read('model-discovery.js'), /async function probeAnthropicModel\(modelId, apiKey\) \{\s+try \{\s+if \(require\('\.\/spend-gate'\)\.refusal/);
});

// ── cap 2 and 3 ─────────────────────────────────────────────────────────────────────────────────────
test('fail closed: a cap is set and the month cannot be read -> refused with the safety sentence; no cap -> the ledger is never opened', () => {
  const bad = path.join(tmp, 'notadir');
  fs.writeFileSync(bad, 'x');   // a file where the ledger's folder should be: the database cannot open
  const l = createLedger({ file: path.join(bad, 'ledger.db'), now: () => T0, getCaps: () => ({ monthlyUsd: 50, monthlyResetDay: 1 }), getZone: () => 'UTC', stateFile: null });
  const g = l.monthlyGate({ provider: 'anthropic', agent: 'Scout' });
  assert.equal(g.refused, true);
  assert.equal(g.text, "Your Maestro could not read this month's spending, so pay-per-use calls are paused for safety. Agents on a subscription or on this computer keep working.");
  assert.equal(l.monthlyGate({ provider: 'claude-sdk', agent: 'Scout' }), null, 'a plan agent keeps working');
  const dir = fs.mkdtempSync(path.join(tmp, 'nc'));
  const none = createLedger({ file: path.join(dir, 'ledger.db'), now: () => T0, getCaps: () => ({}), getZone: () => { throw new Error('zone must not be read'); }, stateFile: null });
  assert.equal(none.monthlyGate({ provider: 'anthropic', agent: 'a' }), null);
  assert.ok(!fs.existsSync(path.join(dir, 'ledger.db')), 'no cap: the database was not even opened');
});

test('the ledger has an index on turns(ts)', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ix'));
  const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => T0, getCaps: () => ({}), stateFile: null });
  l.record({ agent: 'a', model: 'anthropic/x', costUsd: 1 });
  const Database = require('better-sqlite3');
  const db = new Database(path.join(dir, 'ledger.db'), { readonly: true });
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='turns_ts'").get());
  db.close();
});

test('lowering the cap below what is already spent: the cap counts as reached now, so a turn already running finishes', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'lo'));
  const clock = { t: T0 }; const c = { v: { monthlyUsd: 100, monthlyResetDay: 1 } };
  const l = createLedger({ file: path.join(dir, 'ledger.db'), now: () => clock.t, getCaps: () => c.v, getZone: () => 'UTC', stateFile: null });
  l.record({ agent: 'a', model: 'anthropic/claude-sonnet-5-5', costUsd: 60 });
  clock.t += 3600000;
  const running = clock.t - 1000;           // a turn that began before the owner lowers the cap
  c.v = { monthlyUsd: 50, monthlyResetDay: 1 };
  assert.equal(l.monthlyGate({ provider: 'anthropic', agent: 'Scout', turnStartedAt: running }), null, 'the running turn finishes');
  assert.equal(l.capReachedAt(), clock.t, 'reached at the moment of the change, not at the old row');
  clock.t += 1000;
  assert.equal(l.monthlyGate({ provider: 'anthropic', agent: 'Scout', turnStartedAt: clock.t }).refused, true, 'a new turn is refused');
});

// ── stop 4: admission races (source order: the re-check sits after the last await and before the registration) ──
test('admission: chat, spawn_workers and consults re-check the halt right before they register', () => {
  const s = read('sdk-chat.js');
  const chat = s.slice(s.indexOf('async function handleChatStreamReserved'));
  const recheck = chat.indexOf('Stop all agents may have arrived while the checks above were awaited');
  const log = chat.indexOf('console.log(`[chat] ${agent}:');
  const register = chat.indexOf('turnRegistry.set(agent, turnTrack)');
  assert.ok(recheck > 0 && recheck < log && log < register);
  assert.ok(!/\bawait\b/.test(chat.slice(chat.indexOf('if (hubHalt', recheck), register).replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|`[^`\n]*`/g, '')), 'no await between the re-check and the registration');
  const sw = s.slice(s.indexOf('async function runSpawnWorkers'));
  assert.ok(sw.indexOf('arrived while the catalogue was read') > sw.indexOf('refreshWorkerCatalog()') && sw.indexOf('arrived while the catalogue was read') < sw.indexOf('temporalWorkers.runWorkers('));
  const cv = s.slice(s.indexOf('async function consultViaHub('));
  assert.ok(cv.indexOf('after the awaited access check') > cv.indexOf('await consultAllowed') && cv.indexOf('after the awaited access check') < cv.indexOf('pendingConsults.set(String(workerId)'));
});

// ── stop 5: jobs ────────────────────────────────────────────────────────────────────────────────────
test('jobs: a Stop that arrives while run() is still checking refuses the job', async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'jb'));
  const halted = { v: null };
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 100, log: () => {}, notify: async () => {}, isAgentActive: () => false, agentExists: async () => true, defaultCwd: async () => dataDir,
    haltRefusal: () => halted.v, boxFor: async () => { halted.v = 'hub is halted'; return null; } });   // the Stop lands during the awaited checks
  runner.start();
  try { await assert.rejects(runner.run({ owner: 'maestro', name: 'late', command: 'sleep 5' }), /halted/); assert.equal(runner.list(null).length, 0); }
  finally { runner.stop(); }
});

// ── stop 6 and 7: one pacer, saved from the last actual dispatch; a halt that ends without resumeHub ────────
test('resume pacer: one at a time, 30 s from the last actual dispatch, saved on disk, silent when no window is open', () => {
  const file = path.join(tmp, 'pacer.json'); const c = { t: T0 };
  const p = createResumePacer({ file, now: () => c.t });
  assert.equal(p.take('x'), 0); assert.ok(!fs.existsSync(file), 'no window: nothing is written');
  p.add(['a', 'b', 'c']);
  assert.equal(p.take('a'), 0, 'the first goes at once');
  c.t += 10000;
  assert.equal(p.take('b'), 20000, 'the second waits for what is left of 30 s');
  assert.equal(p.take('c'), 20000, 'asking again does not move the clock');
  const restarted = createResumePacer({ file, now: () => c.t });   // a restart (or a suspend) in between
  assert.equal(restarted.take('b'), 20000, 'the last dispatch time was saved');
  c.t += 20000; assert.equal(restarted.take('b'), 0);
  c.t += 30000; assert.equal(restarted.take('c'), 0);
  assert.equal(restarted.isOpen(), false, 'every released item has gone: the window closes');
  assert.equal(restarted.take('c'), 0);
});

test('job notices and the consult queue wait for the same pacer', async () => {
  const dataDir = fs.mkdtempSync(path.join(tmp, 'pn')); const c = { t: T0 };
  const woke = [];
  const pacer = createResumePacer({ file: path.join(dataDir, 'resume-pacer.json'), now: () => c.t });
  const runner = new JobRunner({ dataDir, spawnMode: 'setsid', pollMs: 600000, now: () => c.t, log: () => {}, isAgentActive: () => false, agentExists: async () => true, pacer,
    notify: async (agent, message) => { woke.push({ agent, at: c.t }); } });
  runner.pending.push({ kind: 'result', jobId: 'j1', agent: 'a', message: 'one', attempts: 0, notBefore: 0 }, { kind: 'result', jobId: 'j2', agent: 'b', message: 'two', attempts: 0, notBefore: 0 });
  pacer.add(['job:j1:result', 'job:j2:result']);
  await runner._deliver();
  assert.equal(woke.length, 1, 'only one notice goes out');
  c.t += 31000; await runner._deliver();
  assert.equal(woke.length, 2); assert.ok(woke[1].at - woke[0].at >= 30000);
  assert.equal(runner.pendingCount(), 0);
  const s = read('sdk-chat.js');
  assert.match(s, /resumePacer\(\)\.take\(pacedId\)/);
  assert.match(s, /if \(pacedWaitMs > 0\) drainConsultQueue\(pacedWaitMs \+ 200\)/);
  assert.match(s, /pacer\.add\(ids\)/, 'Resume opens the window with the job notices and queued consults it released');
});

test('scheduled tasks: a halt that ends without resumeHub still releases the held tasks, and the pace survives a restart', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'ts')); const clock = { t: T0 }; const refusal = { v: null }; const woken = [];
  const mk = () => new ScheduledTasks({ dataDir: dir, tz: 'America/New_York', now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 600000, agentExists: async () => true, isAgentActive: () => false,
    haltRefusal: () => refusal.v, notify: async (agent, message, onReply, meta) => { woken.push({ at: clock.t, taskId: meta && meta.taskId }); } });
  const st = mk();
  const a = await st.create({ requester: 'alice', when: 'in 1 hour', prompt: 'first' });
  const b = await st.create({ requester: 'bob', when: 'in 2 hours', prompt: 'second' });
  refusal.v = 'hub is halted'; clock.t = T0 + 5 * 3600000; await st.tick();
  assert.equal(st.heldList().length, 2);
  refusal.v = null;                         // the flag file was deleted by hand: resumeHub never ran
  await st.tick();
  assert.deepEqual(woken.map((w) => w.taskId), [a.id], 'the tick released them and sent the first');
  const again = mk();                        // a restart 5 s later: the 30 s is still measured from the first dispatch
  clock.t += 5000; await again.tick();
  assert.equal(woken.length, 1, 'too soon after the last actual dispatch');
  clock.t += 26000; await again.tick();
  assert.deepEqual(woken.map((w) => w.taskId), [a.id, b.id]);
  st.stop(); again.stop();
});

// ── stop 8, 9 ────────────────────────────────────────────────────────────────────────────────────────
const noJobs = { cancelAll: () => [], list: () => [], haltView: () => ({ kept: [], cancelling: [] }) };
test('stop-status: a research run that is delivering is listed as still finishing, not as stopped', () => {
  sdk.haltHub('r', { jobRunner: noJobs, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
  try {
    const s = sdk.stopStatus({ jobRunner: noJobs, scheduledTasks: { heldList: () => [] }, schedulerStatus: () => ({ pausedWhileStopped: 0 }),
      researchRunner: { listActive: () => [{ id: 'r1', agent: 'alpha', state: 'delivering' }, { id: 'r2', agent: 'beta', state: 'running' }] } });
    assert.deepEqual(s.finishing.research, [{ id: 'r1', agent: 'alpha' }]);
  } finally { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); }
});

test('a new Stop after a restart adds to the counts saved in the halt file; workers are named by their label and model', () => {
  hubHalt.halt('before the restart', 'Owner');
  hubHalt.setCounts({ agents: 2, workers: 1, jobs: 3, research: 1 });   // what the first Stop saved; this process has no lastStop (as after a restart)
  try {
    sdk.haltHub('again', { jobRunner: { cancelAll: () => ['j9'], list: () => [{ id: 'j9', name: 'n', owner: 'o' }], haltView: () => ({ kept: [], cancelling: [] }) }, researchRunner: { stopAll: () => [] }, stopAgentTurn: () => ({ ok: true }) });
    const saved = JSON.parse(fs.readFileSync(hubHalt.file, 'utf8')).counts;
    assert.deepEqual([saved.agents, saved.workers, saved.jobs, saved.research], [2, 1, 4, 1], 'merged, not overwritten');
  } finally { sdk.resumeHub({ scheduledTasks: { release: () => 0 } }); }
  assert.match(read('sdk-chat.js'), /abortController\.label = v && v\.label \? `\$\{v\.label\}\$\{v\.model \? ` \(\$\{v\.model\}\)` : ''\}`/, 'a worker is named as spawn_workers names it');
  assert.ok(!/worker \$\{stoppedWorkers\}/.test(read('sdk-chat.js')), 'no "worker N"');
});

// ── stop 10: the lead's texts ───────────────────────────────────────────────────────────────────────
test('lead tool texts: kept jobs are named, and nothing says "ask me to resume"', () => {
  const s = read('settings-tool.js');
  assert.match(s, /\$\{names\.length\} job\$\{names\.length === 1 \? '' : 's'\} marked keep \$\{names\.length === 1 \? 'stays' : 'stay'\} running: \$\{names\.join\(', '\)\}\./);
  assert.match(s, /To resume, press Resume in Settings > Emergency or on the red banner\./);
  assert.ok(!/ask me to resume/.test(s));
  assert.match(s, /question = `Stop all agents\? [^`]*\$\{kept \? ` \$\{kept\}` : ''\}`/, 'the Stop card names them too');
});
