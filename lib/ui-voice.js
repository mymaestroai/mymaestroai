'use strict';
/**
 * ui-voice.js — the pure helpers behind the voice feature of the chat pages: the text a reply is spoken from, the
 * sentences it is spoken in, audio resampling and WAV encoding/decoding, microphone level and meter maths, the saved
 * per-device settings, and the spoken stop commands. The pages carry byte-identical copies between the markers below
 * (app.js, mobile.js); test/ui-voice.test.js proves the copies match and tests the behaviour here. Browser-safe plain
 * JS: no require, every top-level name starts with voice / VOICE_.
 *
 *   voiceSpeechText(markdown)          THE cleaner every spoken string passes through: plain text to speak; code and tables
 *                                      are left out and, once, ' I have put the details in the chat.' is added; links keep
 *                                      their label, bare URLs say 'a link', paths 'a file path'; markdown, emoji, symbols and
 *                                      arrows are dropped, dashes become a comma pause, & % + @ are read as words
 *   voiceCleanSpeed(v) / voiceSpeedLabel(v)   voice speed 0.75..1.5 in steps of 0.05 / '1.10x'
 *   voiceSentences(text, max = 220)    the sentences, none longer than max characters
 *   voiceResample(f32, from, to)       Float32Array at the new rate (linear interpolation)
 *   voiceEncodeWav(f32, rate)          ArrayBuffer: 16-bit PCM mono WAV with a 44-byte header
 *   voiceDecodeWav(buf)                { sampleRate, samples } from a 16-bit PCM mono/stereo WAV
 *   voiceLevelDb(f32)                  RMS level in dBFS (silence: -100)
 *   voiceGainFromSlider(v) / voiceSliderFromGain(g)   0..100 slider <-> linear gain, 50 = 1, 0 = -12 dB, 100 = +12 dB
 *   voiceMeterPercent(db)              0..100 (-60 dB = 0, 0 dB = 100)
 *   VOICE_STORE_KEY, voiceLoadPrefs(storage), voiceSavePrefs(storage, prefs)   per-device settings
 *   voiceIsStopCommand(text)           true when the whole utterance is a stop command
 *   VOICE_WAKE_QUIET_MS                [10000, 20000, 45000]: the 'back to standby after' choices (default 20000); pref wake: { agent: { on, phrase, quietMs } } (absent from the defaults)
 *   voiceCleanWakePhrase(text)         the wake phrase tidied for display, '' when invalid (1-4 words, one of 3+ letters that is not a greeting)
 *   voiceWakeForAgent(prefs, agent)    { on, phrase, quietMs } from prefs.wake, or null
 *   voiceWakeMatch(text, phrase)       { match, rest }: does the utterance start with the phrase (fillers skipped, small slips allowed), and the text after it
 *   voiceIsSleepCommand(text)          true for 'that's all' / 'that is all' / 'go to sleep' (+ thanks / thank you)
 *   voiceSoundsUnfinished(text)        true when what was said sounds cut off (ends on a joining word, a comma, or is 1-2 words)
 *   voicePickLocalVoice(voices, lang)  best offline (localService) voice for the language prefix, or null
 *   voiceWaitLocalVoice(synth, lang, ms)  the same, waiting up to ms for 'voiceschanged' when the list is empty
 *   voiceMicGuard()                    { begin, cancel, fail, settle }: pending flag + generation for a microphone request
 *   VOICE_ECHO_HOLDS                   [0, 600, 1000, 1500]: the 'Echo guard' choices in ms (pref echoHold, default 600; 0 = off); pref keepAlive (default true)
 *   voiceCarChirp(rate)                the car test sound: 120 ms sweep 500 -> 3000 Hz, Hann window, peak 0.5 (Float32Array)
 *   voiceEchoAnalysis(ref, rec, rate, opts)   { delayMs, echoDb, confidence }: where (and how loud) the test sound came back in the recording
 *   VOICE_CAR_AT, VOICE_CAR_END, VOICE_CAR_MAX_DELAY_MS   [0.5, 2.0, 3.5] s: when the three chirps play; 5.2 s: when the recording ends; 1200 ms: how far an echo is searched
 *   voiceCarAnalyse(mic, ref, chirp, rate)    three voiceEchoAnalysis results: the chirp onsets are found in ref, each echo in the microphone slice after its onset
 *   voiceCarCheckResult(analyses, current)    { echoHold, interruptSensitivity, delayMs, echoDb, heard, line }: the settings the car test picks
 */
