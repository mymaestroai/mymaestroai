'use strict';

// lib/recordings/routes.js: the /api/recordings/* HTTP surface (call recordings, lib/recordings).
//
// Two kinds of route, and server.js has already identified the caller and applied the access table (lib/access):
//   1. Uploads from the person on the recorded call (segment, transcript, text, pause, consent, trouble): access class "agent" (the caller
//      must be allowed that agent). The handler also checks that the agent has a live call (or, for a transcript and a reply
//      text and a last piece of audio, one that ended less than 60 minutes ago, or one replaced by a newer call) with the request's call id, started by this same caller, with a recording session.
//   2. List, play, download and delete: access class "session" (any signed-in user reaches the handler). The handler refuses with
//      403 { error: 'not_allowed' } every caller that is not a signed-in person on that agent's recordings.allowed list: the hub's own
//      service calls (how agents' tools reach the hub), API tokens, a session still owing its two-factor code, no user at all.
//      Admins get no exception. The answer is the same whether or not the agent or the session exists.
// Nothing here logs audio, transcript text or the consent line. Every audit entry carries the user id, the action and
// <agent>/<sessionId>[/<seq>].

const { writeZip } = require('./zip');
const { recordingsOf, isAllowedUser } = require('./settings');
const trouble = require('./trouble');

const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);
const PLAY_AUDIT_MS = 10 * 60 * 1000;
// The same patterns as lib/recordings/store.js.
const AGENT_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SESSION_RE = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
const SEQ_RE = /^\d{1,9}$/;

const DISK_LOOKUP_MS = 5 * 60 * 1000;   // hits and misses of the on-disk call lookup are remembered this long
const DISK_INCONCLUSIVE_MS = 30 * 1000;   // a lookup that could not finish is answered "try later" without a rescan for this long
const DISK_GRACE_MS = 60 * 60 * 1000;
const DISK_LOOKUP_MAX = 500;        // the lookup cache holds at most this many answers; the oldest go first
const CALL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PIECE_RE = /^[A-Za-z0-9_-]{8,64}$/;
let diskLookups = new WeakMap();   // store -> { seen: Map("<agent>|<callId>" -> { at, found } or { at, inconclusive: true }), pending: Map(same key -> Promise) }

const playSeen = new Map();   // "<user>|<agent>/<session>/<seq>" -> time of the last audited play
function resetForTests() { playSeen.clear(); diskLookups = new WeakMap(); }

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
const pad = (n) => String(n).padStart(4, '0');

/** "bytes=a-b", "bytes=a-" or "bytes=-n" -> { start, end } (inclusive), 'invalid' (416) or null (no usable single range: serve it all). */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return String(header).includes(',') ? null : 'invalid';
  let start; let end;
  if (m[1] === '') { const n = Number(m[2]); if (!n) return 'invalid'; start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return 'invalid';
  return { start, end };
}

/**
 * handle(pathname, req, res, deps) -> Promise (always answers).
 * deps: { jsonResponse, readBody, getAgents, voiceCall?, store?, audit?(userId, action, detail, req), now?, maxSegmentBytes? }
 */
