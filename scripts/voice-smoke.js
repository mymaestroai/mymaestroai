#!/usr/bin/env node
'use strict';
// Manual check of the local voice engine with the REAL downloads (about 0.7 GB with the tiny.en recogniser). Not part of
// the test suite. Usage:
//   node scripts/voice-smoke.js [dir] [clip.wav] [tiny.en|small.en]
// dir defaults to <system temp>/voice-smoke. Installs (idempotent: a second run downloads nothing), then runs
// text-to-speech and speech-to-text through the worker and prints timings. Without a clip, the speech-to-text check
// transcribes the first voice's own output.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createVoiceEngine } = require('../lib/voice/engine');
const { createVoiceClient } = require('../lib/voice/client');

const dir = process.argv[2] || path.join(os.tmpdir(), 'voice-smoke');
const clipArg = process.argv[3] || '';
const sttModel = process.argv[4] || 'tiny.en';

(async () => {
  const engine = createVoiceEngine({ dir, log: (m) => console.log(m) });
  console.log('speed check:', JSON.stringify(engine.speedCheck()));
  let last = '';
  const timer = setInterval(() => {
    const s = engine.status();
    const line = `${s.step} ${Math.round(s.progress * 100)}% (${Math.round(s.bytesDone / 1048576)}/${Math.round(s.bytesTotal / 1048576)} MB)`;
    if (line !== last) { console.log('  ' + line); last = line; }
  }, 2000);
  const t0 = Date.now();
  await engine.install({ sttModel });
  clearInterval(timer);
  console.log(`install: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const st = engine.status();
  console.log('status:', JSON.stringify({ ...st, voices: st.voices.map(v => v.id) }));
  if (!st.ready) throw new Error('not ready');

  const client = createVoiceClient({ engine, idleMs: 0 });
  try {
    const text = 'Good morning. I asked it to suggest 10 minutes at 7:30 about Anthropic.';
    let firstOut = '';
    for (const voice of ['af_heart', 'bm_george', 'alba']) {
      for (let i = 1; i <= 2; i++) {
        const t2 = Date.now(); const r = await client.tts(text, voice);
        const out = path.join(dir, `smoke-${voice}.wav`); fs.writeFileSync(out, r.wav);
        if (!firstOut) firstOut = out;
        console.log(`tts ${voice} #${i}: ${r.wav.length} bytes @ ${r.sampleRate} Hz, worker ${r.ms} ms, round trip ${Date.now() - t2} ms${i === 1 ? ' (includes loading the model)' : ''} -> ${out}`);
      }
    }
    const clip = clipArg || firstOut;
    const wav = fs.readFileSync(clip);
    for (let i = 1; i <= 2; i++) {
      const t1 = Date.now(); const r = await client.stt(wav);
      console.log(`stt #${i} (${path.basename(clip)}): "${r.text}"  worker ${r.ms} ms, round trip ${Date.now() - t1} ms${i === 1 ? ' (includes loading the model)' : ''}`);
    }
  } finally { client.stop(); }
  console.log('OK');
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
