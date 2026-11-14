'use strict';
// lib/recordings/routes.js with the real handler, a real store under a temp folder, a real call registry and fake req/res:
// the allowed users list, play (Range), download and delete; every other caller is refused; the uploads of the person on the call.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Writable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const routes = require('../lib/recordings/routes');
const access = require('../lib/access');
const { createStore } = require('../lib/recordings/store');
const { deriveKey } = require('../lib/recordings/crypt');
const { createVoiceCalls } = require('../lib/voice/call');

const KEY = deriveKey(Buffer.alloc(32, 7));
const T0 = Date.UTC(2026, 10, 13, 22, 0, 0);

const owner = { id: 'u_0000000000a1', role: 'admin', name: 'Owner' };        // an admin who is NOT on the list
const sam = { id: 'u_0000000000b2', role: 'member', name: 'Sam' };           // on the list
const patientA = { id: 'u_0000000000c3', role: 'member', name: 'Patient A' };  // the person on the call
const other = { id: 'u_0000000000d4', role: 'member', name: 'Other' };       // not on the list
const ALLOWED = [sam.id];

function wav(samples, rate = 16000) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const tone = (n, hz = 300) => Int16Array.from({ length: n }, (_, i) => Math.round(9000 * Math.sin(2 * Math.PI * hz * i / 16000)));

function fakeRes() {
  const chunks = [];
  const r = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  r.writeHead = (code, headers) => { r.statusCode = code; r.headers = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v])); r.headersSent = true; };
  r.finished = new Promise((resolve) => r.on('finish', resolve));
  r.body = () => Buffer.concat(chunks);
  r.json = () => JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return r;
}
function fakeReq(method, url, { headers = {}, body, user = null, service = false, token = null, pending = false } = {}) {
  const r = Readable.from(body === undefined ? [] : Array.isArray(body) ? body : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  Object.assign(r, { method, url, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), hubUser: user, hubService: service, hubToken: token, hubPendingTotp: pending });
  return r;
}

function fx(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-routes-'));
  const clock = { t: T0 };
  const store = createStore({ root: path.join(dir, 'call-recordings'), key: KEY, now: () => clock.t });
  const calls = createVoiceCalls({ now: () => clock.t, bus: { publish() {} } });
  const audits = [];
  const agents = [
    { name: 'biographer', display: 'Biographer', recordings: { keep: true, allowed: ALLOWED, keepReplies: false, consentLine: 'x', mic: 'processed' } },
    { name: 'helper', display: 'Helper' },
  ];
  const deps = {
    jsonResponse: (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); },
    readBody: (req) => new Promise((resolve) => { let s = ''; req.on('data', c => { s += c; }); req.on('end', () => resolve(s)); }),
    getAgents: async () => agents,
    voiceCall: calls, store, now: () => clock.t,
    audit: (uid, action, detail) => audits.push([uid, action, detail]),
    ...extra,
  };
  calls.onFinish((info) => (info.recording && info.recording.sessionId ? store.finish(info.agent, info.recording.sessionId, { endedAt: info.endedAt }) : undefined));
  const call = async (req) => {
    const res = fakeRes(); const u = new URL(req.url, 'http://x');
    await routes.handle(u.pathname, req, res, deps);
    if (!res.writableEnded && !res.destroyed) await new Promise(r => setTimeout(r, 5));
    if (res.writableEnded) await res.finished;
    return res;
  };
  // A recorded call of patient-a with the agent: the call, its session, and the recording state on the call.
  const startCall = async ({ keepReplies = false, userId = patientA.id, agent = 'biographer' } = {}) => {
    const c = calls.start(agent, { userId, person: 'Patient A' });
    const { sessionId } = await store.createSession(agent, { userId, callId: c.callId, keepReplies, consentLine: 'x' });
    calls.setRecording(agent, c.callId, { sessionId, paused: false, keepReplies, mic: 'processed' });
    return { callId: c.callId, sessionId };
  };
  routes.resetForTests();
  return { dir, clock, store, calls, audits, deps, call, startCall, agents };
}
// A finished session with three segments and a transcript, made straight in the store.
async function filledSession(store, agent = 'biographer') {
  const { sessionId } = await store.createSession(agent, { userId: patientA.id, callId: 'call-old', keepReplies: true, consentLine: 'x' });
  await store.addSegment(agent, sessionId, { speaker: 'person', wav: wav(tone(4000)), startedAt: T0, endedAt: T0 + 250 });
  await store.addSegment(agent, sessionId, { speaker: 'agent', wav: wav(tone(2000, 500)), startedAt: T0 + 300, endedAt: T0 + 425 });
  await store.setTranscript(agent, sessionId, 1, { text: 'I grew up by the sea.', engine: 'local' });
  await store.addText(agent, sessionId, { speaker: 'agent', text: 'Tell me more.', at: T0 + 500 });
  await store.finish(agent, sessionId, { endedAt: T0 + 1000 });
  return sessionId;
}
const wavReq = (url, body, user = patientA) => fakeReq('POST', url, { headers: { 'content-type': 'audio/wav' }, body, user });
const seg = (agent, callId, extra = '') => `/api/recordings/segment?agent=${agent}&callId=${callId}&speaker=person&startedAt=${new Date(T0).toISOString()}&endedAt=${new Date(T0 + 500).toISOString()}${extra}`;
const jsonReq = (url, body, user = patientA) => fakeReq('POST', url, { headers: { 'content-type': 'application/json' }, body, user });

