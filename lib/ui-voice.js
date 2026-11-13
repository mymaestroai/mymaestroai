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
 *   voicePickLocalVoice(voices, lang)  best offline (localService) voice for the language prefix, or null
 *   voiceWaitLocalVoice(synth, lang, ms)  the same, waiting up to ms for 'voiceschanged' when the list is empty
 *   voiceMicGuard()                    { begin, cancel, fail, settle }: pending flag + generation for a microphone request
 */
// ── voice helpers (begin) ──
const VOICE_STORE_KEY = 'hub-voice';
const VOICE_DETAILS_NOTE = ' I have put the details in the chat.';
const VOICE_ABBREVIATIONS = new Set(['e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'jr', 'sr', 'vs']);
const VOICE_STOP_COMMANDS = new Set(['stop', 'cancel', 'stop stop', 'stop it', 'stop that', 'cancel that', 'never mind', 'nevermind']);
const VOICE_END_PAUSES = [800, 1200, 2000];   // 'Pause before I'm done': short / normal / long, in ms
const VOICE_DEFAULT_PREFS = { micLevel: 50, interruptSensitivity: 50, mode: 'handsfree', readAloud: true, deviceVoiceFallback: true, endPause: 1200, voiceSpeed: 1, speakActivity: false };
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
  for (const k of ['readAloud', 'deviceVoiceFallback', 'speakActivity']) if (typeof raw[k] === 'boolean') p[k] = raw[k];
  return p;
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
// ── voice helpers (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { VOICE_STORE_KEY, voiceSpeechText, voiceSentences, voiceResample, voiceEncodeWav, voiceDecodeWav, voiceLevelDb,
  voiceGainFromSlider, voiceSliderFromGain, voiceMeterPercent, voiceCleanSpeed, voiceSpeedLabel, VOICE_END_PAUSES, voiceLoadPrefs, voiceSavePrefs, voiceIsStopCommand,
  voicePickLocalVoice, voiceWaitLocalVoice, voiceMicGuard };
