'use strict';

// lib/voice/cloud.js: the optional cloud speech engines (OpenAI, Google Gemini, ElevenLabs). The free local engine stays the
// default; the routes (lib/voice/routes.js) call this first only when an agent's voice setting asks for a cloud engine, and
// fall back to the local engine on ANY failure. Every call has a 15 s timeout and one attempt. Keys come from Settings ->
// providers and are never logged or returned. Nothing here writes audio or text anywhere: the ledger row holds no text.
// All network goes through the injected fetchImpl, so tests use a fake and never reach a real service.

// ── One table: models and base URLs (change them here) ──
const MODELS = {
  openai: { stt: 'gpt-4o-mini-transcribe', tts: 'gpt-4o-mini-tts' },
  google: { stt: 'gemini-2.5-flash', tts: 'gemini-2.5-flash-preview-tts' },
  elevenlabs: { tts: 'eleven_flash_v2_5' },
};
const BASES = {
  openai: 'https://api.openai.com/v1',   // the real value comes from getProviderUrl('openai') so a test copy can point elsewhere
  google: 'https://generativelanguage.googleapis.com/v1beta',
  elevenlabs: 'https://api.elevenlabs.io/v1',
};
const TIMEOUT_MS = 15000;
const STT_ENGINES = ['local', 'openai', 'google'];
const TTS_ENGINES = ['local', 'openai', 'google', 'elevenlabs'];
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const GOOGLE_VOICES = ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'];
const ELEVENLABS_VOICE_RE = /^[A-Za-z0-9]{10,40}$/;
const DEFAULT_CLOUD_VOICE = { openai: 'coral', google: 'Kore' };
const GOOGLE_STT_PROMPT = 'Transcribe this audio exactly. Reply with the words only.';

// List-price ESTIMATES in US dollars, to adjust when the providers change their prices. The ledger stores them as the
// reported cost. TTS: per 1,000 characters of text. STT: per minute of audio.
const PRICES = {
  openai: { stt: 0.003, tts: 0.015 },        // estimate: gpt-4o-mini-transcribe about $0.003/min; gpt-4o-mini-tts about $0.015/1k characters
  google: { stt: 0.002, tts: 0.02 },         // estimate: Gemini 2.5 Flash audio input; Gemini TTS output audio
  elevenlabs: { tts: 0.05 },                 // estimate: Flash v2.5 about $0.05/1k characters
};

class CloudError extends Error { constructor(reason, detail) { super(detail || reason); this.reason = reason; } }

/** A canonical 44-byte-header WAV around 16-bit little-endian mono PCM. */
function wavFromPcm16(pcm, rate = 24000, channels = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Sample rate and seconds of a WAV buffer (falls back to 16 kHz mono 16-bit when the header is not canonical). */
function wavInfo(buf) {
  let rate = 16000, channels = 1;
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    rate = buf.readUInt32LE(24) || rate; channels = buf.readUInt16LE(22) || 1;
  }
  const seconds = Math.max(0, buf.length - 44) / (rate * channels * 2);
  return { rate, seconds };
}

