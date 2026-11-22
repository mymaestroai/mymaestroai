'use strict';
// Plan usage updates by itself: the sign-in watch (a stamp from stat only), evidence triggers (a turn went through on a
// window marked used up; rate-limited), a changed subscription clears the old one's flags, the faster poll near the limit,
// and the plan_usage event that carries only the time. All on fake timers and a fake clock.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('plan-usage-refresh-iso-');
const { createPlanUsage, claudeCredentialStamp, FAST_POLL_MS, POLL_MS, FAST_FOR_MS, FAST_LATER_MS } = require(path.join(ISO.lib, 'plan-usage'));

const T0 = Date.parse('2026-10-12T12:00:00Z');
const WEEK1 = '2026-10-14T23:00:00Z';
const WEEK2 = '2026-10-17T05:00:00Z';   // another subscription's week: its reset is hours away from the first
const FABLE = 'claude-sdk/claude-fable-5-1';
const OPUS = 'claude-sdk/claude-opus-5-5';

/** A fake clock with a setTimer/clearTimer pair; advance() runs the timers that fall due and lets promises settle. */
function clock() {
  let t = T0; let id = 0; const timers = new Map();
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  return {
    now: () => t, setTimer: (fn, ms) => { const k = ++id; timers.set(k, { at: t + ms, fn }); return k; }, clearTimer: (k) => { timers.delete(k); },
    pending: () => timers.size, set: (ms) => { t = ms; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = due[1].at; due[1].fn(); await settle();
      }
      t = end; await settle();
    },
  };
}
function rig({ answer = {}, settings = {}, stamp = { v: null } } = {}) {
  const c = clock(); const published = []; const logs = []; const cur = { answer }; let calls = 0; let hold = null;
  const pu = createPlanUsage({ getSetting: (k) => settings[k], now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    fetchUsage: async () => { calls++; if (hold) await hold; return cur.answer; }, publish: (t, d) => published.push({ t, d }), log: (m) => logs.push(m),
    listAgents: () => [], notify: () => {}, credentialStamp: () => stamp.v });
  return { pu, c, published, logs, cur, stamp, calls: () => calls, holdNext: () => { let go; hold = new Promise(r => { go = () => { hold = null; r(); }; }); return go; } };
}
const ans = (week, sub = 'max', extra = {}) => ({ subscription_type: sub, rate_limits_available: true, rate_limits: { seven_day: { utilization: week.u, resets_at: week.r }, ...extra } });
const OLD_FLAGS = () => ({ windows: { seven_day: { utilization: 100, resets_at: WEEK1, rejected: true }, five_hour: { utilization: 100, resets_at: '2026-10-12T15:00:00Z', extraUsage: true } },
  models: { fable: { utilization: 100, resets_at: WEEK1, rejected: true, display_name: 'Fable' } }, overage: { status: 'rejected', inUse: false } });

test('a changed sign-in file is re-read once after the 5 s wait; the old answer\'s flags and models are gone', async () => {
  const r = rig({ answer: ans({ u: 20, r: WEEK1 }), stamp: { v: 'a' } });
  r.pu.start();
  await r.c.advance(5000);                       // the first read
  assert.strictEqual(r.calls(), 1);
  r.pu._setState(OLD_FLAGS());
  r.stamp.v = 'b';
  await r.c.advance(9999);                       // the check at 15 s has not happened yet
  assert.strictEqual(r.calls(), 1);
  await r.c.advance(1);                          // the check sees the change and starts the wait
  await r.c.advance(4999);
  assert.strictEqual(r.calls(), 1, 'still waiting');
  await r.c.advance(1);
  assert.strictEqual(r.calls(), 2, 'one re-read after the wait');
  const s = r.pu.snapshot();
  assert.deepStrictEqual(s.models, {}, 'the old subscription\'s model windows are gone');
  assert.strictEqual(s.windows.seven_day.rejected, false);
  assert.strictEqual(s.windows.five_hour.extraUsage, undefined);
  assert.strictEqual(s.overage, null);
  assert.ok(r.logs.includes('[plan-usage] sign-in changed: re-read'));
  await r.c.advance(60000);                      // the stamp stays the same: nothing more
  assert.strictEqual(r.calls(), 2);
  r.pu.stop();
});

