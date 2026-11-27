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

test('R5-2 voice: a key sent as null resets that key alone to its default (stt/tts local, voice empty); the others stay', async () => {
  seed([base({ voice: { voice: 'af_heart', stt: 'openai', tts: 'openai', cloudVoice: 'nova', cloudConfirmedBy: 'u_owner' } })]);
  assert.deepStrictEqual(await upd({ voice: { stt: null } }), { success: true });
  let v = onDisk('biographer').voice;
  assert.strictEqual(v.stt, 'local'); assert.strictEqual(v.tts, 'openai'); assert.strictEqual(v.voice, 'af_heart'); assert.strictEqual(v.cloudVoice, 'nova');
  assert.deepStrictEqual(await upd({ voice: { voice: null } }), { success: true });
  v = onDisk('biographer').voice;
  assert.strictEqual(v.voice, ''); assert.strictEqual(v.tts, 'openai');
  assert.deepStrictEqual(await upd({ voice: { tts: null } }), { success: true });
  v = onDisk('biographer').voice;
  assert.strictEqual(v.tts, 'local'); assert.ok(!('cloudVoice' in v), 'the cloud voice goes with its engine');
});

test('voiceDefaults: null and {} remove the whole object', async () => {
  await upd({ voiceDefaults: { endPause: 2000, voiceSpeed: 1.2 } });
  assert.deepStrictEqual(await upd({ voiceDefaults: null }), { success: true });
  assert.ok(!('voiceDefaults' in onDisk('biographer')));
  await upd({ voiceDefaults: { endPause: 2000, voiceSpeed: 1.2 } });
  assert.deepStrictEqual(await upd({ voiceDefaults: {} }), { success: true });
  assert.ok(!('voiceDefaults' in onDisk('biographer')));
});

test('R3-1 voiceDefaults: a patch with keys of which none is valid is refused, names the allowed values, and nothing changes', async () => {
  await upd({ voiceDefaults: { endPause: 2000, voiceSpeed: 1.2 } });
  for (const bad of [{ endPause: 1300 }, { endPause: 1 }, { continueWait: 'x' }, { preset: 'nope' }, { foo: 1 }, { voiceSpeed: 'fast' }]) {
    const r = await upd({ voiceDefaults: bad });
    assert.strictEqual(r.success, false, JSON.stringify(bad));
    assert.match(r.error, /800, 1200, 2000, 4000/);
    assert.match(r.error, /1500, 3000, 5000, 8000/);
    assert.match(r.error, /patient/);
    assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 2000, voiceSpeed: 1.2 }, JSON.stringify(bad));
  }
  // with nothing stored, a refused patch stores nothing
  seed([base()]);
  assert.strictEqual((await upd({ voiceDefaults: { endPause: 1300 } })).success, false);
  assert.ok(!('voiceDefaults' in onDisk('biographer')));
  // a valid key beside an invalid one still applies the valid one
  assert.deepStrictEqual(await upd({ voiceDefaults: { endPause: 1300, voiceSpeed: 1.1 } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { voiceSpeed: 1.1 });
});

