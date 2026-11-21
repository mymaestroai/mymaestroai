'use strict';
// The recording line is neutral and spoken once per person (settings.announce: first | every | never), and a person who has
// already heard it on an earlier call is not told again. Real store in a temp folder, real voice and recordings routes, fake engine.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Every lib/ module is loaded from a throwaway copy of the install (test/helpers/isolated-install.js).
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('rec-announce-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const { Readable, Writable } = require('node:stream');
const voiceRoutes = L('voice/routes');
const recRoutes = L('recordings/routes');
const recIndex = L('recordings');
const rs = L('recordings/settings');
const { createStore } = L('recordings/store');
const { deriveKey } = L('recordings/crypt');
const { createVoiceCalls } = L('voice/call');

const KEY = deriveKey(Buffer.alloc(32, 9));
const sam = { id: 'u_0000000000b2', role: 'member', name: 'Sam' };
const patientA = { id: 'u_0000000000c3', role: 'member', name: 'Patient A' };
const NEW_LINE = 'This conversation is being recorded.';
const OLD_LINE = 'This conversation is being recorded for the family.';
const rec = (o = {}) => ({ keep: true, allowed: [sam.id], keepReplies: false, consentLine: NEW_LINE, mic: 'processed', announce: 'first', ...o });

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = headers || {}; r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { body, user }) {
  const r = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(r, { method, url, headers: { 'content-type': 'application/json' }, hubUser: user, hubService: false });
  return r;
}

// One folder of recordings; setup() may be called again on the same folder for a restart (new store object, new routes state).
function makeFolder() { return fs.mkdtempSync(path.join(os.tmpdir(), 'rec-announce-')); }
function setup(dir, { settings = rec(), storeOverride = null } = {}) {
  const clock = { t: Date.UTC(2026, 10, 13, 22, 0, 0) };
  const store = storeOverride || createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  recIndex.setStoreForTests(store);
  const calls = createVoiceCalls({ now: () => clock.t, bus: { publish() {} } });
  const agents = [{ name: 'biographer', owner: sam.id, voice: { voice: 'bm_george', stt: 'local', tts: 'local' }, recordings: settings }];
  const engine = {
    paths: { web: dir, dir, worker: path.join(dir, 'w.js') },
    status: () => ({ enabled: true, ready: true, installing: false, step: 'ready', progress: 1, error: '', platformSupported: true, stt: { engine: 'local', model: 'tiny.en' }, tts: { engine: 'local', defaultVoice: 'af_heart' }, voices: [] }),
    install: () => Promise.resolve(),
  };
  const client = { stt: async () => ({ text: 'hi', ms: 1 }), tts: async () => ({ wav: Buffer.from('RIFF'), ms: 1 }), stop() {}, resume() {} };
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getSetting: (k, d) => (k === 'voice' ? { enabled: true, defaultVoice: '', sttModel: '' } : d),
    updateSettings: () => {},
    getAgents: async () => agents,
    getVoice: () => ({ engine, client }),
    voiceCall: calls, store,
    cloud: { keys: () => ({}), stt: async () => ({ text: 'x', ms: 1, engine: 'openai' }) },
    now: () => clock.t,
    audit: () => {},
  };
  const run = async (mod, req) => { const res = fakeRes(); const u = new URL(req.url, 'http://x'); await mod.handle(u.pathname, req, res, deps); if (!res.writableEnded) await new Promise(r => setTimeout(r, 5)); await res.finished; return res; };
  const start = async (user) => (await run(voiceRoutes, fakeReq('POST', '/api/voice/call', { user, body: { action: 'start', agent: 'biographer' } }))).json();
  const end = (user, callId) => run(voiceRoutes, fakeReq('POST', '/api/voice/call', { user, body: { action: 'end', agent: 'biographer', callId } }));
  // What the page does after it spoke (or did not speak) the line.
  const consent = async (user, callId, extra = {}) => (await run(recRoutes, fakeReq('POST', '/api/recordings/consent', { user, body: { agent: 'biographer', callId, ...extra } }))).json();
  return { dir, store, agents, start, end, consent, cleanup: () => recIndex.setStoreForTests(null) };
}
const settle = () => new Promise(r => setTimeout(r, 25));

test('1. the default line is neutral; the old default reads as the new one; a custom line is kept', () => {
  assert.strictEqual(rs.DEFAULT_CONSENT_LINE, NEW_LINE);
  assert.strictEqual(rs.OLD_DEFAULT_CONSENT_LINE, OLD_LINE);
  assert.strictEqual(rs.cleanRecordingsFull({ consentLine: OLD_LINE }).consentLine, NEW_LINE);
  assert.strictEqual(rs.cleanRecordingsFull({ consentLine: `  ${OLD_LINE}  ` }).consentLine, NEW_LINE);
  assert.strictEqual(rs.cleanRecordings({ keep: false, allowed: [], keepReplies: false, consentLine: OLD_LINE, mic: 'processed' }), undefined);
  assert.strictEqual(rs.cleanRecordings({ consentLine: NEW_LINE }), undefined);
  assert.strictEqual(rs.cleanRecordingsFull({ consentLine: 'Hello there.' }).consentLine, 'Hello there.');
  assert.strictEqual(rs.cleanRecordings({ consentLine: 'Hello there.' }).consentLine, 'Hello there.');
  assert.strictEqual(rs.cleanRecordingsFull({}).consentLine, NEW_LINE);
});

