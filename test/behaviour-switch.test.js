'use strict';
// behaviour_change (lib/behaviour-switch): the lead switches a behaviour change only at the owner's request, in a turn a
// signed-in admin typed, after the owner's yes; page-only entries (security, spending) are refused; every change is
// logged and announced. Temp folders only: nothing under the install's data/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const bc = require('../lib/behaviour-changes');
const { createBehaviourSwitch, runTool, OWNER_ONLY, CHANGED, NOT_CONFIRMED, TURN_ENDED } = require('../lib/behaviour-switch');

const ROOT = path.join(__dirname, '..');

function mk({ entries, agents, auditFile, onAfter, failOn } = {}) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bsw-'));
  const stateFile = path.join(d, 'state.json');
  const ids = bc.manifest().map((e) => e.id);
  const start = entries || Object.fromEntries(ids.map((id) => [id, { state: 'pending', by: 'update', at: '2026-01-01T00:00:00.000Z' }]));
  fs.writeFileSync(stateFile, JSON.stringify({ entries: start }));
  const pushed = [];
  const guidance = [];
  const after = [];
  const roster = agents || [
    { name: 'maestro', lead: true, category: 'primary', box: 1 },
    { name: 'coach', category: 'primary', box: 2 },
    { name: 'sam_assistant', category: 'primary', owner: 'u-member', box: 3 },
  ];
  const sw = createBehaviourSwitch({
    changes: { list: () => bc.list({ stateFile }), decide: (id, dec, o) => bc.decide(id, dec, { ...o, stateFile }) },
    agents: () => roster,
    // stand-ins for agents.agentStamp and updateAgentField(..., { expectStamp }): the stamp is the box id, checked at the write
    stampOf: (n) => { const a = roster.find((x) => x.name === n); return a ? `box:${a.box}` : null; },
    setAgentGuidance: async (n, v, stamp, check) => {
      const a = roster.find((x) => x.name === n);
      if (!a || `box:${a.box}` !== stamp) return { success: false, error: 'The agent changed (removed and made again?), so nothing changed.' };
      const refusal = check(a); if (refusal) return { success: false, error: refusal };
      if (failOn === n) return { success: false, error: 'disk full' };
      guidance.push([n, v]); a.teamGuidance = v; return { success: true };
    },
    isMemberOwned: (a) => !!(a && a.owner && a.owner !== 'u-admin'),
    isVirtual: (n) => n.startsWith('tmp_'),
    afterChange: async (id) => { after.push(id); if (onAfter) await onAfter(id); },
    push: { notify: (payload, opts) => { pushed.push({ payload, opts }); } },
    auditFile: auditFile || path.join(d, 'log.jsonl'),
  });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8')).entries;
  const log = () => { try { return fs.readFileSync(auditFile || path.join(d, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { d, sw, state, log, pushed, guidance, after, roster, stateFile, cleanup: () => fs.rmSync(d, { recursive: true, force: true }) };
}
const yes = async () => true;

test('manifest: member-worker-models is page-only, every other entry may be switched by the lead', () => {
  const m = bc.manifest();
  assert.equal(m.length >= 7, true);
  for (const e of m) assert.equal(typeof e.leadMay, 'boolean', `${e.id} has leadMay`);
  assert.equal(m.find((e) => e.id === 'member-worker-models').leadMay, false);
  // protect-own-code is a security setting: only the owner decides it, on the page (lib/code-protect).
  assert.deepEqual(m.filter((e) => !e.leadMay).map((e) => e.id), ['member-worker-models', 'protect-own-code']);
});

test('a page-only entry is refused before any question, and nothing is written', async (t) => {
  const h = mk(); t.after(h.cleanup);
  let asked = 0;
  await assert.rejects(h.sw.on({ id: 'member-worker-models', by: 'maestro', confirm: async () => { asked++; return true; } }), (e) => e.message === OWNER_ONLY("Members' temporary workers use only the models you allow them") || /Only the owner can switch/.test(e.message));
  assert.equal(asked, 0);
  assert.equal(h.state()['member-worker-models'].state, 'pending');
  assert.deepEqual(h.log(), []);
  assert.equal(h.pushed.length, 0);
});

test('an entry without leadMay true is refused (fail closed)', async (t) => {
  const h = mk(); t.after(h.cleanup);
  const sw = createBehaviourSwitch({ changes: { list: () => [{ id: 'x-new', title: 'X', state: 'pending' }], decide: async () => { throw new Error('must not run'); } }, agents: () => [], push: { notify() {} }, auditFile: path.join(h.d, 'l2.jsonl') });
  await assert.rejects(sw.on({ id: 'x-new', by: 'maestro', confirm: yes }), /Only the owner can switch "X"/);
});

test('unknown id, no confirm, a no, a thrown answer: nothing changes, nothing is logged', async (t) => {
  const h = mk(); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'nope', by: 'maestro', confirm: yes }), /No behaviour change "nope"/);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro' }), (e) => e.message === NOT_CONFIRMED);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: async () => false }), (e) => e.message === NOT_CONFIRMED);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: async () => { throw new Error('gone'); } }), (e) => e.message === NOT_CONFIRMED);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: async () => 'yes' }), (e) => e.message === NOT_CONFIRMED, 'only a true answer counts');
  assert.equal(h.state()['work-check-ins'].state, 'pending');
  assert.deepEqual(h.log(), []);
  assert.equal(h.pushed.length, 0);
});