function zipList(buf) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-zip-')), 'x.zip');
  fs.writeFileSync(file, buf);
  const py = 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"items":[[i.filename,z.read(i).hex()] for i in z.infolist()]}))';
  const r = spawnSync('/usr/bin/python3', ['-I', '-c', py, file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.bad, null);
  return Object.fromEntries(j.items.map(([n, h]) => [n, Buffer.from(h, 'hex')]));
}

// ── access table ──
test('access: uploads are agent routes (body or query), the rest are session routes the handler decides', () => {
  const c = (p, m = 'GET') => access.classifyRoute(p, m);
  assert.deepStrictEqual(c('/api/recordings/segment', 'POST'), { kind: 'agent', from: 'query' });
  for (const p of ['transcript', 'text', 'pause', 'consent']) assert.deepStrictEqual(c(`/api/recordings/${p}`, 'POST'), { kind: 'agent', from: 'body' });
  assert.deepStrictEqual(c('/api/recordings'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/sessions'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/20261113-220000-0a0b0c/manifest'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/20261113-220000-0a0b0c/0001.flac'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/20261113-220000-0a0b0c.zip'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/all.zip'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/20261113-220000-0a0b0c/delete', 'POST'), { kind: 'session' });
  assert.deepStrictEqual(c('/api/recordings/biographer/a/b/c/d'), { kind: 'admin' }, 'deeper paths are not recordings routes');
  assert.deepStrictEqual(c('/api/recordings/'), { kind: 'session' }, 'a trailing slash changes nothing');
  assert.ok(!access.tokenAllows({ scopes: ['chat', 'interject', 'status'], agents: ['biographer'] }, '/api/recordings/segment', 'POST', { agent: 'biographer' }).ok, 'no token scope reaches recordings');
  assert.ok(!access.tokenAllows({ scopes: ['status'] }, '/api/recordings', 'GET').ok);
});

