'use strict';
// Memory health (lib/memory-health): what it finds for each agent from stand-in measurements, the stored result, one
// phone notice for agents that turn red (again when it couldn't be sent), the nightly schedule, and the setup checklist.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMemoryHealth, folderBytes, sizeLabel, tokensLabel } = require('../lib/memory-health');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-health-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const NOW = Date.parse('2026-11-05T12:00:00Z');
const DAY = 86400000, HOUR = 3600000;
const readings = (pcts, limit = 200000) => pcts.map((p, i) => ({ at: new Date(NOW - (pcts.length - i) * 60000).toISOString(), tokens: Math.round(limit * p / 100), limit }));

function make(world = {}, { now = () => NOW } = {}) {
  const notices = [];
  let pauses = 0;
  const file = path.join(tmp, `mh-${++n}.json`);
  const mh = createMemoryHealth({
    file, now, log: () => {}, zone: () => 'UTC',
    listAgents: async () => (world.agents || []).map(a => ({ name: a, display: a[0].toUpperCase() + a.slice(1) })),
    recordsUsage: (a) => { const u = (world.records || {})[a.name]; if (u instanceof Error) throw u; return u || null; },
    history: (name) => { const h = (world.history || {})[name]; if (h instanceof Error) throw h; return { readings: ((world.readings || {})[name]) || [], runs: ((world.runs || {})[name]) || [] }; },
    compactionMode: (name) => { const m = (world.modes || {})[name]; if (m instanceof Error) throw m; return m || 'on'; },
    archiveHealth: (name) => { const h = (world.archives || {})[name]; if (h instanceof Error) throw h; return h === undefined ? { entries: 0 } : h; },
    searchTimes: (name) => ((world.searches || {})[name]) || { count: 0, maxMs: 0, slow: 0, verySlow: 0 },
    chatFile: async (name) => { const c = (world.chats || {})[name]; if (c instanceof Error) throw c; return c || null; },
    bundles: async () => world.bundles || [],
    preSplit: () => world.preSplit || [],
    notify: async (p) => { notices.push(p); return world.send || { sent: 1, failed: 0 }; },
    pause: async () => { pauses++; },
  });
  return { mh, notices, pauses: () => pauses, file };
}
const item = (r, key) => r.items.find(i => i.key === key);

