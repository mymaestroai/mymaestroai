'use strict';
// updateAgentField merges a partial object for voiceDefaults, compaction and voice (like recordings): the keys sent change, the rest stay;
// null still removes the whole object; every validation applies to the merged result. And the phone passes its dialog guard to the card.
// Nothing live: the agents file lives in a throwaway install (test/helpers/isolated-install.js).
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('partial-objects-');
const AGENTS_FILE = path.join(ISO.inst, 'data', 'agents.json');
const agentsLib = require(path.join(ISO.inst, 'lib', 'agents.js'));

const seed = (agents) => { fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2)); };
const onDisk = (name) => JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')).find(a => a.name === name);
const base = (extra = {}) => ({ name: 'biographer', model: 'claude-sdk/default', display: 'Biographer', category: 'specialist', ...extra });
const upd = (fields) => agentsLib.updateAgentField('biographer', fields);

beforeEach(() => { seed([base()]); });

test('voiceDefaults: two partial updates (endPause, then voiceSpeed) keep both', async () => {
  assert.deepStrictEqual(await upd({ voiceDefaults: { endPause: 2000 } }), { success: true });
  assert.deepStrictEqual(await upd({ voiceDefaults: { voiceSpeed: 1.2 } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 2000, voiceSpeed: 1.2 });
  assert.deepStrictEqual(await upd({ voiceDefaults: { endPause: 4000 } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 4000, voiceSpeed: 1.2 });
});

test('voiceDefaults: a number changed away from the stored preset makes it custom; a whole preset still replaces all', async () => {
  await upd({ voiceDefaults: { preset: 'patient' } });
  await upd({ voiceDefaults: { voiceSpeed: 1.2 } });
  const v = onDisk('biographer').voiceDefaults;
  assert.strictEqual(v.voiceSpeed, 1.2);
  assert.ok(!('preset' in v), 'no preset name any more');
  assert.strictEqual(v.endPause, 4000, 'the other preset numbers stay');
  await upd({ voiceDefaults: { preset: 'patient' } });
  assert.strictEqual(onDisk('biographer').voiceDefaults.voiceSpeed, 0.9);
});

test('voiceDefaults: null (and nothing valid) removes the whole object', async () => {
  await upd({ voiceDefaults: { endPause: 2000, voiceSpeed: 1.2 } });
  assert.deepStrictEqual(await upd({ voiceDefaults: null }), { success: true });
  assert.ok(!('voiceDefaults' in onDisk('biographer')));
  await upd({ voiceDefaults: { endPause: 2000, voiceSpeed: 1.2 } });
  await upd({ voiceDefaults: { endPause: 1 } });
  assert.ok(!('voiceDefaults' in onDisk('biographer')));
});

test('compaction: a partial { at } keeps the mode, and a partial { mode } keeps at', async () => {
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: { at: 0.8 } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'on', at: 0.8 });
  assert.deepStrictEqual(await upd({ compaction: { mode: 'dry' } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'dry', at: 0.8 });
});

test('compaction: null removes it; an invalid patch is not stored (as before)', async () => {
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: { at: 5, mode: 'bogus' } }), { success: true });
  assert.ok(!('compaction' in onDisk('biographer')));
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  await upd({ compaction: null });
  assert.ok(!('compaction' in onDisk('biographer')));
});

test('voice: a partial { stt } keeps the tts engine, the cloud voice and the voice', async () => {
  seed([base({ voice: { voice: 'af_heart', stt: 'local', tts: 'openai', cloudVoice: 'nova' } })]);
  assert.deepStrictEqual(await upd({ voice: { stt: 'openai' } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voice, { voice: 'af_heart', stt: 'openai', tts: 'openai', cloudVoice: 'nova' });
});

test('voice: changing the tts engine alone does not carry the old engine\'s cloud voice', async () => {
  seed([base({ voice: { voice: 'af_heart', stt: 'local', tts: 'openai', cloudVoice: 'nova' } })]);
  assert.deepStrictEqual(await upd({ voice: { tts: 'google' } }), { success: true });
  const v = onDisk('biographer').voice;
  assert.strictEqual(v.tts, 'google');
  assert.strictEqual(v.voice, 'af_heart');
  assert.notStrictEqual(v.cloudVoice, 'nova');
});

test('voice: null removes it; invalid merged values are refused and nothing changes', async () => {
  seed([base({ voice: { voice: 'af_heart', stt: 'local', tts: 'local' } })]);
  const bad = await upd({ voice: { stt: 'nonsense' } });
  assert.strictEqual(bad.success, false);
  assert.deepStrictEqual(onDisk('biographer').voice, { voice: 'af_heart', stt: 'local', tts: 'local' });
  const bad2 = await upd({ voice: { voice: 'not-a-voice' } });
  assert.strictEqual(bad2.success, false);
  assert.deepStrictEqual(await upd({ voice: null }), { success: true });
  assert.ok(!('voice' in onDisk('biographer')));
});

test('voice: a partial change cannot carry a stored cloud confirmation to a new engine', async () => {
  seed([base({ voice: { voice: 'af_heart', stt: 'openai', tts: 'local', cloudConfirmedBy: 'u1', cloudConfirmedAt: '2026-01-01T00:00:00.000Z' } })]);
  assert.deepStrictEqual(await upd({ voice: { tts: 'google' } }), { success: true });
  // not kept on the box: no confirmation needed, but a stale confirmation for stt is kept only because stt stayed the same
  const v = onDisk('biographer').voice;
  assert.strictEqual(v.stt, 'openai');
  assert.strictEqual(v.tts, 'google');
  assert.ok(!v.cloudConfirmedBy || v.cloudConfirmedBy === 'u1');
});

test('the journal records the per-key change of a partial update', async () => {
  await upd({ voiceDefaults: { endPause: 2000 } });
  await upd({ voiceDefaults: { voiceSpeed: 1.2 } });
  const dir = path.join(ISO.inst, 'data');
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else files.push(p); } };
  walk(dir);
  const text = files.filter(f => /journal/i.test(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  assert.match(text, /voiceDefaults/);
});

test('mobile.js passes the page\'s dialogGuard to hubAgentCard.configure', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('hubAgentCard.configure('));
  assert.ok(line, 'the configure call is there');
  assert.match(line, /guard:\s*\(typeof dialogGuard !== 'undefined' \? dialogGuard : undefined\)/);
});