test('stillAllowed false after the answer: the turn-ended message, nothing changes', async (t) => {
  const h = mk(); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: yes, stillAllowed: () => false }), (e) => e.message === TURN_ENDED);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: yes, stillAllowed: () => { throw new Error('x'); } }), (e) => e.message === TURN_ENDED);
  assert.equal(h.state()['work-check-ins'].state, 'pending');
  assert.deepEqual(h.log(), []);
});

test('on: asked once, recorded as switched by the lead, logged requested then done (0600), one admin notice with the undo link', async (t) => {
  const h = mk(); t.after(h.cleanup);
  const questions = [];
  const r = await h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: async (q, label) => { questions.push([q, label]); return true; }, stillAllowed: () => true });
  assert.equal(r.state, 'on');
  assert.equal(questions.length, 1);
  assert.match(questions[0][0], /^maestro wants to turn on "/);
  assert.equal(questions[0][1], 'Turn on');
  const s = h.state()['work-check-ins'];
  assert.equal(s.state, 'on'); assert.equal(s.by, 'lead'); assert.equal(s.agent, 'maestro');
  assert.equal(bc.list({ stateFile: h.stateFile }).find((c) => c.id === 'work-check-ins').agent, 'maestro', 'the page can say who switched it');
  assert.deepEqual(h.log().map((l) => l.state), ['requested', 'done']);
  assert.equal(h.log()[0].entryBefore, 'pending'); assert.equal(h.log()[0].entryAfter, 'on'); assert.equal(h.log()[0].by, 'maestro');
  assert.equal(fs.statSync(path.join(h.d, 'log.jsonl')).mode & 0o777, 0o600);
  assert.equal(h.pushed.length, 1);
  assert.equal(h.pushed[0].opts.adminsOnly, true);
  assert.equal(h.pushed[0].payload.url, '/changes#work-check-ins');
  assert.match(h.pushed[0].payload.body, /^maestro turned on ".+" at your request\. Undo it at \/changes\.$/);
  assert.equal(h.pushed[0].opts.kind, 'security', 'announced like connector_access, not a kind that is easy to mute');
  assert.deepEqual(h.after, ['work-check-ins']);
});

test('off is confirmed with its own label; already so: no question, no log, no notice', async (t) => {
  const h = mk(); t.after(h.cleanup);
  let asked = 0;
  const r1 = await h.sw.off({ id: 'work-suggestions', by: 'maestro', confirm: async (q, label) => { asked++; assert.equal(label, 'Turn off'); return true; } });
  assert.equal(r1.state, 'off'); assert.equal(asked, 1);
  const r2 = await h.sw.off({ id: 'work-suggestions', by: 'maestro', confirm: async () => { asked++; return true; } });
  assert.equal(r2.unchanged, true); assert.equal(asked, 1);
  assert.equal(h.log().length, 2); assert.equal(h.pushed.length, 1);
});

test('worker-proposals: the weekly task is brought in line after the change', async (t) => {
  const h = mk(); t.after(h.cleanup);
  await h.sw.on({ id: 'worker-proposals', by: 'maestro', confirm: yes });
  assert.deepEqual(h.after, ['worker-proposals']);
});

