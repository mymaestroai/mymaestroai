'use strict';
// Agents do not edit the settings files directly (lib/tool-policy touchesSettingsFile, lib/policy-gate): refused for every role,
// the lead too, on every route, with approvals on or a policy override allowing admin. Reads stay as they were.
// lib/ comes from a throwaway install, so the install root and its data/ folder are the test's own wherever the clone sits.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('settings-files-prot-');
const L = (p) => require(path.join(ISO.lib, p));
const tp = L('tool-policy');
tp.setMemberProviders({ memberDefaults: () => ({}), ownerGrants: () => ({}) });
const { createGate } = L('policy-gate');
const { createHubMap } = L('hub-map');

const INST = tp.HUB_ROOT;
const DATA = path.join(INST, 'data');
const FILES = ['settings.json', 'agents.json', 'users.json', 'connectors.json', 'modules.json', 'local-models.json', 'research-prefs.json',
  'voice-person-prefs.json', 'push/prefs.json', 'behaviour-reviews.json', 'settings-journal.jsonl', 'auth.db', 'auth.db-wal', 'auth.db-shm',
  'wallet-state.json', 'wallet-allowlist.json', 'wallet-executor.json', 'wallet-hyperliquid.json', 'wallet-keystore.json',
  'agents.json.bak', 'settings.json.tmp-123', 'users.json.4567.tmp', '.users.0a1b2c.tmp', 'connectors.json.89.tmp'];

const lead = { name: 'maestro', category: 'primary', lead: true };
const head = { name: 'biographer', category: 'primary' };
const worker = { name: 'helper', category: 'worker' };
const member = { name: 'sam_assistant', category: 'primary', owner: 'u_sam' };
const tempWorker = { name: 'tw-abc123', category: 'worker' };
const ROLES = [['lead', lead, {}], ['head', head, {}], ['worker', worker, {}], ['member', member, { isMemberOwned: () => true }], ['temporary worker', tempWorker, {}]];
const cwdOf = (a) => path.join(INST, 'workspaces', a.name);
const dec = (agent, tool, input, extra = {}) => tp.decide({ agent, tool, input, cwd: cwdOf(agent), ...extra });