test('Records: fine below 75%, nearly full from 75%, red once a file no longer loads; none when the agent has none; a failure is said, never fine', async () => {
  const { mh } = make({ records: {
    fine: { used: 60 * 1024, cap: 256 * 1024, pct: 23, files: 2, notLoaded: [] },
    full: { used: 200 * 1024, cap: 256 * 1024, pct: 78, files: 3, notLoaded: [] },
    over: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 3, notLoaded: [{ name: 'patient-a.md', bytes: 132 * 1024 }] },
    none: { used: 0, cap: 256 * 1024, pct: 0, files: 0, notLoaded: [] },
    broken: Object.assign(new Error('EACCES: permission denied, scandir \'records\''), { code: 'EACCES' }),
    guess: { used: 30 * 1024, cap: 35 * 1024, pct: 86, files: 2, notLoaded: [{ name: 'notes.md', bytes: 60 * 1024 }], estimated: true },
    guessFine: { used: 30 * 1024, cap: 135 * 1024, pct: 22, files: 2, notLoaded: [], estimated: true },
    links: { used: 40 * 1024, cap: 256 * 1024, pct: 16, files: 2, notLoaded: [], unloadable: [{ name: 'patient-a.md', kind: 'link', why: 'a link to a file that no longer exists' }, { name: 'notes .md', kind: 'name', why: 'its name has characters or a length the hub can\'t open' }] },
    onlyLink: { used: 0, cap: 256 * 1024, pct: 0, files: 0, notLoaded: [], unloadable: [{ name: 'matter.md', kind: 'link', why: 'a link the hub won\'t follow' }] } } });
  const fine = await mh.checkAgent({ name: 'fine' }), full = await mh.checkAgent({ name: 'full' }), over = await mh.checkAgent({ name: 'over' });
  assert.deepStrictEqual([item(fine, 'records').status, fine.status, item(fine, 'records').detail], ['green', 'green', '60 KB of its 256 KB cap (23%).']);
  assert.deepStrictEqual([item(full, 'records').status, item(full, 'records').title], ['amber', 'Records nearly full']);
  assert.match(item(full, 'records').detail, /200 KB of its 256 KB cap \(78%\)\. It is told on every turn to condense them\./);
  assert.deepStrictEqual([item(over, 'records').status, over.status, item(over, 'records').title], ['red', 'red', 'Some Records aren\'t loading']);
  assert.match(item(over, 'records').detail, /patient-a\.md \(132 KB\) doesn't fit in its 256 KB Records cap, so it isn't in front of it\./);
  assert.deepStrictEqual((await mh.checkAgent({ name: 'none' })).items, [], 'nothing to say about an agent with no Records');
  const broken = await mh.checkAgent({ name: 'broken' });
  assert.deepStrictEqual([broken.status, item(broken, 'records').title, item(broken, 'records').detail], ['amber', 'Couldn\'t check its Records', 'EACCES: permission denied, scandir \'records\'.']);
  // a local model server that didn't answer: the cap is an estimate, so it decides nothing: amber, never red or fine
  const guess = item(await mh.checkAgent({ name: 'guess' }), 'records');
  assert.deepStrictEqual([guess.status, guess.title], ['amber', 'Some Records may not be loading']);
  assert.match(guess.detail, /^notes\.md \(60 KB\) may not fit in its Records cap of about 35 KB: its local model server didn't say how big its window is, so the cap is an estimate\. Starting the model server, or setting the agent's context window on its settings page, lets a check a few minutes later confirm it\.$/);
  const guessFine = item(await mh.checkAgent({ name: 'guessFine' }), 'records');
  assert.deepStrictEqual([guessFine.status, guessFine.title], ['amber', 'Records cap not confirmed']);
  assert.match(guessFine.detail, /^30 KB of its Records would load under a cap of about 135 KB, but its local model server didn't say/);
  // Records that are never loaded at all (a dead link, a link the hub won't follow): red, named, with why
  const links = await mh.checkAgent({ name: 'links' });
  assert.deepStrictEqual(links.items.filter(i => i.key === 'records').map(i => [i.status, i.title]), [['green', 'Records'], ['red', 'Some Records can\'t be loaded'], ['amber', 'A file in its Records folder can\'t be opened']], 'a lost link is red; a stray odd name is amber');
  assert.strictEqual(links.items[1].detail, 'patient-a.md (a link to a file that no longer exists). It isn\'t in front of it, and it isn\'t told.');
  assert.deepStrictEqual((await mh.checkAgent({ name: 'onlyLink' })).items.map(i => [i.status, i.title]), [['red', 'Some Records can\'t be loaded']], 'even when it is the only one');
});

test('context: for information (where its recent turns ended); amber only when the last turn ended nearly full while compression is off or a dry run', async () => {
  const { mh } = make({
    readings: { few: readings([90, 95]), long: readings([20, 40, 60, 88]), climbing: readings([60, 78, 85, 89]), dry: readings([10, 50, 93]), off: readings([10, 50, 95]), on: readings([10, 50, 93]),
      switched: [...readings([90, 90]), ...readings([20], 1000000)], nomode: readings([10, 50, 93]) },
    modes: { dry: 'dry', off: 'off', on: 'on', climbing: 'dry', nomode: new Error('agents file unreadable') }, history: { broken: new Error('state file unreadable') } });
  assert.strictEqual(item(await mh.checkAgent({ name: 'few' }), 'context'), undefined, 'three readings needed');
  assert.deepStrictEqual(item(await mh.checkAgent({ name: 'long' }), 'context'), { key: 'context', status: 'green', title: 'Context', detail: 'Its last 4 turns ended between 20% and 88% of its 200K-token window.' });
  assert.strictEqual(item(await mh.checkAgent({ name: 'climbing' }), 'context').status, 'green', 'a long session that climbs is not a finding');
  const dry = item(await mh.checkAgent({ name: 'dry' }), 'context');
  assert.deepStrictEqual([dry.status, dry.title, dry.detail], ['amber', 'Context nearly full', 'Its last turn ended at 93% of its 200K-token window, and compression is only a dry run for it.']);
  assert.match(item(await mh.checkAgent({ name: 'off' }), 'context').detail, /ended at 95% .* compression is off for it\.$/);
  assert.strictEqual(item(await mh.checkAgent({ name: 'on' }), 'context').status, 'green', 'with compression on, a full window is what compression is for');
  const broken = await mh.checkAgent({ name: 'broken' });
  assert.deepStrictEqual([broken.status, item(broken, 'context').title], ['amber', 'Couldn\'t check its context readings']);
  assert.strictEqual(item(await mh.checkAgent({ name: 'switched' }), 'context').detail, 'Its last 3 turns ended between 20% and 90% of the window each turn had (the latest was 1M tokens).', 'a model switch: no window is named for turns it was not');
  const nomode = await mh.checkAgent({ name: 'nomode' });
  assert.deepStrictEqual(nomode.items.filter(i => i.key === 'context').map(i => [i.status, i.title]), [['amber', 'Couldn\'t check its compression setting'], ['green', 'Context']], 'a failed lookup is said, never read as "on"');
});

