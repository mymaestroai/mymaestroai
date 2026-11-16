'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNotifyPrefs } = require('../lib/notify-prefs');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'notify-prefs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, 'push'), file: path.join(root, 'push', 'prefs.json') };
}
const badRequest = (fn) => assert.throws(fn, (e) => e.code === 'bad_request');

test('an unknown user reads all "on" and no agents', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  assert.deepEqual(p.get('owner'), { default: { questions: 'on', other: 'on' }, agents: {} });
  assert.equal(p.mode('owner', 'helper', 'questions'), 'on');
  assert.equal(p.mode('owner', null, 'other'), 'on');
});

test('resolution: agent kind, then default kind, then on', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  p.setDefault('owner', { other: 'away' });
  p.setAgent('owner', 'helper', { questions: 'off' });
  assert.equal(p.mode('owner', 'helper', 'questions'), 'off');
  assert.equal(p.mode('owner', 'helper', 'other'), 'away');      // falls to the default
  assert.equal(p.mode('owner', 'coach', 'questions'), 'on');     // no default for questions
  assert.equal(p.mode('owner', null, 'other'), 'away');
  assert.deepEqual(p.get('owner'), { default: { questions: 'on', other: 'away' }, agents: { helper: { questions: 'off' } } });
});

test('null removes a kind, an emptied agent entry goes, prefs null removes the agent', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  p.setAgent('owner', 'helper', { questions: 'off', other: 'away' });
  p.setAgent('owner', 'helper', { questions: null });
  assert.deepEqual(p.get('owner').agents, { helper: { other: 'away' } });
  p.setAgent('owner', 'helper', { other: null });
  assert.deepEqual(p.get('owner').agents, {});
  p.setAgent('owner', 'coach', { other: 'off' });
  p.setAgent('owner', 'coach', null);
  assert.deepEqual(p.get('owner').agents, {});
});

test('validation: modes, kinds, ids and names', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  badRequest(() => p.setDefault('owner', { questions: 'sometimes' }));
  badRequest(() => p.setDefault('owner', { questions: null }));          // the default cannot be removed
  badRequest(() => p.setDefault('owner', { loud: 'on' }));
  badRequest(() => p.setDefault('owner', null));
  badRequest(() => p.setDefault('', { other: 'on' }));
  badRequest(() => p.setDefault('x'.repeat(65), { other: 'on' }));
  badRequest(() => p.setDefault(7, { other: 'on' }));
  badRequest(() => p.setAgent('owner', '../etc', { other: 'on' }));
  badRequest(() => p.setAgent('owner', '-lead', { other: 'on' }));
  badRequest(() => p.setAgent('owner', 'a'.repeat(65), { other: 'on' }));
  badRequest(() => p.setAgent('owner', 'helper', { other: 'maybe' }));
  badRequest(() => p.setAgent('owner', 'helper', 'on'));
  badRequest(() => p.get(''));
  badRequest(() => p.touch('owner', '', true));
  badRequest(() => p.touch('owner', 'p'.repeat(65), true));
  badRequest(() => p.touch('owner', 'page', 'yes'));
  assert.deepEqual(p.get('owner'), { default: { questions: 'on', other: 'on' }, agents: {} });   // nothing half-applied
});

test('at most 500 agent entries per user', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  for (let i = 0; i < 500; i++) p.setAgent('owner', `agent-${i}`, { other: 'off' });
  badRequest(() => p.setAgent('owner', 'one-too-many', { other: 'off' }));
  p.setAgent('owner', 'agent-3', { other: 'away' });                      // an existing one can still change
  assert.equal(Object.keys(p.get('owner').agents).length, 500);
});

test('file: shape, mode 0600 in a 0700 dir, nothing else stored', (t) => {
  const f = tmp(t);
  let clock = Date.parse('2026-11-16T12:00:00Z');
  const p = createNotifyPrefs({ file: f.file, now: () => clock });
  p.setDefault('owner', { questions: 'away' });
  p.setAgent('owner', 'helper', { other: 'off' });
  p.touch('owner', 'page-1', true);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.dir).mode & 0o777, 0o700);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.file, 'utf8')), {
    owner: { default: { questions: 'away' }, agents: { helper: { other: 'off' } }, updatedAt: '2026-11-16T12:00:00.000Z' },
  });
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes('page-1'));         // presence is never saved
  const again = createNotifyPrefs({ file: f.file });                      // a fresh store reads the file lazily
  assert.equal(again.mode('owner', 'helper', 'other'), 'off');
  assert.equal(again.mode('owner', null, 'questions'), 'away');
});

