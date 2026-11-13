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
 *   voiceCreateThinkingSound({ ctx, volume }) { start(), stop(), setVolume(v) }: the soft pulse heard while a reply is being thought of
 *   voiceLiveTracks()                        how many microphone tracks the VAD adapter made are still live (test hook)
 *   voiceCreateVad(opts)                     { start(handlers), stop(), setPlaybackActive(b), setMicLevel(v), setInterruptSensitivity(v), setEndPause(ms) }
 *   voiceDecisionWord(text)                  'now' | 'later' | 'skip' | null
 *   voiceMatchChoice(text, options)          the matching option label or null
 *   voiceStatusLine(item)                    the status line for a tool activity (shown silently; spoken only with the speakActivity pref)
 *   voiceRoomCheck(speechDb, silenceDb, currentMicLevel)   { micLevel, interruptSensitivity }
 *   voiceVadThresholds(interruptSensitivity, playing)      { positiveSpeechThreshold, negativeSpeechThreshold, minSpeechFrames }
 *   voiceReplySentences(markdown, done)      { sentences, note }: the complete sentences of a reply so far
 *   voiceJoinOr(list)                        'A, B or C'
 */
// ── voice call (begin) ──
const VOICE_CALL_HEARTBEAT_MS = 15000, VOICE_CALL_STATUS_GAP_MS = 10000, VOICE_CALL_PAUSE_MS = 1500, VOICE_CALL_ANSWER_MS = 20000;
const VOICE_CALL_JOIN_MS = 2000, VOICE_CALL_STILL_MS = 20000, VOICE_CALL_THINK_MS = 2000, VOICE_CALL_CONTINUE_MS = 3000, VOICE_CALL_HOLD_MS = 5000, VOICE_CALL_WAIT_HOLD_MS = 20000;
// After 20 s with no reply speech, ONE of these is spoken (never the same one twice in a wait).
const VOICE_THINKING_LINES = ['I\'m considering what you just said.', 'Still thinking about that.', 'Give me a moment, I\'m working through it.'];
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
  let t = voiceSpeechText(markdown, !done), hasNote = false;
  if (t === note) { t = ''; hasNote = true; } else if (t.endsWith(' ' + note)) { t = t.slice(0, -note.length).trim(); hasNote = true; }
  const sentences = voiceSentences(t).filter(Boolean);
  if (!done && sentences.length && !(/[.!?]["')\]]*$/.test(t) && /\s$/.test(String(markdown)))) sentences.pop();
  return { sentences, note: hasNote ? note : '' };
}
function voiceCreateCall(deps) {
  const d = deps || {};
  const ui = Object.assign({ state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {} }, d.ui);
  const server = d.server || {}, vad = d.vad || {};
  const now = () => d.now();
  const quiet = (fn) => { try { return fn(); } catch { return undefined; } };
  let state = '', mode = 'announce', ended = false, started = false, endPromise = null;
  let personSpeaking = false, speechEndAt = null, awaitingReply = false, cutSkip = false;
  let lastText = '', spokenCount = 0, noteSpoken = false, lastStatusAt = null;
  let queue = [], current = null, speaking = false, gen = 0;
  let heldList = [], announceQueue = [], pendingAnnounce = null, pendingAsk = null;
  let hbTimer = null, pumpTimer = null, sttChain = Promise.resolve();
  let callId = null, startP = null, sttPending = 0, speechAnn = null, cutRec = null, lastDone = false;
  // Joining pieces of one sentence: lastSeg is the latest speech segment (its transcript may still be pending), curCand the
  // earlier segment a new one may join, segActive that a segment has begun and has not ended.
  let lastSeg = null, curCand = null, segActive = false;
  // The one spoken line after a long wait: when something was last spoken, when the running turn began, whether a line was
  // said since, which lines this wait has used. The thinking sound: its 2 s timer and whether it is playing.
  let lastSpokenAt = null, turnAt = null, stillSaid = false, stillTimer = null, stillUsed = [];
  let thinkTimer = null, thinkingOn = false;
  const prefs = () => { const p = quiet(() => d.prefs && d.prefs()); return p && typeof p === 'object' ? p : {}; };
  // 'Wait for me to go on': how long a sentence that sounds unfinished waits for the next piece.
  const continueWait = () => { const n = Number(prefs().continueWait); return Number.isFinite(n) && n >= 0 ? n : VOICE_CALL_CONTINUE_MS; };

  // The thinking sound: only when the person's turn was sent and no reply speech began within 2 s; it stops at once when the
  // reply speaks, the person speaks, an announcement plays, the turn ends or the call ends. Nothing plays when a turn ends.
  function stopThinking() {
    if (thinkTimer !== null) { quiet(() => d.clearTimer(thinkTimer)); thinkTimer = null; }
    if (!thinkingOn) return;
    thinkingOn = false;
    quiet(() => d.thinking.stop());
    if (!speaking) quiet(() => vad.setPlaybackActive(false));
  }
  function armThinking() {
    if (ended || thinkTimer !== null || thinkingOn || !awaitingReply || !d.thinking || prefs().thinkingSound === false) return;
    thinkTimer = d.setTimer(() => {
      thinkTimer = null;
      if (ended || !awaitingReply || speaking || personSpeaking || pendingAnnounce || queue.length || prefs().thinkingSound === false) return;
      thinkingOn = true;
      quiet(() => vad.setPlaybackActive(true));   // the pulse is playback: it must not trigger the barge-in detector
      quiet(() => d.thinking.start());
    }, VOICE_CALL_THINK_MS);
  }
  // The person's settings changed (the in-chat voice panel): re-read them now.
  function setPrefs() {
    const p = prefs();
    if (p.thinkingSound === false) stopThinking(); else armThinking();
    if (d.thinking && d.thinking.setVolume && Number.isFinite(Number(p.thinkingVolume))) quiet(() => d.thinking.setVolume(Math.max(0, Math.min(1, Number(p.thinkingVolume)))));
  }

  function clearStill() { if (stillTimer !== null) { quiet(() => d.clearTimer(stillTimer)); stillTimer = null; } }
  // One spoken line (VOICE_THINKING_LINES) when a turn runs and nothing was said for 20 s; not again until something else is said.
  function armStill() {
    if (ended || stillTimer !== null || stillSaid || !awaitingReply) return;
    const since = Math.max(lastSpokenAt === null ? -Infinity : lastSpokenAt, turnAt === null ? -Infinity : turnAt);
    const wait = Number.isFinite(since) ? Math.max(200, VOICE_CALL_STILL_MS - (now() - since)) : VOICE_CALL_STILL_MS;
    stillTimer = d.setTimer(checkStill, wait);
  }
  function checkStill() {
    stillTimer = null;
    if (ended || stillSaid || !awaitingReply) return;
    if (speaking || personSpeaking || sttPending || pendingAsk || pendingAnnounce || queue.length) return;   // settle() arms it again when it is quiet
    const since = Math.max(lastSpokenAt === null ? -Infinity : lastSpokenAt, turnAt === null ? -Infinity : turnAt);
    if (Number.isFinite(since) && now() - since < VOICE_CALL_STILL_MS) { armStill(); return; }
    stillSaid = true;
    let fresh = VOICE_THINKING_LINES.filter(l => !stillUsed.includes(l));
    if (!fresh.length) { stillUsed = []; fresh = VOICE_THINKING_LINES; }
    const line = fresh[0]; stillUsed.push(line);   // never the same line twice in one wait
    enqueue(line, 'still');
  }
  function setState(name) { if (name === state) return; state = name; quiet(() => ui.state(name, '')); }
  function settle() {
    if (ended) return;
    if (!speaking && !personSpeaking && queue.length) { runQueue(); return; }   // lines that waited while the person spoke are read now
    setState(speaking ? 'speaking' : personSpeaking ? 'hearing' : awaitingReply ? 'thinking' : 'listening');
    pumpAnnounce();
    armStill();
    if (awaitingReply && !speaking && !personSpeaking) armThinking();   // a long quiet stretch inside a running turn gets the sound too
  }
  function runAfter(item) { if (item && item.after) { const f = item.after; item.after = null; quiet(f); } }
  function enqueue(text, kind, after, onStart) {
    if (ended || !text) return;
    queue.push({ text, kind, after, onStart });
    if (!speaking && !personSpeaking) runQueue();   // never start reading while the person is speaking: the line waits
  }
  async function runQueue() {
    const my = gen;
    speaking = true; stopThinking(); setState('speaking'); quiet(() => vad.setPlaybackActive(true));
    while (queue.length && my === gen && !personSpeaking) {
      current = queue.shift();
      if (current.onStart) { const f = current.onStart; current.onStart = null; quiet(f); }   // the line really starts playing
      let ok = true;
      lastSpokenAt = now();
      try { ok = await d.speak(current.text); } catch { ok = false; }
      if (my !== gen) return;
      const item = current; current = null;
      lastSpokenAt = now();
      if (item.kind !== 'still') stillSaid = false;   // something new was said: the next long silence may be filled again
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
    lastText = String(full == null ? '' : full); lastDone = !!done;
    if (!done && !awaitingReply && !cutSkip) awaitingReply = true;
    const r = voiceReplySentences(lastText, !!done);
    if (r.sentences.length < spokenCount) spokenCount = 0;
    if (cutSkip) spokenCount = r.sentences.length;
    else { for (const s of r.sentences.slice(spokenCount)) enqueue(s, 'reply'); spokenCount = r.sentences.length; }
    if (done) {
      if (!cutSkip && r.note && !noteSpoken) enqueue(r.note, 'reply');
      noteSpoken = true; awaitingReply = false;
      clearStill(); stopThinking(); quiet(() => ui.activity(''));
      if (!speaking) settle();
    }
  }
  // A tool activity of the running turn: shown silently (ui.activity); spoken only when the page's speakActivity() says so.
  function onActivity(item) {
    if (ended) return;
    if (!awaitingReply && !quiet(() => d.isTurnRunning())) return;
    quiet(() => ui.activity(voiceStatusLine(item)));
    if (state !== 'thinking' || speaking || personSpeaking || pendingAsk || pendingAnnounce) return;
    if (!quiet(() => d.speakActivity && d.speakActivity())) return;
    if (lastStatusAt !== null && now() - lastStatusAt < VOICE_CALL_STATUS_GAP_MS) return;
    lastStatusAt = now();
    enqueue(voiceStatusLine(item), 'status');
  }

  function onAsk(ask) {
    if (ended || !ask) return;
    const options = Array.from(ask.options || []).map(o => (typeof o === 'string' ? o : (o && (o.label || o.value || o.text)) || '')).filter(Boolean);
    pendingAsk = { id: ask.request_id, options, free: !options.length || ask.allow_free_text === true || ask.allow_other === true, reasked: false, tapped: false };
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
  // The hub says an item was decided. 'later' keeps it (deferred: shown with "later", buttons stay, not announced again);
  // 'now' and 'skip' (or no choice) remove it.
  function onHeldDone(id, choice) {
    announceQueue = announceQueue.filter(h => h.id !== id);
    if (pendingAnnounce && pendingAnnounce.id === id) { quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; }
    if (choice === 'later') { const e = heldList.find(h => h.id === id); if (e) { e.later = true; e.announced = true; } }
    else heldList = heldList.filter(h => h.id !== id);
    showHeld(); settle();
  }
  // The hub's list of held items (the start answer, every heartbeat answer): merged by id, a known item keeps its state.
  function hydrate(list) {
    if (ended || !Array.isArray(list)) return;
    let changed = false;
    for (const item of list) {
      if (!item || item.id == null) continue;
      const known = heldList.find(h => h.id === item.id);
      // 'allowed': the person said now and the producer runs it; 'done': it ran. Neither waits for a decision any more.
      if (item.state === 'done' || item.state === 'allowed') {
        if (known) { heldList = heldList.filter(h => h !== known); announceQueue = announceQueue.filter(h => h !== known); changed = true; }
        // decided elsewhere (another device, an admin) while it was being asked: the question is over, the next one may come
        if (pendingAnnounce && pendingAnnounce.id === item.id) { if (pendingAnnounce.timer !== null) quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; changed = true; }
        continue;
      }
      if (known) { if (item.state === 'later' && !known.later) { known.later = true; known.announced = true; changed = true; } continue; }
      const later = item.state === 'later';
      const entry = Object.assign({}, item, { later, announced: later });
      heldList.push(entry); changed = true;
      if (!later && mode === 'announce') announceQueue.push(entry);
    }
    if (changed) { showHeld(); pumpAnnounce(); }
  }
  function decide(id, choice) {
    const entry = heldList.find(h => h.id === id);
    if (!entry || !['now', 'later', 'skip'].includes(choice)) return;
    announceQueue = announceQueue.filter(h => h.id !== id);
    if (pendingAnnounce && pendingAnnounce.id === id) { quiet(() => d.clearTimer(pendingAnnounce.timer)); pendingAnnounce = null; }
    if (choice === 'later') entry.later = true; else heldList = heldList.filter(h => h.id !== id);
    showHeld();
    const failed = () => quiet(() => ui.toast('Could not send that choice.'));
    try { Promise.resolve(server.decide(id, choice, callId)).catch(failed); } catch { failed(); }
    settle();
  }
  function pumpAnnounce() {
    if (pumpTimer !== null) { quiet(() => d.clearTimer(pumpTimer)); pumpTimer = null; }
    if (ended || state !== 'listening' || speaking || personSpeaking || sttPending || pendingAsk || pendingAnnounce || !announceQueue.length) return;
    const wait = speechEndAt === null ? 0 : VOICE_CALL_PAUSE_MS - (now() - speechEndAt);
    if (wait > 0) { pumpTimer = d.setTimer(() => { pumpTimer = null; pumpAnnounce(); }, wait); return; }
    const item = announceQueue.shift();
    item.announced = true;
    const me = { id: item.id, timer: null, heard: false };
    pendingAnnounce = me;
    const start = () => {
      if (pendingAnnounce !== me) return;
      me.timer = d.setTimer(() => { if (pendingAnnounce === me) decide(me.id, 'later'); }, VOICE_CALL_ANSWER_MS);
    };
    enqueue(String(item.label || 'Something came in').replace(/[.!?\s]+$/, '') + '. Now, or after we\'re done?', 'announce', start, () => { me.heard = true; });
  }
  function setMode(m) {
    if (m !== 'announce' && m !== 'dnd') return;
    mode = m;
    if (m === 'dnd') announceQueue = [];
    else announceQueue = heldList.filter(h => !h.later && !h.announced && !(pendingAnnounce && pendingAnnounce.id === h.id));
    quiet(() => Promise.resolve(server.mode(m, callId)).catch(() => {}));
    pumpAnnounce();
  }

  // The first speech-like frame (vad-web onSpeechStart): the person may be starting to talk. Nothing new is started over
  // them, and an answer belongs to the announcement that was pending at this moment. A false start ends in onMisfire.
  // An answer belongs to an announcement only once its line started playing (talking over it to answer is fine) or was
  // read out (its answer timer runs from then); a line still waiting in the queue was not heard yet.
  const heardAnnouncement = () => (pendingAnnounce && pendingAnnounce.heard ? pendingAnnounce.id : null);   // heard: its line started playing
  // A first frame that is followed by nothing (the audio stopped: an incoming phone call, a suspended audio context)
  // must not leave the call deaf and mute: after 4 s without real speech, a misfire or an end, it is let go.
  let beginTimer = null;
  const clearBegin = () => { if (beginTimer !== null) { quiet(() => d.clearTimer(beginTimer)); beginTimer = null; } };
  // A new speech segment begins. When the previous one ended less than 2 s ago and its transcript is not sent yet (still
  // being transcribed, or waiting in line), the previous one is held back: it is joined with this segment into one message.
  function segmentStarting() {
    if (segActive) return;
    segActive = true;
    const c = lastSeg;
    // The earlier piece qualifies when it ended less than 2 s ago, or when it sounded unfinished and is waiting for more.
    if (c && !c.done && !c.hold && (c.waiting || now() - c.endAt <= VOICE_CALL_JOIN_MS)) {
      let resolve; const promise = new Promise((r) => { resolve = r; });
      c.hold = { promise, resolve }; curCand = c;
      if (c.onJoin) { const f = c.onJoin; c.onJoin = null; quiet(f); }   // the wait for more is over: the next piece is coming
    } else curCand = null;
  }
  // The segment was a false start: the held one is sent on its own after all.
  function segmentDropped() {
    segActive = false;
    const c = curCand; curCand = null;
    if (c && c.hold) { c.hold.resolve(null); c.hold = null; }
  }
  function onSpeechBegin() {
    if (ended || personSpeaking) return;
    personSpeaking = true; stopThinking();
    speechAnn = heardAnnouncement();
    clearBegin();
    segmentStarting();
    // Real speech, a misfire and an end all clear this timer, so when it fires no real start came: let the false start go.
    beginTimer = d.setTimer(() => { beginTimer = null; if (!ended && personSpeaking) { personSpeaking = false; speechAnn = null; segmentDropped(); settle(); } }, 4000);
  }
  // Real speech began (the VAD adapter calls this from onSpeechRealStart, so a cough or a click does not cut the reading).
  function onSpeechStart() {
    if (ended) return;
    clearBegin();
    if (!personSpeaking) speechAnn = heardAnnouncement();   // no onSpeechBegin came first
    personSpeaking = true; stopThinking();
    segmentStarting();
    if (speaking || queue.length) {
      const n = (current ? [current] : []).concat(queue).filter(i => i.kind === 'reply').length;
      const cutReply = cancelSpeaking();
      const setSkip = cutReply && awaitingReply && !cutSkip;
      if (setSkip) cutSkip = true;
      cutRec = cutReply ? { mark: Math.max(0, spokenCount - n), setSkip } : null;
    }
    setState('hearing');
  }
  // The VAD heard no real speech after all (a false start): the person is not speaking, and a reply that was cut by it is read on.
  function onMisfire() {
    if (ended) return;
    clearBegin(); segmentDropped();
    personSpeaking = false; speechAnn = null;
    const rec = cutRec; cutRec = null;
    if (rec) {
      if (rec.setSkip) cutSkip = false;
      spokenCount = rec.mark;
      onReplyText(lastText, lastDone);
    }
    settle();
  }
  // Text decides; the optional end-of-turn model (deps.turnModel, audio -> probability finished, or null) can only add doubt:
  // a text that sounds finished is sent when the model says finished or is unsure, and waits when the model says it is not.
  async function soundsUnfinished(text, audio) {
    if (voiceSoundsUnfinished(text)) return true;
    if (!d.turnModel) return false;
    let p = null;
    try { p = await d.turnModel(audio); } catch { p = null; }
    return typeof p === 'number' && Number.isFinite(p) && p < 0.35;
  }
  function onSpeechEnd(audio) {
    if (ended) return Promise.resolve();
    clearBegin();
    personSpeaking = false; speechEndAt = now(); cutRec = null;
    const mine = { endAt: now(), ann: speechAnn, carry: '', done: false, hold: null, waiting: false, onJoin: null };
    speechAnn = null; segActive = false;
    const cand = curCand; curCand = null;
    if (cand && cand.hold) cand.hold.resolve(mine);   // the earlier piece hands its text to this one
    lastSeg = mine;
    sttPending++;
    settle();
    sttChain = sttChain.then(async () => {
      try {
        let text = '', failed = false;
        try { text = await d.stt(audio); } catch { failed = true; quiet(() => ui.toast('Could not transcribe that.')); }
        if (ended) return;
        const own = String(text || '').trim(), n = voiceCallNorm(own);
        const ownOk = !failed && !(n.length < 2 || n.split(' ').every(w => VOICE_CALL_FILLERS.has(w)));
        let t = ownOk ? own : '';
        if (mine.carry) t = ownOk ? (voiceIsStopCommand(own) ? own : mine.carry + ' ' + own) : mine.carry;   // a stop word in this piece wins over the earlier one
        if (!t) return;
        // Does it sound unfinished? Then it is not sent yet: it waits up to the 'Wait for me to go on' time for the next piece,
        // which takes this text along. Not for a stop command, an answer to a question or an announcement, or when the wait is 0.
        let waited = false;
        if (!mine.hold && !ended && !voiceIsStopCommand(t) && !pendingAsk && mine.ann == null && !pendingAnnounce) {
          const ms = continueWait();
          if (ms > 0 && await soundsUnfinished(t, audio)) {
            waited = true; mine.waiting = true;
            let waitTimer = null;
            await new Promise((resolve) => { mine.onJoin = resolve; waitTimer = d.setTimer(resolve, ms); });
            if (waitTimer !== null) quiet(() => d.clearTimer(waitTimer));
            mine.waiting = false; mine.onJoin = null;
            if (ended) return;
          }
        }
        // A later piece started (within 2 s, or while this one waited): it takes this text along (unless this one is a stop command: stop wins at once).
        if (mine.hold && !voiceIsStopCommand(t)) {
          // At most 5 s (20 s after a wait for more, which a long next piece may need): a later piece whose end never comes
          // (audio interrupted) must not block this text and every one after it.
          let holdTimer = null;
          const next = await Promise.race([mine.hold.promise, new Promise((r) => { holdTimer = d.setTimer(() => r(null), waited ? VOICE_CALL_WAIT_HOLD_MS : VOICE_CALL_HOLD_MS); })]);
          if (holdTimer !== null) quiet(() => d.clearTimer(holdTimer));
          if (ended) return;
          if (next) { next.carry = t; if (next.ann == null) next.ann = mine.ann; return; }
        }
        mine.done = true;
        quiet(() => ui.heard(t));
        await route(t, mine.ann);
      } finally { mine.done = true; sttPending--; settle(); }
    });
    return sttChain;
  }
  async function route(t, ann) {
    if (voiceIsStopCommand(t)) {
      cancelSpeaking(); cutSkip = true; awaitingReply = false; stopThinking(); clearStill();
      quiet(() => d.stop()); enqueue('Stopped.', 'stop'); settle();
      return;
    }
    if (pendingAnnounce && ann != null && pendingAnnounce.id === ann) {   // only the announcement pending when the speech began
      const id = pendingAnnounce.id, w = voiceDecisionWord(t);
      decide(id, w || 'later');
      if (w) return;
    }
    if (pendingAsk) {
      const a = pendingAsk, label = voiceMatchChoice(t, a.options);
      if (label !== null || a.free) { pendingAsk = null; quiet(() => d.answerAsk(a.id, label !== null ? label : t)); return; }
      if (!a.reasked) { a.reasked = true; enqueue('Please say one of: ' + voiceJoinOr(a.options) + '.', 'ask'); }
      else if (!a.tapped) { a.tapped = true; enqueue('Please tap one of the options on the screen.', 'ask'); }
      return;
    }
    try {
      if (quiet(() => d.isTurnRunning())) {
        if (cutSkip) { cutSkip = false; spokenCount = completeCount(); }
        awaitingReply = true; turnAt = now(); stillSaid = false; setState('thinking'); armStill(); armThinking();
        await d.interject(t);
      } else {
        awaitingReply = true; cutSkip = false; spokenCount = 0; noteSpoken = false; lastText = ''; turnAt = now(); stillSaid = false; stillUsed = [];
        setState('thinking'); armStill(); armThinking();
        await d.send(t);
      }
    } catch { awaitingReply = false; clearStill(); stopThinking(); quiet(() => ui.activity('')); quiet(() => ui.toast('Could not send that.')); enqueue('That did not go through.', 'status'); settle(); }
  }

  function beat() {
    hbTimer = d.setTimer(() => {
      hbTimer = null;
      if (ended) return;
      Promise.resolve().then(() => server.heartbeat(callId)).then((r) => { if (!ended && r) hydrate(r.held); }).catch(() => {});
      beat();
    }, VOICE_CALL_HEARTBEAT_MS);
  }
  async function start() {
    if (started) return !ended;
    started = true; setState('starting');
    const fail = async (msg) => { quiet(() => ui.toast(msg)); teardown(); await Promise.resolve().then(() => (callId ? server.end(callId) : null)).catch(() => {}); return false; };   // no id: never end another call of this person
    // The microphone starts first, still inside the tap that began the call (iOS needs that for audio); the server next.
    let vadErr = null;
    let vadStarting;
    try {
      vadStarting = Promise.resolve(vad.start({
        onSpeechBegin, onSpeechStart, onMisfire, onSpeechEnd,
        onFrame: (db, probs) => quiet(() => ui.level(db, probs)),
      })).catch((e) => { vadErr = e || new Error('no microphone'); });
    } catch (e) { vadErr = e || new Error('no microphone'); vadStarting = Promise.resolve(); }
    // The call's id comes with the answer; a hang-up while the server is still starting ends that call once the id is known.
    startP = (async () => server.start(mode))().then((r) => { if (r && r.callId) callId = r.callId; return r; });
    let startRes;
    try { startRes = await startP; } catch (e) { await vadStarting; quiet(() => vad.stop()); return fail('Could not start the call: ' + (e && e.message || e)); }
    await vadStarting;
    if (ended) { quiet(() => vad.stop()); return false; }   // hung up while starting: a microphone that came up late is let go
    if (vadErr) return fail('Could not start the microphone: ' + (vadErr.message || vadErr));
    hydrate(startRes && startRes.held);
    beat(); settle();
    return true;
  }
  // Everything the call holds is let go at once: timers, the thinking sound, the microphone and the speaking.
  function teardown() {
    ended = true;
    for (const t of [hbTimer, pumpTimer, pendingAnnounce && pendingAnnounce.timer]) if (t) quiet(() => d.clearTimer(t));
    hbTimer = pumpTimer = null; pendingAnnounce = null; pendingAsk = null; announceQueue = []; clearBegin(); clearStill(); stopThinking();
    for (const s of [lastSeg, curCand]) if (s) { if (s.hold) s.hold.resolve(null); if (s.onJoin) { const f = s.onJoin; s.onJoin = null; quiet(f); } }   // a held or waiting transcript is let go with the call
    quiet(() => vad.stop()); cancelSpeaking(); setState('ended');
  }
  // Immediate hang-up, for a page that is being hidden, frozen or closed (reason: 'hidden', 'pagehide', 'freeze', ...): everything is
  // released now and the server is told in the background; nothing is waited for and nothing is read out.
  function release(reason) {
    if (endPromise) return endPromise;
    teardown();
    const tell = () => { if (callId) quiet(() => Promise.resolve(server.end(callId)).catch(() => {})); };
    if (callId || !startP) tell(); else startP.then(tell, () => {});   // the id may still be on its way
    endPromise = Promise.resolve([]);
    return endPromise;
  }
  // Hangs up: stops listening and speaking, tells the server and reads out what came in while we talked.
  function hangUp() {
    if (endPromise) return endPromise;
    teardown();
    const idKnown = callId || !startP ? Promise.resolve() : startP.catch(() => {});   // hanging up while the start is in flight waits for the id
    endPromise = idKnown.then(() => (callId ? server.end(callId) : { held: [] })).then(r => (r && Array.isArray(r.held) ? r.held : []), () => []).then((held) => {
      if (held.length) {
        const label = (h) => String(h.label || h.kind || 'something').replace(/[.!?\s]+$/, '');
        const n = held.length, ran = held.filter(h => h.state === 'done'), runs = held.filter(h => h.state !== 'done');
        let tail;
        if (!ran.length) tail = n === 1 ? 'It runs now.' : 'They run now.';
        else if (!runs.length) tail = n === 1 ? 'It already ran.' : 'They already ran.';
        else tail = 'Already ran: ' + ran.map(label).join(', ') + '. Running now: ' + runs.map(label).join(', ') + '.';
        const text = 'While we talked: ' + (n === 1 ? '1 thing came in' : n + ' things came in') + ': ' + held.map(label).join(', ') + '. ' + tail;
        quiet(() => ui.summary(text));
        quiet(() => Promise.resolve(d.speak(text)).catch(() => {}));   // spoken in the background: hanging up never waits for it
      }
      return held;
    });
    return endPromise;
  }
  return {
    start, hangUp, release, setPrefs, onSpeechBegin, onSpeechStart, onMisfire, onSpeechEnd, onReplyText, onActivity, onAsk, onAskDone, onHeld, onHeldDone, decide, setMode,
    get state() { return state; }, get callId() { return callId; }, get mode() { return mode; }, get held() { return heldList.map(h => Object.assign({}, h)); },
  };
}
// Every microphone track the adapter makes is counted until it is stopped (voiceLiveTracks: a test hook, and a way to prove nothing is left holding the microphone).
const VOICE_LIVE_TRACKS = new Set();
function voiceTrackLive(stream) { try { for (const tr of stream.getTracks()) VOICE_LIVE_TRACKS.add(tr); } catch { /* not a stream */ } }
function voiceStopStream(stream) {
  try { for (const tr of stream.getTracks()) { try { tr.stop(); } catch { /* already stopped */ } VOICE_LIVE_TRACKS.delete(tr); } } catch { /* no stream */ }
}
function voiceLiveTracks() {
  let n = 0;
  for (const tr of Array.from(VOICE_LIVE_TRACKS)) { if (tr && tr.readyState === 'ended') VOICE_LIVE_TRACKS.delete(tr); else n++; }
  return n;
}
// The thinking sound: a soft low pulse made with Web Audio only (no files). A sine near 208 Hz with a quiet second partial,
// attack 0.25 s, decay 1 s, repeated every 2.5 s, no melody. Its peak is volume x 0.06 at most. start(), stop() (a 0.1 s fade),
// setVolume(0..1). opts: { ctx, volume, setInterval, clearInterval } (the last two for tests).
function voiceCreateThinkingSound(opts) {
  const o = opts || {}, ctx = o.ctx;
  const setIv = o.setInterval || ((f, ms) => setInterval(f, ms)), clearIv = o.clearInterval || ((id) => clearInterval(id));
  const clamp = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; };
  let vol = clamp(o.volume === undefined ? 0.5 : o.volume), master = null, timer = null, running = false, active = [];
  const peak = () => vol * 0.06;
  function pulse() {
    if (!running || !master) return;
    const t0 = ctx.currentTime + 0.02;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + 0.25);            // attack
    env.gain.linearRampToValueAtTime(0, t0 + 1.25);            // decay
    env.connect(master);
    for (const [freq, level] of [[208, 0.85], [416, 0.15]]) {   // the note and a gentle second partial
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq; g.gain.value = level;
      osc.connect(g); g.connect(env);
      const item = { osc, env };
      active.push(item);
      osc.onended = () => { active = active.filter(x => x !== item); try { g.disconnect(); } catch { /* gone */ } };
      osc.start(t0); osc.stop(t0 + 1.3);
    }
  }
  return {
    start() {
      if (running || !ctx) return;
      running = true;
      try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
      master = ctx.createGain(); master.gain.value = peak(); master.connect(ctx.destination);
      pulse();
      timer = setIv(pulse, 2500);
    },
    stop() {
      if (!running) return;
      running = false;
      if (timer !== null) { clearIv(timer); timer = null; }
      const m = master, t = ctx.currentTime; master = null;
      try { m.gain.cancelScheduledValues(t); m.gain.setValueAtTime(m.gain.value, t); m.gain.linearRampToValueAtTime(0, t + 0.1); } catch { /* ignore */ }
      for (const x of active) { try { x.osc.stop(t + 0.12); } catch { /* already stopped */ } }
      active = [];
      try { if (typeof setTimeout === 'function') setTimeout(() => { try { m.disconnect(); } catch { /* gone */ } }, 300); } catch { /* ignore */ }
    },
    setVolume(v) { vol = clamp(v); if (master) { try { master.gain.value = peak(); } catch { /* ignore */ } } },
    get playing() { return running; },
  };
}
// The microphone and the voice activity detector. opts: { baseUrl, micLevel, interruptSensitivity, win, nav, loadScript }.
// MicVAD 0.0.31 only takes getStream (no stream option), so the stream it gets is built here: microphone (echo
// cancellation, noise suppression and auto gain on) -> GainNode (the Mic level) -> MediaStreamDestination; the VAD
// listens to that destination stream, so the gain acts on what it hears and on what is sent to transcription.
function voiceCreateVad(opts) {
  const o = opts || {};
  const base = o.baseUrl || '/api/voice/web/';
  const pause = (v) => (VOICE_END_PAUSES.includes(Number(v)) ? Number(v) : 1200);   // how long a pause ends the person's turn (ms)
  const st = { micLevel: o.micLevel, sens: o.interruptSensitivity, pause: pause(o.endPause), playing: false, vad: null, ctx: null, gain: null, raw: null, dest: null, gen: 0 };
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
    const w = win(), handlers = h || {}, my = ++st.gen;
    const stale = () => st.gen !== my;   // stop() was called while this start was still in flight: whatever it makes is let go
    // Every failure from here on (script load, resume, MicVAD) lets go of the VAD, the stream and the audio context.
    try {
      // The audio context is made and resumed first, still inside the tap that started the call: iOS keeps a context
      // suspended when it is made after an await.
      const Ctx = w.AudioContext || w.webkitAudioContext;
      st.ctx = new Ctx(); const resumed = st.ctx.resume();
      resumed.catch(() => {});   // a failed resume is reported by the await below, not as an unhandled rejection
      if (!w.vad || !w.vad.MicVAD) { await loadScript(base + 'ort.wasm.min.js'); await loadScript(base + 'bundle.min.js'); }
      await resumed;
      if (stale()) throw new Error('stopped');
      const nav = o.nav || w.navigator;
      const t = voiceVadThresholds(st.sens, false);
      st.vad = await w.vad.MicVAD.new({
        model: 'v5', audioContext: st.ctx, baseAssetPath: base, onnxWASMBasePath: base,
        ortConfig: (c) => { c.env.wasm.numThreads = 1; },
        getStream: async () => {
          const raw = await nav.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
          voiceTrackLive(raw);
          if (stale()) { voiceStopStream(raw); throw new Error('stopped'); }
          st.raw = raw;
          const src = st.ctx.createMediaStreamSource(raw), dest = st.ctx.createMediaStreamDestination();
          st.dest = dest.stream; voiceTrackLive(st.dest);
          st.gain = st.ctx.createGain(); st.gain.gain.value = voiceGainFromSlider(st.micLevel);
          src.connect(st.gain); st.gain.connect(dest);
          return dest.stream;
        },
        pauseStream: async () => {}, resumeStream: async (s) => s,
        positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold,
        redemptionMs: st.pause, preSpeechPadMs: 256, minSpeechMs: t.minSpeechFrames * 32,
        // vad-web 0.0.31: onSpeechStart fires on the first speech-like frame, onSpeechRealStart once minSpeechMs is reached.
        // A candidate start marks the person as speaking (nothing new starts over them); playback is cut on the real start
        // only; a candidate that never gets there ends in onVADMisfire.
        onSpeechStart: () => { if (handlers.onSpeechBegin) handlers.onSpeechBegin(); },
        onSpeechRealStart: () => { if (handlers.onSpeechStart) handlers.onSpeechStart(); },
        onSpeechEnd: (audio) => (handlers.onSpeechEnd ? handlers.onSpeechEnd(audio) : undefined),
        onVADMisfire: () => { if (handlers.onMisfire) handlers.onMisfire(); },
        onFrameProcessed: (probs, frame) => { if (handlers.onFrame) handlers.onFrame(voiceLevelDb(frame), probs); },
      });
      if (stale()) throw new Error('stopped');
      await st.vad.start();
    } catch (e) { if (!stale()) await stop(); else await release(); throw e; }
  }
  // Lets go of everything this adapter holds: MicVAD, the raw microphone stream, the processed stream (the destination's
  // tracks) and the audio context, so other apps can use the microphone at once.
  async function release() {
    const { vad, raw, dest, ctx } = st;
    st.vad = st.raw = st.dest = st.ctx = st.gain = null;
    voiceStopStream(raw); voiceStopStream(dest);   // first, so the microphone is free even when the rest is slow
    try { if (vad) await vad.destroy(); } catch { /* already gone */ }
    try { if (ctx) await ctx.close(); } catch { /* already closed */ }
  }
  async function stop() { st.gen++; await release(); }
  return {
    start, stop,
    setPlaybackActive(on) { st.playing = !!on; apply(); },
    setMicLevel(v) { st.micLevel = v; if (st.gain) st.gain.gain.value = voiceGainFromSlider(v); },
    setInterruptSensitivity(v) { st.sens = v; apply(); },
    // 'Pause before I'm done': only the END of a turn waits this long; the start of speech (barge-in) is not delayed.
    setEndPause(ms) { st.pause = pause(ms); if (st.vad) st.vad.setOptions({ redemptionMs: st.pause }); },
  };
}
// ── voice call (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { voiceCreateCall, voiceCreateVad, voiceDecisionWord, voiceMatchChoice, voiceStatusLine,
  voiceRoomCheck, voiceVadThresholds, voiceReplySentences, voiceJoinOr, voiceCreateThinkingSound, voiceLiveTracks, VOICE_THINKING_LINES };
