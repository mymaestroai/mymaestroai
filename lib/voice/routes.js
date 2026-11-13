'use strict';

// lib/voice/routes.js: the /api/voice/* HTTP surface. server.js has already identified the caller and applied the access
// table (lib/access): status and web files are session routes, stt/tts are agent routes (the caller must be allowed that
// agent), enable/disable are admin-only. The handler checks admin again for enable/disable (defence in depth).
// Nothing here logs audio or text.

const fs = require('fs');
const manifest = require('./manifest');

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_TTS_CHARS = 2000;
const WAV_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave']);

let singleton = null;
/** The process-wide engine + client, created on first use (the settings read is lazy so tests never touch data/). */
function getVoice() {
  if (singleton) return singleton;
  const { createVoiceEngine } = require('./engine');
  const { createVoiceClient } = require('./client');
  const hubSettings = require('../settings');
  const engine = createVoiceEngine({ isEnabled: () => !!(hubSettings.getSetting('voice') || {}).enabled, log: (m) => console.log(m) });
  singleton = { engine, client: createVoiceClient({ engine }) };
  return singleton;
}

const defaultIsAdmin = (req) => !!req.hubService || !!(req.hubUser && req.hubUser.role === 'admin');

/**
 * handle(pathname, req, res, deps) -> Promise (always answers).
 * deps: { jsonResponse, readBody, getSetting, updateSettings, getAgents, getVoice?, isAdmin?, maxAudioBytes? }
 */
