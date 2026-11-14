'use strict';
// The call-recordings store: one encrypted FLAC file per utterance, with transcripts and a session manifest.
//   <root>/<agent>/<sessionId>/manifest.json.enc and 0001-person.flac.enc, 0002-agent.flac.enc ...
// Every file is sealed (lib/recordings/crypt.js) with its path relative to the root as additional data, so a file
// moved to another name no longer opens. Changes to one session are serialized; the manifest is replaced atomically,
// and a segment file is on disk in full before the manifest names it (a crash leaves at most an orphan file that
// nothing reads).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { wavToPcm16, encodeFlacAsync, decodeFlac } = require('./flac');
const { seal, open } = require('./crypt');

const MARKER = '.mymaestro-recordings';
const MARKER_TEXT = 'My Maestro call recordings (encrypted). Do not edit by hand.\n';
const AGENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SESSION_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const PROCESSING = ['second-track', 'call-track', 'processed'];   // device.processing: how the page took the voice (see lib/ui-voice-call.js)
const PIECE_RE = /^[A-Za-z0-9_-]{8,64}$/;   // the page's id for one uploaded piece (a resend of it changes nothing)
const ENGINE_RE = /^[a-z0-9_-]{1,20}$/;
const TEXT_MAX = 20000;
const TRANSCRIPT_GRACE_MS = 60 * 60 * 1000;   // the page keeps unsent pieces and resends them
const EVENT_TYPES = ['consent', 'pause', 'resume'];

function err(code, message) { const e = new Error(message); e.code = code; return e; }
const badInput = (m) => err('bad_input', m);

function validAgent(agent) { if (typeof agent !== 'string' || !AGENT_RE.test(agent)) throw badInput('bad agent name'); return agent; }
function validSession(id) { if (typeof id !== 'string' || !SESSION_RE.test(id)) throw badInput('bad session id'); return id; }
function validSeq(seq) { if (!Number.isSafeInteger(seq) || seq < 1) throw badInput('bad segment number'); return seq; }
function validSpeaker(s) { if (s !== 'person' && s !== 'agent') throw badInput('bad speaker'); return s; }
function cap(v, n) { return typeof v === 'string' ? v.trim().slice(0, n) : ''; }
function capText(v) {
  if (typeof v !== 'string' || !v.trim()) throw badInput('text is required');
  return v.slice(0, TEXT_MAX);
}

/** The name of the empty marker file in a session folder that says which call the session is: call-<first 32 hex of sha256(callId)>. */
function callMarkerName(callId) { return `call-${crypto.createHash('sha256').update(String(callId)).digest('hex').slice(0, 32)}`; }

