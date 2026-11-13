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

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;       // the routes' upload maximum
const MAX_CLOUD_AUDIO = 8 * 1024 * 1024;        // the most audio read back from a cloud engine
const MAX_CLOUD_JSON = 1024 * 1024;             // the most JSON read back (STT answers)
const MIN_AUDIO_SECONDS = 0.05;
const GOOGLE_TTS_JSON_CAP = Math.ceil(MAX_CLOUD_AUDIO * 4 / 3) + 65536;   // Gemini TTS returns the audio as base64 inside the JSON
const MAX_STT_SECONDS = MAX_AUDIO_BYTES / (16000 * 2);   // the 10 MB maximum at 16 kHz mono 16-bit: one call's priced duration never exceeds it

/** Walks a RIFF/WAVE buffer: { ok, format, channels, rate, bits, dataOffset, dataSize (declared), dataAvail (in the buffer) }. */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return { ok: false };
  let fmt = null, off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4), body = off + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buf.length) return { ok: false };
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) return { ok: false };
      return { ok: true, ...fmt, dataOffset: body, dataSize: size, dataAvail: buf.length - body };
    }
    off = body + size + (size % 2);
  }
  return { ok: false };
}

/** Rate and seconds of the audio actually in a WAV buffer (rate clamped to 8000-48000, channels to 1-2; 16 kHz mono 16-bit when it does not parse). */
function wavInfo(buf) {
  const w = parseWav(buf);
  let rate = 16000, channels = 1, bytes = Math.max(0, buf.length - 44);
  if (w.ok) {
    rate = Math.min(48000, Math.max(8000, w.rate || 16000)); channels = Math.min(2, Math.max(1, w.channels || 1));
    bytes = Math.min(w.dataSize, w.dataAvail);
  }
  return { rate, seconds: Math.min(MAX_STT_SECONDS, bytes / (rate * channels * 2)) };
}

/** Is this a playable OpenAI answer? 16-bit PCM WAV, 1-2 channels, 8-48 kHz, a data chunk that fits, at least 0.05 s. */
function validWav(buf) {
  const w = parseWav(buf);
  if (!w.ok || w.format !== 1 || w.bits !== 16 || w.channels < 1 || w.channels > 2 || w.rate < 8000 || w.rate > 48000) return null;
  // Streamed WAVs (OpenAI's included) carry placeholder sizes (0xFFFFFFFF): the data then runs to the end of the buffer.
  const frame = w.channels * 2;
  let len = Math.min(w.dataSize, w.dataAvail);
  len -= len % frame;
  if (len / (w.rate * frame) < MIN_AUDIO_SECONDS) return null;
  let wav = buf;
  if (len !== w.dataSize || buf.readUInt32LE(4) !== w.dataOffset + len - 8) {
    // a copy with the real sizes, so every browser's decoder accepts it
    wav = Buffer.from(buf.subarray(0, w.dataOffset + len));
    wav.writeUInt32LE(wav.length - 8, 4);
    wav.writeUInt32LE(len, w.dataOffset - 4);
  }
  return { ...w, dataSize: len, wav };
}

function cloudVoiceFor(engine, cloudVoice) {
  if (engine === 'openai') return OPENAI_VOICES.includes(cloudVoice) ? cloudVoice : DEFAULT_CLOUD_VOICE.openai;
  if (engine === 'google') return GOOGLE_VOICES.includes(cloudVoice) ? cloudVoice : DEFAULT_CLOUD_VOICE.google;
  return typeof cloudVoice === 'string' ? cloudVoice : '';
}