test('each later change is read once; an unknown stamp (null) never triggers; a stamp never known is only learned', async () => {
  const r = rig({ answer: ans({ u: 20, r: WEEK1 }), stamp: { v: 'a' } });
  r.pu.start();
  await r.c.advance(5000);
  r.stamp.v = 'b'; await r.c.advance(20000);
  assert.strictEqual(r.calls(), 2);
  r.stamp.v = 'c'; await r.c.advance(20000);
  assert.strictEqual(r.calls(), 3);
  r.stamp.v = null; await r.c.advance(120000);
  assert.strictEqual(r.calls(), 3, 'null is "unknown", not a change');
  r.stamp.v = 'c'; await r.c.advance(120000);
  assert.strictEqual(r.calls(), 3, 'the file back with the stamp it had: no change');
  r.pu.stop();
  const n = rig({ answer: ans({ u: 20, r: WEEK1 }), stamp: { v: null } });   // macOS keychain: no file, no trigger
  n.pu.start(); await n.c.advance(5000); n.stamp.v = 'x'; await n.c.advance(60000);
  assert.strictEqual(n.calls(), 1, 'a stamp that was never known is only learned');
  n.pu.stop();
});

test('the default stamp is built on stat only: no file is read or opened, CLAUDE_CONFIG_DIR is respected, absent -> null', () => {
  const statted = [];
  const fsImpl = { statSync: (p) => { statted.push(p); return { mtimeMs: 12.5, size: 99, ino: 7 }; } };   // anything else is undefined: calling it would throw
  assert.strictEqual(claudeCredentialStamp({ fsImpl, env: { CLAUDE_CONFIG_DIR: '/cfg' }, home: '/home/x' }), '12.5:99:7');
  assert.deepStrictEqual(statted, [path.join('/cfg', '.credentials.json')]);
  assert.strictEqual(claudeCredentialStamp({ fsImpl, env: {}, home: '/home/x' }), '12.5:99:7');
  assert.strictEqual(statted[1], path.join('/home/x', '.claude', '.credentials.json'));
  assert.strictEqual(claudeCredentialStamp({ fsImpl: { statSync: () => { throw new Error('ENOENT'); } }, env: {}, home: '/h' }), null);
  const src = String(claudeCredentialStamp);
  assert.ok(/statSync/.test(src)); assert.doesNotMatch(src, /readFile|readSync|openSync|createReadStream|existsSync/);
  // against a real temp file: the stamp changes when the file is rewritten, and the content never matters
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-stamp-'));
  const f = path.join(dir, '.credentials.json');
  fs.writeFileSync(f, 'not-a-real-credential-1');
  const a = claudeCredentialStamp({ env: { CLAUDE_CONFIG_DIR: dir } });
  assert.match(a, /^[\d.]+:\d+:\d+$/);
  assert.ok(!a.includes('credential'));
  fs.writeFileSync(f, 'not-a-real-credential-two');
  assert.notStrictEqual(claudeCredentialStamp({ env: { CLAUDE_CONFIG_DIR: dir } }), a);
  assert.strictEqual(claudeCredentialStamp({ env: { CLAUDE_CONFIG_DIR: path.join(dir, 'nope') } }), null);
});

