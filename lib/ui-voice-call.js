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
  // deps.keepAlive ({ start(), stop() }, optional): an inaudible sound that keeps a Bluetooth / car audio route awake. It starts with the call and
  // the first spoken line of the call waits until VOICE_CALL_LEAD_IN_MS after that (the route needs a moment to open, or the first syllable is lost).
  let leadInUntil = 0, keepAliveOn = false, micLost = false;
  let linkLost = false, linkWasLost = false;   // the connection to the server is lost (setLinkLost): speech is dropped, nothing is reported as an error
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
    clearBegin();
    segmentStarting();
    // Real speech, a misfire and an end all clear this timer, so when it fires no real start came: let the false start go.
    beginTimer = d.setTimer(() => { beginTimer = null; if (!ended && personSpeaking) { personSpeaking = false; speechAnn = null; capWake = null; segmentDropped(); settle(); } }, 4000);
  }
  // Real speech began (the VAD adapter calls this from onSpeechRealStart, so a cough or a click does not cut the reading).
  function onSpeechStart() {
    if (ended) return;
    clearBegin();
    if (!personSpeaking) speechAnn = heardAnnouncement();   // no onSpeechBegin came first
    if (!personSpeaking || !capWake) capWake = { sb: standby, seq: wakeSeq };
    personSpeaking = true; stopThinking(); clearQuiet();
    quiet(() => ui.reply('drop'));   // real speech: a reaction that has not played is dropped
    segmentStarting();
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
    clearBegin(); segmentDropped();
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
    personSpeaking = false; speechEndAt = now(); cutRec = null;
    // sb and seq: was this said in standby (when it began, or now), and how many wakes had there been. Said in standby, it needs the phrase unless a wake came
    // in between (the phrase said alone, then this): so neither a switch-off nor a lost recognizer check can release it.
    const cap = capWake || { sb: standby, seq: wakeSeq }; capWake = null;
    const mine = { endAt: now(), ann: speechAnn, carry: '', done: false, hold: null, waiting: false, onJoin: null, sb: cap.sb || standby, seq: cap.seq };
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
        try { text = dropLong || linkLost ? '' : await d.stt(audio); } catch { failed = true; if (!mustMatch() && !linkLost) quiet(() => ui.toast('Could not transcribe that.')); }
        if (ended || linkLost) return;   // while the connection is lost what was heard is dropped, not sent
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
          if (ended) return;
          if (next) { next.carry = t; if (next.ann == null) next.ann = mine.ann; return; }
          if (timedOut || !waited) break;
          // A misfire (cough, click) ended the wait early: the rest of the wait goes on.
          const left = ms - (now() - waitStart);
          if (left <= 0) break;
          await waitMore(left);
          if (ended) return;
        }
        if (linkLost) return;
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
        awaitingReply = true; replyEnded = false; turnAt = now(); stillSaid = false; quiet(() => ui.reply('start')); setState('thinking'); armStill(); armThinking();
        await d.interject(t);
      } else {
        awaitingReply = true; replyEnded = false; cutSkip = false; spokenCount = 0; noteSpoken = false; lastText = ''; lastDone = false; turnAt = now(); stillSaid = false; stillUsed = [];
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
    if (on) { linkLost = true; linkWasLost = true; return; }
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
  const say = (f) => { try { if (typeof f === 'function') f(); } catch { /* a listener must not break the watch */ } };
  const clear = (t) => { if (t !== null) { try { clrT(t); } catch { /* gone */ } } return null; };
  function schedule(ms) {
    timer = clear(timer);
    if (running) timer = setT(() => { timer = null; probeNow(); }, ms);
  }
  function markLost() {
    if (!running || lost) return;
    lost = true; lostAt = clock();
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
    const my = gen;
    let p;
    try { p = Promise.resolve(c.probe()); } catch { p = Promise.resolve(false); }
    p.then((ok) => ok === true, () => false).then((ok) => {
      if (my !== gen || !running) return;
      probing = false;
      if (ok) {
        if (lost) {
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
async function voiceOpenMicStream(nav) {
  const md = nav.mediaDevices;
  try { return { stream: await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }), fallback: false }; } catch (first) {
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
    mdOff: null, devTimer: null, reopening: null, info: null, defSnap: null };
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
  const call = (name, arg) => { try { const f = st.handlers[name]; if (typeof f === 'function') f(arg); } catch { /* the handler's own problem */ } };
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
    const r = await voiceOpenMicStream(st.nav);
    return { raw: r.stream, fallback: r.fallback };
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
  function reopen(reason) {
    if (st.reopening) return st.reopening;
    if (!st.ctx || !st.gain || !st.nav) return Promise.resolve(false);
    const my = st.gen, prev = st.info ? st.info.label : '';
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
    } catch (e) { if (!stale()) await stop(); else await release(); throw e; }
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
    setMicLevel(v) { st.micLevel = v; if (st.gain) st.gain.gain.value = voiceGainFromSlider(v); },
    setInterruptSensitivity(v) { st.sens = v; apply(); },
    // 'Pause before I'm done': only the END of a turn waits this long; the start of speech (barge-in) is not delayed.
    setEndPause(ms) { st.pause = pause(ms); if (st.vad) st.vad.setOptions({ redemptionMs: st.pause }); },
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
  voiceCreateKeepAlive, VOICE_ECHO_HOLD_MS, VOICE_CALL_LEAD_IN_MS, voiceOpenMicStream, voiceCarRecord };
