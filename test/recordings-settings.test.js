'use strict';
// The agent setting `recordings` (call recordings): the cleaner, the admin-only guard in server.js, the audit entry, and the
// way GET /api/agents shapes it for each caller. Nothing live: the agents file lives in a temp folder (lib/agents.js runs from a
// copy whose data/ is temporary).
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// The whole lib/ is copied into a throwaway install (test/helpers/isolated-install.js): every module keeps its data under that
// install's data/, never under the real one (symlinked modules would resolve to the real install and open its databases).
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('rec-settings-');
const ROOT = ISO.root;
const HOME = ISO.home;
const REAL = path.join(__dirname, '..');
const INST = ISO.inst;
const AGENTS_FILE = path.join(INST, 'data', 'agents.json');
const agentsLib = require(path.join(INST, 'lib', 'agents.js'));
const rs = require(path.join(INST, 'lib', 'recordings', 'settings.js'));

const OWNER = 'u_0000000000a1';
const SAM = 'u_0000000000b2';
const PATIENT_A = 'u_0000000000c3';
const seed = (agents) => { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2)); };
const onDisk = (name) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === name);
const listed = async (name) => (await agentsLib.getAgents(true)).find(a => a.name === name);
const base = (extra = {}) => ({ name: 'biographer', model: 'claude-sdk/default', display: 'Biographer', category: 'specialist', ...extra });
const DEFAULTS = { keep: false, allowed: [], keepReplies: false, consentLine: 'This conversation is being recorded.', mic: 'processed', announce: 'first' };

beforeEach(() => { seed([base()]); });

// ── the cleaner ──
test('cleaner: defaults, and nothing or all-defaults means no field', () => {
  assert.strictEqual(rs.cleanRecordings(undefined), undefined);
  assert.strictEqual(rs.cleanRecordings(null), undefined);
  assert.strictEqual(rs.cleanRecordings({}), undefined);
  assert.strictEqual(rs.cleanRecordings('yes'), undefined);
  assert.strictEqual(rs.cleanRecordings({ keep: false, allowed: [], keepReplies: false, consentLine: '  ', mic: 'bogus' }), undefined);
  assert.deepStrictEqual(rs.cleanRecordingsFull({}), DEFAULTS);
  assert.deepStrictEqual(rs.cleanRecordings({ keep: true }), { ...DEFAULTS, keep: true });
  assert.deepStrictEqual(rs.cleanRecordings({ allowed: [OWNER] }), { ...DEFAULTS, allowed: [OWNER] }, 'a list alone is a setting (recordings stay reachable after keep is switched off)');
});

test('cleaner: keep and keepReplies are booleans only, mic is one of two, the consent line is trimmed and capped', () => {
  const r = rs.cleanRecordings({ keep: 'true', keepReplies: 1, mic: 'unprocessed', consentLine: `  ${'x'.repeat(400)}  ` });
  assert.strictEqual(r.keep, false);
  assert.strictEqual(r.keepReplies, false);
  assert.strictEqual(r.mic, 'unprocessed');
  assert.strictEqual(r.consentLine, 'x'.repeat(300));
  assert.strictEqual(rs.cleanRecordings({ keep: true, consentLine: '  Hello.  ' }).consentLine, 'Hello.');
  assert.strictEqual(rs.cleanRecordings({ keep: true, mic: 'weird' }).mic, 'processed');
});

test('cleaner: allowed ids are unique, in the user id format, at most 20', () => {
  const ids = Array.from({ length: 25 }, (_, i) => 'u_' + String(i).padStart(12, '0'));
  const r = rs.cleanRecordings({ keep: true, allowed: [OWNER, OWNER, 'sam', 'u_xyz', 7, null, '../etc', SAM, ...ids] });
  assert.deepStrictEqual(r.allowed.slice(0, 2), [OWNER, SAM]);
  assert.strictEqual(r.allowed.length, 20);
  assert.strictEqual(new Set(r.allowed).size, 20);
  assert.ok(r.allowed.every(id => /^u_[0-9a-f]{12}$/.test(id)));
  assert.deepStrictEqual(rs.cleanRecordings({ keep: true, allowed: 'u_0000000000a1' }).allowed, []);
});