function isWav(buf) { return Buffer.isBuffer(buf) && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE'; }

function cloudVoiceFor(engine, cloudVoice) {
  if (engine === 'openai') return OPENAI_VOICES.includes(cloudVoice) ? cloudVoice : DEFAULT_CLOUD_VOICE.openai;
  if (engine === 'google') return GOOGLE_VOICES.includes(cloudVoice) ? cloudVoice : DEFAULT_CLOUD_VOICE.google;
  return typeof cloudVoice === 'string' ? cloudVoice : '';
}

/**
 * createCloudVoice({ fetchImpl, getProviderKey, getProviderUrl, getLedger, now, bases, timeoutMs }) -> { stt, tts, hasKey, keys }
 *   stt(agentName, engine, wavBuffer) -> { text, ms, engine }
 *   tts(agentName, engine, text, cloudVoice, speed) -> { wav, sampleRate, ms, engine }
 * Both throw CloudError (reason: no_key | timeout | http_<status> | bad_response | bad_engine | bad_voice) and, for a call that
 * was actually made, record one ledger row (ok true with the estimated cost, or ok false with cost 0).
 */
function createCloudVoice({ fetchImpl = (...a) => fetch(...a), getProviderKey, getProviderUrl = () => '', getLedger, now = () => Date.now(), bases = {}, timeoutMs = TIMEOUT_MS } = {}) {
  const keyOf = (engine) => { try { return String((getProviderKey && getProviderKey(engine)) || ''); } catch { return ''; } };
  const base = (engine) => {
    if (bases[engine]) return String(bases[engine]).replace(/\/+$/, '');
    if (engine === 'openai') { let u = ''; try { u = getProviderUrl('openai') || ''; } catch {} return String(u || BASES.openai).replace(/\/+$/, ''); }
    return BASES[engine];
  };
  const ledger = () => { try { return getLedger ? getLedger() : require('../sdk-chat').getLedger(); } catch { return null; } };
  const record = (agent, model, costUsd, durationMs, ok) => { try { const l = ledger(); if (l) l.record({ agent, origin: 'voice', model, costUsd, durationMs, ok }); } catch {} };
  const hasKey = (engine) => !!keyOf(engine);
  const keys = () => ({ openai: hasKey('openai'), google: hasKey('google'), elevenlabs: hasKey('elevenlabs') });

  async function post(url, { headers, body }) {
    let r;
    try { r = await fetchImpl(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) }); }
    catch (e) {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new CloudError('timeout');
      throw new CloudError('network');
    }
    if (!r || !r.ok) throw new CloudError(`http_${r && r.status ? r.status : 0}`);
    return r;
  }
  const readJson = async (r) => { try { return await r.json(); } catch { throw new CloudError('bad_response'); } };
  const readBytes = async (r) => { try { return Buffer.from(await r.arrayBuffer()); } catch { throw new CloudError('bad_response'); } };
  const partsOf = (j) => (((((j || {}).candidates || [])[0] || {}).content || {}).parts) || [];

  // Runs one engine call with the key check and the ledger row around it. fn(key) -> result; model -> ledger model; cost(result) -> USD.
  async function run(agent, engine, kind, fn, cost) {
    const model = `${engine}/${(MODELS[engine] || {})[kind]}`;
    const key = keyOf(engine);
    if (!key) throw new CloudError('no_key');
    const t0 = now();
    let out;
    try { out = await fn(key); }
    catch (e) { record(agent, model, 0, now() - t0, false); throw e instanceof CloudError ? e : new CloudError('bad_response'); }
    const ms = now() - t0;
    record(agent, model, cost(out), ms, true);
    return { ...out, ms, engine };
  }

  async function stt(agent, engine, wav) {
    if (!['openai', 'google'].includes(engine)) throw new CloudError('bad_engine');
    const mins = wavInfo(wav).seconds / 60;
    const price = (PRICES[engine].stt || 0) * mins;
    if (engine === 'openai') {
      return run(agent, engine, 'stt', async (key) => {
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', MODELS.openai.stt);
        const r = await post(`${base('openai')}/audio/transcriptions`, { headers: { Authorization: `Bearer ${key}` }, body: form });
        const j = await readJson(r);
        if (!j || typeof j.text !== 'string') throw new CloudError('bad_response');
        return { text: j.text.trim() };
      }, () => price);
    }
    return run(agent, engine, 'stt', async (key) => {
      const body = { contents: [{ parts: [{ text: GOOGLE_STT_PROMPT }, { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }] }] };
      const r = await post(`${base('google')}/models/${encodeURIComponent(MODELS.google.stt)}:generateContent`, { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
      const j = await readJson(r);
      const parts = partsOf(j);
      if (!parts.length) throw new CloudError('bad_response');
      return { text: parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim() };
    }, () => price);
  }

  async function tts(agent, engine, text, cloudVoice /* , speed: the cloud engines are asked for normal speed */) {
    if (!['openai', 'google', 'elevenlabs'].includes(engine)) throw new CloudError('bad_engine');
    const price = (PRICES[engine].tts || 0) * (String(text).length / 1000);
    if (engine === 'openai') {
      return run(agent, engine, 'tts', async (key) => {
        const r = await post(`${base('openai')}/audio/speech`, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODELS.openai.tts, voice: cloudVoiceFor('openai', cloudVoice), input: text, response_format: 'wav' }) });
        const wav = await readBytes(r);
        if (!isWav(wav)) throw new CloudError('bad_response');
        return { wav, sampleRate: wav.readUInt32LE(24) };
      }, () => price);
    }
    if (engine === 'google') {
      return run(agent, engine, 'tts', async (key) => {
        const body = { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cloudVoiceFor('google', cloudVoice) } } } } };
        const r = await post(`${base('google')}/models/${encodeURIComponent(MODELS.google.tts)}:generateContent`, { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
        const j = await readJson(r);
        const part = partsOf(j).find(p => (p.inlineData || p.inline_data));
        const inline = part && (part.inlineData || part.inline_data);
        if (!inline || typeof inline.data !== 'string') throw new CloudError('bad_response');
        const pcm = Buffer.from(inline.data, 'base64');
        if (pcm.length < 2) throw new CloudError('bad_response');
        const m = /rate=(\d{4,6})/.exec(String(inline.mimeType || inline.mime_type || ''));
        const rate = m ? Number(m[1]) : 24000;
        return { wav: wavFromPcm16(pcm.subarray(0, pcm.length - (pcm.length % 2)), rate), sampleRate: rate };
      }, () => price);
    }
    // elevenlabs
    if (!ELEVENLABS_VOICE_RE.test(String(cloudVoice || ''))) throw new CloudError('bad_voice');
    return run(agent, engine, 'tts', async (key) => {
      const r = await post(`${base('elevenlabs')}/text-to-speech/${cloudVoice}?output_format=pcm_24000`, { headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: MODELS.elevenlabs.tts }) });
      const pcm = await readBytes(r);
      if (pcm.length < 2) throw new CloudError('bad_response');
      return { wav: wavFromPcm16(pcm.subarray(0, pcm.length - (pcm.length % 2)), 24000), sampleRate: 24000 };
    }, () => price);
  }

  return { stt, tts, hasKey, keys };
}

/**
 * Is this agent "kept on this computer"? Its folder grants include the medical/ or legal/ team folder, or its name is in the
 * hub's keep-on-box list (settings.autoClassifier.keepOnBox, the same list the classifier honours). getSetting is injectable.
 */
function keptOnBox(agent, getSetting) {
  if (!agent) return false;
  try { if (require('../tool-policy').teamFolderOf(agent)) return true; } catch {}
  try {
    const gs = getSetting || require('../settings').getSetting;
    const s = gs('autoClassifier') || {};
    return Array.isArray(s.keepOnBox) && s.keepOnBox.map(String).includes(String(agent.name));
  } catch { return false; }
}

module.exports = {
  createCloudVoice, wavFromPcm16, wavInfo, keptOnBox, CloudError,
  MODELS, BASES, PRICES, TIMEOUT_MS, STT_ENGINES, TTS_ENGINES, OPENAI_VOICES, GOOGLE_VOICES, ELEVENLABS_VOICE_RE, DEFAULT_CLOUD_VOICE, GOOGLE_STT_PROMPT,
};
