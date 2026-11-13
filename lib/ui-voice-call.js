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
 *   voiceCreateThinkingSound({ ctx, volume }) { start(), pulse(), stop(), setVolume(v) }: the soft pulse heard while a reply is being thought of
 *                                            (start() repeats it itself; pulse() plays ONE, for the call's thinking clock)
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
  const ui = Object.assign({ state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {}, reply() {} }, d.ui);   // ui.thinkingPulse(event) is optional; ui.reply(kind): 'start' | 'end' | 'drop' | 'resume' (a reply's boundaries, for the display's reaction)
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
  let thinkTimer = null, thinkingOn = false, thinkStep = 0, thinkT0 = 0, thinkDueAt = 0, thinkSeed = 0;
  let replyEnded = false;   // the whole reply of this turn was reported once (ui.reply('end'))
  const prefs = () => { const p = quiet(() => d.prefs && d.prefs()); return p && typeof p === 'object' ? p : {}; };
  // 'Wait for me to go on': how long a sentence that sounds unfinished waits for the next piece.
  const continueWait = () => { const n = Number(prefs().continueWait); return Number.isFinite(n) && n >= 0 ? n : VOICE_CALL_CONTINUE_MS; };

  // The thinking clock: ONE scheduler for what is heard and what is shown. When the person's turn was sent (and nothing is being
  // transcribed or asked) it starts: a small silent pulse at once (strength 0.35, visual only), the first full pulse VOICE_CALL_THINK_MS
  // later (2 s, the first audible one), then a quiet random pop cluster (lib/ui-voice-thinking.js: voiceThinkingCluster, seeded) about
  // every 1.5 s of pops + a 4-6 s gap (the gap is measured from the END of the cluster). Every pulse is one event (the contract is in
  // lib/ui-voice-thinking.js: at, kind, durationMs, pops [{ tMs, strength, freqHz, decayMs }], and the old swell fields attackMs, decayMs,
  // strength) handed to ui.thinkingPulse(event) (the call display's orb), and when the sound is on (thinkingSound not false; do-not-disturb never mutes it, with any display) to
  // thinking.pulse(event) as well; `at` is the performance.now() time (d.perfNow, else d.now) the audio is scheduled to start (+20 ms);
  // thinking.pulse(event) may move event.at to the time the pulse is really heard (audio output clock) before the picture gets it.
  // A thinking adapter without pulse() (older) is started with start() at the first audible pulse and runs its own interval.
  // The plan of a wait: variant 'A' (airy; the default build), 'B' (round bubble) or 'C' (sparse single pop), the seed and the gap
  // range come from deps.thinkingPlan { variant, seed, gapMinMs, gapSpreadMs } (a fixed seed makes a wait repeatable; no seed: a new random
  // one for each wait). No saved setting. Without voiceThinkingCluster (lib not loaded) the old single swell every 2.5 s is used.
  // Switching the sound off or on, or do-not-disturb, only changes what is audible: the clock and its phase go on. The clock stops
  // at once when the reply speaks, the person speaks, an announcement plays, the turn ends or the call ends.
  const perfNow = () => { const f = d.perfNow || d.now; return Number(f()); };
  // thinkVisual: a display really takes the pulses right now (ui.thinkingPulse exists and ui.thinkingWanted(), when the page has it, says
  // a view is shown). With NO display (None, hidden, ended) the clock is exactly the plain thinking sound of before: nothing is armed
  // when the sound is off, do-not-disturb does not mute it, switching it off ends the wait and switching it on starts a fresh 2 s one,
  // and the sound's own pulse() is called without an event.
  const thinkVisual = () => typeof (d.ui && d.ui.thinkingPulse) === 'function' && !(typeof d.ui.thinkingWanted === 'function' && !quiet(() => d.ui.thinkingWanted()));
  const thinkAudible = () => !!d.thinking && prefs().thinkingSound !== false;   // the same in every display (None, Orb, Character): do-not-disturb does not mute the sound
  function thinkQuiet() { return ended || !awaitingReply || sttPending || pendingAsk || speaking || personSpeaking || pendingAnnounce || queue.length; }
  function muteThinking() {   // the sound only; the clock stays
    if (!thinkingOn) return;
    thinkingOn = false;
    quiet(() => d.thinking.stop());
    if (!speaking) quiet(() => vad.setPlaybackActive(false));
  }
  function stopThinking() {
    if (thinkTimer !== null) { quiet(() => d.clearTimer(thinkTimer)); thinkTimer = null; }
    thinkStep = 0;
    muteThinking();
  }
  // Pulse 0 (the small silent one) happens at t0, pulse 1 at t0 + 2000, and every next one at the previous one's time + its
  // cluster length + its own gap (all on the controller's clock, so the audio mapping of event.at never makes it drift).
  const thinkPlan = (k) => {
    if (typeof voiceThinkingCluster !== 'function') return null;
    const tp = d.thinkingPlan || {};
    return quiet(() => voiceThinkingCluster({ seed: thinkSeed, index: k - 1, variant: tp.variant, gapMinMs: tp.gapMinMs, gapSpreadMs: tp.gapSpreadMs })) || null;
  };
  function thinkTick() {
    thinkTimer = null;
    if (thinkQuiet()) { stopThinking(); return; }
    const k = thinkStep++, vis = thinkVisual();
    const plan = k > 0 ? thinkPlan(k) : null;
    const ev = plan ? voiceThinkingEvent(plan, perfNow() + 20)
      : { at: perfNow() + 20, kind: k === 0 ? 'tick' : 'cluster', pops: [], attackMs: 250, decayMs: 1000, strength: k === 0 ? 0.35 : 1 };
    thinkDueAt = k === 0 ? thinkT0 + VOICE_CALL_THINK_MS : thinkDueAt + (plan ? plan.durationMs + plan.gapAfterMs : 2500);
    if (k > 0 && thinkAudible()) {
      if (!thinkingOn) {
        thinkingOn = true;
        quiet(() => vad.setPlaybackActive(true));   // the pulse is playback: it must not trigger the barge-in detector
        if (typeof d.thinking.pulse !== 'function') quiet(() => d.thinking.start());
      }
      if (!vis) { if (typeof d.thinking.pulse === 'function') quiet(() => d.thinking.pulse()); }   // no display: the plain sound, no event
      else if (typeof d.thinking.pulse === 'function') {
        // The sound schedules the pulse once on the audio clock and moves ev.at to when it is heard (it mutates ev or returns one);
        // the picture then gets the same event. A sound that did not play (false) leaves the controller's clock and is not audible.
        const at0 = ev.at, r = quiet(() => d.thinking.pulse(ev));
        if (r && typeof r === 'object' && r !== ev && Number.isFinite(Number(r.at))) ev.at = Number(r.at);
        const now = perfNow();
        if (!Number.isFinite(ev.at) || ev.at < now - 100 || ev.at > now + 2000) ev.at = at0;   // never a stale or wild time
        if (r === false) muteThinking();
      }
    } else muteThinking();
    if (vis) quiet(() => ui.thinkingPulse(ev));
    if (thinkTimer === null && !ended) thinkTimer = d.setTimer(thinkTick, Math.max(0, thinkDueAt - perfNow()));
  }
  function armThinking() {
    if (ended || thinkTimer !== null || thinkStep > 0 || !awaitingReply || sttPending || pendingAsk || (!thinkVisual() && !thinkAudible())) return;
    thinkT0 = perfNow();
    const sd = Number(d.thinkingPlan && d.thinkingPlan.seed);
    thinkSeed = Number.isFinite(sd) ? sd : Math.floor(Math.random() * 4294967296);
    thinkTick();
  }
  // The person's settings changed (the in-chat voice panel): re-read them now. Muting stops the sound, not the clock.
  function setPrefs() {
    const p = prefs();
    if (!thinkVisual() && !thinkAudible()) stopThinking();   // no display: the sound switched off ends the wait (a fresh one starts when it is on again)
    else if (!thinkAudible()) muteThinking();
    armThinking();
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
    maybeReplyEnd();
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
  // The whole reply is over, reported ONCE (ui.reply('end')) for the display's reaction: its text is complete AND nothing is read or waiting to be
  // read (so a gap between two sentences of a growing reply is not the end) AND the person is not speaking. With no speech (voice off, a failed
  // line) that is the moment the text is complete; otherwise right after the last line ended, before the call returns to listening.
  function maybeReplyEnd() {
    if (ended || replyEnded || !lastDone || awaitingReply || cutSkip || speaking || personSpeaking || current || queue.length) return;
    replyEnded = true;
    quiet(() => ui.reply('end'));
  }
  // Reply text so far (markdown) and whether the turn is over: speaks the complete sentences that are new.
  function onReplyText(full, done) {
    if (ended) return;
    lastText = String(full == null ? '' : full); lastDone = !!done;
    if (!done && !awaitingReply && !cutSkip) { awaitingReply = true; replyEnded = false; }
    const r = voiceReplySentences(lastText, !!done);
    if (r.sentences.length < spokenCount) spokenCount = 0;
    if (cutSkip) spokenCount = r.sentences.length;
    else { for (const s of r.sentences.slice(spokenCount)) enqueue(s, 'reply'); spokenCount = r.sentences.length; }
    if (done) {
      if (!cutSkip && r.note && !noteSpoken) enqueue(r.note, 'reply');
      noteSpoken = true; awaitingReply = false;
      clearStill(); stopThinking(); quiet(() => ui.activity(''));
      if (!speaking) { maybeReplyEnd(); settle(); }
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
    mode = m;   // the thinking sound is not touched: do-not-disturb holds announcements, not the thinking sound
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
    // The earlier piece qualifies while its text is not sent yet (its transcript pending, held, or in the continue wait): one chain,
    // in order, however slow the transcription is, so a later stop word still wins over it.
    if (c && !c.done && !c.hold) {
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
    quiet(() => ui.reply('drop'));   // real speech: a reaction that has not played is dropped
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
    quiet(() => ui.reply('resume'));
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
      let counted = false;
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
        let waited = false, waitStart = 0, ms = 0;
        const waitMore = async (len) => {
          mine.waiting = true;
          let waitTimer = null;
          await new Promise((resolve) => { mine.onJoin = resolve; waitTimer = d.setTimer(resolve, len); });
          if (waitTimer !== null) quiet(() => d.clearTimer(waitTimer));
          mine.waiting = false; mine.onJoin = null;
        };
        if (!mine.hold && !ended && !voiceIsStopCommand(t) && !pendingAsk && mine.ann == null && !pendingAnnounce) {
          ms = continueWait();
          if (ms > 0 && await soundsUnfinished(t, audio)) {
            waited = true; waitStart = now();
            await waitMore(ms);
            if (ended) return;
          }
        }
        // A later piece started (within 2 s, or while this one waited): it takes this text along (unless this one is a stop command: stop wins at once).
        while (mine.hold && !voiceIsStopCommand(t)) {
          // At most 5 s (20 s after a wait for more, which a long next piece may need): a later piece whose end never comes
          // (audio interrupted) must not block this text and every one after it.
          let holdTimer = null, timedOut = false;
          const next = await Promise.race([mine.hold.promise, new Promise((r) => { holdTimer = d.setTimer(() => { timedOut = true; r(null); }, waited ? VOICE_CALL_WAIT_HOLD_MS : VOICE_CALL_HOLD_MS); })]);
          if (holdTimer !== null) quiet(() => d.clearTimer(holdTimer));
          if (ended) return;
          if (next) { next.carry = t; if (next.ann == null) next.ann = mine.ann; return; }
          if (timedOut || !waited) break;
          // A misfire (cough, click) ended the wait early: the rest of the wait goes on.
          const left = ms - (now() - waitStart);
          if (left <= 0) break;
          await waitMore(left);
          if (ended) return;
        }
        mine.done = true;
        quiet(() => ui.heard(t));
        sttPending--; counted = true;   // the transcript is out of the queue: the thinking sound may arm while the turn runs
        await route(t, mine.ann);
      } finally { mine.done = true; if (!counted) sttPending--; settle(); }
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
        awaitingReply = true; replyEnded = false; turnAt = now(); stillSaid = false; quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
        await d.interject(t);
      } else {
        awaitingReply = true; replyEnded = false; cutSkip = false; spokenCount = 0; noteSpoken = false; lastText = ''; lastDone = false; turnAt = now(); stillSaid = false; stillUsed = [];
        quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
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
// The thinking sound: quiet random pop clusters made with Web Audio only (no files). The plan (how many pops, when, how high, the gaps) is
// DATA from lib/ui-voice-thinking.js (voiceThinkingCluster, seeded); this function only plays an event's pops: each pop is a sine with a
// few-ms attack and a 30-60 ms decay (a little glide), through a low-pass below 2 kHz, the whole cluster fades in and out. Peak = volume x
// 0.1125 (volume 0.5, the default, is -25 dBFS). start(), stop() (a 0.1 s fade), setVolume(0..1). pulse(event) schedules ONE cluster at
// ctx.currentTime + 0.02 and moves event.at to the moment that cluster is HEARD (the audio output clock mapped to performance.now():
// getOutputTimestamp when valid, else now + the scheduling lead + the output or base latency); it returns the same event, or false when
// the context is not running (nothing was claimed, event.at is untouched). An event without pops (or no event) plays a cluster of a fresh
// random seed. start() plays one now and another every 6.5 s (the old adapters without a clock of their own).
// opts: { ctx, volume, variant, seed (a fixed seed for the clusters it makes itself), setInterval, clearInterval, perfNow } (the last four for tests).
function voiceCreateThinkingSound(opts) {
  const o = opts || {}, ctx = o.ctx;
  const perf = o.perfNow || (() => (typeof performance !== 'undefined' && performance && typeof performance.now === 'function' ? performance.now() : NaN));
  const setIv = o.setInterval || ((f, ms) => setInterval(f, ms)), clearIv = o.clearInterval || ((id) => clearInterval(id));
  const clamp = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5; };
  let vol = clamp(o.volume === undefined ? 0.5 : o.volume), master = null, timer = null, running = false, active = [], own = 0;
  const peak = () => vol * 2 * Math.pow(10, -25 / 20);   // volume 0.5 = -25 dBFS
  // performance.now() time at which the sample scheduled for context time t0 comes out of the speakers; null when it cannot be told.
  function heardAt(ct, t0) {
    const now = Number(perf());
    if (!Number.isFinite(ct) || !Number.isFinite(now)) return null;
    const sane = (m) => Number.isFinite(m) && m >= 0 && m >= now - 5 && m <= now + 1500;   // never in the past, never far ahead
    try {
      const ts = typeof ctx.getOutputTimestamp === 'function' ? ctx.getOutputTimestamp() : null;
      if (ts && Number.isFinite(ts.contextTime) && Number.isFinite(ts.performanceTime) && ts.contextTime >= 0 && ts.performanceTime > 0) {
        const m = ts.performanceTime + (t0 - ts.contextTime) * 1000;
        if (sane(m)) return m;
      }
    } catch { /* no output timestamp: the latency estimate below */ }
    const l = Number(ctx.outputLatency) > 0 ? Number(ctx.outputLatency) : (Number(ctx.baseLatency) > 0 ? Number(ctx.baseLatency) : 0);
    const m = now + (t0 - ct) * 1000 + l * 1000;
    return sane(m) ? m : null;
  }
  function pulse(ev) {
    if (!running || !master) return;
    const ct = ctx.currentTime, t0 = ct + 0.02;
    if (ev && typeof ev === 'object') { const m = heardAt(ct, t0); if (m !== null) ev.at = m; }
    // the plan: the event's own pops, else a cluster of a fresh random seed (nothing without lib/ui-voice-thinking.js)
    let plan = ev && typeof ev === 'object' && Array.isArray(ev.pops) && ev.pops.length ? ev : null;
    if (!plan && typeof voiceThinkingCluster === 'function') plan = voiceThinkingCluster({ seed: Number.isFinite(Number(o.seed)) ? Number(o.seed) : Math.floor(Math.random() * 4294967296), index: own++, variant: o.variant });
    if (!plan || !Array.isArray(plan.pops) || !plan.pops.length) return;
    const dur = Math.max(0.05, (Number(plan.durationMs) || 1500) / 1000);
    const fin = Math.min(dur, Math.max(0.004, (Number(plan.fadeInMs) || 0) / 1000)), fout = Math.min(dur - fin, Math.max(0.01, (Number(plan.fadeOutMs) || 0) / 1000));
    const env = ctx.createGain();   // the cluster's fade in and out
    env.gain.setValueAtTime(0, t0);
    env.gain.linearRampToValueAtTime(1, t0 + fin);
    env.gain.setValueAtTime(1, t0 + dur - fout);
    env.gain.linearRampToValueAtTime(0, t0 + dur);
    env.connect(master);
    let sink = env;
    if (typeof ctx.createBiquadFilter === 'function') {   // the low-pass: nothing above 2 kHz
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = Math.min(1990, Number(plan.lowpassHz) || 1600); if (lp.Q) lp.Q.value = 0.5;
      lp.connect(env); sink = lp;
    }
    let left = plan.pops.length;
    const done = () => { if (--left === 0) { try { sink.disconnect(); } catch { /* gone */ } try { env.disconnect(); } catch { /* gone */ } } };
    for (const p of plan.pops) {
      const tp = t0 + Math.max(0, Number(p.tMs) || 0) / 1000, dec = Math.max(0.03, Math.min(0.06, (Number(p.decayMs) || 45) / 1000));
      const freq = Math.max(60, Math.min(1900, Number(p.freqHz) || 300)), level = Math.max(0, Math.min(1, Number(p.strength))), glide = Number(p.glide) > 0 ? Number(p.glide) : 1;
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      if (glide !== 1 && osc.frequency.setValueAtTime) { osc.frequency.setValueAtTime(freq, tp); osc.frequency.linearRampToValueAtTime(Math.min(1900, freq * glide), tp + dec); }
      g.gain.setValueAtTime(0, tp);
      g.gain.linearRampToValueAtTime(Number.isFinite(level) ? level : 0.7, tp + 0.004);   // a few ms attack
      g.gain.linearRampToValueAtTime(0, tp + dec);                                          // the 30-60 ms decay ramp
      osc.connect(g); g.connect(sink);
      const item = { osc, env };
      active.push(item);
      osc.onended = () => { active = active.filter(x => x !== item); try { g.disconnect(); } catch { /* gone */ } done(); };
      osc.start(tp); osc.stop(tp + dec + 0.02);
    }
  }
  return {
    start() {
      if (running || !ctx) return;
      running = true;
      try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
      master = ctx.createGain(); master.gain.value = peak(); master.connect(ctx.destination);
      pulse();
      timer = setIv(pulse, 6500);
    },
    // ONE pulse at ctx.currentTime + 0.02 (the call's thinking clock decides when); no interval of its own. stop() ends it like start().
    // With an event: event.at becomes the moment the pulse is heard and the event is returned (the same object); a context that is
    // not running (suspended, closed) is asked to resume, plays nothing, claims nothing and false is returned.
    pulse(ev) {
      if (!ctx) return ev ? false : undefined;
      const wants = ev && typeof ev === 'object';
      if (wants && ctx.state !== undefined && ctx.state !== 'running') {
        try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
        return false;
      }
      if (!running) {
        running = true;
        try { if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); } } catch { /* the page resumes it */ }
        master = ctx.createGain(); master.gain.value = peak(); master.connect(ctx.destination);
      }
      pulse(wants ? ev : undefined);
      return wants ? ev : undefined;
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
