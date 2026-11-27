'use strict';
// Per-person voice preference: whether an agent starts reading chat details aloud with "Remember, you can interrupt me any time."
// Default ON. Keyed by the signed-in account id (a string), or 'owner' on an install with no accounts.
// The file holds { people: { <key>: { interruptReminder: boolean } } } and nothing else. Set only by the voice_interrupt_reminder
// tool, on a live call, by the person speaking.

const fs = require('fs');
const path = require('path');

const MAX_PEOPLE = 1000;

function bad(message) { const e = new Error(message); e.code = 'bad_request'; return e; }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function cleanKey(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64) throw bad('person key must be a string of 1 to 64 characters');
  return v;
}
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

function createVoicePersonPrefs({ file } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createVoicePersonPrefs needs a file');
  let data = null;   // key -> boolean; replaced whole after a successful write

  function writePrivate(f, obj) {
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, f);
  }

  function load() {
    if (data) return data;
    const out = {};
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const people = isObj(raw) && isObj(raw.people) ? raw.people : {};
      for (const k of Object.keys(people)) {
        if (k.length < 1 || k.length > 64 || !isObj(people[k]) || typeof people[k].interruptReminder !== 'boolean') continue;
        if (Object.keys(out).length < MAX_PEOPLE) out[k] = people[k].interruptReminder;
      }
    } catch { /* missing or corrupt: everyone keeps the default */ }
    return (data = out);
  }

  function interruptReminder(personKey) {
    if (typeof personKey !== 'string') return true;
    const all = load();
    return hasOwn(all, personKey) ? all[personKey] : true;
  }

  function setInterruptReminder(personKey, on) {
    cleanKey(personKey);
    if (typeof on !== 'boolean') throw bad('on must be true or false');
    const cur = load();
    if (!hasOwn(cur, personKey) && Object.keys(cur).length >= MAX_PEOPLE) throw bad(`at most ${MAX_PEOPLE} people can have their own voice settings`);
    const next = { ...cur, [personKey]: on };
    // The settings journal (store "prefs", key prefs.<person>.voice.interruptReminder), in two phases: a pending entry before the file (a
    // change it cannot record is refused), a commit after it; a failed write marks the entry failed and the error propagates.
    const was = hasOwn(cur, personKey) ? cur[personKey] : true;
    const changes = was !== on ? [{ key: `prefs.${personKey}.voice.interruptReminder`, before: was, after: on }] : [];
    require('./settings-journal').journaledWrite(file, changes, () => {
      const people = {};
      for (const k of Object.keys(next)) people[k] = { interruptReminder: next[k] };
      writePrivate(file, { people });
    });
    data = next;
    return on;
  }

  return { interruptReminder, setInterruptReminder };
}

const NOT_ON_CALL = 'This only works on a voice call, for the person speaking.';

/**
 * The voice_interrupt_reminder tool, as a pure function. turn = { moodStrip, ephemeral, consultedBy, depth, tigerTeam, originKind, personKey }
 * is built by the hub from the turn itself, never from the tool input. Refuses (changes nothing) unless this is a live voice call
 * of the signed-in person speaking.
 */
function handleInterruptReminderTool({ on, turn } = {}, store) {
  const t = turn || {};
  const live = t.moodStrip === true && !t.ephemeral && !t.consultedBy && !(Number(t.depth) > 0) && !t.tigerTeam
    && t.originKind === 'user' && typeof t.personKey === 'string' && t.personKey.length > 0;
  if (!live) return NOT_ON_CALL;
  if (typeof on !== 'boolean') return 'Say whether to stop or bring back the reminder: on must be true or false.';
  try { store.setInterruptReminder(t.personKey, on); } catch { return 'That could not be saved; nothing was changed.'; }
  return on ? 'Done: I will remind them again that they can interrupt me.' : 'Done: I will no longer remind them that they can interrupt me.';
}

let singleton = null;
function getVoicePersonPrefs() {
  if (!singleton) singleton = createVoicePersonPrefs({ file: path.join(__dirname, '..', 'data', 'voice-person-prefs.json') });
  return singleton;
}

module.exports = { createVoicePersonPrefs, getVoicePersonPrefs, handleInterruptReminderTool, NOT_ON_CALL, MAX_PEOPLE };