test('team-guidance for named agents: the change turns on and each agent is switched; refusals for members, temporary workers, unknown names and other ids', async (t) => {
  const h = mk(); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['sam_assistant'], by: 'maestro', confirm: yes }), /belongs to a member/);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['tmp_w1'], by: 'maestro', confirm: yes }), /No agent named "tmp_w1"|temporary worker/);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['ghost'], by: 'maestro', confirm: yes }), /No agent named "ghost"/);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', agents: ['coach'], by: 'maestro', confirm: yes }), /only for team-guidance/);
  assert.deepEqual(h.guidance, []); assert.deepEqual(h.log(), []);
  const qs = [];
  const r = await h.sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: async (q) => { qs.push(q); return true; } });
  assert.equal(r.state, 'on'); assert.deepEqual(r.agents, ['coach']);
  assert.deepEqual(h.guidance, [['coach', 'on']]);
  assert.equal(h.state()['team-guidance'].state, 'on');
  // review r6 (GPT-6): the question says the change itself turns on too
  assert.match(qs[0], /for coach\. This also turns the change itself on: the lead and new agents get it too\. Turn it on\?$/);
  assert.match(h.pushed[0].payload.body, /^maestro turned on "[^"]+" and switched it on for coach at your request\. Undo it at \/changes\.$/);
  // with the change already on, naming an agent asks only about that agent
  const qs2 = [];
  h.roster.push({ name: 'helper', category: 'worker', box: 4 });
  await h.sw.on({ id: 'team-guidance', agents: ['helper'], by: 'maestro', confirm: async (q) => { qs2.push(q); return true; } });
  assert.doesNotMatch(qs2[0], /also turns the change itself on/);
  assert.match(h.pushed[1].payload.body, /^maestro switched "[^"]+" on for helper at your request/);
  // off for an agent leaves the change itself on
  await h.sw.off({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: yes });
  assert.deepEqual(h.guidance, [['coach', 'on'], ['helper', 'on'], ['coach', 'off']]);
  assert.equal(h.state()['team-guidance'].state, 'on');
});

test('a temporary worker is refused even when it shows in the roster', async (t) => {
  const h = mk({ agents: [{ name: 'maestro', lead: true, box: 1 }, { name: 'tmp_w1', box: 9 }] }); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['tmp_w1'], by: 'maestro', confirm: yes }), /temporary worker/);
});

test('rules are checked again after the answer: an agent replaced (same name, new box) or turned into a member\'s is refused', async (t) => {
  const h = mk(); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: async () => { h.roster[1].box = 22; return true; } }), (e) => e.message === CHANGED);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: async () => { h.roster[1].owner = 'u-member'; return true; } }), /belongs to a member/);
  assert.equal(h.state()['team-guidance'].state, 'pending');
  assert.deepEqual(h.guidance, []);
});

test('an unwritable log refuses the change; a failing change is logged as failed and nothing is announced', async (t) => {
  const h0 = mk(); t.after(h0.cleanup);
  const dirAsFile = path.join(h0.d, 'adir'); fs.mkdirSync(dirAsFile);
  const h = mk({ auditFile: dirAsFile }); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: yes }), /Couldn't record the change/);
  assert.equal(h.state()['work-check-ins'].state, 'pending');
  const h2 = mk(); t.after(h2.cleanup);
  fs.writeFileSync(h2.stateFile, '{not json');
  await assert.rejects(h2.sw.on({ id: 'work-check-ins', by: 'maestro', confirm: yes }), /could not be read/);
  assert.equal(h2.pushed.length, 0);
});

test('runTool: plain text; list marks the owner-only entry; unknown action', async (t) => {
  const h = mk(); t.after(h.cleanup);
  const list = await runTool(h.sw, { action: 'list' }, 'maestro', yes, () => true);
  assert.match(list, /member-worker-models \(.+\): pending \(only the owner switches this, on \/changes\)/);
  assert.match(list, /work-check-ins \(.+\): pending\n/);
  assert.match(await runTool(h.sw, { action: 'on', id: 'member-worker-models' }, 'maestro', yes, () => true), /Only the owner can switch/);
  assert.match(await runTool(h.sw, { action: 'on', id: 'work-check-ins' }, 'maestro', yes, () => true), /^Done\. work-check-ins is on\. The owner can undo it at \/changes\.$/);
  assert.match(await runTool(h.sw, { action: 'on', id: 'work-check-ins' }, 'maestro', yes, () => true), /^Nothing to change/);
  assert.equal(await runTool(h.sw, { action: 'grant' }, 'maestro', yes, () => true), 'Action must be list, on or off.');
});