function assertRefused(d, label) {
  assert.strictEqual(d.decision, 'deny', label);
  assert.strictEqual(d.cls, 'settings_file', label);
  const text = tp.denialText(d);
  assert.match(text, /^\[DENIED BY POLICY\] Agents do not edit My Maestro's settings files directly \(/, label);
  assert.match(text, /change_setting tool/, label);
  assert.match(text, /Do not work around it\.$/, label);
}

test('Write, Edit, MultiEdit and NotebookEdit to every protected file are refused for every role, with the change_setting text', () => {
  for (const [label, agent, extra] of ROLES) {
    for (const f of FILES) {
      const abs = path.join(DATA, f);
      for (const tool of ['Write', 'Edit', 'MultiEdit', 'mcp__hub__Write', 'mcp__hub__Edit']) {
        assertRefused(dec(agent, tool, { file_path: abs, content: 'x' }, extra), `${label}: ${tool} ${f}`);
      }
      assertRefused(dec(agent, 'NotebookEdit', { notebook_path: abs }, extra), `${label}: NotebookEdit ${f}`);
    }
    // a relative spelling from the workspace and a spelling through ..
    assertRefused(dec(agent, 'Write', { file_path: path.join('..', '..', 'data', 'settings.json'), content: 'x' }, extra), `${label}: relative`);
    assertRefused(dec(agent, 'Write', { file_path: path.join(DATA, 'x', '..', 'agents.json'), content: 'x' }, extra), `${label}: dotdot`);
  }
});

test('the refusal names the file and stays with approvals on, a policy override allowing admin and every class set to allow', () => {
  const allow = { policy: { overrides: { admin: 'allow', write_outside: 'allow', destroy: 'allow', send: 'allow' } } };
  for (const [label, agent, extra] of ROLES) {
    const a = { ...agent, ...allow };
    const d = dec(a, 'Write', { file_path: path.join(DATA, 'settings.json'), content: 'x' }, { ...extra, allowances: { has: () => true } });
    assertRefused(d, label);
    assert.match(tp.denialText(d), /\(settings\.json\)/);
    assert.match(tp.denialText(dec(a, 'Write', { file_path: path.join(DATA, 'push', 'prefs.json'), content: 'x' }, extra)), /\(push\/prefs\.json\)/);
    // and not decided by "ask": there is no card to approve
    assert.notStrictEqual(d.decision, 'ask');
  }
});

test('Bash and run_job writes to the protected files are refused for every role', () => {
  const cmds = [
    `cd ${INST} && echo x > data/settings.json`,
    `echo x >> ${DATA}/agents.json`,
    `sed -i s/a/b/ ${DATA}/agents.json`,
    `cp /tmp/x ${DATA}/users.json`,
    `mv /tmp/x ${DATA}/agents.json`,
    `mv ${DATA}/agents.json /tmp/gone`,
    `rm ${DATA}/connectors.json`,
    `echo x | tee ${DATA}/modules.json`,
    `echo x > ${DATA}/agents.json.bak`,
    `echo x > ${DATA}/settings.json.tmp-9`,
    `echo x > ${DATA}/agents.json.123.tmp`,
    `truncate -s 0 ${DATA}/local-models.json`,
    `ln -sf /tmp/x ${DATA}/research-prefs.json`,
    `install -m 600 /tmp/x ${DATA}/voice-person-prefs.json`,
    `dd if=/tmp/x of=${DATA}/push/prefs.json`,
    `patch ${DATA}/behaviour-reviews.json /tmp/p`,
    `cd ${DATA} && echo x > settings.json`,
    `cd ${DATA} && cp /tmp/x auth.db`,
    `echo x > ${DATA}/wallet-state.json`,
  ];
  for (const [label, agent, extra] of ROLES) {
    for (const command of cmds) {
      assertRefused(dec(agent, 'Bash', { command }, extra), `${label}: Bash ${command}`);
      assertRefused(dec(agent, 'mcp__hub__Bash', { command }, extra), `${label}: hub Bash ${command}`);
      assertRefused(dec(agent, 'run_job', { name: 'j', command }, extra), `${label}: run_job ${command}`);
    }
  }
});

test('reads are as they were: the lead may read agents.json, copy it out; settings.json stays a refused read', () => {
  const rd = (agent, f, extra) => dec(agent, 'Read', { file_path: path.join(DATA, f) }, extra);
  // reading agents.json: not the settings_file refusal, and the lead's rule is whatever it was (admin = ask, approvals off allow)
  const r = rd(lead, 'agents.json');
  assert.notStrictEqual(r.cls, 'settings_file');
  assert.notStrictEqual(r.decision, 'deny', 'the lead still reads data/agents.json');
  // settings.json is a sensitive read: admin, as before
  const s = rd(lead, 'settings.json');
  assert.strictEqual(s.cls, 'admin');
  assert.notStrictEqual(s.cls, 'settings_file');
  assert.strictEqual(rd(worker, 'settings.json').decision, 'deny', 'a worker still may not read it');
  // a copy FROM a protected file to the agent's own folder writes nothing protected
  const c = dec(lead, 'Bash', { command: `cp ${DATA}/agents.json ${INST}/workspaces/maestro/agents-copy.json` });
  assert.notStrictEqual(c.cls, 'settings_file');
  const g = dec(lead, 'Bash', { command: `cat ${DATA}/agents.json` });
  assert.notStrictEqual(g.cls, 'settings_file');
});

test('scheduled-tasks.json is not covered by this rule', () => {
  for (const [label, agent, extra] of ROLES) {
    assert.notStrictEqual(dec(agent, 'Write', { file_path: path.join(DATA, 'scheduled-tasks.json'), content: '[]' }, extra).cls, 'settings_file', label);
    assert.notStrictEqual(dec(agent, 'Bash', { command: `echo x > ${DATA}/scheduled-tasks.json` }, extra).cls, 'settings_file', label);
  }
  assert.strictEqual(tp.touchesSettingsFile({ tool: 'Write', input: { file_path: path.join(DATA, 'jobs', 'a', 'run.sh') } }), null);
  assert.strictEqual(tp.touchesSettingsFile({ tool: 'Write', input: { file_path: path.join(INST, 'workspaces', 'x', 'settings.json') } }), null, 'a file of that name elsewhere is not data/');
});

test('the gate refuses it with the log line, with the policy switched off and approvals on', async () => {
  const lines = [];
  for (const enabled of [true, false]) {
    const g = createGate({ getAgent: async (n) => ({ maestro: lead, helper: worker }[n]), approvalsOn: () => true, enabled: () => enabled, log: (l) => lines.push(l) });
    for (const name of ['maestro', 'helper']) {
      const r = await g.check({ agentName: name, tool: 'Write', input: { file_path: path.join(DATA, 'settings.json'), content: 'x' }, cwd: path.join(INST, 'workspaces', name) });
      assert.strictEqual(r.allowed, false, `${name} enabled=${enabled}`);
      assert.match(r.text, /change_setting tool/);
      assert.strictEqual(r.decision.cls, 'settings_file');
    }
    const h = await g.sdkHook({ agentName: 'maestro', cwd: path.join(INST, 'workspaces', 'maestro') })({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `rm ${DATA}/agents.json` } });
    assert.strictEqual(h.decision, 'block');
  }
  assert.ok(lines.some(l => /^\[policy\] maestro: DENY settings_file via Write/.test(l)), lines.join('\n'));
});

test('the lead brief no longer says settings are the lead\'s to edit, and names change_setting', async () => {
  const hm = createHubMap({
    root: path.join(__dirname, '..'), startedAt: new Date('2026-01-01T12:00:00Z'), gitInfo: 'abc1234 2026-01-01', version: '9.9.9',
    isLead: (n) => n === 'maestro', getSetting: (k, d) => d,
    auth: () => ({ hasUsers: () => true, listUsers: () => [{ role: 'admin' }] }),
    agents: async () => [{ name: 'maestro', category: 'primary' }], providersWithKeys: () => [], hasSdkCredentials: () => true,
    supervisor: () => 'systemd user service', nodeSecurity: () => null, zone: () => 'UTC',
    readiness: () => ({ check: async () => ({ critical: 0, warnings: 0, items: [] }) }),
  }).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  const text = await hm.briefFor('maestro');
  assert.match(text, /change_setting/);
  assert.match(text, /never by editing data\/ files/);
  assert.ok(!/data changes \([^)]*\bsettings\b[^)]*\) apply at once/.test(text), 'settings are no longer in the "apply at once" list');
});
