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

test('both are manifest entries (eleven in all) and the prompt builders add the text only while they are on', () => {
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates', 'behaviour-changes.json'), 'utf8'));
  const ids = m.changes.map((c) => c.id);
  assert.deepStrictEqual(ids, ['team-guidance', 'starter-team', 'member-worker-models', 'worker-proposals', 'ask-lead-for-workers', 'work-check-ins', 'work-suggestions', 'hand-off-guidance', 'protect-own-code', 'own-code-guidance', 'deep-research']);   // deep-research (lib/research) joined the ten   // ten entries now (code protection, lib/code-protect);   // hand-offs (lib/hand-offs): the rule to hand long work to a build partner
  for (const c of m.changes) for (const k of ['title', 'changes', 'benefits', 'costs', 'check', 'on', 'off']) assert.ok(typeof c[k] === 'string' && c[k].length > 5, `${c.id}.${k}`);
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  assert.strictEqual((sdk.match(/\(await askLeadTextFor\(agentName\)\) \+ \(await workPracticesTextFor\(agentName\)\)/g) || []).length, 3, 'gateway, SDK and Codex');
  assert.match(sdk, /const checkIns = bc\.isOn\('work-check-ins'\), suggestions = bc\.isOn\('work-suggestions'\), handOffs = bc\.isOn\('hand-off-guidance'\) && !handOffOfTurn\(agentName\), ownCode = bc\.isOn\('own-code-guidance'\);\n\s+if \(!checkIns && !suggestions && !handOffs && !ownCode\) return '';/);
  assert.match(sdk, /async function workPracticesTextFor\(agentName\) \{[\s\S]*?if \(temporalWorkers\.isVirtual\(agentName\)\) return '';/);
});
