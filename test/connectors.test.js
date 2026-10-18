'use strict';
// Data connectors (lib/connectors): grants, passphrase scopes, child hygiene, policy classes, idle lock. Uses the real
// stdio MCP client against test/fixtures/fake-mcp.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createConnectors } = require('../lib/connectors');
const McpStdioClient = require('../lib/skills/mcp-stdio');
const FAKE = path.join(__dirname, 'fixtures', 'fake-mcp.js');
const PASS = 'correct horse battery';

function rig(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-'));
  const logs = []; const events = []; const timers = [];
  const cx = createConnectors({
    file: path.join(dir, 'connectors.json'), keyFile: path.join(dir, '.auth-key'),
    McpClient: McpStdioClient, now: () => 1_700_000_000_000, log: (...a) => logs.push(a.join(' ')), publish: (t, d) => events.push({ t, d }),
    unlockTtlMs: o.ttl == null ? 0 : o.ttl, setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; },
    baseEnv: { PATH: process.env.PATH, HOME: '/tmp/h', ANTHROPIC_API_KEY: 'sk-ant-LEAK', OPENAI_API_KEY: 'sk-LEAK', HUB_TOKEN: 'LEAK' },
    skills: o.skills || null,
  });
  const mcp = (extra = {}) => ({ id: 'fake', label: 'Fake service', kind: 'mcp', command: process.execPath, args: [FAKE], enabled: true, ...extra });
  return { cx, dir, logs, events, timers, mcp };
}
const envOf = async (cx, agent) => JSON.parse(await (await cx.toolSpecsFor(agent)).find(t => t.tool === 'env').handler({}));

test('grants: ungranted agent gets no tools; a granted agent gets them on its own turn only (never at consultation depth > 0)', async (t) => {
  const { cx, mcp } = rig(); t.after(() => cx.shutdown());
  cx.upsert(mcp({ agents: ['gp'], secrets: { FAKE_TOKEN: 'tok-123456' } }));
  assert.deepEqual(await cx.toolSpecsFor('trader'), []);
  const mine = await cx.toolSpecsFor('gp');
  assert.deepEqual(mine.map(x => x.name).sort(), ['fake__env', 'fake__get_record', 'fake__send_message']);
  assert.deepEqual(await cx.toolSpecsFor('gp', { consultationDepth: 1 }), []);
  assert.equal(await mine.find(x => x.tool === 'get_record').handler({ id: '7' }), 'record 7 via token');
  assert.ok(cx.contextTextFor('gp').includes('Fake service (tools "fake__*"): available'));
  assert.equal(cx.contextTextFor('trader'), '');
});

test('child hygiene: the MCP server gets a minimal environment plus its secrets, never the hub\'s provider keys; stderr and errors are redacted', async (t) => {
  const { cx, mcp, logs } = rig(); t.after(() => cx.shutdown());
  cx.upsert(mcp({ secrets: { FAKE_TOKEN: 'tok-SECRET-9' }, dataHome: '/tmp/home-x' }));
  const e = await envOf(cx, 'anyone');
  assert.equal(e.token, 'tok-SECRET-9'); assert.equal(e.id, 'fake'); assert.equal(e.home, '/tmp/home-x');
  for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HUB_TOKEN']) assert.ok(!e.keys.includes(k), `${k} must not reach the child`);
  assert.ok(e.keys.includes('PATH'));
  // a failed start records the error without the secret value
  cx.upsert({ id: 'broken', kind: 'mcp', command: '/nonexistent/tok-SECRET-9/bin', enabled: true, secrets: { FAKE_TOKEN: 'tok-SECRET-9' } });
  await cx.toolSpecsFor('anyone');
  const b = cx.list().connectors.find(c => c.id === 'broken');
  assert.ok(b.lastError && !b.lastError.includes('tok-SECRET-9') && b.lastError.includes('[secret]'), b.lastError);
  assert.ok(logs.every(l => !l.includes('tok-SECRET-9')), 'no log line carries the secret');
});