/**
 * createCloudVoice({ fetchImpl, getProviderKey, getProviderUrl, getLedger, now, bases, timeoutMs }) -> { stt, tts, hasKey, keys }
 *   stt(agentName, engine, wavBuffer) -> { text, ms, engine }
 *   tts(agentName, engine, text, cloudVoice, speed) -> { wav, sampleRate, ms, engine }
 * Both throw CloudError (reason: no_key | timeout | http_<status> | bad_response | bad_audio | too_large | cancelled | bad_engine | bad_voice) and, for a call that
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

  // One call's abort context: the timeout and the caller's isCancelled (polled) both abort the request and the body read.
  function makeCtx(isCancelled) {
    const ctl = new AbortController();
    const ctx = { cancelled: false, timedOut: false, signal: ctl.signal, abort: () => { try { ctl.abort(); } catch {} }, timer: null, timeoutTimer: null };
    // The 15 s limit covers the request and the body read; the timer is cleared when the call ends.
    ctx.timeoutTimer = setTimeout(() => { ctx.timedOut = true; try { ctl.abort(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); } catch {} }, timeoutMs);
    if (typeof isCancelled === 'function') {
      const check = () => { let c = false; try { c = !!isCancelled(); } catch {} if (c && !ctx.cancelled) { ctx.cancelled = true; ctx.abort(); } return c; };
      ctx.check = check;
      ctx.timer = setInterval(check, 100); if (ctx.timer.unref) ctx.timer.unref();
    }
    ctx.done = () => { if (ctx.timer) clearInterval(ctx.timer); clearTimeout(ctx.timeoutTimer); };
    return ctx;
  }
  // What an aborted fetch or body read means: the caller left, the 15 s ran out, or (otherwise) the given reason.
  const abortReason = (ctx, e, otherwise) => {
    if (ctx.cancelled) return new CloudError('cancelled');
    if (ctx.timedOut || (e && e.name === 'TimeoutError')) return new CloudError('timeout');
    if (e && e.name === 'AbortError') return new CloudError('timeout');
    return new CloudError(otherwise);
  };
  async function post(url, { headers, body }, ctx) {
    let r;
    try { r = await fetchImpl(url, { method: 'POST', headers, body, signal: ctx.signal }); }
    catch (e) {
      const a = abortReason(ctx, e, 'network'); throw a;
    }
    if (!r || !r.ok) { ctx.abort(); throw new CloudError(`http_${r && r.status ? r.status : 0}`); }   // a hanging error body is not kept open
    return r;
  }
  const lengthOf = (r) => { try { const v = r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : null; return v === null || v === undefined || v === '' ? NaN : Number(v); } catch { return NaN; } };
  // Reads the whole body with a byte cap: content-length precheck, then a running total; over the cap aborts the request.
  async function readCapped(r, cap, ctx) {
    if (lengthOf(r) > cap) { ctx.abort(); throw new CloudError('too_large'); }
    try {
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader(); const chunks = []; let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > cap) { try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {} ctx.abort(); throw new CloudError('too_large'); }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
        return Buffer.concat(chunks);
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > cap) { ctx.abort(); throw new CloudError('too_large'); }
      return buf;
    } catch (e) {
      if (e instanceof CloudError) throw e;
      throw abortReason(ctx, e, 'bad_response');
    }
  }
  const readBytes = (r, ctx) => readCapped(r, MAX_CLOUD_AUDIO, ctx);
  const readJson = async (r, ctx, cap = MAX_CLOUD_JSON) => {
    // A response object without a stream (a test double) is read through json() after the length precheck.
    if (!(r.body && typeof r.body.getReader === 'function') && typeof r.json === 'function' && typeof r.arrayBuffer !== 'function') {
      if (lengthOf(r) > cap) throw new CloudError('too_large');
      try { return await r.json(); } catch (e) { throw abortReason(ctx, e, 'bad_response'); }
    }
    const buf = await readCapped(r, cap, ctx);
    try { return JSON.parse(buf.toString('utf8')); } catch { throw new CloudError('bad_response'); }
  };
  const partsOf = (j) => (((((j || {}).candidates || [])[0] || {}).content || {}).parts) || [];

  // Runs one engine call with the key check and the ledger row around it. fn(key) -> result; model -> ledger model; cost(result) -> USD.
  async function run(agent, engine, kind, fn, cost, opts = {}) {
    const model = `${engine}/${(MODELS[engine] || {})[kind]}`;
    const key = keyOf(engine);
    if (!key) throw new CloudError('no_key');
    const ctx = makeCtx(opts.isCancelled);
    if (ctx.check && ctx.check()) { ctx.done(); throw new CloudError('cancelled'); }   // the caller already left: nothing is sent
    const t0 = now();
    let out;
    try { out = await fn(key, ctx); }
    catch (e) {
      const err = e instanceof CloudError ? e : abortReason(ctx, e, 'bad_response');
      ctx.abort(); ctx.done();   // nothing of this request is still open
      // The provider answered (and billed) but the answer was unusable: its estimated cost still counts.
      let billed = 0;
      if (err.reason === 'bad_audio' || err.reason === 'too_large' || err.reason === 'bad_response') { try { billed = Number(cost(null)) || 0; } catch {} }
      record(agent, model, billed, now() - t0, false);
      throw err;
    }
    ctx.done();
    const ms = now() - t0;
    record(agent, model, cost(out), ms, true);
    return { ...out, ms, engine };
  }

  async function stt(agent, engine, wav, opts = {}) {
    if (!['openai', 'google'].includes(engine)) throw new CloudError('bad_engine');
    const mins = wavInfo(wav).seconds / 60;   // the audio really sent (rate and channels clamped, capped at the 10 MB maximum), never the header's claim
    const price = (PRICES[engine].stt || 0) * mins;
    if (engine === 'openai') {
      return run(agent, engine, 'stt', async (key, ctx) => {
        const form = new FormData();
        form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
        form.append('model', MODELS.openai.stt);
        const r = await post(`${base('openai')}/audio/transcriptions`, { headers: { Authorization: `Bearer ${key}` }, body: form }, ctx);
        const j = await readJson(r, ctx);
        if (!j || typeof j.text !== 'string') throw new CloudError('bad_response');
        return { text: j.text.trim() };
      }, () => price, opts);
    }
    return run(agent, engine, 'stt', async (key, ctx) => {
      const body = { contents: [{ parts: [{ text: GOOGLE_STT_PROMPT }, { inline_data: { mime_type: 'audio/wav', data: wav.toString('base64') } }] }] };
      const r = await post(`${base('google')}/models/${encodeURIComponent(MODELS.google.stt)}:generateContent`, { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, ctx);
      const j = await readJson(r, ctx);
      const parts = partsOf(j);
      if (!parts.length) throw new CloudError('bad_response');
      return { text: parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('').trim() };
    }, () => price, opts);
  }

  async function tts(agent, engine, text, cloudVoice /* , speed: the cloud engines are asked for normal speed */, speed, opts = {}) {
    if (!['openai', 'google', 'elevenlabs'].includes(engine)) throw new CloudError('bad_engine');
    const price = (PRICES[engine].tts || 0) * (String(text).length / 1000);
    if (engine === 'openai') {
      return run(agent, engine, 'tts', async (key, ctx) => {
        const r = await post(`${base('openai')}/audio/speech`, { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: MODELS.openai.tts, voice: cloudVoiceFor('openai', cloudVoice), input: text, response_format: 'wav' }) }, ctx);
        const wav = await readBytes(r, ctx);
        const w = validWav(wav);
        if (!w) throw new CloudError('bad_audio');
        return { wav: w.wav, sampleRate: w.rate };
      }, () => price, opts);
    }
    if (engine === 'google') {
      return run(agent, engine, 'tts', async (key, ctx) => {
        const body = { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cloudVoiceFor('google', cloudVoice) } } } } };
        const r = await post(`${base('google')}/models/${encodeURIComponent(MODELS.google.tts)}:generateContent`, { headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) }, ctx);
        const j = await readJson(r, ctx, GOOGLE_TTS_JSON_CAP);   // the audio is base64 inside the JSON
        const part = partsOf(j).find(p => (p.inlineData || p.inline_data));
        const inline = part && (part.inlineData || part.inline_data);
        if (!inline || typeof inline.data !== 'string') throw new CloudError('bad_response');
        const mime = String(inline.mimeType || inline.mime_type || '');
        // only raw 16-bit PCM can be wrapped as WAV; an MP3 or WAV payload would play as noise
        if (!/^(audio\/)?(l16|pcm)\b/i.test(mime)) throw new CloudError('bad_audio');
        const b64 = inline.data.replace(/\s+/g, '');
        if (!b64 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new CloudError('bad_audio');
        const pcm = Buffer.from(b64, 'base64');
        const m = /rate=(\d{4,6})/.exec(mime);
        const rate = m ? Number(m[1]) : 24000;
        if (rate < 8000 || rate > 48000 || pcm.length % 2 !== 0 || pcm.length < 24000 * 2 * MIN_AUDIO_SECONDS) throw new CloudError('bad_audio');
        return { wav: wavFromPcm16(pcm, rate), sampleRate: rate };
      }, () => price, opts);
    }
    // elevenlabs
    if (!ELEVENLABS_VOICE_RE.test(String(cloudVoice || ''))) throw new CloudError('bad_voice');
    return run(agent, engine, 'tts', async (key, ctx) => {
      const r = await post(`${base('elevenlabs')}/text-to-speech/${cloudVoice}?output_format=pcm_24000`, { headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: MODELS.elevenlabs.tts }) }, ctx);
      const pcm = await readBytes(r, ctx);
      if (pcm.length % 2 !== 0 || pcm.length < 24000 * 2 * MIN_AUDIO_SECONDS) throw new CloudError('bad_audio');
      return { wav: wavFromPcm16(pcm, 24000), sampleRate: 24000 };
    }, () => price, opts);
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

/** The agent as a non-admin may see it: voice.cloudConfirmedBy and cloudConfirmedAt (who confirmed, and when) are removed. Admins get it as is. */
function publicAgentVoice(agent, isAdmin) {
  if (isAdmin || !agent || !agent.voice || typeof agent.voice !== 'object') return agent;
  const { cloudConfirmedBy, cloudConfirmedAt, ...voice } = agent.voice;
  return { ...agent, voice };
}

module.exports = {
  publicAgentVoice,
  createCloudVoice, wavFromPcm16, wavInfo, parseWav, keptOnBox, CloudError,
  MODELS, BASES, PRICES, TIMEOUT_MS, STT_ENGINES, TTS_ENGINES, OPENAI_VOICES, GOOGLE_VOICES, ELEVENLABS_VOICE_RE, DEFAULT_CLOUD_VOICE, GOOGLE_STT_PROMPT,
};