// ── voice helpers (begin) ──
const VOICE_STORE_KEY = 'hub-voice';
const VOICE_DETAILS_NOTE = ' I have put the details in the chat.';
const VOICE_ABBREVIATIONS = new Set(['e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'jr', 'sr', 'vs']);
const VOICE_STOP_COMMANDS = new Set(['stop', 'cancel', 'stop stop', 'stop it', 'stop that', 'cancel that', 'never mind', 'nevermind']);
const VOICE_END_PAUSES = [800, 1200, 2000];   // 'Pause before I'm done': short / normal / long, in ms
const VOICE_CONTINUE_WAITS = [1500, 3000, 5000];   // 'Wait for me to go on': how long a sentence that sounds unfinished waits for more, in ms
const VOICE_ECHO_HOLDS = [0, 600, 1000, 1500];   // 'Echo guard': how long the raised barge-in thresholds stay after playback stops, in ms (0 = off)
const VOICE_WAKE_QUIET_MS = [10000, 20000, 45000];   // 'Go back to standby after': how long a quiet call stays awake (default 20000)
const VOICE_DEFAULT_PREFS = { micLevel: 50, interruptSensitivity: 50, mode: 'handsfree', readAloud: true, deviceVoiceFallback: true, endPause: 1200, voiceSpeed: 1, speakActivity: false, continueWait: 3000, thinkingSound: true, thinkingVolume: 0.5, echoHold: 600, keepAlive: true, loudness: 'louder', loudnessBt: 'normal' };
function voiceCleanSpeed(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(0.75, Math.min(1.5, n)) * 20) / 20 : 1;
}
function voiceSpeedLabel(v) { return voiceCleanSpeed(v).toFixed(2) + 'x'; }
// The spoken-text cleaner's pieces (see voiceSpeechText).
const VOICE_SYMBOLS_RE = new RegExp('[\\u2190-\\u2BFF\\u2022\\u00B7]', 'g');
const VOICE_NUM_EN_DASH_RE = new RegExp('(\\d)\\s*\\u2013\\s*(?=\\d)', 'g');
const VOICE_DASH_RE = new RegExp('\\s*[\\u2013\\u2014\\u2015]\\s*', 'g');
const VOICE_DQUOTE_RE = new RegExp('[\\u201C\\u201D"]', 'g');
const VOICE_SQUOTE_RE = new RegExp('[\\u2018\\u2019]', 'g');
const VOICE_ELLIPSIS_RE = new RegExp('\\u2026', 'g');
const VOICE_SEG = '\\/[\\w.@+~-]*[\\w@+~-]';
function voicePathsToWords(t) {
  const isPath = (m) => (m.match(/\//g) || []).length >= 2 || /\.[A-Za-z0-9]{1,8}$/.test(m);
  t = t.replace(/(^|[^\w/.~@-])[A-Za-z]:\\[^\s]*[^\s.,;:!?)\]'"]/g, '$1a file path');
  t = t.replace(new RegExp('(^|[^\\w/.~@-])((?:~|\\.{1,2})(?:' + VOICE_SEG + ')+|(?:' + VOICE_SEG + '){2,}|' + VOICE_SEG + '(?=\\.[A-Za-z0-9]{1,8}\\b)(?:\\.[A-Za-z0-9]{1,8})?)', 'g'),
    (m, lead, p) => lead + (isPath(p) || /^\/[\w@+~-]*\.\w/.test(p) ? 'a file path' : p));
  t = t.replace(new RegExp('(^|[^\\w/.~@-])((?=[\\w.-]*[A-Za-z])[\\w.-]+(?:' + VOICE_SEG + ')+)', 'g'), (m, lead, p) => lead + (isPath(p) ? 'a file path' : p));
  return t;
}
function voiceCleanInline(s) {
  s = s.replace(/\u2212\s*(?=\d)/g, 'minus ').replace(/\u2212/g, ' minus ');   // the minus sign is read, before the math-sign strip drops it
  s = s.replace(/[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\p{Extended_Pictographic}\p{Cf}\u{FE0E}\u{FE0F}\u{20E3}]/gu, '')   // emoji and zero-width marks
    .replace(VOICE_SYMBOLS_RE, ' ');                                    // arrows, math signs, boxes, dingbats, bullets
  s = s.replace(/[-=]+>|<[-=]+/g, ' ');                                 // -> => <-
  s = s.replace(VOICE_NUM_EN_DASH_RE, '$1 to ');                        // 5 en dash 10
  s = s.replace(VOICE_DASH_RE, ', ');                                   // en/em dash as a separator: a pause
  s = s.replace(/(^|[\s(])-{1,2}(?=[A-Za-z])/g, '$1');                  // a command-line flag: -x --force
  s = s.replace(/(^|[\s(])-(?=\d)/g, '$1minus ');
  s = s.replace(/\s*-{2,}\s*/g, ', ').replace(/\s+-(?=\s|$)/g, ', ');   // -- or a lone dash between spaces
  s = s.replace(/(^|\s)-+(?=\S)/g, '$1').replace(/(\S)-+(?=\s|$)/g, '$1');   // a dash stuck to the edge of a word (hyphens inside words stay)
  s = s.replace(/&/g, ' and ').replace(/%/g, ' percent').replace(/@/g, ' at ').replace(/=+/g, ' equals ');
  s = s.replace(/(\d)\s*\+\s*(?=\d)/g, '$1 plus ').replace(/(\d)\+(?=\W|$)/g, '$1 plus');
  s = s.replace(/<\/?[A-Za-z][^<>]*>/g, ' ');
  s = s.replace(/[*`#~^|\\<>+{}\[\]()]/g, ' ').replace(/\//g, ' ');
  s = s.replace(/\b_+|_+\b/g, '').replace(/_/g, ' ');
  s = s.replace(VOICE_DQUOTE_RE, '').replace(VOICE_SQUOTE_RE, '\'').replace(VOICE_ELLIPSIS_RE, '...');
  s = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 3; i++) s = s.replace(/\s+([,.;:!?])/g, '$1').replace(/([,;:])(?:\s*[,;:])+/g, '$1').replace(/([.!?])\s*,/g, '$1').replace(/,\s*([.!?])/g, '$1');
  return s.replace(/^[,;:\s]+/, '').replace(/,$/, '').trim();
}
function voiceSpeechText(markdown, open) {
  let t = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  let hadDetails = false;
  t = t.replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(\n[ \t]*(```|~~~)[^\n]*|$)/g, (m, lead) => { hadDetails = true; return lead; });
  t = t.split('\n').filter(l => { if (/^\s*\|/.test(l)) { hadDetails = true; return false; } return true; }).join('\n');
  t = t.replace(/!?\[([^\]]*)\]\([^)\s]*(?:\s+"[^"]*")?\)/g, '$1');
  t = t.replace(/(?:https?:\/\/|www\.)[^\s<>)\]]*[^\s<>)\].,;:!?'"]/gi, 'a link');
  t = voicePathsToWords(t);
  // Lines -> blocks: a heading, a list item or a bold-only line is a block of its own, a blank line or a rule ends one,
  // other lines of a paragraph join. Each block is cleaned and ends with a full stop, so lines never run together.
  const blocks = [];
  let cur = '', curOwn = false;
  const flush = () => { if (cur.trim()) blocks.push(cur.trim()); cur = ''; curOwn = false; };
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*([-*_=~])(?:\s*\1){2,}\s*$/.test(line)) { flush(); continue; }
    let s = line.replace(/^[ \t]*(?:>[ \t]?)+/, '');
    const head = /^[ \t]*#{1,6}[ \t]+/.test(s), item = /^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/.test(s);
    s = s.replace(/^[ \t]*#{1,6}[ \t]+/, '').replace(/^[ \t]*(?:[-*+•]|\d+[.)])[ \t]+/, '');
    const bold = /^\s*(\*\*|__)[^*_]+\1\s*:?\s*$/.test(s);
    if (head || item || bold) { flush(); cur = s; curOwn = true; }
    else if (!cur) cur = s;
    else if (curOwn && !/^(?:[ \t]{2,}|\t)/.test(raw)) { flush(); cur = s; }   // text under a heading or item starts its own block
    else cur += ' ' + s;
  }
  flush();
  const done = [];
  blocks.forEach((raw, i) => {
    const b = voiceCleanInline(raw);
    if (!b) return;
    // open: the text is still being written, so its last block is not finished and gets no full stop yet
    done.push(/[.!?:;]["')’\]]*$/.test(b) || (open && i === blocks.length - 1) ? b : b + '.');
  });
  t = done.join(' ').replace(/\s+/g, ' ').trim();
  return hadDetails ? (t + VOICE_DETAILS_NOTE).trim() : t;
}
function voiceSplitLong(s, max) {
  const out = [];
  let rest = s.trim();
  while (rest.length > max) {
    const win = rest.slice(0, max);
    let cut = Math.max(win.lastIndexOf(';'), win.lastIndexOf(',')) + 1;
    if (cut < max * 0.3) cut = win.lastIndexOf(' ') + 1;
    if (cut < max * 0.3) cut = win.lastIndexOf(' ') > 0 ? win.lastIndexOf(' ') + 1 : max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out.filter(Boolean);
}
function voiceSentences(text, max = 220) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  const limit = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 220;
  const parts = [];
  let start = 0;
  const re = /[.!?]+["')\]]*(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[0].replace(/["')\]]/g, '') === '.') {
      const before = s.slice(start, m.index).split(' ').pop().replace(/^[("'\[]+/, '').toLowerCase();
      if (VOICE_ABBREVIATIONS.has(before)) continue;
    }
    parts.push(s.slice(start, m.index + m[0].length));
    start = m.index + m[0].length;
  }
  parts.push(s.slice(start));
  const out = [];
  for (const p of parts) for (const q of voiceSplitLong(p, limit)) out.push(q);
  return out;
}
function voiceResample(float32, fromRate, toRate) {
  const src = float32 instanceof Float32Array ? float32 : Float32Array.from(float32 || []);
  if (fromRate === toRate || !(fromRate > 0) || !(toRate > 0)) return new Float32Array(src);
  const n = Math.max(0, Math.round(src.length * toRate / fromRate));
  const out = new Float32Array(n);
  const step = fromRate / toRate;
  for (let i = 0; i < n; i++) {
    const pos = i * step, i0 = Math.floor(pos), frac = pos - i0;
    const a = src[Math.min(i0, src.length - 1)], b = src[Math.min(i0 + 1, src.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}
function voiceEncodeWav(float32, sampleRate) {
  const n = float32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const tag = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  tag(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const x = Math.max(-1, Math.min(1, float32[i] || 0));
    v.setInt16(44 + i * 2, Math.round(x < 0 ? x * 32768 : x * 32767), true);
  }
  return buf;
}
function voiceDecodeWav(arrayBuffer) {
  const v = new DataView(arrayBuffer), len = arrayBuffer.byteLength;
  const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
  if (len < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let channels = 0, sampleRate = 0, bits = 0, dataAt = -1, dataLen = 0, o = 12;
  while (o + 8 <= len) {
    const id = tag(o), size = v.getUint32(o + 4, true);
    if (id === 'fmt ' && o + 24 <= len) {
      if (v.getUint16(o + 8, true) !== 1) throw new Error('only PCM WAV is supported');
      channels = v.getUint16(o + 10, true); sampleRate = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true);
    } else if (id === 'data') {
      dataAt = o + 8; dataLen = Math.min(size, len - dataAt); break;
    }
    o += 8 + size + (size % 2);
  }
  if (!channels || dataAt < 0) throw new Error('WAV has no audio');
  if (bits !== 16 || channels > 2) throw new Error('only 16-bit mono or stereo WAV is supported');
  const frames = Math.floor(dataLen / (2 * channels)), samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += v.getInt16(dataAt + (i * channels + c) * 2, true);
    samples[i] = sum / channels / 32768;
  }
  return { sampleRate, samples };
}
function voiceLevelDb(float32) {
  if (!float32 || !float32.length) return -100;
  let sum = 0;
  for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
  const rms = Math.sqrt(sum / float32.length);
  if (!(rms > 0)) return -100;
  return Math.max(-100, 20 * Math.log10(rms));
}
function voiceGainFromSlider(v) {
  const x = Number.isFinite(Number(v)) ? Math.max(0, Math.min(100, Number(v))) : 50;
  return Math.pow(10, ((x - 50) / 50 * 12) / 20);
}
function voiceSliderFromGain(g) {
  if (!(g > 0)) return 0;
  return Math.max(0, Math.min(100, 50 + 20 * Math.log10(g) / 12 * 50));
}
function voiceMeterPercent(db) {
  if (!Number.isFinite(db)) return db === Infinity ? 100 : 0;
  return Math.max(0, Math.min(100, (db + 60) / 60 * 100));
}
function voiceCleanPrefs(raw) {
  const p = Object.assign({}, VOICE_DEFAULT_PREFS);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return p;
  for (const k of ['micLevel', 'interruptSensitivity']) {
    if (typeof raw[k] === 'number' && Number.isFinite(raw[k])) p[k] = Math.max(0, Math.min(100, raw[k]));
  }
  if (raw.mode === 'handsfree' || raw.mode === 'tap') p.mode = raw.mode;
  if (VOICE_END_PAUSES.includes(raw.endPause)) p.endPause = raw.endPause;
  if (typeof raw.voiceSpeed === 'number' && Number.isFinite(raw.voiceSpeed)) p.voiceSpeed = voiceCleanSpeed(raw.voiceSpeed);
  if (VOICE_CONTINUE_WAITS.includes(raw.continueWait)) p.continueWait = raw.continueWait;
  if (VOICE_ECHO_HOLDS.includes(raw.echoHold)) p.echoHold = raw.echoHold;
  if (typeof raw.thinkingVolume === 'number' && Number.isFinite(raw.thinkingVolume)) p.thinkingVolume = Math.round(Math.max(0, Math.min(1, raw.thinkingVolume)) * 100) / 100;
  for (const k of ['readAloud', 'deviceVoiceFallback', 'speakActivity', 'thinkingSound', 'keepAlive']) if (typeof raw[k] === 'boolean') p[k] = raw[k];
  if (typeof raw.loudness === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, raw.loudness)) p.loudness = raw.loudness;
  if (typeof raw.loudnessBt === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, raw.loudnessBt)) p.loudnessBt = raw.loudnessBt;
  // wake: per agent { on, phrase, quietMs }; the key exists only when the raw prefs carried an object (the defaults have none)
  if (raw.wake && typeof raw.wake === 'object' && !Array.isArray(raw.wake)) {
    const wake = {};
    let n = 0;
    for (const name of Object.keys(raw.wake)) {
      if (n >= 50) break;
      const e = raw.wake[name];
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name) || !e || typeof e !== 'object' || Array.isArray(e)) continue;
      wake[name] = { on: e.on === true, phrase: voiceCleanWakePhrase(e.phrase), quietMs: VOICE_WAKE_QUIET_MS.includes(e.quietMs) ? e.quietMs : 20000 };
      n++;
    }
    p.wake = wake;
  }
  return p;
}
// The wake phrase of an agent from the cleaned prefs: { on, phrase, quietMs } or null.
function voiceWakeForAgent(prefs, agent) {
  try {
    const w = prefs && prefs.wake;
    if (!w || typeof w !== 'object' || typeof agent !== 'string' || !Object.prototype.hasOwnProperty.call(w, agent)) return null;
    const e = w[agent];
    if (!e || typeof e !== 'object') return null;
    return { on: e.on === true, phrase: typeof e.phrase === 'string' ? e.phrase : '', quietMs: VOICE_WAKE_QUIET_MS.includes(e.quietMs) ? e.quietMs : 20000 };
  } catch { return null; }
}
const VOICE_WAKE_GREETINGS = new Set(['hey', 'hi', 'hello', 'hay', 'ok', 'okay', 'yo', 'oh', 'um', 'uh', 'so', 'well']);
// The phrase tidied for display, '' when it is not usable: 1-4 words of letters, digits or apostrophes (1-20 characters each), at most
// 60 characters, and at least one word of 3+ characters that is not a greeting or filler.
function voiceCleanWakePhrase(text) {
  if (typeof text !== 'string') return '';
  const s = text.replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (!s || s.length > 60) return '';
  const words = s.split(' ').map(w => w.replace(/[,.]/g, '')).filter(Boolean);
  if (words.length < 1 || words.length > 4) return '';
  if (!words.every(w => /^[\p{L}\p{N}'’]{1,20}$/u.test(w))) return '';
  if (!words.some(w => w.replace(/['’]/g, '').length >= 3 && !VOICE_WAKE_GREETINGS.has(w.toLowerCase().replace(/['’]/g, '')))) return '';
  return words.join(' ');
}
// Tokens for matching: lowercase, apostrophes removed, everything else that is not a letter or digit separates; each token keeps the
// offset just after its last character in the original text.
function voiceWakeTokens(text) {
  const s = String(text), out = [];
  let cur = '', end = 0;
  for (let i = 0; i < s.length;) {
    const ch = String.fromCodePoint(s.codePointAt(i)), at = i;
    i += ch.length;
    if (ch === '\'' || ch === '’' || ch === '‘' || ch === 'ʼ') continue;
    if (/[\p{L}\p{N}]/u.test(ch)) { cur += ch.toLowerCase(); end = at + ch.length; }
    else if (cur) { out.push({ t: cur, end }); cur = ''; }
  }
  if (cur) out.push({ t: cur, end });
  return out;
}
function voiceWakeDistance(a, b) {
  let prev = []; for (let j = 0; j <= b.length; j++) prev.push(j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)));
    prev = cur;
  }
  return prev[b.length];
}
const VOICE_WAKE_FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'oh', 'so', 'ok', 'okay', 'well', 'and', 'yeah']);
// Does the utterance start with the wake phrase? -> { match, rest }: rest is the original text after the phrase without the pause
// punctuation. Leading fillers are skipped (not one that is the phrase's own first word); the first 1..words+2 tokens are joined and
// compared to the phrase without spaces by edit distance (0 up to 6 letters, 1 up to 12, 2 above), the first letters must agree.
function voiceWakeMatch(text, phrase) {
  const none = { match: false, rest: '' };
  try {
    if (typeof text !== 'string' || !text) return none;
    const clean = voiceCleanWakePhrase(phrase);
    if (!clean) return none;
    const pt = voiceWakeTokens(clean).map(x => x.t);
    if (!pt.length) return none;
    const ut = voiceWakeTokens(text);
    let i = 0;
    while (i < ut.length && VOICE_WAKE_FILLERS.has(ut[i].t) && ut[i].t !== pt[0]) i++;
    if (i >= ut.length || ut[i].t[0] !== pt[0][0]) return none;
    const P = pt.join(''), tol = P.length <= 6 ? 0 : P.length <= 12 ? 1 : 2;
    // Every span of 1 .. k+2 words is tried and the closest one wins (fewest edits, then the word count nearest the phrase's), so
    // "Hey Watchman AI" heard in full is never taken as "Hey Watchman" plus a message starting "AI".
    let U = '', best = null;
    for (let n = 1; n <= pt.length + 2 && i + n <= ut.length; n++) {
      U += ut[i + n - 1].t;
      if (Math.abs(U.length - P.length) > tol) continue;
      const dist = voiceWakeDistance(U, P);
      if (dist > tol) continue;
      const off = Math.abs(n - pt.length);
      if (!best || dist < best.dist || (dist === best.dist && off < best.off)) best = { dist, off, end: ut[i + n - 1].end };
    }
    if (!best) return none;
    return { match: true, rest: text.slice(best.end).replace(/^[\s,.!?;:\-–—…"'“”‘’()\[\]]+/, '').trimEnd() };
  } catch { return none; }
}
function voiceLoadPrefs(storage) {
  try { return voiceCleanPrefs(JSON.parse(storage.getItem(VOICE_STORE_KEY))); } catch { return voiceCleanPrefs(null); }
}
function voiceSavePrefs(storage, prefs) {
  const merged = voiceCleanPrefs(Object.assign({}, voiceLoadPrefs(storage), prefs));
  try { storage.setItem(VOICE_STORE_KEY, JSON.stringify(merged)); } catch { /* storage full or blocked: keep going */ }
  return merged;
}
function voiceIsStopCommand(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return VOICE_STOP_COMMANDS.has(t);
}
// The words that put an awake call back to standby: 'that's all', 'that is all', 'go to sleep', each with 'thanks' or 'thank you' after.
const VOICE_SLEEP_COMMANDS = new Set(['thats all', 'that is all', 'go to sleep'].flatMap(c => [c, c + ' thanks', c + ' thank you']));
function voiceIsSleepCommand(text) {
  const t = String(text == null ? '' : text).toLowerCase().replace(/['’]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return VOICE_SLEEP_COMMANDS.has(t);
}
// Does what was said sound unfinished? True when it ends on a joining word (and, but, to, the, ...), ends with a comma, a
// dash or an ellipsis, or is a fragment of one or two words without final punctuation. A whole sentence or a question is
// finished, and so are stop commands and short answers (now, later, skip, yes, no, ok). A final full stop does not make a
// fragment finished ("... difficult to."): Whisper puts one on a cut-off piece, so it is stripped before the last word is checked.
// Strong joining words leave a thought open even with a final full stop ("... difficult to."); weak ones (pronouns, "is",
// "that"...) end plenty of whole sentences ("Do it.", "That is what it is."), so they count only without final punctuation.
const VOICE_JOINING_WORDS = new Set(['and', 'also', 'but', 'or', 'because', 'to', 'the', 'a', 'an', 'of', 'when', 'if', 'with', 'from', 'about', 'like',
  'my', 'your', 'our', 'their', 'very', 'um', 'uh', 'er', 'hmm']);
const VOICE_WEAK_JOINING_WORDS = new Set(['that', 'which', 'who', 'i', 'you', 'we', 'it', 'is', 'are', 'was', 'this', 'these', 'then', 'just', 'really', 'so', 'as', 'at', 'in', 'on', 'by', 'than', 'for']);
const VOICE_JOINING_PHRASES = ['you know', 'i mean'];
const VOICE_COMPLETE_SHORT = new Set(['stop', 'cancel', 'now', 'later', 'skip', 'yes', 'no', 'yeah', 'yep', 'nope', 'ok', 'okay', 'sure', 'thanks', 'hello', 'hi', 'go ahead', 'thank you', 'never mind', 'nevermind']);
function voiceSoundsUnfinished(text) {
  const raw = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!raw) return false;
  if (/[,–—…-]["')\]]*$/.test(raw) || /\.{3}["')\]]*$/.test(raw)) return true;   // a comma, a dash, an ellipsis: more is coming
  if (/[!?\uFF01\uFF1F]["')\]]*$/.test(raw)) return false;                                                    // a question or an exclamation is whole
  const body = raw.replace(/[.\u3002\s]+$/, '');
  const words = body.toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, ' ').replace(/’/g, '\'').split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  if (voiceIsStopCommand(raw) || VOICE_COMPLETE_SHORT.has(words.join(' '))) return false;
  const last = words[words.length - 1].replace(/^'+|'+$/g, '');
  if (VOICE_JOINING_WORDS.has(last) || (words.length >= 2 && VOICE_JOINING_PHRASES.includes(words.slice(-2).join(' ')))) return true;
  if (VOICE_WEAK_JOINING_WORDS.has(last) && !/[.\u3002]['")\]]*$/.test(raw)) return true;                         // weak: only without a full stop
  return words.length <= 2 && !/[.\u3002]["')\]]*$/.test(raw);                                        // one or two words and no full stop
}
function voicePickLocalVoice(voices, lang) {
  const pre = String(lang || 'en').toLowerCase();
  const local = Array.from(voices || []).filter(v => v && v.localService === true && String(v.lang || '').toLowerCase().startsWith(pre));
  return local.find(v => v.default === true) || local[0] || null;
}
async function voiceWaitLocalVoice(synth, lang, waitMs = 1000) {
  if (!synth || typeof synth.getVoices !== 'function') return null;
  let list = synth.getVoices() || [];
  if (!list.length && typeof synth.addEventListener === 'function') {
    list = await new Promise((resolve) => {
      let done = false, timer = null;
      const fin = () => {
        if (done) return;
        done = true; clearTimeout(timer);
        try { synth.removeEventListener('voiceschanged', fin); } catch { /* gone */ }
        resolve(synth.getVoices() || []);
      };
      timer = setTimeout(fin, waitMs);
      synth.addEventListener('voiceschanged', fin);
    });
  }
  return voicePickLocalVoice(list, lang);
}
function voiceMicGuard() {
  const g = { pending: false, gen: 0 };
  g.begin = () => { if (g.pending) return -1; g.pending = true; return g.gen; };
  g.cancel = () => { g.gen++; };
  g.fail = () => { g.pending = false; };
  g.settle = (token, mic) => {
    g.pending = false;
    if (token === g.gen) return true;
    try { if (mic && mic.close) mic.close(); } catch { /* already closed */ }
    return false;
  };
  return g;
}
// The test sound of the 'Car or Bluetooth check': a 120 ms linear sweep from 500 Hz to 3000 Hz (inside narrowband car audio, 300-3400 Hz),
// Hann-windowed so it does not click, peak 0.5.
function voiceCarChirp(rate) {
  const r = Number(rate) > 0 ? Number(rate) : 16000, n = Math.max(2, Math.round(r * 0.12)), dur = n / r, f0 = 500, f1 = 3000;
  const out = new Float32Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / r, phase = 2 * Math.PI * (f0 * t + (f1 - f0) * t * t / (2 * dur));
    out[i] = Math.sin(phase) * 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0) for (let i = 0; i < n; i++) out[i] = out[i] * 0.5 / peak;
  return out;
}
// Where does the test sound come back? ref = the chirp, rec = microphone samples that start when the chirp was scheduled to start, both at
// `rate`. Searches the lags 0..opts.maxDelayMs (default 1500) for the peak of the NORMALISED cross-correlation (divided by
// sqrt(energy of ref x energy of the recorded window)): a coarse pass over every few samples (so 48 kHz input stays fast), then the exact
// values around the best one. -> { delayMs, echoDb, confidence }: confidence is the normalised peak (0..1), delayMs the lag in ms (null when
// confidence < 0.3: no echo found), echoDb the RMS level of the recorded window at that lag (-Infinity for silence).
function voiceEchoAnalysis(ref, rec, rate, opts) {
  const o = opts || {}, none = { delayMs: null, echoDb: -Infinity, confidence: 0 };
  const n = ref ? ref.length : 0, m = rec ? rec.length : 0;
  if (!(n > 0) || !(Number(rate) > 0)) return none;
  const maxMs = Number.isFinite(Number(o.maxDelayMs)) && Number(o.maxDelayMs) >= 0 ? Number(o.maxDelayMs) : 1500;
  const maxLag = Math.min(Math.floor(maxMs * rate / 1000), m - n);
  if (maxLag < 0) return none;
  let eref = 0;
  for (let i = 0; i < n; i++) eref += ref[i] * ref[i];
  if (!(eref > 0)) return none;
  const pre = new Float64Array(m + 1);   // running sums of rec squared: the energy of any window in O(1)
  for (let i = 0; i < m; i++) pre[i + 1] = pre[i] + rec[i] * rec[i];
  const energy = (lag) => pre[lag + n] - pre[lag];
  const step = Math.max(1, Math.round(rate / 12000));   // 48 kHz: every 4th sample; 16 kHz and 8 kHz: every sample
  const cols = Math.ceil(n / step), refD = new Float32Array(cols);
  for (let j = 0; j < cols; j++) refD[j] = ref[j * step];
  let bestLag = 0, best = -Infinity;
  for (let lag = 0; lag <= maxLag; lag += step) {
    const e = energy(lag);
    if (!(e > 0)) continue;
    let s = 0;
    for (let j = 0; j < cols; j++) s += refD[j] * rec[lag + j * step];
    const score = s * step / Math.sqrt(eref * e);
    if (score > best) { best = score; bestLag = lag; }
  }
  let conf = 0;
  const lo = Math.max(0, bestLag - Math.max(4, step)), hi = Math.min(maxLag, bestLag + Math.max(4, step));
  for (let lag = lo; lag <= hi; lag++) {
    const e = energy(lag);
    if (!(e > 0)) continue;
    let s = 0;
    for (let i = 0; i < n; i++) s += ref[i] * rec[lag + i];
    const score = s / Math.sqrt(eref * e);
    if (score > conf) { conf = score; bestLag = lag; }
  }
  conf = Math.max(0, Math.min(1, conf));
  const rms = Math.sqrt(Math.max(0, energy(bestLag)) / n);
  const echoDb = rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -Infinity;
  return { delayMs: conf < 0.3 ? null : Math.round(bestLag / rate * 1000), echoDb, confidence: conf, lag: bestLag };   // lag: the same in samples (exact)
}
function voiceEchoHoldLabel(ms) { return ms === 0 ? 'off' : (ms / 1000) + ' s'; }   // 'off', '0.6 s', '1 s', '1.5 s'
function voiceCarMedian(list) {
  const a = list.slice().sort((x, y) => x - y), k = a.length >> 1;
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
}
// What the car test decides. analyses = voiceEchoAnalysis results (usually 3), current = { echoHold, interruptSensitivity }. The sound was heard
// when at least two analyses found an echo. Then the Echo guard becomes the smallest hold (0 is not a candidate) of at least the median delay
// + 300 ms (else the longest), and a loud echo lowers the interrupt sensitivity (never raises it): echo above -30 dB: at most 30; above -45 dB: at most 40.
// -> { echoHold, interruptSensitivity, delayMs, echoDb, heard, line } (line: what is said and shown).
function voiceCarCheckResult(analyses, current) {
  const cur = current || {};
  const curHold = VOICE_ECHO_HOLDS.includes(cur.echoHold) ? cur.echoHold : 600;
  const curSens = Number.isFinite(Number(cur.interruptSensitivity)) ? Number(cur.interruptSensitivity) : 50;
  const found = Array.from(analyses || []).filter(a => a && typeof a === 'object' && a.delayMs !== null && Number.isFinite(Number(a.delayMs)));
  if (found.length < 2) {
    return { echoHold: curHold, interruptSensitivity: curSens, delayMs: null, echoDb: null, heard: false,
      line: 'No echo of the test sound reached the microphone. Echo guard stays at ' + voiceEchoHoldLabel(curHold) + '.' };
  }
  const delayMs = Math.round(voiceCarMedian(found.map(a => Number(a.delayMs))));
  const echoDb = Math.round(voiceCarMedian(found.map(a => (Number.isNaN(Number(a.echoDb)) ? -Infinity : Number(a.echoDb)))) * 10) / 10;
  const echoHold = VOICE_ECHO_HOLDS.filter(h => h > 0).find(h => h >= delayMs + 300) || 1500;
  const interruptSensitivity = echoDb > -30 ? Math.min(curSens, 30) : echoDb > -45 ? Math.min(curSens, 40) : curSens;
  const lowered = interruptSensitivity < curSens;
  return { echoHold, interruptSensitivity, delayMs, echoDb, heard: true,
    line: 'The echo comes back after ' + delayMs + ' ms. Echo guard set to ' + voiceEchoHoldLabel(echoHold) + (lowered ? ', interrupt sensitivity lowered to ' + interruptSensitivity + '.' : '.') };
}
// The Car or Bluetooth check plays the chirp three times, VOICE_CAR_AT seconds after the start, and records until VOICE_CAR_END. The chirps are 1.5 s
// apart and the search for an echo stops at VOICE_CAR_MAX_DELAY_MS (1.2 s), so the window of one chirp never holds the echo of the next.
const VOICE_CAR_AT = [0.5, 2.0, 3.5], VOICE_CAR_END = 5.2, VOICE_CAR_MAX_DELAY_MS = 1200;
// The analysis of one check recording. mic = the microphone samples and ref = a copy of the chirp (silence elsewhere) from the SAME buffers of the SAME
// audio processor, so both share one clock and index i of one is the same instant as index i of the other. The chirp onsets are found in ref
// (confidence > 0.9, in samples): the first in a window shorter than the spacing (so it can only be the first chirp), each next one within
// +-200 ms of where the spacing puts it. Then for each onset the microphone slice [onset, onset + VOICE_CAR_MAX_DELAY_MS + chirp length] is
// analysed. -> always VOICE_CAR_AT.length voiceEchoAnalysis results; a chirp whose onset was not found gives { delayMs: null, echoDb: -Infinity, confidence: 0 }.
function voiceCarAnalyse(mic, ref, chirp, rate) {
  const count = VOICE_CAR_AT.length, none = () => ({ delayMs: null, echoDb: -Infinity, confidence: 0 }), out = [];
  const n = chirp ? chirp.length : 0, r = Number(rate);
  const onsets = [];   // null where a chirp was not found
  if (ref && n > 0 && r > 0) {
    const firstMs = Math.max(200, ((VOICE_CAR_AT[1] - VOICE_CAR_AT[0]) || 1.5) * 1000 - 100);
    const a0 = voiceEchoAnalysis(chirp, ref, r, { maxDelayMs: firstMs });
    let prev = a0.delayMs !== null && a0.confidence > 0.9 ? a0.lag : null;
    onsets.push(prev);
    for (let i = 1; i < count; i++) {
      if (prev === null) { onsets.push(null); continue; }
      const from = Math.max(0, prev + Math.round((VOICE_CAR_AT[i] - VOICE_CAR_AT[i - 1]) * r) - Math.round(0.2 * r));
      const a = voiceEchoAnalysis(chirp, ref.subarray(from), r, { maxDelayMs: 400 });
      prev = a.delayMs !== null && a.confidence > 0.9 ? from + a.lag : null;
      onsets.push(prev);
    }
  }
  const span = Math.round(VOICE_CAR_MAX_DELAY_MS / 1000 * r) + n;
  for (let i = 0; i < count; i++) {
    if (i >= onsets.length || onsets[i] === null || !mic) { out.push(none()); continue; }
    out.push(voiceEchoAnalysis(chirp, mic.subarray(onsets[i], onsets[i] + span), r, { maxDelayMs: VOICE_CAR_MAX_DELAY_MS }));
  }
  return out;
}
// A very quiet, looping WAV (white noise near -60 dBFS, never silence). Played through a media element it makes Chrome for Android take full audio focus.
function voiceFocusWav(seconds = 6, sampleRate = 8000) {
  const n = Math.max(1, Math.round(seconds * sampleRate)), bytes = n * 2;
  const out = new Uint8Array(44 + bytes), dv = new DataView(out.buffer);
  const tag = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + bytes, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, bytes, true);
  let s = 123456789;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    let v = Math.round(((s >>> 8) / 8388607.5 - 1) * 33);
    if (v === 0) v = (i & 1) ? 1 : -1;
    dv.setInt16(44 + i * 2, v, true);
  }
  return out;
}
// A hidden looping <audio> element playing that noise for the length of a call, so other apps pause instead of just ducking. start() must run inside the user's tap.
function voiceCreateAudioFocus(opts) {
  const o = opts || {};
  const doc = o.doc, urlApi = o.URL, BlobCtor = o.Blob;
  let el = null, src = null, running = false, gen = 0;   // gen: a play() of an earlier start never changes a later one's state
  function make() {
    if (el) return el;
    if (!doc || typeof doc.createElement !== 'function') return null;
    if (!src) {
      if (!urlApi || typeof urlApi.createObjectURL !== 'function' || typeof BlobCtor !== 'function') return null;
      src = urlApi.createObjectURL(new BlobCtor([voiceFocusWav()], { type: 'audio/wav' }));
    }
    const a = doc.createElement('audio');
    if (!a) return null;
    a.loop = true; a.preload = 'auto'; a.playsInline = true;
    if (typeof a.setAttribute === 'function') { a.setAttribute('playsinline', ''); a.setAttribute('aria-hidden', 'true'); }
    a.muted = false; a.volume = 1;
    if (a.style) a.style.display = 'none';
    a.src = src;
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
    el = a;
    return el;
  }
  return {
    start() {
      if (running) return Promise.resolve(true);
      try {
        const a = make();
        if (!a || typeof a.play !== 'function') return Promise.resolve(false);
        const my = ++gen;
        const p = a.play();
        running = true;
        return Promise.resolve(p).then(() => my === gen, () => { if (my === gen) running = false; return false; });
      } catch { running = false; return Promise.resolve(false); }
    },
    stop() {
      gen++;
      running = false;
      if (!el) return;
      try { if (typeof el.pause === 'function') el.pause(); } catch {}
      try { el.currentTime = 0; } catch {}
    },
    get running() { return running; },
  };
}
// Loudness boost for call replies (dB): the speech engine leaves headroom, and Android's call mode lowers the output further.
const VOICE_LOUDNESS = { normal: 0, louder: 9, loudest: 14 };
// The same levels when the hub already sent the voice normalised to -16 dBFS (header X-Voice-Normalized: 1): less boost is needed.
const VOICE_LOUDNESS_NORMALIZED = { normal: 0, louder: 4, loudest: 8 };
function voiceLoudnessDb(name, normalized) {
  const t = normalized ? VOICE_LOUDNESS_NORMALIZED : VOICE_LOUDNESS;
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(t, name) ? t[name] : t.louder;
}
// Which output a call's sound goes to, from the open microphone's label (the output follows the input route during a call): 'bluetooth' for
// a Bluetooth headset, hands-free or car input, else 'speaker' (the phone or computer speaker; a wired headset counts as speaker). Android's
// Chrome names inputs "Bluetooth headset", "Speakerphone", "Wired headset", "Headset earpiece", "USB audio".
function voiceOutputKind(label) {
  return typeof label === 'string' && /bluetooth|hands[- ]?free|\bhfp\b|airpods|\bcar\b|car audio/i.test(label) ? 'bluetooth' : 'speaker';
}
// The loudness level name for an output kind: the speaker pref, or the Bluetooth / car pref.
function voiceLoudnessFor(prefs, kind) {
  const p = prefs && typeof prefs === 'object' ? prefs : {};
  const v = kind === 'bluetooth' ? p.loudnessBt : p.loudness;
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(VOICE_LOUDNESS, v) ? v : (kind === 'bluetooth' ? 'normal' : 'louder');
}
// The output ceiling: no sample leaves the call chain louder than this (-1 dBFS).
const VOICE_CEILING = Math.pow(10, -1 / 20);
// The compressor's automatic makeup gain at threshold -3 dB, ratio 20, knee 0 is (3 - 3/20) * 0.6 = 1.71 dB; the trim takes it back off,
// so speech below the threshold plays at exactly the chosen loudness. (At -6 dB the compressor held speech near -18.5 dBFS with peaks
// near -4 and left the headroom to the ceiling unused; the curve below is what guarantees the ceiling.)
const VOICE_LIMIT_THRESHOLD_DB = -3;
const VOICE_LIMIT_TRIM_DB = -1.71;
// A fixed safety curve after the compressor: straight up to 0.7 (-3.1 dBFS), then a smooth bend that never reaches the ceiling,
// even for inputs past full scale (a WaveShaper holds its last value there). This is what makes the limit hard: the compressor
// alone lets the first milliseconds of a peak through.
function voiceCeilingCurve(n) {
  const len = Math.max(3, n | 0), k = 0.7, room = VOICE_CEILING - k;
  const curve = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1, a = Math.abs(x);
    const y = a <= k ? a : k + room * Math.tanh((a - k) / room);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}
// One chain per AudioContext: gain -> compressor -> trim -> ceiling curve -> analyser -> destination. Returns null when the context cannot build it.
function voiceCreateLoudness(ctx) {
  if (!ctx) return null;
  try { if (ctx.__voiceLoudness) return ctx.__voiceLoudness; } catch {}
  if (typeof ctx.createGain !== 'function' || typeof ctx.createDynamicsCompressor !== 'function') return null;
  let gain, comp, trim, shaper = null, an = null, db = voiceLoudnessDb('louder'), buf = null;
  try {
    gain = ctx.createGain();
    comp = ctx.createDynamicsCompressor();
    const set = (prm, v) => { try { if (prm && typeof prm === 'object') prm.value = v; } catch {} };
    set(comp.threshold, VOICE_LIMIT_THRESHOLD_DB); set(comp.knee, 0); set(comp.ratio, 20); set(comp.attack, 0.001); set(comp.release, 0.1);
    trim = ctx.createGain();
    set(trim.gain, Math.pow(10, VOICE_LIMIT_TRIM_DB / 20));
    if (typeof ctx.createWaveShaper === 'function') {
      try { shaper = ctx.createWaveShaper(); shaper.curve = voiceCeilingCurve(4097); shaper.oversample = 'none'; } catch { shaper = null; }
    }
    if (typeof ctx.createAnalyser === 'function') { try { an = ctx.createAnalyser(); an.fftSize = 2048; } catch { an = null; } }
    gain.connect(comp);
    comp.connect(trim);
    let last = trim;
    if (shaper) { last.connect(shaper); last = shaper; }
    if (an) { last.connect(an); an.connect(ctx.destination); } else last.connect(ctx.destination);
  } catch { return null; }
  let levelName = 'louder', normalized = false;
  const apply = () => { db = voiceLoudnessDb(levelName, normalized); try { gain.gain.value = Math.pow(10, db / 20); } catch {} };
  apply();
  const chain = {
    input: gain,
    setLevel(name) { levelName = name; apply(); },
    setNormalized(flag) { normalized = !!flag; apply(); },
    get normalized() { return normalized; },
    get gainDb() { return db; },
    meter() {
      try {
        if (!an || typeof an.getFloatTimeDomainData !== 'function') return null;
        if (!buf || buf.length !== (an.fftSize || 2048)) buf = new Float32Array(an.fftSize || 2048);
        an.getFloatTimeDomainData(buf);
        let sum = 0, peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
        const toDb = (x) => (x > 0 ? Math.max(-120, 20 * Math.log10(x)) : -120);
        return { rmsDb: toDb(Math.sqrt(sum / buf.length)), peakDb: toDb(peak) };
      } catch { return null; }
    },
  };
  try { ctx.__voiceLoudness = chain; } catch {}
  return chain;
}
// ── voice helpers (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { VOICE_STORE_KEY, voiceSpeechText, voiceSentences, voiceResample, voiceEncodeWav, voiceDecodeWav, voiceLevelDb,
  voiceGainFromSlider, voiceSliderFromGain, voiceMeterPercent, voiceCleanSpeed, voiceSpeedLabel, VOICE_END_PAUSES, voiceLoadPrefs, voiceSavePrefs, voiceIsStopCommand,
  voicePickLocalVoice, voiceWaitLocalVoice, voiceMicGuard, voiceSoundsUnfinished, VOICE_CONTINUE_WAITS, voiceCleanPrefs,
  VOICE_ECHO_HOLDS, voiceCarChirp, voiceEchoAnalysis, voiceCarCheckResult, VOICE_CAR_AT, VOICE_CAR_END, VOICE_CAR_MAX_DELAY_MS, voiceCarAnalyse,
  VOICE_WAKE_QUIET_MS, voiceCleanWakePhrase, voiceWakeForAgent, voiceWakeMatch, voiceIsSleepCommand, voiceFocusWav, voiceCreateAudioFocus,
  VOICE_LOUDNESS, VOICE_LOUDNESS_NORMALIZED, voiceLoudnessDb, voiceCreateLoudness, voiceOutputKind, voiceLoudnessFor, VOICE_CEILING, VOICE_LIMIT_THRESHOLD_DB, VOICE_LIMIT_TRIM_DB, voiceCeilingCurve };
