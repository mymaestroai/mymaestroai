'use strict';
// Per-person choice about deep research: 'ask' (default), 'always' or 'never', and for 'never' when the person was last
// reminded that it is off. Keyed by the signed-in account id (a string), or 'owner' on an install with no accounts.
// The file holds { people: { <key>: { choice, remindedAt, alwaysLevel } } } and nothing else.

const fs = require('fs');
const path = require('path');

const MAX_PEOPLE = 1000;
const CHOICES = ['ask', 'always', 'never'];
const LEVELS = ['quick', 'thorough'];

function bad(message) { const e = new Error(message); e.code = 'bad_request'; return e; }
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function cleanKey(v) {
  if (typeof v !== 'string' || v.length < 1 || v.length > 64) throw bad('person key must be a string of 1 to 64 characters');
  return v;
}
function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function createResearchPrefs({ file, now = Date.now } = {}) {
  if (typeof file !== 'string' || !file) throw new Error('createResearchPrefs needs a file');
  let data = null;   // key -> { choice, remindedAt }; replaced whole after a successful write

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
        if (k.length < 1 || k.length > 64 || !isObj(people[k]) || !CHOICES.includes(people[k].choice)) continue;
        if (Object.keys(out).length < MAX_PEOPLE) out[k] = { choice: people[k].choice, remindedAt: isTime(people[k].remindedAt) ? people[k].remindedAt : null, alwaysLevel: LEVELS.includes(people[k].alwaysLevel) ? people[k].alwaysLevel : 'quick' };
      }
    } catch { /* missing or corrupt: everyone keeps the default */ }
    return (data = out);
  }

  function save(next) {
    writePrivate(file, { people: next });
    data = next;
  }

  function choiceOf(personKey) {
    if (typeof personKey !== 'string') return 'ask';
    const all = load();
    return hasOwn(all, personKey) ? all[personKey].choice : 'ask';
  }

  /** Stores the choice. Choosing 'never' counts as being told it is off: the first reminder comes one interval later. */
  function setChoice(personKey, choice) {
    cleanKey(personKey);
    if (!CHOICES.includes(choice)) throw bad(`choice must be one of: ${CHOICES.join(', ')}`);
    const cur = load();
    if (!hasOwn(cur, personKey) && Object.keys(cur).length >= MAX_PEOPLE) throw bad(`at most ${MAX_PEOPLE} people can have their own research settings`);
    const was = hasOwn(cur, personKey) ? cur[personKey] : null;
    const remindedAt = choice !== 'never' ? null : (was && was.choice === 'never' ? was.remindedAt : now());
    save({ ...cur, [personKey]: { choice, remindedAt, alwaysLevel: was ? was.alwaysLevel : 'quick' } });
    return choice;
  }

  /** The level an 'Always yes' person's research runs at: 'quick' (default) or 'thorough'. */
  function alwaysLevelOf(personKey) {
    if (typeof personKey !== 'string') return 'quick';
    const all = load();
    return hasOwn(all, personKey) ? all[personKey].alwaysLevel : 'quick';
  }

  /** Stores the always level; the person's choice and reminder clock are left as they are. */
  function setAlwaysLevel(personKey, level) {
    cleanKey(personKey);
    if (!LEVELS.includes(level)) throw bad(`level must be one of: ${LEVELS.join(', ')}`);
    const cur = load();
    if (!hasOwn(cur, personKey) && Object.keys(cur).length >= MAX_PEOPLE) throw bad(`at most ${MAX_PEOPLE} people can have their own research settings`);
    const was = hasOwn(cur, personKey) ? cur[personKey] : { choice: 'ask', remindedAt: null };
    save({ ...cur, [personKey]: { choice: was.choice, remindedAt: was.remindedAt, alwaysLevel: level } });
    return level;
  }

  /** Whether a person who chose 'never' is due a reminder that it is off (intervalMs 0 or less: never). */
  function remindDue(personKey, intervalMs) {
    if (typeof personKey !== 'string' || !(Number(intervalMs) > 0)) return false;
    const all = load();
    if (!hasOwn(all, personKey) || all[personKey].choice !== 'never') return false;
    const at = all[personKey].remindedAt;
    return !isTime(at) || now() - at >= Number(intervalMs);
  }

  /** Records that the person was just reminded (only while their choice is 'never'). */
  function markReminded(personKey) {
    cleanKey(personKey);
    const cur = load();
    if (!hasOwn(cur, personKey) || cur[personKey].choice !== 'never') return false;
    save({ ...cur, [personKey]: { choice: 'never', remindedAt: now(), alwaysLevel: cur[personKey].alwaysLevel } });
    return true;
  }

  return { choiceOf, setChoice, alwaysLevelOf, setAlwaysLevel, remindDue, markReminded };
}

let singleton = null;
function getResearchPrefs() {
  if (!singleton) singleton = createResearchPrefs({ file: path.join(__dirname, '..', 'data', 'research-prefs.json') });
  return singleton;
}

module.exports = { createResearchPrefs, getResearchPrefs, CHOICES, LEVELS, MAX_PEOPLE };