function pad(seq) { return String(seq).padStart(4, '0'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

async function fsyncDir(dir) {
  let fh;
  try { fh = await fs.promises.open(dir, 'r'); await fh.sync(); } catch { /* some filesystems refuse; the rename is still atomic */ } finally { if (fh) await fh.close(); }
}

function createStore({ root, key, now = () => Date.now(), randomHex = (n) => crypto.randomBytes(n).toString('hex') } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('root is required');
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('key must be a 32-byte Buffer');
  const ROOT = path.resolve(root);

  function toIso(v, fallback) {
    if (v === undefined || v === null || v === '') v = fallback === undefined ? now() : fallback;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) throw badInput('bad time');
    return d.toISOString();
  }

  // Resolve a path under the root from already-validated parts and make sure it stays inside.
  function under(...parts) {
    const p = path.resolve(ROOT, ...parts);
    if (p !== ROOT && !p.startsWith(ROOT + path.sep)) throw badInput('path outside the recordings folder');
    return p;
  }
  const rel = (agent, sid, name) => `${agent}/${sid}/${name}`;

  async function mkdir700(dir) {
    try { await fs.promises.mkdir(dir, { mode: 0o700 }); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
    await fs.promises.chmod(dir, 0o700);
    return true;
  }
  async function ensureRoot() {
    await fs.promises.mkdir(ROOT, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(ROOT, 0o700);
    const marker = path.join(ROOT, MARKER);
    try { await fs.promises.access(marker); } catch {
      await writeAtomic(marker, Buffer.from(MARKER_TEXT));
    }
  }

  async function writeAtomic(file, data) {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.tmp-${randomHex(4)}-${process.pid}`);
    const fh = await fs.promises.open(tmp, 'w', 0o600);
    try { await fh.writeFile(data); await fh.sync(); } finally { await fh.close(); }
    await fs.promises.chmod(tmp, 0o600);
    await fs.promises.rename(tmp, file);
    await fsyncDir(dir);
  }

  // ---- per-session serialization ----
  const tails = new Map();
  function serial(k, fn) {
    const run = (tails.get(k) || Promise.resolve()).then(fn);
    const tail = run.then(() => {}, () => {});
    tails.set(k, tail);
    tail.then(() => { if (tails.get(k) === tail) tails.delete(k); });
    return run;
  }

  // ---- manifest ----
  async function loadManifest(agent, sid) {
    validAgent(agent); validSession(sid);
    const name = 'manifest.json.enc';
    let raw;
    try { raw = await fs.promises.readFile(under(agent, sid, name)); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw err('no_session', 'no such recording session');
      throw e;
    }
    let m;
    try { m = JSON.parse(open(key, raw, rel(agent, sid, name)).toString('utf8')); } catch (e) {
      throw err('bad_recording_file', 'the session manifest does not open');
    }
    if (!m || m.format !== 1 || m.sessionId !== sid || m.agent !== agent || !Array.isArray(m.entries)) throw err('bad_recording_file', 'the session manifest is not valid');
    return m;
  }

  function refreshDuration(m) {
    const start = Date.parse(m.startedAt);
    let end = m.endedAt ? Date.parse(m.endedAt) : start;
    if (!m.endedAt) {
      for (const e of m.entries) {
        const t = Date.parse(e.kind === 'segment' ? e.endedAt : e.at);
        if (t > end) end = t;
      }
    }
    m.durationMs = Math.max(0, end - start);
  }

  async function saveManifest(m) {
    refreshDuration(m);
    const name = 'manifest.json.enc';
    await writeAtomic(under(m.agent, m.sessionId, name), seal(key, Buffer.from(JSON.stringify(m), 'utf8'), rel(m.agent, m.sessionId, name)));
  }

  // Run a change on one session: load, mutate (may write files first), save, all in the session's queue.
  function update(agent, sid, mutate) {
    validAgent(agent); validSession(sid);
    return serial(`${agent}/${sid}`, async () => {
      const m = await loadManifest(agent, sid);
      const result = await mutate(m);
      await saveManifest(m);
      return result;
    });
  }

  const isClosed = (m) => m.endedAt !== null;
  const withinGrace = (m) => !isClosed(m) || now() - Date.parse(m.endedAt) <= TRANSCRIPT_GRACE_MS;

  // ---- API ----
  async function createSession(agent, opts = {}) {
    validAgent(agent);
    const o = opts || {};
    const d = o.device || {};
    const startedAt = toIso(o.startedAt);
    const at = new Date(now()).toISOString();                   // YYYY-MM-DDTHH:MM:SS.mmmZ
    const stamp = at.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    await ensureRoot();
    await mkdir700(under(agent));
    let sid = null;
    for (let i = 0; i < 8 && !sid; i++) {
      const candidate = `${stamp}-${randomHex(3)}`;
      if (!SESSION_RE.test(candidate)) throw new Error('bad generated session id');
      if (await mkdir700(under(agent, candidate))) sid = candidate;
    }
    if (!sid) throw err('session_exists', 'could not allocate a session id');
    const manifest = {
      format: 1, sessionId: sid, agent, startedAt, endedAt: null, durationMs: 0, aliveAt: startedAt,
      device: {
        userAgent: cap(d.userAgent, 300), micLabel: cap(d.micLabel, 120),
        sampleRate: Number.isInteger(d.sampleRate) ? d.sampleRate : null,
        ...(PROCESSING.includes(d.processing) ? { processing: d.processing } : {}),   // how the voice was taken (capped to these three values)
      },
      userId: cap(o.userId, 120), callId: cap(o.callId, 120), keepReplies: !!o.keepReplies, consentLine: cap(o.consentLine, 300),
      entries: [],
    };
    await serial(`${agent}/${sid}`, async () => {
      // The call marker is on disk before the first manifest save, so a lookup can tell whose session this is without opening it.
      if (manifest.callId) await writeAtomic(under(agent, sid, callMarkerName(manifest.callId)), Buffer.alloc(0));
      await saveManifest(manifest);
    });
    return { sessionId: sid };
  }

  async function addSegment(agent, sid, seg = {}) {
    validAgent(agent); validSession(sid);
    const speaker = validSpeaker(seg.speaker);
    const piece = seg.piece === undefined || seg.piece === null ? undefined : seg.piece;
    if (piece !== undefined && (typeof piece !== 'string' || !PIECE_RE.test(piece))) throw badInput('bad piece id');
    if (!Buffer.isBuffer(seg.wav)) throw badInput('wav must be a Buffer');
    const startedAt = toIso(seg.startedAt);
    const endedAt = toIso(seg.endedAt, Date.parse(startedAt));
    const { sampleRate, samples } = wavToPcm16(seg.wav);
    const flac = await encodeFlacAsync(samples, sampleRate);
    const back = decodeFlac(flac);
    if (back.sampleRate !== sampleRate || back.samples.length !== samples.length || Buffer.compare(
      Buffer.from(back.samples.buffer, back.samples.byteOffset, back.samples.byteLength),
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)) !== 0) throw err('bad_recording_file', 'the encoded audio does not match the original');
    const digest = sha256(flac);
    return update(agent, sid, async (m) => {
      if (!withinGrace(m)) throw err('session_closed', 'the recording session was finished too long ago');   // the last pieces may arrive just after hang-up
      if (piece !== undefined) {
        // A piece the page sent before (its answer was lost, or it retried): the same audio gives the same seq and writes nothing.
        const same = m.entries.find((e) => e.kind === 'segment' && e.piece === piece);
        if (same) {
          if (same.sha256 !== digest) throw err('piece_conflict', 'this piece id already holds different audio');
          return { seq: same.seq, file: same.file, sha256: same.sha256, bytes: same.bytes, durationMs: same.durationMs, sampleRate: same.sampleRate, samples: same.samples, duplicate: true };
        }
      }
      let seq = 0;
      for (const e of m.entries) if (e.kind === 'segment' && e.seq > seq) seq = e.seq;
      seq++;
      const file = `${pad(seq)}-${speaker}.flac`;
      await writeAtomic(under(agent, sid, file + '.enc'), seal(key, flac, rel(agent, sid, file + '.enc')));
      const entry = {
        seq, kind: 'segment', speaker, file, startedAt, endedAt,
        durationMs: Math.round(samples.length * 1000 / sampleRate), sampleRate, samples: samples.length,
        bytes: flac.length, sha256: digest, transcript: '', engine: '',
        ...(piece !== undefined ? { piece } : {}),
      };
      m.entries.push(entry);
      return { seq, file, sha256: digest, bytes: flac.length, durationMs: entry.durationMs, sampleRate, samples: samples.length };
    });
  }

  async function setTranscript(agent, sid, seq, tr = {}) {
    validSeq(seq);
    const text = typeof tr.text === 'string' ? tr.text.slice(0, TEXT_MAX) : (() => { throw badInput('text is required'); })();
    const engine = tr.engine === undefined ? 'local' : tr.engine;
    if (typeof engine !== 'string' || !ENGINE_RE.test(engine)) throw badInput('bad engine');
    return update(agent, sid, async (m) => {
      if (!withinGrace(m)) throw err('session_closed', 'the recording session was finished too long ago');
      const e = m.entries.find((x) => x.kind === 'segment' && x.seq === seq);
      if (!e) throw err('no_segment', 'no such segment');
      e.transcript = text;
      e.engine = engine;
    });
  }

  async function addText(agent, sid, t = {}) {
    validSpeaker(t.speaker);
    if (t.speaker !== 'agent') throw badInput('only agent text entries are kept');
    const text = capText(t.text);
    const at = toIso(t.at);
    return update(agent, sid, async (m) => {
      if (!withinGrace(m)) throw err('session_closed', 'the recording session is finished');
      m.entries.push({ kind: 'text', speaker: 'agent', text, at });
    });
  }

  async function addEvent(agent, sid, ev = {}) {
    if (!EVENT_TYPES.includes(ev.type)) throw badInput('bad event type');
    const at = toIso(ev.at);
    return update(agent, sid, async (m) => {
      if (isClosed(m)) throw err('session_closed', 'the recording session is finished');
      m.entries.push({ kind: 'event', type: ev.type, at, ...(ev.type === 'consent' && ev.spoken === false ? { spoken: false } : {}) });
    });
  }

  async function finish(agent, sid, opts = {}) {
    const endedAt = toIso((opts || {}).endedAt);
    return update(agent, sid, async (m) => {
      if (isClosed(m)) return;
      m.endedAt = endedAt;
    });
  }

  async function readManifest(agent, sid) { return loadManifest(agent, sid); }

  // The session of one call, found on disk (a late piece after a hub restart, when no call registry remembers it). Only this agent's
  // sessions whose id date is today or in the 2 days before are opened, newest first; the first manifest with the call id is returned
  // (null when none). Sessions that don't open are skipped.
  const LOOKUP_DAYS = 2;
  async function findSessionByCall(agent, callId) {
    validAgent(agent);
    if (typeof callId !== 'string' || !callId) return null;
    const d = new Date(now());
    const cutoff = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - LOOKUP_DAYS)).toISOString().slice(0, 10).replace(/-/g, '');
    const mine = callMarkerName(callId);
    let unreadable = false;   // an unmarked session (made before markers) that could not be opened: it might have been this call's
    for (const sid of (await sessionIds(agent)).reverse()) {
      if (sid.slice(0, 8) < cutoff) break;   // sorted: everything after this is older
      // The durable call marker says whose session this is without opening the manifest.
      let files;
      try { files = await fs.promises.readdir(under(agent, sid)); } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) continue;
        throw e;
      }
      if (files.includes(mine)) {
        let m;
        try { m = await loadManifest(agent, sid); } catch (e) {
          // The session is this call's but cannot be read: "cannot tell", never a miss.
          // A missing manifest beside the call's marker proves nothing (it may have been lost): "cannot tell" as well.
          if (e && (e.code === 'no_session' || e.code === 'bad_recording_file')) throw Object.assign(err('lookup_inconclusive', 'the call\'s session cannot be read'), { cause: e });
          throw e;
        }
        if (m.callId === callId) return m;
        continue;
      }
      if (files.some((f) => f.startsWith('call-'))) continue;   // marked as another call's session
      // No marker (made before markers, or copied by hand): match on the manifest.
      try { const m = await loadManifest(agent, sid); if (m.callId === callId) return m; } catch (e) {
        // A folder with no manifest is not a session (silent); a manifest that does not open is skipped (logged once an hour).
        // Anything else is a real I/O error: it propagates, so the caller can answer "try later".
        if (e && e.code === 'no_session') continue;
        if (e && e.code === 'bad_recording_file') { logSkipped(agent, sid); unreadable = true; continue; }
        throw e;
      }
    }
    // No match. When an unmarked session could not be opened, it might have been this call's: "cannot tell", never a miss
    // (only sessions made before call markers have no marker, so this cannot hold lookups up for long).
    if (unreadable) throw err('lookup_inconclusive', 'an unmarked session in the window cannot be read');
    return null;
  }

  const SKIP_LOG_MS = 60 * 60 * 1000;
  const SKIP_LOG_MAX = 1000;
  const skippedLogged = new Map();   // "<agent>/<sid>" -> time of the last log line
  function logSkipped(agent, sid) {
    const k = `${agent}/${sid}`;
    const t = now();
    const last = skippedLogged.get(k);
    if (last !== undefined && t - last < SKIP_LOG_MS) return;
    skippedLogged.delete(k);
    if (skippedLogged.size >= SKIP_LOG_MAX) skippedLogged.delete(skippedLogged.keys().next().value);
    skippedLogged.set(k, t);
    console.log(`[recordings] skipped a session that does not open: ${k}`);
  }

  // The hub's own clock for a call that a restart cut short: the call heartbeat stamps aliveAt on the manifest, at most once a minute.
  const TOUCH_MS = 60 * 1000;
  const touched = new Map();   // "<agent>/<sid>" -> time of the last stamp
  async function touch(agent, sid) {
    validAgent(agent); validSession(sid);
    const k = `${agent}/${sid}`;
    const t = now();
    const last = touched.get(k);
    if (last !== undefined && t - last < TOUCH_MS && t >= last) return false;
    if (touched.size > 500) for (const [x, at] of touched) if (t - at >= TOUCH_MS) touched.delete(x);
    touched.set(k, t);
    try {
      return await update(agent, sid, async (m) => {
        if (isClosed(m)) return false;
        m.aliveAt = new Date(now()).toISOString();
        return true;
      });
    } catch (e) { touched.delete(k); throw e; }
  }

  // Whether this agent has a recordings folder at all (a lookup for any other agent has nothing to scan).
  async function hasAgentFolder(agent) {
    validAgent(agent);
    try { return (await fs.promises.stat(under(agent))).isDirectory(); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
      throw e;
    }
  }

  async function dirNames(dir) {
    try { return await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
      throw e;
    }
  }

  async function sessionIds(agent) {
    return (await dirNames(under(agent))).filter((d) => d.isDirectory() && SESSION_RE.test(d.name)).map((d) => d.name).sort();
  }

  async function listAgents() {
    const out = [];
    for (const d of await dirNames(ROOT)) {
      if (d.isDirectory() && AGENT_RE.test(d.name) && (await sessionIds(d.name)).length) out.push(d.name);
    }
    return out.sort();
  }

  async function listSessions(agent) {
    validAgent(agent);
    const out = [];
    for (const sid of (await sessionIds(agent)).reverse()) {
      try {
        const m = await loadManifest(agent, sid);
        const segs = m.entries.filter((e) => e.kind === 'segment');
        const first = segs.find((e) => e.speaker === 'person' && e.transcript);
        out.push({
          sessionId: sid, startedAt: m.startedAt, endedAt: m.endedAt, unfinished: m.endedAt === null, durationMs: m.durationMs,
          segments: segs.length, bytes: segs.reduce((n, e) => n + e.bytes, 0), firstWords: first ? first.transcript.slice(0, 80) : '',
        });
      } catch { out.push({ sessionId: sid, damaged: true }); }
    }
    return out;
  }

  async function readSegment(agent, sid, seq) {
    validSeq(seq);
    const m = await loadManifest(agent, sid);
    const e = m.entries.find((x) => x.kind === 'segment' && x.seq === seq);
    if (!e) throw err('no_segment', 'no such segment');
    const name = e.file + '.enc';
    if (!/^\d{4,}-(person|agent)\.flac$/.test(e.file)) throw err('bad_recording_file', 'bad segment name in the manifest');
    let raw;
    try { raw = await fs.promises.readFile(under(agent, sid, name)); } catch (er) {
      if (er.code === 'ENOENT') throw err('bad_recording_file', 'the segment file is missing');
      throw er;
    }
    const flac = open(key, raw, rel(agent, sid, name));
    if (sha256(flac) !== e.sha256) throw err('bad_recording_file', 'the segment file does not match the manifest');
    return flac;
  }

  const hms = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
  };
  const label = (speaker) => (speaker === 'agent' ? 'Agent' : 'Person');

  async function* exportEntries(agent, sid) {
    const m = await loadManifest(agent, sid);
    const t0 = Date.parse(m.startedAt);
    const lines = [];
    for (const e of m.entries) {
      if (e.kind === 'segment') lines.push(`[${hms(Date.parse(e.startedAt) - t0)}] ${label(e.speaker)}: ${e.transcript || '(no transcript)'}`);
      else if (e.kind === 'text') lines.push(`[${hms(Date.parse(e.at) - t0)}] ${label(e.speaker)}: ${e.text}`);
      else if (e.kind === 'event') lines.push(`[${hms(Date.parse(e.at) - t0)}] (${e.type}${e.type === 'consent' && e.spoken === false ? ' line not spoken' : ''})`);
    }
    const when = new Date(t0);
    // The downloaded manifest leaves out who started the call and the hub's call id: neither is needed to use the recording.
    const { userId: _u, callId: _c, ...shown } = m;
    yield { name: `${sid}/manifest.json`, data: Buffer.from(JSON.stringify(shown, null, 2) + '\n', 'utf8'), mtime: when };
    yield { name: `${sid}/transcript.txt`, data: Buffer.from(lines.join('\n') + (lines.length ? '\n' : ''), 'utf8'), mtime: when };
    for (const e of m.entries) {
      if (e.kind !== 'segment') continue;
      const base = e.file.replace(/\.flac$/, '');
      yield { name: `${sid}/${e.file}`, data: await readSegment(agent, sid, e.seq), mtime: new Date(e.startedAt) };
      yield { name: `${sid}/${base}.txt`, data: Buffer.from(e.transcript ? e.transcript + '\n' : '', 'utf8'), mtime: new Date(e.startedAt) };
    }
  }

  async function deleteSession(agent, sid) {
    validAgent(agent); validSession(sid);
    return serial(`${agent}/${sid}`, async () => {
      await loadManifest(agent, sid).catch((e) => { if (e.code === 'no_session') throw e; });
      await fs.promises.rm(under(agent, sid), { recursive: true, force: true });
      try { await fs.promises.rmdir(under(agent)); } catch (e) { if (e.code !== 'ENOTEMPTY' && e.code !== 'ENOENT') throw e; }
    });
  }

  async function stats(agent) {
    if (agent !== undefined) validAgent(agent);
    const out = { sessions: 0, segments: 0, bytes: 0, speechMs: 0 };
    for (const a of agent === undefined ? await listAgents() : [agent]) {
      for (const sid of await sessionIds(a)) {
        let m;
        try { m = await loadManifest(a, sid); } catch { continue; }
        out.sessions++;
        for (const e of m.entries) if (e.kind === 'segment') { out.segments++; out.bytes += e.bytes; out.speechMs += e.durationMs; }
      }
    }
    return out;
  }

  return { createSession, addSegment, setTranscript, addText, addEvent, finish, readManifest, findSessionByCall, touch, hasAgentFolder, listAgents, listSessions, readSegment, exportEntries, deleteSession, stats };
}

module.exports = { createStore, callMarkerName };