test('an event that was not a refusal on a window marked refused triggers a re-read: one per 60 s, never while one is in flight', async () => {
  const r = rig({ answer: ans({ u: 40, r: WEEK1 }) });
  r.pu._setState({ models: { opus: { utilization: 100, resets_at: WEEK1, rejected: true } } });
  const ok = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.3 };
  r.pu.noteEvent(ok, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), 1);
  assert.ok(r.logs.includes('[plan-usage] a turn went through on a window marked used up: re-read'));
  r.pu._setState({ models: { opus: { utilization: 100, resets_at: WEEK1, rejected: true } } });
  r.pu.noteEvent(ok, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), 1, 'rate-limited');
  await r.c.advance(61000);
  r.pu.noteEvent(ok, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), 2);
  // in flight: no second one, however old the last trigger
  await r.c.advance(61000);
  const go = r.holdNext();
  r.pu._setState({ models: { opus: { utilization: 100, resets_at: WEEK1, rejected: true } } });
  r.pu.noteEvent(ok, OPUS, 'lead'); r.pu.noteEvent(ok, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), 3, 'one in flight');
  go(); await r.c.advance(0);
  // a window that is not marked used up, a refusal and a different family do not count as evidence
  const before = r.calls(); await r.c.advance(61000);
  r.pu._setState({ models: {}, windows: {} });
  r.pu.noteEvent(ok, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), before, 'nothing marked used up');
  r.pu._setState({ models: { fable: { utilization: 100, resets_at: WEEK1, rejected: true } } });
  r.pu.noteEvent(ok, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), before, 'another family\'s refusal is not this family\'s');
});

test('a stored weekly 100% with an event below 100 triggers; an event at 100 does not', async () => {
  const r = rig({ answer: ans({ u: 30, r: WEEK1 }) });
  r.pu._setState({ windows: { seven_day: { utilization: 100, resets_at: WEEK1, rejected: false } } });
  r.pu.noteEvent({ status: 'allowed', rateLimitType: 'seven_day', utilization: 1 }, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), 0, 'the event itself says 100%');
  r.pu.noteEvent({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 }, OPUS, 'lead'); await r.c.advance(0);
  assert.strictEqual(r.calls(), 1);
});

test('noteTurnOk on a window at 100% re-reads, at most once a minute; below 100 it does nothing', async () => {
  const r = rig({ answer: ans({ u: 30, r: WEEK1 }) });
  r.pu._setState({ models: { fable: { utilization: 90, resets_at: WEEK1 } } });
  r.pu.noteTurnOk(FABLE); await r.c.advance(0);
  assert.strictEqual(r.calls(), 0);
  r.pu._setState({ models: { fable: { utilization: 100, resets_at: WEEK1 } } });
  r.pu.noteTurnOk(FABLE); await r.c.advance(0);
  assert.strictEqual(r.calls(), 1);
  assert.ok(r.logs.includes('[plan-usage] a turn went through on a window marked used up: re-read'));
  r.pu._setState({ models: { fable: { utilization: 100, resets_at: WEEK1 } } });
  r.pu.noteTurnOk(FABLE); r.pu.noteTurnOk(FABLE); await r.c.advance(59000);
  r.pu.noteTurnOk(FABLE); await r.c.advance(0);
  assert.strictEqual(r.calls(), 1, 'rate-limited to one per 60 s');
  await r.c.advance(1000);
  r.pu.noteTurnOk(FABLE); await r.c.advance(0);
  assert.strictEqual(r.calls(), 2);
  // the all-models weekly window counts for every family; no family -> nothing
  await r.c.advance(61000);
  r.pu._setState({ models: {}, windows: { seven_day: { utilization: 100, resets_at: WEEK1, rejected: true } } });
  r.pu.noteTurnOk(OPUS); await r.c.advance(0);
  assert.strictEqual(r.calls(), 3);
  r.pu.noteTurnOk('gpt-5.6');
  assert.strictEqual(r.calls(), 3);
});

