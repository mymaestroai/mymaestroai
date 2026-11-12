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
  const status = () => ({ ...engine.status(), enabled: settingsVoice().enabled });
  const usable = () => settingsVoice().enabled && engine.status().ready;
  const drain = () => { try { req.resume(); } catch {} };

  try {
    if (pathname === '/api/voice/status' && method === 'GET') return jsonResponse(res, 200, status());

    if (pathname === '/api/voice/enable' && method === 'POST') {
      drain();
      if (!isAdmin(req)) return jsonResponse(res, 403, { error: 'admin_only' });
      if (!engine.status().platformSupported) return jsonResponse(res, 400, { error: 'platform_unsupported' });
      const cur = settingsVoice();
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
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > maxAudio) { drain(); return jsonResponse(res, 413, { error: `audio is larger than ${Math.round(maxAudio / 1048576)} MB` }); }
      const chunks = []; let size = 0; let tooBig = false;
      await new Promise((resolve, reject) => {
        req.on('data', (c) => { if (tooBig) return; size += c.length; if (size > maxAudio) { tooBig = true; chunks.length = 0; } else chunks.push(c); });
        req.on('end', resolve); req.on('error', reject); req.on('aborted', () => reject(new Error('upload aborted')));
      });
      if (tooBig) return jsonResponse(res, 413, { error: `audio is larger than ${Math.round(maxAudio / 1048576)} MB` });
      if (!size) return jsonResponse(res, 400, { error: 'empty audio' });
      let r;
      try { r = await client.stt(Buffer.concat(chunks)); }
      catch (e) {
        if (e && e.badAudio) return jsonResponse(res, 400, { error: e.message });
        console.error('[voice] stt failed:', e.message);
        return jsonResponse(res, 500, { error: 'speech recognition failed' });
      }
      console.log(`[voice] stt ${size} bytes in ${r.ms} ms`);
      return jsonResponse(res, 200, { text: r.text, ms: r.ms });
    }

    if (pathname === '/api/voice/tts' && method === 'POST') {
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
      const pick = [b.voice, agentVoice, settingsVoice().defaultVoice, st.tts.defaultVoice, manifest.DEFAULT_VOICE].find(v => v && installed.has(v));
      if (!pick) return jsonResponse(res, 409, { error: 'voice_off' });
      const speed = Math.max(0.5, Math.min(2, Number(b.speed) || 1));
      let r;
      try { r = await client.tts(text, pick, speed); }
      catch (e) { console.error('[voice] tts failed:', e.message); return jsonResponse(res, 500, { error: 'speech synthesis failed' }); }
      console.log(`[voice] tts ${text.length} chars, voice ${pick}, ${r.ms} ms`);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': r.wav.length, 'X-Voice-Ms': String(r.ms), 'X-Voice': pick, 'Cache-Control': 'no-store' });
      return res.end(r.wav);
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
      const known = ['/api/voice/status', '/api/voice/enable', '/api/voice/disable', '/api/voice/stt', '/api/voice/tts'];
      return jsonResponse(res, known.includes(pathname) ? 405 : 404, { error: known.includes(pathname) ? 'method_not_allowed' : 'not_found' });
    }
    return jsonResponse(res, 404, { error: 'not_found' });
  } catch (e) {
    console.error('[voice] route error:', e.message);
    if (!res.headersSent) return jsonResponse(res, 500, { error: 'voice error' });
    try { res.end(); } catch {}
  }
}

module.exports = { handle, getVoice, MAX_AUDIO_BYTES, MAX_TTS_CHARS };
