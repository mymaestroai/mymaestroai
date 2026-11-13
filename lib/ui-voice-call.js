'use strict';
/**
 * ui-voice-call.js — the hands-free call controller of the chat pages (voice phase 2, part P1): the state machine of a
 * call (listening / hearing / thinking / speaking), how each utterance is routed, barge-in, reading a reply sentence by
 * sentence, spoken status lines, ask_user answered by voice, announcements of held items, heartbeat and the hang-up
 * summary, plus the VAD adapter around MicVAD (vad-web 0.0.31). Everything the controller touches comes in through
 * deps (adapters), so it is tested in Node with fakes. The pages carry byte-identical copies between the markers below
 * (app.js, mobile.js); test/ui-voice-call.test.js proves the copies match. Browser-safe plain JS: no require, every
 * top-level name starts with voice / VOICE_, nothing runs at load time. It uses the helpers of lib/ui-voice.js
 * (voiceSpeechText, voiceSentences, voiceIsStopCommand, voiceLevelDb, voiceGainFromSlider), which the pages carry in the
 * block before this one.
 *
 *   voiceCreateCall(deps)                    the call controller (see the doc of each method inside)
 *   voiceCreateVad(opts)                     { start(handlers), stop(), setPlaybackActive(b), setMicLevel(v), setInterruptSensitivity(v) }
 *   voiceDecisionWord(text)                  'now' | 'later' | 'skip' | null
 *   voiceMatchChoice(text, options)          the matching option label or null
 *   voiceStatusLine(item)                    the spoken status line for a tool activity
 *   voiceRoomCheck(speechDb, silenceDb, currentMicLevel)   { micLevel, interruptSensitivity }
 *   voiceVadThresholds(interruptSensitivity, playing)      { positiveSpeechThreshold, negativeSpeechThreshold, minSpeechFrames }
 *   voiceReplySentences(markdown, done)      { sentences, note }: the complete sentences of a reply so far
 *   voiceJoinOr(list)                        'A, B or C'
 */
