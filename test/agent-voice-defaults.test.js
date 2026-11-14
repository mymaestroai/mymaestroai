'use strict';
// An agent's voice defaults (voiceDefaults: { preset?, endPause, continueWait, interruptSensitivity, voiceSpeed }): the record, its
// validation, the admin-only guard in server.js. Nothing live: the agents file lives in a temp folder (lib/agents.js runs from a
// copy whose data/ is temporary).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-defaults-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HUB_HOME = HOME;   // before anything loads lib/hub-home

const REAL = path.join(__dirname, '..');
const INST = path.join(ROOT, 'inst');
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
fs.mkdirSync(path.join(INST, 'lib'), { recursive: true });
fs.mkdirSync(path.join(INST, 'data'), { recursive: true });
for (const f of fs.readdirSync(path.join(REAL, 'lib'))) {
  const dst = path.join(INST, 'lib', f);
  if (f === 'agents.js') fs.copyFileSync(path.join(REAL, 'lib', f), dst);
  else fs.symlinkSync(path.join(REAL, 'lib', f), dst);
}
const agentsLib = require(path.join(INST, 'lib', 'agents.js'));

const seed = (agents) => { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2)); };
const onDisk = (name) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === name);
const listed = async (name) => (await agentsLib.getAgents(true)).find(a => a.name === name);
const base = (extra = {}) => ({ name: 'biographer', model: 'claude-sdk/default', display: 'Biographer', category: 'specialist', ...extra });
const PATIENT = { endPause: 4000, continueWait: 8000, interruptSensitivity: 30, voiceSpeed: 0.9 };

beforeEach(() => { seed([base()]); });

test('an agent with no voice defaults has no voiceDefaults field', async () => {
  assert.ok(!('voiceDefaults' in await listed('biographer')) || (await listed('biographer')).voiceDefaults === undefined);
});

test('an admin sets the patient preset: it is stored cleaned (the preset name and its four values) and listed', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('biographer', { voiceDefaults: { preset: 'patient' } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { preset: 'patient', ...PATIENT });
  assert.deepStrictEqual((await listed('biographer')).voiceDefaults, { preset: 'patient', ...PATIENT });
});

test('custom values are stored', async () => {
  const v = { endPause: 2000, continueWait: 5000, interruptSensitivity: 65, voiceSpeed: 1.2 };
  assert.deepStrictEqual(await agentsLib.updateAgentField('biographer', { voiceDefaults: v }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, v);
  assert.deepStrictEqual((await listed('biographer')).voiceDefaults, v);
});

test('junk is cleaned: invalid values dropped, numbers clamped, unknown keys and presets ignored', async () => {
  await agentsLib.updateAgentField('biographer', { voiceDefaults: { endPause: 1500, continueWait: 8000, interruptSensitivity: 400, voiceSpeed: 'fast', hack: 'x', preset: 'nope' } });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { continueWait: 8000, interruptSensitivity: 100 });
});

test('nothing valid removes the field, and so do an empty object and null', async () => {
  for (const empty of [{}, null, [], 'patient', 7, { endPause: 1 }]) {
    seed([base({ voiceDefaults: { preset: 'patient', ...PATIENT } })]);
    assert.deepStrictEqual(await agentsLib.updateAgentField('biographer', { voiceDefaults: empty }), { success: true }, JSON.stringify(empty));
    assert.ok(!('voiceDefaults' in onDisk('biographer')), 'removed by ' + JSON.stringify(empty));
    assert.strictEqual((await listed('biographer')).voiceDefaults, undefined);
  }
});

test('a hand-edited bad value in the file is cleaned on load, and the file is not rewritten', async () => {
  seed([base({ voiceDefaults: { endPause: 99999, voiceSpeed: 1.1 } })]);
  assert.deepStrictEqual((await listed('biographer')).voiceDefaults, { voiceSpeed: 1.1 });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 99999, voiceSpeed: 1.1 });
});

test('other agents and other fields are untouched', async () => {
  seed([base(), base({ name: 'helper', display: 'Helper' })]);
  await agentsLib.updateAgentField('biographer', { voiceDefaults: { preset: 'patient' }, blurb: 'hi' });
  assert.ok(!('voiceDefaults' in onDisk('helper')));
  assert.strictEqual(onDisk('biographer').blurb, 'hi');
  assert.strictEqual((await listed('helper')).voiceDefaults, undefined);
});

// ── the server boundary: only an admin may set it (server.js, run on the real source) ──
test('a member cannot PATCH voiceDefaults: the server guard refuses it; an admin and the hub itself pass', () => {
  const src = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  const start = src.indexOf("if (!req.hubService && !access.isAdmin(req.hubUser)) {\n        const MEMBER_EDITABLE");
  assert.ok(start > 0, 'the member guard is in server.js');
  const open = src.indexOf('{', start);
  let depth = 0, end = open;
  for (let i = open; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (!depth) { end = i; break; } } }
  const guard = src.slice(start, end + 1);
  assert.doesNotMatch(guard, /voiceDefaults/, 'voiceDefaults is not in the member allowlist');
  const run = (user, body, hubService = false) => {
    let sent = null;
    const jsonResponse = (res, code, obj) => { sent = { code, obj }; return 'sent'; };
    const fn = vm.runInNewContext(`(function (req, body, access, jsonResponse, res) { ${guard}\n return 'continued'; })`, {});
    const out = fn({ hubService, hubUser: user }, body, require('../lib/access'), jsonResponse, {});
    return { out, sent };
  };
  const member = { id: 'u2', role: 'member' }, admin = { id: 'u1', role: 'admin' };
  const refused = run(member, { voiceDefaults: { preset: 'patient' } });
  assert.strictEqual(refused.out, 'sent');
  assert.strictEqual(refused.sent.code, 403);
  assert.match(refused.sent.obj.error, /voiceDefaults/);
  assert.strictEqual(run(member, { blurb: 'x', voiceDefaults: null }).sent.code, 403, 'null is refused too');
  assert.strictEqual(run(member, { blurb: 'x' }).out, 'continued', 'a member can still change what they may');
  assert.strictEqual(run(admin, { voiceDefaults: { preset: 'patient' } }).out, 'continued');
  assert.strictEqual(run(null, { voiceDefaults: null }, true).out, 'continued', 'the hub itself');
  // and the PATCH route hands the body to updateAgentField unchanged
  assert.match(src, /const result = await updateAgentField\(name, body,/);
});

test('GET /api/agents sends the agent records as they are, so voiceDefaults reaches both pages', () => {
  const src = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
  const i = src.indexOf("pathname === '/api/agents' && req.method === 'GET'");
  assert.ok(i > 0);
  const route = src.slice(i, src.indexOf("'/api/agents/status'", i));
  assert.match(route, /agents\.map\(a => \(\{ \.\.\.stripVoice\(a\)/, 'every field of the record is spread into the answer (no allowlist)');
  const lib = fs.readFileSync(path.join(REAL, 'lib', 'agents.js'), 'utf8');
  assert.match(lib, /voiceDefaults: \(\(\) => \{ const d = cleanVoiceDefaults\(a\.voiceDefaults\)/, 'getAgents puts it on the record');
});