test('another subscription (type or reset time) clears the old flags; the new window warns once at its level, the old one is not re-announced', async () => {
  const r = rig({ answer: ans({ u: 80, r: WEEK1 }, 'pro') });
  await r.pu.refresh();
  const warns = () => r.published.filter(p => p.t === 'plan_warning');
  assert.strictEqual(warns().length, 1, 'the old window warned at 75%');
  r.pu._setState({ models: { fable: { utilization: 100, resets_at: WEEK1, rejected: true, extraUsage: true } } });
  r.cur.answer = ans({ u: 80, r: WEEK2 }, 'max');                 // another type, another week
  await r.pu.refresh();
  assert.deepStrictEqual(r.pu.snapshot().models, {}, 'no model window of the old subscription survives');
  assert.ok(r.logs.includes('[plan-usage] the subscription changed: re-read'));
  assert.strictEqual(warns().length, 2, 'the new window warns once');
  assert.strictEqual(warns()[1].d.level, 75);
  await r.pu.refresh();
  assert.strictEqual(warns().length, 2, 'not again for the same window');
  r.cur.answer = ans({ u: 80, r: WEEK1 }, 'max');                  // back to the old week: its key is still on record
  await r.pu.refresh();
  assert.strictEqual(warns().length, 2, 'the old window\'s warning is not re-fired');

  // the same type, only the reset hour differs: by more than an hour it is another subscription, by less it is not
  const q = rig({ answer: ans({ u: 20, r: WEEK1 }, 'max') });
  await q.pu.refresh();
  const mark = { models: { opus: { utilization: 100, resets_at: WEEK1, rejected: true } } };
  q.pu._setState(mark); q.cur.answer = ans({ u: 20, r: '2026-10-14T23:30:00Z' }, 'max'); await q.pu.refresh();
  assert.ok(q.pu.snapshot().models.opus, 'half an hour is the same window');
  q.cur.answer = ans({ u: 20, r: '2026-10-15T01:30:00Z' }, 'max'); await q.pu.refresh();
  assert.deepStrictEqual(q.pu.snapshot().models, {}, 'two and a half hours is another subscription');
});

test('refresh({ reset: true }) waits for a read in flight, then reads again', async () => {
  const r = rig({ answer: ans({ u: 20, r: WEEK1 }) });
  const go = r.holdNext();
  const a = r.pu.refresh(); const b = r.pu.refresh({ reason: 'sign-in changed', reset: true });
  await r.c.advance(0); assert.strictEqual(r.calls(), 1);
  go(); await a; await b; await r.c.advance(0);
  assert.strictEqual(r.calls(), 2);
});

test('polling: every 10 minutes, every 60 s at the top level or while refused, back to 10 minutes below; stop() ends it', async () => {
  assert.strictEqual(FAST_POLL_MS, 60000); assert.strictEqual(POLL_MS, 600000);
  const r = rig({ answer: ans({ u: 50, r: WEEK1 }) });
  r.pu.start();
  await r.c.advance(5000); assert.strictEqual(r.calls(), 1);
  await r.c.advance(599000); assert.strictEqual(r.calls(), 1, 'below the top level: 10 minutes');
  await r.c.advance(1000); assert.strictEqual(r.calls(), 2);
  r.cur.answer = ans({ u: 90, r: WEEK1 });                          // the top default level is 90
  await r.c.advance(600000); assert.strictEqual(r.calls(), 3);
  await r.c.advance(60000); assert.strictEqual(r.calls(), 4, 'at the top level: 60 s');
  await r.c.advance(60000); assert.strictEqual(r.calls(), 5);
  r.cur.answer = ans({ u: 89, r: WEEK1 });
  await r.c.advance(60000); assert.strictEqual(r.calls(), 6, 'this read still came after a 60 s wait');
  await r.c.advance(599000); assert.strictEqual(r.calls(), 6, 'below: back to 10 minutes');
  await r.c.advance(1000); assert.strictEqual(r.calls(), 7);
  // refused: fast
  r.pu._setState({ models: { fable: { utilization: 100, resets_at: WEEK1, rejected: true } } });
  r.cur.answer = { ...ans({ u: 10, r: WEEK1 }), rate_limits: { seven_day: { utilization: 10, resets_at: WEEK1 }, model_scoped: [{ display_name: 'Fable', utilization: 100, resets_at: WEEK1 }] } };
  await r.c.advance(600000); assert.strictEqual(r.calls(), 8);
  assert.strictEqual(r.pu.snapshot().models.fable.rejected, true, 'the refusal for the same window is kept');
  await r.c.advance(60000); assert.strictEqual(r.calls(), 9, 'refused: 60 s');
  r.pu.stop();
  await r.c.advance(3600000); assert.strictEqual(r.calls(), 9);
  assert.strictEqual(r.c.pending(), 0, 'stop() clears every timer');
  // the owner's own top level moves the threshold
  const o = rig({ answer: ans({ u: 60, r: WEEK1 }), settings: { planWarn: { at: [40, 60] } } });
  o.pu.start(); await o.c.advance(5000); await o.c.advance(60000);
  assert.strictEqual(o.calls(), 2); o.pu.stop();
  const none = rig({ answer: ans({ u: 90, r: WEEK1 }), settings: { planWarn: { at: [] } } });   // no levels: 90
  none.pu.start(); await none.c.advance(5000); await none.c.advance(60000);
  assert.strictEqual(none.calls(), 2); none.pu.stop();
});

