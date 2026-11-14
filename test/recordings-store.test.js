'use strict';
// The call-recordings store (lib/recordings/store.js): encrypted per-utterance FLAC files, transcripts, manifest.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const { createStore } = require('../lib/recordings/store');
const { deriveKey } = require('../lib/recordings/crypt');
const { decodeFlac } = require('../lib/recordings/flac');
const { writeZip } = require('../lib/recordings/zip');

const KEY = deriveKey(Buffer.alloc(32, 3));
const T0 = Date.UTC(2026, 10, 13, 21, 47, 0);

function mkStore(extra = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-store-'));
  const root = path.join(base, 'call-recordings');
  let t = T0, n = 0;
  const clock = { set(v) { t = v; } };
  const store = createStore({ root, key: KEY, now: () => t, randomHex: (k) => (++n).toString(16).padStart(k * 2, '0').slice(-k * 2), ...extra });
  return { store, root, clock };
}
function wav(samples, rate = 16000) {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
function tone(n, hz = 300, rate = 16000) { return Int16Array.from({ length: n }, (_, i) => Math.round(9000 * Math.sin(2 * Math.PI * hz * i / rate))); }
function walk(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}
const code = (c) => (e) => e.code === c;
const iso = (ms) => new Date(ms).toISOString();

async function fullSession(store, clock) {
  const { sessionId } = await store.createSession('biographer', {
    userId: 'owner', callId: 'call-1', device: { userAgent: 'TestAgent/1.0', micLabel: 'Test mic', sampleRate: 48000 },
    keepReplies: true, consentLine: 'Recording was agreed by patient-a.',
  });
  const a = await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(5000)), startedAt: T0 + 1000, endedAt: T0 + 2000 });
  const b = await store.addSegment('biographer', sessionId, { speaker: 'agent', wav: wav(tone(3000, 500, 48000), 48000), startedAt: T0 + 3000, endedAt: T0 + 4000 });
  const c = await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(new Int16Array([5])), startedAt: T0 + 65000, endedAt: T0 + 65100 });
  await store.setTranscript('biographer', sessionId, 1, { text: 'I was born by the sea in a small house.', engine: 'local' });
  await store.setTranscript('biographer', sessionId, 3, { text: 'Yes.', engine: 'cloud-1' });
  await store.addText('biographer', sessionId, { speaker: 'agent', text: 'Tell me more about the house.', at: T0 + 3500 });
  await store.addEvent('biographer', sessionId, { type: 'consent', at: T0 + 500 });
  await store.addEvent('biographer', sessionId, { type: 'pause', at: T0 + 10000 });
  await store.addEvent('biographer', sessionId, { type: 'resume', at: T0 + 20000 });
  clock.set(T0 + 70000);
  await store.finish('biographer', sessionId, { endedAt: T0 + 70000 });
  return { sessionId, a, b, c };
}

