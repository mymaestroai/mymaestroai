'use strict';
// Voice fixes 1 (2026-11-12): the spoken-text cleaner (voiceSpeechText is the one function every spoken string passes
// through) on realistic agent replies, plus the new per-device prefs (voice speed, end-of-turn pause, spoken activity).
// Non-ASCII characters are written as \u escapes: the source has no emoji, no U+FE0F and no zero-width characters.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const V = require('../lib/ui-voice');
const { voiceSpeechText: say, voiceSentences, voiceCleanSpeed, voiceSpeedLabel, voiceLoadPrefs, voiceSavePrefs } = V;

const memStore = (init) => {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); } };
};

test('cleaner: a bulleted plan becomes separate sentences, bold markers are gone', () => {
  assert.strictEqual(say('Here\'s the plan:\n\n- Back up the database\n- Run the migration\n- Restart the **hub**\n\nI\'ll start now.'),
    'Here\'s the plan: Back up the database. Run the migration. Restart the hub. I\'ll start now.');
});

test('cleaner: a table is skipped entirely and the note is added once', () => {
  assert.strictEqual(say('Results for this week:\n\n| Metric | Value |\n|---|---|\n| Users | 120 |\n| Errors | 3 |\n\nLooks healthy overall.'),
    'Results for this week: Looks healthy overall. I have put the details in the chat.');
});

test('cleaner: a code block is skipped, inline code keeps its words', () => {
  assert.strictEqual(say('Run this:\n```bash\nnpm test --silent\n```\nThen tell me what you see.'),
    'Run this: Then tell me what you see. I have put the details in the chat.');
  assert.strictEqual(say('Call `foo_bar` and then `baz`.'), 'Call foo bar and then baz.');
});

test('cleaner: file paths say "a file path", URLs say "a link"', () => {
  assert.strictEqual(say('I changed `/home/sam/agent-hub/lib/ui-voice.js` and lib/ui-voice-call.js, then ran npm test.'),
    'I changed a file path and a file path, then ran npm test.');
  assert.strictEqual(say('See ~/notes/todo.md, ./run.sh and C:\\Users\\me\\a.txt.'), 'See a file path, a file path and a file path.');
  assert.strictEqual(say('The docs are at https://docs.example.com/guide/start?x=1 and www.example.org too.'), 'The docs are at a link and a link too.');
  assert.strictEqual(say('Read [the guide](https://example.com/guide) first.'), 'Read the guide first.');
  assert.strictEqual(say('Say yes/no, and/or maybe, 24/7.'), 'Say yes no, and or maybe, 24 7.', 'a slash in a word pair is not a path');
});

test('cleaner: em and en dashes used as separators become a comma pause; hyphens inside words stay', () => {
  assert.strictEqual(say('It\'s done \u2014 mostly. One thing is left \u2013 the follow-up call \u2014 which I\'ll do tomorrow.'),
    'It\'s done, mostly. One thing is left, the follow-up call, which I\'ll do tomorrow.');
  assert.strictEqual(say('Next -- after lunch - maybe.'), 'Next, after lunch, maybe.');
  assert.strictEqual(say('A well-known, up-to-date follow-up.'), 'A well-known, up-to-date follow-up.');
  assert.strictEqual(say('Pages 5\u201310 and a -5 degree dip.'), 'Pages 5 to 10 and a minus 5 degree dip.');
  assert.strictEqual(say('Run npm install --force now.'), 'Run npm install force now.');
});

test('cleaner: emoji and stray symbols are dropped, & % + @ are read as words', () => {
  assert.strictEqual(say('All set \u2705 \u{1F389} Thanks for waiting \u{1F64F}! Cost: 5% less & 3+4 items @ home.'),
    'All set Thanks for waiting! Cost: 5 percent less and 3 plus 4 items at home.');
  assert.strictEqual(say('Go A => B -> C \u2192 D, ignore * _ ~ ` # > | / \\ here.'), 'Go A B C D, ignore here.');
  assert.strictEqual(say('Use brackets [like this] and (like this) and {this}.'), 'Use brackets like this and like this and this.');
  assert.strictEqual(say('Say \u201Cstop\u201D now\u2026 it\u2019s fine.'), 'Say stop now... it\'s fine.');
  assert.strictEqual(say('Heart \u2764\uFE0F and family \u{1F468}\u200D\u{1F469}\u200D\u{1F467} fine.'), 'Heart and family fine.');
});

test('cleaner: bold, italic, underline and strike-through markers go, their words stay', () => {
  assert.strictEqual(say('**Important:** the *new* build is __ready__ and ~~old~~ one is gone.'), 'Important: the new build is ready and old one is gone.');
});

