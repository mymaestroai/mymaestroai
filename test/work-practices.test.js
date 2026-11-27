'use strict';
// Two behaviour changes for primary agents (owner, 06:09): check-ins on long work (work-check-ins) and suggestions for
// better ways of working (work-suggestions). lib/work-practices.js builds the text; lib/sdk-chat.js adds it only while each
// change is on (lib/behaviour-changes), on every model path; both are manifest entries like the other five.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const wp = require('../lib/work-practices');

const ROOT = path.join(__dirname, '..');
const primary = { name: 'coach', category: 'primary' };

test('only primary agents get the sections; each only when its change is on', () => {
  assert.strictEqual(wp.textFor({ agent: { category: 'worker' }, checkIns: true, suggestions: true }), '');
  assert.strictEqual(wp.textFor({ agent: { category: 'specialist' }, checkIns: true, suggestions: true }), '');
  assert.strictEqual(wp.textFor({ agent: primary }), '');
  assert.match(wp.textFor({ agent: primary, checkIns: true }), /KEEPING LONG WORK ON TRACK/);
  assert.doesNotMatch(wp.textFor({ agent: primary, checkIns: true }), /WORKING BETTER/);
  assert.match(wp.textFor({ agent: primary, suggestions: true }), /WORKING BETTER/);
  assert.doesNotMatch(wp.textFor({ agent: primary, suggestions: true }), /KEEPING LONG WORK/);
});

test('check-ins: the lead gets the full instructions, other primary agents the core lines', () => {
  const full = wp.textFor({ agent: primary, isLead: true, checkIns: true });
  const core = wp.textFor({ agent: primary, checkIns: true });
  assert.strictEqual(full, wp.CHECK_INS_FULL);
  assert.strictEqual(core, wp.CHECK_INS_CORE);
  for (const t of [full, core]) {
    assert.match(t, /schedule_task/);
    assert.match(t, /every 30 minutes by default/);
    assert.match(t, /two check-ins/);
  }
  assert.match(full, /Keep one active check-in per piece of work:/);
  assert.match(full, /cancel_scheduled_task/);
  assert.match(full, /call for_owner then/);
  assert.ok(core.length < full.length);
});

test('suggestions: one per topic, a no is remembered, nothing without a yes; builds go through the lead or request_agent', () => {
  const lead = wp.textFor({ agent: primary, isLead: true, suggestions: true });
  const other = wp.textFor({ agent: primary, leadName: 'maestro', suggestions: true });
  const member = wp.textFor({ agent: primary, member: true, leadName: 'maestro', suggestions: true });
  for (const t of [lead, other, member]) {
    assert.match(t, /At most one suggestion per conversation and per topic/);
    assert.match(t, /note it in your memory and do not suggest it again/);
    assert.match(t, /Nothing is created without their yes/);
    for (const idea of ['a specialist', 'a dedicated lead agent', 'low-cost temporary workers', 'a cheaper model or speed', 'a scheduled task', 'a Record']) assert.ok(t.includes(idea), idea);
  }
  assert.match(lead, /build a new agent yourself, following AGENT-PLAYBOOK\.md\./);
  assert.match(other, /ask maestro to build a new agent \(consult_agent\)/);
  assert.match(member, /ask for a new agent with request_agent; an admin decides\./);
  assert.doesNotMatch(member, /maestro/, 'a member\'s agent is never pointed at the admin\'s agents');
});

test('both are manifest entries (thirteen in all) and the prompt builders add the text only while they are on', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'behaviour-changes.json'), 'utf8'));
  const ids = m.changes.map((c) => c.id);
  assert.deepStrictEqual(ids, ['team-guidance', 'starter-team', 'member-worker-models', 'worker-proposals', 'ask-lead-for-workers', 'work-check-ins', 'work-suggestions', 'hand-off-guidance', 'parallel-work', 'protect-own-code', 'own-code-guidance', 'deep-research', 'research-own-work']);   // research for an agent's own work (lib/research, research-own-work) joined after deep-research   // deep-research (lib/research) joined the ten   // ten entries now (code protection, lib/code-protect);   // hand-offs (lib/hand-offs): the rule to hand long work to a build partner
  for (const c of m.changes) for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(typeof c[k] === 'string' && c[k].length > 5, `${c.id}.${k}`);
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  assert.strictEqual((sdk.match(/\(await askLeadTextFor\(agentName\)\) \+ \(await workPracticesTextFor\(agentName\)\)/g) || []).length, 3, 'gateway, SDK and Codex');
  assert.match(sdk, /const checkIns = bc\.isOn\('work-check-ins'\), suggestions = bc\.isOn\('work-suggestions'\), handOffs = bc\.isOn\('hand-off-guidance'\) && !handOffOfTurn\(agentName\), ownCode = bc\.isOn\('own-code-guidance'\), parallel = bc\.isOn\('parallel-work'\);\n\s+if \(!checkIns && !suggestions && !handOffs && !ownCode && !parallel\) return '';/);
  assert.match(sdk, /async function workPracticesTextFor\(agentName\) \{[\s\S]*?if \(temporalWorkers\.isVirtual\(agentName\)\) return '';/);
});

