'use strict';
/**
 * ui-voice-call.js — the hands-free call controller of the chat pages (voice phase 2, part P1): the state machine of a
 * call (listening / hearing / thinking / speaking), how each utterance is routed, barge-in, reading a reply sentence by
 * sentence, spoken status lines, ask_user answered by voice, announcements of held items, heartbeat and the hang-up
 * summary, plus the VAD adapter around MicVAD (vad-web 0.0.31). Everything the controller touches comes in through
 * deps (adapters), so it is tested in Node with fakes. The pages carry byte-identical copies between the markers below
 * (app.js, mobile.js); test/ui-voice-call.test.js proves the copies match. Browser-safe plain JS: no require, every
 * top-level name starts with voice / VOICE_, nothing runs at load time. It uses the helpers of lib/ui-voice.js
 * (voiceSpeechText, voiceSentences, voiceIsStopCommand, voiceLevelDb, voiceGainFromSlider, and for standby voiceWakeMatch, voiceIsSleepCommand, VOICE_WAKE_QUIET_MS), which the pages carry in the
 * block before this one.
 *
 *   voiceCreateCall(deps)                    the call controller (see the doc of each method inside)
 *                                            Standby (optional deps.wake() -> { phrase, quietMs, local } | null, deps.chime()): state 'standby' (ui.state(name, phrase)), only the wake phrase
 *                                            is listened for, 'that's all' / 'go to sleep' returns to it, a quiet awake call returns to it after quietMs;
 *                                            the controller also has wakeChanged() (the setting or the recognizer check changed) and isStandby()
 *   voicePlayWakeChime(ctx)                  true when the soft two-note wake chime (660 + 880 Hz, Web Audio, no asset) was scheduled on the AudioContext
 *   voiceCreateThinkingSound({ ctx, volume }) { start(), pulse(), stop(), setVolume(v) }: the soft pulse heard while a reply is being thought of
 *                                            (start() repeats it itself; pulse() plays ONE, for the call's thinking clock)
 *   voiceLiveTracks()                        how many microphone tracks the VAD adapter made are still live (test hook)
 *   voiceCreateKeepAlive({ ctx, levelDb })   { start(), stop(), running }: an inaudible looping noise (-70 dB) that keeps a phone / Bluetooth / car audio route open
 *   voiceOpenMicStream(nav)                  Promise of { stream, fallback }: the microphone constraint ladder (echo cancellation first, then plain { audio: true })
 *   voiceCarRecord(opts)                     { done, cancel() }: the Car or Bluetooth check's recording; the chirp and the microphone share one audio processor (see its doc)
 *   VOICE_ECHO_HOLD_MS, VOICE_CALL_LEAD_IN_MS   600 ms: how long the raised barge-in thresholds stay after playback; 300 ms: the wait before the first spoken line when a keep-alive was started
 *   voiceCreateVad(opts)                     { start(handlers), stop(), setPlaybackActive(b), setMicLevel(v), setInterruptSensitivity(v), setEndPause(ms), setEchoHold(ms), reopen(), info() }
 *                                            (handlers also: onMicInfo(info), onMicChange({ ok, reason, info, changed, error }))
 *   voiceCreateRecorder(opts)                { begin(), drop(), end() -> { seq } | null, pause(on), setSource(node), stop() }: the recording of a recorded call (see its doc);
 *                                            voiceCreateCall(deps) uses it only with deps.recorder (+ deps.recordTranscript(seq, text), deps.recordReplyText(text))
 *   voiceDecisionWord(text)                  'now' | 'later' | 'skip' | null
 *   voiceMatchChoice(text, options)          the matching option label or null
 *   voiceStatusLine(item)                    the status line for a tool activity (shown silently; spoken only with the speakActivity pref)
 *   voiceRoomCheck(speechDb, silenceDb, currentMicLevel)   { micLevel, interruptSensitivity }
 *   voiceVadThresholds(interruptSensitivity, playing)      { positiveSpeechThreshold, negativeSpeechThreshold, minSpeechFrames }
 *   voiceReplySentences(markdown, done)      { sentences, note }: the complete sentences of a reply so far
 *   voiceJoinOr(list)                        'A, B or C'
 */