test('2. announce: default first; every and never kept; junk is first; only announce differing keeps the record', () => {
  assert.deepStrictEqual(rs.ANNOUNCE, ['first', 'every', 'never']);
  assert.strictEqual(rs.cleanRecordingsFull({}).announce, 'first');
  assert.strictEqual(rs.cleanRecordingsFull({ announce: 'every' }).announce, 'every');
  assert.strictEqual(rs.cleanRecordingsFull({ announce: 'never' }).announce, 'never');
  for (const junk of ['always', '', 5, null, {}, ['every']]) assert.strictEqual(rs.cleanRecordingsFull({ announce: junk }).announce, 'first');
  assert.strictEqual(rs.cleanRecordings({ announce: 'first' }), undefined);
  assert.strictEqual(rs.cleanRecordings({ announce: 'junk' }), undefined);
  assert.strictEqual(rs.cleanRecordings({ announce: 'never' }).announce, 'never');
  assert.strictEqual(rs.cleanRecordings({ announce: 'every' }).announce, 'every');
  assert.strictEqual(rs.recordingsForViewer({ recordings: { keep: true, announce: 'never' } }, { admin: true }).announce, 'never');
  assert.ok(rs.auditDetail('biographer', { announce: 'every' }).endsWith(' announce=every'));
});

test('3. first: the first recorded call of a person announces; after the page posted consent a second call does not', async () => {
  const t = setup(makeFolder());
  const a = await t.start(sam);
  assert.ok(a.recording.sessionId);
  assert.strictEqual(a.recording.consentLine, NEW_LINE);
  assert.deepStrictEqual(await t.consent(sam, a.call.callId), { ok: true });
  await t.end(sam, a.call.callId); await settle();
  const b = await t.start(sam);
  assert.ok(b.recording.sessionId && b.recording.sessionId !== a.recording.sessionId, 'still a recording');
  assert.ok(!('consentLine' in b.recording), 'no line the second time');
  assert.strictEqual((await t.store.readManifest('biographer', b.recording.sessionId)).consentLine, '');
  t.cleanup();
});

test('4. restart: a new store object on the same folder still knows sam heard the line', async () => {
  const dir = makeFolder();
  const t1 = setup(dir);
  const a = await t1.start(sam);
  await t1.consent(sam, a.call.callId);
  await t1.end(sam, a.call.callId); await settle();
  t1.cleanup();
  const t2 = setup(dir);
  assert.strictEqual(await t2.store.heardConsent('biographer', sam.id), true);
  const b = await t2.start(sam);
  assert.ok(b.recording.sessionId);
  assert.ok(!('consentLine' in b.recording));
  t2.cleanup();
});

test('5. a different person on the same agent still hears the line on their first call', async () => {
  const t = setup(makeFolder());
  const a = await t.start(sam);
  await t.consent(sam, a.call.callId);
  await t.end(sam, a.call.callId); await settle();
  const p = await t.start(patientA);
  assert.ok(p.recording.sessionId);
  assert.strictEqual(p.recording.consentLine, NEW_LINE);
  assert.strictEqual(await t.store.heardConsent('biographer', patientA.id), false);
  t.cleanup();
});

test('6. every: the line on every call; never: no line ever and the recording still starts', async () => {
  const e = setup(makeFolder(), { settings: rec({ announce: 'every' }) });
  for (let i = 0; i < 2; i++) {
    const a = await e.start(sam);
    assert.strictEqual(a.recording.consentLine, NEW_LINE);
    await e.consent(sam, a.call.callId);
    await e.end(sam, a.call.callId); await settle();
  }
  e.cleanup();
  const n = setup(makeFolder(), { settings: rec({ announce: 'never' }) });
  for (let i = 0; i < 2; i++) {
    const a = await n.start(sam);
    assert.ok(a.recording.sessionId);
    assert.ok(!('consentLine' in a.recording));
    assert.strictEqual((await n.store.readManifest('biographer', a.recording.sessionId)).consentLine, '');
    await n.end(sam, a.call.callId); await settle();
  }
  n.cleanup();
});