test('a corrupt or foreign file reads as empty and is replaced on the next save', (t) => {
  const f = tmp(t);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.file, '{ not json');
  const p = createNotifyPrefs({ file: f.file });
  assert.deepEqual(p.get('owner'), { default: { questions: 'on', other: 'on' }, agents: {} });
  p.setDefault('owner', { other: 'off' });
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).owner.default.other, 'off');
  fs.writeFileSync(f.file, JSON.stringify({ sam: { default: { other: 'bogus', secret: 'x' }, agents: { 'bad name': { other: 'on' }, helper: { other: 'away', extra: 1 } }, token: 'x' } }));
  const q = createNotifyPrefs({ file: f.file });
  assert.deepEqual(q.get('sam'), { default: { questions: 'on', other: 'on' }, agents: { helper: { other: 'away' } } });
});

test('isolation: one person never changes another\'s settings', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  const before = JSON.stringify(p.get('sam'));
  p.setDefault('owner', { questions: 'off', other: 'off' });
  p.setAgent('owner', 'helper', { other: 'away' });
  assert.equal(JSON.stringify(p.get('sam')), before);
  assert.equal(p.mode('sam', 'helper', 'other'), 'on');
  p.setAgent('sam', 'helper', { other: 'on' });
  assert.equal(p.mode('owner', 'helper', 'other'), 'away');
  assert.deepEqual(p.get('owner').default, { questions: 'off', other: 'off' });
});

test('get() returns copies: editing the result does not change the store', (t) => {
  const p = createNotifyPrefs({ file: tmp(t).file });
  p.setAgent('owner', 'helper', { other: 'off' });
  const v = p.get('owner'); v.agents.helper.other = 'on'; v.default.other = 'off';
  assert.equal(p.mode('owner', 'helper', 'other'), 'off');
  assert.equal(p.mode('owner', 'coach', 'other'), 'on');
});

test('away: a fresh visible page means present; stale, hidden or unknown means away', (t) => {
  let clock = 1_000_000;
  const p = createNotifyPrefs({ file: tmp(t).file, now: () => clock, awayMs: 150000 });
  assert.equal(p.isAway('owner'), true);                                  // nothing reported (e.g. after a restart)
  p.touch('owner', 'a', true);
  assert.equal(p.isAway('owner'), false);
  clock += 150000;
  assert.equal(p.isAway('owner'), false);                                 // exactly at the limit still counts
  clock += 1;
  assert.equal(p.isAway('owner'), true);                                  // stale
  p.touch('owner', 'a', true);
  assert.equal(p.isAway('owner'), false);
  p.touch('owner', 'a', false);                                           // the page was hidden (or closed: beacon)
  assert.equal(p.isAway('owner'), true);
  p.touch('owner', 'b', true);                                            // another page of the same person
  assert.equal(p.isAway('owner'), false);
  assert.equal(p.isAway('sam'), true);                                    // presence is per person
});

test('presence keeps at most 20 pages per person and drops the oldest', (t) => {
  let clock = 5_000_000;
  const p = createNotifyPrefs({ file: tmp(t).file, now: () => clock });
  p.touch('owner', 'first', true);
  for (let i = 0; i < 20; i++) { clock += 10; p.touch('owner', `later-${i}`, false); }   // pushes 'first' out
  assert.equal(p.isAway('owner'), true);                                  // the one visible page was dropped
  p.touch('owner', 'later-0', true);
  assert.equal(p.isAway('owner'), false);
});

test('presence is memory only: a new store knows nothing', (t) => {
  const f = tmp(t);
  const a = createNotifyPrefs({ file: f.file });
  a.touch('owner', 'p', true);
  assert.equal(createNotifyPrefs({ file: f.file }).isAway('owner'), true);
});

// ---- write and read failures ----
const failingWrite = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };

test('a failed write leaves the cache unchanged for setDefault and setAgent, and the error propagates', (t) => {
  const f = tmp(t);
  let failing = false;
  const p = createNotifyPrefs({ file: f.file, write: (file, obj) => { if (failing) failingWrite(); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj)); } });
  p.setDefault('owner', { other: 'away' });
  p.setAgent('owner', 'helper', { questions: 'off' });
  const before = JSON.stringify([p.get('owner'), p.get('other-person'), p.mode('owner', 'helper', 'questions'), p.mode('owner', null, 'other')]);
  const onDisk = fs.readFileSync(f.file, 'utf8');
  failing = true;
  assert.throws(() => p.setDefault('owner', { other: 'off', questions: 'off' }), (e) => e.code === 'ENOSPC');
  assert.throws(() => p.setAgent('owner', 'helper', { questions: 'on', other: 'off' }), (e) => e.code === 'ENOSPC');
  assert.throws(() => p.setAgent('owner', 'helper', null), (e) => e.code === 'ENOSPC');
  assert.throws(() => p.setDefault('newcomer', { other: 'off' }), (e) => e.code === 'ENOSPC');
  assert.equal(JSON.stringify([p.get('owner'), p.get('other-person'), p.mode('owner', 'helper', 'questions'), p.mode('owner', null, 'other')]), before);
  assert.equal(p.mode('newcomer', null, 'other'), 'on');
  assert.equal(fs.readFileSync(f.file, 'utf8'), onDisk);
  failing = false;
  p.setDefault('owner', { other: 'off' });                                  // and it recovers
  assert.equal(p.mode('owner', null, 'other'), 'off');
});

test('a real failing rename (read-only directory) changes nothing', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root ignores directory permissions');
  const f = tmp(t);
  const p = createNotifyPrefs({ file: f.file });
  p.setDefault('owner', { questions: 'away' });
  fs.chmodSync(f.dir, 0o500);
  try {
    assert.throws(() => p.setAgent('owner', 'helper', { questions: 'off' }));
    assert.throws(() => p.setDefault('owner', { other: 'off' }));
  } finally { fs.chmodSync(f.dir, 0o700); }
  assert.deepEqual(p.get('owner'), { default: { questions: 'away', other: 'on' }, agents: {} });
  assert.equal(p.mode('owner', 'helper', 'questions'), 'away');
});

test('a missing file reads as empty and is cached', (t) => {
  const f = tmp(t);
  const p = createNotifyPrefs({ file: f.file });
  assert.equal(p.mode('owner', null, 'other'), 'on');
  p.setDefault('owner', { other: 'off' });
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).owner.default.other, 'off');
});

test('a file that is not JSON is kept as <file>.corrupt-<time> (0600), then reads as empty', (t) => {
  const f = tmp(t);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.file, '{ not json');
  const p = createNotifyPrefs({ file: f.file, now: () => 1234567 });
  assert.equal(p.mode('owner', null, 'other'), 'on');
  const copy = `${f.file}.corrupt-1234567`;
  assert.equal(fs.readFileSync(copy, 'utf8'), '{ not json');
  assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
  p.setDefault('owner', { other: 'off' });
  assert.equal(fs.readFileSync(copy, 'utf8'), '{ not json');                 // the copy stays
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).owner.default.other, 'off');
});

test('any other read error is not cached: reads say "on", writes throw without writing, and it recovers', (t) => {
  if (process.getuid && process.getuid() === 0) return t.skip('root can read a file with mode 000');
  const f = tmp(t);
  const seed = createNotifyPrefs({ file: f.file });
  seed.setDefault('sam', { other: 'off' });
  seed.setAgent('sam', 'helper', { questions: 'away' });
  const original = fs.readFileSync(f.file, 'utf8');
  fs.chmodSync(f.file, 0o000);
  const p = createNotifyPrefs({ file: f.file });
  try {
    assert.equal(p.mode('sam', null, 'other'), 'on');
    assert.deepEqual(p.get('sam'), { default: { questions: 'on', other: 'on' }, agents: {} });
    const noCode = (e) => e instanceof Error && e.code === undefined;
    assert.throws(() => p.setDefault('sam', { questions: 'off' }), noCode);
    assert.throws(() => p.setAgent('sam', 'helper', { other: 'off' }), noCode);
  } finally { fs.chmodSync(f.file, 0o600); }
  assert.equal(fs.readdirSync(f.dir).filter(n => n !== 'prefs.json').length, 0);   // no temp or corrupt copy left behind
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);                    // nothing was written
  assert.equal(p.mode('sam', null, 'other'), 'off');                          // readable again: the real values, not a cached empty
  p.setDefault('sam', { questions: 'off' });
  assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).sam.default.other, 'off');   // the earlier settings survived the change
});
