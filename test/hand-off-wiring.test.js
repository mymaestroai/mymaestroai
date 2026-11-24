'use strict';
// Hand-offs, the hub side (lib/sdk-chat, lib/hand-off-tools, lib/scheduled-tasks, lib/jobs, lib/voice/call): the tools,
// who gets them, how a target's turns and continuations belong to one hand-off, and the long-wait record. The runner
// itself is tested in test/hand-offs.test.js. Throwaway install and temp folders: nothing under the real data/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('hand-off-wiring-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SDK = read('lib/sdk-chat.js');
const tools = require('../lib/hand-off-tools');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(50); } return false; }

function fakeRunner() {
  const calls = [];
  return {
    calls,
    create: async (o) => { calls.push(['create', o]); return { id: 'ho-0000abcd', target: o.target, topic: o.topic, state: 'queued', folder: '/files/scout/hand-offs/lead-site' }; },
    listShown: async (caller, o) => { calls.push(['listShown', caller, o]); return [{ id: 'ho-0000abcd', target: 'scout', topic: 'site', state: 'running', folder: '/f', turns: 2, queuedNotes: 1, status: 'Step 3 of 5\nnext: tests' }, { id: 'ho-0000abce', target: 'scout', topic: 'other', state: 'done', folder: '/g', turns: 1, queuedNotes: 0, status: null }]; },
    note: (o) => { calls.push(['note', o]); return { id: o.id, target: 'scout', state: 'running', queuedNotes: 0 }; },
    cancel: (o) => { calls.push(['cancel', o]); return { id: o.id, target: 'scout', topic: 'site', folder: '/f', state: 'cancelled' }; },
  };
}

test('hand_off: refusals (no agent, itself, a temporary worker, not a consultable agent) start nothing; a yes creates it with the member flag', async () => {
  const r = fakeRunner();
  const deps = (allow, member = false) => ({ runner: r, mayTarget: async () => allow, isVirtual: (n) => n.startsWith('tw-'), member });
  assert.match(await tools.runTool('hand_off', {}, 'lead', deps(true)), /Say which agent/);
  assert.match(await tools.runTool('hand_off', { agent: 'lead', topic: 't', brief: 'b' }, 'lead', deps(true)), /yourself/);
  assert.match(await tools.runTool('hand_off', { agent: 'tw-1', topic: 't', brief: 'b' }, 'lead', deps(true)), /temporary worker/);
  assert.match(await tools.runTool('hand_off', { agent: 'scout', topic: 't', brief: 'b' }, 'lead', deps(false)), /only to agents you may consult/);
  assert.equal(r.calls.length, 0);
  const out = await tools.runTool('hand_off', { agent: 'scout', topic: 'site', brief: 'build it' }, 'sam_main', deps(true, true));
  assert.deepEqual(r.calls[0], ['create', { caller: 'sam_main', target: 'scout', topic: 'site', brief: 'build it', member: true }]);
  assert.match(out, /^Handed off to scout \(id ho-0000abcd\): queued: it starts as soon as that agent is free\./);
  assert.match(out, /STATUS\.md current/);
  assert.match(out, /You are free/);
  // the runner's refusal comes back as the tool's text
  const bad = { ...fakeRunner(), create: async () => { throw new Error('You have 5 hand-offs open (queued or running). Wait for one to finish or cancel one.'); } };
  assert.match(await tools.runTool('hand_off', { agent: 'scout', topic: 'x', brief: 'y' }, 'lead', { runner: bad, mayTarget: async () => true }), /5 hand-offs open/);
});