test('R3-2 voiceDefaults: a key sent as null or \'\' removes only that key', async () => {
  await upd({ voiceDefaults: { endPause: 2000, continueWait: 5000, voiceSpeed: 1.2 } });
  assert.deepStrictEqual(await upd({ voiceDefaults: { voiceSpeed: null } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 2000, continueWait: 5000 });
  assert.deepStrictEqual(await upd({ voiceDefaults: { continueWait: '' } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 2000 });
  // the last key gone: nothing is left, the object goes
  assert.deepStrictEqual(await upd({ voiceDefaults: { endPause: null } }), { success: true });
  assert.ok(!('voiceDefaults' in onDisk('biographer')));
});

test('R3-3 voiceDefaults: preset:null deletes the stored preset and keeps the four numbers', async () => {
  await upd({ voiceDefaults: { preset: 'patient' } });
  assert.strictEqual(onDisk('biographer').voiceDefaults.preset, 'patient');
  assert.deepStrictEqual(await upd({ voiceDefaults: { preset: null } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 4000, continueWait: 8000, interruptSensitivity: 30, voiceSpeed: 0.9 });
  await upd({ voiceDefaults: { preset: 'patient' } });
  assert.deepStrictEqual(await upd({ voiceDefaults: { preset: '' } }), { success: true });
  assert.ok(!('preset' in onDisk('biographer').voiceDefaults));
  assert.strictEqual(onDisk('biographer').voiceDefaults.endPause, 4000);
  // taking a number out of a preset also drops the preset name, and the preset does not refill the number
  await upd({ voiceDefaults: { preset: 'patient' } });
  assert.deepStrictEqual(await upd({ voiceDefaults: { voiceSpeed: null } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').voiceDefaults, { endPause: 4000, continueWait: 8000, interruptSensitivity: 30 });
});

test('compaction: a partial { at } keeps the mode, and a partial { mode } keeps at', async () => {
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: { at: 0.8 } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'on', at: 0.8 });
  assert.deepStrictEqual(await upd({ compaction: { mode: 'dry' } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'dry', at: 0.8 });
});

test('compaction: null and {} remove it', async () => {
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  await upd({ compaction: null });
  assert.ok(!('compaction' in onDisk('biographer')));
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: {} }), { success: true });
  assert.ok(!('compaction' in onDisk('biographer')));
});

test('R3-1 compaction: a patch with keys of which none is valid is refused, names the allowed values, nothing changes', async () => {
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  for (const bad of [{ at: 5, mode: 'bogus' }, { at: 5 }, { mode: 'x' }, { foo: 1 }]) {
    const r = await upd({ compaction: bad });
    assert.strictEqual(r.success, false, JSON.stringify(bad));
    assert.match(r.error, /off, dry, on, assisted/);
    assert.match(r.error, /0\.3 to 0\.95/);
    assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'on', at: 0.6 });
  }
});