// ── the record on the agent ──
test('an agent with no setting has no recordings field', async () => {
  assert.strictEqual((await listed('biographer')).recordings, undefined);
});

test('updateAgentField stores it cleaned, lists it cleaned, and the defaults remove it', async () => {
  assert.deepStrictEqual(await agentsLib.updateAgentField('biographer', { recordings: { keep: true, allowed: [OWNER, 'junk'], mic: 'unprocessed', extra: 1 } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').recordings, { ...DEFAULTS, keep: true, allowed: [OWNER], mic: 'unprocessed' });
  assert.deepStrictEqual((await listed('biographer')).recordings, { ...DEFAULTS, keep: true, allowed: [OWNER], mic: 'unprocessed' });
  assert.deepStrictEqual(await agentsLib.updateAgentField('biographer', { recordings: { keep: false, allowed: [], mic: 'processed' } }), { success: true });
  assert.ok(!('recordings' in onDisk('biographer')));
  assert.strictEqual((await listed('biographer')).recordings, undefined);
  await agentsLib.updateAgentField('biographer', { recordings: { keep: true } });
  await agentsLib.updateAgentField('biographer', { recordings: null });
  assert.ok(!('recordings' in onDisk('biographer')), 'null removes it');
});

test('a partial change is merged into the stored setting: it never switches recording off or empties the list', async () => {
  await agentsLib.updateAgentField('biographer', { recordings: { keep: true, allowed: [OWNER] } });
  assert.deepStrictEqual(await agentsLib.updateAgentField('biographer', { recordings: { mic: 'unprocessed' } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').recordings, { ...DEFAULTS, keep: true, allowed: [OWNER], mic: 'unprocessed' });
  await agentsLib.updateAgentField('biographer', { recordings: { keep: false } });
  assert.deepStrictEqual(onDisk('biographer').recordings, { ...DEFAULTS, keep: false, allowed: [OWNER], mic: 'unprocessed' }, 'keep off keeps the list');
  await agentsLib.updateAgentField('biographer', { recordings: null });
  assert.ok(!('recordings' in onDisk('biographer')));
});

test('a hand-edited bad record in agents.json is cleaned on read', async () => {
  seed([base({ recordings: { keep: 'yes', allowed: ['sam', OWNER], consentLine: 5, mic: 'x' } })]);
  assert.deepStrictEqual((await listed('biographer')).recordings, { ...DEFAULTS, allowed: [OWNER] });
});

// ── the audit ──
test('every change is audited as agent.recordings with the agent, keep, allowed ids and mic, and never the consent text', async () => {
  const log = [];
  const ctx = { userId: OWNER, audit: (action, detail) => log.push([action, detail]) };
  await agentsLib.updateAgentField('biographer', { recordings: { keep: true, allowed: [OWNER, SAM], mic: 'unprocessed', consentLine: 'Private words here' } }, ctx);
  assert.deepStrictEqual(log, [['agent.recordings', `biographer keep=on allowed=${OWNER},${SAM} mic=unprocessed announce=first`]]);
  assert.ok(!log[0][1].includes('Private'));
  await agentsLib.updateAgentField('biographer', { recordings: { keep: false, allowed: [OWNER, SAM], mic: 'unprocessed', consentLine: 'Private words here' } }, ctx);
  assert.strictEqual(log.length, 2);
  assert.strictEqual(log[1][1], `biographer keep=off allowed=${OWNER},${SAM} mic=unprocessed announce=first`);
  await agentsLib.updateAgentField('biographer', { recordings: { keep: false, allowed: [OWNER, SAM], mic: 'unprocessed', consentLine: 'Private words here' } }, ctx);
  assert.strictEqual(log.length, 2, 'no change, no audit entry');
  await agentsLib.updateAgentField('biographer', { blurb: 'hello' }, ctx);
  assert.strictEqual(log.length, 2, 'other fields are not audited here');
  await agentsLib.updateAgentField('biographer', { recordings: null }, ctx);
  assert.strictEqual(log.length, 3);
  assert.strictEqual(log[2][1], 'biographer keep=off allowed=- mic=processed announce=first');
});

test('a failing audit never stops the save', async () => {
  const r = await agentsLib.updateAgentField('biographer', { recordings: { keep: true } }, { audit: () => { throw new Error('db down'); } });
  assert.deepStrictEqual(r, { success: true });
  assert.strictEqual(onDisk('biographer').recordings.keep, true);
});

// ── admin-only ──
const server = fs.readFileSync(path.join(REAL, 'server.js'), 'utf8');
test('server.js: recordings is not member-editable, and a member or the hub\'s own service calls are refused', () => {
  const m = server.match(/const MEMBER_EDITABLE = new Set\((\[[^\]]*\])\)/);
  assert.ok(m, 'MEMBER_EDITABLE is still there');
  const set = vm.runInNewContext(m[1]);
  assert.ok(!set.includes('recordings'));
  const i = server.indexOf("'recordings' in body");
  assert.ok(i > 0, 'an explicit guard for the field');
  const guard = server.slice(i - 120, i + 520);
  assert.ok(/req\.hubService/.test(guard) && /hubAuth\.isOwner\(req\.hubUser\)/.test(guard) && /req\.hubPendingTotp/.test(guard) && /req\.hubToken/.test(guard) && /403/.test(guard), 'only the owner, never a service call or an API token');
  assert.ok(/only the owner can change: recordings/.test(guard), 'the refusal says so');
  assert.ok(!/only an admin can change: recordings/.test(server), 'no longer "any admin"');
  assert.ok(i < server.indexOf('const { updateAgentField } = require'), 'the guard runs before the update');
});

test('server.js: a change of the allowed list sends "Recording access changed" to everyone on the old and the new list', () => {
  const i = server.indexOf("title: 'Recording access changed'");
  assert.ok(i > 0, 'the notice is sent');
  const around = server.slice(i - 900, i + 500);
  assert.ok(/notifyUsers\(/.test(around));
  assert.ok(/\$\{\(rec && rec\.display\) \|\| name\}: the list of people who can download its recordings was changed\./.test(around), 'the body names the agent by its display name');
  assert.ok(/new Set\(\[\.\.\.allowedBefore, \.\.\.allowedAfter\]\)/.test(around), 'old and new list, one notice each');
  assert.ok(/allowedBefore\.some\(id => !allowedAfter\.includes\(id\)\)/.test(around), 'only when the list changed');
  assert.ok(i > server.indexOf('const result = await updateAgentField(name, body'), 'sent after a successful change');
});

// ── agents with recordings can't be renamed or deleted; a clone has none ──
const RECORDINGS_ERROR = 'This agent has call recordings. Download and delete them on the Recordings page first.';
const withRecordings = (agent, sid = '20261113-220000-0a0b0c') => fs.mkdirSync(path.join(HOME, 'call-recordings', agent, sid), { recursive: true });
test('delete and rename are refused while the agent has a recording session folder, with the plain message', async () => {
  seed([base({ name: 'life-story', display: 'Life Story' }), base({ name: 'helper', display: 'Helper' })]);
  withRecordings('life-story');
  assert.deepStrictEqual(await agentsLib.deleteAgent('life-story'), { success: false, error: RECORDINGS_ERROR });
  assert.deepStrictEqual(await agentsLib.renameAgent('life-story', 'memoir'), { success: false, error: RECORDINGS_ERROR });
  assert.ok(onDisk('life-story') && !onDisk('memoir'), 'nothing changed');
  // a name that is a clone's, with no recordings of its own, is not blocked by this rule: the refusal for "helper" (busy, grants...) is never the recordings one
  const r = await agentsLib.deleteAgent('no-such-agent');
  assert.deepStrictEqual(r, { success: false, error: 'Agent not found' });
});

test('cloning an agent with recordings is fine, and the clone does not copy the recordings setting', async () => {
  seed([base({ name: 'life-story', display: 'Life Story', recordings: { ...DEFAULTS, keep: true, allowed: [SAM], keepReplies: true, consentLine: 'Hello.', mic: 'unprocessed' } })]);
  withRecordings('life-story', '20261113-220000-0a0b0d');
  const r = await agentsLib.cloneAgent('life-story', 'life-story-copy');
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.ok(onDisk('life-story').recordings.keep, 'the source keeps its setting');
  const clone = onDisk('life-story-copy');
  assert.ok(clone, 'the clone exists');
  assert.ok(!('recordings' in clone), 'no recordings field on the clone');
  assert.ok(!fs.existsSync(path.join(HOME, 'call-recordings', 'life-story-copy')), 'no recordings for the clone');
});

test('server.js: the PATCH route passes an audit callback that writes agent.recordings through hubAuth.audit', () => {
  const i = server.indexOf("const result = await updateAgentField(name, body");
  assert.ok(i > 0);
  const call = server.slice(i, i + 700);
  assert.ok(/audit: \(action, detail\) => hubAuth\.audit\(/.test(call));
});

// ── GET /api/agents shaping ──
test('shaping: a member sees no allowed list; canDownload is right for every caller', () => {
  const agent = { name: 'biographer', recordings: { ...DEFAULTS, keep: true, allowed: [OWNER, PATIENT_A], keepReplies: true, mic: 'unprocessed', consentLine: 'Hello.' } };
  const forMember = rs.recordingsForViewer(agent, { admin: false, userId: SAM });
  assert.deepStrictEqual(forMember, { keep: true, consentLine: 'Hello.', keepReplies: true, mic: 'unprocessed', canDownload: false });
  assert.ok(!('allowed' in forMember));
  assert.deepStrictEqual(rs.recordingsForViewer(agent, { admin: false, userId: PATIENT_A }), { keep: true, consentLine: 'Hello.', keepReplies: true, mic: 'unprocessed', canDownload: true });
  assert.deepStrictEqual(rs.recordingsForViewer(agent, { admin: true, userId: OWNER }), { ...agent.recordings, canDownload: true });
  assert.strictEqual(rs.recordingsForViewer(agent, { admin: true, userId: SAM }).canDownload, false, 'an admin off the list cannot download');
  assert.deepStrictEqual(rs.recordingsForViewer(agent, { admin: true, userId: SAM }).allowed, [OWNER, PATIENT_A], 'an admin sees the list');
  assert.strictEqual(rs.recordingsForViewer(agent, { admin: false, userId: '' }).canDownload, false, 'no user (the hub itself): no');
  assert.ok(!('allowed' in rs.recordingsForViewer(agent, {})));
});

test('shaping: an agent with no setting shows the defaults and canDownload false', () => {
  assert.deepStrictEqual(rs.recordingsForViewer({ name: 'helper' }, { admin: false, userId: SAM }), { keep: false, consentLine: DEFAULTS.consentLine, keepReplies: false, mic: 'processed', canDownload: false });
});

test('server.js: GET /api/agents uses the shaping, a service call counts as no admin and no user', () => {
  const i = server.indexOf('const recView = ');
  assert.ok(i > 0);
  const chunk = server.slice(i, i + 700);
  assert.ok(/admin: access\.isAdmin\(req\.hubUser\)/.test(chunk));
  assert.ok(/recordingsForViewer/.test(chunk) && /recordings: recordingsFor\(a, recView\)/.test(chunk));
  assert.ok(!/hubService/.test(chunk.split('\n')[0]), 'the service identity is never treated as an admin for this field');
});