test('compression: amber when the last run within a week failed; otherwise how often it ran', async () => {
  const run = (daysAgo, ok, error) => ({ at: new Date(NOW - daysAgo * DAY).toISOString(), ok, mode: 'on', reason: 'threshold', reset: ok, ...(error ? { error } : {}) });
  const { mh } = make({ runs: { failed: [run(3, true), run(1, false, 'brief not written; session kept')], old: [run(20, true), run(9, false, 'x')], ok: [run(10, true), run(2, true), run(1, true)] } });
  const failed = item(await mh.checkAgent({ name: 'failed' }), 'compression');
  assert.deepStrictEqual([failed.status, failed.title], ['amber', 'The last compression failed']);
  assert.match(failed.detail, /: brief not written; session kept\.$/);
  assert.strictEqual(item(await mh.checkAgent({ name: 'old' }), 'compression').status, 'green', 'a failure more than a week ago is history');
  assert.match(item(await mh.checkAgent({ name: 'ok' }), 'compression').detail, /^2 runs in the last 7 days; last /);
});

test('archive: red when it can\'t be read; its own recent searches decide the speed (amber from 500 ms, red from 2 s); the chat file for information', async () => {
  const big = { entries: 30000, fileBytes: 40 * 1048576, recent: 1200 };
  const { mh } = make({
    archives: { broken: null, small: { entries: 150, fileBytes: 90000, recent: 12 }, quick: big, slow: big, crawl: { ...big, fileBytes: 3 * 1073741824 }, combined: { entries: 9, fileBytes: null, recent: 2 }, odd: new Error('disk I/O error') },
    searches: { quick: { count: 50, maxMs: 80, slow: 0, verySlow: 0 }, slow: { count: 12, maxMs: 900, slow: 4, verySlow: 0 }, crawl: { count: 5, maxMs: 2400, slow: 5, verySlow: 3 }, small: { count: 20, maxMs: 650, slow: 1, verySlow: 0, failed: 2 } },
    chats: { quick: { messages: 212, bytes: 3.1 * 1048576 }, slow: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) } });
  assert.deepStrictEqual([item(await mh.checkAgent({ name: 'broken' }), 'archive').status, item(await mh.checkAgent({ name: 'broken' }), 'archive').title], ['red', 'Its archive can\'t be read']);
  const small = await mh.checkAgent({ name: 'small' });
  assert.deepStrictEqual(small.items.filter(i => i.key === 'archive').map(i => [i.status, i.detail]), [
    ['green', '150 entries, 88 KB; 12 added in the last 30 days; the slowest of its 20 searches this week took 650 ms.'],
    ['amber', '2 searches this week failed, so recall may have missed its past conversations then.']], 'one slow search is not "slow"; failed searches are said');
  assert.strictEqual(item(await mh.checkAgent({ name: 'combined' }), 'archive').detail, '9 entries; 2 added in the last 30 days.', 'no searches yet: nothing said about speed');
  const quick = await mh.checkAgent({ name: 'quick' });
  assert.deepStrictEqual([item(quick, 'archive').status, item(quick, 'archive').detail], ['green', '30,000 entries, 40.0 MB; 1,200 added in the last 30 days; the slowest of its 50 searches this week took 80 ms.']);
  assert.deepStrictEqual([item(quick, 'chat').status, item(quick, 'chat').detail], ['green', '212 messages in its chat file, 3.1 MB.']);
  const slow = await mh.checkAgent({ name: 'slow' });
  assert.deepStrictEqual([item(slow, 'archive').status, item(slow, 'archive').title], ['amber', 'Searching its archive is slow']);
  assert.match(item(slow, 'archive').detail, /; 4 of its 12 searches this week took 500 ms or longer \(the slowest 900 ms\)\.$/);
  assert.deepStrictEqual([item(slow, 'chat').status, item(slow, 'chat').title], ['amber', 'Couldn\'t check its chat file']);
  const crawl = item(await mh.checkAgent({ name: 'crawl' }), 'archive');
  assert.deepStrictEqual([crawl.status, /3 of its 5 searches this week took 2 seconds or longer \(the slowest 2,400 ms\)/.test(crawl.detail)], ['red', true]);
  assert.deepStrictEqual([item(await mh.checkAgent({ name: 'odd' }), 'archive').status, item(await mh.checkAgent({ name: 'odd' }), 'archive').title], ['amber', 'Couldn\'t check its archive']);
  assert.strictEqual(item(await mh.checkAgent({ name: 'nothing' }), 'archive'), undefined, 'no archive yet: nothing to say');
});