test('hot: 60 s polls for the first 30 minutes, then every 5 minutes; cooling goes back to 10 minutes and resets the clock', async () => {
  assert.strictEqual(FAST_FOR_MS, 30 * 60 * 1000); assert.strictEqual(FAST_LATER_MS, 5 * 60 * 1000);
  const r = rig({ answer: ans({ u: 95, r: WEEK1 }) });
  const times = []; let seen = 0;
  const run = async (ms) => { for (let i = 0; i < ms / 1000; i++) { await r.c.advance(1000); if (r.calls() > seen) { seen = r.calls(); times.push(r.c.now()); } } };
  const gaps = (from) => times.slice(from).map((t, i, a) => (i ? t - a[i - 1] : null)).slice(1);
  r.pu.start();
  await run(5000 + 30 * 60 * 1000 + 20 * 60 * 1000);
  const g1 = gaps(0);
  assert.ok(g1.length >= 30 + 4);
  assert.deepStrictEqual(g1.slice(0, 30), new Array(30).fill(FAST_POLL_MS), 'the first 30 minutes: every 60 s');
  assert.ok(g1.slice(30).every(g => g === FAST_LATER_MS), 'then every 5 minutes');
  // cooled: the next read (still on the 5 minute wait) sees it, and the one after waits POLL_MS
  r.cur.answer = ans({ u: 50, r: WEEK1 });
  const n = times.length;
  await run(FAST_LATER_MS + POLL_MS);
  assert.strictEqual(times.length, n + 2);
  assert.strictEqual(times[n + 1] - times[n], POLL_MS, 'cooled: back to the normal poll');
  // hot again: a new 30 minute fast period starts
  r.cur.answer = ans({ u: 95, r: WEEK1 });
  const m = times.length;
  await run(POLL_MS + 5 * 60 * 1000 + 30 * 60 * 1000 + 10 * 60 * 1000);
  const g2 = gaps(m);                              // m is the read that first sees it hot
  assert.deepStrictEqual(g2.slice(0, 30), new Array(30).fill(FAST_POLL_MS), 'a new 30 minutes of 60 s polls');
  assert.ok(g2.slice(30).every(g => g === FAST_LATER_MS));
  r.pu.stop();
});

test('plan_usage is published after a read that succeeded, with only the time; a failed read publishes nothing', async () => {
  const r = rig({ answer: ans({ u: 20, r: WEEK1 }) });
  await r.pu.refresh();
  const ev = r.published.filter(p => p.t === 'plan_usage');
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual(Object.keys(ev[0].d), ['fetchedAt']);
  assert.strictEqual(ev[0].d.fetchedAt, new Date(T0).toISOString());
  const bad = createPlanUsage({ now: () => T0, fetchUsage: async () => { throw new Error('no client'); }, publish: (t, d) => r.published.push({ t: `bad-${t}`, d }), log: () => {} });
  await bad.refresh();
  assert.strictEqual(r.published.filter(p => p.t === 'bad-plan_usage').length, 0);
});
