'use strict';
// The ChatGPT side: the sign-in watch (stamp, stat only) and the fast reads while a limit is reached.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCodexUsage, defaultCredentialStamp, FAST_FOR_MS, FAST_LATER_MS } = require('../lib/codex-usage');

const T0 = Date.parse('2026-11-19T20:00:00Z');
const RESET_S = Math.floor(Date.parse('2026-11-23T16:48:00Z') / 1000);

const weeklyRead = (pct, id = 'codex') => ({
  rateLimits: { limitId: id, planType: 'pro', primary: { usedPercent: pct, windowDurationMins: 10080, resetsAt: RESET_S }, secondary: null, rateLimitReachedType: null, spendControlReached: null },
  rateLimitsByLimitId: null,
});

/** A fake clock with a timer queue: advance(ms) runs due timers in order and lets promises settle. */
function make(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-si-'));
  const clock = { t: T0 };
  const timers = [];
  let seq = 0;
  const env = { stamp: o.stamp === undefined ? 'a' : o.stamp, read: o.read || weeklyRead(10), reads: 0 };
  const published = [];
  const stateFile = path.join(dir, 'codex-usage.json');
  const u = createCodexUsage({
    now: () => clock.t,
    stateFile,
    publish: (type, data) => published.push({ type, data }),
    listAgents: () => [{ name: 'cx', model: 'codex-cli/gpt-x' }],
    readLimits: async () => { env.reads++; return typeof env.read === 'function' ? env.read() : env.read; },
    signedIn: async () => ({ loggedIn: true, mode: 'chatgpt' }),
    log: () => {},
    whenText: (iso) => `<${iso}>`,
    credentialStamp: () => env.stamp,
    setTimer: (fn, ms) => { const t = { id: ++seq, at: clock.t + ms, fn }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  async function advance(ms) {
    const end = clock.t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      clock.t = Math.max(clock.t, next.at);
      next.fn();
      await settle();
    }
    clock.t = end;
    await settle();
  }
  return { u, env, stateFile, clock, timers, published, advance, settle };
}

// start() with a long first-read delay so only the watch and the fast reads are in play.
const startQuiet = (m) => m.u.start({ delayMs: 24 * 3600 * 1000 });

test('a stamp change reads once, after the 5 s quiet time', async () => {
  const m = make();
  startQuiet(m);
  await m.advance(60 * 1000);
  assert.strictEqual(m.env.reads, 0, 'an unchanged stamp reads nothing');
  m.env.stamp = 'b';
  await m.advance(15 * 1000);           // the next check sees it
  assert.strictEqual(m.env.reads, 0, 'not yet: the quiet time runs first');
  await m.advance(4 * 1000);
  assert.strictEqual(m.env.reads, 0);
  await m.advance(1100);
  assert.strictEqual(m.env.reads, 1);
  await m.advance(120 * 1000);
  assert.strictEqual(m.env.reads, 1, 'no more reads while the stamp stays');
  m.u.stop();
});

test('an unknown stamp is not a change; sign-out then sign-in (known, gone, a new one) is', async () => {
  const m = make({ stamp: null });
  startQuiet(m);
  m.env.stamp = 'a';                    // from unknown to known: not a change
  await m.advance(60 * 1000);
  assert.strictEqual(m.env.reads, 0);
  m.env.stamp = null;                   // signed out: the file is gone
  await m.advance(60 * 1000);
  assert.strictEqual(m.env.reads, 0);
  m.env.stamp = 'c';                    // signed in again, a different file
  await m.advance(25 * 1000);
  assert.strictEqual(m.env.reads, 1);
  m.u.stop();
});

test('the sign-in change reads the new account and drops the old one\'s limits and warned entries', async () => {
  const m = make({ read: weeklyRead(95, 'old') });
  m.u.start({ delayMs: 24 * 3600 * 1000 });
  await m.u.readNow();
  assert.strictEqual(m.u.snapshot().limits[0].id, 'old');
  m.u.flush();
  assert.ok(Object.keys(JSON.parse(fs.readFileSync(m.stateFile, 'utf8')).warned).some(k => k.includes('|old|')), 'the old account was warned about');
  m.env.read = weeklyRead(10, 'new');
  m.env.stamp = 'b';
  await m.advance(25 * 1000);           // check at 15 s, debounce 5 s; the 60 s gap holds the read back
  await m.advance(60 * 1000);           // the single retry once the gap allows
  const snap = m.u.snapshot();
  assert.deepStrictEqual(snap.limits.map(l => l.id), ['new']);
  assert.strictEqual(snap.limits[0].reached, false);
  assert.strictEqual(m.env.reads, 2);
  m.u.flush();
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(m.stateFile, 'utf8')).warned).filter(k => k.includes('|old|')), []);
  m.u.stop();
});

test('a sign-in read blocked by the once-a-minute limit is retried once when the gap allows', async () => {
  const m = make();
  startQuiet(m);
  await m.u.readNow();                  // a read just now
  assert.strictEqual(m.env.reads, 1);
  m.env.stamp = 'b';
  await m.advance(20 * 1000);           // the stamp check and the quiet time pass inside the gap: blocked
  assert.strictEqual(m.env.reads, 1);
  await m.advance(45 * 1000);
  assert.strictEqual(m.env.reads, 2, 'retried once after the gap');
  await m.advance(10 * 60 * 1000);
  assert.strictEqual(m.env.reads, 2, 'and only once');
  m.u.stop();
});

