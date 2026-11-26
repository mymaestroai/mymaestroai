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

test('a cd that cannot be followed: a relative write to a protected name is refused, an absolute one elsewhere is not', () => {
  const cmds = [
    'cd ~/install/data && echo x > settings.json',
    'cd $(echo /tmp)/data && cp /tmp/x agents.json',
    'cd ~/x/data; echo x >> users.json',
    'cd -P -- /tmp/data && echo x > connectors.json',
    'pushd /tmp && echo x > ../data/modules.json',
    'cd $HOME/x/data && echo x > push/prefs.json',
    'cd ~/data && mv /tmp/x auth.db',
    'cd ~/data && rm -f settings-journal.jsonl',
    'cd "$(git rev-parse --show-toplevel)/data" && sed -i s/a/b/ agents.json',
    'cd $X && echo x > data/settings.json',
    'cd ~ && cp a ../data/users.json',
    'cd ~ && echo x > ./data/wallet-state.json',
    'cd $HUB/data && echo x > wallet-keystore.json',
    `cd ~/${path.basename(INST)} && echo x > settings.json`,
  ];
  // the reviewer's false refusals: after a cd it cannot follow, a protected name that is not written as data/ and is not under a data-ish cd is allowed
  const allowed = [
    'cd ~/proj && echo x > users.json',
    'cd ~/proj && echo x > .vscode/settings.json',
    'cd ~/proj && echo x > fixtures/modules.json',
    'cd ~/proj && echo x > wallet-notes.txt',
    'cd ~/proj && echo x > wallet-state.json',
    'cd ~/proj && echo x > push/prefs.json',
    'cd $(pwd)/proj && sed -i s/a/b/ settings.json',
    'echo "cd ~ and more" && echo x > settings.json',
    `echo 'cd ~' > /dev/null; echo x > users.json`,
  ];
  for (const [label, agent, extra] of ROLES) {
    for (const command of cmds) {
      assertRefused(dec(agent, 'Bash', { command }, extra), `${label}: Bash ${command}`);
      assertRefused(dec(agent, 'run_job', { name: 'j', command }, extra), `${label}: run_job ${command}`);
    }
    // not blind (no cd, or one it follows), or an absolute path elsewhere: not this refusal
    for (const command of [...allowed, 'echo x > settings.json', 'cd /tmp && echo x > settings.json', 'cd ~ && echo x > /tmp/settings.json', 'cd ~ && echo x > notes.txt']) {
      assert.notStrictEqual(dec(agent, 'Bash', { command }, extra).cls, 'settings_file', `${label}: ${command}`);
    }
  }
});

test('blind is decided from command words: a cd inside eval / bash -c / sh -c code counts, a quoted cd does not', () => {
  const refused = [
    'eval "cd ~/x/data && echo y > users.json"',
    'for i in 1; do bash -c "cd ~/h/data && echo {} > settings.json"; done',
    `sh -c 'cd $HUB/data; echo x > agents.json'`,
    `zsh -c 'cd ~/x/data && echo x > connectors.json'`,
    `dash -c "cd ~/x/data; echo x > modules.json"`,
    `source <(echo "cd ~/x/data; echo x > users.json")`,
    `bash -c 'echo x > ${DATA}/users.json'`,
  ];
  const allowed = [
    'echo "cd ~/x/data" && echo x > notes.txt',
    'echo "cd ~/x/data" && echo x > settings.json',
    `bash -c 'cd ~/proj && echo x > users.json'`,
    `eval "echo cd ~/x/data" > /dev/null`,
  ];
  for (const [label, agent, extra] of ROLES) {
    for (const command of refused) assertRefused(dec(agent, 'Bash', { command }, extra), `${label}: ${command}`);
    for (const command of allowed) assert.notStrictEqual(dec(agent, 'Bash', { command }, extra).cls, 'settings_file', `${label}: ${command}`);
  }
});