// The offer: the same rule as connector_access (lib/sdk-chat), run here on its own source with stand-ins.
test('sdk-chat: behaviour_change is offered only with connector_access (the lead, in a turn a signed-in admin typed, depth 0) and re-checked at call time', () => {
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  const fn = sdk.match(/function connectorAccessOffered\(agentName, consultationDepth\) \{[\s\S]*?\n\}/)[0];
  const ctx = { ownerTurnAgents: new Set(['maestro', 'coach']), temporalWorkers: { isVirtual: (n) => n.startsWith('tmp_') }, require: () => ({ ownerLeadNames: () => ['maestro'] }) };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.offered = connectorAccessOffered;', ctx);
  assert.equal(ctx.offered('maestro', 0), true, 'the lead in the owner\'s own turn');
  assert.equal(ctx.offered('maestro', 1), false, 'a consult');
  assert.equal(ctx.offered('coach', 0), false, 'not a lead');
  ctx.ownerTurnAgents.delete('maestro');
  assert.equal(ctx.offered('maestro', 0), false, 'a hub-started turn (scheduled task, job, consult, mail) never marks the turn');
  // both tool lists put behaviour_change inside the connector_access gate, and the handler re-checks it
  const gated = sdk.split('...(connectorAccessOffered(agentName, consultationDepth)').slice(1).map((s) => s.slice(0, 1600));
  assert.equal(gated.length, 2);
  for (const g of gated) assert.match(g.split(': []),')[0], /behaviourSwitchLib\.TOOL\.name/);
  assert.equal((sdk.match(/behaviourSwitchLib\.TOOL\.name/g) || []).length, 3, 'the gateway list once, the SDK list twice (name and extras)');
  const body = sdk.match(/async function runBehaviourSwitch\([\s\S]*?\n\}/)[0];
  assert.match(body, /^async function runBehaviourSwitch\(agentName, sseRes, args, consultationDepth, signal\) \{\n  if \(!connectorAccessOffered\(agentName, consultationDepth\)\) return CONNECTOR_ACCESS_NOT_OFFERED;/);
  assert.match(body, /runAskUser\(agentName, sseRes, \{ question, options: \[yesLabel, 'Leave as is'\], header: 'Changes to how agents behave', adminOnly: true \}/);
  assert.match(body, /const stillAllowed = \(\) => connectorAccessOffered\(agentName, consultationDepth\) && !\(signal && signal\.aborted\);/);
});

test("the /changes page says the lead can switch a change at the owner's word, marks owner-only entries and names who switched one", () => {
  const page = fs.readFileSync(path.join(ROOT, 'changes.html'), 'utf8');
  assert.match(page, /or by telling your lead agent in chat \(it asks you to confirm\)\. Changes about security or spending limits can only be switched here\./);
  assert.doesNotMatch(page, /Nothing else can switch them on/);
  assert.match(page, /if \(c\.leadMay !== true\) el\.appendChild\(para\('Who can switch it', 'Only you, on this page\.'\)\);/);
  assert.match(page, /c\.by === 'lead' && c\.agent \? ' \(by ' \+ c\.agent \+ ' at your request\)'/);
});

test('review r6 (GPT-6): an agent replaced between the answer and the write is refused at the write itself', async (t) => {
  const h = mk(); t.after(h.cleanup);
  // the stamp read after the answer matches, then the agent is re-made just before its write
  let calls = 0;
  const sw = createBehaviourSwitch({
    changes: { list: () => bc.list({ stateFile: h.stateFile }), decide: (id, dec, o) => bc.decide(id, dec, { ...o, stateFile: h.stateFile }) },
    agents: () => h.roster,
    stampOf: (n) => { const a = h.roster.find((x) => x.name === n); return a ? `box:${a.box}` : null; },
    setAgentGuidance: async (n, v, stamp) => { calls++; return stamp === 'box:99' ? { success: true } : { success: false, error: 'The agent changed (removed and made again?), so nothing changed.' }; },
    isMemberOwned: () => false, isVirtual: () => false, afterChange: async () => {},
    push: { notify: (payload, opts) => h.pushed.push({ payload, opts }) },
    auditFile: path.join(h.d, 'log3.jsonl'),
  });
  await assert.rejects(sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: yes }), /The agent changed/);
  assert.equal(calls, 1);
});

test('review r6 (GPT-6): the change switched off while the owner answered is not turned on by an agent-only answer', async (t) => {
  const h = mk({ entries: { 'team-guidance': { state: 'on', by: 'owner', at: '2026-01-01T00:00:00.000Z' } } }); t.after(h.cleanup);
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: async () => { await bc.decide('team-guidance', 'off', { stateFile: h.stateFile }); return true; } }), (e) => e.message === CHANGED);
  assert.equal(h.state()['team-guidance'].state, 'off');
  assert.deepEqual(h.guidance, []);
});