test('a full session: segments, transcripts, text, events, finish, manifest', async () => {
  const { store, clock } = mkStore();
  const { sessionId, a, b, c } = await fullSession(store, clock);
  assert.match(sessionId, /^20261113-214700-[0-9a-f]{6}$/);
  assert.deepStrictEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
  assert.strictEqual(a.file, '0001-person.flac');
  assert.strictEqual(b.file, '0002-agent.flac');
  assert.strictEqual(b.sampleRate, 48000);
  assert.strictEqual(a.samples, 5000);
  assert.strictEqual(a.durationMs, Math.round(5000 * 1000 / 16000));
  assert.match(a.sha256, /^[0-9a-f]{64}$/);

  const m = await store.readManifest('biographer', sessionId);
  assert.strictEqual(m.format, 1);
  assert.strictEqual(m.sessionId, sessionId);
  assert.strictEqual(m.agent, 'biographer');
  assert.strictEqual(m.startedAt, iso(T0));
  assert.strictEqual(m.endedAt, iso(T0 + 70000));
  assert.strictEqual(m.durationMs, 70000);
  assert.deepStrictEqual(m.device, { userAgent: 'TestAgent/1.0', micLabel: 'Test mic', sampleRate: 48000 });
  assert.strictEqual(m.userId, 'owner');
  assert.strictEqual(m.callId, 'call-1');
  assert.strictEqual(m.keepReplies, true);
  assert.strictEqual(m.consentLine, 'Recording was agreed by patient-a.');
  assert.deepStrictEqual(m.entries.map((e) => e.kind), ['segment', 'segment', 'segment', 'text', 'event', 'event', 'event']);
  assert.deepStrictEqual(m.entries[0], {
    seq: 1, kind: 'segment', speaker: 'person', file: '0001-person.flac', startedAt: iso(T0 + 1000), endedAt: iso(T0 + 2000),
    durationMs: 313, sampleRate: 16000, samples: 5000, bytes: a.bytes, sha256: a.sha256,
    transcript: 'I was born by the sea in a small house.', engine: 'local',
  });
  assert.strictEqual(m.entries[2].engine, 'cloud-1');
  assert.deepStrictEqual(m.entries[3], { kind: 'text', speaker: 'agent', text: 'Tell me more about the house.', at: iso(T0 + 3500) });
  assert.deepStrictEqual(m.entries[4], { kind: 'event', type: 'consent', at: iso(T0 + 500) });

  // finish is idempotent and keeps the first end time
  await store.finish('biographer', sessionId, { endedAt: T0 + 99999 });
  assert.strictEqual((await store.readManifest('biographer', sessionId)).endedAt, iso(T0 + 70000));
});

test('strings are trimmed and capped', async () => {
  const { store } = mkStore();
  const { sessionId } = await store.createSession('helper', {
    userId: 'sam', device: { userAgent: ' ' + 'u'.repeat(400) + ' ', micLabel: 'm'.repeat(200), sampleRate: 44100 }, consentLine: 'c'.repeat(500),
  });
  const m = await store.readManifest('helper', sessionId);
  assert.strictEqual(m.device.userAgent.length, 300);
  assert.strictEqual(m.device.micLabel.length, 120);
  assert.strictEqual(m.consentLine.length, 300);
  await store.addText('helper', sessionId, { speaker: 'agent', text: 'x'.repeat(30000) });
  await store.addSegment('helper', sessionId, { speaker: 'person', wav: wav(tone(100)), startedAt: T0, endedAt: T0 + 10 });
  await store.setTranscript('helper', sessionId, 1, { text: 'y'.repeat(30000), engine: 'local' });
  const m2 = await store.readManifest('helper', sessionId);
  assert.strictEqual(m2.entries[0].text.length, 20000);
  assert.strictEqual(m2.entries[1].transcript.length, 20000);
  await assert.rejects(() => store.setTranscript('helper', sessionId, 1, { text: 'x', engine: 'Bad Engine!' }), code('bad_input'));
  await assert.rejects(() => store.setTranscript('helper', sessionId, 9, { text: 'x', engine: 'local' }), code('no_segment'));
});

test('modes are 0700 and 0600, and the marker file exists', async () => {
  const { store, root, clock } = mkStore();
  const { sessionId } = await fullSession(store, clock);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  assert.strictEqual(mode(root), 0o700);
  assert.strictEqual(mode(path.join(root, 'biographer')), 0o700);
  assert.strictEqual(mode(path.join(root, 'biographer', sessionId)), 0o700);
  const files = walk(root);
  assert.ok(files.length >= 4);
  for (const f of files) assert.strictEqual(mode(f), 0o600, f);
  const marker = fs.readFileSync(path.join(root, '.mymaestro-recordings'), 'utf8');
  assert.strictEqual(marker, 'My Maestro call recordings (encrypted). Do not edit by hand.\n');
  assert.ok(!files.some((f) => /\.tmp-/.test(f)), 'no temp files are left behind');
});