test('nested shell code is judged in the folder a preceding cd moved to, with variables substituted; stdin-fed shells; the depth limit', () => {
  const refused = [
    `cd ${DATA} && bash -c 'echo x > users.json'`,
    `D=${DATA}; cd $D; bash -c 'echo x > users.json'`,
    `cd ${DATA} && zsh -c "cd . && echo x > agents.json"`,
    `echo 'echo x > ${DATA}/users.json' | bash`,
    `echo 'cd ${DATA}; echo x > users.json' | sh`,
    `bash <<EOF\necho x > ${DATA}/users.json\nEOF`,
    `cd ${DATA}\nbash <<'EOF'\necho x > settings.json\nEOF`,
    `bash <<< 'echo x > ${DATA}/connectors.json'`,
    // deeper than the limit: a nested runner remains and the code names a protected file
    Array.from({ length: 7 }).reduce((code) => `bash -c '${code.replace(/'/g, `'\\''`)}'`, 'echo > users.json'),
  ];
  const allowed = [
    `cd ${DATA} && echo hi`,
    `cd ${DATA}/../workspaces && bash -c 'echo x > users.json'`,
    `echo 'echo hi' | bash`,
    `bash <<EOF\necho hi > notes.txt\nEOF`,
    `bash script.sh`,
  ];
  const had = process.env.HUB_AUTH_DIR;
  for (const [label, agent, extra] of ROLES) {
    for (const command of refused) assertRefused(dec(agent, 'Bash', { command }, extra), `${label}: ${command}`);
    for (const command of allowed) assert.notStrictEqual(dec(agent, 'Bash', { command }, extra).cls, 'settings_file', `${label}: ${command}`);
    // from the install root, a relative cd into data/
    for (const command of [`cd data; sh -c 'echo > settings.json'`, `cd data && bash -c 'echo x > users.json'`]) {
      assertRefused(dec(agent, 'Bash', { command }, { ...extra, cwd: INST }), `${label} (install root): ${command}`);
    }
  }
  assert.strictEqual(had, process.env.HUB_AUTH_DIR);
});

test('blind-cd counts the moved account folder name; an install name counts only at 4+ characters and as a whole path part', () => {
  const had = process.env.HUB_AUTH_DIR;
  try {
    // HUB_AUTH_DIR set (the isolated install sets it): cd "$HUB_AUTH_DIR" is a cd to a data folder
    assert.ok(process.env.HUB_AUTH_DIR);
    assertRefused(dec(lead, 'Bash', { command: 'cd "$HUB_AUTH_DIR" && echo x > users.json' }), 'cd $HUB_AUTH_DIR');
    const acct = path.join(ISO.root, 'accounts-moved');
    process.env.HUB_AUTH_DIR = acct;
    assertRefused(dec(lead, 'Bash', { command: `cd ~/accounts-moved && echo x > users.json` }), 'cd to the moved folder name');
    assert.notStrictEqual(dec(lead, 'Bash', { command: `cd ~/accounts-moved-old && echo x > users.json` }).cls, 'settings_file', 'a longer name is not the part');
    process.env.HUB_AUTH_DIR = had;
    // an install folder named hub: too short to match, and cd ~/github/x does not hold it as a part anyway
    const fs = require('node:fs');
    const hubRoot = path.join(ISO.root, 'hubcopy', 'hub');
    fs.mkdirSync(hubRoot, { recursive: true });
    fs.cpSync(ISO.lib, path.join(hubRoot, 'lib'), { recursive: true });
    fs.symlinkSync(path.join(ISO.inst, 'node_modules'), path.join(hubRoot, 'node_modules'));
    const tpHub = require(path.join(hubRoot, 'lib', 'tool-policy'));
    assert.strictEqual(path.basename(tpHub.HUB_ROOT), 'hub');
    const cwd = path.join(hubRoot, 'workspaces', 'helper');
    const hit = (command) => tpHub.touchesSettingsFile({ tool: 'Bash', input: { command }, cwd });
    assert.strictEqual(hit('cd ~/github/x && echo x > settings.json'), null);
    assert.strictEqual(hit('cd ~/hub && echo x > settings.json'), null, 'a 3-character install name is not enough');
    assert.strictEqual(hit('cd ~/x/data && echo x > settings.json'), 'settings.json');
  } finally { process.env.HUB_AUTH_DIR = had; }
});

test('mv and ln are the command only at command position: grep mv data/agents.json is a read', () => {
  const reads = [`grep mv ${DATA}/agents.json`, `echo ln ${DATA}/agents.json`, `grep -n mv ${DATA}/settings.json | head`, `cat ${DATA}/agents.json | grep ln`];
  for (const [label, agent, extra] of ROLES) {
    for (const command of reads) assert.notStrictEqual(dec(agent, 'Bash', { command }, extra).cls, 'settings_file', `${label}: ${command}`);
    for (const command of [`sudo mv /tmp/x ${DATA}/agents.json`, `env A=1 mv /tmp/x ${DATA}/agents.json`, `cd /tmp && mv x ${DATA}/agents.json`, `true && ln -s /tmp/x ${DATA}/agents.json`,
      `find /tmp -name x -exec mv {} ${DATA}/agents.json \\;`, `if true; then mv /tmp/x ${DATA}/agents.json; fi`]) {
      assertRefused(dec(agent, 'Bash', { command }, extra), `${label}: ${command}`);
    }
  }
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
