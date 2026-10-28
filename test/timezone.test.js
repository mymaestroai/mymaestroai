'use strict';
// Agents work in the local time of the person they work for (2026-10-28): the hub stores UTC, and everything an
// agent reads (the time now, search hits, recall, history stamps, summaries, session notes, schedules, the brief)
// is written in that person's zone with the zone named. A person's zone follows the device they use unless pinned.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tz = require('../lib/timezone');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const tmpDirs = [];
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const AT = '2026-10-28T19:47:00.000Z';   // 3:47 PM in New York (EDT), 12:47 PM in Los Angeles (PDT)

test('isZone: real zone names only', () => {
  for (const z of ['America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'UTC', 'America/Argentina/Buenos_Aires']) assert.strictEqual(tz.isZone(z), true, z);
  for (const z of ['', 'Mars/Base', '../etc/passwd', 'America/New York', '<script>', 'x'.repeat(80), null, 42]) assert.strictEqual(tz.isZone(z), false, String(z));
});

test('times written in a zone, with the zone named', () => {
  assert.strictEqual(tz.stamp(AT, 'America/New_York'), '2026-10-28 15:47 EDT');
  assert.strictEqual(tz.stamp(AT, 'America/Los_Angeles'), '2026-10-28 12:47 PDT');
  assert.strictEqual(tz.stamp(AT, 'Asia/Kolkata'), '2026-10-29 01:17 GMT+5:30', 'the next day there');
  assert.strictEqual(tz.stamp(AT, 'UTC'), '2026-10-28 19:47 UTC');
  assert.strictEqual(tz.stamp('2026-12-01T17:00:00Z', 'America/New_York'), '2026-12-01 12:00 EST', 'standard time in winter');
  assert.strictEqual(tz.stamp('not a time', 'UTC'), 'not a time');
  assert.strictEqual(tz.stamp(AT, 'Bogus/Zone'), '2026-10-28 19:47 UTC', 'an unknown zone falls back to UTC, named');
  assert.strictEqual(tz.shortStamp(AT, 'America/New_York'), 'Oct 28 15:47 EDT');
  assert.strictEqual(tz.shortStamp(AT, 'America/New_York', true), 'Oct 28 2026 15:47 EDT');
  assert.strictEqual(tz.shortStamp('2026-11-01T06:30:00Z', 'America/New_York'), 'Nov 1 01:30 EST', 'the repeated hour\'s second time says so');
  assert.strictEqual(tz.localTimeTag('America/New_York', Date.parse(AT)), '<local_time zone="America/New_York">Wednesday, October 28, 2026 at 3:47 PM EDT</local_time>');
  assert.strictEqual(tz.localDate('Asia/Tokyo', Date.parse(AT)), '2026-10-29');
  assert.strictEqual(tz.localHm('Asia/Tokyo', Date.parse(AT)), '04:47');
  assert.strictEqual(tz.zoneName('America/New_York', Date.parse(AT)), 'EDT');
});

test('parseLocal: an agent\'s time without a zone is the person\'s local time; with one, as written', () => {
  assert.strictEqual(tz.parseLocal('2026-10-28 09:00', 'America/New_York'), '2026-10-28T13:00:00.000Z');
  assert.strictEqual(tz.parseLocal('2026-10-28T09:00', 'America/Los_Angeles'), '2026-10-28T16:00:00.000Z');
  assert.strictEqual(tz.parseLocal('2026-10-28T09:00:00Z', 'America/New_York'), '2026-10-28T09:00:00.000Z');
  assert.strictEqual(tz.parseLocal('2026-10-28T09:00:00-07:00', 'America/New_York'), '2026-10-28T16:00:00.000Z');
  assert.strictEqual(tz.parseLocal('2026-10-28', 'America/New_York'), '2026-10-28T04:00:00.000Z', 'a bare date starts at local midnight');
  assert.strictEqual(tz.parseLocal('2026-10-28', 'America/New_York', { endOfDay: true }), '2026-10-29T03:59:59.999Z', '...and as an end, ends at the next local midnight');
  assert.strictEqual(tz.parseLocal('2027-03-14 03:30', 'America/New_York'), '2027-03-14T07:30:00.000Z', 'after the spring change');
  assert.strictEqual(tz.parseLocal('2026-11-01 01:30', 'America/New_York'), '2026-11-01T05:30:00.000Z', 'the repeated hour: the first one');
  assert.strictEqual(tz.parseLocal('2026-11-01 01:30 EST', 'America/New_York'), '2026-11-01T06:30:00.000Z', '...unless its zone name says the second');
  assert.strictEqual(tz.parseLocal('2026-10-25 02:30', 'Europe/Berlin'), '2026-10-25T00:30:00.000Z', 'east of UTC too: the first');
  assert.strictEqual(tz.parseLocal('2027-03-14 02:30', 'America/New_York'), '2027-03-14T07:30:00.000Z', 'the skipped hour: as the clock shows it, 03:30');
  assert.strictEqual(tz.parseLocal('2027-03-28 02:30', 'Europe/Berlin'), '2027-03-28T01:30:00.000Z', 'the skipped hour east of UTC: 03:30 CEST');
  assert.strictEqual(tz.zonedToUtcMs(2026, 11, 1, 1, 30, 0, 'America/New_York'), Date.parse('2026-11-01T05:30:00Z'));
  assert.strictEqual(tz.parseLocal('2026-02-30', 'America/New_York'), undefined, 'no February 30');
  assert.strictEqual(tz.parseLocal('2026-10-28 24:00', 'America/New_York'), undefined);
  assert.strictEqual(tz.parseLocal('2026-10-28T09:00:00.000', 'America/Los_Angeles'), '2026-10-28T16:00:00.000Z', 'with a fraction, still local');
  // The hub's own forms, copied back by an agent: read in the person's zone, whatever this computer's zone is.
  assert.strictEqual(tz.parseLocal('Oct 28 2026 15:47', 'America/Los_Angeles'), '2026-10-28T22:47:00.000Z', 'sent= without its zone name');
  assert.strictEqual(tz.parseLocal('Oct 28 2026 15:47 PDT', 'America/Los_Angeles'), '2026-10-28T22:47:00.000Z', 'sent= as printed');
  assert.strictEqual(tz.parseLocal('[Oct 28 2026 15:47 PDT]', 'America/Los_Angeles'), '2026-10-28T22:47:00.000Z', 'with its brackets');
  assert.strictEqual(tz.parseLocal('2026-10-28 15:47 PDT', 'America/Los_Angeles'), '2026-10-28T22:47:00.000Z', 'a stamp as printed');
  assert.strictEqual(tz.parseLocal('2026-10-29 01:17 GMT+5:30', 'America/Los_Angeles'), '2026-10-28T19:47:00.000Z', 'a numeric zone name');
  assert.strictEqual(tz.parseLocal('2026-10-28 15:47 UTC', 'America/Los_Angeles'), '2026-10-28T15:47:00.000Z');
  assert.strictEqual(tz.parseLocal('2026-10-28 15:47 EDT', 'America/Los_Angeles'), '2026-10-28T19:47:00.000Z', 'another zone\'s name, as written');
  assert.strictEqual(tz.parseLocal('October 28, 2026', 'America/Los_Angeles'), '2026-10-28T07:00:00.000Z', 'other text without a zone: local');
  assert.strictEqual(tz.parseLocal('October 28, 2026', 'America/Los_Angeles', { endOfDay: true }), '2026-10-29T06:59:59.999Z');
  assert.strictEqual(tz.parseLocal('2026-10-28 15:47 XYZT', 'America/Los_Angeles'), undefined, 'a zone name nobody knows: not guessed');
  assert.strictEqual(tz.parseLocal('2026-10-28 15:47 edt', 'America/Los_Angeles'), '2026-10-28T19:47:00.000Z', 'zone names in any case');
  assert.strictEqual(tz.parseLocal('2026-10-28T09:00:00.123', 'America/Los_Angeles'), '2026-10-28T16:00:00.123Z', 'a fraction is kept');
  assert.strictEqual(tz.parseLocal('2026-10-28 UTC', 'America/Los_Angeles', { endOfDay: true }), '2026-10-28T23:59:59.999Z', 'a date with a zone ends in that zone');
  assert.strictEqual(tz.parseLocal('2026-10-28+05:30', 'UTC', { endOfDay: true }), '2026-10-28T18:29:59.999Z');
  for (const bad of ['2026-02-30 UTC', '2026-02-30T09:00:00Z', '2026-10-28 09:00 GMT+5:99', '2026-10-28 09:00 +15:00', '03/14/2027 02:30', 'Oct 28 13:00 PM', 'Smarch 3 2026'])
    assert.strictEqual(tz.parseLocal(bad, 'UTC'), undefined, `refused: ${bad}`);
  assert.strictEqual(tz.parseLocal('Oct 28 2026 3:47 PM', 'America/Los_Angeles'), '2026-10-28T22:47:00.000Z', 'a 12-hour time');
  assert.strictEqual(tz.parseLocal('Oct 28 2026 12:15 am', 'America/Los_Angeles'), '2026-10-28T07:15:00.000Z');
  assert.strictEqual(tz.parseLocal('Sept 3 2026 10:00', 'UTC'), '2026-09-03T10:00:00.000Z');
  const realNow = Date.now;
  try {
    Date.now = () => Date.parse('2027-01-02T12:00:00Z');
    assert.strictEqual(tz.parseLocal('Dec 30', 'UTC'), '2026-12-30T00:00:00.000Z', 'no year: the latest one, three days ago');
    assert.strictEqual(tz.parseLocal('Dec 30', 'UTC', { endOfDay: true }), '2026-12-30T23:59:59.999Z', 'the end of that same day');
    assert.strictEqual(tz.parseLocal('Jan 3 15:00', 'UTC'), '2027-01-03T15:00:00.000Z', 'tomorrow is near enough to be this year');
    Date.now = () => Date.parse('2026-10-28T19:47:00Z');   // 3:47 PM in New York
    assert.strictEqual(tz.parseLocal('Oct 30', 'America/New_York'), '2026-10-30T04:00:00.000Z', 'the day after tomorrow');
    assert.strictEqual(tz.parseLocal('Oct 30 16:00', 'America/New_York'), '2026-10-30T20:00:00.000Z', 'and a time on it: the same year, though 2 days and 13 minutes ahead');
    Date.now = () => Date.parse('2028-01-02T12:00:00Z');
    assert.strictEqual(tz.parseLocal('Feb 29 UTC', 'UTC'), undefined, '2027 has no February 29: refused, not March 1');
  } finally { Date.now = realNow; }
  assert.strictEqual(tz.parseLocal('', 'UTC'), undefined);
  assert.strictEqual(tz.parseLocal(undefined, 'UTC'), undefined);
  assert.strictEqual(tz.parseLocal('rubbish', 'UTC'), undefined);
  assert.deepStrictEqual([tz.addDays('2026-11-01', -1), tz.addDays('2027-03-14', 1), tz.addDays('2026-12-31', 1), tz.addDays('2026-03-01', -1), tz.addDays('x', 1)],
    ['2026-10-31', '2027-03-15', '2027-01-01', '2026-02-28', null], 'calendar days');
});

test('whose zone: an owned agent uses its owner\'s; the hub\'s own agents use the first admin\'s; then HUB_TZ; then this computer\'s', () => {
  // The first admin's zone must differ from this computer's, or using the computer's zone by mistake would pass.
  const FIRST = ['America/Chicago', 'Pacific/Auckland'].find(z => z !== tz.serverZone());
  const users = [
    { id: 'u2', role: 'admin', createdAt: '2026-05-01T00:00:00Z', timeZone: 'Europe/Berlin' },
    { id: 'u1', role: 'admin', createdAt: '2026-01-01T00:00:00Z', timeZone: FIRST },
    { id: 'm1', role: 'member', createdAt: '2026-06-01T00:00:00Z', timeZone: 'America/Los_Angeles' },
    { id: 'm2', role: 'member', createdAt: '2026-06-02T00:00:00Z' },
  ];
  const agents = [{ name: 'maestro' }, { name: 'kidsbot', owner: 'm1' }, { name: 'newbot', owner: 'm2' }];
  tz._setDeps({ auth: { admins: () => users.filter(u => u.role === 'admin'), getUser: (id) => users.find(u => u.id === id) || null }, agents: () => agents, ownerOf: (a) => a.owner || null });
  const keep = process.env.HUB_TZ;
  try {
    assert.strictEqual(tz.hubZone(), FIRST, 'the first admin (by creation)');
    assert.strictEqual(tz.zoneForAgent('maestro'), FIRST);
    assert.strictEqual(tz.zoneForAgent('kidsbot'), 'America/Los_Angeles', 'its owner\'s');
    assert.strictEqual(tz.zoneForAgent('newbot'), FIRST, 'an owner with no zone yet: the hub\'s');
    assert.strictEqual(tz.zoneForAgent('no-such-agent'), FIRST);
    assert.strictEqual(tz.zoneForUser('m1'), 'America/Los_Angeles');
    users[1].timeZone = undefined;
    process.env.HUB_TZ = 'Asia/Tokyo';
    assert.strictEqual(tz.hubZone(), 'Asia/Tokyo', 'no zone from the first admin: HUB_TZ');
    process.env.HUB_TZ = 'Not/AZone';
    assert.strictEqual(tz.hubZone(), tz.serverZone(), 'a bad HUB_TZ is ignored');
  } finally {
    if (keep === undefined) delete process.env.HUB_TZ; else process.env.HUB_TZ = keep;
    tz._setDeps(null);
  }
});

test('a person\'s zone: reports from their device follow them; a pinned zone stays; only choices are audited', () => {
  const A = require('../lib/auth');
  const dir = tmp('tz-auth-');
  const auth = A.createAuth({ dataDir: dir, log: () => {} });
  const u = auth.createUser({ login: 'owner@example.com', name: 'Owner', role: 'admin', password: 'correct-horse-battery-9' }).user;
  const r1 = auth.setTimeZone(u.id, 'America/New_York', { auto: true });
  assert.deepStrictEqual([r1.ok, r1.changed, r1.user.timeZone, r1.user.timeZonePinned], [true, true, 'America/New_York', false]);
  assert.strictEqual(auth.setTimeZone(u.id, 'America/New_York', { auto: true }).changed, false, 'the same report again: nothing to save');
  assert.strictEqual(auth.setTimeZone(u.id, 'America/Los_Angeles', { auto: true }).user.timeZone, 'America/Los_Angeles', 'travelling: it follows the device');
  const pin = auth.setTimeZone(u.id, 'Europe/Berlin', { pinned: true });
  assert.deepStrictEqual([pin.user.timeZone, pin.user.timeZonePinned], ['Europe/Berlin', true]);
  assert.strictEqual(auth.setTimeZone(u.id, 'America/New_York', { auto: true }).user.timeZone, 'Europe/Berlin', 'pinned: the device does not move it');
  const unpin = auth.setTimeZone(u.id, 'America/New_York', { pinned: false });
  assert.deepStrictEqual([unpin.user.timeZone, unpin.user.timeZonePinned], ['America/New_York', false], 'follow the device again, from its zone now');
  assert.strictEqual(auth.setTimeZone(u.id, 'Mars/Base', { auto: true }).ok, false);
  assert.strictEqual(auth.setTimeZone(u.id, null, { pinned: true }).ok, false, 'nothing to pin');
  assert.strictEqual(auth.setTimeZone('nobody', 'UTC', { auto: true }).ok, false);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'users.json'), 'utf8')).users[0];
  assert.deepStrictEqual([saved.timeZone, !!saved.timeZonePinned], ['America/New_York', false], 'kept in the users file');
  const src = read('lib/auth.js');
  const fn = src.slice(src.indexOf('function setTimeZone('), src.indexOf('function deleteUser('));
  assert.ok(!/if \(auto\)[\s\S]*?audit\(/.test(fn.slice(fn.indexOf('if (auto)'), fn.indexOf('if (pinned && !tz)'))), 'a device report is not audited');
  assert.match(fn, /if \(changed\) \{ save\(\); audit\(id, 'user\.timezone'/, 'a choice in the Security dialog is');
});

test('what agents read: recall results, history stamps and the current request are local, zone named', () => {
  const sdk = require('../lib/sdk-chat');
  const rows = [{ id: 7, ts: AT, kind: 'user', text: 'Push to experimental.' }];
  assert.strictEqual(sdk.formatRecall(rows, 'America/New_York'), '#7 2026-10-28 15:47 EDT user\nPush to experimental.');
  assert.strictEqual(sdk.formatRecall(rows, 'America/Los_Angeles'), '#7 2026-10-28 12:47 PDT user\nPush to experimental.');
  const now = Date.parse('2026-10-28T20:05:00Z');
  const out = sdk.__cache.annotateForContext([{ role: 'user', content: 'earlier', ts: AT }, { role: 'user', content: 'now' }], { now, timeZone: 'America/New_York', hubContext: 'hits' });
  assert.strictEqual(out[0].content, '[Oct 28 15:47 EDT] earlier', 'a past message in local time, zone named');
  assert.ok(out[1].content.startsWith('<local_time zone="America/New_York">Wednesday, October 28, 2026 at 4:05 PM EDT</local_time>\n<hub_context>\nhits\n</hub_context>\n'), out[1].content);
  assert.ok(out[1].content.includes('<current_request sent="Oct 28 2026 16:05 EDT" zone="America/New_York">\nnow\n</current_request>'), out[1].content);
  const plain = sdk.__cache.annotateForContext([{ role: 'user', content: 'now' }], { now });
  assert.ok(!plain[0].content.includes('<local_time'), 'without a zone: as before');
  const chunks = require('../lib/context-budget').chunkRows([{ ts: AT, kind: 'user', text: 'hello' }], 1000, 'America/New_York');
  assert.deepStrictEqual(chunks, ['[2026-10-28 15:47 EDT] Owner: hello']);
});

test('every route and every place an agent reads a time uses the person\'s zone', () => {
  const chat = read('lib/sdk-chat.js');
  assert.ok(chat.includes("const timeZoneLib = require('./timezone');"));
  assert.ok(chat.includes('contextPrefix = `${timeZoneLib.localTimeTag(timeZoneLib.zoneForAgent(agentName))}\\n`;'), 'Claude route: the local time first');
  assert.ok(chat.includes('let prompt = `${timeZoneLib.localTimeTag(timeZoneLib.zoneForAgent(agentName))}\\n` + sdkInterject.formatCarried(carried)'), 'Codex route');
  assert.ok(chat.includes("annotateForContext(trimmed, { hubContext: hubContextOut.text || '', timeZone: timeZoneLib.zoneForAgent(agentName) })"), 'API route');
  assert.strictEqual((chat.match(/timeZoneLib\.policyText\(\)/g) || []).length, 3, 'the TIME section on all three routes');
  assert.ok(chat.includes('handler: async (args) => recallFor(agentName, args),') && chat.includes('async (args) => text(recallFor(agentName, args)),'), 'recall reads local from/to on both tool sets');
  assert.strictEqual((chat.match(/formatRecall\([^;]*?, (zone|timeZoneLib\.zoneForAgent\(agentName\))\)/g) || []).length, 3, 'recall and both recall_context tools answer in local time');
  assert.doesNotMatch(chat, /Xm ago/, 'the old history-stamp wording is gone');
  const agents = read('lib/agents.js');
  assert.strictEqual((agents.match(/tzLib\.stamp\((r|h)\.ts, zone\)/g) || []).length, 2, 'search hits and recent conversation');
  assert.doesNotMatch(agents, /String\((r|h)\.ts\)\.replace\('T', ' '\)\.slice\(0, 16\)/);
  assert.ok(read('lib/compaction.js').includes("chunkRows(rows, chunkChars, require('./timezone').zoneForAgent(agentName))"));
  const mem = read('lib/memory-db.js');
  assert.ok(mem.includes('const date = tz.localDate(zone, now);') && mem.includes('const time = `${tz.localHm(zone, now)} ${tz.zoneName(zone, now)}`;'), 'session notes: the person\'s day, and the time with its zone');
  assert.ok(mem.includes(".all(agent, tzLib.addDays(today, -SESSION_LOOKBACK_DAYS), tzLib.addDays(today, 2), SESSION_NOTE_DAYS);"), '...read back by the same calendar days, up to two days ahead');
  assert.strictEqual((mem.match(/ORDER BY id'/g) || []).length, 2, 'in the order written');
  const sched = read('lib/scheduled-tasks.js');
  assert.doesNotMatch(sched, /\|\| 'America\/New_York'/, 'no install defaults to US Eastern any more');
  assert.match(sched, /times are in the local time of the person you work for unless you name a zone/, 'what agents are told');
  assert.match(sched, /Times are in the local time of the person the agent works for unless a zone is named/);
  assert.match(sched, /parseWhen\(when, now, this\.zoneFor\(agent\)\)/);
  assert.ok(read('lib/hub-map.js').includes('zone = () => require(\'./timezone\').hubZone(),'));
});

test('recent session notes: the last local calendar days, also across the nights the clocks change', () => {
  const MOD = require.resolve('../lib/memory-db');
  const keepDb = process.env.HUB_MEMORY_DB, realNow = Date.now;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tz-notes-'));
  process.env.HUB_MEMORY_DB = path.join(dir, 'memory.db');
  delete require.cache[MOD];
  tz._setDeps({ auth: { admins: () => [{ id: 'u1', createdAt: '2026-01-01T00:00:00Z', timeZone: 'America/New_York' }], getUser: () => null }, agents: () => [] });
  const m = require(MOD);
  try {
    const add = (date, text) => m.getDb().prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)').run('a', date, '12:00 EDT', 'Chat', text);
    for (const [d, t] of [['2027-03-13', 'thirteenth'], ['2027-03-14', 'fourteenth'], ['2027-03-15', 'fifteenth'], ['2026-10-31', 'halloween'], ['2026-11-01', 'first']]) add(d, t);
    Date.now = () => Date.parse('2027-03-15T04:30:00Z');   // 00:30 on March 15 in New York, the night after the clocks went forward
    const spring = m.getMemoryContext('a');
    assert.ok(spring.includes('# Session Memory (2027-03-15)') && spring.includes('# Session Memory (2027-03-14)'), 'yesterday is the 14th, not the 13th');
    assert.ok(!spring.includes('thirteenth'));
    Date.now = () => Date.parse('2026-11-02T04:30:00Z');   // 23:30 on November 1, a 25-hour day
    const fall = m.getMemoryContext('a');
    assert.strictEqual((fall.match(/# Session Memory \(2026-11-01\)/g) || []).length, 1, 'today once');
    assert.ok(fall.includes('# Session Memory (2026-10-31)'), 'and yesterday');
    add('2026-11-03', 'tokyo');   // written in Tokyo on the morning of Nov 3, then the person flew to New York, where it is Nov 2
    Date.now = () => Date.parse('2026-11-02T22:00:00Z');   // 17:00 on Nov 2 in New York
    assert.ok(m.getMemoryContext('a').includes('tokyo'), 'a note filed under the day it already was where it was written');
    add('2026-11-04', 'kiritimati');   // written at 00:30 on Nov 4 in Kiritimati (UTC+14), read at 23:30 on Nov 2 in Pago Pago (UTC-11)
    tz._setDeps({ auth: { admins: () => [{ id: 'u1', createdAt: '2026-01-01T00:00:00Z', timeZone: 'Pacific/Pago_Pago' }], getUser: () => null }, agents: () => [] });
    Date.now = () => Date.parse('2026-11-03T10:30:00Z');
    assert.ok(m.getMemoryContext('a').includes('kiritimati'), 'even two calendar days ahead');
  } finally {
    Date.now = realNow;
    try { m.getDb().close(); } catch {}
    delete require.cache[MOD];
    if (keepDb === undefined) delete process.env.HUB_MEMORY_DB; else process.env.HUB_MEMORY_DB = keepDb;
    tz._setDeps(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old notes are cleaned up by each agent\'s own days', () => {
  const MOD = require.resolve('../lib/memory-db');
  const keepDb = process.env.HUB_MEMORY_DB, realNow = Date.now;
  const dir = tmp('tz-clean-');
  process.env.HUB_MEMORY_DB = path.join(dir, 'memory.db');
  delete require.cache[MOD];
  // The hub's agents are in Pago Pago (UTC-11); "far" works for someone in Kiritimati (UTC+14), two calendar days ahead.
  tz._setDeps({ auth: { admins: () => [{ id: 'u1', createdAt: '2026-01-01T00:00:00Z', timeZone: 'Pacific/Pago_Pago' }], getUser: (id) => (id === 'k' ? { id: 'k', timeZone: 'Pacific/Kiritimati' } : null) },
    agents: () => [{ name: 'far', owner: 'k' }], ownerOf: (a) => a.owner || null });
  const m = require(MOD);
  try {
    Date.now = () => Date.parse('2026-11-03T10:30:00Z');   // Nov 2 in Pago Pago, Nov 4 in Kiritimati
    const ins = m.getDb().prepare('INSERT INTO session_notes (agent,date,time,category,content) VALUES (?,?,?,?,?)');
    ins.run('far', '2026-08-05', '09:00', 'c', 'far-old'); ins.run('far', '2026-08-06', '09:00', 'c', 'far-keep');
    ins.run('near', '2026-08-04', '09:00', 'c', 'near-keep'); ins.run('near', '2026-08-03', '09:00', 'c', 'near-old');
    const log = console.log; console.log = () => {};
    try { m.cleanupOldSessions(); } finally { console.log = log; }
    assert.deepStrictEqual(m.getDb().prepare('SELECT content FROM session_notes ORDER BY content').all().map(r => r.content), ['far-keep', 'near-keep'], '90 of each person\'s own days');
  } finally {
    Date.now = realNow;
    try { m.getDb().close(); } catch {}
    delete require.cache[MOD];
    if (keepDb === undefined) delete process.env.HUB_MEMORY_DB; else process.env.HUB_MEMORY_DB = keepDb;
    tz._setDeps(null);
  }
});

test('recall says when it can\'t read a from/to, instead of searching without it', () => {
  const sdk = require('../lib/sdk-chat');
  assert.strictEqual(sdk.recallFor('nobody', { query: 'x', from: 'next blue moon' }), 'Could not read from "next blue moon" as a date or time. Give a local date or time such as 2026-10-28 or 2026-10-28 09:00.');
  assert.match(sdk.recallFor('nobody', { query: 'x', from: '2026-02-30', to: 'soon' }), /^Could not read from "2026-02-30" or to "soon"/);
});

test('Records, the Files folder index, plan reset times and dreaming use local days and times too', () => {
  const rec = require('../lib/records');
  const dir = tmp('tz-files-');
  fs.writeFileSync(path.join(dir, 'late.pdf'), 'x');
  const t = new Date('2026-10-29T02:00:00Z');   // 10 PM on Oct 28 in New York, already Oct 29 in UTC
  fs.utimesSync(path.join(dir, 'late.pdf'), t, t);
  assert.match(rec.filesIndex(dir, { zone: 'America/New_York' }), /- late\.pdf \(1 bytes, 2026-10-28\)$/, 'the day it was in New York');
  assert.match(rec.filesIndex(dir), /- late\.pdf \(1 bytes, 2026-10-29\)$/, 'no zone given: UTC, as before');
  assert.ok(read('lib/agents.js').includes("records.filesIndex(filesRoot, { max: opts.compressionTurn ? 40 : 150, zone: require('./timezone').zoneForAgent(agentName) })"));
  assert.ok(read('lib/records.js').includes('updated ${tz.stamp(i.mtime, zone)}'), 'record_list');
  const plan = require('../lib/plan-usage');
  assert.strictEqual(plan.whenText('2026-10-29T00:00:00Z', 'America/New_York'), 'Wed 8:00 PM EDT');
  assert.strictEqual(plan.whenText('2026-10-29T00:00:00Z', 'America/Los_Angeles'), 'Wed 5:00 PM PDT');
  assert.match(read('lib/plan-usage.js'), /function whenText\(iso, zone = require\('\.\/timezone'\)\.hubZone\(\)\)/, 'the plan\'s owner: the hub\'s zone');
  const dream = read('lib/dream.js');
  assert.ok(dream.includes('const today = tz.localDate(zone, now.getTime());'), 'dreaming counts the same days the notes are dated by');
  assert.ok(dream.includes('startDate = tz.addDays(watermark, 1);') && dream.includes('d = addDays(d, 1)'), 'in calendar days');
  assert.doesNotMatch(dream, /now\.toISOString\(\)\.slice\(0, 10\)/);
});

test('scheduled tasks: "tomorrow at 9am" means 9 AM where the agent\'s person is', async () => {
  const st = require('../lib/scheduled-tasks');
  const T0 = Date.parse('2026-10-28T19:47:00Z');
  const zones = { east: 'America/New_York', west: 'America/Los_Angeles' };
  const inst = new st.ScheduledTasks({ dataDir: tmp('tz-sched-'), now: () => T0, log: () => {},
    agentExists: async () => true, isPrivileged: () => true, leadNames: () => ['east'], zoneFor: (a) => zones[a] });
  const e = await inst.create({ requester: 'east', agent: 'east', when: 'tomorrow at 9am', prompt: 'p' });
  const w = await inst.create({ requester: 'east', agent: 'west', when: 'tomorrow at 9am', prompt: 'p' });
  assert.strictEqual(new Date(e.nextRunAt).toISOString(), '2026-10-29T13:00:00.000Z');
  assert.strictEqual(new Date(w.nextRunAt).toISOString(), '2026-10-29T16:00:00.000Z');
  assert.strictEqual(e.nextRunLocal, 'Thu, Oct 29, 2026, 9:00 AM EDT', 'shown in its own zone');
  assert.strictEqual(w.nextRunLocal, 'Thu, Oct 29, 2026, 9:00 AM PDT');
  const stored = JSON.parse(fs.readFileSync(inst.file, 'utf8'));
  const tasks = Array.isArray(stored) ? stored : stored.tasks;
  assert.deepStrictEqual(tasks.map(t => t.schedule.tz).sort(), ['America/Los_Angeles', 'America/New_York'], 'each task keeps its zone');
  // The person moves west and the hub restarts: a task made earlier keeps its zone and time.
  zones.east = 'America/Los_Angeles';
  const daily = await inst.create({ requester: 'east', agent: 'west', when: 'every day at 9am', prompt: 'p' });
  zones.west = 'Asia/Tokyo';
  const again = new st.ScheduledTasks({ dataDir: path.dirname(inst.file), now: () => T0, log: () => {}, agentExists: async () => true, isPrivileged: () => true, leadNames: () => ['east'], zoneFor: (a) => zones[a] });
  const kept = again.list('east').find(t => t.id === e.id), keptDaily = again.list('east').find(t => t.id === daily.id);
  assert.strictEqual(kept.nextRunAt, e.nextRunAt, 'a one-off keeps its moment');
  assert.strictEqual(keptDaily.nextRunLocal, 'Thu, Oct 29, 2026, 9:00 AM PDT', 'a recurring task keeps its zone after a restart');
});

// A page's function, cut out of the page by its braces (the pages are plain scripts, not modules).
function extract(src, name) {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0, i = src.indexOf('{', start);
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(start, i + 1);
}

// The page's own reportTimeZone, run against stubs: a clock, the device's zone, the tab's visibility and the hub.
function pageReporter(file) {
  const src = read(file);
  const helpers = extract(src, 'deviceTimeZone');
  const env = { now: Date.parse(AT), zone: 'America/Los_Angeles', visible: 'visible', sent: [], answer: null, fail: false, status: 200 };
  const me = { user: { id: 'u1', timeZone: 'America/New_York', timeZonePinned: false }, timeZone: 'America/New_York' };
  const post = (url, opts) => {
    env.sent.push({ url, body: JSON.parse(opts.body) });
    if (env.fail) return Promise.reject(new Error('offline'));
    return new Promise((resolve) => { env.answer = () => resolve({ ok: env.status === 200, status: env.status, json: async () => ({ ok: true, user: { ...me.user, timeZone: env.zone }, timeZone: env.zone }) }); });
  };
  const make = new Function('window', 'hubMe', 'document', 'fetch', 'api', 'Date', 'Intl', `
    const TZ_REPORT_EVERY_MS = 10 * 60 * 1000;
    let tzReportedAt = 0, tzChoice = 0, tzSentAt = 0;
    ${helpers}
    ${extract(src, 'reportTimeZone')}
    ${extract(src, 'zoneHeader')}
    return { report: reportTimeZone, cameBack: () => { tzReportedAt = 0; }, choose: () => { tzChoice++; }, sent: () => { tzSentAt = Date.now(); }, zoneHeader };`);
  const page = make({ hubMe: me }, me, { get visibilityState() { return env.visible; } }, post, post, { now: () => env.now },
    { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: env.zone }) }) });
  return { env, me, page };
}

for (const file of ['app.js', 'mobile.js']) {
  test(`${file}: the device in use reports its zone; a page nobody is using does not`, async () => {
    const src = read(file);
    assert.doesNotMatch(extract(src, 'loadMe'), /reportTimeZone/, 'not when the page loads: a page can reload by itself after a restart, where nobody is');
    assert.ok(src.includes("for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, reportTimeZone, { capture: true, passive: true });"), 'on a tap or a key');
    assert.ok(src.includes("document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tzReportedAt = 0; });"), 'at once again when it comes back into view');
    const { env, me, page } = pageReporter(file);
    const flush = () => new Promise((r) => setImmediate(r));
    env.visible = 'hidden';
    page.report();
    assert.strictEqual(env.sent.length, 0, 'a hidden page says nothing');
    env.visible = 'visible';
    page.report();
    assert.deepStrictEqual(env.sent.map(x => [x.url, x.body]), [['/api/me/timezone', { tz: 'America/Los_Angeles', auto: true }]]);
    env.answer(); await flush(); await flush();
    assert.strictEqual(me.timeZone, 'America/Los_Angeles', 'the page learns the hub\'s answer');
    env.now += 9 * 60 * 1000; page.report();
    assert.strictEqual(env.sent.length, 1, 'at most every 10 minutes while in use');
    env.now += 2 * 60 * 1000; page.report();
    assert.strictEqual(env.sent.length, 2, 'then again (the hub saves nothing when the zone is the same)');
    page.cameBack(); env.fail = true; page.report(); await flush(); await flush();
    assert.strictEqual(env.sent.length, 3, 'coming back into view: at once');
    env.fail = false; page.report();
    assert.strictEqual(env.sent.length, 4, 'a report that never arrived is tried again at the next tap');
    page.cameBack(); env.status = 500; page.report(); env.answer(); await flush(); await flush(); env.status = 200;
    page.report();
    assert.strictEqual(env.sent.length, 6, 'and one the hub failed (HTTP 500) too');
    const sends = (src.match(/(?:fetch|api)\('\/api\/chat\/stream', \{[\s\S]{0,200}?\.\.\.zoneHeader\(\) \}/g) || []).length;
    assert.strictEqual(sends, file === 'app.js' ? 4 : 1, 'every message carries the device\'s zone');
    assert.strictEqual((src.match(/(?:fetch|api)\('\/api\/chat\/stream'/g) || []).length, sends, '...every one');
    page.cameBack(); page.report();
    assert.deepStrictEqual(page.zoneHeader(), {}, 'a tap that is not a send: the page\'s own requests say nothing');
    page.sent();
    assert.deepStrictEqual(page.zoneHeader(), { 'X-Hub-Time-Zone': 'America/Los_Angeles' }, 'a message just sent carries it');
    assert.deepStrictEqual(page.zoneHeader(), {}, 'the page\'s next request (a group\'s next speaker, seconds later) does not');
    page.sent(); env.now += 61 * 1000;
    assert.deepStrictEqual(page.zoneHeader(), {}, 'nor a request more than a minute after the send');
    const arms = file === 'app.js'
      ? [['sendSoloMessage', 'if (!retryCount) tzSentAt = Date.now();'], ['sendGroupMessage', 'tzSentAt = Date.now();'], ['sendOrchTask', 'tzSentAt = Date.now();']]
      : [['sendMessage', 'if (!fallback) tzSentAt = Date.now();']];
    for (const [fn, line] of arms) assert.ok(extract(src, fn).includes(line), `${fn}: the person's own send arms it`);
    assert.strictEqual((src.match(/tzSentAt = Date\.now\(\)/g) || []).length, arms.length, 'and nothing else does');
    const none = pageReporter(file);
    none.me.user = null; none.page.report();
    assert.strictEqual(none.env.sent.length, 0, 'nobody signed in: nothing to report');
  });
}

test('desktop: a report answered after a choice in the Security dialog does not undo the choice on the page', async () => {
  const { env, me, page } = pageReporter('app.js');
  const flush = () => new Promise((r) => setImmediate(r));
  page.report();
  page.choose();   // chooseTimeZone: tzChoice++ before its own request
  me.user = { ...me.user, timeZone: 'Europe/Berlin', timeZonePinned: true }; me.timeZone = 'Europe/Berlin';
  env.answer(); await flush(); await flush();
  assert.deepStrictEqual([me.timeZone, me.user.timeZonePinned], ['Europe/Berlin', true]);
  assert.ok(extract(read('app.js'), 'chooseTimeZone').includes('tzChoice++;'));
  assert.ok(extract(read('app.js'), 'chooseTimeZone').includes('sel.disabled = true;') && extract(read('app.js'), 'paintTimeZone').includes('sel.disabled = false;'), 'one choice at a time');
});

test('the Security dialog pins a zone or follows the device again; the hub has the route', () => {
  const app = read('app.js'), server = read('server.js');
  assert.ok(app.includes('<select id="sec-tz" onchange="chooseTimeZone(this)"'), 'Security dialog: the time zone');
  assert.ok(app.includes("const body = tz ? { tz, pinned: true } : { tz: deviceTimeZone() || null, pinned: false };"));
  assert.ok(server.includes("if (pathname === '/api/me/timezone' && req.method === 'POST') {"));
  assert.ok(server.includes("hubAuth.setTimeZone(req.hubUser.id, tz, { auto: body.auto === true, pinned: body.pinned === true })"));
  const chatRoute = server.slice(server.indexOf("if (pathname === '/api/chat/stream' && req.method === 'POST') {"), server.indexOf("return handleChatStream(body, res);"));
  assert.ok(chatRoute.includes("const deviceZone = req.headers['x-hub-time-zone'];\n      if (req.hubUser && typeof deviceZone === 'string' && deviceZone) { try { hubAuth.setTimeZone(req.hubUser.id, deviceZone.trim(), { auto: true }); } catch {} }"), 'a message\'s device zone is saved before its turn is built');
  const access = require('../lib/access');
  assert.deepStrictEqual(access.classifyRoute('/api/me/timezone', 'POST'), { kind: 'session' }, 'any signed-in person, for themselves');
});