test('7. a consent on a call that announced nothing is stored announced:false and does not count; never then first announces', async () => {
  const t = setup(makeFolder(), { settings: rec({ announce: 'never' }) });
  const a = await t.start(sam);
  assert.deepStrictEqual(await t.consent(sam, a.call.callId), { ok: true });
  const m = await t.store.readManifest('biographer', a.recording.sessionId);
  const ev = m.entries.find((x) => x.kind === 'event' && x.type === 'consent');
  assert.strictEqual(ev.announced, false);
  let text = '';
  for await (const part of t.store.exportEntries('biographer', a.recording.sessionId)) if (part.name.endsWith('transcript.txt') || /\.txt$/.test(part.name)) text += Buffer.from(part.data).toString('utf8');
  assert.match(text, /\(consent, not announced\)/);
  await t.end(sam, a.call.callId); await settle();
  assert.strictEqual(await t.store.heardConsent('biographer', sam.id), false);
  t.agents[0].recordings = rec({ announce: 'first' });
  const b = await t.start(sam);
  assert.strictEqual(b.recording.consentLine, NEW_LINE, 'the next call announces');
  t.cleanup();
});

test('8. a consent posted with spoken:false does not count as heard', async () => {
  const t = setup(makeFolder());
  const a = await t.start(sam);
  assert.strictEqual(a.recording.consentLine, NEW_LINE);
  await t.consent(sam, a.call.callId, { spoken: false });
  await t.end(sam, a.call.callId); await settle();
  assert.strictEqual(await t.store.heardConsent('biographer', sam.id), false);
  const b = await t.start(sam);
  assert.strictEqual(b.recording.consentLine, NEW_LINE);
  t.cleanup();
});

test('9. heardConsent: bad input, and lookup_inconclusive when a session cannot be opened; the call start then announces', async () => {
  const dir = makeFolder();
  const t = setup(dir);
  await assert.rejects(() => t.store.heardConsent('../x', sam.id), { code: 'bad_input' });
  assert.strictEqual(await t.store.heardConsent('biographer', ''), false);
  assert.strictEqual(await t.store.heardConsent('biographer', 5), false);
  assert.strictEqual(await t.store.heardConsent('biographer', sam.id), false, 'no sessions: not heard, not an error');
  // sam heard it on an old call, then a newer session of patient-a is damaged: newest first, the damaged one is skipped, sam still matches
  const a = await t.start(sam);
  await t.consent(sam, a.call.callId);
  await t.end(sam, a.call.callId); await settle();
  const other = await t.store.createSession('biographer', { userId: patientA.id, callId: 'call-damaged', consentLine: NEW_LINE });
  fs.writeFileSync(path.join(dir, 'call-recordings', 'biographer', other.sessionId, 'manifest.json.enc'), 'garbage');
  assert.strictEqual(await t.store.heardConsent('biographer', sam.id), true, 'a match is a match');
  // patient-a: no match and one session skipped -> inconclusive, and the call start announces
  await assert.rejects(() => t.store.heardConsent('biographer', patientA.id), { code: 'lookup_inconclusive' });
  const p = await t.start(patientA);
  assert.ok(p.recording.sessionId, 'the recording still starts');
  assert.strictEqual(p.recording.consentLine, NEW_LINE);
  // any error from the lookup announces too
  const boom = { ...t.store, heardConsent: async () => { throw new Error('disk gone'); } };
  const t2 = setup(makeFolder(), { storeOverride: boom });
  const q = await t2.start(sam);
  assert.strictEqual(q.recording.consentLine, NEW_LINE);
  t2.cleanup(); t.cleanup();
});

test('10. agent-settings.html: the Announce recording select exists, is saved and is loaded', () => {
  const as = fs.readFileSync(path.join(__dirname, '..', 'agent-settings.html'), 'utf8');
  assert.match(as, /<label for="rec-announce" style="margin:0;">Announce recording<\/label>/);
  assert.match(as, /<select id="rec-announce" onchange="saveRecordings\(\)" style="width:auto;max-width:100%;">/);
  for (const o of ['<option value="first">First call with each person</option>', '<option value="every">Every call</option>', '<option value="never">Never</option>']) assert.ok(as.includes(o), o);
  assert.ok(as.indexOf('id="rec-consent"') < as.indexOf('id="rec-announce"'), 'after the consent line');
  assert.ok(as.includes('The line is spoken when a recorded call starts. The Recording badge shows on every call.'));
  assert.ok(as.includes('The agent can say a short line when a call starts (see Announce recording), and the call screen shows Recording.'));
  assert.ok(!as.includes('The agent says a short line at the start'));
  assert.match(as, /id="rec-consent" maxlength="300" placeholder="This conversation is being recorded\."/);
  const form = as.slice(as.indexOf('  function recordingsFormValues()'), as.indexOf('  // One warning while keep is on'));
  assert.match(form, /announce: document\.getElementById\('rec-announce'\)\.value/);
  const load = as.slice(as.indexOf('  async function loadRecordings(agent)'), as.indexOf('  async function saveRecordings()'));
  assert.match(load, /announce\.value = \['first', 'every', 'never'\]\.includes\(r\.announce\) \? r\.announce : 'first'/);
  assert.match(load, /pageGuard\.markLoaded\(\[[^\]]*announce[^\]]*\]\)/);
  assert.match(as, /\['saveRecordings', 'recordings-status', byId\([^)]*'rec-announce'\)\]/);
});
