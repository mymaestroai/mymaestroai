'use strict';
// Leading mood tag filter for voice replies. Pure: no I/O, no timers, no
// dependencies. One filter instance per reply (turn).
//
// GRAMMAR (exact). A reply may begin with one optional mood tag:
//
//   reply   = ws* "[" word "]" next
//   ws      = any character matching /\s/
//   word    = 1 or more ASCII letters [A-Za-z]  (case-insensitive)
//   next    = the first character after "]"
//
// The tag is recognised ONLY at the very start of the reply (after optional
// leading whitespace). It is NOT a tag, and the text is passed through
// unchanged, when any of these hold:
//   - the first non-whitespace character is not "["
//   - the bracket holds anything but 1+ ASCII letters ("[1]", "[a b]", "[]",
//     "[crazy-ish]")
//   - the "]" is followed by "(" , "[" or ":" (Markdown inline link
//     "[Title](url)", reference link "[Title][ref]", reference definition
//     "[Title]: url") -- the decision waits for that one character, even
//     across a chunk boundary
//   - the whole bracketed text, with its leading whitespace, would exceed
//     MAX_BUFFER (64) characters before it closes (malformed / unclosed)
//   - the word (lower-cased) is not one of MOODS ("[Summary]", "[x]", "[OK]"):
//     ordinary text, kept exactly, no mood, never emptied
// When it IS a tag (the word is one of MOODS): the leading whitespace, the
// bracketed word and all whitespace that immediately follows are removed and
// onMood(word) is called exactly once, as soon as the character after "]" is
// seen (or at finish() for a tag-only reply). A tag anywhere else
// (not leading, or a second tag) is ordinary text.
//
// Memory: at most MAX_BUFFER characters are ever held; once the decision is
// made, text passes straight through. Output never contains held text twice.
//
// disabled (enabled !== true): push(t) returns t byte for byte, finish()
// returns '', cancel() returns ''.
//
// After finish() or cancel() the filter is spent and passes later text through.

const MOODS = Object.freeze(['delighted', 'laughing', 'sympathetic', 'surprised', 'proud', 'curious', 'encouraging']);
const MAX_BUFFER = 64;

const FACE_MOOD_NOTE =
  'Your face is shown on screen during this call. Optionally, begin your reply with exactly one mood word in square brackets, ' +
  'chosen from: ' + MOODS.map((m) => '[' + m + ']').join(', ') + '. ' +
  'Use it only when it truly fits, at the very start, before any other word, and never more than once. ' +
  'Leave it out for ordinary replies. It is removed before anything is spoken or shown.';

function createMoodFilter(opts) {
  const o = opts || {};
  const enabled = o.enabled === true;
  const onMood = typeof o.onMood === 'function' ? o.onMood : null;
  // state: 'lead' (deciding), 'skipws' (tag removed, eating whitespace), 'pass'
  let state = enabled ? 'lead' : 'pass';
  let buf = ''; // held text, only in 'lead'; <= MAX_BUFFER

  function plain(rest) { // give up: release the held text plus the rest
    const out = buf + rest;
    buf = '';
    state = 'pass';
    return out;
  }

  function confirm() { // buf is a complete tag
    const word = buf.replace(/^\s*\[/, '').slice(0, -1).toLowerCase();
    buf = '';
    state = 'skipws';
    if (onMood && MOODS.includes(word)) {
      try { onMood(word); } catch (_) { /* a listener must not break speech */ }
    }
  }

  function skipws(rest) {
    const t = rest.replace(/^\s+/, '');
    if (t) state = 'pass';
    return t;
  }

  function push(text) {
    if (!enabled) return text;
    let s = typeof text === 'string' ? text : (text == null ? '' : String(text));
    if (state === 'pass') return s;
    if (state === 'skipws') return skipws(s);
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const closed = buf.endsWith(']');
      if (closed) {
        if (c === '(' || c === '[' || c === ':') return plain(s.slice(i));
        confirm();
        return skipws(s.slice(i));
      }
      if (buf.length + 1 > MAX_BUFFER) return plain(s.slice(i));
      const open = buf.includes('[');
      if (!open) {
        if (/\s/.test(c)) buf += c;
        else if (c === '[') buf += c;
        else return plain(s.slice(i));
      } else if (/[A-Za-z]/.test(c)) {
        buf += c;
        // not the start of any mood word: ordinary text, release it now
        const w = buf.slice(buf.indexOf('[') + 1).toLowerCase();
        if (!MOODS.some((m) => m.startsWith(w))) return plain(s.slice(i + 1));
      } else if (c === ']' && !buf.endsWith('[')) {
        buf += c;
        // only the seven moods are tags; "[Summary]", "[OK]" are ordinary text
        const w = buf.slice(buf.indexOf('[') + 1, -1).toLowerCase();
        if (!MOODS.includes(w)) return plain(s.slice(i + 1));
      } else {
        return plain(s.slice(i));
      }
    }
    return '';
  }

  function finish() {
    if (!enabled) return '';
    let out = '';
    if (state === 'lead') {
      if (buf.endsWith(']')) confirm(); // tag-only reply
      else out = plain('');
    }
    state = 'pass';
    return out;
  }

  function cancel() { // reply abandoned (barge-in / hang-up): drop held text, no mood
    buf = '';
    state = 'pass';
    return '';
  }

  return { push, finish, cancel };
}

module.exports = { createMoodFilter, FACE_MOOD_NOTE, MOODS, MAX_BUFFER };