// ── the allowed user ──
test('the allowed user lists, reads the manifest (no user or call ids), plays with Range, downloads zips and deletes', async () => {
  const t = fx();
  const sid = await filledSession(t.store);
  const as = (m, u, o = {}) => fakeReq(m, u, { user: sam, ...o });

  let r = await t.call(as('GET', '/api/recordings'));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json().agents, [{ name: 'biographer', display: 'Biographer', sessions: 1, bytes: r.json().agents[0].bytes, speechMs: 375 }]);
  assert.ok(r.json().agents[0].bytes > 0);

  r = await t.call(as('GET', '/api/recordings/biographer/sessions'));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.json().sessions.length, 1);
  assert.strictEqual(r.json().sessions[0].sessionId, sid);
  assert.strictEqual(r.json().sessions[0].firstWords, 'I grew up by the sea.');

  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/manifest`));
  assert.strictEqual(r.statusCode, 200);
  const man = r.json();
  assert.strictEqual(man.sessionId, sid);
  assert.ok(!('userId' in man) && !('callId' in man));
  assert.strictEqual(man.entries.filter(e => e.kind === 'segment').length, 2);

  // play: the whole file
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/1.flac`));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['content-type'], 'audio/flac');
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(r.headers['content-disposition'], `inline; filename="biographer-${sid}-0001.flac"`);
  assert.strictEqual(r.headers['accept-ranges'], 'bytes');
  const whole = r.body();
  assert.strictEqual(whole.subarray(0, 4).toString('latin1'), 'fLaC');
  assert.deepStrictEqual(whole, await t.store.readSegment('biographer', sid, 1));
  assert.strictEqual(Number(r.headers['content-length']), whole.length);

  // play: ranges
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/1.flac`, { headers: { range: 'bytes=10-29' } }));
  assert.strictEqual(r.statusCode, 206);
  assert.strictEqual(r.headers['content-range'], `bytes 10-29/${whole.length}`);
  assert.strictEqual(r.headers['content-length'], 20);
  assert.deepStrictEqual(r.body(), whole.subarray(10, 30));
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/1.flac`, { headers: { range: 'bytes=100-' } }));
  assert.strictEqual(r.statusCode, 206);
  assert.strictEqual(r.headers['content-range'], `bytes 100-${whole.length - 1}/${whole.length}`);
  assert.deepStrictEqual(r.body(), whole.subarray(100));
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/1.flac`, { headers: { range: `bytes=5-${whole.length + 500}` } }));
  assert.strictEqual(r.statusCode, 206, 'an end past the file is cut to the file');
  assert.deepStrictEqual(r.body(), whole.subarray(5));
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/1.flac`, { headers: { range: `bytes=${whole.length}-` } }));
  assert.strictEqual(r.statusCode, 416);
  assert.strictEqual(r.headers['content-range'], `bytes */${whole.length}`);
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}/9.flac`));
  assert.strictEqual(r.statusCode, 404);

  // one session as a zip
  r = await t.call(as('GET', `/api/recordings/biographer/${sid}.zip`));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['content-type'], 'application/zip');
  assert.strictEqual(r.headers['content-disposition'], `attachment; filename="biographer-${sid}.zip"`);
  const z = zipList(r.body());
  assert.deepStrictEqual(Object.keys(z), [`${sid}/manifest.json`, `${sid}/transcript.txt`, `${sid}/0001-person.flac`, `${sid}/0001-person.txt`, `${sid}/0002-agent.flac`, `${sid}/0002-agent.txt`]);
  assert.match(z[`${sid}/transcript.txt`].toString(), /Person: I grew up by the sea\./);
  assert.deepStrictEqual(z[`${sid}/0001-person.flac`], whole);

  // everything of the agent in one zip, oldest first; a damaged session is skipped and named
  t.clock.t += 5000;
  const sid2 = await filledSession(t.store);
  const sid3 = await filledSession(t.store);
  assert.ok(sid < sid2 && sid2 < sid3 || sid !== sid2, 'three sessions');
  const manifestOf3 = path.join(t.dir, 'call-recordings', 'biographer', sid3, 'manifest.json.enc');
  fs.writeFileSync(manifestOf3, Buffer.from('not a recording file at all, certainly not sealed'));
  r = await t.call(as('GET', '/api/recordings/biographer/all.zip'));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.headers['content-disposition'], 'attachment; filename="biographer-all.zip"');
  const all = zipList(r.body());
  const names = Object.keys(all);
  const first = names.findIndex(n => n.startsWith(sid + '/')); const second = names.findIndex(n => n.startsWith(sid2 + '/'));
  assert.ok(first >= 0 && second >= 0 && first < second, 'oldest first');
  assert.ok(names.every(n => n === 'damaged.txt' || n.startsWith(sid + '/') || n.startsWith(sid2 + '/')), 'the damaged session has no files in the zip');
  assert.ok(all['damaged.txt'].toString().includes(sid3));
  assert.ok(!all['damaged.txt'].toString().includes(sid2));

  // delete
  r = await t.call(jsonReqAs(sam, `/api/recordings/biographer/${sid}/delete`, { confirm: 'DELETE' }));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json(), { ok: true });
  await assert.rejects(t.store.readManifest('biographer', sid), (e) => e.code === 'no_session');
  r = await t.call(jsonReqAs(sam, `/api/recordings/biographer/${sid}/delete`, { confirm: 'DELETE' }));
  assert.strictEqual(r.statusCode, 404, 'already gone');
});
function jsonReqAs(user, url, body) { return fakeReq('POST', url, { headers: { 'content-type': 'application/json' }, body, user }); }

test('bad session ids, seq numbers and paths are 404 for the allowed user', async () => {
  const t = fx();
  const sid = await filledSession(t.store);
  for (const p of ['/api/recordings/biographer/nope/manifest', `/api/recordings/biographer/${sid}/0.flac`, `/api/recordings/biographer/${sid}/x.flac`, '/api/recordings/biographer/nope.zip', `/api/recordings/biographer/${sid}/other`, `/api/recordings/biographer/${sid}/delete/x`]) {
    const r = await t.call(fakeReq('GET', p, { user: sam }));
    assert.strictEqual(r.statusCode, 404, p);
    assert.deepStrictEqual(r.json(), { error: 'not_found' }, p);
  }
  const r = await t.call(jsonReqAs(sam, '/api/recordings/biographer/nope/delete', { confirm: 'DELETE' }));
  assert.strictEqual(r.statusCode, 404);
  const wm = await t.call(fakeReq('POST', '/api/recordings/biographer/sessions', { user: sam }));
  assert.strictEqual(wm.statusCode, 405);
});

// ── everybody else is refused, on every route ──
test('every refused caller gets 403 not_allowed on EVERY allowed-user route, and nothing changes', async () => {
  const t = fx();
  const sid = await filledSession(t.store);
  const bodyDelete = JSON.stringify({ confirm: 'DELETE' });
  const routesList = [
    ['GET', '/api/recordings'],
    ['GET', '/api/recordings/biographer/sessions'],
    ['GET', `/api/recordings/biographer/${sid}/manifest`],
    ['GET', `/api/recordings/biographer/${sid}/1.flac`],
    ['GET', `/api/recordings/biographer/${sid}.zip`],
    ['GET', '/api/recordings/biographer/all.zip'],
    ['POST', `/api/recordings/biographer/${sid}/delete`, bodyDelete],
  ];
  const callers = {
    'no user': {},
    'the hub itself (service)': { service: true },
    'an API token': { token: { id: 't1', scopes: ['status'], agents: null } },
    'a user, two-factor pending (on the list)': { user: sam, pending: true },
    'a token that carries a listed user': { user: sam, token: { id: 't2', scopes: ['chat'], agents: ['biographer'] } },
    'a service call that carries a listed user': { user: sam, service: true },
  };
  for (const [who, opts] of Object.entries(callers)) {
    for (const [method, url, body] of routesList) {
      const r = await t.call(fakeReq(method, url, { ...opts, body, headers: body ? { 'content-type': 'application/json' } : {} }));
      assert.strictEqual(r.statusCode, 403, `${who}: ${method} ${url}`);
      assert.deepStrictEqual(r.json(), { error: 'not_allowed' }, `${who}: ${method} ${url}`);
    }
  }
  // Signed-in people who are not on the list: 403 on every agent route (also for an unknown agent, a bad session and a bad agent name), and an empty list.
  for (const [who, user] of [['another member', other], ['an admin not on the list', owner], ['the person on the call, not on the list', patientA]]) {
    for (const [method, url, body] of routesList.slice(1)) {
      const r = await t.call(fakeReq(method, url, { user, body, headers: body ? { 'content-type': 'application/json' } : {} }));
      assert.strictEqual(r.statusCode, 403, `${who}: ${method} ${url}`);
      assert.deepStrictEqual(r.json(), { error: 'not_allowed' }, `${who}: ${method} ${url}`);
    }
    const l = await t.call(fakeReq('GET', '/api/recordings', { user }));
    assert.deepStrictEqual(l.json(), { agents: [] }, `${who}: sees no agents`);
    for (const url of ['/api/recordings/ghost/sessions', '/api/recordings/helper/sessions', '/api/recordings/Bad..Name/sessions', `/api/recordings/ghost/${sid}/manifest`]) {
      const r = await t.call(fakeReq('GET', url, { user }));
      assert.strictEqual(r.statusCode, 403, `${who}: ${url}`);
      assert.deepStrictEqual(r.json(), { error: 'not_allowed' });
    }
  }
  // The same 403 for a listed user asking about an agent that does not list them or does not exist
  for (const url of ['/api/recordings/ghost/sessions', '/api/recordings/helper/sessions']) {
    const r = await t.call(fakeReq('GET', url, { user: sam }));
    assert.strictEqual(r.statusCode, 403);
    assert.deepStrictEqual(r.json(), { error: 'not_allowed' });
  }
  const s = await t.store.listSessions('biographer');
  assert.strictEqual(s.length, 1, 'the refused delete deleted nothing');
  assert.deepStrictEqual(t.audits, [], 'no refused request is audited as a success');
});

test('delete: anything but exactly "DELETE" is refused, and a session whose call is still live is in use', async () => {
  const t = fx();
  const sid = await filledSession(t.store);
  for (const body of [{}, { confirm: 'delete' }, { confirm: 'DELETE ' }, { confirm: true }, { confirm: ['DELETE'] }, { confirm: 'yes' }]) {
    const r = await t.call(jsonReqAs(sam, `/api/recordings/biographer/${sid}/delete`, body));
    assert.strictEqual(r.statusCode, 400, JSON.stringify(body));
    assert.deepStrictEqual(r.json(), { error: 'confirm_required' });
  }
  let r = await t.call(fakeReq('POST', `/api/recordings/biographer/${sid}/delete`, { user: sam, body: 'not json' }));
  assert.strictEqual(r.statusCode, 400);
  assert.strictEqual((await t.store.listSessions('biographer')).length, 1);

  const live = await t.startCall();
  r = await t.call(jsonReqAs(sam, `/api/recordings/biographer/${live.sessionId}/delete`, { confirm: 'DELETE' }));
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(r.json(), { error: 'in_use' });
  assert.strictEqual((await t.store.listSessions('biographer')).length, 2);
  assert.deepStrictEqual(t.audits.filter(a => a[1] === 'recordings.delete'), []);
  // after hang-up the session can go
  t.calls.end('biographer', patientA.id, live.callId);
  r = await t.call(jsonReqAs(sam, `/api/recordings/biographer/${live.sessionId}/delete`, { confirm: 'DELETE' }));
  assert.strictEqual(r.statusCode, 200);
});

// ── audit ──
test('audit: play (once per user, session and segment per 10 minutes), download and delete', async () => {
  const t = fx();
  const sid = await filledSession(t.store);
  const get = (u, who = sam) => t.call(fakeReq('GET', u, { user: who }));
  await get(`/api/recordings/biographer/${sid}/1.flac`);
  await get(`/api/recordings/biographer/${sid}/1.flac`);
  await t.call(fakeReq('GET', `/api/recordings/biographer/${sid}/1.flac`, { user: sam, headers: { range: 'bytes=0-9' } }));
  assert.deepStrictEqual(t.audits, [[sam.id, 'recordings.play', `biographer/${sid}/1`]], 'repeats and ranges of the same segment are one entry');
  await get(`/api/recordings/biographer/${sid}/2.flac`);
  assert.strictEqual(t.audits.length, 2);
  assert.deepStrictEqual(t.audits[1], [sam.id, 'recordings.play', `biographer/${sid}/2`]);
  t.clock.t += 9 * 60 * 1000;
  await get(`/api/recordings/biographer/${sid}/1.flac`);
  assert.strictEqual(t.audits.length, 2, 'still inside 10 minutes');
  t.clock.t += 2 * 60 * 1000;
  await get(`/api/recordings/biographer/${sid}/1.flac`);
  assert.strictEqual(t.audits.length, 3, 'after 10 minutes it is audited again');
  await get(`/api/recordings/biographer/${sid}/9.flac`);
  assert.strictEqual(t.audits.length, 3, 'a segment that does not exist is not audited');

  await get(`/api/recordings/biographer/${sid}.zip`);
  await get('/api/recordings/biographer/all.zip');
  assert.deepStrictEqual(t.audits.slice(3), [[sam.id, 'recordings.download', `biographer/${sid}`], [sam.id, 'recordings.download', 'biographer/all']]);
  await t.call(jsonReqAs(sam, `/api/recordings/biographer/${sid}/delete`, { confirm: 'DELETE' }));
  assert.deepStrictEqual(t.audits[5], [sam.id, 'recordings.delete', `biographer/${sid}`]);
  assert.strictEqual(t.audits.length, 6);
  await get(`/api/recordings/biographer/${sid}.zip`);
  assert.strictEqual(t.audits.length, 6, 'a zip of a session that does not exist is not audited');
});

// ── uploads from the person on the call ──
test('the person on the call uploads utterances, transcripts, reply text, pauses and consent', async () => {
  const t = fx({ });
  const { callId, sessionId } = await t.startCall();
  let r = await t.call(wavReq(seg('biographer', callId), wav(tone(3200))));
  assert.strictEqual(r.statusCode, 200);
  assert.deepStrictEqual(r.json(), { seq: 1 });
  r = await t.call(wavReq(seg('biographer', callId), wav(tone(1600, 440))));
  assert.deepStrictEqual(r.json(), { seq: 2 });
  r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'Hello there.', engine: 'local' }));
  assert.strictEqual(r.statusCode, 200);
  r = await t.call(jsonReq('/api/recordings/text', { agent: 'biographer', callId, text: 'Nice to meet you.', at: new Date(T0 + 700).toISOString() }));
  assert.strictEqual(r.statusCode, 200);
  r = await t.call(jsonReq('/api/recordings/consent', { agent: 'biographer', callId }));
  assert.strictEqual(r.statusCode, 200);
  r = await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: true }));
  assert.deepStrictEqual(r.json(), { ok: true, paused: true });
  assert.strictEqual(t.calls.recordingOf('biographer').paused, true);
  r = await t.call(wavReq(seg('biographer', callId), wav(tone(800))));
  assert.strictEqual(r.statusCode, 200, 'pause never refuses audio (pieces from before the pause are not lost)');
  assert.deepStrictEqual(r.json(), { seq: 3 });
  r = await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: false }));
  assert.deepStrictEqual(r.json(), { ok: true, paused: false });
  r = await t.call(wavReq(seg('biographer', callId), wav(tone(900))));
  assert.deepStrictEqual(r.json(), { seq: 4 });

  const m = await t.store.readManifest('biographer', sessionId);
  assert.strictEqual(m.entries.filter(e => e.kind === 'segment').length, 4);
  assert.strictEqual(m.entries.find(e => e.seq === 1).transcript, 'Hello there.');
  assert.deepStrictEqual(m.entries.filter(e => e.kind === 'event').map(e => e.type), ['consent', 'pause', 'resume']);
  assert.ok(m.entries.some(e => e.kind === 'text' && e.text === 'Nice to meet you.'));
  assert.ok(m.entries.filter(e => e.kind === 'segment').every(e => e.speaker === 'person'));
  assert.strictEqual(m.endedAt, null, 'still on the call');
});

test('uploads are refused: another user, a wrong or missing call id, no recording session, no call, speaker agent without keepReplies, bad audio, too big', async () => {
  const t = fx({ maxSegmentBytes: 2000 });
  const { callId, sessionId } = await t.startCall();
  const refused = async (req, code, error, label) => { const r = await t.call(req); assert.strictEqual(r.statusCode, code, label); assert.deepStrictEqual(r.json(), { error }, label); };
  await refused(wavReq(seg('biographer', callId), wav(tone(300)), sam), 409, 'not_recording', 'another user');
  await refused(wavReq(seg('biographer', callId), wav(tone(300)), owner), 409, 'not_recording', 'an admin is not the person on the call either');
  await refused(wavReq(seg('biographer', 'call-other'), wav(tone(300))), 409, 'not_recording', 'wrong call id');
  await refused(wavReq(`/api/recordings/segment?agent=biographer&speaker=person`, wav(tone(300))), 409, 'not_recording', 'no call id');
  await refused(wavReq(seg('helper', callId), wav(tone(300))), 409, 'not_recording', 'an agent with no call');
  await refused(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId: 'call-other', seq: 1, text: 'x' }), 409, 'not_recording', 'transcript, wrong call');
  await refused(jsonReq('/api/recordings/text', { agent: 'biographer', callId, text: 'x' }, sam), 409, 'not_recording', 'text, another user');
  await refused(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: true }, sam), 409, 'not_recording', 'pause, another user');
  await refused(jsonReq('/api/recordings/consent', { agent: 'biographer', callId }, sam), 409, 'not_recording', 'consent, another user');
  // service calls, API tokens and a session owing its two-factor code never feed a recording (403 before anything else), on every upload route
  const noPerson = { service: { service: true, user: null }, token: { token: { id: 't1' }, user: null }, pending: { pending: true, user: patientA } };
  for (const [who, extra] of Object.entries(noPerson)) {
    await refused(fakeReq('POST', seg('biographer', callId), { headers: { 'content-type': 'audio/wav' }, body: wav(tone(300)), ...extra }), 403, 'not_allowed', `segment, ${who}`);
    for (const p of ['transcript', 'text', 'pause', 'consent', 'trouble']) {
      await refused(fakeReq('POST', `/api/recordings/${p}`, { headers: { 'content-type': 'application/json' }, body: { agent: 'biographer', callId, seq: 1, text: 'x', paused: true, reason: 'start_failed' }, ...extra }), 403, 'not_allowed', `${p}, ${who}`);
    }
  }
  assert.strictEqual(t.calls.recordingOf('biographer').paused, false, 'a refused pause changed nothing');
  // a call without a recording session (switched off, or the session could not start)
  const plain = t.calls.start('helper', { userId: patientA.id, person: 'Patient A' });
  await refused(wavReq(seg('helper', plain.callId), wav(tone(300))), 409, 'not_recording', 'no recording session');
  // speaker agent only with keepReplies
  await refused(wavReq(seg('biographer', callId).replace('speaker=person', 'speaker=agent'), wav(tone(300))), 409, 'replies_not_kept', 'speaker agent, keepReplies off');
  await refused(wavReq(seg('biographer', callId).replace('speaker=person', 'speaker=nobody'), wav(tone(300))), 400, 'bad_speaker', 'bad speaker');
  // bad audio and size
  await refused(wavReq(seg('biographer', callId), Buffer.from('this is not a wav file at all')), 400, 'bad_audio', 'bad audio');
  await refused(wavReq(seg('biographer', callId), Buffer.alloc(0)), 400, 'bad_audio', 'empty');
  await refused(wavReq(seg('biographer', callId), wav(tone(5000))), 413, 'audio is larger than 0 MB', 'too big (counted as it arrives)');
  await refused(fakeReq('POST', seg('biographer', callId), { user: patientA, headers: { 'content-type': 'text/plain' }, body: 'x' }), 415, 'send audio/wav (16-bit PCM)', 'not a wav');
  await refused(fakeReq('POST', seg('biographer', callId), { user: patientA, headers: { 'content-type': 'audio/wav', 'content-length': '999999' }, body: wav(tone(10)) }), 413, 'audio is larger than 0 MB', 'declared too big');
  await refused(jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: 'yes' }), 400, 'bad_request', 'paused must be a boolean');
  const m = await t.store.readManifest('biographer', sessionId);
  assert.strictEqual(m.entries.length, 0, 'nothing was stored by a refused upload');
  assert.deepStrictEqual((await t.call(fakeReq('GET', '/api/recordings/biographer/sessions', { user: sam }))).json().sessions[0].segments, 0);
  // the GET method is not an upload
  const g = await t.call(fakeReq('GET', '/api/recordings/segment', { user: patientA }));
  assert.strictEqual(g.statusCode, 405);
});

test('speaker agent is stored when the call keeps replies', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall({ keepReplies: true });
  const r = await t.call(wavReq(seg('biographer', callId).replace('speaker=person', 'speaker=agent'), wav(tone(800))));
  assert.deepStrictEqual(r.json(), { seq: 1 });
  assert.strictEqual((await t.store.readManifest('biographer', sessionId)).entries[0].speaker, 'agent');
});

test('a transcript, reply text or the last audio piece may arrive within 60 minutes after hang-up, and not after; pauses and consent may not', async () => {
  const t = fx();
  const { callId, sessionId } = await t.startCall();
  let r = await t.call(wavReq(seg('biographer', callId), wav(tone(1000))));
  assert.deepStrictEqual(r.json(), { seq: 1 });
  t.calls.end('biographer', patientA.id, callId);
  await new Promise(res => setTimeout(res, 20));   // the finish hook runs the store's finish
  assert.notStrictEqual((await t.store.readManifest('biographer', sessionId)).endedAt, null, 'the session was finished when the call ended');
  t.clock.t += 59 * 60 * 1000;
  r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'Late words.' }));
  assert.strictEqual(r.statusCode, 200);
  r = await t.call(jsonReq('/api/recordings/text', { agent: 'biographer', callId, text: 'A late reply.', at: new Date(t.clock.t).toISOString() }));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual((await t.store.readManifest('biographer', sessionId)).entries.find(e => e.seq === 1).transcript, 'Late words.');
  // the last piece of audio (in flight at hang-up) is still kept
  r = await t.call(wavReq(seg('biographer', callId), wav(tone(500))));
  assert.deepStrictEqual(r.json(), { seq: 2 });
  // pause and consent need the live call
  for (const req of [jsonReq('/api/recordings/pause', { agent: 'biographer', callId, paused: true }), jsonReq('/api/recordings/consent', { agent: 'biographer', callId })]) {
    r = await t.call(req);
    assert.strictEqual(r.statusCode, 409);
    assert.deepStrictEqual(r.json(), { error: 'not_recording' });
  }
  // another user cannot use the ended call either
  r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'Not mine.' }, sam));
  assert.strictEqual(r.statusCode, 409);
  t.clock.t += 2 * 60 * 1000;   // 61 minutes after the end
  r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId, seq: 1, text: 'Too late.' }));
  assert.strictEqual(r.statusCode, 409);
  assert.deepStrictEqual(r.json(), { error: 'not_recording' });
  assert.strictEqual((await t.store.readManifest('biographer', sessionId)).entries.find(e => e.seq === 1).transcript, 'Late words.');
  r = await t.call(wavReq(seg('biographer', callId), wav(tone(500))));
  assert.strictEqual(r.statusCode, 409, 'audio 61 minutes after the end is refused');
});

test('a new call replaces the old one: the old call id keeps its last pieces for the grace period, the new id goes to the new session', async () => {
  const t = fx();
  const first = await t.startCall();
  const second = await t.startCall();
  assert.notStrictEqual(first.callId, second.callId);
  await new Promise(res => setTimeout(res, 20));
  assert.notStrictEqual((await t.store.readManifest('biographer', first.sessionId)).endedAt, null, 'the earlier session was finished by the replacement');
  assert.strictEqual((await t.store.readManifest('biographer', second.sessionId)).endedAt, null);
  // a piece the page had not sent yet, under the old call id, while the new call is live: it goes to the old session
  let r = await t.call(wavReq(seg('biographer', first.callId), wav(tone(500))));
  assert.strictEqual(r.statusCode, 200);
  r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId: first.callId, seq: 1, text: 'Old words.' }));
  assert.strictEqual(r.statusCode, 200);
  // the new id goes to the new session
  r = await t.call(wavReq(seg('biographer', second.callId), wav(tone(500))));
  assert.strictEqual(r.statusCode, 200);
  const oldM = await t.store.readManifest('biographer', first.sessionId);
  const newM = await t.store.readManifest('biographer', second.sessionId);
  assert.deepStrictEqual(oldM.entries.map(e => [e.kind, e.seq, e.transcript]), [['segment', 1, 'Old words.']]);
  assert.deepStrictEqual(newM.entries.map(e => [e.kind, e.seq]), [['segment', 1]]);
  // pause and consent are for the live call only
  r = await t.call(jsonReq('/api/recordings/pause', { agent: 'biographer', callId: first.callId, paused: true }));
  assert.strictEqual(r.statusCode, 409);
  // after the grace period the old id is refused
  t.clock.t += 61 * 60 * 1000;
  r = await t.call(wavReq(seg('biographer', first.callId), wav(tone(500))));
  assert.strictEqual(r.statusCode, 409);
  // another user is never the person on either call
  r = await t.call(jsonReq('/api/recordings/transcript', { agent: 'biographer', callId: second.callId, seq: 1, text: 'x' }, sam));
  assert.strictEqual(r.statusCode, 409);
});

test('hyphenated agent names: uploads and the allowed user lists, plays and downloads work for life-story', async () => {
  const t = fx();
  t.agents.push({ name: 'life-story', display: 'Life Story', recordings: { keep: true, allowed: ALLOWED, keepReplies: false, consentLine: 'x', mic: 'processed' } });
  const { callId, sessionId } = await t.startCall({ agent: 'life-story' });
  let r = await t.call(wavReq(seg('life-story', callId), wav(tone(800))));
  assert.deepStrictEqual(r.json(), { seq: 1 });
  r = await t.call(fakeReq('GET', '/api/recordings/life-story/sessions', { user: sam }));
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.json().sessions.length, 1);
  r = await t.call(fakeReq('GET', `/api/recordings/life-story/${sessionId}/1.flac`, { user: sam }));
  assert.strictEqual(r.statusCode, 200);
  r = await t.call(fakeReq('GET', `/api/recordings/life-story/${sessionId}.zip`, { user: sam }));
  assert.strictEqual(r.statusCode, 200);
  assert.ok(routes.parseRange);
});

test('audit: a manifest view is audited as recordings.view, once per user and session per 10 minutes', async () => {
  const t = fx();
  const sid = await filledSession(t.store);
  const get = (who = sam) => t.call(fakeReq('GET', `/api/recordings/biographer/${sid}/manifest`, { user: who }));
  await get(); await get();
  assert.deepStrictEqual(t.audits, [[sam.id, 'recordings.view', `biographer/${sid}`]]);
  t.clock.t += 9 * 60 * 1000;
  await get();
  assert.strictEqual(t.audits.length, 1, 'still inside 10 minutes');
  t.clock.t += 2 * 60 * 1000;
  await get();
  assert.strictEqual(t.audits.length, 2, 'audited again after 10 minutes');
  const r = await t.call(fakeReq('GET', '/api/recordings/biographer/20200101-000000-aaaaaa/manifest', { user: sam }));
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(t.audits.length, 2, 'a session that does not exist is not audited');
  assert.strictEqual((await get(other)).statusCode, 403);
  assert.strictEqual(t.audits.length, 2, 'a refused caller is not audited as a view');
});