test('a check: the worst first, counts, stored privately; one phone notice for agents that turned red, none for those already told', async () => {
  const world = {
    agents: ['maestro', 'doc', 'watchman', 'tester'],
    records: { doc: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 3, notLoaded: [{ name: 'patient-a.md', bytes: 132 * 1024 }] }, maestro: { used: 200 * 1024, cap: 256 * 1024, pct: 78, files: 3, notLoaded: [] }, tester: new Error('disk gone') },
    bundles: [{ folder: 'rifle-20261102T214939Z', name: 'rifle', bytes: 3 * 1048576, complete: true, partial: false }],
    preSplit: [{ file: 'transcript.db.pre-split', bytes: 120 * 1048576 }],
  };
  const { mh, notices, pauses, file } = make(world);
  const r = await mh.run();
  assert.deepStrictEqual(r.agents.map(a => [a.agent, a.status]), [['doc', 'red'], ['maestro', 'amber'], ['tester', 'amber'], ['watchman', 'green']]);
  assert.deepStrictEqual(r.counts, { red: 1, amber: 2, green: 1 });
  assert.deepStrictEqual(r.extras, { bundles: { count: 1, bytes: 3 * 1048576, complete: true, items: world.bundles }, preSplit: world.preSplit });
  assert.ok(pauses() >= 4, 'it pauses between agents so the hub keeps answering');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).notified, ['doc']);
  assert.deepStrictEqual(notices, [{ title: 'Doc: some records aren\'t loading', body: 'Open Settings → Status → Memory to see what would help.', url: '/?memory=1', tag: 'memory-health' }]);
  await mh.run();
  assert.strictEqual(notices.length, 1, 'still red and told: no second notice');
  world.records.maestro = { used: 300 * 1024, cap: 256 * 1024, pct: 99, files: 2, notLoaded: [{ name: 'hub-state.md', bytes: 120 * 1024 }] };
  world.records.watchman = { used: 300 * 1024, cap: 256 * 1024, pct: 99, files: 2, notLoaded: [{ name: 'alert-rules.md', bytes: 50 * 1024 }] };
  await mh.run();
  assert.deepStrictEqual([notices.length, notices[1].title, notices[1].body], [2, '2 agents need attention', 'Maestro: some records aren\'t loading; Watchman: some records aren\'t loading']);
  delete world.records.doc;
  await mh.run();
  assert.deepStrictEqual(mh.stored().notified, ['maestro', 'watchman'], 'an agent that is fine again leaves the list, so a later red tells again');
});

test('a notice that could not be sent is tried again at the next check; with nobody to send to, it counts as told', async () => {
  const world = { agents: ['doc'], records: { doc: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 3, notLoaded: [{ name: 'patient-a.md', bytes: 132 * 1024 }] } }, send: { sent: 0, failed: 2 } };
  const { mh, notices } = make(world);
  await mh.run();
  assert.deepStrictEqual([notices.length, mh.stored().notified], [1, []]);
  world.send = { sent: 1, failed: 1 };
  await mh.run();
  assert.deepStrictEqual([notices.length, mh.stored().notified], [2, ['doc']]);
  await mh.run();
  assert.strictEqual(notices.length, 2);
  const quiet = make({ agents: ['doc'], records: world.records, send: { sent: 0, failed: 0 } });
  await quiet.mh.run();
  assert.deepStrictEqual(quiet.mh.stored().notified, ['doc'], 'no device registered: nothing to retry');
  const broken = make({ agents: ['doc'], records: world.records, send: { sent: 0, failed: 0, removed: 0, error: 'push keys unreadable' } });
  await broken.mh.run();
  assert.deepStrictEqual(broken.mh.stored().notified, [], 'the push service itself failed: tried again');
});

