'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createMoodFilter, FACE_MOOD_NOTE, MOODS, MAX_BUFFER } = require('../lib/voice/mood.js');

function run(chunks, enabled = true) {
  const moods = [];
  const f = createMoodFilter({ enabled, onMood: (m) => moods.push(m) });
  let out = '';
  for (const c of chunks) out += f.push(c);
  out += f.finish();
  return { out, moods };
}
// every way to cut s into 1, 2 and 3 pieces, plus char by char
function* splits(s) {
  yield [s];
  for (let i = 0; i <= s.length; i++) {
    yield [s.slice(0, i), s.slice(i)];
    for (let j = i; j <= s.length; j++) yield [s.slice(0, i), s.slice(i, j), s.slice(j)];
  }
  yield s.split('');
}
function check(input, expOut, expMoods) {
  for (const parts of splits(input)) {
    const r = run(parts);
    assert.strictEqual(r.out, expOut, JSON.stringify({ input, parts }));
    assert.deepStrictEqual(r.moods, expMoods, JSON.stringify({ input, parts }));
  }
}

test('known tags stripped, mood reported once, all splits', () => {
  for (const m of MOODS) {
    check(`[${m}] Hello there.`, 'Hello there.', [m]);
    check(`[${m.toUpperCase()}]Hello`, 'Hello', [m]);
    check(`  \n[${m}]\n\n Hello [${m}] again`, `Hello [${m}] again`, [m]);
    check(`[${m}]`, '', [m]); // tag-only turn
    check(`[${m}]  \n`, '', [m]);
  }
});

test('unknown words are ordinary text: kept, no mood, never empty', () => {
  for (const s of ['[excited] Great news', '[Zzz]ok', '[excited]', '[Summary] The plan is ready.', '[x] done', '[OK]',
    '  [OK] fine', '[curiou] x', '[curiouss] x', '[proudly]']) check(s, s, []);
});

test('ordinary bracket syntax preserved', () => {
  const same = [
    '[1] first item', '[a b] x', '[] empty', '[crazy-ish] x', '[curious', '[curious ', '[curi',
    '[', '[[curious]]', 'Hello [curious] there', '  hi [x]', '[1](u)',
    '[Docs](https://example.com/x) are here', '[curious](http://x)', '[curious][ref]',
    '[curious]: not a tag', '[curious]( x', '',
  ];
  for (const s of same) check(s, s, []);
  check('  [Docs](u)', '  [Docs](u)', []);
});

test('only the first leading tag is a tag', () => {
  check('[curious] [proud] hi', '[proud] hi', ['curious']);
});

test('unclosed / malformed bounded at 64', () => {
  const long = '[' + 'a'.repeat(200) + '] text';
  check(long, long, []);
  const exact = '[' + 'a'.repeat(MAX_BUFFER - 2) + '] text'; // 64 chars, unknown word
  check(exact, exact, []);
  const wsMood = ' '.repeat(MAX_BUFFER - '[curious]'.length) + '[curious] text'; // tag exactly 64 chars
  check(wsMood, 'text', ['curious']);
  const wsOver = ' '.repeat(MAX_BUFFER - '[curious]'.length + 1) + '[curious] text';
  check(wsOver, wsOver, []);
  const over = '[' + 'a'.repeat(MAX_BUFFER - 1) + '] text'; // 65
  check(over, over, []);
  const ws = ' '.repeat(100) + '[curious] x';
  check(ws, ws, []);
});

test('memory is bounded: held text never exceeds MAX_BUFFER', () => {
  const f = createMoodFilter({ enabled: true });
  let held = 0;
  const input = '[' + 'a'.repeat(500);
  for (const ch of input) held += 1, held -= f.push(ch).length;
  assert.ok(held === 0 || held <= MAX_BUFFER);
  assert.strictEqual(f.finish(), '');
});

test('plain text streaming passes through promptly', () => {
  const f = createMoodFilter({ enabled: true });
  assert.strictEqual(f.push('Hello'), 'Hello');
  assert.strictEqual(f.push(' [curious] world'), ' [curious] world');
  assert.strictEqual(f.finish(), '');
});

test('held markdown link waits for the char after the bracket', () => {
  const f = createMoodFilter({ enabled: true });
  assert.strictEqual(f.push('[curious]'), '');
  assert.strictEqual(f.push('('), '[curious](');
  assert.strictEqual(f.push('u)'), 'u)');
  const g = createMoodFilter({ enabled: true, onMood: () => {} });
  assert.strictEqual(g.push('[curious]'), '');
  assert.strictEqual(g.push(' x'), 'x');
  // a non-mood word is ordinary text at once: nothing to wait for
  const h = createMoodFilter({ enabled: true });
  assert.strictEqual(h.push('[Docs]'), '[Docs]');
  assert.strictEqual(h.push('(u)'), '(u)');
});

test('finish flushes pending plain content', () => {
  const f = createMoodFilter({ enabled: true });
  assert.strictEqual(f.push('  [cur'), '');
  assert.strictEqual(f.finish(), '  [cur');
  assert.strictEqual(f.push('more'), 'more'); // spent: passes through
  const g = createMoodFilter({ enabled: true });
  assert.strictEqual(g.push('   '), '');
  assert.strictEqual(g.finish(), '   ');
});

test('cancel drops held text and fires no mood', () => {
  const moods = [];
  const f = createMoodFilter({ enabled: true, onMood: (m) => moods.push(m) });
  assert.strictEqual(f.push('[curious]'), '');
  assert.strictEqual(f.cancel(), '');
  assert.strictEqual(f.finish(), '');
  assert.deepStrictEqual(moods, []);
});

test('disabled is byte for byte', () => {
  for (const s of ['[curious] hi', '  [x]', '', '[1](u)', 'plain']) {
    const moods = [];
    const f = createMoodFilter({ enabled: false, onMood: (m) => moods.push(m) });
    assert.strictEqual(f.push(s), s);
    assert.strictEqual(f.finish(), '');
    assert.deepStrictEqual(moods, []);
  }
  assert.strictEqual(createMoodFilter().push('[curious] a'), '[curious] a');
});

test('a throwing listener does not break the stream', () => {
  const f = createMoodFilter({ enabled: true, onMood: () => { throw new Error('x'); } });
  assert.strictEqual(f.push('[proud] ok'), 'ok');
});

test('FACE_MOOD_NOTE lists the fixed words and does not mention the orb', () => {
  assert.strictEqual(typeof FACE_MOOD_NOTE, 'string');
  for (const m of MOODS) assert.ok(FACE_MOOD_NOTE.includes('[' + m + ']'));
  assert.ok(!/orb/i.test(FACE_MOOD_NOTE));
});