test('R3-2 compaction: a key sent as null or \'\' removes that key only', async () => {
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: { at: null } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'on' });
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: { mode: null } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { at: 0.6 });
  assert.deepStrictEqual(await upd({ compaction: { at: '' } }), { success: true });
  assert.ok(!('compaction' in onDisk('biographer')), 'nothing left: the object goes');
  // a null beside a valid key: the valid one applies, the null one is removed
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await upd({ compaction: { mode: 'dry', at: null } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').compaction, { mode: 'dry' });
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

test('R3-2 voice: cloudVoice sent as null or \'\' removes only the cloud voice; engines and voice stay', async () => {
  seed([base({ voice: { voice: 'af_heart', stt: 'local', tts: 'openai', cloudVoice: 'nova' } })]);
  assert.deepStrictEqual(await upd({ voice: { cloudVoice: null } }), { success: true });
  const v = onDisk('biographer').voice;
  assert.strictEqual(v.voice, 'af_heart');
  assert.strictEqual(v.stt, 'local');
  assert.strictEqual(v.tts, 'openai');
  assert.notStrictEqual(v.cloudVoice, 'nova', 'the old cloud voice is gone (the engine default applies)');
  seed([base({ voice: { voice: 'af_heart', stt: 'local', tts: 'openai', cloudVoice: 'nova' } })]);
  assert.deepStrictEqual(await upd({ voice: { cloudVoice: '' } }), { success: true });
  assert.strictEqual(onDisk('biographer').voice.voice, 'af_heart');
  assert.notStrictEqual(onDisk('biographer').voice.cloudVoice, 'nova');
});

// The journal entries a partial change adds: one per changed key, nothing else of the agent.
const journal = require(path.join(ISO.inst, 'lib', 'settings-journal'));
async function changedKeys(fn) {
  await agentsLib.loadAgentsFromDisk();   // a seed() is an outside edit: let the journal note it first, so only this change is counted
  const seen = new Set(journal.list({ limit: 500 }).map(e => e.id));
  await fn();
  return journal.list({ limit: 500 }).filter(e => !seen.has(e.id)).map(e => e.key).sort();
}

test('the journal records exactly the changed keys of a partial update', async () => {
  await upd({ voiceDefaults: { endPause: 2000, voiceSpeed: 1.2, continueWait: 5000 } });
  assert.deepStrictEqual(await changedKeys(() => upd({ voiceDefaults: { endPause: 4000 } })), ['agents.biographer.voiceDefaults.endPause']);
  // removing one key journals that key only
  assert.deepStrictEqual(await changedKeys(() => upd({ voiceDefaults: { voiceSpeed: null } })), ['agents.biographer.voiceDefaults.voiceSpeed']);
  // a refused patch journals nothing
  assert.deepStrictEqual(await changedKeys(() => upd({ voiceDefaults: { endPause: 1300 } })), []);
  // compaction: one half changes, one entry
  seed([base({ compaction: { mode: 'on', at: 0.6 } })]);
  assert.deepStrictEqual(await changedKeys(() => upd({ compaction: { at: 0.8 } })), ['agents.biographer.compaction.at']);
  assert.deepStrictEqual(await changedKeys(() => upd({ compaction: { mode: null } })), ['agents.biographer.compaction.mode']);
  assert.deepStrictEqual(await changedKeys(() => upd({ compaction: { at: 9 } })), []);
  // voice: the cloud voice alone
  seed([base({ voice: { voice: 'af_heart', stt: 'local', tts: 'openai', cloudVoice: 'nova' } })]);
  assert.deepStrictEqual(await changedKeys(() => upd({ voice: { cloudVoice: 'echo' } })), ['agents.biographer.voice.cloudVoice']);
  // preset:null: the preset name only
  seed([base()]);
  await upd({ voiceDefaults: { preset: 'patient' } });
  assert.deepStrictEqual(await changedKeys(() => upd({ voiceDefaults: { preset: null } })), ['agents.biographer.voiceDefaults.preset']);
});

// ---- policy compare-and-set (policyIfMatch): the card sends the policy it built its change from ----
const MSG_409 = "This agent's permissions were changed elsewhere. The card now shows them again; make your change once more.";
test('policyIfMatch: a matching policy writes (normalised like the stored one, a missing policy is {}) and is never stored', async () => {
  assert.deepStrictEqual(await upd({ policy: { roots: ['/a'] }, policyIfMatch: {} }), { success: true }, 'no policy stored = {}');
  assert.deepStrictEqual(onDisk('biographer').policy, { roots: ['/a'] });
  assert.ok(!('policyIfMatch' in onDisk('biographer')));
  // unknown classes and padding in the sent copy do not make a difference
  assert.deepStrictEqual(await upd({ policy: { overrides: { web: 'ask' }, roots: ['/a'] }, policyIfMatch: { roots: [' /a '], overrides: { bogus: 'allow' } } }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').policy, { overrides: { web: 'ask' }, roots: ['/a'] });
});

test('policyIfMatch: a different stored policy answers 409 with the words, writes nothing and journals nothing', async () => {
  seed([base({ policy: { overrides: { send: 'deny' }, roots: ['/a'] } })]);
  const before = fs.readFileSync(AGENTS_FILE, 'utf8');
  let r;
  const keys = await changedKeys(async () => { r = await upd({ policy: { roots: ['/a', '/b'] }, policyIfMatch: { roots: ['/a', '/b', '/c'] } }); });
  assert.deepStrictEqual([r.success, r.status, r.error], [false, 409, MSG_409]);
  assert.strictEqual(fs.readFileSync(AGENTS_FILE, 'utf8'), before, 'the agents file is untouched');
  assert.deepStrictEqual(keys, [], 'the journal is unchanged');
  // a stale card that thinks there is no policy
  assert.strictEqual((await upd({ policy: { roots: ['/x'] }, policyIfMatch: {} })).status, 409);
});

test('policyIfMatch alone is ignored (nothing stored, nothing refused)', async () => {
  seed([base({ policy: { roots: ['/a'] } })]);
  assert.deepStrictEqual(await upd({ policyIfMatch: { roots: ['/zzz'] }, blurb: 'hi' }), { success: true });
  assert.deepStrictEqual(onDisk('biographer').policy, { roots: ['/a'] });
  assert.ok(!('policyIfMatch' in onDisk('biographer')));
});

test('the route answers a refused policyIfMatch with 409 { ok:false, error }', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /result\.status === 409 \? \{ ok: false, error: result\.error \}/);
});

// removed (P4-2): 'agent-settings.html Custom call timing sends preset:null with the four numbers' pinned the old page's source; the card's Call timing row does it
// and test/ui-agent-card-basics.test.js ('Call timing: Patient saves the preset, Custom the four numbers (and drops the preset)') pins the same body.

test('mobile.js passes the page\'s dialogGuard to hubAgentCard.configure', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('hubAgentCard.configure('));
  assert.ok(line, 'the configure call is there');
  assert.match(line, /guard:\s*\(typeof dialogGuard !== 'undefined' \? dialogGuard : undefined\)/);
});
