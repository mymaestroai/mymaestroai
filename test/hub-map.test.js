'use strict';
// The lead agent's standing brief about this hub (lib/hub-map): a few stable lines per turn with live facts and the
// pointer to docs/HUB-MAP.md, only for lead agents, switchable off, re-sent to a resumed Claude session only when
// something changed. Fake dependencies; the table of contents comes from the real map file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHubMap, newestCode, MAP_REL } = require('../lib/hub-map');

const ROOT = path.join(__dirname, '..');
const T0 = new Date('2026-01-01T12:00:00Z');
function deps(over = {}) {
  return {
    root: ROOT, startedAt: T0, gitInfo: 'abc1234 2026-01-01', version: '9.9.9',
    isLead: (n) => n === 'maestro',
    getSetting: (k, d) => d,
    auth: () => ({ hasUsers: () => true, listUsers: () => [{ role: 'admin' }, { role: 'admin', disabled: true }, { role: 'member' }, { role: 'member' }] }),
    agents: async () => [{ name: 'maestro', category: 'primary' }, { name: 'w', category: 'worker' }, { name: 'x', category: 'worker' }, { name: 'odd', category: 'thing' }],
    providersWithKeys: () => ['openai', 'google'],
    hasSdkCredentials: () => true,
    supervisor: () => 'systemd user service',
    nodeSecurity: () => null,   // the real check would follow the Node.js running the tests
    readiness: () => ({ check: async () => ({ critical: 1, warnings: 1, items: [{ id: 'docker', level: 'ok' }, { id: 'sandbox-image', level: 'ok' }, { id: 'accounts', level: 'critical' }, { id: 'poppler', level: 'warn' }, { id: 'search', level: 'info' }] }) }),
    ...over,
  };
}

test('brief: lead agent gets the facts and the map pointer; others and the off switch get nothing', async () => {
  const hm = createHubMap(deps()).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  assert.strictEqual(await hm.briefFor('worker'), '', 'not a lead agent');
  const text = await hm.briefFor('maestro');
  assert.ok(text.startsWith('\n\n---\n\n## THIS HUB'), 'its own section, so a change re-sends only this block');
  for (const s of ['My Maestro AI 9.9.9, commit abc1234 2026-01-01', 'process started 2026-01-01 12:00 UTC', 'systemd user service', `install ${ROOT}`, `hub home ${path.resolve(ROOT, '..')}`,
    'Port 8888, localhost only', 'Accounts: 1 admin, 2 members', 'Agents: 4 (primary 1, worker 2, thing 1)', 'Providers with keys: openai, google', 'Claude client signed in: yes',
    'never print secrets', `The map, ${MAP_REL}: 1 What the hub is`, '14 Setup recipes', 'Read the section that applies']) assert.ok(text.includes(s), s);
  assert.ok(text.includes('Setup checklist: not checked yet'), 'first turn: the checklist runs in the background');
  await hm.refreshChecklist();
  const t2 = await hm.briefFor('maestro');
  assert.ok(t2.includes('Setup checklist: 1 critical, 1 warnings (accounts!, poppler)'), t2);
  assert.ok(t2.includes('Sandboxes: Docker yes, image ready'), t2);
  const off = createHubMap(deps({ getSetting: (k, d) => (k === 'hubBrief' ? false : d) }));
  assert.strictEqual(await off.briefFor('maestro'), '');
});

test('brief: stable between calls (no clock text), exposure and missing pieces are said plainly', async () => {
  const hm = createHubMap(deps({ auth: () => ({ hasUsers: () => false }), providersWithKeys: () => [], hasSdkCredentials: () => false, gitInfo: '', readiness: null }))
    .init({ port: 9000, host: '0.0.0.0', exposed: () => true });
  const a = await hm.briefFor('maestro'); const b = await hm.briefFor('maestro');
  assert.strictEqual(a, b, 'identical text on consecutive turns');
  assert.ok(a.includes('reachable from the network on 0.0.0.0'));
  assert.ok(a.includes('Accounts: none yet (create the admin account at /welcome with the setup link (mymaestro setup-link)'));
  assert.ok(a.includes('Providers with keys: none'));
  assert.ok(a.includes('Claude client signed in: no'));
  assert.ok(a.includes('Sandboxes: unknown until the checklist runs'));
  assert.ok(a.includes('My Maestro AI 9.9.9; process started'), 'no commit text when git is unavailable');
});