test('readSegment round-trips the samples through decodeFlac', async () => {
  const { store } = mkStore();
  const { sessionId } = await store.createSession('biographer', {});
  const s = tone(9000, 220, 44100);
  await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(s, 44100), startedAt: T0, endedAt: T0 + 100 });
  const d = decodeFlac(await store.readSegment('biographer', sessionId, 1));
  assert.strictEqual(d.sampleRate, 44100);
  assert.deepStrictEqual(Array.from(d.samples), Array.from(s));
});

test('nothing on disk is plaintext', async () => {
  const { store, root, clock } = mkStore();
  await fullSession(store, clock);
  for (const f of walk(root)) {
    const b = fs.readFileSync(f);
    if (path.basename(f) === '.mymaestro-recordings') continue;
    assert.ok(!b.includes('fLaC'), f);
    for (const word of ['born by the sea', 'Tell me more', 'patient-a', 'sessionId', 'biographer', 'TestAgent']) assert.ok(!b.includes(word), `${word} in ${f}`);
    assert.strictEqual(b.toString('latin1', 0, 6), 'MMREC1');
  }
});

test('a tampered file and a file renamed to another seq are refused', async () => {
  const { store, root, clock } = mkStore();
  const { sessionId } = await fullSession(store, clock);
  const dir = path.join(root, 'biographer', sessionId);
  const f1 = path.join(dir, '0001-person.flac.enc');
  const orig = fs.readFileSync(f1);
  assert.ok((await store.readSegment('biographer', sessionId, 1)).length > 0);

  const bad = Buffer.from(orig); bad[40] ^= 1;
  fs.writeFileSync(f1, bad);
  await assert.rejects(() => store.readSegment('biographer', sessionId, 1), code('bad_recording_file'));
  fs.writeFileSync(f1, orig);
  assert.ok((await store.readSegment('biographer', sessionId, 1)).length > 0);

  // segment 1 moved into the place of segment 3
  fs.copyFileSync(f1, path.join(dir, '0003-person.flac.enc'));
  await assert.rejects(() => store.readSegment('biographer', sessionId, 3), code('bad_recording_file'));

  // a missing file, and a tampered manifest
  fs.writeFileSync(path.join(dir, '0002-agent.flac.enc'), Buffer.alloc(0));
  await assert.rejects(() => store.readSegment('biographer', sessionId, 2), code('bad_recording_file'));
  const mf = path.join(dir, 'manifest.json.enc');
  const mb = fs.readFileSync(mf); mb[mb.length - 3] ^= 1; fs.writeFileSync(mf, mb);
  await assert.rejects(() => store.readManifest('biographer', sessionId), code('bad_recording_file'));
});

test('a segment that does not match the manifest hash is refused', async () => {
  const { store, root } = mkStore();
  const { sessionId } = await store.createSession('biographer', {});
  await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(500)), startedAt: T0, endedAt: T0 + 10 });
  await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(700)), startedAt: T0, endedAt: T0 + 10 });
  const { seal } = require('../lib/recordings/crypt');
  const { encodeFlac } = require('../lib/recordings/flac');
  const rel = `biographer/${sessionId}/0001-person.flac.enc`;
  fs.writeFileSync(path.join(root, rel), seal(KEY, encodeFlac(tone(500, 400), 16000), rel));   // validly sealed, but other audio
  await assert.rejects(() => store.readSegment('biographer', sessionId, 1), code('bad_recording_file'));
});

test('concurrent addSegment calls get distinct seqs and the manifest keeps all of them', async () => {
  const { store } = mkStore();
  const { sessionId } = await store.createSession('biographer', {});
  const res = await Promise.all([1, 2, 3, 4, 5].map((i) => store.addSegment('biographer', sessionId, {
    speaker: i % 2 ? 'person' : 'agent', wav: wav(tone(1000 * i)), startedAt: T0 + i, endedAt: T0 + i + 50,
  })));
  assert.deepStrictEqual(res.map((r) => r.seq).sort(), [1, 2, 3, 4, 5]);
  const m = await store.readManifest('biographer', sessionId);
  assert.deepStrictEqual(m.entries.map((e) => e.seq), [1, 2, 3, 4, 5]);
  for (const r of res) assert.strictEqual(m.entries.find((e) => e.seq === r.seq).file, r.file);
  for (let i = 1; i <= 5; i++) assert.ok((await store.readSegment('biographer', sessionId, i)).length > 0);
  // mixed concurrent changes do not lose updates either
  await Promise.all([
    store.addText('biographer', sessionId, { speaker: 'agent', text: 'one', at: T0 }),
    store.addEvent('biographer', sessionId, { type: 'pause', at: T0 }),
    store.setTranscript('biographer', sessionId, 2, { text: 'two', engine: 'local' }),
    store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(10)), startedAt: T0, endedAt: T0 + 1 }),
  ]);
  const m2 = await store.readManifest('biographer', sessionId);
  assert.strictEqual(m2.entries.length, 8);
  assert.strictEqual(m2.entries.find((e) => e.seq === 2).transcript, 'two');
});

