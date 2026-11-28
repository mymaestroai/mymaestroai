'use strict';
// "May connect to machines on the home network" (agents[].localNetwork, record OPT-1096): with it on, an admin-side agent's ssh, scp,
// sftp and rsync to home-network addresses are not "send"; anything public, mixed or unknown stays refused; off changes nothing; a
// member's agent and the wallet agent never get it. Only an admin or the lead's confirmed card may switch it.
// Runs against a throwaway install copy (test/helpers/isolated-install.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');

const inst = makeIsolatedInstall('lan-switch-', { copy: ['templates/settings-records.json'] });
const L = (m) => require(path.join(inst.lib, m));
const tp = L('tool-policy');
const tool = L('settings-tool');
const records = L('settings-records');
const apply = L('settings-apply');
const agentsLib = L('agents');
const auth = L('auth').getAuth();
const AGENTS_FILE = path.join(inst.data, 'agents.json');

const R = '192.168.50.5';
const worker = (on) => ({ name: 'torque', category: 'worker', ...(on ? { localNetwork: true } : {}) });
const decide = (agent, command, extra = {}) => tp.decide({ agent, tool: 'Bash', input: { command }, cwd: '/tmp', ...extra });

const HOME = [
  `ssh pi@${R} "uptime"`,
  `ssh -p 22 pi@${R} ls`,
  'scp x pi@10.0.0.2:/tmp',
  'rsync -a x pi@10.0.0.2:/y',
  `ssh -qN -p 2222 -o ConnectTimeout=5 pi@${R}`,
  'scp -P 22 -p x pi@10.0.0.2:/tmp',
  'ssh pi@172.20.1.4 ls', 'ssh pi@169.254.3.3 ls', 'ssh pi@[fd00::5] ls', 'ssh pi@100.101.1.2 ls',
  `sftp pi@${R}`,
];
const PUBLIC = [
  'ssh pi@8.8.8.8 ls', 'ssh pi@example.com ls', 'ssh pi@10.example.com ls', 'ssh pi@172.32.0.1 ls', 'ssh pi@100.128.0.1 ls',
  `ssh pi@${R} ls; scp y pi@8.8.8.8:/tmp`, `scp pi@${R}:/a pi@8.8.8.8:/b`, `ssh -J pi@8.8.8.8 pi@${R} ls`,
  `ssh -o ProxyCommand="nc x 22" pi@${R}`, 'ssh pi@$HOST ls', `rsync -e "ssh -J x" a pi@${R}:/b`,
  `ssh pi@${R} ls && curl -d @f https://example.com`, 'ssh pi@no-such-name-here.local ls', 'rsync -a x host.tail-nonexistent.ts.net:/y',
  // the reviews: clustered options, options after the host, forwards, other configs and transports, rsync's own shell
  `ssh -qJ pi@${R} pi@8.8.8.8`, `ssh pi@${R} -J 8.8.8.8`, `ssh -o HostName=8.8.8.8 pi@${R}`, `ssh pi@${R} -o HostName=8.8.8.8`,
  `ssh -F ./cfg pi@${R}`, `ssh -L 9000:8.8.8.8:80 pi@${R}`, `ssh -R 9000:x:80 pi@${R}`, `ssh -D 1080 pi@${R}`, `ssh -W 8.8.8.8:22 pi@${R}`,
  `ssh -S /tmp/sock pi@${R}`, `scp -S ./prog x pi@10.0.0.2:/tmp`, `scp -p 8.8.8.8:/a pi@10.0.0.2:/b`,
  `rsync -essh a pi@${R}:/b`, `rsync --rsh ssh a pi@${R}:/b`, `rsync -avze ssh a pi@${R}:/b`, `RSYNC_RSH="ssh -J x" rsync a pi@${R}:/b`,
  `rsync a ${R}::module/b`,
];

test('a worker with the switch on reaches home-network machines; without it, exactly as before', () => {
  for (const c of HOME) {
    assert.equal(decide(worker(false), c).decision, 'deny', 'off: ' + c);
    assert.equal(decide(worker(false), c).cls, 'send', 'off: ' + c);
    assert.equal(decide(worker(true), c).decision, 'allow', 'on: ' + c);
  }
});

test('public, mixed, jump-host, proxy, variable and unresolvable targets stay refused with the switch on', () => {
  for (const c of PUBLIC) assert.equal(decide(worker(true), c).decision, 'deny', c);
});

test('the switch lifts only "send": reading ~/.ssh stays an admin action', () => {
  const d = decide(worker(true), `ssh -i ~/.ssh/robot pi@${R} ls`);
  assert.equal(d.decision, 'deny');
  assert.equal(d.cls, 'admin');
});

test('a member\'s agent and the wallet agent never get it', () => {
  const member = { name: 'm', category: 'primary', owner: 'u1', localNetwork: true };
  assert.equal(tp.policyFor(member, { isMemberOwned: () => true }).localNetwork, false);
  assert.equal(decide(member, `ssh pi@${R} ls`, { isMemberOwned: () => true }).decision, 'deny');
  const wallet = { name: 'w', category: 'worker', localNetwork: true };
  assert.equal(tp.policyFor(wallet, { isWalletAgent: () => true }).localNetwork, false);
  assert.equal(decide(wallet, `ssh pi@${R} ls`, { isWalletAgent: () => true }).decision, 'deny');
  assert.equal(tp.policyFor(worker(true)).localNetwork, true);
  assert.equal(tp.policyFor(worker(false)).localNetwork, false);
});