async function handle(pathname, req, res, deps) {
  const { jsonResponse, readBody, getAgents } = deps;
  const method = req.method;
  const now = deps.now || (() => Date.now());
  const maxSegment = deps.maxSegmentBytes || MAX_SEGMENT_BYTES;
  const calls = () => deps.voiceCall || require('../voice/call');
  const store = () => deps.store || require('./index').getStore();
  const drain = () => { try { req.resume(); } catch {} };
  const agentRecord = async (name) => { try { return (await getAgents()).find(x => x && x.name === name) || null; } catch { return null; } };
  const audit = (uid, action, detail) => {
    try {
      if (deps.audit) return deps.audit(uid, action, detail, req);
      const a = require('../auth').getAuth();
      return a.audit(uid, action, detail, a.clientIp(req));
    } catch {}
    return undefined;
  };
  const storeError = (e) => {
    if (e && e.badAudio) return jsonResponse(res, 400, { error: 'bad_audio' });
    const code = e && e.code;
    if (code === 'bad_input') return jsonResponse(res, 400, { error: 'bad_request' });
    if (code === 'no_session' || code === 'session_closed') return jsonResponse(res, 409, { error: 'not_recording' });
    if (code === 'no_segment') return jsonResponse(res, 404, { error: 'no_segment' });
    if (code === 'piece_conflict') return jsonResponse(res, 409, { error: 'piece_conflict' });
    console.error(`[recordings] request failed: ${code || 'error'}`);
    return jsonResponse(res, 500, { error: 'recording_failed' });
  };
  const readJson = async () => { try { return JSON.parse((await readBody(req)) || '{}') || {}; } catch { return null; } };

  try {
    // ── 1. Uploads from the person on the call ──
    const UPLOADS = ['/api/recordings/segment', '/api/recordings/transcript', '/api/recordings/text', '/api/recordings/pause', '/api/recordings/consent', '/api/recordings/trouble'];
    if (UPLOADS.includes(pathname)) {
      // A recording is fed only by the signed-in person on the call: never a service call, an API token or a session owing its code.
      if (req.hubService || req.hubToken || req.hubPendingTotp) { drain(); return jsonResponse(res, 403, { error: 'not_allowed' }); }
      if (method !== 'POST') { drain(); return jsonResponse(res, 405, { error: 'method_not_allowed' }); }
      const userId = req.hubUser ? String(req.hubUser.id) : (req.hubService ? 'service' : 'owner');
      // The recording of this agent's call, for this caller and call id: live, or (allowEnded) ended or replaced in the last 60 minutes.
      // When no call registry remembers the call (the hub restarted), the store is asked: a session of this agent, last 2 days, with this call id.
      const fromDisk = async (agent, callId) => {
        const st = store();
        if (!st || typeof st.findSessionByCall !== 'function') return null;
        if (!AGENT_RE.test(agent) || !CALL_ID_RE.test(callId)) return null;   // nothing to look up: a plain refusal
        const t = now();
        let lk = diskLookups.get(st);
        if (!lk) { lk = { seen: new Map(), pending: new Map() }; diskLookups.set(st, lk); }
        const { seen, pending } = lk;
        for (const [k, v] of seen) if (t - v.at > (v.inconclusive ? DISK_INCONCLUSIVE_MS : DISK_LOOKUP_MS)) seen.delete(k);
        const key = `${agent}|${callId}`;
        const inconclusive = (e) => Object.assign(new Error('call lookup could not finish'), { code: 'lookup_inconclusive', tryLater: true, cause: e });
        let hit = seen.get(key);
        if (hit && hit.inconclusive) throw inconclusive();   // a scan that could not finish a moment ago: "try later" again, no rescan
        if (!hit) {
          // Concurrent lookups of the same call share one scan. A scan that could not finish (it throws) is answered "try later"
          // and remembered for 30 seconds as such (never as a miss or a hit); a confirmed miss or a hit is cached for longer.
          let p = pending.get(key);
          if (!p) {
            p = (async () => {
              if (typeof st.hasAgentFolder === 'function' && !(await st.hasAgentFolder(agent))) return { at: t, found: null };
              const m = await st.findSessionByCall(agent, callId);
              let last = NaN;
              if (m) { last = Date.parse(m.startedAt); const alive = Date.parse(m.aliveAt); if (alive > last || Number.isNaN(last)) last = alive; }
              return { at: t, found: m ? { sessionId: m.sessionId, userId: String(m.userId), keepReplies: !!m.keepReplies, endedAt: m.endedAt, last } : null };
            })();
            pending.set(key, p);
            const drop = () => { if (pending.get(key) === p) pending.delete(key); };
            p.then(drop, drop);
          }
          try { hit = await p; } catch (e) {
            if (!seen.has(key)) {
              seen.set(key, { at: t, inconclusive: true });
              while (seen.size > DISK_LOOKUP_MAX) seen.delete(seen.keys().next().value);
            }
            throw inconclusive(e);
          }
          if (!seen.has(key)) {
            seen.set(key, hit);
            while (seen.size > DISK_LOOKUP_MAX) seen.delete(seen.keys().next().value);
          }
        }
        const f = hit.found;
        if (!f || f.userId !== userId) return null;
        const ref = f.endedAt === null ? f.last : Date.parse(f.endedAt);   // an unfinished session: the hub's own clock (aliveAt), never the entries' times
        if (!Number.isFinite(ref) || t - ref > DISK_GRACE_MS) return null;
        return { sessionId: f.sessionId, live: false, keepReplies: f.keepReplies, paused: false };
      };
      const recordingFor = async (agent, callId, allowEnded) => {
        if (!agent || !callId) return null;
        const live = calls().recordingOf(agent);
        if (live && live.sessionId && live.callId === callId) return String(live.userId) === userId ? { sessionId: live.sessionId, live: true, keepReplies: !!live.keepReplies, paused: !!live.paused } : null;
        // A newer call is live, or none: the pieces of an earlier call (same agent, its own id) still go to that call's session.
        if (!allowEnded) return null;
        const e = calls().recentRecording(agent, callId);
        if (e) return String(e.userId) === userId ? { sessionId: e.sessionId, live: false, keepReplies: !!e.keepReplies, paused: false } : null;
        return fromDisk(agent, callId);
      };
      const notRecording = () => jsonResponse(res, 409, { error: 'not_recording' });

      if (pathname === '/api/recordings/segment') {
        const q = new URL(req.url, 'http://x').searchParams;
        const agent = String(q.get('agent') || ''); const callId = String(q.get('callId') || ''); const speaker = String(q.get('speaker') || '');
        // A call that ended less than 60 minutes ago still takes its last pieces (an upload in flight at hang-up, pieces the page kept and resends).
        const pieceText = q.get('piece');
        if (pieceText !== null && !PIECE_RE.test(pieceText)) { drain(); return jsonResponse(res, 400, { error: 'bad_request' }); }
        const piece = pieceText === null ? undefined : pieceText;
        let rec = await recordingFor(agent, callId, true);
        if (!rec) { drain(); return notRecording(); }
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!WAV_TYPES.has(type)) { drain(); return jsonResponse(res, 415, { error: 'send audio/wav (16-bit PCM)' }); }
        if (speaker !== 'person' && speaker !== 'agent') { drain(); return jsonResponse(res, 400, { error: 'bad_speaker' }); }
        if (speaker === 'agent' && !rec.keepReplies) { drain(); return jsonResponse(res, 409, { error: 'replies_not_kept' }); }
        const tooBigAnswer = () => jsonResponse(res, 413, { error: `audio is larger than ${Math.round(maxSegment / 1048576)} MB` });
        if (Number(req.headers['content-length'] || 0) > maxSegment) { drain(); return tooBigAnswer(); }
        const chunks = []; let size = 0; let tooBig = false;
        await new Promise((resolve, reject) => {
          req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > maxSegment) { tooBig = true; chunks.length = 0; } else chunks.push(c); });
          req.on('end', resolve); req.on('error', reject); req.on('aborted', () => reject(new Error('upload aborted')));
        });
        if (tooBig) return tooBigAnswer();
        if (!size) return jsonResponse(res, 400, { error: 'bad_audio' });
        rec = await recordingFor(agent, callId, true);   // the call may have ended more than 60 minutes ago while the audio came in
        if (!rec) return notRecording();
        try {
          const r = await store().addSegment(agent, rec.sessionId, { speaker, piece, wav: Buffer.concat(chunks), startedAt: q.get('startedAt') || undefined, endedAt: q.get('endedAt') || undefined });
          return jsonResponse(res, 200, { seq: r.seq });
        } catch (e) {
          // A store failure (not a bad upload) means this call is no longer being recorded: the allowed users hear of it once.
          const known = e && (e.badAudio || ['bad_input', 'no_session', 'session_closed', 'no_segment', 'piece_conflict'].includes(e.code));
          if (!known) await trouble.notifyTrouble({ agent, callId, rec: await agentRecord(agent), now: now(), push: deps.push, reason: 'upload_failed' });
          return storeError(e);
        }
      }

      const b = await readJson();
      if (b === null) return jsonResponse(res, 400, { error: 'invalid JSON' });
      const agent = String(b.agent || ''); const callId = String(b.callId || '');

      if (pathname === '/api/recordings/transcript') {
        const rec = await recordingFor(agent, callId, true);
        if (!rec) return notRecording();
        if (!Number.isSafeInteger(b.seq) || b.seq < 1 || typeof b.text !== 'string') return jsonResponse(res, 400, { error: 'bad_request' });
        try { await store().setTranscript(agent, rec.sessionId, b.seq, { text: b.text, ...(b.engine === undefined ? {} : { engine: b.engine }) }); return jsonResponse(res, 200, { ok: true }); } catch (e) { return storeError(e); }
      }
      if (pathname === '/api/recordings/text') {
        const rec = await recordingFor(agent, callId, true);
        if (!rec) return notRecording();
        try { await store().addText(agent, rec.sessionId, { speaker: 'agent', text: b.text, at: b.at }); return jsonResponse(res, 200, { ok: true }); } catch (e) { return storeError(e); }
      }
      if (pathname === '/api/recordings/pause') {
        const rec = await recordingFor(agent, callId, false);
        if (!rec) return notRecording();
        if (typeof b.paused !== 'boolean') return jsonResponse(res, 400, { error: 'bad_request' });
        if (rec.paused !== b.paused) {
          // The event first, then the flag: a failed event leaves the state as it was. (Pause never refuses audio: it is the page's capture control.)
          try { await store().addEvent(agent, rec.sessionId, { type: b.paused ? 'pause' : 'resume' }); } catch (e) { return storeError(e); }
          calls().setRecording(agent, callId, { paused: b.paused });
        }
        return jsonResponse(res, 200, { ok: true, paused: b.paused });
      }
      if (pathname === '/api/recordings/trouble') {
        const rec = await recordingFor(agent, callId, true);
        if (!rec) return notRecording();
        if (!trouble.REASONS.includes(b.reason)) return jsonResponse(res, 400, { error: 'bad_request' });
        return jsonResponse(res, 200, await trouble.notifyTrouble({ agent, callId, rec: await agentRecord(agent), now: now(), push: deps.push, reason: b.reason }));
      }
      // consent
      const rec = await recordingFor(agent, callId, false);
      if (!rec) return notRecording();
      if (b.spoken !== undefined && typeof b.spoken !== 'boolean') return jsonResponse(res, 400, { error: 'bad_request' });
      const spoken = b.spoken !== false;   // default true: the consent line was said aloud
      try { await store().addEvent(agent, rec.sessionId, { type: 'consent', ...(spoken ? {} : { spoken: false }) }); return jsonResponse(res, 200, { ok: true }); } catch (e) { return storeError(e); }
    }

    // ── 2. List, play, download, delete: only a signed-in person on the agent's allowed list ──
    const refused = () => { drain(); return jsonResponse(res, 403, { error: 'not_allowed' }); };   // the body of a refused request is never read
    if (req.hubService || req.hubToken || !req.hubUser || req.hubPendingTotp) return refused();
    const uid = String(req.hubUser.id);

    if (pathname === '/api/recordings') {
      if (method !== 'GET') return jsonResponse(res, 405, { error: 'method_not_allowed' });
      const out = [];
      for (const a of await getAgents()) {
        if (!a || !isAllowedUser(a, uid)) continue;
        let s = { sessions: 0, bytes: 0, speechMs: 0 };
        try { s = await store().stats(a.name); } catch {}
        out.push({ name: a.name, display: a.display || a.name, sessions: s.sessions, bytes: s.bytes, speechMs: s.speechMs });
      }
      return jsonResponse(res, 200, { agents: out });
    }

    const m = /^\/api\/recordings\/([^/]+)\/(.+)$/.exec(pathname);
    if (!m) return jsonResponse(res, 404, { error: 'not_found' });
    const agent = safeDecode(m[1]);
    const rec = agent === null ? null : await agentRecord(agent);
    if (!rec || !isAllowedUser(rec, uid)) return refused();
    const rest = m[2].split('/').map(safeDecode);
    if (rest.includes(null)) return jsonResponse(res, 404, { error: 'not_found' });
    const notFound = () => jsonResponse(res, 404, { error: 'not_found' });
    const wrongMethod = () => jsonResponse(res, 405, { error: 'method_not_allowed' });
    if (!AGENT_RE.test(agent)) return notFound();
    const fileErr = (e) => {
      if (e && (e.code === 'no_session' || e.code === 'no_segment' || e.code === 'bad_input')) return notFound();
      if (e && e.code === 'bad_recording_file') return jsonResponse(res, 500, { error: 'damaged' });
      console.error(`[recordings] request failed: ${(e && e.code) || 'error'}`);
      return jsonResponse(res, 500, { error: 'recording_failed' });
    };
    const zipHeaders = (name) => ({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });

    // GET /api/recordings/<agent>/sessions
    if (rest.length === 1 && rest[0] === 'sessions') {
      if (method !== 'GET') return wrongMethod();
      try { return jsonResponse(res, 200, { sessions: await store().listSessions(agent) }); } catch (e) { return fileErr(e); }
    }

    // GET /api/recordings/<agent>/all.zip
    if (rest.length === 1 && rest[0] === 'all.zip') {
      if (method !== 'GET') return wrongMethod();
      const st = store();
      let list;
      try { list = (await st.listSessions(agent)).reverse(); } catch (e) { return fileErr(e); }   // oldest first
      audit(uid, 'recordings.download', `${agent}/all`);
      const damaged = [];
      async function* entries() {
        for (const s of list) {
          if (s.damaged) { damaged.push(s.sessionId); continue; }
          // A session is checked whole before its first file goes into the zip: a damaged one is skipped, never half-written.
          try {
            const man = await st.readManifest(agent, s.sessionId);
            for (const e of man.entries) if (e.kind === 'segment') await st.readSegment(agent, s.sessionId, e.seq);
          } catch { damaged.push(s.sessionId); continue; }
          yield* st.exportEntries(agent, s.sessionId);
        }
        if (damaged.length) yield { name: 'damaged.txt', data: Buffer.from('These sessions are damaged and were left out:\n' + damaged.join('\n') + '\n', 'utf8'), mtime: new Date(now()) };
      }
      res.writeHead(200, zipHeaders(`${agent}-all.zip`));
      try { await writeZip(entries(), res); res.end(); } catch { try { res.destroy(); } catch {} }
      return undefined;
    }

    const sid = rest[0];
    const sidOk = typeof sid === 'string' && SESSION_RE.test(sid.replace(/\.zip$/, ''));

    // GET /api/recordings/<agent>/<sessionId>.zip
    if (rest.length === 1 && /\.zip$/.test(rest[0])) {
      if (method !== 'GET') return wrongMethod();
      const id = rest[0].replace(/\.zip$/, '');
      if (!SESSION_RE.test(id)) return notFound();
      try { await store().readManifest(agent, id); } catch (e) { return fileErr(e); }
      audit(uid, 'recordings.download', `${agent}/${id}`);
      res.writeHead(200, zipHeaders(`${agent}-${id}.zip`));
      try { await writeZip(store().exportEntries(agent, id), res); res.end(); } catch { try { res.destroy(); } catch {} }
      return undefined;
    }

    // GET /api/recordings/<agent>/<sessionId>/manifest
    if (rest.length === 2 && rest[1] === 'manifest') {
      if (method !== 'GET') return wrongMethod();
      if (!sidOk) return notFound();
      try {
        const { userId, callId, ...man } = await store().readManifest(agent, sid);
        const key = `${uid}|${agent}/${sid}|manifest`; const t = now();
        for (const [k, at] of playSeen) if (t - at > PLAY_AUDIT_MS) playSeen.delete(k);
        if (!playSeen.has(key)) { playSeen.set(key, t); audit(uid, 'recordings.view', `${agent}/${sid}`); }
        return jsonResponse(res, 200, man);
      } catch (e) { return fileErr(e); }
    }

    // GET /api/recordings/<agent>/<sessionId>/<seq>.flac
    if (rest.length === 2 && /\.flac$/.test(rest[1])) {
      if (method !== 'GET') return wrongMethod();
      const seqText = rest[1].replace(/\.flac$/, '');
      if (!sidOk || !SEQ_RE.test(seqText) || Number(seqText) < 1) return notFound();
      const seq = Number(seqText);
      let flac;
      try { flac = await store().readSegment(agent, sid, seq); } catch (e) { return fileErr(e); }
      const key = `${uid}|${agent}/${sid}/${seq}`; const t = now();
      for (const [k, at] of playSeen) if (t - at > PLAY_AUDIT_MS) playSeen.delete(k);
      if (!playSeen.has(key)) { playSeen.set(key, t); audit(uid, 'recordings.play', `${agent}/${sid}/${seq}`); }
      const headers = { 'Content-Type': 'audio/flac', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': `inline; filename="${agent}-${sid}-${pad(seq)}.flac"` };
      const range = parseRange(req.headers && req.headers.range, flac.length);
      if (range === 'invalid') { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${flac.length}`, 'Content-Length': 0 }); return res.end(); }
      if (range) {
        const part = flac.subarray(range.start, range.end + 1);
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${range.start}-${range.end}/${flac.length}`, 'Content-Length': part.length });
        return res.end(part);
      }
      res.writeHead(200, { ...headers, 'Content-Length': flac.length });
      return res.end(flac);
    }

    // POST /api/recordings/<agent>/<sessionId>/delete {confirm: 'DELETE'}
    if (rest.length === 2 && rest[1] === 'delete') {
      if (method !== 'POST') return wrongMethod();
      if (!sidOk) return notFound();
      const b = await readJson();
      if (b === null) return jsonResponse(res, 400, { error: 'invalid JSON' });
      if (b.confirm !== 'DELETE') return jsonResponse(res, 400, { error: 'confirm_required' });
      const live = calls().recordingOf(agent);
      if (live && live.sessionId === sid) return jsonResponse(res, 409, { error: 'in_use' });
      try { await store().deleteSession(agent, sid); } catch (e) { return fileErr(e); }
      audit(uid, 'recordings.delete', `${agent}/${sid}`);
      return jsonResponse(res, 200, { ok: true });
    }

    return notFound();
  } catch (e) {
    // The call lookup could not finish (an unreadable folder or manifest): not a refusal. The page keeps the piece and tries again.
    if (e && e.code === 'lookup_inconclusive' && !res.headersSent) {
      try { drain(); res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30' }); res.end(JSON.stringify({ error: 'try_later' })); } catch {}
      return undefined;
    }
    console.error(`[recordings] route error: ${(e && e.code) || 'error'}`);
    if (!res.headersSent) return jsonResponse(res, 500, { error: 'recording_failed' });
    try { res.end(); } catch {}
    return undefined;
  }
}

module.exports = { handle, parseRange, resetForTests, MAX_SEGMENT_BYTES };