async function handle(pathname, req, res, deps) {
  const { jsonResponse, readBody, getSetting, updateSettings, getAgents } = deps;
  const { engine, client } = (deps.getVoice || getVoice)();
  const isAdmin = deps.isAdmin || defaultIsAdmin;
  const maxAudio = deps.maxAudioBytes || MAX_AUDIO_BYTES;
  const method = req.method;
  const settingsVoice = () => manifest.cleanVoiceSettings({}, getSetting('voice'));
  // The default voice in force: the saved hub default when it is installed, else the installer's.
  const effectiveDefault = (st) => { const saved = settingsVoice().defaultVoice; return saved && (st.voices || []).some(v => v.id === saved) ? saved : st.tts.defaultVoice; };
  const status = () => {
    const st = engine.status();
    const failed = !!st.error;
    // The error text can carry paths and URLs: only admins see it; everyone else gets failed: true.
    return { ...st, enabled: settingsVoice().enabled, error: isAdmin(req) ? st.error : (failed ? null : st.error), failed, tts: { ...st.tts, defaultVoice: effectiveDefault(st), installDefaultVoice: st.tts.defaultVoice } };
  };
  const usable = () => settingsVoice().enabled && engine.status().ready;
  const clientGen = () => (typeof client.generation === 'function' ? client.generation() : undefined);
  const drain = () => { try { req.resume(); } catch {} };
  // A caller that went away before the answer is sent: its queued voice work is dropped instead of run.
  let cancelled = false;
  const isCancelled = () => cancelled;
  try { res.on('close', () => { if (!res.writableEnded) cancelled = true; }); } catch {}
  // Maps a client rejection to the answer; returns true when it answered.
  const answerClientError = (e) => {
    if (!e) return false;
    if (e.code === 'voice_off') { jsonResponse(res, 409, { error: 'voice_off' }); return true; }
    if (e.code === 'voice_busy') { res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '5' }); res.end(JSON.stringify({ error: 'voice_busy' })); return true; }
    if (e.code === 'voice_cancelled') { try { res.end(); } catch {} return true; }
    return false;
  };

  try {
    if (pathname === '/api/voice/status' && method === 'GET') return jsonResponse(res, 200, status());

    if (pathname === '/api/voice/enable' && method === 'POST') {
      drain();
      if (!isAdmin(req)) return jsonResponse(res, 403, { error: 'admin_only' });
      if (!engine.status().platformSupported) return jsonResponse(res, 400, { error: 'platform_unsupported' });
      const cur = settingsVoice();
      client.resume();   // requests may run again (disable had stopped the client)
      updateSettings({ voice: manifest.cleanVoiceSettings({ enabled: true }, cur) });
      // Install in the background: the page polls /api/voice/status for step and progress.
      engine.install({ sttModel: cur.sttModel || undefined }).catch(() => {});
      return jsonResponse(res, 200, { ok: true, status: status() });
    }

    if (pathname === '/api/voice/disable' && method === 'POST') {
      drain();
      if (!isAdmin(req)) return jsonResponse(res, 403, { error: 'admin_only' });
      updateSettings({ voice: manifest.cleanVoiceSettings({ enabled: false }, settingsVoice()) });
      client.stop();   // the models leave memory; the downloaded files stay
      return jsonResponse(res, 200, { ok: true, status: status() });
    }

    if (pathname === '/api/voice/stt' && method === 'POST') {
      const q = new URL(req.url, 'http://x').searchParams;
      const agent = String(q.get('agent') || req.headers['x-agent'] || '');
      if (!agent) { drain(); return jsonResponse(res, 400, { error: 'agent_required' }); }
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!WAV_TYPES.has(type)) { drain(); return jsonResponse(res, 415, { error: 'send audio/wav (16-bit PCM)' }); }
      if (!usable()) { drain(); return jsonResponse(res, 409, { error: 'voice_off' }); }
      const admitted = clientGen();   // a Disable during the upload refuses this request, even if voice is enabled again
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > maxAudio) { drain(); return jsonResponse(res, 413, { error: `audio is larger than ${Math.round(maxAudio / 1048576)} MB` }); }
      const chunks = []; let size = 0; let tooBig = false;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > maxAudio) { tooBig = true; chunks.length = 0; } else chunks.push(c); });
        req.on('end', resolve); req.on('error', reject); req.on('aborted', () => reject(new Error('upload aborted')));
      });
      if (tooBig) return jsonResponse(res, 413, { error: `audio is larger than ${Math.round(maxAudio / 1048576)} MB` });
      if (!size) return jsonResponse(res, 400, { error: 'empty audio' });
      if (!usable()) return jsonResponse(res, 409, { error: 'voice_off' });   // disabled while the upload was coming in
      let r;
      try { r = await client.stt(Buffer.concat(chunks), undefined, { isCancelled, gen: admitted }); }
      catch (e) {
        if (answerClientError(e)) return;
        if (e && e.badAudio) return jsonResponse(res, 400, { error: e.message });
        console.error('[voice] stt failed:', e.message);
        return jsonResponse(res, 500, { error: 'speech recognition failed' });
      }
      console.log(`[voice] stt ${size} bytes in ${r.ms} ms`);
      return jsonResponse(res, 200, { text: r.text, ms: r.ms });
    }

    if (pathname === '/api/voice/tts' && method === 'POST') {
      const admitted = clientGen();   // as for stt: a Disable while this request waits refuses it
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const agent = String(b.agent || '');
      if (!agent) return jsonResponse(res, 400, { error: 'agent_required' });
      const text = typeof b.text === 'string' ? b.text : '';
      if (!text.trim()) return jsonResponse(res, 400, { error: 'text_required' });
      if (text.length > MAX_TTS_CHARS) return jsonResponse(res, 413, { error: `text is longer than ${MAX_TTS_CHARS} characters` });
      if (b.voice !== undefined && b.voice !== '' && !manifest.VOICE_IDS.includes(b.voice)) return jsonResponse(res, 400, { error: 'unknown_voice' });
      if (!usable()) return jsonResponse(res, 409, { error: 'voice_off' });
      const st = engine.status();
      const installed = new Set(st.voices.map(v => v.id));
      let agentVoice = '';
      try { const a = (await getAgents()).find(x => x.name === agent); agentVoice = (a && a.voice && a.voice.voice) || ''; } catch {}
      const pick = [b.voice, agentVoice, effectiveDefault(st), manifest.DEFAULT_VOICE].find(v => v && installed.has(v));
      if (!pick) return jsonResponse(res, 409, { error: 'voice_off' });
      const speed = Math.max(0.5, Math.min(2, Number(b.speed) || 1));
      if (!usable()) return jsonResponse(res, 409, { error: 'voice_off' });   // disabled while the agent list was read
      let r;
      try { r = await client.tts(text, pick, speed, { isCancelled, gen: admitted }); }
      catch (e) {
        if (answerClientError(e)) return;
        console.error('[voice] tts failed:', e.message); return jsonResponse(res, 500, { error: 'speech synthesis failed' });
      }
      console.log(`[voice] tts ${text.length} chars, voice ${pick}, ${r.ms} ms`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': r.wav.length, 'X-Voice-Ms': String(r.ms), 'X-Voice': pick, 'Cache-Control': 'no-store' });
      return res.end(r.wav);
    }

    // Agents "on a call" (lib/voice/call): the page starts a call, sends a heartbeat every 15 s, and ends it. Only the person
    // who started it may change it (admins too). server.js has already checked that the caller may use the agent.
    if (pathname === '/api/voice/call' || pathname === '/api/voice/call/decide') {
      if (method !== 'POST') { drain(); return jsonResponse(res, 405, { error: 'method_not_allowed' }); }
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const agent = String(b.agent || '');
      if (!agent) return jsonResponse(res, 400, { error: 'agent_required' });
      const calls = deps.voiceCall || require('./call');
      const userId = req.hubUser ? String(req.hubUser.id) : (req.hubService ? 'service' : 'owner');
      const person = (req.hubUser && (req.hubUser.name || req.hubUser.id)) || 'the owner';
      const refuse = (r) => jsonResponse(res, r.error === 'not_your_call' ? 403 : (r.error === 'no_call' ? 409 : 400), { error: r.error });
      if (pathname === '/api/voice/call/decide') {
        const r = calls.decide(agent, userId, String(b.id || ''), b.choice);
        if (r.error) return r.error === 'unknown_item' ? jsonResponse(res, 404, { error: r.error }) : refuse(r);
        return jsonResponse(res, 200, { ok: true, choice: r.choice, call: calls.statusOf(agent) });
      }
      const action = String(b.action || '');
      if (action === 'start') {
        if (b.mode !== undefined && !(calls.MODES || require('./call').MODES).includes(b.mode)) return jsonResponse(res, 400, { error: 'bad_mode' });
        const r = calls.start(agent, { userId, person, mode: b.mode });
        return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: r });
      }
      if (action === 'heartbeat') { const r = calls.heartbeat(agent, userId); return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: r }); }
      if (action === 'mode') { const r = calls.setMode(agent, userId, b.mode); return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: r }); }
      if (action === 'end') { const r = calls.end(agent, userId); return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: null, held: r.held }); }
      return jsonResponse(res, 400, { error: 'unknown_action' });
    }

    const web = pathname.match(/^\/api\/voice\/web\/([^/]+)$/);
    if (web && method === 'GET') {
      let name; try { name = decodeURIComponent(web[1]); } catch { name = ''; }
      if (!Object.prototype.hasOwnProperty.call(manifest.WEB_FILES, name)) return jsonResponse(res, 404, { error: 'not_found' });
      const file = require('path').join(engine.paths.web, name);
      let st; try { st = fs.statSync(file); } catch { return jsonResponse(res, 404, { error: 'not_found' }); }
      if (!st.isFile()) return jsonResponse(res, 404, { error: 'not_found' });
      res.writeHead(200, { 'Content-Type': manifest.WEB_FILES[name].type, 'Content-Length': st.size, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      const stream = fs.createReadStream(file);
      stream.on('error', () => { try { res.destroy(); } catch {} });
      return stream.pipe(res);
    }

    if (pathname.startsWith('/api/voice/')) {
      const known = ['/api/voice/status', '/api/voice/enable', '/api/voice/disable', '/api/voice/stt', '/api/voice/tts', '/api/voice/call', '/api/voice/call/decide'];
      return jsonResponse(res, known.includes(pathname) ? 405 : 404, { error: known.includes(pathname) ? 'method_not_allowed' : 'not_found' });
    }
    return jsonResponse(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('[voice] route error:', e.message);
    if (!res.headersSent) return jsonResponse(res, 500, { error: 'voice error' });
    try { res.end(); } catch {}
  }
}

/**
 * After a hub restart in the middle of the download the setting says enabled but nothing is installing: start the install
 * again. Never throws. deps: { getSetting, getVoice?, log? }
 */
function resumeIfNeeded({ getSetting, getVoice: gv, log } = {}) {
  const say = typeof log === 'function' ? log : () => {};
  try {
    const v = manifest.cleanVoiceSettings({}, getSetting('voice'));
    if (!v.enabled) return false;
    const { engine } = (gv || getVoice)();
    const st = engine.status();
    if (st.ready || st.installing) return false;
    say('[voice] resuming the interrupted voice setup');
    Promise.resolve(engine.install({ sttModel: v.sttModel || undefined })).catch((e) => say(`[voice] resume failed: ${e && e.message}`));
    return true;
  } catch (e) { try { say(`[voice] resume failed: ${e && e.message}`); } catch {} return false; }
}

module.exports = { handle, getVoice, resumeIfNeeded, MAX_AUDIO_BYTES, MAX_TTS_CHARS };