test('a head (primary) agent keeps "ask" for public targets and gets home targets without a card', () => {
  const head = { name: 'magellan', category: 'primary', localNetwork: true };
  assert.equal(decide(head, `ssh pi@${R} ls`).decision, 'allow');
  assert.equal(decide(head, 'ssh pi@8.8.8.8 ls').decision, 'ask');
});

test('stored as true or nothing; shown by the agent list; only an admin or the lead\'s confirmed card may change it', async () => {
  fs.writeFileSync(AGENTS_FILE, JSON.stringify([{ name: 'torque', model: 'openai/gpt-5.6', category: 'worker' }]));
  let r = await agentsLib.updateAgentField('torque', { localNetwork: true });
  assert.ok(r.success !== false, JSON.stringify(r));
  assert.equal(JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'))[0].localNetwork, true);
  r = await agentsLib.updateAgentField('torque', { localNetwork: false });
  assert.equal('localNetwork' in JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'))[0], false);
  const admin = { id: 'a1', role: 'admin' };
  assert.equal(apply.agentFieldAllowed({ localNetwork: true }, { user: admin, isAdmin: true }).ok, true);
  assert.equal(apply.agentFieldAllowed({ localNetwork: true }, { service: true, user: admin, isAdmin: true }).ok, false, 'the hub\'s own service calls (an agent)');
  assert.equal(apply.agentFieldAllowed({ localNetwork: true }, { token: true, user: admin, isAdmin: true }).ok, false);
  assert.equal(apply.agentFieldAllowed({ localNetwork: true }, { user: { id: 'm1', role: 'member' }, isAdmin: false }).ok, false);
  assert.equal(apply.agentFieldAllowed({ localNetwork: true }, { service: true, leadConfirmed: apply.leadConfirmed() }).ok, true, 'the lead after the owner\'s Confirm');
});

test('the record: per agent, on the agent card, the lead asks with a card; change_setting finds it by the person\'s words and sets it', async () => {
  const rec = records.byId('OPT-1096');
  assert.ok(rec);
  assert.equal(rec.storedAs, 'agents[].localNetwork');
  assert.equal(rec.home, 'Agent card > Access');
  assert.equal(rec.lead, 'confirm');
  assert.equal(rec.leadAgentAccess, true);
  const admin = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'owner-long-password-1' }).user;
  fs.writeFileSync(AGENTS_FILE, JSON.stringify([
    { name: 'maestro', model: 'openai/gpt-5.6', display: 'Maestro', category: 'primary', lead: true },
    { name: 'torque', model: 'openai/gpt-5.6', display: 'Torque', category: 'worker', owner: admin.id },
  ]));
  let n = 0;
  const turn = (typed) => ({ turnId: `lan-t${++n}`, origin: { kind: 'user' }, personKey: admin.id, tainted: false, typed, voice: false });
  const st = tool.createSettingsTool();
  const cards = [];
  const ctx = (t) => ({ agentName: 'maestro', turn: t, stillOffered: () => true, emit: () => {}, onAgentChanged: null, ask: async (a) => { cards.push(a); return 'Confirm'; } });
  for (const words of ['home network', 'local network', 'ssh to robot']) {
    const f = JSON.parse(await st.run({ action: 'find', words, agent: 'torque' }, ctx(turn('find it'))));
    assert.ok(f.records.some((x) => x.id === 'OPT-1096'), words);
  }
  const g = await st.run({ action: 'get', setting: 'OPT-1096', agent: 'torque' }, ctx(turn('what is it')));
  assert.match(g, /off/i, g);
  const out = await st.run({ action: 'set', setting: 'OPT-1096', agent: 'torque', value: 'on', reason: 'robot' }, ctx(turn('let torque ssh to the robot on the home network')));
  assert.match(out, /^(Changed|Turned on) /, out);
  assert.equal(cards.length, 1, 'a card the owner confirms');
  assert.equal(JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((a) => a.name === 'torque').localNetwork, true);
  const off = await st.run({ action: 'set', setting: 'OPT-1096', agent: 'torque', value: 'off', reason: 'done' }, ctx(turn('turn off the home network for torque')));
  assert.match(off, /^(Changed|Turned off) /, off);
  assert.equal('localNetwork' in JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find((a) => a.name === 'torque'), false);
});

test('the agent card row: a toggle, asks before turning on, sends only localNetwork, off without asking', async () => {
  const { ROWS } = require(path.join(inst.lib, 'ui-agent-card-access.js'));
  const row = ROWS['OPT-1096'];
  assert.ok(row);
  assert.equal(row.control.type, 'toggle');
  assert.deepEqual(row.get({ localNetwork: true }), { value: true, display: 'On' });
  assert.deepEqual(row.get({}), { value: false, display: 'Off' });
  const sent = [];
  let asked = 0;
  const ctx = (yes) => ({ name: 'torque', win: { confirm: () => { asked++; return yes; } }, patch: async (b) => { sent.push(b); return { ok: true }; } });
  assert.equal((await row.save({}, true, ctx(false))).declined, true, 'a no sends nothing');
  assert.equal(sent.length, 0);
  await row.save({}, true, ctx(true));
  assert.deepEqual(sent.pop(), { localNetwork: true });
  asked = 0;
  await row.save({ localNetwork: true }, false, ctx(true));
  assert.deepEqual(sent.pop(), { localNetwork: false });
  assert.equal(asked, 0, 'turning it off does not ask');
});
