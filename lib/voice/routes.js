'use strict';

// lib/voice/routes.js: the /api/voice/* HTTP surface. server.js has already identified the caller and applied the access
// table (lib/access): status and web files are session routes, stt/tts are agent routes (the caller must be allowed that
// agent), enable/disable are admin-only. The handler checks admin again for enable/disable (defence in depth).
// Nothing here logs audio or text.

const fs = require('fs');
const manifest = require('./manifest');
const cloudMod = require('./cloud');

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

let cloudSingleton = null;
/** The process-wide cloud engines (keys read from Settings at each call; nothing is created until the first use). */
function getCloud() {
  if (cloudSingleton) return cloudSingleton;
  const hubSettings = require('../settings');
  cloudSingleton = cloudMod.createCloudVoice({ getProviderKey: hubSettings.getProviderKey, getProviderUrl: hubSettings.getProviderUrl });
  return cloudSingleton;
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
  // ── Cloud engines (lib/voice/cloud): chosen per agent, always with the local engine as the fallback ──
  const cloud = () => deps.cloud || getCloud();
  const agentRecord = async (name) => { try { return (await getAgents()).find(x => x.name === name) || null; } catch { return null; } };
  /**
   * The engine for this agent and kind ('stt' | 'tts'): its chosen cloud engine, or 'local'. A cloud choice is ignored (served
   * locally) for an agent kept on this computer unless the owner confirmed it, even if the stored setting says otherwise
   * (for example an agent moved into medical/ after a cloud engine was chosen).
   */
  const engineFor = (rec, kind) => {
    const v = rec && rec.voice;
    const e = v && v[kind];
    if (!e || e === 'local' || !(kind === 'stt' ? cloudMod.STT_ENGINES : cloudMod.TTS_ENGINES).includes(e)) return 'local';
    if (cloudMod.keptOnBox(rec, getSetting) && !v.cloudConfirmedBy) return 'local';
    return e;
  };
  // The short, safe reason a cloud call failed (a code, never a message that could carry a key, text or audio).
  const failReason = (e) => String((e && e.reason) || 'failed').replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'failed';
  const sendJson = (code, data, headers = {}) => { const body = JSON.stringify(data); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers }); res.end(body); };
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
    if (pathname === '/api/voice/status' && method === 'GET') {
      // Which cloud engines have a key: booleans only, and only for admins (members get {}).
      let cl = {}; if (isAdmin(req)) { try { cl = cloud().keys(); } catch { cl = { openai: false, google: false, elevenlabs: false }; } }
      return jsonResponse(res, 200, { ...status(), cloud: cl });
    }

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
      if (!settingsVoice().enabled) { drain(); return jsonResponse(res, 409, { error: 'voice_off' }); }
      const rec = await agentRecord(agent);
      const cloudEngine = engineFor(rec, 'stt');   // 'local' unless the agent chose a cloud engine and may use it
      if (cloudEngine === 'local' && !usable()) { drain(); return jsonResponse(res, 409, { error: 'voice_off' }); }
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
      if (!settingsVoice().enabled || (cloudEngine === 'local' && !usable())) return jsonResponse(res, 409, { error: 'voice_off' });   // disabled while the upload was coming in
      const audio = Buffer.concat(chunks);
      let fallback = '';
      if (cloudEngine !== 'local') {
        try {
          const c = await cloud().stt(agent, cloudEngine, audio, { isCancelled });
          console.log(`[voice] stt ${size} bytes in ${c.ms} ms (${c.engine})`);
          return sendJson(200, { text: c.text, ms: c.ms, engine: c.engine }, { 'X-Voice-Engine': c.engine });
        } catch (e) {
          fallback = failReason(e);
          if (usable()) console.log(`[voice] ${cloudEngine} stt failed (${fallback}): using the local engine`);
          else { console.log(`[voice] ${cloudEngine} stt failed (${fallback}): no local engine to fall back to`); return sendJson(503, { error: 'voice_unavailable' }, { 'X-Voice-Fallback': fallback }); }
        }
      }
      let r;
      try { r = await client.stt(audio, undefined, { isCancelled, gen: admitted }); }
      catch (e) {
        if (answerClientError(e)) return;
        if (e && e.badAudio) return jsonResponse(res, 400, { error: e.message });
        console.error('[voice] stt failed:', e.message);
        return jsonResponse(res, 500, { error: 'speech recognition failed' });
      }
      console.log(`[voice] stt ${size} bytes in ${r.ms} ms`);
      return sendJson(200, { text: r.text, ms: r.ms, engine: 'local' }, { 'X-Voice-Engine': 'local', ...(fallback ? { 'X-Voice-Fallback': fallback } : {}) });
    }

    if (pathname === '/api/voice/tts' && method === 'POST') {
      const admitted = clientGen();   // as for stt: a Disable while this request waits refuses it
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const agent = String(b.agent || '');
      if (!agent) return jsonResponse(res, 400, { error: 'agent_required' });
      const rawText = typeof b.text === 'string' ? b.text : '';
      if (!rawText.trim()) return jsonResponse(res, 400, { error: 'text_required' });
      if (rawText.length > MAX_TTS_CHARS) return jsonResponse(res, 413, { error: `text is longer than ${MAX_TTS_CHARS} characters` });
      // Safety net: whatever the caller sent, no markdown or symbols reach any engine. The pages send text their cleaner (the
      // same function) already cleaned; it is cleaned again only when markup or symbols are left in it, so a clean sentence
      // such as "42. That is the answer." is never read as a list item and cut.
      const MARKUP = /[*_#|`~<>[\]{}\\/^=@&%+]|https?:|www\.|[\u2010-\u2015\u2190-\u2BFF\u2022\u00B7\u2212]|\p{Extended_Pictographic}|^\s*[-*+]\s/mu;
      const text = MARKUP.test(rawText) ? require('../ui-voice').voiceSpeechText(rawText) : rawText.replace(/\s+/g, ' ').trim();
      if (!text.trim()) return jsonResponse(res, 400, { error: 'nothing_to_say' });
      if (b.voice !== undefined && b.voice !== '' && !manifest.VOICE_IDS.includes(b.voice)) return jsonResponse(res, 400, { error: 'unknown_voice' });
      if (!settingsVoice().enabled) return jsonResponse(res, 409, { error: 'voice_off' });
      const rec = await agentRecord(agent);
      const cloudEngine = engineFor(rec, 'tts');
      const speed = Math.max(0.5, Math.min(2, Number(b.speed) || 1));
      let fallback = '';
      if (cloudEngine !== 'local') {
        try {
          const c = await cloud().tts(agent, cloudEngine, text, rec.voice.cloudVoice, speed, { isCancelled });
          console.log(`[voice] tts ${text.length} chars, ${c.engine}, ${c.ms} ms`);
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': c.wav.length, 'X-Voice-Ms': String(c.ms), 'X-Voice-Engine': c.engine, 'Cache-Control': 'no-store' });
          return res.end(c.wav);
        } catch (e) {
          fallback = failReason(e);
          if (usable()) console.log(`[voice] ${cloudEngine} tts failed (${fallback}): using the local engine`);
          else { console.log(`[voice] ${cloudEngine} tts failed (${fallback}): no local engine to fall back to`); return sendJson(503, { error: 'voice_unavailable' }, { 'X-Voice-Fallback': fallback }); }
        }
      }
      if (!usable()) return jsonResponse(res, 409, { error: 'voice_off' });
      const st = engine.status();
      const installed = new Set(st.voices.map(v => v.id));
      const agentVoice = (rec && rec.voice && rec.voice.voice) || '';
      const pick = [b.voice, agentVoice, effectiveDefault(st), manifest.DEFAULT_VOICE].find(v => v && installed.has(v));
      if (!pick) return jsonResponse(res, 409, { error: 'voice_off' });
      if (!usable()) return jsonResponse(res, 409, { error: 'voice_off' });   // disabled while the agent list was read
      let r;
      try { r = await client.tts(text, pick, speed, { isCancelled, gen: admitted }); }
      catch (e) {
        if (answerClientError(e)) return;
        console.error('[voice] tts failed:', e.message); return jsonResponse(res, 500, { error: 'speech synthesis failed' });
      }
      console.log(`[voice] tts ${text.length} chars, voice ${pick}, ${r.ms} ms`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': r.wav.length, 'X-Voice-Ms': String(r.ms), 'X-Voice': pick, 'X-Voice-Engine': 'local', ...(fallback ? { 'X-Voice-Fallback': fallback } : {}), 'Cache-Control': 'no-store' });
      return res.end(r.wav);
    }

    // Agents "on a call" (lib/voice/call): the page starts a call, sends a heartbeat every 15 s, and ends it. Only the person
    // who started it may heartbeat it; an admin may also end, decide and change the mode of any call. A request naming a call id that is not the current call's gets 409 stale_call. server.js has already checked that the caller may use the agent.
    if (pathname === '/api/voice/call' || pathname === '/api/voice/call/decide') {
      if (method !== 'POST') { drain(); return jsonResponse(res, 405, { error: 'method_not_allowed' }); }
      let b;
      try { b = JSON.parse((await readBody(req)) || '{}') || {}; } catch { return jsonResponse(res, 400, { error: 'invalid JSON' }); }
      const agent = String(b.agent || '');
      if (!agent) return jsonResponse(res, 400, { error: 'agent_required' });
      const calls = deps.voiceCall || require('./call');
      const userId = req.hubUser ? String(req.hubUser.id) : (req.hubService ? 'service' : 'owner');
      const person = (req.hubUser && (req.hubUser.name || req.hubUser.id)) || 'the owner';
      const refuse = (r) => jsonResponse(res, r.error === 'not_your_call' ? 403 : (['no_call', 'stale_call', 'cannot_skip'].includes(r.error) ? 409 : 400), { error: r.error });
      // The call this request is about (absent: whatever call is current, for older pages). A call of an older id is refused.
      const callId = b.callId === undefined || b.callId === null ? undefined : String(b.callId);
      // An admin may end, decide and change the mode of any call (not heartbeat or start it).
      const admin = { admin: isAdmin(req) };
      if (pathname === '/api/voice/call/decide') {
        const r = await calls.decide(agent, userId, String(b.id || ''), b.choice, callId, admin);
        if (r.error) return r.error === 'unknown_item' ? jsonResponse(res, 404, { error: r.error }) : refuse(r);
        return jsonResponse(res, 200, { ok: true, choice: r.choice, call: calls.statusOf(agent) });
      }
      const action = String(b.action || '');
      if (action === 'start') {
        if (b.mode !== undefined && !(calls.MODES || require('./call').MODES).includes(b.mode)) return jsonResponse(res, 400, { error: 'bad_mode' });
        const r = calls.start(agent, { userId, person, mode: b.mode });
        return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: r });
      }
      if (action === 'heartbeat') { const r = calls.heartbeat(agent, userId, callId); return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: r }); }
      if (action === 'mode') { const r = calls.setMode(agent, userId, b.mode, callId, admin); return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, call: r }); }
      if (action === 'end') { const r = calls.end(agent, userId, callId, admin); return r.error ? refuse(r) : jsonResponse(res, 200, { ok: true, held: r.held }); }
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