test('bad agent, session id, seq, speaker and audio are refused', async () => {
  const { store } = mkStore();
  const { sessionId } = await store.createSession('biographer', {});
  const ok = { speaker: 'person', wav: wav(tone(100)), startedAt: T0, endedAt: T0 + 5 };
  for (const agent of ['../x', 'Bio', '', 'a/b', 'a.b', '1abc', 'x'.repeat(65), '..', undefined, null]) {
    await assert.rejects(() => store.createSession(agent, {}), code('bad_input'), String(agent));
    await assert.rejects(() => store.addSegment(agent, sessionId, ok), code('bad_input'), String(agent));
    await assert.rejects(() => store.readManifest(agent, sessionId), code('bad_input'), String(agent));
    await assert.rejects(() => store.listSessions(agent), code('bad_input'), String(agent));
    await assert.rejects(() => store.deleteSession(agent, sessionId), code('bad_input'), String(agent));
  }
  for (const sid of ['../x', '../../etc', '20261113-214700-A1B2C3', '20261113-214700-a1b2c', '', 'x', '20261113-214700-a1b2c3/..', undefined]) {
    await assert.rejects(() => store.readManifest('biographer', sid), code('bad_input'), String(sid));
    await assert.rejects(() => store.addSegment('biographer', sid, ok), code('bad_input'), String(sid));
    await assert.rejects(() => store.finish('biographer', sid, {}), code('bad_input'), String(sid));
    await assert.rejects(() => store.deleteSession('biographer', sid), code('bad_input'), String(sid));
    await assert.rejects(() => store.exportEntries('biographer', sid).next(), code('bad_input'), String(sid));
  }
  for (const seq of [0, -1, 1.5, '1', NaN, null, undefined, '../x']) {
    await assert.rejects(() => store.readSegment('biographer', sessionId, seq), code('bad_input'), String(seq));
    await assert.rejects(() => store.setTranscript('biographer', sessionId, seq, { text: 'x', engine: 'local' }), code('bad_input'), String(seq));
  }
  await assert.rejects(() => store.addSegment('biographer', sessionId, { ...ok, speaker: 'robot' }), code('bad_input'));
  await assert.rejects(() => store.addSegment('biographer', sessionId, { ...ok, wav: 'x' }), code('bad_input'));
  await assert.rejects(() => store.addSegment('biographer', sessionId, { ...ok, wav: Buffer.from('not wav data') }), (e) => e.badAudio === true);
  await assert.rejects(() => store.addEvent('biographer', sessionId, { type: 'dance' }), code('bad_input'));
  await assert.rejects(() => store.addText('biographer', sessionId, { speaker: 'person', text: 'x' }), code('bad_input'));
  await assert.rejects(() => store.addText('biographer', sessionId, { speaker: 'agent', text: '' }), code('bad_input'));
  // nothing was created for the refused calls
  assert.deepStrictEqual(await store.listAgents(), ['biographer']);
  assert.strictEqual((await store.readManifest('biographer', sessionId)).entries.length, 0);
});