test('review r6 (GPT-6): a failure part-way is logged with what was done, announced, and reported', async (t) => {
  const h = mk({ failOn: 'coach' }); t.after(h.cleanup);
  h.roster.push({ name: 'helper', category: 'worker', box: 4 });
  await assert.rejects(h.sw.on({ id: 'team-guidance', agents: ['helper', 'coach'], by: 'maestro', confirm: yes }),
    /Couldn't change coach: disk full\. Done before that: turned on "[^"]+" and switched it on for helper\. The owner can undo it at \/changes\.$/);
  assert.equal(h.state()['team-guidance'].state, 'on');
  const last = h.log().pop();
  assert.equal(last.state, 'failed'); assert.equal(last.entryDone, true); assert.deepEqual(last.agentsDone, ['helper']);
  assert.equal(h.pushed.length, 1);
  assert.match(h.pushed[0].payload.body, /^maestro turned on "[^"]+" and switched it on for helper; the rest failed\. Undo it at \/changes\.$/);
  assert.deepEqual(h.after, ['team-guidance']);
  // nothing done: logged as failed, nothing announced
  const h2 = mk({ failOn: 'coach', entries: { 'team-guidance': { state: 'on', by: 'owner', at: '2026-01-01T00:00:00.000Z' } } }); t.after(h2.cleanup);
  await assert.rejects(h2.sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: yes }), /Couldn't change coach: disk full$/);
  assert.equal(h2.pushed.length, 0);
  assert.equal(h2.log().pop().state, 'failed');
});

test('review r6 (Sentinel): member-worker-models stays page-only even if the manifest file said leadMay true', async (t) => {
  const h = mk(); t.after(h.cleanup);
  const sw = createBehaviourSwitch({ changes: { list: () => [{ id: 'member-worker-models', title: 'Limit', state: 'pending', leadMay: true }], decide: async () => { throw new Error('must not run'); } }, agents: () => [], push: { notify() {} }, auditFile: path.join(h.d, 'l4.jsonl') });
  await assert.rejects(sw.on({ id: 'member-worker-models', by: 'maestro', confirm: yes }), /Only the owner can switch "Limit"/);
});

test('agents.agentStamp and updateAgentField expectStamp (source): box id first, else a digest of the record; checked at the write', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'agents.js'), 'utf8');
  assert.match(src, /function stampOf\(rec\) \{\n  if \(!rec\) return null;\n  if \(rec\.box\) return `box:\$\{rec\.box\}`;/);
  assert.match(src, /if \(ctx\.expectStamp !== undefined && stampOf\(agent\) !== ctx\.expectStamp\) return \{ success: false/);
  const sw = fs.readFileSync(path.join(ROOT, 'lib', 'behaviour-switch.js'), 'utf8');
  assert.match(sw, /stampOf = \(name\) => require\('\.\/agents'\)\.agentStamp\(name\)/);
  assert.match(sw, /updateAgentField\(name, \{ teamGuidance: value \}, \{ expectStamp: stamp, check \}\)/);
  assert.match(src, /if \(typeof ctx\.check === 'function'\) \{\n    let refusal;\n    try \{ refusal = ctx\.check\(agent\); \} catch \{ refusal = "Couldn't check the agent, so nothing changed\."; \}/);
});

test('review r7 (GPT-6): an agent handed to a member while the change turns on is refused at the write; the change itself stays on and is announced', async (t) => {
  const h = mk(); t.after(h.cleanup);
  const realDecide = bc.decide;
  const sw = createBehaviourSwitch({
    changes: { list: () => bc.list({ stateFile: h.stateFile }), decide: async (id, dec, o) => { const r = await realDecide(id, dec, { ...o, stateFile: h.stateFile }); h.roster[1].owner = 'u-member'; return r; } },
    agents: () => h.roster,
    stampOf: (n) => { const a = h.roster.find((x) => x.name === n); return a ? `box:${a.box}` : null; },
    setAgentGuidance: async (n, v, stamp, check) => { const a = h.roster.find((x) => x.name === n); const refusal = check(a); if (refusal) return { success: false, error: refusal }; h.guidance.push([n, v]); return { success: true }; },
    isMemberOwned: (a) => !!(a && a.owner && a.owner !== 'u-admin'), isVirtual: () => false, afterChange: async () => {},
    push: { notify: (payload, opts) => h.pushed.push({ payload, opts }) },
    auditFile: path.join(h.d, 'log5.jsonl'),
  });
  await assert.rejects(sw.on({ id: 'team-guidance', agents: ['coach'], by: 'maestro', confirm: yes }), /Couldn't change coach: coach belongs to a member; only the owner can change its settings\. Done before that: turned on "[^"]+"\./);
  assert.deepEqual(h.guidance, []);
  assert.equal(h.state()['team-guidance'].state, 'on');
  assert.match(h.pushed[0].payload.body, /^maestro turned on "[^"]+"; the rest failed\./);
});