test('cleaner: numbered steps and headings are separate sentences', () => {
  assert.strictEqual(say('1. Open Settings\n2. Click **Voices**\n3. Pick a voice -> press Play\n4. Done (about 10 seconds)'),
    'Open Settings. Click Voices. Pick a voice press Play. Done about 10 seconds.');
  assert.strictEqual(say('## Summary\nThe fix works.\n### Next\nWe ship tomorrow.'), 'Summary. The fix works. Next. We ship tomorrow.');
  assert.strictEqual(say('**Plan**\nStep one is easy.'), 'Plan. Step one is easy.');
});

test('cleaner: normal punctuation and apostrophes are kept, whitespace is collapsed, empty stays empty', () => {
  assert.strictEqual(say('Wait: really? Yes! It\'s fine; go on, please.'), 'Wait: really? Yes! It\'s fine; go on, please.');
  assert.strictEqual(say('  lots   of   space  '), 'lots of space.');
  assert.strictEqual(say('---\n***\n'), '');
  assert.strictEqual(say('\u{1F600}'), '');
  assert.strictEqual(say(undefined), '');
});

test('cleaner: running it twice changes nothing (call lines are cleaned again at playback)', () => {
  const samples = [
    'Here\'s the plan:\n\n- Back up the database\n- Run the **migration** at /var/log/app.log\n\nSee https://x.io/a \u2014 now & later, 5% done.',
    'Results:\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nOk.',
    'Options: Red, Green or Blue.', 'Stopped.', 'Still working on it.', 'Running a command.',
  ];
  for (const s of samples) { const once = say(s); assert.strictEqual(say(once), once, s); }
});

test('cleaner: a text that is still being written never gets a full stop on its last line', () => {
  assert.strictEqual(say('One. Two. Thr', true), 'One. Two. Thr');
  assert.strictEqual(say('- first\n- seco', true), 'first. seco');
  assert.strictEqual(say('One. Two. Thr', false), 'One. Two. Thr.');
  assert.deepStrictEqual(voiceSentences(say('- first\n- second\n- third')), ['first.', 'second.', 'third.']);
});

test('the cleaner source has no emoji, U+FE0F or zero-width characters', () => {
  const bad = new RegExp('[' + [0xFE0F, 0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF].map(c => String.fromCharCode(c)).join('') + ']');
  for (const f of ['lib/ui-voice.js', 'lib/ui-voice-call.js', 'test/ui-voice-clean.test.js', 'test/ui-voice-call-fixes.test.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(!bad.test(src), f);
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(src), f + ' has no emoji');
  }
});

test('prefs: voice speed is 0.75 to 1.5 in steps of 0.05 (default 1), the pause is 800 / 1200 / 2000, spoken activity is off', () => {
  assert.strictEqual(voiceCleanSpeed(1.1), 1.1);
  assert.strictEqual(voiceCleanSpeed(0.2), 0.75);
  assert.strictEqual(voiceCleanSpeed(9), 1.5);
  assert.strictEqual(voiceCleanSpeed(1.12), 1.1);
  assert.strictEqual(voiceCleanSpeed('x'), 1);
  assert.strictEqual(voiceSpeedLabel(1.1), '1.10x');
  assert.strictEqual(voiceSpeedLabel(1), '1.00x');
  const p = voiceLoadPrefs(memStore());
  assert.strictEqual(p.endPause, 1200); assert.strictEqual(p.voiceSpeed, 1); assert.strictEqual(p.speakActivity, false);
  const st = memStore();
  const saved = voiceSavePrefs(st, { endPause: 2000, voiceSpeed: 1.3, speakActivity: true });
  assert.deepStrictEqual([saved.endPause, saved.voiceSpeed, saved.speakActivity], [2000, 1.3, true]);
  assert.deepStrictEqual([voiceLoadPrefs(st).endPause, voiceLoadPrefs(st).voiceSpeed], [2000, 1.3], 'remembered per device');
  const bad = voiceLoadPrefs(memStore({ 'hub-voice': '{"endPause":1500,"voiceSpeed":"fast","speakActivity":"yes"}' }));
  assert.deepStrictEqual([bad.endPause, bad.voiceSpeed, bad.speakActivity], [1200, 1, false], 'bad values fall back to the defaults');
  assert.deepStrictEqual(V.VOICE_END_PAUSES, [800, 1200, 2000]);
});

test('the typographic minus sign is read as minus, not dropped (a reviewer found -5 read as 5)', () => {
  assert.strictEqual(say('The temperature is −5 degrees.'), 'The temperature is minus 5 degrees.');
  assert.strictEqual(say(say('The temperature is −5 degrees.')), 'The temperature is minus 5 degrees.');
});