// ── voice call (begin) ──
const VOICE_CALL_HEARTBEAT_MS = 15000, VOICE_CALL_STATUS_GAP_MS = 10000, VOICE_CALL_PAUSE_MS = 1500, VOICE_CALL_ANSWER_MS = 20000;
const VOICE_CALL_FILLERS = new Set(['uh', 'um', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'hm', 'mm', 'mmm', 'huh']);
const VOICE_CALL_ORDINALS = [['first', '1st', 'one', '1'], ['second', '2nd', 'two', '2'], ['third', '3rd', 'three', '3'], ['fourth', '4th', 'four', '4'], ['fifth', '5th', 'five', '5']];
function voiceCallNorm(text) {
  return String(text == null ? '' : text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function voiceJoinOr(list) {
  const a = Array.from(list || []).filter(Boolean);
  return a.length < 2 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1];
}
function voiceDecisionWord(text) {
  const t = voiceCallNorm(text);
  if (!t || t.split(' ').length > 6) return null;
  if (/\b(later|after|afterwards|not now|wait|hold on)\b/.test(t)) return 'later';
  if (/\b(skip|no|nope|decline|cancel it|drop it|dismiss)\b/.test(t)) return 'skip';
  if (/\b(now|go ahead|yes|yeah|yep|sure)\b/.test(t)) return 'now';
  return null;
}
function voiceMatchChoice(text, options) {
  const labels = Array.from(options || []).map(o => (typeof o === 'string' ? o : (o && (o.label || o.value || o.text)) || '')).filter(Boolean);
  const t = voiceCallNorm(text);
  if (!t || !labels.length) return null;
  const norm = labels.map(voiceCallNorm);
  let i = norm.indexOf(t);
  if (i >= 0) return labels[i];
  const byLen = norm.map((n, k) => k).filter(k => norm[k]).sort((a, b) => norm[b].length - norm[a].length);
  for (const k of byLen) if ((' ' + t + ' ').includes(' ' + norm[k] + ' ')) return labels[k];
  const words = t.split(' ');
  for (const w of words) {
    const k = VOICE_CALL_ORDINALS.findIndex(set => set.includes(w));
    if (k >= 0 && k < labels.length) return labels[k];
  }
  i = norm.findIndex(n => n && n.split(' ')[0] === words[0] && words[0].length > 1);
  return i >= 0 ? labels[i] : null;
}
function voiceStatusLine(item) {
  const s = (typeof item === 'string' ? item : item && (item.tool || item.name || item.label || item.kind || item.type) || '').toString().toLowerCase();
  if (/consult|agent|delegate/.test(s)) return 'Asking another agent.';
  if (/web|search|fetch|browse|url/.test(s)) return 'Searching the web.';
  if (/bash|shell|command|exec|terminal|\brun/.test(s)) return 'Running a command.';
  if (/read|file|grep|glob|\bls\b|view/.test(s)) return 'Reading a file.';
  return 'Working on it.';
}
function voiceCallMedian(list) {
  const a = Array.from(list || []).filter(x => Number.isFinite(x) && x > -100).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function voiceRoomCheck(speechDb, silenceDb, currentMicLevel) {
  const cur = Number.isFinite(currentMicLevel) ? Math.max(0, Math.min(100, currentMicLevel)) : 50;
  const speech = voiceCallMedian(speechDb), noise = voiceCallMedian(silenceDb);
  if (speech === null) return { micLevel: cur, interruptSensitivity: 50 };
  const micLevel = Math.round(Math.max(0, Math.min(100, cur + (-20 - speech) * 50 / 12)));
  const gap = noise === null ? 60 : speech - noise;
  const interruptSensitivity = Math.round(Math.max(10, Math.min(90, 10 + (gap - 10) / 30 * 60)));
  return { micLevel, interruptSensitivity };
}
function voiceVadThresholds(interruptSensitivity, playing) {
  if (!playing) return { positiveSpeechThreshold: 0.5, negativeSpeechThreshold: 0.35, minSpeechFrames: 3 };
  const s = Number.isFinite(Number(interruptSensitivity)) ? Math.max(0, Math.min(100, Number(interruptSensitivity))) : 50;
  const positive = 0.9 - 0.4 * s / 100;
  return { positiveSpeechThreshold: +positive.toFixed(3), negativeSpeechThreshold: +(positive - 0.15).toFixed(3), minSpeechFrames: Math.round(8 - 5 * s / 100) };
}
function voiceReplySentences(markdown, done) {
  const note = voiceSpeechText('| a |');
  let t = voiceSpeechText(markdown), hasNote = false;
  if (t === note) { t = ''; hasNote = true; } else if (t.endsWith(' ' + note)) { t = t.slice(0, -note.length).trim(); hasNote = true; }
  const sentences = voiceSentences(t).filter(Boolean);
  if (!done && sentences.length && !(/[.!?]["')\]]*$/.test(t) && /\s$/.test(String(markdown)))) sentences.pop();
  return { sentences, note: hasNote ? note : '' };
}
function voiceCreateCall(deps) {
  const d = deps || {};
  const ui = Object.assign({ state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {} }, d.ui);
  const server = d.server || {}, vad = d.vad || {};
  const now = () => d.now();
  const quiet = (fn) => { try { return fn(); } catch { return undefined; } };
  let state = '', mode = 'announce', ended = false, started = false, endPromise = null;
  let personSpeaking = false, speechEndAt = null, awaitingReply = false, cutSkip = false;
  let lastText = '', spokenCount = 0, noteSpoken = false, lastStatusAt = null;
  let queue = [], current = null, speaking = false, gen = 0;
  let heldList = [], announceQueue = [], pendingAnnounce = null, pendingAsk = null;
  let hbTimer = null, pumpTimer = null, sttChain = Promise.resolve();

  function setState(name) { if (name === state) return; state = name; quiet(() => ui.state(name, '')); }
  function settle() {
    if (ended) return;
    setState(speaking ? 'speaking' : personSpeaking ? 'hearing' : awaitingReply ? 'thinking' : 'listening');
    pumpAnnounce();
  }
  function runAfter(item) { if (item && item.after) { const f = item.after; item.after = null; quiet(f); } }
  function enqueue(text, kind, after) {
    if (ended || !text) return;
    queue.push({ text, kind, after });
    if (!speaking) runQueue();
  }
  async function runQueue() {
    const my = gen;
    speaking = true; setState('speaking'); quiet(() => vad.setPlaybackActive(true));
    while (queue.length && my === gen) {
      current = queue.shift();
      let ok = true;
      try { ok = await d.speak(current.text); } catch { ok = false; }
      if (my !== gen) return;
      const item = current; current = null;
      if (ok === false) { for (const q of queue) runAfter(q); queue = []; }
      runAfter(item);
    }
    if (my !== gen) return;
    speaking = false; quiet(() => vad.setPlaybackActive(false));
    settle();
  }
  // Cuts what is being read at once. True when part of a reply was cut (the rest of that reply is then skipped).
  function cancelSpeaking() {
    const items = (current ? [current] : []).concat(queue);
    const hadReply = items.some(i => i.kind === 'reply');
    gen++; queue = []; current = null;
    if (speaking) { speaking = false; quiet(() => vad.setPlaybackActive(false)); }
    quiet(() => d.cancelSpeech());
    items.forEach(runAfter);
    return hadReply;
  }

  function completeCount() { return voiceReplySentences(lastText, false).sentences.length; }
  // Reply text so far (markdown) and whether the turn is over: speaks the complete sentences that are new.
  function onReplyText(full, done) {
    if (ended) return;
    lastText = String(full == null ? '' : full);
    if (!done && !awaitingReply && !cutSkip) awaitingReply = true;
    const r = voiceReplySentences(lastText, !!done);
    if (r.sentences.length < spokenCount) spokenCount = 0;
    if (cutSkip) spokenCount = r.sentences.length;
    else { for (const s of r.sentences.slice(spokenCount)) enqueue(s, 'reply'); spokenCount = r.sentences.length; }
    if (done) {
      if (!cutSkip && r.note && !noteSpoken) enqueue(r.note, 'reply');
      noteSpoken = true; awaitingReply = false;
      if (!speaking) settle();
    }
  }
  function onActivity(item) {
    if (ended || state !== 'thinking' || speaking || personSpeaking || pendingAsk || pendingAnnounce) return;
    if (!awaitingReply && !quiet(() => d.isTurnRunning())) return;
    if (lastStatusAt !== null && now() - lastStatusAt < VOICE_CALL_STATUS_GAP_MS) return;
    lastStatusAt = now();
    enqueue(voiceStatusLine(item), 'status');
  }

  function onAsk(ask) {
    if (ended || !ask) return;
    const options = Array.from(ask.options || []).map(o => (typeof o === 'string' ? o : (o && (o.label || o.value || o.text)) || '')).filter(Boolean);
    pendingAsk = { id: ask.request_id, options, free: !options.length || ask.allow_free_text === true || ask.allow_other === true, reasked: false };
    enqueue(String(ask.question || '') + (options.length ? ' Options: ' + voiceJoinOr(options) + '.' : ''), 'ask');
  }
  function onAskDone(id) { if (pendingAsk && (id == null || pendingAsk.id === id)) pendingAsk = null; }

  function showHeld() { quiet(() => ui.held(heldList.map(h => Object.assign({}, h)))); }
  function onHeld(item, quietFlag) {
    if (ended || !item || heldList.some(h => h.id === item.id)) return;
    const entry = Object.assign({}, item, { later: false, announced: false });
    heldList.push(entry); showHeld();
    if (!quietFlag && mode === 'announce') { announceQueue.push(entry); pumpAnnounce(); }
  }
  function onHeldDone(id) {
    heldList = heldList.filter(h => h.id !== id); announceQueue = announceQueue.filter(h => h.id !== id);
    if (pendingAnnounce && pendingAnnounce.id === id) { quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; }
    showHeld(); settle();
  }
  function decide(id, choice) {
    const entry = heldList.find(h => h.id === id);
    if (!entry || !['now', 'later', 'skip'].includes(choice)) return;
    announceQueue = announceQueue.filter(h => h.id !== id);
    if (pendingAnnounce && pendingAnnounce.id === id) { quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; }
    if (choice === 'later') entry.later = true; else heldList = heldList.filter(h => h.id !== id);
    showHeld();
    const failed = () => quiet(() => ui.toast('Could not send that choice.'));
    try { Promise.resolve(server.decide(id, choice)).catch(failed); } catch { failed(); }
    settle();
  }
  function pumpAnnounce() {
    if (pumpTimer !== null) { quiet(() => d.clearTimer(pumpTimer)); pumpTimer = null; }
    if (ended || state !== 'listening' || speaking || personSpeaking || pendingAsk || pendingAnnounce || !announceQueue.length) return;
    const wait = speechEndAt === null ? 0 : VOICE_CALL_PAUSE_MS - (now() - speechEndAt);
    if (wait > 0) { pumpTimer = d.setTimer(() => { pumpTimer = null; pumpAnnounce(); }, wait); return; }
    const item = announceQueue.shift();
    item.announced = true;
    const me = { id: item.id, timer: null };
    pendingAnnounce = me;
    const start = () => {
      if (pendingAnnounce !== me) return;
      me.timer = d.setTimer(() => { if (pendingAnnounce === me) decide(me.id, 'later'); }, VOICE_CALL_ANSWER_MS);
    };
    enqueue(String(item.label || 'Something came in').replace(/[.!?\s]+$/, '') + '. Now, or after we\'re done?', 'announce', start);
  }
  function setMode(m) {
    if (m !== 'announce' && m !== 'dnd') return;
    mode = m;
    if (m === 'dnd') announceQueue = [];
    else announceQueue = heldList.filter(h => !h.later && !h.announced && !(pendingAnnounce && pendingAnnounce.id === h.id));
    quiet(() => server.mode(m));
    pumpAnnounce();
  }

  function onSpeechStart() {
    if (ended) return;
    personSpeaking = true;
    if (speaking || queue.length) { if (cancelSpeaking() && awaitingReply) cutSkip = true; }
    setState('hearing');
  }
  function onSpeechEnd(audio) {
    if (ended) return Promise.resolve();
    personSpeaking = false; speechEndAt = now();
    settle();
    sttChain = sttChain.then(async () => {
      let text = '';
      try { text = await d.stt(audio); } catch { quiet(() => ui.toast('Could not transcribe that.')); return; }
      if (ended) return;
      const t = String(text || '').trim(), n = voiceCallNorm(t);
      if (n.length < 2 || n.split(' ').every(w => VOICE_CALL_FILLERS.has(w))) return;
      quiet(() => ui.heard(t));
      await route(t);
    });
    return sttChain;
  }
  async function route(t) {
    if (voiceIsStopCommand(t)) {
      cancelSpeaking(); cutSkip = true; awaitingReply = false;
      quiet(() => d.stop()); enqueue('Stopped.', 'stop'); settle();
      return;
    }
    if (pendingAnnounce) {
      const id = pendingAnnounce.id, w = voiceDecisionWord(t);
      decide(id, w || 'later');
      if (w) return;
    }
    if (pendingAsk) {
      const a = pendingAsk, label = voiceMatchChoice(t, a.options);
      if (label !== null || a.free) { pendingAsk = null; quiet(() => d.answerAsk(a.id, label !== null ? label : t)); return; }
      if (!a.reasked) { a.reasked = true; enqueue('Please say one of: ' + voiceJoinOr(a.options) + '.', 'ask'); }
      return;
    }
    try {
      if (quiet(() => d.isTurnRunning())) {
        if (cutSkip) { cutSkip = false; spokenCount = completeCount(); }
        awaitingReply = true; setState('thinking');
        await d.interject(t);
      } else {
        awaitingReply = true; cutSkip = false; spokenCount = 0; noteSpoken = false; lastText = '';
        setState('thinking');
        await d.send(t);
      }
    } catch { awaitingReply = false; quiet(() => ui.toast('Could not send that.')); settle(); }
  }

  function beat() {
    hbTimer = d.setTimer(() => {
      hbTimer = null;
      if (ended) return;
      Promise.resolve().then(() => server.heartbeat()).catch(() => {});
      beat();
    }, VOICE_CALL_HEARTBEAT_MS);
  }
  async function start() {
    if (started) return !ended;
    started = true; setState('starting');
    const fail = async (msg) => { quiet(() => ui.toast(msg)); ended = true; setState('ended'); await Promise.resolve().then(() => server.end()).catch(() => {}); return false; };
    // The microphone starts first, still inside the tap that began the call (iOS needs that for audio); the server next.
    let vadErr = null;
    let vadStarting;
    try {
      vadStarting = Promise.resolve(vad.start({
        onSpeechStart, onSpeechEnd,
        onFrame: (db, probs) => quiet(() => ui.level(db, probs)),
      })).catch((e) => { vadErr = e || new Error('no microphone'); });
    } catch (e) { vadErr = e || new Error('no microphone'); vadStarting = Promise.resolve(); }
    try { await server.start(mode); } catch (e) { await vadStarting; quiet(() => vad.stop()); return fail('Could not start the call: ' + (e && e.message || e)); }
    await vadStarting;
    if (ended) { quiet(() => vad.stop()); return false; }   // hung up while starting: a microphone that came up late is let go
    if (vadErr) return fail('Could not start the microphone: ' + (vadErr.message || vadErr));
    beat(); settle();
    return true;
  }
  // Hangs up: stops listening and speaking, tells the server and reads out what came in while we talked.
  function hangUp() {
    if (endPromise) return endPromise;
    ended = true;
    for (const t of [hbTimer, pumpTimer, pendingAnnounce && pendingAnnounce.timer]) if (t) quiet(() => d.clearTimer(t));
    hbTimer = pumpTimer = null; pendingAnnounce = null; pendingAsk = null; announceQueue = [];
    quiet(() => vad.stop()); cancelSpeaking(); setState('ended');
    endPromise = Promise.resolve().then(() => server.end()).then(r => (r && Array.isArray(r.held) ? r.held : []), () => []).then((held) => {
      if (held.length) {
        const labels = held.map(h => String(h.label || h.kind || 'something').replace(/[.!?\s]+$/, ''));
        const n = held.length;
        const text = 'While we talked: ' + (n === 1 ? '1 thing came in' : n + ' things came in') + ': ' + labels.join(', ') + '. ' + (n === 1 ? 'It runs now.' : 'They run now.');
        quiet(() => ui.summary(text));
        quiet(() => Promise.resolve(d.speak(text)).catch(() => {}));   // spoken in the background: hanging up never waits for it
      }
      return held;
    });
    return endPromise;
  }
  return {
    start, hangUp, onSpeechStart, onSpeechEnd, onReplyText, onActivity, onAsk, onAskDone, onHeld, onHeldDone, decide, setMode,
    get state() { return state; }, get mode() { return mode; }, get held() { return heldList.map(h => Object.assign({}, h)); },
  };
}
// The microphone and the voice activity detector. opts: { baseUrl, micLevel, interruptSensitivity, win, nav, loadScript }.
// MicVAD 0.0.31 only takes getStream (no stream option), so the stream it gets is built here: microphone (echo
// cancellation, noise suppression and auto gain on) -> GainNode (the Mic level) -> MediaStreamDestination; the VAD
// listens to that destination stream, so the gain acts on what it hears and on what is sent to transcription.
function voiceCreateVad(opts) {
  const o = opts || {};
  const base = o.baseUrl || '/api/voice/web/';
  const st = { micLevel: o.micLevel, sens: o.interruptSensitivity, playing: false, vad: null, ctx: null, gain: null, raw: null };
  const win = () => o.win || window;
  const loadScript = o.loadScript || ((src) => new Promise((resolve, reject) => {
    const el = win().document.createElement('script');
    el.src = src; el.onload = () => resolve(); el.onerror = () => reject(new Error('could not load ' + src));
    win().document.head.appendChild(el);
  }));
  const apply = () => {
    const t = voiceVadThresholds(st.sens, st.playing);
    if (st.vad) st.vad.setOptions({ positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold, minSpeechMs: t.minSpeechFrames * 32 });
  };
  async function start(h) {
    const w = win(), handlers = h || {};
    // The audio context is made and resumed first, still inside the tap that started the call: iOS keeps a context
    // suspended when it is made after an await.
    const Ctx = w.AudioContext || w.webkitAudioContext;
    st.ctx = new Ctx(); const resumed = st.ctx.resume();
    if (!w.vad || !w.vad.MicVAD) { await loadScript(base + 'ort.wasm.min.js'); await loadScript(base + 'bundle.min.js'); }
    await resumed;
    const nav = o.nav || w.navigator;
    const t = voiceVadThresholds(st.sens, false);
    try {
      st.vad = await w.vad.MicVAD.new({
        model: 'v5', audioContext: st.ctx, baseAssetPath: base, onnxWASMBasePath: base,
        ortConfig: (c) => { c.env.wasm.numThreads = 1; },
        getStream: async () => {
          st.raw = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          const src = st.ctx.createMediaStreamSource(st.raw), dest = st.ctx.createMediaStreamDestination();
          st.gain = st.ctx.createGain(); st.gain.gain.value = voiceGainFromSlider(st.micLevel);
          src.connect(st.gain); st.gain.connect(dest);
          return dest.stream;
        },
        pauseStream: async () => {}, resumeStream: async (s) => s,
        positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold,
        redemptionMs: 384, preSpeechPadMs: 256, minSpeechMs: t.minSpeechFrames * 32,
        onSpeechStart: () => { if (handlers.onSpeechStart) handlers.onSpeechStart(); },
        onSpeechEnd: (audio) => (handlers.onSpeechEnd ? handlers.onSpeechEnd(audio) : undefined),
        onVADMisfire: () => { if (handlers.onMisfire) handlers.onMisfire(); },
        onFrameProcessed: (probs, frame) => { if (handlers.onFrame) handlers.onFrame(voiceLevelDb(frame), probs); },
      });
      await st.vad.start();
    } catch (e) { await stop(); throw e; }
  }
  async function stop() {
    const { vad, raw, ctx } = st;
    st.vad = st.raw = st.ctx = st.gain = null;
    try { if (vad) await vad.destroy(); } catch { /* already gone */ }
    try { if (raw) raw.getTracks().forEach(tr => tr.stop()); } catch { /* already stopped */ }
    try { if (ctx) await ctx.close(); } catch { /* already closed */ }
  }
  return {
    start, stop,
    setPlaybackActive(on) { st.playing = !!on; apply(); },
    setMicLevel(v) { st.micLevel = v; if (st.gain) st.gain.gain.value = voiceGainFromSlider(v); },
    setInterruptSensitivity(v) { st.sens = v; apply(); },
  };
}
// ── voice call (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { voiceCreateCall, voiceCreateVad, voiceDecisionWord, voiceMatchChoice, voiceStatusLine,
  voiceRoomCheck, voiceVadThresholds, voiceReplySentences, voiceJoinOr };