test('passphrases: own and group scopes lock the tools and the secrets; wrong passphrase refused; lowering protection needs the current passphrase; secrets survive every scope change', async (t) => {
  const { cx, mcp } = rig(); t.after(() => cx.shutdown());
  cx.upsert(mcp({ secrets: { FAKE_TOKEN: 'tok-roundtrip' } }));
  cx.upsert({ id: 'fake', protect: 'own' }, { newPassphrase: PASS });          // none -> own (fresh lock, stays unlocked)
  assert.equal((await envOf(cx, 'x')).token, 'tok-roundtrip');
  cx.lock('fake');
  assert.deepEqual(await cx.toolSpecsFor('x'), []);
  assert.match(cx.contextTextFor('x'), /LOCKED by the owner's passphrase/);
  assert.throws(() => cx.unlock('fake', 'wrong passphrase'), /Wrong passphrase/);
  assert.throws(() => cx.upsert({ id: 'fake', protect: 'none' }), /Wrong passphrase|No lock/);
  assert.throws(() => cx.upsert({ id: 'fake', secrets: { FAKE_TOKEN: 'x' } }), /Unlock/);
  cx.unlock('fake', PASS);
  assert.equal((await envOf(cx, 'x')).token, 'tok-roundtrip');
  cx.createGroup('medical', 'Medical', 'medical pass phrase');
  cx.upsert({ id: 'fake', protect: 'group', group: 'medical' }, { passphrase: PASS });   // own -> group
  assert.equal((await envOf(cx, 'x')).token, 'tok-roundtrip');
  cx.lockGroup('medical');
  assert.equal(cx.list().connectors[0].unlocked, false);
  assert.deepEqual(await cx.toolSpecsFor('x'), []);
  assert.throws(() => cx.unlock('fake', 'nope nope nope'), /Wrong passphrase/);
  cx.unlock('fake', 'medical pass phrase');                                   // unlocking the connector unlocks its group
  assert.equal(cx.group('medical').unlocked, true);
  assert.throws(() => cx.deleteGroup('medical', 'medical pass phrase'), /still protects/);
  cx.upsert({ id: 'fake', protect: 'none' }, { passphrase: 'medical pass phrase' });  // group -> none, audited
  assert.equal((await envOf(cx, 'x')).token, 'tok-roundtrip');
  assert.deepEqual(cx.deleteGroup('medical', 'medical pass phrase'), { ok: true });
});

test('files are private and no secret is stored in clear', async (t) => {
  const { cx, dir, mcp, logs } = rig(); t.after(() => cx.shutdown());
  cx.upsert(mcp({ secrets: { FAKE_TOKEN: 'tok-plain-check' } }));
  const f = path.join(dir, 'connectors.json');
  assert.equal((fs.statSync(f).mode & 0o777).toString(8), '600');
  assert.ok(!fs.readFileSync(f, 'utf8').includes('tok-plain-check'));
  assert.ok(logs.some(l => /AUDIT|created "fake"/.test(l)));
  cx.upsert({ id: 'fake', protect: 'own' }, { newPassphrase: PASS });
  cx.upsert({ id: 'fake', protect: 'none' }, { passphrase: PASS });
  assert.ok(logs.some(l => /AUDIT "fake" protection changed own -> none/.test(l)), 'lowering protection is audited');
});

test('idle timeout: an unlocked scope locks itself again and stops the child', async (t) => {
  const { cx, mcp, timers } = rig({ ttl: 60000 }); t.after(() => cx.shutdown());
  cx.upsert(mcp({ secrets: { FAKE_TOKEN: 't-123456' } }));
  cx.upsert({ id: 'fake', protect: 'own' }, { newPassphrase: PASS });
  assert.equal((await envOf(cx, 'x')).token, 't-123456');
  assert.equal(cx.list().connectors[0].running, true);
  const tmr = timers.find(x => x.ms === 60000 && !x.cleared); assert.ok(tmr, 'a lock timer is armed');
  tmr.fn();
  assert.equal(cx.list().connectors[0].unlocked, false);
  assert.equal(cx.list().connectors[0].running, false, 'lock stops the child');
  assert.deepEqual(await cx.toolSpecsFor('x'), []);
});

test('policy classes: declared send -> send, read-only annotation -> read_outside, sensitive reads -> admin, undeclared -> write_outside; registered into tool-policy', async (t) => {
  const { cx, mcp } = rig(); t.after(() => cx.shutdown());
  cx.upsert(mcp({ tools: { send_message: { cls: 'send' } } }));
  await cx.toolSpecsFor('x');   // discovers tools (annotations)
  assert.equal(cx.classifyToolCall({ tool: 'fake__send_message', input: { to: 'bob' } }).cls, 'send');
  assert.equal(cx.classifyToolCall({ tool: 'fake__get_record', input: {} }).cls, 'read_outside');
  assert.equal(cx.classifyToolCall({ tool: 'fake__env', input: {} }).cls, 'write_outside');
  assert.equal(cx.classifyToolCall({ tool: 'nothere__x' }), null);
  cx.upsert({ id: 'fake', sensitive: true });
  assert.equal(cx.classifyToolCall({ tool: 'fake__get_record', input: {} }).cls, 'admin');
  assert.equal(cx.classifyToolCall({ tool: 'fake__get_record' }).destKey, 'fake');
  const tp = require('../lib/tool-policy');
  const off = tp.registerToolClassifier((q) => cx.classifyToolCall(q));
  try {
    assert.equal(tp.classifyTool({ tool: 'mcp__agent-hub__fake__get_record', input: {}, agentName: 'gp', policy: { roots: [] } }).cls, 'admin');
    assert.equal(tp.classifyTool({ tool: 'slack__get_channel', input: {}, agentName: 'gp', policy: { roots: [] } }).cls, 'read_outside', 'plain skills unchanged');
  } finally { off(); }
  const tested = await cx.test('fake');
  assert.deepEqual(tested.tools.map(x => [x.name, x.cls]).sort(), [['env', 'write'], ['get_record', 'read'], ['send_message', 'send']]);
});

test('tool-name collision inside a connector is refused, not shadowed', async (t) => {
  const { cx, logs } = rig(); t.after(() => cx.shutdown());
  cx.upsert({ id: 'coll', kind: 'mcp', command: process.execPath, args: [FAKE], enabled: true, secrets: { FAKE_COLLIDE: '1' } });
  const names = (await cx.toolSpecsFor('x')).map(x => x.name);
  assert.equal(names.filter(n => n === 'coll__get_record').length, 1);
  assert.ok(logs.some(l => /collision on coll__get_record/.test(l)));
});

test('wrapped skills leave the ungated skill path: wrappedSkillIds() and getSkillTools({ exclude })', async () => {
  const skills = { SKILLS: { gw: { label: 'GW' } }, discoverTools: async () => [{ name: 'list_events', description: 'x' }], executeMcpTool: async (id, tool) => `${id}:${tool}` };
  const { cx } = rig({ skills });
  cx.upsert({ id: 'cal', kind: 'skill', skillId: 'gw', enabled: true, agents: ['gp'] });
  assert.deepEqual([...cx.wrappedSkillIds()], ['gw']);
  assert.throws(() => cx.upsert({ id: 'cal2', kind: 'skill', skillId: 'gw' }), /already wrapped/);
  assert.deepEqual(await cx.toolSpecsFor('trader'), []);
  const mine = await cx.toolSpecsFor('gp');
  assert.equal(await mine[0].handler({}), 'gw:list_events');
  const sm = require('../lib/skills/skill-manager');
  const r = await sm.getSkillTools({ exclude: new Set(Object.keys(sm.SKILLS)) });
  assert.deepEqual(r.openaiTools, [], 'every skill excluded -> nothing exposed, nothing spawned');
});

test('validation: ids, kinds, protect values, secret names, agents list parsing', () => {
  const { cx } = rig();
  assert.throws(() => cx.upsert({ id: 'Bad Id' }), /Connector id/);
  assert.throws(() => cx.upsert({ id: 'ok', kind: 'nope' }), /kind must be/);
  assert.throws(() => cx.upsert({ id: 'ok', kind: 'mcp', protect: 'weird' }), /protect must be/);
  assert.throws(() => cx.upsert({ id: 'ok', kind: 'mcp', secrets: { 'lower': 'x' } }), /UPPER_CASE/);
  assert.throws(() => cx.upsert({ id: 'ok', kind: 'mcp', protect: 'own' }, { newPassphrase: 'short' }), /at least 8/);
  const c = cx.upsert({ id: 'ok', kind: 'mcp', command: 'x', agents: 'gp, labs ,gp' });
  assert.deepEqual(c.agents, ['gp', 'labs']);
  assert.deepEqual(cx.setGrants('ok', null).agents, null);
  assert.deepEqual(cx.remove('ok'), { ok: true });
  assert.throws(() => cx.remove('ok'), /No connector/);
});

test('zodShapeFromJsonSchema: MCP input schemas become sdk.tool shapes (required vs optional, enums, arrays, nested objects, fallback)', () => {
  const { z } = require('zod');
  const { zodShapeFromJsonSchema } = require('../lib/connectors');
  const shape = zodShapeFromJsonSchema(z, { type: 'object', required: ['id', 'kind'], properties: {
    id: { type: 'string', description: 'record id' }, kind: { type: 'string', enum: ['lab', 'note'] }, limit: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } }, filter: { type: 'object', properties: { since: { type: 'string' } } }, flag: { type: ['boolean', 'null'] } } });
  const obj = z.object(shape);
  assert.deepEqual(obj.parse({ id: 'x', kind: 'lab' }), { id: 'x', kind: 'lab' });
  assert.deepEqual(obj.parse({ id: 'x', kind: 'note', limit: 3, tags: ['a'], filter: { since: '2026', extra: 1 }, flag: true }), { id: 'x', kind: 'note', limit: 3, tags: ['a'], filter: { since: '2026', extra: 1 }, flag: true });
  assert.throws(() => obj.parse({ id: 'x' }), /kind/);
  assert.throws(() => obj.parse({ id: 'x', kind: 'other' }));
  assert.equal(shape.id.description, 'record id');
  const fb = zodShapeFromJsonSchema(z, null);
  assert.ok(fb.input && z.object(fb).parse({}) && z.object(fb).parse({ input: { a: 1 } }).input.a === 1);
});

test('wiring: both dispatch paths expose connector tools and the context block; routes and shutdown exist', () => {
  const sdk = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
  assert.ok(sdk.includes("connectorsLib.getConnectors().toolSpecsFor(agentName, { consultationDepth })"), 'tool specs per agent and depth');
  assert.ok(sdk.includes('...connectorSdkTools,'), 'SDK path');
  assert.ok(sdk.includes("getSkillTools({ exclude })"), 'wrapped skills excluded from the ungated path');
  assert.equal((sdk.match(/\+ connectorsTextFor\(agentName\)/g) || []).length, 3, 'context block on the gateway path and both SDK prompt builders');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const r of ["pathname === '/api/connectors' && req.method === 'POST'", "'/api/connectors/lock-all'", "(unlock|lock|test|grants)", "'/api/connector-groups' && req.method === 'POST'"]) assert.ok(srv.includes(r), r);
  assert.ok(srv.includes("require('./lib/connectors').getConnectors().shutdown()"), 'children stopped on shutdown');
});