test('unknown and finished sessions are refused; a transcript may arrive for 60 minutes after finish', async () => {
  const { store, clock } = mkStore();
  await assert.rejects(() => store.addSegment('biographer', '20261113-214700-a1b2c3', { speaker: 'person', wav: wav(tone(10)), startedAt: T0, endedAt: T0 }), code('no_session'));
  await assert.rejects(() => store.readManifest('biographer', '20261113-214700-a1b2c3'), code('no_session'));
  const { sessionId } = await store.createSession('biographer', {});
  await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(100)), startedAt: T0, endedAt: T0 + 5 });
  await store.finish('biographer', sessionId, { endedAt: T0 + 1000 });
  clock.set(T0 + 1000 + 59 * 60 * 1000);
  // the last piece of a call (in flight at hang-up, or kept by the page and resent) is still kept within 60 minutes
  assert.strictEqual((await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(10)), startedAt: T0, endedAt: T0 })).seq, 2);
  await assert.rejects(() => store.addEvent('biographer', sessionId, { type: 'pause' }), code('session_closed'));
  await store.setTranscript('biographer', sessionId, 1, { text: 'late words', engine: 'local' });
  assert.strictEqual((await store.readManifest('biographer', sessionId)).entries[0].transcript, 'late words');
  clock.set(T0 + 1000 + 61 * 60 * 1000);
  await assert.rejects(() => store.setTranscript('biographer', sessionId, 1, { text: 'too late', engine: 'local' }), code('session_closed'));
  await assert.rejects(() => store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(10)), startedAt: T0, endedAt: T0 }), code('session_closed'));
});

test('exportEntries piped through writeZip reads back with Python, and the FLAC decodes', async () => {
  const { store, clock } = mkStore();
  const { sessionId } = await fullSession(store, clock);
  const pt = new PassThrough();
  const chunks = [];
  pt.on('data', (c) => chunks.push(c));
  await writeZip(store.exportEntries('biographer', sessionId), pt);
  pt.end();
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rec-export-')), 'export.zip');
  fs.writeFileSync(file, Buffer.concat(chunks));
  const py = 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"items":[[i.filename,z.read(i).hex()] for i in z.infolist()]}))';
  const r = spawnSync('/usr/bin/python3', ['-I', '-c', py, file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.strictEqual(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout);
  assert.strictEqual(res.bad, null);
  const names = res.items.map((i) => i[0]);
  assert.deepStrictEqual(names, [
    `${sessionId}/manifest.json`, `${sessionId}/transcript.txt`,
    `${sessionId}/0001-person.flac`, `${sessionId}/0001-person.txt`,
    `${sessionId}/0002-agent.flac`, `${sessionId}/0002-agent.txt`,
    `${sessionId}/0003-person.flac`, `${sessionId}/0003-person.txt`,
  ]);
  const get = (n) => Buffer.from(res.items[names.indexOf(`${sessionId}/${n}`)][1], 'hex');
  assert.deepStrictEqual(JSON.parse(get('manifest.json').toString()), await store.readManifest('biographer', sessionId));
  assert.strictEqual(get('transcript.txt').toString(), [
    '[00:00:01] Person: I was born by the sea in a small house.',
    '[00:00:03] Agent: (no transcript)',
    '[00:01:05] Person: Yes.',
    '[00:00:03] Agent: Tell me more about the house.',
    '[00:00:00] (consent)',
    '[00:00:10] (pause)',
    '[00:00:20] (resume)',
    '',
  ].join('\n'));
  assert.strictEqual(get('0001-person.txt').toString(), 'I was born by the sea in a small house.\n');
  assert.strictEqual(get('0002-agent.txt').toString(), '');
  const d = decodeFlac(get('0002-agent.flac'));
  assert.strictEqual(d.sampleRate, 48000);
  assert.strictEqual(d.samples.length, 3000);
  assert.deepStrictEqual(Array.from(decodeFlac(get('0001-person.flac')).samples), Array.from(tone(5000)));
});