// ── voice call (begin) ──
const VOICE_ECHO_HOLD_MS = 600, VOICE_CALL_LEAD_IN_MS = 300, VOICE_KEEPALIVE_DB = -70;
const VOICE_MIC_LOST_LINE = 'I lost the microphone. Tap the button to try it again.';
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
// On a call only the spoken lead of a reply is read aloud: at most this many sentences.
const VOICE_LEAD_MAX_SENTENCES = 3;
// A 'detail' line ends the spoken lead: a table row starting with |, a code fence, a heading, a list item, a rule, or a bold label
// (bold text ending in a colon: **Details:** or **Details**:). A bold sentence (**Yes, it finished.**) is an answer and is read.
const VOICE_DETAIL_LINE_RE = /^[ \t]*(?:\||```|~~~|#{1,6}[ \t]|[-*+•◦▪‣][ \t]|\d+[.)][ \t]|([-*_])(?:[ \t]*\1){2,}[ \t]*$|(\*\*|__)[^*_\n]+(?::\2|\2[ \t]*:)[ \t]*$)/;
// A table's delimiter row, also without outer pipes (--- | ---); the line before it is the table's header.
const VOICE_TABLE_RULE_RE = /^[ \t]*\|?[ \t]*:?-{3,}:?[ \t]*(?:\|[ \t]*:?-{3,}:?[ \t]*)+\|?[ \t]*$/;
// voiceSpokenLead(markdown, done) -> { lead, cut }: the text before the first detail line; cut is true when such a line was found.
// While the reply streams (done false) the last line is still being typed: a detail-looking last line, or a line with a pipe whose next
// line has not arrived (it may be a table header), is held back (cut false, so nothing before it is taken as finished).
function voiceSpokenLead(markdown, done) {
  const text = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
  const lines = text.split('\n'), last = lines.length - 1;
  const before = (i) => (i > 0 ? lines.slice(0, i).join('\n') + '\n' : '');
  // A line with a pipe keeps its text before the first pipe as lead text, read like text still being typed (openTail): its complete
  // sentences count, an unfinished last one does not. That is exactly the lead the line had before the pipe arrived, so a sentence
  // already spoken is never taken back, whether the line turns out to be prose or a table header (whose cells are never read).
  const pipeKeep = (i) => before(i) + lines[i].slice(0, lines[i].indexOf('|'));
  for (let i = 0; i < lines.length; i++) {
    const open = !done && i === last;
    if (VOICE_DETAIL_LINE_RE.test(lines[i]) || VOICE_TABLE_RULE_RE.test(lines[i])) return { lead: before(i), cut: !open };
    if (lines[i].includes('|')) {
      if (open || (!done && i + 1 === last)) return { lead: pipeKeep(i), cut: false };
      if (i + 1 <= last && VOICE_TABLE_RULE_RE.test(lines[i + 1])) return { lead: pipeKeep(i), cut: true, openTail: true };
    }
  }
  return { lead: text, cut: false };
}
function voiceReplySentences(markdown, done) {
  const note = voiceSpeechText('| a |');
  const sp = voiceSpokenLead(markdown, done);
  const finished = (!!done || sp.cut) && !sp.openTail;   // a cut lead is complete; an uncut reply may still be streaming; text before a table header's pipe is read as typed
  let lead = sp.lead;
  // While streaming, a last line that is only the start of a detail line (a lone marker, digits, an unclosed bold) is not lead text yet.
  if (!finished) lead = lead.replace(/(^|\n)[ \t]*(?:[-*+•◦▪‣`~#|_=]+|\d+[.)]?|(?:\*\*|__)[^\n]*)$/, '$1');
  let t = voiceSpeechText(lead, !finished), hasNote = sp.cut;
  if (t === note) { t = ''; hasNote = true; } else if (t.endsWith(' ' + note)) { t = t.slice(0, -note.length).trim(); hasNote = true; }
  let sentences = voiceSentences(t).filter(Boolean);
  if (!finished && sentences.length && !(/[.!?]["')\]]*$/.test(t) && /\s$/.test(lead))) sentences.pop();
  if (sentences.length > VOICE_LEAD_MAX_SENTENCES) { sentences = sentences.slice(0, VOICE_LEAD_MAX_SENTENCES); hasNote = true; }
  return { sentences, note: hasNote ? note : '' };
}
function voiceCreateCall(deps) {
  const d = deps || {};
  const ui = Object.assign({ state() {}, heard() {}, held() {}, toast() {}, summary() {}, level() {}, activity() {}, reply() {}, mic() {}, micLost() {} }, d.ui);   // ui.mic(info): the open microphone; ui.micLost(bool): it was lost / is back; ui.thinkingPulse(event) is optional; ui.reply(kind): 'start' | 'end' | 'drop' | 'resume' (a reply's boundaries, for the display's reaction)
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
  // Recording (deps.recorder, only for an agent that keeps recordings; without it none of this acts). recDecided: the decision for the speech now
  // under way was made (at its begin); recOn: it is being recorded. Nothing said in standby is ever recorded: the decision is made at speech begin.
  // deps.recordTranscript(seq, text) and deps.recordReplyText(text) hand the saved text to the page.
  const recorder = d.recorder || null;
  let recDecided = false, recOn = false, replyRecorded = false;
  function recBegin() {
    if (!recorder || recDecided) return;
    recDecided = true;
    if (!standby) { recOn = true; quiet(() => recorder.begin()); }
  }
  function recDrop() {
    recDecided = false;
    if (recOn) { recOn = false; quiet(() => recorder.drop()); }
  }
  // deps.keepAlive ({ start(), stop() }, optional): an inaudible sound that keeps a Bluetooth / car audio route awake. It starts with the call and
  // the first spoken line of the call waits until VOICE_CALL_LEAD_IN_MS after that (the route needs a moment to open, or the first syllable is lost).
  let leadInUntil = 0, keepAliveOn = false, micLost = false;
  let linkLost = false, linkWasLost = false;   // the connection to the server is lost (setLinkLost): speech is dropped, nothing is reported as an error
  // Outage count: each loss adds one. A piece of speech remembers the count when it began (-1 if the link was already lost); it is dropped when
  // that differs from the count when it is transcribed or sent, so nothing heard around an outage reaches the agent after the link is back.
  let linkGen = 0, segLinkGen = 0;
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
  // Standby (deps.wake(), optional): { phrase, quietMs, local } while the person has the wake phrase on, else null (switched off).
  // local is true only when speech is known to be recognized on this computer. Standby shows state 'standby' (ui.state gets the
  // phrase as its second argument), drops everything said that does not start with the phrase and is left again when the phrase is
  // heard; an awake call that stays quiet for quietMs goes back to standby. Wake mode starts only with local true, and once on it fails
  // closed: if local turns false the call stays in (or returns to) standby and nothing heard there is even transcribed. Only the
  // person switching it off (wake() -> null) makes it an ordinary call. Without deps.wake nothing here acts.
  const wake = () => { if (!d.wake) return null; const w = quiet(() => d.wake()); return w && typeof w === 'object' ? w : null; };
  const wakePhrase = () => { const w = wake(); return w && typeof w.phrase === 'string' ? w.phrase : ''; };
  let standby = false, wakeMode = false, wakeSeq = 0, quietTimer = null, chimeTimer = null, statePhrase = '';
  let capWake = null, heardShown = false;   // heardShown: a 'Heard' line is on screen (cleared when the call goes back to standby)   // { sb, seq } taken when the person starts to speak: what counts is whether the call was in standby then
  const wakeIdle = () => !awaitingReply && !speaking && !personSpeaking && !sttPending && !queue.length && !current && !pendingAsk && !pendingAnnounce;
  function clearQuiet() { if (quietTimer !== null) { quiet(() => d.clearTimer(quietTimer)); quietTimer = null; } }
  function enterStandby() {
    if (ended) return;
    standby = true; clearQuiet(); stopThinking();
    if (heardShown) { heardShown = false; quiet(() => ui.heard('')); }   // the last message does not stay on screen while waiting
    if (!speaking) setState('standby');
  }
  function leaveStandby() { standby = false; clearQuiet(); settle(); }
  function setState(name) {
    const phrase = name === 'standby' ? wakePhrase() : '';
    if (name === state && phrase === statePhrase) return;   // (the phrase of a standby can change with the setting)
    state = name; statePhrase = phrase; quiet(() => ui.state(name, phrase));
  }
  function armQuiet() {
    const w = wake();
    if (!wakeMode || standby || state !== 'listening' || !wakeIdle()) { clearQuiet(); return; }
    if (quietTimer !== null) return;
    const ms = w && VOICE_WAKE_QUIET_MS.includes(w.quietMs) ? w.quietMs : 20000;
    quietTimer = d.setTimer(() => {
      quietTimer = null;
      if (ended) return;
      if (wakeMode && !standby && wakeIdle()) enterStandby(); else settle();
    }, ms);
  }
  function settle() {
    if (ended) return;
    if (!speaking && !personSpeaking && queue.length) { clearQuiet(); runQueue(); return; }   // lines that waited while the person spoke are read now
    setState(speaking ? 'speaking' : standby ? 'standby' : personSpeaking ? 'hearing' : awaitingReply ? 'thinking' : 'listening');
    armQuiet();
    pumpAnnounce();
    armStill();
    if (awaitingReply && !speaking && !personSpeaking && !standby) armThinking();   // a long quiet stretch inside a running turn gets the sound too
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
    const lead = leadInUntil; leadInUntil = 0;   // only before the first speak of the call
    if (lead && now() < lead) {
      await new Promise((resolve) => { d.setTimer(resolve, lead - now()); });
      if (my !== gen) return;
    }
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
      if (ok === false) {
        // A failed or cut line drops what waits behind it, except a microphone line ('mic': lost / back / switched), which is
        // tried ONCE more: sending the person's last words stops playback, and that must not swallow "I lost the microphone".
        // Only the line that was cut uses up its retry; mic lines still waiting keep theirs (each gets at most two real attempts).
        const retryItem = item.kind === 'mic' && !item.retried;
        const keep = (retryItem ? [item] : []).concat(queue.filter(q => q.kind === 'mic'));
        for (const q of queue) if (!keep.includes(q)) runAfter(q);
        if (retryItem) item.retried = true;
        queue = keep;
        if (retryItem) continue;   // its after() runs when it is really done
      }
      runAfter(item);
    }
    if (my !== gen) return;
    speaking = false; quiet(() => vad.setPlaybackActive(false));
    maybeReplyEnd();
    settle();
  }
  // Cuts what is being read at once. True when part of a reply was cut (the rest of that reply is then skipped).
  // byPerson: the person's real speech cut it, so the thresholds drop at once (no echo hold-over over their own words), and the
  // microphone lines ('mic': lost / back / switched) are kept: they are about the call, not the reply, and are said when the person
  // stops (the words that cut them may be the last ones heard before the microphone went).
  function cancelSpeaking(byPerson) {
    const items = (current ? [current] : []).concat(queue);
    const hadReply = items.some(i => i.kind === 'reply');
    // a mic line that was PLAYING when cut is kept once (it is not replayed on every barge-in); waiting ones are kept as they are
    const keep = byPerson ? items.filter(i => i.kind === 'mic' && !(i === current && i.retried)) : [];
    if (current && keep.includes(current)) current.retried = true;
    gen++; queue = keep; current = null;
    if (speaking) { speaking = false; quiet(() => vad.setPlaybackActive(false, !!byPerson)); }
    quiet(() => d.cancelSpeech());
    items.filter(i => !keep.includes(i)).forEach(runAfter);
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
    if (!done) replyRecorded = false;   // a reply is being written: its text is saved once, when complete
    if (!done && !awaitingReply && !cutSkip) { awaitingReply = true; replyEnded = false; }
    const r = voiceReplySentences(lastText, !!done);
    if (r.sentences.length < spokenCount) spokenCount = 0;
    if (cutSkip) spokenCount = r.sentences.length;
    else { for (const s of r.sentences.slice(spokenCount)) enqueue(s, 'reply'); spokenCount = r.sentences.length; }
    if (done) {
      if (recorder && !replyRecorded && lastText.trim()) { replyRecorded = true; quiet(() => d.recordReplyText(lastText)); }
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
    if (standby && wake() && wake().local === true) { standby = false; clearQuiet(); }   // the agent asks: the answer is listened for without the phrase (talk from before the question is still dropped)
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
    const failed = () => { if (!linkLost) quiet(() => ui.toast('Could not send that choice.')); };
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
    personSpeaking = true; stopThinking(); clearQuiet();
    capWake = { sb: standby, seq: wakeSeq };
    speechAnn = heardAnnouncement();
    segLinkGen = linkLost ? -1 : linkGen;
    clearBegin();
    segmentStarting();
    recBegin();
    // Real speech, a misfire and an end all clear this timer, so when it fires no real start came: let the false start go.
    beginTimer = d.setTimer(() => { beginTimer = null; if (!ended && personSpeaking) { personSpeaking = false; speechAnn = null; capWake = null; recDrop(); segmentDropped(); settle(); } }, 4000);
  }
  // Real speech began (the VAD adapter calls this from onSpeechRealStart, so a cough or a click does not cut the reading).
  function onSpeechStart() {
    if (ended) return;
    clearBegin();
    if (!personSpeaking) { speechAnn = heardAnnouncement(); segLinkGen = linkLost ? -1 : linkGen; }   // no onSpeechBegin came first
    if (!personSpeaking || !capWake) capWake = { sb: standby, seq: wakeSeq };
    personSpeaking = true; stopThinking(); clearQuiet();
    quiet(() => ui.reply('drop'));   // real speech: a reaction that has not played is dropped
    segmentStarting();
    recBegin();   // no onSpeechBegin came first (a begin already decided this speech)
    if (!standby && (speaking || queue.length)) {   // in standby a sound does not cut the reading ("<phrase>, stop" does, once heard)
      const noteText = voiceSpeechText('| a |');   // the details note is a reply item but not one of the counted sentences
      const items = (current ? [current] : []).concat(queue);
      const n = items.filter(i => i.kind === 'reply' && i.text !== noteText).length;
      const noteCut = items.some(i => i.kind === 'reply' && i.text === noteText);   // a false start puts the note back too
      const cutReply = cancelSpeaking(true);
      const setSkip = cutReply && awaitingReply && !cutSkip;
      if (setSkip) cutSkip = true;
      if (cutReply) cutRec = { mark: Math.max(0, spokenCount - n), setSkip, noteCut };   // a cut of mic lines only keeps an earlier reply cut to resume
    }
    if (!standby) setState('hearing');   // in standby the person is not addressed until the phrase
  }
  // The VAD heard no real speech after all (a false start): the person is not speaking, and a reply that was cut by it is read on.
  function onMisfire() {
    if (ended) return;
    clearBegin(); segmentDropped(); recDrop();
    personSpeaking = false; speechAnn = null; capWake = null;
    quiet(() => ui.reply('resume'));
    const rec = cutRec; cutRec = null;
    if (rec) {
      if (rec.setSkip) cutSkip = false;
      spokenCount = rec.mark;
      if (rec.noteCut) noteSpoken = false;
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
    // The recorded audio of this speech (null when it was not recorded: standby, paused, no recorder): its transcript is saved below.
    const recHandle = recOn ? quiet(() => recorder.end()) || null : null;
    recOn = false; recDecided = false;
    personSpeaking = false; speechEndAt = now(); cutRec = null;
    // sb and seq: was this said in standby (when it began, or now), and how many wakes had there been. Said in standby, it needs the phrase unless a wake came
    // in between (the phrase said alone, then this): so neither a switch-off nor a lost recognizer check can release it.
    const cap = capWake || { sb: standby, seq: wakeSeq }; capWake = null;
    const mine = { endAt: now(), ann: speechAnn, carry: '', done: false, hold: null, waiting: false, onJoin: null, sb: cap.sb || standby, seq: cap.seq,
      linkGen: segLinkGen === linkGen && !linkLost ? linkGen : -1 };
    const stale = () => linkLost || mine.linkGen !== linkGen;   // heard while the link was lost, or an outage began since: never sent
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
        const mustMatch = () => standby || (mine.sb && mine.seq === wakeSeq);
        const w0 = wake();
        if (mustMatch() && !(w0 && w0.local === true)) return;   // standby without a recognizer known to be local: not even transcribed
        const dropLong = mustMatch() && !!audio && audio.length > 30 * 16000;   // a long stretch of talk in standby is not transcribed at all
        try { text = dropLong || stale() ? '' : await d.stt(audio); } catch { failed = true; if (!mustMatch() && !linkLost) quiet(() => ui.toast('Could not transcribe that.')); }
        // The person's words for this piece, as the recognizer gave them, are saved with its audio (also a filler or text that is not sent).
        if (recHandle && !failed && !dropLong && !stale() && String(text || '').trim()) quiet(() => d.recordTranscript(recHandle.seq, String(text).trim()));
        if (ended || stale()) return;   // heard around an outage: dropped, not sent (also when the link came back while this waited)
        const own = String(text || '').trim(), n = voiceCallNorm(own);
        const ownOk = !failed && !(n.length < 2 || n.split(' ').every(w => VOICE_CALL_FILLERS.has(w)));
        let t = ownOk ? own : '';
        if (mine.carry) t = ownOk ? (voiceIsStopCommand(own) || (wakeMode && voiceIsSleepCommand(own)) ? own : mine.carry + ' ' + own) : mine.carry;   // a stop or sleep command in this piece wins over the earlier one
        if (!t) return;
        if (mustMatch()) {   // only the wake phrase is listened for: anything else is dropped (not shown, not sent, nothing kept)
          const w = wake();
          if (!(w && w.local === true)) return;   // switched off, or the check failed, while this was waiting: what was said in standby stays dropped
          const m = voiceWakeMatch(t, w.phrase);
          if (!m.match) return;
          standby = false; wakeSeq++;
          quiet(() => d.chime && d.chime());
          quiet(() => vad.setPlaybackActive(true));   // the chime is playback: it must not be taken as speech
          if (chimeTimer !== null) quiet(() => d.clearTimer(chimeTimer));
          chimeTimer = d.setTimer(() => { chimeTimer = null; if (!ended && !speaking) quiet(() => vad.setPlaybackActive(false)); }, 700);
          if (!m.rest) { settle(); return; }   // the next utterance is the message
          t = m.rest;
        }
        const sleepy = wakeMode && voiceIsSleepCommand(t);
        if (sleepy) { mine.done = true; enterStandby(); return; }   // 'that's all': back to standby at once, not shown, not sent, never joined to what follows
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
        if (!mine.hold && !ended && !voiceIsStopCommand(t) && !sleepy && !pendingAsk && mine.ann == null && !pendingAnnounce) {
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
          if (ended || stale()) return;
          if (next) { next.carry = t; if (next.ann == null) next.ann = mine.ann; return; }
          if (timedOut || !waited) break;
          // A misfire (cough, click) ended the wait early: the rest of the wait goes on.
          const left = ms - (now() - waitStart);
          if (left <= 0) break;
          await waitMore(left);
          if (ended) return;
        }
        if (stale()) return;
        mine.done = true;
        heardShown = true; quiet(() => ui.heard(t));
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
        awaitingReply = true; replyEnded = false; replyRecorded = false; turnAt = now(); stillSaid = false; quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
        await d.interject(t);
      } else {
        awaitingReply = true; replyEnded = false; replyRecorded = false; cutSkip = false; spokenCount = 0; noteSpoken = false; lastText = ''; lastDone = false; turnAt = now(); stillSaid = false; stillUsed = [];
        quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
        await d.send(t);
      }
    } catch {
      awaitingReply = false; clearStill(); stopThinking(); quiet(() => ui.activity(''));
      if (!linkLost) { quiet(() => ui.toast('Could not send that.')); enqueue('That did not go through.', 'status'); }   // a lost connection is reported by the link watch, not as an error line
      settle();
    }
  }
  // The connection to the server was lost (on) or is back (!on). While lost, what is heard is dropped and no error is spoken or shown;
  // when it is back after a real outage, "Reconnected." is spoken (kind 'mic': a barge-in does not drop it).
  function setLinkLost(on) {
    if (ended) return;
    if (on) { if (!linkLost) linkGen++; linkLost = true; linkWasLost = true; return; }
    if (!linkLost) return;
    linkLost = false;
    if (linkWasLost) { linkWasLost = false; enqueue('Reconnected.', 'mic'); }
  }

  // The microphone (from the VAD adapter): onMicInfo shows which one is open; onMicChange says a reopen after the microphone ended or
  // changed (Bluetooth connected or dropped, a car started) worked or failed. A lost microphone does not end the call: the heartbeat, held
  // items and the reading of replies go on, and a tap (retryMic) tries again. Nothing is retried on its own.
  function onMicInfo(info) { if (!ended) quiet(() => ui.mic(info)); }
  function onMicChange(ev) {
    if (ended || !ev) return;
    if (ev.ok === false) {
      if (micLost) return;   // already said: a burst of device events while it is lost is not announced again
      micLost = true; quiet(() => ui.micLost(true));
      enqueue(VOICE_MIC_LOST_LINE, 'mic');
      return;
    }
    if (micLost) {
      micLost = false; quiet(() => ui.micLost(false));
      queue = queue.filter(q => !(q.kind === 'mic' && q.text === VOICE_MIC_LOST_LINE));   // a lost line still waiting is no longer true
      enqueue('The microphone is back.', 'mic'); return;
    }
    if (ev.changed) enqueue('I\'ve switched microphones.', 'mic');
  }
  // Tries to open the microphone again (the answer arrives through onMicChange); the promise says whether it worked.
  function retryMic() {
    if (ended || typeof vad.reopen !== 'function') return Promise.resolve(false);
    try { return Promise.resolve(vad.reopen()).then((r) => !!r, () => false); } catch { return Promise.resolve(false); }
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
    if (d.keepAlive) { keepAliveOn = true; quiet(() => d.keepAlive.start()); leadInUntil = now() + VOICE_CALL_LEAD_IN_MS; }   // inside the tap, before anything is awaited
    const fail = async (msg) => { quiet(() => ui.toast(msg)); teardown(); await Promise.resolve().then(() => (callId ? server.end(callId) : null)).catch(() => {}); return false; };   // no id: never end another call of this person
    // Standby is decided before the microphone opens, so nothing said while the call starts gets past it.
    const w0 = wake();
    wakeMode = !!(w0 && w0.local === true); standby = wakeMode;
    if (w0 && !wakeMode) quiet(() => ui.toast('The wake phrase is not in use on this call: speech recognition is not known to run on this computer.'));
    // The microphone starts first, still inside the tap that began the call (iOS needs that for audio); the server next.
    let vadErr = null;
    let vadStarting;
    try {
      vadStarting = Promise.resolve(vad.start({
        onSpeechBegin, onSpeechStart, onMisfire, onSpeechEnd,
        onFrame: (db, probs) => quiet(() => ui.level(db, probs)),
        onMicInfo, onMicChange,
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
    beat();
    if (!wake()) { wakeMode = false; standby = false; }   // switched off while the call started (wakeChanged waits for the start)
    if (standby) enterStandby();   // (a phrase heard while the call started has already woken it)
    settle();
    return true;
  }
  // Everything the call holds is let go at once: timers, the thinking sound, the microphone and the speaking.
  function teardown() {
    ended = true; capWake = null;
    for (const t of [hbTimer, pumpTimer, quietTimer, chimeTimer, pendingAnnounce && pendingAnnounce.timer]) if (t) quiet(() => d.clearTimer(t));
    hbTimer = pumpTimer = quietTimer = chimeTimer = null; pendingAnnounce = null; pendingAsk = null; announceQueue = []; clearBegin(); clearStill(); stopThinking();
    for (const s of [lastSeg, curCand]) if (s) { if (s.hold) s.hold.resolve(null); if (s.onJoin) { const f = s.onJoin; s.onJoin = null; quiet(f); } }   // a held or waiting transcript is let go with the call
    quiet(() => vad.stop()); cancelSpeaking(); setState('ended');
    if (recorder) { recOn = false; quiet(() => recorder.stop()); }
    if (keepAliveOn) { keepAliveOn = false; quiet(() => d.keepAlive.stop()); }
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
  // Hangs up: stops listening and speaking, tells the server and shows what came in while we talked. After Hang up nothing is
  // spoken: the person asked for silence, and the labels of held jobs and tasks read badly aloud.
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
        quiet(() => ui.summary(text));   // shown only, never spoken
      }
      return held;
    });
    return endPromise;
  }
  // The page calls this when the wake setting or the recognizer check may have changed (also on routine refreshes: nothing that is
  // unchanged may move the call). Switched off: an ordinary call. Switched on (with a local recognizer): standby now if idle, else after
  // the quiet time. Anything else (a new phrase or quiet time, a check that failed) leaves the mode and the state as they are.
  function wakeChanged() {
    if (ended || !started || state === 'starting') return;
    const w = wake();
    if (!w) { wakeMode = false; if (standby) leaveStandby(); else settle(); return; }
    if (!wakeMode && w.local === true) { wakeMode = true; if (!standby && wakeIdle()) enterStandby(); }
    settle();
  }
  return {
    start, hangUp, release, wakeChanged, isStandby: () => standby, setPrefs, retryMic, setLinkLost, onSpeechBegin, onSpeechStart, onMisfire, onSpeechEnd, onReplyText, onActivity, onAsk, onAskDone, onHeld, onHeldDone, decide, setMode,
    get state() { return state; }, get callId() { return callId; }, get mode() { return mode; }, get held() { return heldList.map(h => Object.assign({}, h)); },
  };
}
// The link watch of a call: is the server reachable? o = { probe: () => Promise<boolean> (true = reachable), setTimeout, clearTimeout, onLost(), onBack(),
// onGiveUp(), everyMs = 5000, lostEveryMs = 1000, giveUpMs = 10000, now = Date.now }. While the link is fine it probes every everyMs; a failed probe, report()
// (a network failure seen on one of the call's own requests) or offline() mark it LOST at once (onLost, once per outage), and it then probes every
// lostEveryMs. A probe that succeeds within giveUpMs -> onBack (once) and the normal rhythm; no success within giveUpMs -> onGiveUp (once), and nothing runs
// any more. One probe is in flight at a time; after stop() nothing fires, and a probe that resolves late is ignored.
// -> { start(), stop(), report(), offline(), online() (probe at once), get lost() }
function voiceCreateLinkWatch(o) {
  const c = o || {};
  const setT = c.setTimeout, clrT = c.clearTimeout, clock = typeof c.now === 'function' ? c.now : Date.now;
  const every = Number.isFinite(Number(c.everyMs)) ? Number(c.everyMs) : 5000;
  const lostEvery = Number.isFinite(Number(c.lostEveryMs)) ? Number(c.lostEveryMs) : 1000;
  const giveUp = Number.isFinite(Number(c.giveUpMs)) ? Number(c.giveUpMs) : 10000;
  let running = false, lost = false, lostAt = 0, probing = false, gen = 0, timer = null, giveTimer = null;
  let outage = 0;   // each loss adds one: only a probe started after the loss can say the link is back
  const say = (f) => { try { if (typeof f === 'function') f(); } catch { /* a listener must not break the watch */ } };
  const clear = (t) => { if (t !== null) { try { clrT(t); } catch { /* gone */ } } return null; };
  function schedule(ms) {
    timer = clear(timer);
    if (running) timer = setT(() => { timer = null; probeNow(); }, ms);
  }
  function markLost() {
    if (!running || lost) return;
    lost = true; lostAt = clock(); outage++;
    giveTimer = clear(giveTimer);
    giveTimer = setT(() => {
      giveTimer = null;
      if (!running || !lost) return;
      running = false; gen++; probing = false;   // a probe still out is ignored
      timer = clear(timer);
      say(c.onGiveUp);
    }, giveUp);
    schedule(lostEvery);
    say(c.onLost);
  }
  function probeNow() {
    if (!running || probing) return;
    probing = true;
    timer = clear(timer);
    const my = gen, myOutage = outage;
    let p;
    try { p = Promise.resolve(c.probe()); } catch { p = Promise.resolve(false); }
    p.then((ok) => ok === true, () => false).then((ok) => {
      if (my !== gen || !running) return;
      probing = false;
      if (ok) {
        if (lost) {
          if (myOutage !== outage) { schedule(0); return; }   // it left before the loss: it proves nothing, so ask again at once (the deadline stands)
          if (clock() - lostAt > giveUp) return;   // too late: the give-up timer ends the call
          lost = false; giveTimer = clear(giveTimer);
          schedule(every);
          say(c.onBack);
        } else schedule(every);
      } else if (lost) schedule(lostEvery);
      else markLost();
    });
  }
  return {
    start() { if (running) return; running = true; lost = false; probing = false; gen++; schedule(every); },
    stop() { running = false; gen++; probing = false; lost = false; timer = clear(timer); giveTimer = clear(giveTimer); },
    report() { markLost(); },
    offline() { markLost(); },
    online() { if (running) probeNow(); },
    get lost() { return lost; },
  };
}
// Two short soft tones on the call's own audio context: descending (660 then 440 Hz) = the connection was lost, rising (440 then 660 Hz) = it is back.
// Nothing happens without a context; it never throws.
function voiceLinkTone(ctx, up) {
  try {
    if (!ctx || typeof ctx.createOscillator !== 'function' || typeof ctx.createGain !== 'function') return false;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') { try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* not resumable */ } }
    const t0 = (Number(ctx.currentTime) || 0) + 0.02, freqs = up ? [440, 660] : [660, 440], len = 0.16;
    freqs.forEach((hz, i) => {
      const osc = ctx.createOscillator(), g = ctx.createGain(), s = t0 + i * len;
      osc.type = 'sine'; osc.frequency.value = hz;
      g.gain.setValueAtTime(0, s); g.gain.linearRampToValueAtTime(0.12, s + 0.015); g.gain.linearRampToValueAtTime(0, s + len);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(s); osc.stop(s + len + 0.02);
    });
    return true;
  } catch { return false; }
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
// The constraint ladder that opens the microphone (the VAD adapter and the Car or Bluetooth check use it): echo cancellation, noise suppression and
// auto gain first, exactly as ever. A refusal by the person or the browser (NotAllowedError, SecurityError, AbortError) ends it; any other failure
// (OverconstrainedError, NotReadableError, TypeError, NotSupportedError, NotFoundError: some Bluetooth and car inputs cannot do those) gets ONE more
// try with plain { audio: true }; when that fails too, the FIRST error is thrown. -> Promise of { stream, fallback }.
// o.unprocessed (a call whose voice is recorded, mic 'unprocessed'): the first try asks for echo cancellation, noise suppression and auto gain OFF; the ladder is the same after that.
async function voiceOpenMicStream(nav, o) {
  const md = nav.mediaDevices, on = !(o && o.unprocessed);
  try { return { stream: await md.getUserMedia({ audio: { echoCancellation: on, noiseSuppression: on, autoGainControl: on } }), fallback: false }; } catch (first) {
    const name = first && first.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'AbortError') throw first;
    try { return { stream: await md.getUserMedia({ audio: true }), fallback: true }; } catch { throw first; }
  }
}
// The recording of the 'Car or Bluetooth check'. The test chirp is played three times (opts.at, seconds after the start; default VOICE_CAR_AT) and the
// microphone is recorded until opts.seconds (default VOICE_CAR_END) on the audio clock. WHY ONE PROCESSOR AND A REFERENCE CHANNEL: the delay is the
// time between the chirp leaving and its echo arriving, and two clocks (a timestamp of the played sound, one of the microphone block) never agree:
// the first version dated blocks with AudioProcessingEvent.playbackTime (the OUTPUT buffer's time) and every delay came out about one buffer too
// long. So no timestamps are used: every chirp is played twice at the same scheduled time, once to the speakers (ctx.destination) and once into
// input 1 of a ChannelMerger whose input 0 is the microphone; the merger feeds ONE ScriptProcessor, so a block holds the microphone (channel 0)
// and an exact copy of the chirp (channel 1, silence elsewhere) at the same sample positions, and the delay is the distance between the chirp
// in channel 1 and its echo in channel 0 (voiceCarAnalyse). WHY 1.5 s SPACING AND A 1.2 s SEARCH: the three chirps are identical, so an echo found
// in the window of one chirp could be the echo of the next; the chirps are 1.5 s apart and the search stops at VOICE_CAR_MAX_DELAY_MS (1.2 s), so
// a window never reaches the next chirp's echo. The processor only runs while connected to the destination, hence the 0-gain node at the end.
// opts: { ctx (made and resumed by the page inside the tap; NOT closed here), nav, chirp (Float32Array at ctx.sampleRate), micLevel (the Mic level
// slider, applied to the microphone channel as in a call; default 50 = 0 dB), at, seconds, setTimer,
// clearTimer, now (ms clock), wallMs (default 12000: the audio clock must start within this, else the error code is 'audio_not_started') }.
// -> { done: Promise of { mic, ref, rate, fallback }, cancel() }; cancel() rejects with an Error whose code is 'cancelled'. However it ends
// (result, error, cancel, an exception while building) every source is stopped and disconnected, the processor's handler is removed, the
// microphone stream is stopped and the timer is cleared.
function voiceCarRecord(opts) {
  const o = opts || {}, ctx = o.ctx;
  const at = Array.isArray(o.at) ? o.at : VOICE_CAR_AT;
  const seconds = Number.isFinite(Number(o.seconds)) ? Number(o.seconds) : VOICE_CAR_END;
  const wallMs = Number.isFinite(Number(o.wallMs)) ? Number(o.wallMs) : 12000;
  const micChunks = [], refChunks = [], bufSources = [];
  let finished = false, stream = null, timer = null, micSource = null, micGain = null, merger = null, proc = null, gain = null, resolveF, rejectF;
  const done = new Promise((resolve, reject) => { resolveF = resolve; rejectF = reject; });
  const fail = (code, message) => { const e = new Error(message); e.code = code; return e; };
  const concat = (chunks) => {
    let n = 0; for (const c of chunks) n += c.length;
    const out = new Float32Array(n);
    let at0 = 0; for (const c of chunks) { out.set(c, at0); at0 += c.length; }
    return out;
  };
  function cleanup() {
    if (timer !== null) { try { o.clearTimer(timer); } catch { /* gone */ } timer = null; }
    if (proc) { try { proc.onaudioprocess = null; } catch { /* gone */ } }
    for (const s of bufSources) { try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* gone */ } }
    for (const n of [micSource, micGain, merger, proc, gain]) { if (n) { try { n.disconnect(); } catch { /* gone */ } } }
    if (stream) voiceStopStream(stream);
  }
  function finish(ok, value) {
    if (finished) return;
    finished = true;
    cleanup();
    if (ok) resolveF(value); else rejectF(value);
  }
  (async () => {
    let opened;
    try { opened = await voiceOpenMicStream(o.nav); } catch (e) { finish(false, e); return; }
    stream = opened.stream; voiceTrackLive(stream);
    if (finished) { voiceStopStream(stream); return; }   // cancelled while the microphone was opening: let go of it
    // iOS can suspend or interrupt the context when the microphone starts (or after the first permission prompt): resume it, waiting at most 3 s.
    if (ctx.state && ctx.state !== 'running' && typeof ctx.resume === 'function') {
      let wait = null;
      try { await Promise.race([Promise.resolve(ctx.resume()), new Promise((r) => { wait = o.setTimer(r, 3000); })]); } catch { /* the wall-clock limit below reports it */ }
      finally { if (wait !== null) { try { o.clearTimer(wait); } catch { /* gone */ } } }
      if (finished) return;
    }
    let t0, startMs;
    try {
      micSource = ctx.createMediaStreamSource(stream);
      merger = ctx.createChannelMerger(2);
      // The microphone goes through the person's Mic level, exactly as in a call (the VAD hears it after that gain); the reference does not.
      micGain = ctx.createGain(); micGain.gain.value = voiceGainFromSlider(o.micLevel);
      micSource.connect(micGain); micGain.connect(merger, 0, 0);
      proc = ctx.createScriptProcessor(4096, 2, 1);
      proc.onaudioprocess = (ev) => {
        if (finished) return;
        const ib = ev.inputBuffer, mic = ib.getChannelData(0);
        micChunks.push(new Float32Array(mic));
        refChunks.push(ib.numberOfChannels > 1 ? new Float32Array(ib.getChannelData(1)) : new Float32Array(mic.length));
      };
      merger.connect(proc);
      gain = ctx.createGain(); gain.gain.value = 0;
      proc.connect(gain); gain.connect(ctx.destination);
      t0 = ctx.currentTime;
      const buffer = ctx.createBuffer(1, o.chirp.length, ctx.sampleRate);
      buffer.getChannelData(0).set(o.chirp);
      for (const a of at) {
        const toSpeakers = ctx.createBufferSource(); bufSources.push(toSpeakers);
        toSpeakers.buffer = buffer; toSpeakers.connect(ctx.destination); toSpeakers.start(t0 + a);
        const toMerger = ctx.createBufferSource(); bufSources.push(toMerger);
        toMerger.buffer = buffer; toMerger.connect(merger, 0, 1); toMerger.start(t0 + a);
      }
      startMs = o.now();
    } catch (e) { finish(false, e); return; }
    const tick = () => {
      timer = null;
      if (finished) return;
      try {
        if (ctx.currentTime >= t0 + seconds) { finish(true, { mic: concat(micChunks), ref: concat(refChunks), rate: ctx.sampleRate, fallback: !!opened.fallback }); return; }
        if (o.now() - startMs > wallMs) { finish(false, fail('audio_not_started', 'the audio did not start')); return; }
        timer = o.setTimer(tick, 100);
      } catch (e) { finish(false, e); }
    };
    try { timer = o.setTimer(tick, 100); } catch (e) { finish(false, e); }
  })();
  return { done, cancel() { finish(false, fail('cancelled', 'cancelled')); } };
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
// The keep-alive sound: a 2 s loop of white noise at levelDb (default -70 dB, amplitude 10^(levelDb/20), mono) through a GainNode to
// ctx.destination. It is inaudible noise, not digital silence: phones and Bluetooth links that put the audio route to sleep on silence keep
// it open, so the first syllable of a reply and the thinking sound are not clipped. start() makes the buffer once and a source node each
// time; stop() stops and disconnects it. A missing or failing context makes every call a no-op. opts: { ctx, levelDb }.
function voiceCreateKeepAlive(opts) {
  const o = opts || {}, ctx = o.ctx;
  const db = typeof o.levelDb === 'number' && Number.isFinite(o.levelDb) ? o.levelDb : VOICE_KEEPALIVE_DB;
  let buffer = null, src = null, gain = null;
  const drop = () => {
    const s = src, g = gain; src = gain = null;
    if (s) { try { s.stop(); } catch { /* not started */ } try { s.disconnect(); } catch { /* gone */ } }
    if (g) { try { g.disconnect(); } catch { /* gone */ } }
  };
  return {
    start() {
      if (!ctx || src) return;
      try {
        if (ctx.state === 'suspended' && ctx.resume) { const r = ctx.resume(); if (r && r.catch) r.catch(() => {}); }
        if (!buffer) {
          const rate = ctx.sampleRate, amp = Math.pow(10, db / 20);
          buffer = ctx.createBuffer(1, Math.max(1, Math.round(rate * 2)), rate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * amp;
        }
        gain = ctx.createGain(); gain.gain.value = 1;
        src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
        src.connect(gain); gain.connect(ctx.destination);
        src.start();
      } catch { drop(); }
    },
    stop() { drop(); },
    get running() { return !!src; },
  };
}
// The microphone and the voice activity detector. opts: { baseUrl, micLevel, interruptSensitivity, endPause, echoHoldMs, win, nav, loadScript, setTimer, clearTimer }.
// MicVAD 0.0.31 only takes getStream (no stream option), so the stream it gets is built here: microphone (echo
// cancellation, noise suppression and auto gain on) -> GainNode (the Mic level) -> MediaStreamDestination; the VAD
// listens to that destination stream, so the gain acts on what it hears and on what is sent to transcription.
// The gain and the destination are made once; the microphone source in front of them can be swapped (attach), so when the microphone
// ends or changes (Bluetooth connected or dropped, a car started) it is opened again without restarting the speech detector.
// handlers.onMicInfo(info) after every open; handlers.onMicChange({ ok, reason, info, changed, error }) after every reopen.
function voiceCreateVad(opts) {
  const o = opts || {};
  const base = o.baseUrl || '/api/voice/web/';
  const pause = (v) => (VOICE_END_PAUSES.includes(Number(v)) ? Number(v) : 1200);   // how long a pause ends the person's turn (ms)
  const holdMs = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : VOICE_ECHO_HOLD_MS; };
  const st = { micLevel: o.micLevel, sens: o.interruptSensitivity, pause: pause(o.endPause), playing: false, vad: null, ctx: null, gain: null, raw: null, dest: null, gen: 0,
    hold: o.echoHoldMs === undefined ? VOICE_ECHO_HOLD_MS : holdMs(o.echoHoldMs), holdTimer: null, nav: null, handlers: {}, src: null, track: null, trackOff: null,
    mdOff: null, devTimer: null, reopening: null, info: null, defSnap: null,
    unprocessed: !!o.unprocessed,   // the call's own microphone is opened with echo cancellation, noise suppression and auto gain off (a recorded call, mic 'unprocessed': the fallback)
    recRaw: null, recSrc: null, recTrack: null, recOff: null, srcWatchers: [], openWaiters: [] };   // the recording's own second microphone track (openRecordingTap) and who follows the tap
  const win = () => o.win || window;
  const setT = o.setTimer || ((fn, ms) => { const w = win(); return (typeof w.setTimeout === 'function' ? w.setTimeout.bind(w) : setTimeout)(fn, ms); });
  const clearT = o.clearTimer || ((id) => { const w = win(); return (typeof w.clearTimeout === 'function' ? w.clearTimeout.bind(w) : clearTimeout)(id); });
  const clearHold = () => { if (st.holdTimer !== null) { try { clearT(st.holdTimer); } catch { /* gone */ } st.holdTimer = null; } };
  const loadScript = o.loadScript || ((src) => new Promise((resolve, reject) => {
    const el = win().document.createElement('script');
    el.src = src; el.onload = () => resolve(); el.onerror = () => reject(new Error('could not load ' + src));
    win().document.head.appendChild(el);
  }));
  const apply = () => {
    const t = voiceVadThresholds(st.sens, st.playing);
    if (st.vad) st.vad.setOptions({ positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold, minSpeechMs: t.minSpeechFrames * 32 });
  };
  // The microphone helpers. A handler (onMicInfo, onMicChange) must never break the microphone.
  const callH = (name, arg) => { try { const f = st.handlers[name]; if (typeof f === 'function') f(arg); } catch { /* the handler's own problem */ } };
  const call = callH;
  const rawTrack = (raw) => { try { const l = raw && (raw.getAudioTracks ? raw.getAudioTracks() : (raw.getTracks ? raw.getTracks() : [])); return (l && l[0]) || null; } catch { return null; } };
  // { label, sampleRate, channelCount, echoCancellation, fallback } from the track (each may be missing; the rate then is the context's).
  function micInfo(raw, fallback) {
    const tr = rawTrack(raw);
    let s = {};
    try { s = (tr && typeof tr.getSettings === 'function' && tr.getSettings()) || {}; } catch { s = {}; }
    return { label: tr && typeof tr.label === 'string' ? tr.label : '', sampleRate: Number.isFinite(s.sampleRate) ? s.sampleRate : (st.ctx ? st.ctx.sampleRate : undefined),
      channelCount: s.channelCount, echoCancellation: s.echoCancellation, fallback: !!fallback };
  }
  // The constraint ladder: echo cancellation, noise suppression and auto gain first, exactly as ever. A refusal by the person or the browser
  // (NotAllowedError, SecurityError, AbortError) ends it; any other failure (OverconstrainedError, NotReadableError, TypeError, NotSupportedError,
  // NotFoundError: some Bluetooth and car inputs cannot do those) gets ONE more try with plain { audio: true }; when that fails too, the FIRST error is thrown.
  async function openMic() {
    const r = await voiceOpenMicStream(st.nav, { unprocessed: st.unprocessed });
    return { raw: r.stream, fallback: r.fallback };
  }
  // The recording follows the microphone: handlers registered with onSourceChange(fn) get the node to tap (recordingNode()) after every swap.
  const recordingNode = () => st.recSrc || st.src;
  function fireSource() { for (const f of st.srcWatchers.slice()) { try { f(recordingNode()); } catch { /* the watcher's own problem */ } } }
  function flushOpen(ok) { const w = st.openWaiters; st.openWaiters = []; for (const f of w) { try { f(ok); } catch { /* gone */ } } }
  function dropRecording() {
    if (st.recOff) { try { st.recOff(); } catch { /* gone */ } }
    const s = st.recSrc, r = st.recRaw;
    st.recOff = st.recTrack = st.recSrc = st.recRaw = null;
    if (s) { try { s.disconnect(); } catch { /* gone */ } }
    if (r) voiceStopStream(r);
  }
  // The recording's microphone (a recorded call). Not unprocessed: the call's own source is tapped ('processed'). Unprocessed: a SECOND stream is opened with
  // echo cancellation, noise suppression and auto gain off (the call track's device when known) and used only when its track says echo cancellation is off
  // ('second-track'); else it is let go and the call's own microphone is opened again without that processing ('call-track'; 'processed' if even that failed).
  // -> Promise of { processing, node } (node: what the recorder taps).
  async function openRecordingTap(unprocessed) {
    if (!st.ctx || !st.src) return { processing: 'processed', node: null };
    if (!unprocessed) return { processing: 'processed', node: st.src };
    const my = st.gen;
    let dev;
    try { dev = st.track && typeof st.track.getSettings === 'function' ? st.track.getSettings().deviceId : undefined; } catch { dev = undefined; }
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (dev) audio.deviceId = dev;
    let raw = null;
    try { raw = await st.nav.mediaDevices.getUserMedia({ audio }); } catch { raw = null; }
    if (raw) {
      voiceTrackLive(raw);
      if (st.gen !== my || !st.ctx) { voiceStopStream(raw); return { processing: 'processed', node: null }; }
      const tr = rawTrack(raw);
      let ec;
      try { ec = tr && typeof tr.getSettings === 'function' ? tr.getSettings().echoCancellation : undefined; } catch { ec = undefined; }
      if (ec === false) {
        let src;
        try { src = st.ctx.createMediaStreamSource(raw); } catch { src = null; }
        if (src) {
          dropRecording();
          st.recRaw = raw; st.recSrc = src; st.recTrack = tr;
          if (tr && typeof tr.addEventListener === 'function') {
            // The second track ended: the recording goes back to the call's own microphone, opened without processing.
            const f = () => { if (st.recTrack !== tr) return; dropRecording(); st.unprocessed = true; reopen('recording', true).then(() => fireSource(), () => fireSource()); };
            tr.addEventListener('ended', f);
            st.recOff = () => { if (typeof tr.removeEventListener === 'function') tr.removeEventListener('ended', f); };
          }
          return { processing: 'second-track', node: src };
        }
      }
      voiceStopStream(raw);   // processing is still on (or unusable): not used
    }
    if (st.gen !== my || !st.ctx) return { processing: 'processed', node: null };
    st.unprocessed = true;
    const ok = await reopen('recording', true);
    return { processing: ok ? 'call-track' : 'processed', node: st.src };
  }
  function unwatchTrack() {
    if (st.trackOff) { try { st.trackOff(); } catch { /* gone */ } }
    st.trackOff = null; st.track = null;
  }
  // The new microphone goes in front of the SAME gain: the source is swapped, the destination stream (and so MicVAD) stays.
  // The new source is made and connected first: if that throws, nothing of the old one was touched (the caller lets go of the new stream).
  function attach(raw, fallback) {
    const prevRaw = st.raw, prevSrc = st.src;
    const src = st.ctx.createMediaStreamSource(raw);
    try { src.connect(st.gain); } catch (e) { try { src.disconnect(); } catch { /* never connected */ } throw e; }
    unwatchTrack();
    if (prevSrc) { try { prevSrc.disconnect(); } catch { /* gone */ } }
    if (prevRaw && prevRaw !== raw) voiceStopStream(prevRaw);   // stops and untracks it
    st.src = src; st.raw = raw;
    const tr = rawTrack(raw);
    if (tr && typeof tr.addEventListener === 'function') {
      const f = () => { if (st.track === tr) reopen('ended').catch(() => {}); };   // ended: opened again at once
      tr.addEventListener('ended', f);
      st.track = tr;
      st.trackOff = () => { if (typeof tr.removeEventListener === 'function') tr.removeEventListener('ended', f); };
    }
    fireSource();
  }
  // The 'default' audio input as it was at the last open (its group and label change when the system switches, for example to a car).
  async function snapDefault() {
    const my = st.gen, md = st.nav && st.nav.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return;
    try {
      const list = await md.enumerateDevices();
      if (st.gen !== my || !st.ctx) return;
      const def = Array.from(list || []).find(x => x && x.kind === 'audioinput' && x.deviceId === 'default');
      st.defSnap = def ? { groupId: def.groupId, label: def.label } : null;
    } catch { /* no list: the default entry is simply not compared */ }
  }
  // devicechange: waits 700 ms (a burst of events counts once), then opens the microphone again only when it matters for this call: the
  // current track ended, its device is no longer listed, or the 'default' input moved to another device or name.
  function deviceChanged() {
    if (!st.ctx) return;
    if (st.devTimer !== null) { try { clearT(st.devTimer); } catch { /* gone */ } }
    st.devTimer = setT(() => { st.devTimer = null; checkDevices().catch(() => {}); }, 700);
  }
  async function checkDevices() {
    const my = st.gen;
    if (!st.ctx || st.reopening) return;
    let need = !!(st.track && st.track.readyState === 'ended');
    if (!need) {
      const md = st.nav.mediaDevices;
      if (typeof md.enumerateDevices !== 'function') return;
      let list;
      try { list = await md.enumerateDevices(); } catch { return; }
      if (st.gen !== my || !st.ctx) return;
      const inputs = Array.from(list || []).filter(x => x && x.kind === 'audioinput');
      let id;
      try { id = st.track && typeof st.track.getSettings === 'function' ? st.track.getSettings().deviceId : undefined; } catch { id = undefined; }
      if (id && !inputs.some(x => x.deviceId === id)) need = true;
      const def = inputs.find(x => x.deviceId === 'default');
      if (!need && def && st.defSnap && (def.groupId !== st.defSnap.groupId || def.label !== st.defSnap.label)) need = true;
    }
    if (need) await reopen('devicechange');
  }
  // ONE attempt (with the constraint ladder), never two at once: a reopen in flight absorbs further triggers (and answers them with its own
  // result). Success: the new source is attached, onMicInfo and onMicChange({ ok: true, info, reason, changed }) (changed: the label differs from
  // before). Failure: onMicChange({ ok: false, reason, error }); the speech detector keeps running on the silent destination and nothing is retried.
  // silent (the recording's own reopen): the result is not reported through onMicChange (nothing is said to the person).
  function reopen(reason, silent) {
    if (st.reopening) return st.reopening;
    if (!st.ctx || !st.gain || !st.nav) return Promise.resolve(false);
    const my = st.gen, prev = st.info ? st.info.label : '';
    const call = silent ? ((name, arg) => { if (name !== 'onMicChange') callH(name, arg); }) : callH;
    st.reopening = (async () => {
      let res;
      try { res = await openMic(); } catch (error) { if (st.gen === my) call('onMicChange', { ok: false, reason, error }); return false; }
      voiceTrackLive(res.raw);
      if (st.gen !== my || !st.ctx || !st.gain) { voiceStopStream(res.raw); return false; }   // stopped meanwhile: let go of it
      // iOS leaves the context 'interrupted' (or suspended) after a route change or a phone call: resume it, or the new source is silent.
      // A resume can stay pending on iOS while a phone call holds the audio: it is given 3 s; a context still not running is a lost microphone
      // (the new stream is let go, "Try the microphone again" tries later), never a recovery that hears nothing.
      if (st.ctx.state && st.ctx.state !== 'running' && typeof st.ctx.resume === 'function') {
        let wait = null;
        try { await Promise.race([Promise.resolve(st.ctx.resume()), new Promise((r) => { wait = setT(r, 3000); })]); } catch { /* checked below */ }
        finally { if (wait !== null) { try { clearT(wait); } catch { /* gone */ } } }
        if (st.gen !== my || !st.ctx || !st.gain) { voiceStopStream(res.raw); return false; }
        if (st.ctx.state && st.ctx.state !== 'running') { voiceStopStream(res.raw); call('onMicChange', { ok: false, reason, error: new Error('the audio is not running') }); return false; }
      }
      try { attach(res.raw, res.fallback); } catch (error) {
        voiceStopStream(res.raw);   // the new stream is let go; the old source (if any) was not touched
        call('onMicChange', { ok: false, reason, error });
        return false;
      }
      const info = micInfo(res.raw, res.fallback);
      st.info = info;
      snapDefault();
      call('onMicInfo', info);
      call('onMicChange', { ok: true, reason, info, changed: (info.label || '') !== (prev || '') });
      return true;
    })().finally(() => { st.reopening = null; });
    return st.reopening;
  }
  async function start(h) {
    const w = win(), handlers = h || {}, my = ++st.gen;
    const stale = () => st.gen !== my;   // stop() was called while this start was still in flight: whatever it makes is let go
    st.handlers = handlers;
    // Every failure from here on (script load, resume, MicVAD) lets go of the VAD, the stream and the audio context.
    try {
      // The audio context is made and resumed first, still inside the tap that started the call: iOS keeps a context
      // suspended when it is made after an await. Speech detection needs at least 16 kHz: a context that came up lower (some
      // Bluetooth hands-free profiles run at 8 kHz) is closed and a 48 kHz one made instead (a plain one when that is refused).
      const Ctx = w.AudioContext || w.webkitAudioContext;
      st.ctx = new Ctx();
      if (typeof st.ctx.sampleRate === 'number' && st.ctx.sampleRate < 16000) {
        try { const c = st.ctx.close(); if (c && c.catch) c.catch(() => {}); } catch { /* already closed */ }
        try { st.ctx = new Ctx({ sampleRate: 48000 }); } catch { st.ctx = new Ctx(); }
      }
      const resumed = st.ctx.resume();
      resumed.catch(() => {});   // a failed resume is reported by the await below, not as an unhandled rejection
      if (!w.vad || !w.vad.MicVAD) { await loadScript(base + 'ort.wasm.min.js'); await loadScript(base + 'bundle.min.js'); }
      await resumed;
      if (stale()) throw new Error('stopped');
      const nav = o.nav || w.navigator;
      st.nav = nav;
      const t = voiceVadThresholds(st.sens, false);
      st.vad = await w.vad.MicVAD.new({
        model: 'v5', audioContext: st.ctx, baseAssetPath: base, onnxWASMBasePath: base,
        ortConfig: (c) => { c.env.wasm.numThreads = 1; },
        getStream: async () => {
          const opened = await openMic();
          voiceTrackLive(opened.raw);
          if (stale()) { voiceStopStream(opened.raw); throw new Error('stopped'); }
          const dest = st.ctx.createMediaStreamDestination();   // the destination and the gain are made once; a reopen only swaps the source (attach)
          st.dest = dest.stream; voiceTrackLive(st.dest);
          st.gain = st.ctx.createGain(); st.gain.gain.value = voiceGainFromSlider(st.micLevel);
          try { attach(opened.raw, opened.fallback); } catch (e) { voiceStopStream(opened.raw); throw e; }   // never leave the new stream live
          st.gain.connect(dest);
          st.info = micInfo(opened.raw, opened.fallback);
          if (!st.mdOff && nav.mediaDevices && typeof nav.mediaDevices.addEventListener === 'function') {
            const md = nav.mediaDevices, onChange = () => deviceChanged();
            md.addEventListener('devicechange', onChange);
            st.mdOff = () => { try { md.removeEventListener('devicechange', onChange); } catch { /* gone */ } };
          }
          snapDefault();
          call('onMicInfo', st.info);
          flushOpen(true);
          return dest.stream;
        },
        pauseStream: async () => {}, resumeStream: async (s) => s,
        positiveSpeechThreshold: t.positiveSpeechThreshold, negativeSpeechThreshold: t.negativeSpeechThreshold,
        redemptionMs: st.pause, preSpeechPadMs: 256, minSpeechMs: t.minSpeechFrames * 32,
        // vad-web 0.0.31: onSpeechStart fires on the first speech-like frame, onSpeechRealStart once minSpeechMs is reached.
        // A candidate start marks the person as speaking (nothing new starts over them); playback is cut on the real start
        // only; a candidate that never gets there ends in onVADMisfire.
        onSpeechStart: () => { if (handlers.onSpeechBegin) handlers.onSpeechBegin(); },
        // Real speech passed the raised thresholds: an echo hold-over still running (after a reply or a thinking pulse) ends at once, so
        // it never stays raised over the person's own words.
        onSpeechRealStart: () => {
          if (st.holdTimer !== null) { clearHold(); st.playing = false; apply(); }
          if (handlers.onSpeechStart) handlers.onSpeechStart();
        },
        onSpeechEnd: (audio) => (handlers.onSpeechEnd ? handlers.onSpeechEnd(audio) : undefined),
        onVADMisfire: () => { if (handlers.onMisfire) handlers.onMisfire(); },
        onFrameProcessed: (probs, frame) => { if (handlers.onFrame) handlers.onFrame(voiceLevelDb(frame), probs); },
      });
      if (stale()) throw new Error('stopped');
      await st.vad.start();
    } catch (e) { flushOpen(false); if (!stale()) await stop(); else await release(); throw e; }
  }
  // Lets go of everything this adapter holds: MicVAD, the raw microphone stream, the processed stream (the destination's
  // tracks) and the audio context, so other apps can use the microphone at once.
  async function release() {
    const { vad, raw, dest, ctx } = st;
    if (st.holdTimer !== null) st.playing = false;   // an echo hold-over that was still running ends with the adapter
    clearHold();
    if (st.devTimer !== null) { try { clearT(st.devTimer); } catch { /* gone */ } st.devTimer = null; }
    unwatchTrack();
    if (st.mdOff) { st.mdOff(); st.mdOff = null; }
    const src = st.src;
    flushOpen(false); dropRecording(); st.srcWatchers = [];
    st.vad = st.raw = st.dest = st.ctx = st.gain = st.src = st.defSnap = null;
    if (src) { try { src.disconnect(); } catch { /* gone */ } }
    voiceStopStream(raw); voiceStopStream(dest);   // first, so the microphone is free even when the rest is slow
    try { if (vad) await vad.destroy(); } catch { /* already gone */ }
    try { if (ctx) await ctx.close(); } catch { /* already closed */ }
  }
  async function stop() { st.gen++; await release(); }
  return {
    start, stop,
    // While a reply plays the barge-in thresholds are raised. Playback stopping does NOT lower them at once: a car cabin's echo of the reply
    // reaches the microphone 150-300 ms after playback stops (longer through Bluetooth), and would be heard as the person speaking. So they stay
    // raised for echoHoldMs (default VOICE_ECHO_HOLD_MS; 0 = off: lowered at once) and a new playback in between cancels the lowering.
    // now = true (the person's real speech cut the playback): lowered at once, so the hold-over never shortens their own turn.
    setPlaybackActive(on, now) {
      if (on) { clearHold(); st.playing = true; apply(); return; }
      if (now) { clearHold(); st.playing = false; apply(); return; }
      if (st.holdTimer !== null) return;   // already counting down
      if (!st.ctx) { st.playing = false; return; }   // released (a hang-up): no timer outlives the adapter
      if (st.hold > 0 && st.playing) {
        try { st.holdTimer = setT(() => { st.holdTimer = null; st.playing = false; apply(); }, st.hold); return; } catch { st.holdTimer = null; /* no timer: lowered at once */ }
      }
      st.playing = false; apply();
    },
    // 'Echo guard' (ms, 0 = off); lowering it to 0 ends a hold-over that is running.
    setEchoHold(ms) { st.hold = holdMs(ms); if (st.hold === 0 && st.holdTimer !== null) { clearHold(); st.playing = false; apply(); } },
    // Opens the microphone again (the same path as a lost or changed one, reason 'manual'): a promise of true / false.
    reopen() { return reopen('manual'); },
    info() { return st.info; },
    // The recording's taps (a recorded call): tapNode() is the call's current microphone source (before the Mic level gain); recordingNode() is what the
    // recorder listens to (the second track's source when openRecordingTap made one, else tapNode()); onSourceChange(fn) calls fn(recordingNode()) after
    // every swap of the source (a reopen); whenOpen() -> Promise of true once the microphone is open (false: the start failed or the adapter was released);
    // audioContext() is the call's AudioContext; openRecordingTap(unprocessed) -> { processing, node } (see its doc above).
    tapNode() { return st.src; },
    recordingNode,
    onSourceChange(fn) { if (typeof fn === 'function') st.srcWatchers.push(fn); },
    whenOpen() { return st.info && st.src ? Promise.resolve(true) : new Promise((resolve) => { st.openWaiters.push(resolve); }); },
    audioContext() { return st.ctx; },
    openRecordingTap,
    setMicLevel(v) { st.micLevel = v; if (st.gain) st.gain.gain.value = voiceGainFromSlider(v); },
    setInterruptSensitivity(v) { st.sens = v; apply(); },
    // 'Pause before I'm done': only the END of a turn waits this long; the start of speech (barge-in) is not delayed.
    setEndPause(ms) { st.pause = pause(ms); if (st.vad) st.vad.setOptions({ redemptionMs: st.pause }); },
  };
}
// The recorder of a recorded call (only made when the agent keeps recordings). It taps an audio node (the microphone source) on the call's own
// AudioContext and keeps the last prerollMs of audio in a ring buffer; begin() opens a segment with that preroll in front, end() closes it, encodes
// 16-bit PCM mono WAV at ctx.sampleRate (never resampled) and uploads it. opts: { ctx, source, upload(segment) -> Promise<{ seq }>, now, setTimer, clearTimer,
// prerollMs = 600, maxMs = 3 min, onTrouble(reason) }. A segment is { wav: Uint8Array, startedAt, endedAt (ms), sampleRate }.
// The tap is an AudioWorkletNode (a processor from a Blob URL) when ctx.audioWorklet exists, else a ScriptProcessorNode (4096); either way it goes to a
// zero-gain node to ctx.destination, so it runs and makes no sound.
// begin() is ignored while a segment is open or while paused. drop() discards the open segment. end() -> { seq: Promise<number|null> } or null; seq is
// null when the upload finally failed. A segment longer than maxMs is cut at maxMs and the rest goes on as a new one (the handle is the last piece's).
// pause(true): the open segment is SENT first (what was already said is kept), then nothing is captured; it returns flushed() (a promise that resolves when
// every upload queued or in flight before the pause has finished, resolved or given up); pause(false) resumes. flushed() is that promise at any time.
// cut() sends the open segment and goes on with a new one (a page being hidden or closed: the piece is on its way and stored). ready: a promise of true (the tap
// is made) or false (it could not be). setSource(node) moves the tap; stop() sends the open segment (the words being said at hang-up; not while paused) and
// disconnects (uploads in flight go on while the page is open; the hub takes a call's last pieces for 60 minutes after it ends).
// Uploads (opts.agent, callId, speaker 'person' name the piece in the store): each piece is written to IndexedDB (database 'hub-rec-pending', store 'pieces',
// opts.store overrides; none or a failing one: memory only, the call is never held) BEFORE its first try and deleted when the hub answers 2xx or finally refuses.
// At most 2 uploads at once; a failed one is tried again after waits of 1, 2, 4, 8, 15, 30, 60 s, then every 60 s, until 55 minutes after the piece's end;
// a 4xx other than 408 and 429 is final (the upload function gives 409, paused or no call, as a result, which is final too). onTrouble('upload_failed') is
// called ONCE, when the first piece has been failing for more than 60 s (it still retries) or when one is given up. The transcript of a piece that is resent
// after a reload (voiceRecResendPending) is lost: the audio is what matters.
const VOICE_REC_WORKLET = 'class VoiceRecTap extends AudioWorkletProcessor { constructor() { super(); this.b = new Float32Array(1024); this.n = 0; } process(inputs) { const c = inputs[0] && inputs[0][0]; if (!c) return true; for (let k = 0; k < c.length; k++) { this.b[this.n++] = c[k]; if (this.n === 1024) { const o = this.b; this.port.postMessage(o, [o.buffer]); this.b = new Float32Array(1024); this.n = 0; } } return true; } } registerProcessor("voice-rec-tap", VoiceRecTap);';
function voiceWavFromFloat(samples, rate) {
  const n = samples.length, out = new Uint8Array(44 + n * 2), dv = new DataView(out.buffer);
  const tag = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); tag(8, 'WAVE'); tag(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, Number(samples[i]) || 0)); dv.setInt16(44 + i * 2, Math.round(v * 32767), true); }
  return out;
}
// The pieces the hub has not acknowledged yet, kept in IndexedDB so a flaky network, a closed tab or a reload does not lose them (the hub takes a call's pieces for
// 60 minutes after it ends, so a piece is kept for 55). voiceRecStore(idb) -> { put(record), del(id), all() } (each a Promise that never rejects: put / del give
// true or false, all gives an array), or null when there is no IndexedDB. A record is { id, agent, callId, speaker, startedAt, endedAt (ms), wav (ArrayBuffer),
// createdAt (ms) }. The database opens at once and put() starts its transaction synchronously once it is open, so a page that is closing still gets its piece written.
const VOICE_REC_KEEP_MS = 55 * 60 * 1000;
const VOICE_REC_UNREADABLE = { unreadable: true };
function voiceRecStore(idb) {
  if (!idb || typeof idb.open !== 'function') return null;
  let db = null, opening = null;
  const open = () => opening || (opening = new Promise((resolve) => {
    try {
      const req = idb.open('hub-rec-pending', 1);
      req.onupgradeneeded = () => { try { req.result.createObjectStore('pieces', { keyPath: 'id' }); } catch { /* it exists */ } };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  }));
  const run = (mode, fn, bad) => new Promise((resolve) => {
    const go = (d) => {
      if (!d) { resolve(bad); return; }
      try {
        const tx = d.transaction('pieces', mode), r = fn(tx.objectStore('pieces'));
        tx.oncomplete = () => resolve(mode === 'readonly' ? r.result : true);
        tx.onerror = () => resolve(bad); tx.onabort = () => resolve(bad);
      } catch { resolve(bad); }
    };
    if (db) go(db); else open().then(go, () => resolve(bad));
  });
  open();
  return { put: (rec) => run('readwrite', (st) => st.put(rec), false), del: (id) => run('readwrite', (st) => st.delete(id), false),
    all: () => run('readonly', (st) => st.getAll(), []).then((v) => (Array.isArray(v) ? v : [])),
    // get: the record, or null when it is not there; it REJECTS when it could not be read (a missing record means "sent by another tab", an unreadable one is a failed try)
    get: (id) => run('readonly', (st) => st.get(id), VOICE_REC_UNREADABLE).then((v) => { if (v === VOICE_REC_UNREADABLE) throw new Error('the stored piece could not be read'); return v || null; }) };
}
const voiceRecShared = { store: undefined, resending: false };   // store: made on first use (undefined = not tried yet, null = this browser has none)
function voiceRecStoreOf(idb) {
  if (idb !== undefined) return voiceRecStore(idb);
  if (voiceRecShared.store === undefined) voiceRecShared.store = voiceRecStore(typeof indexedDB !== 'undefined' ? indexedDB : null);
  return voiceRecShared.store;
}
// piece: the piece's id (letters, digits, _ and -, 8 to 64 characters): the hub answers the same piece sent again with the first answer.
function voiceRecSegmentUrl(agent, callId, speaker, startedAt, endedAt, piece) {
  const iso = (ms) => new Date(ms).toISOString();
  return '/api/recordings/segment?agent=' + encodeURIComponent(agent) + '&callId=' + encodeURIComponent(callId || '') + '&speaker=' + speaker
    + '&startedAt=' + encodeURIComponent(iso(startedAt)) + '&endedAt=' + encodeURIComponent(iso(endedAt)) + (piece ? '&piece=' + encodeURIComponent(piece) : '');
}
const voiceRecLive = new Set();   // ids of the pieces a live recorder is still sending: the resend leaves them alone
// Sends every stored piece that is less than 55 minutes old, one at a time, and deletes older ones (the hub no longer takes them). fetch(url, init) answers like
// fetch. A piece is deleted when the hub answers 2xx or refuses it for good (409, or a 4xx other than 408 / 429 / 401: a sign-in that ran out keeps the audio);
// a 5xx, 413, 401 and so on on one piece leaves that piece for the next pass and goes on to the next piece; only no network at all (fetch throws) stops the pass.
// Pieces belong to a person: only those stored with the signed-in user's id (opts.userId) are sent. Another person's pieces, and pieces with no userId, are left alone
// (not sent, not deleted) until they are 55 minutes old. With no userId known, nothing is sent. Every try carries the piece's id (&piece=): the hub answers a piece it
// has already taken with the first answer. Called at page start (after sign-in is known) and when a call starts.
// The transcript of a piece resent this way is lost (it needs the seq of the first upload); the audio is what matters.
// opts: { store, indexedDB, now, userId }. -> { sent, dropped, kept }
async function voiceRecResendPending(fetchFn, opts) {
  const x = opts || {}, out = { sent: 0, dropped: 0, kept: 0 };
  if (voiceRecShared.resending || typeof fetchFn !== 'function') return out;
  const userId = x.userId === undefined || x.userId === null ? '' : String(x.userId);
  if (!userId) return out;
  const store = x.store !== undefined ? x.store : voiceRecStoreOf(x.indexedDB);
  if (!store) return out;
  voiceRecShared.resending = true;
  try {
    const now = typeof x.now === 'function' ? x.now() : Date.now();
    const all = (await store.all()).filter(r => r && r.id && !voiceRecLive.has(r.id)).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (let i = 0; i < all.length; i++) {
      const r = all[i];
      if (!(now - Number(r.createdAt) < VOICE_REC_KEEP_MS)) { await store.del(r.id); out.dropped++; continue; }
      if (!r.userId || String(r.userId) !== userId) continue;   // somebody else's piece, or nobody's: left alone
      let res;
      try { res = await fetchFn(voiceRecSegmentUrl(r.agent, r.callId, r.speaker || 'person', r.startedAt, r.endedAt, r.id), { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'audio/wav' }, body: new Uint8Array(r.wav) }); } catch { out.kept += all.length - i; break; }
      const s = Number(res && res.status);
      if (res && (res.ok || s === 409 || (s >= 400 && s < 500 && s !== 408 && s !== 429 && s !== 401 && s !== 413))) { await store.del(r.id); out.sent += res.ok ? 1 : 0; out.dropped += res.ok ? 0 : 1; } else out.kept++;
    }
  } catch { /* the next pass tries again */ } finally { voiceRecShared.resending = false; }
  return out;
}
function voiceCreateRecorder(opts) {
  const o = opts || {}, ctx = o.ctx;
  const clock = typeof o.now === 'function' ? o.now : () => Date.now();
  const setT = o.setTimer || ((fn, ms) => setTimeout(fn, ms)), clrT = o.clearTimer || ((id) => clearTimeout(id));
  const rate = ctx.sampleRate;
  const preMs = Number.isFinite(Number(o.prerollMs)) ? Number(o.prerollMs) : 600;
  // A long stretch of talk is cut into pieces of at most 3 minutes (about 35 MB of samples in memory at 48 kHz, a 17 MB upload), so a phone never holds more.
  const maxMs = Number.isFinite(Number(o.maxMs)) && Number(o.maxMs) > 0 ? Number(o.maxMs) : 3 * 60 * 1000;
  const preSamples = Math.round(rate * preMs / 1000), maxSamples = Math.round(rate * maxMs / 1000);
  let src = null, tap = null, zero = null, url = null, ring = [], ringN = 0, seg = null, paused = false, stopped = false, troubled = false;
  let inflight = 0; const waiting = [], jobs = new Set();
  const store = o.store !== undefined ? o.store : voiceRecStoreOf();
  const WAITS = [1000, 2000, 4000, 8000, 15000, 30000, 60000], GIVE_UP_MS = 55 * 60 * 1000, TROUBLE_MS = 60 * 1000;
  let counter = 0, lost = 0;
  const userId = o.userId === undefined || o.userId === null ? '' : String(o.userId);
  const quiet = (fn) => { try { return fn(); } catch { return undefined; } };
  const concat = (chunks, n) => { const out = new Float32Array(n); let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; } return out; };
  // A 401 (the sign-in ran out) is retryable: the audio is kept and tried again on the normal schedule.
  const retryable = (e) => { const s = e && Number(e.status); return !(s >= 400 && s < 500 && s !== 408 && s !== 429 && s !== 401); };
  function trouble() { if (troubled) return; troubled = true; if (typeof o.onTrouble === 'function') quiet(() => o.onTrouble('upload_failed')); }
  const failing = () => { for (const j of jobs) if (j.failedAt !== undefined && !j.over) return true; return false; };
  // Every piece that failed has since been sent (none given up, none failing): the people are told it is fine again (onRecover); a later failure tells them again.
  // keep: the stored copy stays (the hub refused the piece because the call is not recording: voiceRecResendPending may still place it under the person's own id).
  function finish(job, seq, sent, keep) {
    job.over = true; job.keep = keep === true; jobs.delete(job); voiceRecLive.delete(job.id); if (store && !job.keep) Promise.resolve(quiet(() => store.del(job.id))).catch(() => {});
    if (!sent) lost++;
    if (sent && troubled && !lost && !failing()) { troubled = false; if (typeof o.onRecover === 'function') quiet(() => o.onRecover()); }
    job.resolve(seq);
  }
  // One try of a piece. A piece that fails is tried again later (its slot is free meanwhile) until the hub has it, refuses it for good, or time is up.
  // A piece whose copy is in the store (its put succeeded) has no WAV in memory: it is read back for each try; a read that fails counts as a failed try.
  async function attempt(job) {
    try {
      let seg = job.segment;
      if (!seg.wav) {
        // The read-back is raced against 2 s: a store that hangs counts as one failed try (the slot is freed, the piece is tried again later).
        let rec = null;
        if (store && typeof store.get === 'function') {
          let timer = null;
          const timeout = new Promise((_, no) => { timer = setT(() => no(new Error('the stored piece could not be read in time')), 2000); });
          try { rec = await Promise.race([Promise.resolve(store.get(job.id)), timeout]); } finally { if (timer !== null) quiet(() => clrT(timer)); }
        }
        // No record at all: another tab (its resend) sent the piece and deleted it. It was sent: no trouble, no failure.
        if (rec === null || rec === undefined) { finish(job, null, true); return; }
        if (!rec.wav) throw new Error('the stored piece could not be read');
        seg = { wav: new Uint8Array(rec.wav), startedAt: seg.startedAt, endedAt: seg.endedAt, sampleRate: seg.sampleRate, piece: seg.piece };
      }
      const r = await o.upload(seg);
      if (r && r.status === 409) {   // the hub's answer is no: not sent, and not retried live. Only piece_conflict (a different body under that id) leaves nothing to resend.
        finish(job, null, false, r.error !== 'piece_conflict'); return;
      }
      finish(job, r && Number.isInteger(r.seq) ? r.seq : null, true); return;
    } catch (e) {
      if (!retryable(e)) { trouble(); finish(job, null, false); return; }
      const now = clock(), first = job.failedAt === undefined;
      if (first) job.failedAt = now;
      else if (now - job.failedAt > TROUBLE_MS) trouble();
      if (now - job.segment.endedAt >= GIVE_UP_MS) { trouble(); finish(job, null); return; }
      const wait = WAITS[Math.min(job.fails++, WAITS.length - 1)];
      setT(() => { waiting.push(job); pump(); }, wait);
      if (first) setT(() => { if (!job.over) trouble(); }, TROUBLE_MS + 1);   // still failing after a minute: the people are told while it goes on trying
    }
  }
  function pump() {
    while (inflight < 2 && waiting.length) {
      const job = waiting.shift(); inflight++;
      attempt(job).then(() => { inflight--; pump(); });
    }
  }
  function send(samples, startedAt, endedAt) {
    const wav = voiceWavFromFloat(samples, rate);
    return new Promise((resolve) => {
      // The piece's id: base36 parts joined with '-', 8 to 64 characters of [A-Za-z0-9_-] (the hub's rule); it is sent as &piece= on every try, so a retry is never a second piece.
      const id = Date.now().toString(36) + '-' + (counter++).toString(36) + '-' + Math.random().toString(36).slice(2, 8).padEnd(4, '0');
      const segment = { wav, startedAt, endedAt, sampleRate: rate, piece: id };
      const job = { id, segment, resolve, fails: 0, over: false };
      jobs.add(job); voiceRecLive.add(job.id);
      job.done = new Promise((r) => { job.settle = r; });
      const was = job.resolve; job.resolve = (v) => { was(v); job.settle(); };
      const go = () => { waiting.push(job); pump(); };
      let saved = null;
      if (store) saved = quiet(() => store.put({ id: job.id, userId, agent: String(o.agent || ''), callId: String(o.callId || ''), speaker: o.speaker || 'person', startedAt, endedAt,
        wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength), createdAt: clock() }));   // written BEFORE the first try
      if (saved && typeof saved.then === 'function') {
        // A store that hangs does not hold the call's uploads: after 2 s the piece goes to the network anyway (its copy stays in memory). Once the put has succeeded the
        // copy in memory is dropped (a long outage must not fill a phone) and each try reads it back from the store.
        let t = null, done = false;
        const next = (ok) => {
          if (done) { if (ok === true && job.over && !job.keep) quiet(() => store.del(job.id)); return; }   // a put that finished after the piece was already sent leaves nothing behind
          done = true; if (t !== null) quiet(() => clrT(t));
          if (ok === true && typeof store.get === 'function') segment.wav = null;
          go();
        };
        t = setT(() => next(false), 2000);
        saved.then(next, () => next(false));
      } else go();
    });
  }
  function flushed() { return Promise.all(Array.from(jobs).map(j => j.done)).then(() => undefined); }
  function onChunk(f32) {
    if (stopped || paused || !f32 || !f32.length) return;
    ring.push(f32); ringN += f32.length;
    while (ring.length > 1 && ringN - ring[0].length >= preSamples) ringN -= ring.shift().length;
    if (!seg) return;
    seg.chunks.push(f32); seg.samples += f32.length;
    while (seg && seg.samples > maxSamples) {   // cut at maxMs; the rest goes on as a new segment
      const all = concat(seg.chunks, seg.samples), cutAt = seg.startedAt + maxMs;
      send(all.subarray(0, maxSamples), seg.startedAt, cutAt);
      const rest = all.subarray(maxSamples);
      seg = { chunks: [rest], samples: rest.length, startedAt: cutAt };
    }
  }
  function connectSource(node) {
    if (src && tap) quiet(() => src.disconnect(tap));
    src = node || null;
    if (src && tap) quiet(() => src.connect(tap));
  }
  function makeTap() {
    zero = ctx.createGain(); zero.gain.value = 0; zero.connect(ctx.destination);
    const sp = () => {
      tap = ctx.createScriptProcessor(4096, 1, 1);
      tap.onaudioprocess = (e) => { const d = e && e.inputBuffer && e.inputBuffer.getChannelData(0); if (d) onChunk(new Float32Array(d)); };
      tap.connect(zero); connectSource(src);
    };
    const W = o.AudioWorkletNode || (typeof AudioWorkletNode !== 'undefined' ? AudioWorkletNode : null);
    const B = o.Blob || (typeof Blob !== 'undefined' ? Blob : null), U = o.URL || (typeof URL !== 'undefined' ? URL : null);
    if (ctx.audioWorklet && W && B && U) {
      url = U.createObjectURL(new B([VOICE_REC_WORKLET], { type: 'application/javascript' }));
      return Promise.resolve(ctx.audioWorklet.addModule(url)).then(() => {
        if (stopped) return;
        tap = new W(ctx, 'voice-rec-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
        tap.port.onmessage = (e) => onChunk(e.data);
        tap.connect(zero); connectSource(src);
      }).catch(() => { if (!stopped) sp(); });
    }
    sp();
    return Promise.resolve();
  }
  src = o.source || null;
  const ready = Promise.resolve().then(makeTap).then(() => !!tap || stopped, () => false);   // false: the tap could not be made, nothing will be recorded
  return {
    ready,
    flushed,
    // A page being hidden or closed: the open segment is sent now (written to IndexedDB first) and a new one goes on from here; not while paused.
    cut() {
      if (stopped || paused || !seg || seg.samples <= 0) return;
      const s = seg, at = clock();
      send(concat(s.chunks, s.samples), s.startedAt, at);
      seg = { chunks: [], samples: 0, startedAt: at };
    },
    begin() {
      if (stopped || paused || seg) return;
      const all = concat(ring, ringN), take = Math.min(all.length, preSamples);
      const pre = all.subarray(all.length - take);
      seg = { chunks: [pre], samples: pre.length, startedAt: clock() - Math.round(take * 1000 / rate) };
    },
    drop() { seg = null; },
    end() {
      if (!seg) return null;
      const s = seg; seg = null;
      if (s.samples <= 0) return null;
      return { seq: send(concat(s.chunks, s.samples), s.startedAt, clock()) };
    },
    // pause(true) first sends the open segment (as end() does), then stops capturing; it returns flushed(): every upload queued or in flight so far.
    pause(on) {
      if (!on) { paused = false; return Promise.resolve(); }
      if (!paused && !stopped && seg && seg.samples > 0) { const s = seg; send(concat(s.chunks, s.samples), s.startedAt, clock()); }
      paused = true; seg = null; ring = []; ringN = 0;
      return flushed();
    },
    setSource(node) { connectSource(node); },
    // Hang-up: what the person was saying at that moment is kept (sent like any other piece), then the tap is let go.
    stop() {
      if (stopped) return;
      if (seg && !paused && seg.samples > 0) { const s = seg; send(concat(s.chunks, s.samples), s.startedAt, clock()); }
      stopped = true; seg = null; ring = []; ringN = 0;
      if (src && tap) quiet(() => src.disconnect(tap));
      src = null;
      if (tap) { quiet(() => { tap.onaudioprocess = null; }); quiet(() => { if (tap.port) tap.port.onmessage = null; }); quiet(() => tap.disconnect()); }
      if (zero) quiet(() => zero.disconnect());
      if (url) { quiet(() => (o.URL || URL).revokeObjectURL(url)); url = null; }
    },
    get paused() { return paused; },
  };
}
// What the hub answers a call start with when the agent keeps recordings but its speech recognition is not on this computer (409 recording_needs_local_stt).
const VOICE_REC_NEEDS_LOCAL = 'This agent keeps recordings of its calls, and recordings are only made with speech recognition on this computer. An admin can switch this agent\'s speech recognition to this computer on its settings page.';
// The agent's recordings setting as the page needs it (GET /api/agents gives `recordings` on each agent): keep on or off, and the microphone mode.
function voiceRecSettings(agentRecord) {
  const r = agentRecord && typeof agentRecord === 'object' ? agentRecord.recordings : null;
  return { keep: !!(r && r.keep === true), mic: r && r.mic === 'unprocessed' ? 'unprocessed' : 'processed' };
}
// The page's side of a recorded call (made only when the agent's recordings.keep is true; the pages never call it otherwise). One per call.
// o: { agent, userId (the signed-in user's id: stored with every piece, so only that person's page resends it), vad (the adapter: whenOpen, openRecordingTap, audioContext, recordingNode, onSourceChange, info), fetch(url, init), nav, unprocessed (mic 'unprocessed'),
//      wired (deps.recorder was given to the controller: false makes a recording answer an error), speak(line) -> Promise (the consent line, in the agent's voice),
//      playback(on) (the page tells the speech detector a line is playing), badge(state) ('on' | 'trouble' | 'paused' | 'error' | 'stopped'), toast(msg), onNetFail(e),
//      now, setTimer, clearTimer, createRecorder (default voiceCreateRecorder), waitMs (how long the start waits for the microphone, default 15000) }
// -> { device() (Promise of the start body's device: userAgent, micLabel, sampleRate, processing), recorder (the controller's deps.recorder: begin, drop, end, stop),
//      recordTranscript(seq, text), recordReplyText(text), started(recording, callId) (the start answer's `recording`: the consent line, the recorder, the badge),
//      togglePause(wantPaused), replyAudio(arrayBuffer) (a spoken reply sentence's WAV: uploaded as speaker 'agent' only when the agent keeps replies), trouble(reason), stop(),
//      get state() }
function voiceCreateRecordingSession(o) {
  const q = o || {}, agent = String(q.agent || '');
  const clock = typeof q.now === 'function' ? q.now : () => Date.now();
  const quiet = (fn) => { try { return fn(); } catch { return undefined; } };
  let callId = null, sessionId = null, keepReplies = false, recorder = null, tap = null, active = false, paused = false, state = 'off', troubled = false, uploadTrouble = false, ended = false, consenting = false, replyCount = 0;
  const iso = (ms) => new Date(ms).toISOString();
  const show = (s) => { state = s; quiet(() => q.badge(s)); };
  async function postJson(path, body) {
    let r;
    try { r = await q.fetch(path, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { quiet(() => q.onNetFail && q.onNetFail(e)); throw e; }
    let j = {}; try { j = await r.json(); } catch { /* no body */ }
    if (!r.ok) { const e = new Error(j.error || 'HTTP ' + r.status); e.status = r.status; throw e; }
    return j;
  }
  // One audio segment. 409 (paused, or the call is over) is not a failure: nothing is kept on purpose. A 4xx other than 408 / 429 carries .status (the recorder does not retry it).
  // piece: the piece's id (&piece=): the same on every try of the same piece, so the hub never takes it twice.
  async function sendAudio(speaker, body, startedAt, endedAt, piece) {
    const url = voiceRecSegmentUrl(agent, callId, speaker, startedAt, endedAt, piece);
    let r;
    try { r = await q.fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'audio/wav' }, body }); } catch (e) { quiet(() => q.onNetFail && q.onNetFail(e)); throw e; }
    if (r.ok) { let j = {}; try { j = await r.json(); } catch { /* no body */ } return { seq: j.seq }; }
    // 409 is the hub's answer, not a failure of the network: { seq: null, status: 409, error } where error is its code ('not_recording' when it gave none, or 'piece_conflict').
    // The recorder ends the piece's live tries on it but keeps the stored copy unless the code is piece_conflict.
    if (r.status === 409) { let j = {}; try { j = await r.json(); } catch { /* no body */ } return { seq: null, status: 409, error: j && typeof j.error === 'string' && j.error ? j.error : 'not_recording' }; }
    let j = {}; try { j = await r.json(); } catch { /* no body */ }
    const e = new Error('HTTP ' + r.status); e.status = r.status; if (j && typeof j.error === 'string') e.code = j.error; throw e;
  }
  // An upload that has been failing for a minute does NOT stop the recording: 'trouble' ("Recording (some speech not sent yet)", red dot, Pause stays) while it
  // keeps trying. 'stopped' is only for a recording that really cannot go on (the recorder could not be made, or its tap failed: start_failed).
  function trouble(reason) {
    if (reason === 'upload_failed') { uploadTrouble = true; if (state === 'on') show('trouble'); }   // the badge follows every failure (it went back to normal when the pieces were sent) ...
    if (troubled) return;   // ... but the hub is told only once
    troubled = true;
    if (reason !== 'upload_failed' && (state === 'on' || state === 'trouble' || state === 'paused')) show('stopped');   // "Recording stopped" for the rest of the call; the call carries on
    if (callId) postJson('/api/recordings/trouble', { agent, callId, reason }).catch(() => {});
  }
  // Every piece that failed has been sent since: the badge goes back to 'on' (or 'paused'). The hub was told once already and is not told again.
  function recovered() { uploadTrouble = false; if (state === 'trouble') show(live()); }
  const proxy = {
    begin() { if (active && recorder) recorder.begin(); },
    drop() { if (recorder) recorder.drop(); },
    end() { return active && recorder ? recorder.end() : null; },
    stop() { ended = true; active = false; if (recorder) quiet(() => recorder.stop()); },
  };
  const live = () => (paused ? 'paused' : uploadTrouble ? 'trouble' : 'on');   // what the badge says while the recording goes on
  return {
    recorder: proxy,
    get state() { return state; },
    // Waits (up to waitMs) for the call's microphone, then makes the recording's tap. Never throws: a missing field is simply not sent.
    async device() {
      const nav = q.nav || (typeof navigator !== 'undefined' ? navigator : {});
      const dev = { userAgent: String(nav.userAgent || '') };
      let open = false;
      try {
        let wait = null;
        open = await Promise.race([Promise.resolve(q.vad.whenOpen()), new Promise((resolve) => { wait = (q.setTimer || setTimeout)(() => resolve(false), Number.isFinite(Number(q.waitMs)) ? Number(q.waitMs) : 15000); })]);
        if (wait !== null) quiet(() => (q.clearTimer || clearTimeout)(wait));
      } catch { open = false; }
      if (open !== true) return dev;
      try { tap = await q.vad.openRecordingTap(q.unprocessed === true); if (tap && tap.processing) dev.processing = tap.processing; } catch { tap = null; }
      const info = quiet(() => q.vad.info()), ctx = quiet(() => q.vad.audioContext());
      if (info && typeof info.label === 'string') dev.micLabel = info.label;
      if (ctx && Number.isInteger(ctx.sampleRate)) dev.sampleRate = ctx.sampleRate;
      return dev;
    },
    // The start answer's `recording`: { sessionId, consentLine, keepReplies, mic } or { error }. The consent line is spoken first (not recorded), then the
    // consent is posted and the recorder starts. A line that could not be spoken (TTS failed) changes nothing else: the text is on screen.
    async started(rec, id) {
      callId = id || null;
      if (!rec || rec.error || !rec.sessionId || q.wired === false) { show('error'); trouble('start_failed'); return; }   // "Not recording": the hub could not start it (or this page cannot make it); the call carries on
      sessionId = rec.sessionId; keepReplies = rec.keepReplies === true;
      show('on');
      let spoken = true;
      if (rec.consentLine) {
        // The line gets at most 20 s; after that the call carries on as if it had played. A line that failed or timed out is put on screen (toast) and the hub is told.
        consenting = true; quiet(() => q.playback && q.playback(true));
        let cut = null;
        try {
          spoken = await Promise.race([Promise.resolve(q.speak(String(rec.consentLine))).then(() => true, () => false),
            new Promise((resolve) => { cut = (q.setTimer || setTimeout)(() => resolve(false), 20000); })]);
        } catch { spoken = false; }
        if (cut !== null) quiet(() => (q.clearTimer || clearTimeout)(cut));
        consenting = false; quiet(() => q.playback && q.playback(false));
        if (!spoken && !ended) quiet(() => q.toast(String(rec.consentLine)));
      }
      if (ended) return;
      postJson('/api/recordings/consent', spoken ? { agent, callId } : { agent, callId, spoken: false }).catch(() => {});
      const ctx = quiet(() => q.vad.audioContext()), node = (tap && tap.node) || quiet(() => q.vad.recordingNode());
      const make = q.createRecorder || voiceCreateRecorder;
      try {
        recorder = make({ ctx, source: node, now: clock, setTimer: q.setTimer, clearTimer: q.clearTimer, prerollMs: 600, agent, callId, speaker: 'person', userId: q.userId,
          upload: (seg) => sendAudio('person', seg.wav, seg.startedAt, seg.endedAt, seg.piece), onTrouble: (reason) => trouble(reason), onRecover: () => recovered() });
        quiet(() => q.vad.onSourceChange((n) => { if (recorder && n) recorder.setSource(n); }));
        if (paused) recorder.pause(true);
        active = true;
        // The tap could not be made (ready false): nothing will be recorded. The call carries on.
        Promise.resolve(recorder.ready).then((ok) => { if (ok === false && !ended) { active = false; if (state !== 'stopped') show('stopped'); trouble('start_failed'); } }, () => {});
      } catch { recorder = null; trouble('start_failed'); }
    },
    // The person's words for one recorded piece, saved with its audio (seq is the recorder handle's promise: null when its upload failed).
    async recordTranscript(seq, text) {
      let n = null; try { n = await seq; } catch { n = null; }
      if (!Number.isInteger(n) || !callId) return;
      try { await postJson('/api/recordings/transcript', { agent, callId, seq: n, text: String(text), engine: 'local' }); } catch { /* the audio is kept without its text */ }
    },
    recordReplyText(text) {
      if (!sessionId || !callId || paused || ended || !String(text || '').trim()) return;
      postJson('/api/recordings/text', { agent, callId, text: String(text), at: iso(clock()) }).catch(() => {});
    },
    // The Pause / Resume button. The badge follows the server's answer; on a failure the old state stays and a short toast is shown.
    // Pausing first keeps what was already said: the recorder sends its open segment and stops capturing, and the hub is asked to pause at once (it takes pieces
    // while paused, so nothing waits for them). If the hub's answer is an error, capture goes back to what it was.
    async togglePause(want) {
      if (!callId || (state !== 'on' && state !== 'trouble' && state !== 'paused')) return;
      const old = paused;
      try {
        if (want && recorder) recorder.pause(true);   // nothing more is captured at once
        const j = await postJson('/api/recordings/pause', { agent, callId, paused: !!want });
        paused = j.paused === true;
        if (recorder) recorder.pause(paused);
        if (state === 'on' || state === 'trouble' || state === 'paused') show(live());
      } catch {
        if (recorder) recorder.pause(old);
        quiet(() => q.toast('Could not change the recording. It stays as it was.'));
      }
    },
    replyAudio(buf) {
      if (!active || !keepReplies || paused || consenting || ended || state === 'stopped' || !buf || !callId) return;
      let ms = 0;
      try { const dv = new DataView(buf); if (dv.byteLength >= 44 && dv.getUint32(28, true) > 0) ms = Math.round(dv.getUint32(40, true) * 1000 / dv.getUint32(28, true)); } catch { ms = 0; }
      const at = clock();
      sendAudio('agent', buf, at, at + ms, Date.now().toString(36) + '-' + (replyCount++).toString(36) + '-' + Math.random().toString(36).slice(2, 8).padEnd(4, '0')).catch(() => { /* a reply sentence that was not kept is not an alarm: the person's side is what is watched */ });
    },
    trouble,
    // The page is being hidden or closed: what the person is saying now is sent (stored in IndexedDB first). The call is not ended.
    flushOpen() { if (active && recorder && typeof recorder.cut === 'function') quiet(() => recorder.cut()); },
    stop() { proxy.stop(); },
  };
}
// The wake chime: two soft sine notes (660 Hz, then 880 Hz), 110 ms each, 40 ms apart, peak gain 0.08 (10 ms attack, exponential decay).
// Pure Web Audio on the given AudioContext, no asset. -> true when scheduled, false when there is no context or anything threw.
function voicePlayWakeChime(ctx) {
  try {
    if (!ctx || typeof ctx.createOscillator !== 'function') return false;
    const t0 = ctx.currentTime + 0.02;
    [[660, 0], [880, 0.15]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain(), s = t0 + offset, e = s + 0.11;
      osc.type = 'sine'; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, s);
      gain.gain.linearRampToValueAtTime(0.08, s + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, e);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(s); osc.stop(e + 0.02);
    });
    return true;
  } catch { return false; }
}
// ── voice call (end) ──

if (typeof module !== 'undefined' && module.exports) module.exports = { voicePlayWakeChime, voiceCreateCall, voiceCreateLinkWatch, voiceLinkTone, voiceCreateVad, voiceDecisionWord, voiceMatchChoice, voiceStatusLine,
  voiceRoomCheck, voiceVadThresholds, voiceReplySentences, voiceSpokenLead, VOICE_LEAD_MAX_SENTENCES, voiceJoinOr, voiceCreateThinkingSound, voiceLiveTracks, VOICE_THINKING_LINES,
  voiceCreateKeepAlive, voiceCreateRecorder, voiceRecStore, voiceRecResendPending, voiceRecSegmentUrl, voiceWavFromFloat, voiceCreateRecordingSession, voiceRecSettings, VOICE_REC_NEEDS_LOCAL, VOICE_ECHO_HOLD_MS, VOICE_CALL_LEAD_IN_MS, voiceOpenMicStream, voiceCarRecord };