test('restart pending: code newer than the process start is named', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-map-'));
  fs.mkdirSync(path.join(tmp, 'lib', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'server.js'), '//');
  fs.writeFileSync(path.join(tmp, 'lib', 'deep', 'late.js'), '//');
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(tmp, 'server.js'), old, old);
  const n = newestCode(tmp);
  assert.strictEqual(n.file, path.join('lib', 'deep', 'late.js'));
  const hm = createHubMap(deps({ root: tmp, startedAt: new Date(Date.now() - 600 * 1000), gitInfo: '', version: '1.0.0' }));
  const t = await hm.briefFor('maestro');
  assert.ok(t.includes(`Code changed after the process started (${path.join('lib', 'deep', 'late.js')}`), t);
  assert.ok(t.includes('a restart is pending, and only the owner restarts'));
  const calm = createHubMap(deps({ root: tmp, startedAt: new Date(Date.now() + 60 * 1000), gitInfo: '', version: '1.0.0' }));
  assert.ok(!(await calm.briefFor('maestro')).includes('restart is pending'));
  assert.strictEqual(calm.tocText(), '', 'no map file under this root: pointer without a table of contents');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('wiring: the three prompt sites append the brief after the pictures note; the server passes port and exposure; the map documents the setting', () => {
  const sdk = fs.readFileSync(path.join(ROOT, 'lib', 'sdk-chat.js'), 'utf8');
  assert.strictEqual((sdk.match(/\(await hubBriefTextFor\(agentName\)\)/g) || []).length, 3, 'gateway, Claude client and Codex paths');
  assert.ok(sdk.includes("require('./hub-map').getHubMap().briefFor(agentName)"));
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(server.includes("require('./lib/hub-map').getHubMap().init({ port: PORT, host: HOST, exposed: () => !!BIND.exposed, setupNeeded: () => isSetupNeeded() })"));
  const map = fs.readFileSync(path.join(ROOT, MAP_REL), 'utf8');
  assert.ok(map.includes('`hubBrief`'), 'settings table names the switch');
  const tpl = fs.readFileSync(path.join(ROOT, 'templates', 'workspaces', 'maestro', 'SOUL.md'), 'utf8');
  assert.ok(tpl.includes('docs/HUB-MAP.md'), 'the shipped lead agent knows where the map is');
});

test('brief: the models the lead agent can assign, newest first, without previews, snapshots or old families', async () => {
  const ids = ['claude-sdk/claude-haiku-4-5-20251001', 'claude-sdk/default', 'claude-sdk/opus', 'claude-sdk/sonnet', 'claude-sdk/haiku',
    'openai/gpt-4-0613', 'openai/gpt-5.5', 'openai/gpt-6', 'openai/gpt-5.4-2026-03-05', 'openai/tts-1', 'openai/gpt-5.5-mini',
    'google/gemini-2.5-computer-use-preview-10-2025', 'google/gemini-4-argon', 'google/gemini-3.8-flash', 'local/qwen3.8-27b'];
  const hm = createHubMap(deps({ models: () => ids })).init({ port: 9000 });
  const line = (await hm.briefFor('maestro')).split('\n').find(l => l.startsWith('- Models you can assign'));
  assert.ok(line, 'the line is there when models are known');
  assert.match(line, /claude-sdk\/default, claude-sdk\/opus, claude-sdk\/sonnet, claude-sdk\/haiku/);
  assert.match(line, /openai\/gpt-6, openai\/gpt-5\.5/);
  assert.match(line, /google\/gemini-4-argon, google\/gemini-3\.8-flash/);
  assert.match(line, /local\/qwen3\.8-27b/);
  for (const bad of ['gpt-4-0613', '2026-03-05', 'tts-1', 'computer-use']) assert.ok(!line.includes(bad), bad);
  assert.match(line, /claude-sdk\/ uses the owner's Claude subscription; the others bill per use, except local ones, which are free\./);
  const none = createHubMap(deps({ models: () => [] })).init({ port: 9000 });
  assert.ok(!(await none.briefFor('maestro')).includes('Models you can assign'), 'no line when nothing is known');
});

test('brief: a Node.js security release the hub misses becomes a SECURITY line for the lead agent only', async () => {
  const ns = { behind: true, version: 'v22.23.3', floor: '22.23.4', rated: 'HIGH', date: '2026-10-20', managed: true, how: 'run the one-line installer again ...: curl -fsSL https://mymaestroai.ai/install.sh | bash -s -- --yes' };
  const hm = createHubMap(deps({ nodeSecurity: () => ns })).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  const text = await hm.briefFor('maestro');
  assert.match(text, /- SECURITY \(act on this\): Node\.js v22\.23\.3, which runs this hub, misses the security fixes Node\.js published on 2026-10-20 \(rated HIGH; fixed in 22\.23\.4\)\. At the start of your next reply, tell the owner/);
  assert.match(text, /Only with the owner's OK: run the one-line installer again/);
  assert.match(text, /start it as a background job \(run_job\)/);
  assert.strictEqual(await hm.briefFor('worker'), '', 'not for other agents');
  const clean = createHubMap(deps({ nodeSecurity: () => ({ ...ns, behind: false }) })).init({ port: 8888, host: '127.0.0.1', exposed: () => false, setupNeeded: () => false });
  assert.doesNotMatch(await clean.briefFor('maestro'), /SECURITY/);
});
