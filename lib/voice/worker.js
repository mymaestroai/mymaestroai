'use strict';

// lib/voice/worker.js: child process that holds the loaded speech models. `node lib/voice/worker.js <dir>`.
// sherpa-onnx calls are synchronous and heavy, so they never run in the hub process.
//
// Protocol (one JSON object per line):
//   in : { id, op:'ping' }
//        { id, op:'stt', pcmBase64, sampleRate, model? }     pcmBase64 = little-endian float32 samples, mono
//        { id, op:'tts', text, voice, speed }
//   out: { id, ok:true, text, ms } | { id, ok:true, wavBase64, sampleRate, normalized, gainDb, ms } | { id, ok:true, pong:true } | { id, ok:false, error }
// Nothing is logged: not audio, not text.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const manifest = require('./manifest');
const { normalizeSpeech } = require('./normalize');

function wavFromFloat32(samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples[i])); buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), 44 + i * 2); }
  return buf;
}

function createWorker(dir, { sherpa: sherpaOverride, write = (line) => process.stdout.write(line) } = {}) {
  const modelsDir = path.join(dir, 'models');
  const threads = Math.max(1, Math.min(8, os.cpus().length || 1));
  let sherpa = sherpaOverride || null;
  const recognisers = new Map();   // model size -> OfflineRecognizer
  let kokoro = null, kokoroAccent = '';   // one Kokoro instance at a time (a second would double the memory)
  const pipers = new Map();               // model id -> OfflineTts

  function loadSherpa() {
    if (sherpa) return sherpa;
    const req = createRequire(path.join(dir, 'node_modules', 'noop.js'));
    sherpa = req('sherpa-onnx-node');
    return sherpa;
  }
  const mdir = (id) => path.join(modelsDir, id);

  function recogniser(size) {
    if (!manifest.STT_MODELS.includes(size)) throw new Error(`unknown speech model ${size}`);
    if (recognisers.has(size)) return recognisers.get(size);
    const m = manifest.MODELS[`whisper-${size}`]; const d = mdir(m.id);
    if (!fs.existsSync(d)) throw new Error(`speech model ${size} is not installed`);
    const rec = new (loadSherpa().OfflineRecognizer)({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        whisper: { encoder: path.join(d, m.used.encoder), decoder: path.join(d, m.used.decoder), language: 'en', task: 'transcribe' },
        tokens: path.join(d, m.used.tokens), numThreads: threads, provider: 'cpu',
      },
    });
    recognisers.set(size, rec);
    return rec;
  }

  function ttsFor(voice) {
    const S = loadSherpa();
    if (voice.engine === 'kokoro') {
      const accent = voice.gb ? 'gb' : 'us';
      if (kokoro && kokoroAccent === accent) return kokoro;
      const m = manifest.MODELS[voice.model]; const d = mdir(m.id);
      if (!fs.existsSync(d)) throw new Error('the Kokoro voices are not installed');
      kokoro = null;   // release the other accent's instance before loading this one
      kokoro = new S.OfflineTts({
        model: {
          kokoro: { model: path.join(d, m.used.model), voices: path.join(d, m.used.voices), tokens: path.join(d, m.used.tokens), dataDir: path.join(d, m.used.dataDir), lexicon: path.join(d, accent === 'gb' ? m.used.lexiconGb : m.used.lexiconUs) },
          debug: false, numThreads: threads, provider: 'cpu',
        },
        maxNumSentences: 1,
      });
      kokoroAccent = accent;
      return kokoro;
    }
    if (pipers.has(voice.model)) return pipers.get(voice.model);
    const m = manifest.MODELS[voice.model]; const d = mdir(m.id);
    if (!fs.existsSync(d)) throw new Error(`the ${voice.id} voice is not installed`);
    const t = new S.OfflineTts({
      model: { vits: { model: path.join(d, m.used.model), tokens: path.join(d, m.used.tokens), dataDir: path.join(d, m.used.dataDir) }, debug: false, numThreads: threads, provider: 'cpu' },
      maxNumSentences: 1,
    });
    pipers.set(voice.model, t);
    return t;
  }

  function doStt(msg) {
    const buf = Buffer.from(String(msg.pcmBase64 || ''), 'base64');
    if (buf.length < 4) throw new Error('empty audio');
    const samples = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4)));
    const rec = recogniser(msg.model || manifest.DEFAULT_STT);
    const stream = rec.createStream();
    stream.acceptWaveform({ samples, sampleRate: Number(msg.sampleRate) || 16000 });
    rec.decode(stream);
    return { text: String(rec.getResult(stream).text || '').trim() };
  }

  function doTts(msg) {
    const voice = manifest.VOICES.find(v => v.id === msg.voice);
    if (!voice) throw new Error('unknown voice');
    const text = String(msg.text || '').trim();
    if (!text) throw new Error('empty text');
    const speed = Math.max(0.5, Math.min(2, Number(msg.speed) || 1));
    const audio = ttsFor(voice).generate({ text, sid: voice.sid, speed });
    if (!audio || !audio.samples || !audio.samples.length) throw new Error('the voice produced no audio');
    // Every local voice is brought to one speech level with a peak ceiling (lib/voice/normalize.js); on any failure the raw samples go out.
    let samples = audio.samples, normalized = false, gainDb = 0;
    try { const n = normalizeSpeech(audio.samples, audio.sampleRate); samples = n.samples; normalized = n.normalized === true; gainDb = n.gainDb; } catch { samples = audio.samples; normalized = false; gainDb = 0; }
    const wav = wavFromFloat32(samples, audio.sampleRate);
    return { wavBase64: wav.toString('base64'), sampleRate: audio.sampleRate, normalized, gainDb };
  }

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (!msg || msg.id === undefined) return;
    const t0 = Date.now();
    try {
      let out;
      if (msg.op === 'ping') out = { pong: true };
      else if (msg.op === 'stt') out = doStt(msg);
      else if (msg.op === 'tts') out = doTts(msg);
      else throw new Error('unknown op');
      write(JSON.stringify({ id: msg.id, ok: true, ...out, ms: Date.now() - t0 }) + '\n');
    } catch (e) {
      write(JSON.stringify({ id: msg.id, ok: false, error: String((e && e.message) || e).slice(0, 300) }) + '\n');
    }
  }
  return { handle, wavFromFloat32 };
}

module.exports = { createWorker, wavFromFloat32 };

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) { process.stderr.write('usage: node worker.js <dir>\n'); process.exit(2); }
  const w = createWorker(dir);
  let pending = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    pending += chunk;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, i); pending = pending.slice(i + 1); if (line.trim()) w.handle(line); }
  });
  process.stdin.on('end', () => process.exit(0));
  process.on('disconnect', () => process.exit(0));
}