test('hand_off_list, hand_off_note, hand_off_cancel: plain text from the runner, STATUS.md shown, the caller passed through', async () => {
  const r = fakeRunner();
  const d = { runner: r, mayTarget: async () => true };
  const list = await tools.runTool('hand_off_list', { include_done: 'true' }, 'lead', d);
  assert.deepEqual(r.calls[0], ['listShown', 'lead', { includeDone: true, withStatus: true }]);   // review r2: what the caller may be shown
  assert.match(list, /ho-0000abcd to scout: "site", running, 2 steps so far, 1 note waiting\./);
  assert.match(list, /STATUS\.md:\n {4}Step 3 of 5\n {4}next: tests/);
  assert.match(list, /ho-0000abce to scout: "other", done, 1 step so far\.\n {2}Folder: \/g\n {2}STATUS\.md: not written yet\./);
  assert.match(await tools.runTool('hand_off_note', { id: ' ho-0000abcd ', text: 'use blue' }, 'lead', d), /Note delivered to scout/);
  assert.deepEqual(r.calls[1], ['note', { caller: 'lead', id: 'ho-0000abcd', text: 'use blue' }]);
  assert.match(await tools.runTool('hand_off_cancel', { id: 'ho-0000abcd' }, 'lead', d), /^Cancelled ho-0000abcd \("site"\): scout's running step was stopped/);
  assert.match(await tools.runTool('hand_off_list', {}, 'lead', { ...d, runner: { ...r, listShown: async () => [] } }), /^No hand-offs\.$/);
  assert.equal(tools.jsonSchema(tools.TOOL_SPECS[0]).required.join(','), 'agent,topic,brief');
  assert.deepEqual(tools.jsonSchema(tools.TOOL_SPECS[1]).required, []);
});

test('hand-off authorization is checked when any of the registered tool handlers is called', () => {
  const fn = SDK.match(/function handOffOffered\(agentName, consultationDepth\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(consultationDepth !== 0 \|\| temporalWorkers\.isVirtual\(agentName\)\) return false;/);
  assert.match(fn, /return rec\.category === 'primary' \|\| require\('\.\/agents'\)\.isLeadAgent\(agentName, /);
  assert.match(SDK, /function runHandOffTool\(name, args, agentName, consultationDepth\) \{\n  if \(!handOffOffered\(agentName, consultationDepth\)\) return Promise\.resolve\('Hand-offs can only be started from your own turn\.'\);/);
  assert.match(SDK, /mayTarget: \(caller, target\) => consultAllowed\(caller, target\),/, 'the consult_agent rule, unchanged');
  assert.match(SDK, /member: isMemberTurn\(agentName\),\n  \}\);/);
});

test('the target\'s turns: consult depth (a consultation\'s tool exclusions) with origin.handOff and never consulted_by; workers and consults stay open to it', () => {
  const factory = SDK.slice(SDK.indexOf('function getHandOffRunner() {'), SDK.indexOf("voiceCall.registerProducer('hand_off'"));
  assert.match(factory, /origin: \{ kind: 'hand_off', from: origin\.from, handOff: origin\.handOffId, label: origin\.label, \.\.\.\(origin\.member \? \{ member: true \} : \{\}\) \},\n\s+body: \{ consultation_depth: 1 \},/);
  assert.doesNotMatch(factory, /consulted_by/);
  assert.match(factory, /deliver: \(agent, message, meta\) => wakeAgent\(agent, message, null, \{\n\s+kind: 'hand_off_report', from: meta\.from, handOffReport: meta\.handOffId,/);
  assert.match(factory, /holds: \(agent, r\) => voiceCall\.holds\(agent, \{ id: `hand_off:\$\{r\.id\}:\$\{r\.state\}`, kind: 'hand_off',/);
  // a continuation's wake-up (its schedule_task or job notice) is the hand-off's turn too
  assert.match(SDK, /const handOff = typeof meta\?\.handOff === 'string' && \/\^ho-\[0-9a-f\]\{8\}\$\/\.test\(meta\.handOff\) \? meta\.handOff : null;/);
  assert.match(SDK, /handleChatStream\(\{ agent: agentName, message, origin, exclude_tools: meta\?\.exclude_tools, \.\.\.\(handOff \? \{ consultation_depth: 1 \} : \{\}\) \}, sink\)/);
  assert.match(SDK, /if \(handOff && admitted\) handOffHook\('ended', handOff, chunks\.join\(''\), agentName\);/);
  assert.match(SDK, /admitted = true; if \(handOff\) handOffHook\('started', handOff, null, agentName\);/);
  // review r1: a continuation of a hand-off that is over, or not this agent's, is stopped
  assert.match(SDK, /if \(r\.turnStarted\(id, agent\) === false\) \{ [^\n]*stopAgentTurn\(agent\); \}/);
  // the handler records the turn's hand-off while it runs, and only for a well-formed id
  assert.match(SDK, /if \(turnOrigin && typeof turnOrigin\.handOff === 'string' && \/\^ho-\[0-9a-f\]\{8\}\$\/\.test\(turnOrigin\.handOff\)\) \{ handOffTurnAgents\.set\(agent, turnOrigin\.handOff\); handOffMarked = turnOrigin\.handOff; \}/);
  assert.match(SDK, /if \(handOffMarked && handOffTurnAgents\.get\(agent\) === handOffMarked\) handOffTurnAgents\.delete\(agent\);/);
  // the gateway's depth guard lets a hand-off turn use workers and consult (it is the target's own work)
  assert.match(SDK, /if \(consultationDepth >= 1 && !handOffOfTurn\(agentName\)\) return '\[BLOCKED\] Workers cannot spawn further workers/);
  assert.match(SDK, /if \(consultationDepth >= 1 && !handOffOfTurn\(agentName\)\) \{\n\s+return '\[BLOCKED\] Cannot consult another agent/);
  // schedule_task and run_job carry the turn's hand-off from the hub's context, on both paths
  assert.equal((SDK.match(/\{ consultedBy, member: isMemberTurn\(agentName\), handOff: handOffOfTurn\(agentName\) \}/g) || []).length, 4);
  // origin is a hub-only field: no request can set handOff itself
  assert.match(read('server.js'), /const HUB_ONLY_CHAT_FIELDS = \[[^\]]*'origin'/);
});

test('continuations: a task made in a hand-off turn is tagged (never from arguments) and its run says so; a job too, its result notice tagged and its report to another agent not', async () => {
  const st = L('scheduled-tasks');
  process.env.HUB_TZ = 'America/New_York';
  L('timezone')._setDeps({ auth: { admins: () => [], getUser: () => null }, agents: () => [] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-st-'));
  const clock = { t: Date.parse('2026-09-29T18:00:00Z') };
  const woken = [];
  const inst = new st.ScheduledTasks({ dataDir: dir, now: () => clock.t, log: () => {}, retryMs: 1000, pollMs: 60000, agentExists: async () => true, isAgentActive: () => false, notify: async (agent, message, onReply, meta) => { woken.push(meta); } });
  const spec = st.TOOL_SPECS.find(s => s.name === 'schedule_task');
  const a = JSON.parse(await st.runTool(inst, spec, 'scout', { when: 'in 5 minutes', prompt: 'continue' }, { handOff: 'ho-0000abcd' }));
  const b = JSON.parse(await st.runTool(inst, spec, 'scout', { when: 'in 5 minutes', prompt: 'x', handOff: 'ho-0000ffff' }, {}));
  const c = JSON.parse(await st.runTool(inst, spec, 'scout', { when: 'in 5 minutes', prompt: 'y' }, { handOff: 'not-an-id' }));
  assert.equal(a.handOff, 'ho-0000abcd'); assert.equal(b.handOff, undefined); assert.equal(c.handOff, undefined);
  clock.t += 6 * 60000; await inst.tick();
  const byTask = Object.fromEntries(woken.map(w => [w.taskId, w]));
  assert.equal(byTask[a.id].handOff, 'ho-0000abcd'); assert.equal(byTask[b.id].handOff, undefined);
  fs.rmSync(dir, { recursive: true, force: true });

  const { JobRunner, TOOL_SPECS, runTool } = L('jobs');
  const jd = fs.mkdtempSync(path.join(os.tmpdir(), 'ho-jobs-'));
  const notes = [];
  const runner = new JobRunner({ dataDir: jd, spawnMode: 'setsid', pollMs: 100, retryMs: 150, log: () => {}, notify: async (agent, message, onReply, meta) => { notes.push({ agent, meta }); }, isAgentActive: () => false, agentExists: async () => true, defaultCwd: async () => jd, mayReport: async () => ({ ok: true }) });
  runner.start();
  const js = TOOL_SPECS.find(s => s.name === 'run_job');
  const j = JSON.parse(await runTool(runner, js, 'scout', { name: 'build', command: 'sleep 0.3', report_to: 'lead' }, { handOff: 'ho-0000abcd' }));
  assert.equal(runner.openFor('ho-0000abcd').length, 1, 'running: open');
  assert.equal(runner.openFor('ho-0000ffff').length, 0);
  assert.ok(await until(() => notes.length >= 1), 'notice delivered');
  const result = notes.find(n => n.meta.kind === 'job_notice');
  assert.equal(result.agent, 'scout'); assert.equal(result.meta.handOff, 'ho-0000abcd');
  assert.ok(await until(() => runner.openFor('ho-0000abcd').length === 0), 'closed once its notice is out');
  runner.stop();
  void j;
  fs.rmSync(jd, { recursive: true, force: true });
  // the report to another agent never carries the hand-off (source: the meta line)
  assert.match(read('lib/jobs.js'), /\.\.\.\(j && j\.handOff && p\.kind !== 'report' \? \{ handOff: j\.handOff \} : \{\}\),/);
});

test('voice calls: a hand-off turn or report waits while the person is on a call with that agent; skipping means after the call', () => {
  const src = read('lib/voice/call.js');
  assert.match(src, /const HELD_KINDS = new Set\(\[[^\]]*'hand_off'[^\]]*\]\);/);
  assert.match(src, /const LATER_ON_SKIP = new Set\(\[[^\]]*'hand_off'[^\]]*\]\);/);
  assert.match(SDK, /voiceCall\.registerProducer\('hand_off', \{ kick: \(\) => \{ try \{ getHandOffRunner\(\)\.tick\(\); \} catch \{\} \} \}\);/);
});

test('the hub starts the runner at start-up (a hand-off whose turn died is reported) and the cards\' route uses it', () => {
  const server = read('server.js');
  assert.match(server, /try \{ require\('\.\/lib\/sdk-chat'\)\.getHandOffRunner\(\)\.start\(\); \} catch \(e\) \{ console\.error\('\[hand-offs\] could not start:'/);
  assert.match(server, /const handOffs = await require\('\.\/lib\/sdk-chat'\)\.getHandOffRunner\(\)\.listShown\(name, \{ includeDone: false, withStatus: false \}\);/);   // review r2
  assert.match(read('lib/hand-offs.js'), /r\.report = \{ kind: 'interrupted', state: 'pending', attempts: 0, deliveredAt: null \};\n\s+\/\/ its scheduled continuations[^\n]*\n\s+try \{ this\.cancelContinuations\(r\.id\); \}/);
});

test('long waits: recorded only for a primary agent on its own turn past the setting, never a lead, a worker or a temporary one; both tools on both paths', () => {
  const fn = SDK.match(/function noteLongWait\(agentName, tool, startedMs, consultationDepth\) \{[\s\S]*?\n\}/)[0];
  assert.match(fn, /if \(consultationDepth !== 0 \|\| temporalWorkers\.isVirtual\(agentName\)\) return;/);
  assert.match(fn, /const limit = lw\.thresholdMinutes\(require\('\.\/settings'\)\.getSetting\);\n\s+if \(!limit\) return;/);
  assert.match(fn, /if \(!rec \|\| rec\.category !== 'primary' \|\| require\('\.\/agents'\)\.isLeadAgent\(agentName, all\)\) return;/);
  assert.equal((SDK.match(/noteLongWait\(agentName, 'spawn_workers', waitStart, consultationDepth\)/g) || []).length, 2);
  assert.equal((SDK.match(/noteLongWait\(agentName, 'consult_agent', waitStart, consultationDepth\)/g) || []).length, 2);
});

test('the rule text (behaviour change hand-off-guidance): primary agents only, its build partner by name, the lead also builds partners', () => {
  const wp = require('../lib/work-practices');
  const primary = { category: 'primary' };
  assert.equal(wp.textFor({ agent: primary }), '');
  const withPartner = wp.textFor({ agent: primary, handOffs: true, partner: 'kiln' });
  assert.match(withPartner, /## LONG WORK: HAND IT OFF\n- Never wait on long work inside your own turn\. Anything longer than a few minutes \(development, production, long research\) goes to your build partner, kiln \(or another teammate\), with hand_off; you stay free to talk with the person you work for\./);
  assert.doesNotMatch(withPartner, /no build partner/);
  assert.match(wp.textFor({ agent: primary, handOffs: true, leadName: 'boss' }), /You have no build partner yet: if long work keeps coming back, ask boss for one \(consult_agent\)\./);
  assert.match(wp.textFor({ agent: primary, handOffs: true, member: true }), /ask for one with request_agent/);
  assert.match(wp.textFor({ agent: primary, handOffs: true, isLead: true }), /also create its build partner and write this rule into both agents' files \(AGENT-PLAYBOOK\.md, "Build partners"\)/);
  assert.equal(wp.textFor({ agent: { category: 'worker' }, handOffs: true }), '', 'not for a worker');
  assert.match(SDK, /const partner = typeof rec\.buildPartner === 'string' && agents\.some\(a => a && a\.name === rec\.buildPartner\) \? rec\.buildPartner : '';/);
  const m = JSON.parse(read('templates/behaviour-changes.json'));
  const e = m.changes.find(c => c.id === 'hand-off-guidance');
  assert.ok(e && e.leadMay === true);
  for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(e[k] && e[k].length > 10, k);
});

test('labels: the target\'s chat shows "Task from <caller>"; the caller\'s shows the report, on both pages (a hand-off reads "task" on screen)', () => {
  const auto = require('../lib/ui-auto-turns.js');
  const info = (auto.autoInfoOf || (() => null));
  const a = info({ role: 'user', origin: { kind: 'hand_off', from: 'lead', label: 'Hand-off from lead: site' } });
  const b = info({ role: 'user', origin: { kind: 'hand_off_report', from: 'scout', label: 'Hand-off finished: site' } });
  if (a) { assert.equal(a.label, 'Task from lead: site'); assert.equal(b.label, 'Task finished: site'); }
  for (const page of ['app.js', 'mobile.js']) {
    const src = read(page);
    assert.match(src, /else if \(o\.kind === 'hand_off'\) label = o\.label \? o\.label\.replace\(\/\^Hand-off\\b\/, 'Task'\) : `Task from \$\{from \|\| 'another agent'\}`;/, page);
    assert.match(src, /case 'hand_off': return `task from \$\{origin\.from \|\| 'another agent'\}`;/, page);   // on screen a hand-off reads "task" (owner, 11-20)
  }
});

test('review r1: the runner checks identities, access and earlier deliveries; a hand-off turn never queues a consultation; the rule text is not given inside a hand-off turn', () => {
  const factory = SDK.slice(SDK.indexOf('function getHandOffRunner() {'), SDK.indexOf("voiceCall.registerProducer('hand_off'"));
  // the agent's identity (box id, or its name from before box ids), not the whole-record stamp: a model switch keeps the hand-off
  assert.match(factory, /stampOf: \(name\) => require\('\.\/agents'\)\.agentIdentity\(name\),/);
  assert.match(factory, /mayTarget: \(caller, target\) => consultAllowed\(caller, target\),/);
  assert.match(factory, /alreadyDelivered: \(caller, id\) => \{\n\s+for \(const l of tailLines\(path\.join\(CONV_DIR, `\$\{caller\}\.jsonl`\), 400\)\) \{\n\s+try \{ const e = JSON\.parse\(l\.text\); if \(e && e\.origin && e\.origin\.handOffReport === id\) return true; \} catch \{\}/);
  assert.match(SDK, /for \(const k of \['kind', 'from', 'by', 'label', 'for', 'jobName', 'taskId', 'handOff', 'handOffReport'\]\)/, 'the conversation log keeps the ids (and, since Build Team, the main agent a build_team turn is for)');
  assert.match(SDK, /if \(handOffOfTurn\(coordinatorName\)\) return resolve\(HAND_OFF_NO_QUEUE\(agentName, 'busy'\)\);/);
  assert.match(SDK, /if \(handOffOfTurn\(coordinatorName\)\) return HAND_OFF_NO_QUEUE\(agentName, 'on a voice call'\);/);
  assert.match(SDK, /handOffs = bc\.isOn\('hand-off-guidance'\) && !handOffOfTurn\(agentName\), ownCode = bc\.isOn\('own-code-guidance'\);/);
  // the only places a consultation is queued are those two gated ones
  assert.equal((SDK.match(/\.enqueue\(\{ from: coordinatorName/g) || []).length, 2, 'the 409 path and holdConsultForCall');
  assert.equal((SDK.match(/q\.enqueue\(\{ from: coordinatorName/g) || []).length, 1, 'holdConsultForCall');
});

test('review r2: a held task (after a restore, waiting on the owner) still counts as the hand-off\'s continuation', () => {
  assert.match(SDK, /t\.handOff === id && \(t\.status === 'active' \|\| t\.status === 'paused' \|\| t\.status === 'held' \|\| t\.queued\)/);
  // review r3: a failed lookup keeps the hand-off waiting (strict), never reads as nothing left
  assert.match(SDK, /hasContinuation: \(id\) => \{ const c = handOffContinuations\(id, \{ strict: true \}\);/);
  assert.match(SDK, /catch \(e\) \{ if \(strict\) throw e; return \[\]; \}/);
});

test('review r3: a continuation is authorised before its turn starts; skill tools stay out of a hand-off turn', () => {
  assert.match(SDK, /\(handOff \? Promise\.resolve\(\)\.then\(\(\) => getHandOffRunner\(\)\.mayContinue\(handOff, agentName\)\)\.catch\(\(\) => false\) : Promise\.resolve\(true\)\)\.then\(\(ok\) => \{\n\s+if \(!ok\) \{[^\n]*resolve\(\); \} reply\(''\); return; \}\n\s+handleChatStream\(/);
  assert.match(SDK, /if \(!handOffOfTurn\(agentName\)\) try \{\n\s+let exclude = null; try \{ exclude = connectorsLib\.getConnectors\(\)\.wrappedSkillIds\(\); \} catch \{\}\n\s+const skillResult = await getSkillTools/);
  // review r4: a throw in that step rejects the wake-up, never leaves it hanging
  assert.match(SDK, /\}\)\.catch\(\(e\) => \{ if \(!settled\) \{ settled = true; reject\(e\); \} \}\);   \/\/ review r4/);
});

test('wakeAgent: the reply callback runs once, even when it throws (the real function, run in a VM)', async () => {
  const vm = require('vm');
  const a = SDK.indexOf('function wakeAgent(');
  assert.ok(a > 0);
  const m = SDK.slice(a).match(/\n\}\n/);
  const src = SDK.slice(a, a + m.index + 2);
  const run = async ({ fail }) => {
    const errors = [];
    const ctx = {
      console: { log() {}, error: (...x) => errors.push(x.join(' ')) },
      Promise,
      getHandOffRunner: () => ({ mayContinue: async () => true }),
      handOffHook: () => {},
      // a turn that is admitted, streams one chunk and ends
      handleChatStream: async (body, sink) => { sink.writeHead(200); sink.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'done' } }] }) + '\n\n'); sink.end(); },
    };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.wakeAgent = wakeAgent;', ctx);
    const calls = [];
    const onReply = (t) => { calls.push(t); if (fail) throw new Error('reply handler broke'); };
    await ctx.wakeAgent('scout', 'hello', onReply, null);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    return { calls, errors };
  };
  const ok = await run({ fail: false });
  assert.deepEqual(ok.calls, ['done']);
  const bad = await run({ fail: true });
  assert.deepEqual(bad.calls, ['done'], 'a throwing reply handler is not called a second time');
  assert.ok(bad.errors.some((e) => /reply handler for scout failed: reply handler broke/.test(e)));
  assert.equal((src.match(/onReply\(/g) || []).length, 1, 'onReply is called only inside the guard');
});