test('parallel-work: only primary agents get the section, and only when it is on', () => {
  for (const category of ['specialist', 'worker', undefined]) assert.strictEqual(wp.textFor({ agent: { category }, parallel: true }), '');
  assert.strictEqual(wp.textFor({ agent: null, parallel: true }), '');
  assert.strictEqual(wp.textFor({ agent: primary, parallel: false }), '');
  assert.strictEqual(wp.textFor({ agent: primary }), '');
  assert.match(wp.textFor({ agent: primary, parallel: true }), /## COMPLEX WORK: SPLIT IT, UNLESS SPLITTING HURTS/);
});

test('parallel-work: only the lead gets the create-another-lead line', () => {
  const re = /you may create another lead for yourself, following AGENT-PLAYBOOK\.md, rather than lend a specialist from another field/;
  assert.match(wp.textFor({ agent: primary, isLead: true, parallel: true }), re);
  assert.doesNotMatch(wp.textFor({ agent: primary, leadName: 'maestro', parallel: true }), re);
  assert.doesNotMatch(wp.textFor({ agent: primary, member: true, leadName: 'maestro', parallel: true }), re);
  assert.doesNotMatch(wp.textFor({ agent: primary, member: true, parallel: true }), re);
});

test('parallel-work: the hand_off line appears only when hand-offs are on', () => {
  const re = /Work that will take more than a few minutes still goes to a teammate with hand_off, rather than being split and waited on in your own turn; the teammate that leads it does the splitting\./;
  assert.doesNotMatch(wp.parallelText(), re);
  assert.doesNotMatch(wp.parallelText({ isLead: true }), re);
  assert.match(wp.parallelText({ handOffs: true }), re);
  assert.match(wp.textFor({ agent: primary, handOffs: true, parallel: true }), re);
  assert.doesNotMatch(wp.textFor({ agent: primary, parallel: true }), re);
});

test('parallel-work: the text holds the key rules and names no model', () => {
  const t = wp.parallelText({ isLead: true, handOffs: true });
  for (const s of ['first look for parts that don\'t depend on each other', 'Where running them separately keeps the quality, start them at the same time, without being asked', 'from the models you may use', "reviews from different companies' models side by side", 'several consult_agent or spawn_workers calls in one message', 'Quality comes first', 'one design or writing voice', 'tightly coupled changes to the same files', 'each step depends on the last', 'Say in one line why it stays in one thread', 'Check every part that comes back before you use it', "Don't split trivial jobs"]) assert.ok(t.includes(s), s);
  assert.doesNotMatch(t, /claude|sonnet|opus|haiku|gpt|gemini|fable/i);
  assert.ok(t.startsWith('\n\n## COMPLEX WORK'));
});

test("parallel-work: the section comes after LONG WORK: HAND IT OFF and before YOUR MAESTRO'S OWN CODE", () => {
  const t = wp.textFor({ agent: primary, isLead: true, checkIns: true, suggestions: true, handOffs: true, parallel: true, ownCode: true });
  const a = t.indexOf('## LONG WORK: HAND IT OFF'), b = t.indexOf('## COMPLEX WORK: SPLIT IT'), c = t.indexOf("## YOUR MAESTRO'S OWN CODE");
  assert.ok(a >= 0 && b > a && c > b, [a, b, c].join(','));
});

test('parallel-work: sdk-chat reads the flag on its own (not tied to hand-off turns) and passes it to textFor', () => {
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /parallel = bc\.isOn\('parallel-work'\);/);
  assert.doesNotMatch(sdk, /parallel = bc\.isOn\('parallel-work'\) &&/);
  assert.doesNotMatch(sdk, /parallel = [^;\n]*handOffOfTurn/);
  assert.match(sdk, /textFor\(\{ agent: rec, [^}]*\bparallel, kept \}\)/);
});

test('parallel-work: content kept on its own service never points at another company\'s model', () => {
  const kept = wp.textFor({ agent: primary, isLead: true, handOffs: true, parallel: true, kept: true });
  assert.match(kept, /Your work stays on your own service: every worker and reviewer runs on your own model, never on another company's\./);
  assert.match(kept, /several reviewers side by side\./);
  assert.doesNotMatch(kept, /different companies' models|Pick the model for each part/);
  const open = wp.textFor({ agent: primary, parallel: true });
  assert.doesNotMatch(open, /Your work stays on your own service/);
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  assert.match(sdk, /const kept = parallel && researchKeptOnBox\(rec\);/);
  assert.match(sdk, /partner, ownCode, parallel, kept \}\)/);
});

test('parallel-work: the word counts in the manifest and the settings record match the text', () => {
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  const core = words(wp.parallelText({ handOffs: true })), lead = words(wp.parallelText({ isLead: true, handOffs: true }));
  const near = (n, claim) => Math.abs(n - claim) <= claim * 0.15;
  assert.ok(near(core, 220) && near(lead, 260), `core ${core}, lead ${lead}`);
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'behaviour-changes.json'), 'utf8')).changes.find((c) => c.id === 'parallel-work');
  assert.match(m.costs, /^About 220 words more in each primary agent's instructions \(about 260 for the lead\)/);
  assert.strictEqual(m.leadMay, true);
  const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'settings-records.json'), 'utf8')).records.find((x) => x.id === 'OPT-1083');
  assert.strictEqual(r.storedAs, 'behaviour:parallel-work');
  assert.match(r.risk, /about 220 words longer/);
  assert.deepStrictEqual(r.labels, [m.title]);
});