test('a reached limit is read every 60 s until it drops; below the top level there are no periodic reads', async () => {
  const m = make({ read: { ...weeklyRead(100), rateLimits: { ...weeklyRead(100).rateLimits, rateLimitReachedType: 'primary' } } });
  startQuiet(m);
  await m.u.readNow();                  // a reached limit is now known
  assert.strictEqual(m.env.reads, 1);
  assert.strictEqual(m.u.snapshot().limits[0].reached, true);
  await m.advance(61 * 1000);
  assert.strictEqual(m.env.reads, 2);
  await m.advance(61 * 1000);
  assert.strictEqual(m.env.reads, 3);
  m.env.read = weeklyRead(20);          // the limit drops
  await m.advance(61 * 1000);
  assert.strictEqual(m.env.reads, 4);
  assert.strictEqual(m.u.snapshot().limits[0].reached, false);
  await m.advance(30 * 60 * 1000);
  assert.strictEqual(m.env.reads, 4, 'no periodic reads below the top level');
  m.u.stop();
});

test('at or above the top warning level (default 90) reads every minute; just below does not', async () => {
  const hi = make({ read: weeklyRead(90) });
  startQuiet(hi);
  await hi.u.readNow();
  await hi.advance(3 * 61 * 1000);
  assert.strictEqual(hi.env.reads, 4);
  hi.u.stop();
  const lo = make({ read: weeklyRead(89) });
  startQuiet(lo);
  await lo.u.readNow();
  await lo.advance(10 * 60 * 1000);
  assert.strictEqual(lo.env.reads, 1);
  lo.u.stop();
});

test('a limit at the top: a read every 60 s for 30 minutes, then every 5 minutes; cooled there are none; hot again starts 30 new minutes', async () => {
  assert.strictEqual(FAST_FOR_MS, 30 * 60 * 1000); assert.strictEqual(FAST_LATER_MS, 5 * 60 * 1000);
  const m = make({ read: weeklyRead(95) });
  startQuiet(m);
  const times = []; let seen = 0;
  const run = async (ms) => { for (let i = 0; i < ms / 1000; i++) { await m.advance(1000); if (m.env.reads > seen) { seen = m.env.reads; times.push(m.clock.t); } } };
  const gaps = (from) => times.slice(from).map((t, i, a) => (i ? t - a[i - 1] : null)).slice(1);
  await m.u.readNow(); seen = m.env.reads; times.push(m.clock.t);
  await run(30 * 60 * 1000 + 20 * 60 * 1000);
  const g1 = gaps(0);
  assert.ok(g1.length >= 30 + 4);
  assert.deepStrictEqual(g1.slice(0, 30), new Array(30).fill(60 * 1000), 'the first 30 minutes: every 60 s');
  assert.ok(g1.slice(30).every(g => g === FAST_LATER_MS), 'then every 5 minutes');
  m.env.read = weeklyRead(20);          // cooled: the next (5 minute) read sees it, then nothing
  const n = times.length;
  await run(FAST_LATER_MS + 60 * 60 * 1000);
  assert.strictEqual(times.length, n + 1, 'one last read, no periodic reads after it');
  assert.strictEqual(m.u.snapshot().limits[0].reached, false);
  m.env.read = weeklyRead(95);          // hot again
  await m.u.readNow(); seen = m.env.reads; times.push(m.clock.t);
  const k = times.length - 1;
  await run(30 * 60 * 1000 + 15 * 60 * 1000);
  const g2 = gaps(k);
  assert.deepStrictEqual(g2.slice(0, 30), new Array(30).fill(60 * 1000), 'a new 30 minutes of 60 s reads');
  assert.ok(g2.length >= 33 && g2.slice(30).every(g => g === FAST_LATER_MS));
  m.u.stop();
});

test('stop() ends the watch and the fast reads', async () => {
  const m = make({ read: weeklyRead(95) });
  startQuiet(m);
  await m.u.readNow();
  m.u.stop();
  assert.strictEqual(m.timers.length, 0);
  m.env.stamp = 'zz';
  await m.advance(10 * 60 * 1000);
  assert.strictEqual(m.env.reads, 1);
});

test('the stamp is stat only: the default reads the path\'s stat, never its content', () => {
  const calls = [];
  const fake = {
    statSync: (p, o) => { calls.push(['statSync', p, o]); return { mtimeMs: 123.5, size: 77, ino: 9 }; },
    readFileSync: () => { throw new Error('content must not be read'); },
    openSync: () => { throw new Error('content must not be opened'); },
    createReadStream: () => { throw new Error('content must not be streamed'); },
  };
  const s = defaultCredentialStamp({ fs: fake, env: { CODEX_HOME: '/x/codexhome' } });
  assert.strictEqual(s, '123.5:77:9');
  assert.deepStrictEqual(calls.map(c => [c[0], c[1]]), [['statSync', path.join('/x/codexhome', 'auth.json')]]);
  assert.strictEqual(defaultCredentialStamp({ fs: { statSync: () => undefined }, env: { CODEX_HOME: '/x' } }), null);
  assert.strictEqual(defaultCredentialStamp({ fs: { statSync: () => { throw new Error('x'); } }, env: {} }), null);
  // The default home is ~/.codex when CODEX_HOME is not set.
  const seen = [];
  defaultCredentialStamp({ fs: { statSync: (p) => { seen.push(p); return null; } }, env: {} });
  assert.strictEqual(seen[0], path.join(os.homedir(), '.codex', 'auth.json'));
});

test('stamp source check: only statSync touches the credentials path', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codex-usage.js'), 'utf8');
  const body = src.slice(src.indexOf('function defaultCredentialStamp'), src.indexOf('async function defaultReadLimits'));
  assert.match(body, /statSync/);
  assert.doesNotMatch(body, /readFile|openSync|createReadStream|readSync/);
});