test('deleteSession removes the folder, the empty agent folder, and later calls get no_session', async () => {
  const { store, root, clock } = mkStore();
  const { sessionId } = await fullSession(store, clock);
  const other = await store.createSession('biographer', {});
  await store.deleteSession('biographer', sessionId);
  await assert.rejects(() => store.readManifest('biographer', sessionId), code('no_session'));
  await assert.rejects(() => store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(10)), startedAt: T0, endedAt: T0 }), code('no_session'));
  await assert.rejects(() => store.deleteSession('biographer', sessionId), code('no_session'));
  assert.ok(!fs.existsSync(path.join(root, 'biographer', sessionId)));
  assert.ok(fs.existsSync(path.join(root, 'biographer')), 'the agent folder stays while another session is in it');
  await store.deleteSession('biographer', other.sessionId);
  assert.ok(!fs.existsSync(path.join(root, 'biographer')));
  assert.deepStrictEqual(await store.listAgents(), []);
});

test('listSessions, listAgents and stats; a damaged manifest does not throw', async () => {
  const { store, root, clock } = mkStore();
  assert.deepStrictEqual(await store.listAgents(), []);
  assert.deepStrictEqual(await store.listSessions('biographer'), []);
  assert.deepStrictEqual(await store.stats(), { sessions: 0, segments: 0, bytes: 0, speechMs: 0 });
  const first = await fullSession(store, clock);
  clock.set(T0 + 3600 * 1000);
  const second = await store.createSession('biographer', {});
  const third = await store.createSession('helper', {});
  assert.deepStrictEqual(await store.listAgents(), ['biographer', 'helper']);

  let list = await store.listSessions('biographer');
  assert.deepStrictEqual(list.map((s) => s.sessionId), [second.sessionId, first.sessionId]);
  assert.strictEqual(list[0].unfinished, true);
  assert.strictEqual(list[1].unfinished, false);
  assert.strictEqual(list[1].segments, 3);
  assert.strictEqual(list[1].firstWords, 'I was born by the sea in a small house.');
  assert.strictEqual(list[1].durationMs, 70000);
  assert.strictEqual(list[1].bytes, first.a.bytes + first.b.bytes + first.c.bytes);

  const st = await store.stats('biographer');
  assert.strictEqual(st.sessions, 2);
  assert.strictEqual(st.segments, 3);
  assert.strictEqual(st.bytes, first.a.bytes + first.b.bytes + first.c.bytes);
  assert.strictEqual(st.speechMs, first.a.durationMs + first.b.durationMs + first.c.durationMs);
  assert.strictEqual((await store.stats()).sessions, 3);

  fs.writeFileSync(path.join(root, 'biographer', second.sessionId, 'manifest.json.enc'), Buffer.from('garbage'));
  list = await store.listSessions('biographer');
  assert.deepStrictEqual(list[0], { sessionId: second.sessionId, damaged: true });
  assert.strictEqual(list[1].sessionId, first.sessionId);
  fs.mkdirSync(path.join(root, 'biographer', '20200101-000000-abcdef'));        // a folder with no manifest at all
  assert.ok((await store.listSessions('biographer')).some((s) => s.damaged && s.sessionId === '20200101-000000-abcdef'));
  assert.strictEqual((await store.stats('biographer')).sessions, 1);
  void third;
});

test('an orphan segment file that the manifest does not name is ignored', async () => {
  const { store, root } = mkStore();
  const { sessionId } = await store.createSession('biographer', {});
  fs.writeFileSync(path.join(root, 'biographer', sessionId, '0001-person.flac.enc'), Buffer.from('orphan left by a crash'));
  const seg = await store.addSegment('biographer', sessionId, { speaker: 'person', wav: wav(tone(100)), startedAt: T0, endedAt: T0 + 5 });
  assert.strictEqual(seg.seq, 1);                                           // the orphan is overwritten by the real file
  assert.ok((await store.readSegment('biographer', sessionId, 1)).length > 0);
  fs.writeFileSync(path.join(root, 'biographer', sessionId, '0002-agent.flac.enc'), Buffer.from('orphan'));
  assert.strictEqual((await store.readManifest('biographer', sessionId)).entries.length, 1);
  await assert.rejects(() => store.readSegment('biographer', sessionId, 2), code('no_segment'));
});
