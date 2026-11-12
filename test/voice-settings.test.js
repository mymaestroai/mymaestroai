'use strict';
// The `voice` hub setting (sanitiser used by POST /api/settings) and the per-agent `voice` field (updateAgentField).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const manifest = require('../lib/voice/manifest');

const { cleanVoiceSettings, cleanAgentVoice } = manifest;
const roots = [];
const saved = { mem: process.env.HUB_MEMORY_DB, auth: process.env.HUB_AUTH_DIR };
after(() => {
  for (const [k, v] of [['HUB_MEMORY_DB', saved.mem], ['HUB_AUTH_DIR', saved.auth]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

test('settings sanitiser: known keys only, values checked, merged onto what is stored', () => {
  assert.deepStrictEqual(cleanVoiceSettings({}, undefined), { enabled: false, defaultVoice: '', sttModel: '' });
  assert.deepStrictEqual(cleanVoiceSettings({ enabled: true, defaultVoice: 'bf_emma', sttModel: 'small.en' }, {}), { enabled: true, defaultVoice: 'bf_emma', sttModel: 'small.en' });
  // a partial patch keeps the rest
  const cur = { enabled: true, defaultVoice: 'alba', sttModel: 'tiny.en' };
  assert.deepStrictEqual(cleanVoiceSettings({ defaultVoice: 'lessac' }, cur), { enabled: true, defaultVoice: 'lessac', sttModel: 'tiny.en' });
  assert.deepStrictEqual(cleanVoiceSettings({ enabled: false }, cur), { enabled: false, defaultVoice: 'alba', sttModel: 'tiny.en' });
  // invalid values are ignored, never stored; "" resets to automatic
  assert.deepStrictEqual(cleanVoiceSettings({ defaultVoice: 'robot', sttModel: 'large-v3', enabled: 'yes' }, cur), { enabled: false, defaultVoice: 'alba', sttModel: 'tiny.en' }, 'enabled must be exactly true');
  assert.deepStrictEqual(cleanVoiceSettings({ defaultVoice: '', sttModel: '' }, cur), { enabled: true, defaultVoice: '', sttModel: '' });
  // unknown keys never survive (no way to smuggle a path or a URL in); junk shapes are harmless
  const out = cleanVoiceSettings({ dir: '/etc', url: 'http://x', __proto__: { polluted: 1 }, constructor: 'x', engine: 'cloud' }, cur);
  assert.deepStrictEqual(Object.keys(out).sort(), ['defaultVoice', 'enabled', 'sttModel']);
  assert.strictEqual({}.polluted, undefined);
  for (const junk of [null, 'x', 5, [], undefined]) assert.deepStrictEqual(cleanVoiceSettings(junk, { enabled: true, defaultVoice: 'robot', sttModel: 7 }), { enabled: true, defaultVoice: '', sttModel: '' });
});

test('server.js feeds POST /api/settings through the sanitiser and routes /api/voice/* to lib/voice/routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /patch\.voice = require\('\.\/lib\/voice\/manifest'\)\.cleanVoiceSettings\(patch\.voice, hubSettings\.getSetting\('voice'\)\)/);
  assert.match(src, /pathname\.startsWith\('\/api\/voice\/'\)\) return require\('\.\/lib\/voice\/routes'\)\.handle\(/);
  assert.match(src, /route\.from === 'query'/);
});

test('settings round trip: the cleaned object is stored and shows up in getForUI', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-settings-')); roots.push(dir);
  fs.mkdirSync(path.join(dir, 'lib')); fs.copyFileSync(path.join(__dirname, '..', 'lib', 'settings.js'), path.join(dir, 'lib', 'settings.js'));
  const log = console.log; console.log = () => {};
  let s; try { s = require(path.join(dir, 'lib', 'settings.js')); } finally { console.log = log; }
  assert.strictEqual(s.getSetting('voice'), undefined);
  s.updateSettings({ voice: cleanVoiceSettings({ enabled: true, defaultVoice: 'am_michael' }, s.getSetting('voice')) });
  s.updateSettings({ voice: cleanVoiceSettings({ sttModel: 'small.en' }, s.getSetting('voice')) });
  assert.deepStrictEqual(s.getForUI().voice, { enabled: true, defaultVoice: 'am_michael', sttModel: 'small.en' });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8')).voice, { enabled: true, defaultVoice: 'am_michael', sttModel: 'small.en' });
});

test('agent voice validator: a voice id from the list or empty, stt and tts "local" for now', () => {
  assert.deepStrictEqual(cleanAgentVoice({ voice: 'alba', stt: 'local', tts: 'local' }), { ok: true, value: { voice: 'alba', stt: 'local', tts: 'local' } });
  assert.deepStrictEqual(cleanAgentVoice({ voice: 'bm_george' }), { ok: true, value: { voice: 'bm_george', stt: 'local', tts: 'local' } });
  assert.deepStrictEqual(cleanAgentVoice({ voice: '' }), { ok: true, value: { voice: '', stt: 'local', tts: 'local' } });
  for (const empty of [null, '', undefined]) assert.deepStrictEqual(cleanAgentVoice(empty), { ok: true, value: null });
  for (const v of manifest.VOICE_IDS) assert.ok(cleanAgentVoice({ voice: v }).ok, v);
  for (const bad of [{ voice: 'robot' }, { voice: 5 }, { voice: 'af_heart', stt: 'cloud' }, { voice: 'af_heart', tts: 'cloud' }, 'alba', 7, ['alba']]) {
    const r = cleanAgentVoice(bad); assert.strictEqual(r.ok, false, JSON.stringify(bad)); assert.ok(r.error);
  }
  assert.deepStrictEqual(Object.keys(cleanAgentVoice({ voice: 'alba', evil: 1, __proto__: { x: 1 } }).value), ['voice', 'stt', 'tts'], 'nothing extra is kept');
});

test('updateAgentField: `voice` is an allowed field, validated, stored on the agent, and cleared with null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-agents-')); roots.push(root);
  const hub = path.join(root, 'hub');
  fs.mkdirSync(path.join(root, 'share'));
  fs.cpSync(path.join(__dirname, '..', 'lib'), path.join(hub, 'lib'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(hub, 'package.json'));
  fs.symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(hub, 'node_modules'));
  fs.mkdirSync(path.join(hub, 'data'), { recursive: true });
  fs.writeFileSync(path.join(hub, 'data', 'agents.json'), JSON.stringify([{ name: 'maestro', model: 'm1' }, { name: 'sam_helper', model: 'm1', owner: 'u_sam' }]));
  process.env.HUB_MEMORY_DB = path.join(hub, 'data', 'memory.db'); process.env.HUB_AUTH_DIR = path.join(hub, 'data');
  const gw = new Module(path.join(hub, 'lib', 'gateway-client.js')); gw.filename = gw.id; gw.loaded = true;
  gw.exports = { listModels: async () => ['m1'], chatCompletion: async () => ({ choices: [{ message: { content: '{}' } }] }) };
  require.cache[gw.id] = gw;
  const ag = require(path.join(hub, 'lib', 'agents.js'));
  const onDisk = (n) => JSON.parse(fs.readFileSync(path.join(hub, 'data', 'agents.json'), 'utf8')).find(a => a.name === n);

  let r = await ag.updateAgentField('sam_helper', { voice: { voice: 'bf_emma', stt: 'local', tts: 'local' } });
  assert.strictEqual(r.success, true);
  assert.deepStrictEqual(onDisk('sam_helper').voice, { voice: 'bf_emma', stt: 'local', tts: 'local' });
  assert.deepStrictEqual(onDisk('maestro').voice, undefined, 'other agents untouched');
  const listed = (n) => ag.getAgentsSync(true).find(x => x.name === n);
  assert.deepStrictEqual(listed('sam_helper').voice, { voice: 'bf_emma', stt: 'local', tts: 'local' }, 'the agent list (and /api/agents, /api/voice/tts) carries it');
  assert.strictEqual(listed('maestro').voice, undefined);
  r = await ag.updateAgentField('sam_helper', { voice: { voice: 'robot' } });
  assert.strictEqual(r.success, false); assert.match(r.error, /voice must be one of/);
  assert.strictEqual(onDisk('sam_helper').voice.voice, 'bf_emma', 'a refused change leaves the old value');
  r = await ag.updateAgentField('sam_helper', { voice: { voice: 'alba', tts: 'cloud' } });
  assert.strictEqual(r.success, false);
  r = await ag.updateAgentField('sam_helper', { voice: null });
  assert.strictEqual(r.success, true); assert.strictEqual(onDisk('sam_helper').voice, undefined, 'null clears it');
});

test('members may NOT change an agent\'s voice (conservative): it is not in server.js MEMBER_EDITABLE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const m = src.match(/const MEMBER_EDITABLE = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'MEMBER_EDITABLE found');
  assert.ok(!/voice/.test(m[1]), 'voice stays an admin decision (agent settings page is admin-only today)');
});