test('the nightly schedule: the first look after start when never checked; then each night between 2 and 5 AM once per calendar day; any time after 48 hours', async () => {
  let t = Date.parse('2026-11-05T14:00:00Z');
  const { mh } = make({ agents: ['doc'] }, { now: () => t });
  assert.strictEqual(mh.isDue(), true, 'never checked: the first look after start, whatever the hour');
  await mh.run();   // a daytime check, 14:00 on the 5th
  t = Date.parse('2026-11-05T22:00:00Z');
  assert.strictEqual(mh.isDue(), false, 'evening: not due');
  t = Date.parse('2026-11-06T02:00:00Z');
  assert.strictEqual(mh.isDue(), true, 'the next night is due even though the last check was only 12 hours ago');
  await mh.run();
  t = Date.parse('2026-11-06T03:00:00Z');
  assert.strictEqual(mh.isDue(), false, 'checked tonight already');
  t = Date.parse('2026-11-06T10:00:00Z');
  await mh.run();   // Check now in the morning
  t = Date.parse('2026-11-07T02:05:00Z');
  assert.strictEqual(mh.isDue(), true, 'a morning press does not cost the next night');
  await mh.run();
  t = Date.parse('2026-11-09T05:30:00Z');
  assert.strictEqual(mh.isDue(), true, 'off at night for two days: due at any hour after 48 hours');
});

test('the setup checklist: red agents as a warning, amber ones as a note, otherwise all fine (nothing with no agents); latest() answers from the stored check', async () => {
  const world = { agents: ['maestro', 'doc'], records: { doc: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 3, notLoaded: [{ name: 'patient-a.md', bytes: 132 * 1024 }] } } };
  const { mh } = make(world);
  assert.deepStrictEqual(mh.readinessItems(), [], 'nothing before the first check');
  assert.strictEqual((await mh.latest()).cached, false);
  const [red] = mh.readinessItems();
  assert.deepStrictEqual([red.id, red.level, red.title, red.detail, red.action], ['memory', 'warn', '1 agent needs attention for memory', 'Doc: some records aren\'t loading.', { label: 'Open Memory', href: '/?memory=1' }]);
  assert.strictEqual((await mh.latest()).cached, true);
  world.records.doc = { used: 200 * 1024, cap: 256 * 1024, pct: 78, files: 3, notLoaded: [] };
  await mh.run();
  assert.deepStrictEqual(mh.readinessItems().map(i => [i.level, i.title]), [['info', '1 agent could use a look for memory']]);
  delete world.records.doc;
  await mh.run();
  assert.deepStrictEqual(mh.readinessItems().map(i => [i.level, i.title, i.detail]), [['ok', 'Agents\' memory', 'All 2 agents are fine (checked 2026-11-05 12:00 UTC).']]);
  const empty = make({ agents: [] });
  await empty.mh.run();
  assert.deepStrictEqual(empty.mh.readinessItems(), [], 'no agents: no line');
});

test('folder sizes: counted without holding up the hub, within a budget shared by every folder', async () => {
  const d = fs.mkdtempSync(path.join(tmp, 'bundle-'));
  fs.mkdirSync(path.join(d, 'workspace', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workspace', 'a.md'), 'a'.repeat(1000));
  fs.writeFileSync(path.join(d, 'workspace', 'deep', 'b.md'), 'b'.repeat(500));
  fs.symlinkSync('/etc/hostname', path.join(d, 'workspace', 'link'));   // links are not followed
  assert.deepStrictEqual(await folderBytes(d), { bytes: 1500, complete: true });
  const budget = { left: 2 };
  const partial = await folderBytes(d, budget);
  assert.strictEqual(partial.complete, false);
  assert.deepStrictEqual(await folderBytes(d, budget), { bytes: 0, complete: false }, 'the budget is shared');
});

test('sizes and windows read plainly', () => {
  assert.deepStrictEqual([sizeLabel(900), sizeLabel(256 * 1024), sizeLabel(3.1 * 1048576), sizeLabel(1.2 * 1073741824)], ['1 KB', '256 KB', '3.1 MB', '1.2 GB']);
  assert.deepStrictEqual([tokensLabel(200000), tokensLabel(1000000), tokensLabel(131072)], ['200K', '1M', '131K']);
});
