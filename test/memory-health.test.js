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
    listAgents: async () => { if (world.listFail && world.listFail()) throw new Error('could not list the agents'); return (world.agents || []).map(a => ({ name: a, display: a[0].toUpperCase() + a.slice(1) })); },
    recordsUsage: (a) => { const u = (world.records || {})[a.name]; if (u instanceof Error) throw u; return u || null; },
    history: (name) => { const h = (world.history || {})[name]; if (h instanceof Error) throw h; return { readings: ((world.readings || {})[name]) || [], runs: ((world.runs || {})[name]) || [] }; },
    compactionSettings: (name) => { const m = (world.modes || {})[name]; if (m instanceof Error) throw m; return { mode: m || 'on', at: ((world.at || {})[name]) || 0.75 }; },
    archiveHealth: (name) => { const h = (world.archives || {})[name]; if (h instanceof Error) throw h; return h === undefined ? { entries: 0 } : h; },
    searchTimes: (name) => ((world.searches || {})[name]) || { count: 0, maxMs: 0, slow: 0, verySlow: 0 },
    chatFile: async (name) => { const c = (world.chats || {})[name]; if (c instanceof Error) throw c; return c || null; },
    bundles: async () => world.bundles || [],
    preSplit: () => world.preSplit || [],
    notify: async (p) => { notices.push(p); return world.send || { sent: 1, failed: 0 }; },
    pause: async () => { pauses++; if (world.pauseGate) await world.pauseGate; },
    agentBusy: (name) => (world.busy || []).includes(name),
    snapshotRecords: async (a) => { if (world.snapFail) throw world.snapFail; (world.snaps = world.snaps || []).push(a.name); return { file: '/ws/x', name: '.records-before-condense-20261105T120000Z.json', files: 3 }; },
    discardSnapshot: async (a, snap) => { (world.discarded = world.discarded || []).push(snap && snap.name); },
    pruneSnapshots: async (a) => { (world.pruned = world.pruned || []).push(a.name); },
    startTurn: async (name, message) => { if (world.refuse) throw world.refuse; (world.turns = world.turns || []).push({ name, message }); return { done: Promise.resolve('condensed') }; },
    setCompaction: async (name, c) => {
      (world.saved = world.saved || []).push({ name, ...c });
      if ('mode' in c) world.modes = { ...(world.modes || {}), [name]: c.mode };
      if ('at' in c) world.at = { ...(world.at || {}), [name]: c.at };
      return { success: true };
    },
    tidyStep: (name, o) => {
      (world.firsts = world.firsts || []).push(!!(o && o.first));
      world.tidies = (world.tidies || 0) + 1;
      const fixed = (world.tidyResult || {})[name];
      if (fixed !== undefined) return fixed;
      if (!(world.archives || {})[name]) return null;
      return { done: world.tidies >= (world.tidyDoneAt || 3) };
    },
    // the pause between tidy steps is a tick; the 20-second answer timer fires only when a test says so
    sleep: (ms) => (ms >= 1000 ? (world.answerNow ? Promise.resolve() : new Promise(() => {})) : new Promise(r => setImmediate(r))),
    removeBundle: async (folder, o) => { (world.removed = world.removed || []).push(folder); (world.expected = world.expected || []).push(o && o.expectName); world.bundles = (world.bundles || []).filter(b => b.folder !== folder); },
    removePreSplit: async (file) => { (world.removed = world.removed || []).push(file); world.preSplit = []; },
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
  assert.deepStrictEqual(item(await mh.checkAgent({ name: 'long' }), 'context'), { key: 'context', status: 'green', title: 'Context', detail: 'Its last 4 turns ended between 20% and 88% of its 200K-token window.',
    actions: [{ id: 'compress-earlier', label: 'Compress earlier (at 60% instead of 75%)' }] }, 'turns that reach 80% with compression on: compressing earlier is offered, not urged');
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
  assert.deepStrictEqual(r.extras, { bundles: { count: 1, bytes: 3 * 1048576, complete: true, items: [{ ...world.bundles[0], action: { id: 'delete-bundle', folder: 'rifle-20261102T214939Z', confirm: 'rifle' } }] },
    preSplit: [{ ...world.preSplit[0], action: { id: 'delete-pre-split', file: 'transcript.db.pre-split', confirm: 'delete' } }] });
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

test('each finding offers only the action that answers it', async () => {
  const { mh } = make({
    records: { full: { used: 200 * 1024, cap: 256 * 1024, pct: 78, files: 3, notLoaded: [] }, guess: { used: 30 * 1024, cap: 35 * 1024, pct: 86, files: 2, notLoaded: [{ name: 'n.md', bytes: 60 * 1024 }], estimated: true } },
    readings: { dry: readings([10, 50, 93]), low: readings([10, 20, 30]), early: readings([50, 85, 70]) },
    modes: { dry: 'dry', early: 'on' }, at: { early: 0.6 },
    archives: { slow: { entries: 30000, fileBytes: 1, recent: 0 }, shared: { entries: 30000, fileBytes: null, recent: 0 } },
    searches: { slow: { count: 12, maxMs: 900, slow: 4, verySlow: 0 }, shared: { count: 12, maxMs: 900, slow: 4, verySlow: 0 } } });
  const ids = async (name, key) => (item(await mh.checkAgent({ name }), key).actions || []).map(x => x.id);
  assert.deepStrictEqual(await ids('full', 'records'), ['condense']);
  assert.deepStrictEqual(await ids('guess', 'records'), [], 'an estimated cap offers nothing to do to the agent');
  assert.deepStrictEqual(await ids('dry', 'context'), ['compression-on']);
  assert.deepStrictEqual(await ids('low', 'context'), [], 'turns that stay low: nothing offered');
  assert.deepStrictEqual(await ids('early', 'context'), [], 'already at 60%');
  assert.deepStrictEqual(await ids('slow', 'archive'), ['tidy-index']);
  assert.deepStrictEqual(await ids('shared', 'archive'), [], 'no own file yet (every agent still in the combined one): nothing to tidy on its own');
});

test('actions: each is checked against what it applies to now, and the deletes need the typed word', async () => {
  const world = { agents: ['doc', 'watchman', 'maestro', 'quiet'],
    records: { doc: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 3, notLoaded: [{ name: 'patient-a.md', bytes: 132 * 1024 }] }, maestro: { used: 200 * 1024, cap: 256 * 1024, pct: 78, files: 3, notLoaded: [] } },
    modes: { watchman: 'dry' }, at: { watchman: 0.9, maestro: 0.9 }, busy: ['maestro'], archives: { watchman: { entries: 5000, fileBytes: 1, recent: 0 } },
    bundles: [{ folder: 'rifle-20261102T214939Z', name: 'rifle', bytes: 10, complete: true, partial: false }, { folder: 'old-x.partial', name: 'old', bytes: 1, complete: true, partial: true }],
    preSplit: [{ file: 'transcript.db.pre-split', bytes: 99 }] };
  const { mh } = make(world);
  await mh.run();
  const doc = await mh.act({ action: 'condense', agent: 'doc' });
  assert.deepStrictEqual([doc.ok, doc.message], [true, 'Asked Doc to condense its Records. It is working on it now, and the next check shows the result. A copy of them as they were is in its workspace (.records-before-condense-20261105T120000Z.json).']);
  assert.deepStrictEqual([world.turns.length, world.snaps, world.pruned], [1, ['doc'], ['doc']], 'a copy first, then the turn, and only then are older copies pruned');
  assert.match(world.turns[0].message, /^\[From the hub, at an admin's request\] Your Records use 250 KB of their 256 KB cap \(98%\), and patient-a\.md doesn't fit, so it isn't loaded\. Condense them now\. First read every Record in full: the ones in front of you, and with your Read tool any that aren't loaded \(record_list shows their folder\)\. If one can't be read, change nothing and say which\./);
  assert.match(world.turns[0].message, /don't merge files: an emptied file stays behind and saves no space\. A copy of your Records as they are now is in your workspace \(\.records-before-condense-20261105T120000Z\.json\)\./);
  assert.deepStrictEqual(await mh.act({ action: 'condense', agent: 'maestro' }), { ok: false, error: 'Maestro is working right now (a reply or a background job). Try again when it\'s done.' });
  assert.deepStrictEqual(await mh.act({ action: 'condense', agent: 'quiet' }), { ok: false, error: 'Quiet has no Records to condense.' });
  assert.deepStrictEqual(await mh.act({ action: 'condense', agent: 'nobody' }), { ok: false, error: 'There is no agent by that name.' });
  const on = await mh.act({ action: 'compression-on', agent: 'watchman' });
  assert.deepStrictEqual([on.ok, on.message, world.saved[0], !!on.result], [true, 'Compression is on for Watchman: it compresses when its context reaches 90% of its window.', { name: 'watchman', mode: 'on' }, true], 'only the mode: the threshold keeps following its own setting or the hub default');
  assert.deepStrictEqual(await mh.act({ action: 'compression-on', agent: 'watchman' }), { ok: false, error: 'Compression is already on for Watchman.' });
  const earlier = await mh.act({ action: 'compress-earlier', agent: 'watchman' });
  assert.deepStrictEqual([earlier.ok, world.saved[1]], [true, { name: 'watchman', at: 0.6 }], 'only the threshold');
  assert.deepStrictEqual(await mh.act({ action: 'compress-earlier', agent: 'watchman' }), { ok: false, error: 'Watchman already compresses at 60%.' });
  const tidy = await mh.act({ action: 'tidy-index', agent: 'watchman' });
  assert.deepStrictEqual([tidy.ok, tidy.message, world.tidies, world.firsts], [true, 'Tidied Watchman\'s search index (3 steps).', 3, [true, false, false]], 'SQLite\'s rule: a negative page count on the first step only');
  assert.deepStrictEqual(await mh.act({ action: 'tidy-index', agent: 'quiet' }), { ok: false, error: 'Quiet has no archive yet.' });
  assert.deepStrictEqual(await mh.act({ action: 'delete-bundle', folder: 'rifle-20261102T214939Z', confirm: 'Rifle' }), { ok: false, error: 'Type rifle to delete it for good.' });
  assert.deepStrictEqual(await mh.act({ action: 'delete-bundle', folder: 'old-x.partial', confirm: 'old' }).then(r => r.ok), false, 'one still being put away is not offered');
  assert.deepStrictEqual(await mh.act({ action: 'delete-bundle', folder: '../../etc', confirm: 'x' }).then(r => r.ok), false);
  const del = await mh.act({ action: 'delete-bundle', folder: 'rifle-20261102T214939Z', confirm: 'rifle' });
  assert.deepStrictEqual([del.ok, del.message, world.removed, world.expected, del.result.extras.bundles.items.map(b => b.folder)], [true, 'Deleted rifle\'s folder for good.', ['rifle-20261102T214939Z'], ['rifle'], ['old-x.partial']], 'the name typed goes with the removal, which checks it against the folder again');
  assert.deepStrictEqual(await mh.act({ action: 'delete-pre-split', file: 'transcript.db.pre-split', confirm: 'yes' }), { ok: false, error: 'Type delete to remove it for good.' });
  const ps = await mh.act({ action: 'delete-pre-split', file: 'transcript.db.pre-split', confirm: 'delete' });
  assert.deepStrictEqual([ps.ok, ps.message, ps.result.extras.preSplit], [true, 'Deleted transcript.db.pre-split for good.', []]);
  assert.deepStrictEqual(await mh.act({ action: 'drop-everything' }), { ok: false, error: 'Unknown action.' });
});

test('condense: nothing is asked when the hub refuses the turn or the copy of the Records can\'t be made, and the reason is said', async () => {
  const world = { agents: ['doc'], records: { doc: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 3, notLoaded: [] } } };
  const { mh } = make(world);
  world.refuse = Object.assign(new Error('Agent is busy; use interject or wait for the current turn.'), { status: 409 });
  assert.deepStrictEqual(await mh.act({ action: 'condense', agent: 'doc' }), { ok: false, error: 'Doc started working on something else just now. Try again when it\'s done.' });
  world.refuse = Object.assign(new Error('hub halted'), { status: 503 });
  assert.deepStrictEqual(await mh.act({ action: 'condense', agent: 'doc' }), { ok: false, error: 'The hub didn\'t start Doc\'s turn: hub halted.' });
  assert.deepStrictEqual([world.snaps.length, world.discarded, world.pruned], [2, ['.records-before-condense-20261105T120000Z.json', '.records-before-condense-20261105T120000Z.json'], undefined], 'each refused press removes the copy it made, and prunes nothing');
  world.refuse = null;
  world.snapFail = new Error('facts.md can\'t be read');
  assert.deepStrictEqual(await mh.act({ action: 'condense', agent: 'doc' }), { ok: false, error: 'Couldn\'t keep a copy of Doc\'s Records first (facts.md can\'t be read), so nothing was asked.' });
  assert.strictEqual(world.turns, undefined, 'no turn was started');
});

test('an action answers with a check that started after it: one already running read the old state; each check carries a higher number', async () => {
  const world = { agents: ['watchman'], readings: { watchman: readings([20, 60, 93]) }, modes: { watchman: 'dry' }, at: { watchman: 0.75 } };
  const { mh } = make(world);
  const first = await mh.run();
  assert.strictEqual(item(first.agents[0], 'context').status, 'amber');
  let release; world.pauseGate = new Promise(r => { release = r; });
  const stale = mh.run();   // reads Watchman's setting (still a dry run), then waits
  await new Promise(r => setImmediate(r));
  const acting = mh.act({ action: 'compression-on', agent: 'watchman' });
  await new Promise(r => setImmediate(r)); await new Promise(r => setImmediate(r));
  world.pauseGate = null; release();
  const [r, old] = await Promise.all([acting, stale]);
  assert.strictEqual(item(old.agents[0], 'context').status, 'amber', 'the check that was running saw the old setting');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(item(r.result.agents[0], 'context').status, 'green', 'the answer shows compression on');
  assert.ok(first.gen >= 1 && old.gen > first.gen && r.result.gen > old.gen, `rising numbers: ${first.gen}, ${old.gen}, ${r.result.gen}`);
  assert.strictEqual(mh.stored().gen, r.result.gen, 'the stored check is the newest');
});

test('tidy: one at a time per agent; refused in words before the split and when the archive can\'t be opened; a long one is answered at once and finishes in the background, its outcome on the check after it', async () => {
  const world = { agents: ['watchman', 'shared', 'broken'], archives: { watchman: { entries: 5000, fileBytes: 1, recent: 0 } },
    tidyResult: { shared: { combined: true }, broken: false } };
  const { mh } = make(world);
  assert.deepStrictEqual(await mh.act({ action: 'tidy-index', agent: 'shared' }), { ok: false, error: 'Every agent\'s archive is still in the one shared file of an earlier version, so Shared\'s search index can\'t be tidied on its own. Your Maestro splits that file at its next start.' });
  assert.deepStrictEqual(await mh.act({ action: 'tidy-index', agent: 'broken' }), { ok: false, error: 'Couldn\'t open Broken\'s archive, so its search index can\'t be tidied.' });
  world.tidyDoneAt = Infinity; world.answerNow = true;
  const r = await mh.act({ action: 'tidy-index', agent: 'watchman' });
  assert.deepStrictEqual([r.ok, r.message, !!(r.pending && r.pending.tidy)], [true, 'Tidying Watchman\'s search index. It goes on in the background (at most 10 minutes), and this list updates when it\'s done.', true]);
  assert.deepStrictEqual(await mh.act({ action: 'tidy-index', agent: 'watchman' }), { ok: false, error: 'Watchman\'s search index is being tidied already.' });
  world.tidyDoneAt = world.tidies + 2;   // two more steps
  const mine = () => ((mh.stored() || {}).tidies || []).find(x => x.id === r.pending.tidy);
  for (let i = 0; i < 50 && !mine(); i++) await new Promise(res => setImmediate(res));
  const note = mine();
  assert.deepStrictEqual([note.ok, note.done, note.message], [true, true, `Tidied Watchman's search index (${note.steps} steps).`]);
  assert.ok(note.steps >= 3);
  world.answerNow = false; world.tidyDoneAt = world.tidies + 1;
  const again = await mh.act({ action: 'tidy-index', agent: 'watchman' });
  assert.deepStrictEqual([again.ok, again.message], [true, 'Tidied Watchman\'s search index (1 step).'], 'after it ended, it can be pressed again');
});

// The real Records copies (lib/records snapshot / discardSnapshot / pruneSnapshots) in a stand-in hub folder.
function realRecords() {
  const REAL = path.resolve(__dirname, '..');
  const hub = fs.mkdtempSync(path.join(tmp, 'hub-'));
  fs.mkdirSync(path.join(hub, 'lib'));
  for (const f of ['records.js', 'path-confine.js', 'timezone.js']) fs.copyFileSync(path.join(REAL, 'lib', f), path.join(hub, 'lib', f));
  fs.writeFileSync(path.join(hub, 'lib', 'settings.js'), 'module.exports = { getSetting: (k, d) => d };');
  return { rec: require(path.join(hub, 'lib', 'records.js')), ws: (a) => path.join(hub, 'workspaces', a) };
}

test('condense with the real Records copies: a refused press leaves every earlier copy; an admitted one keeps the newest three, its own among them', async () => {
  const { rec, ws } = realRecords();
  rec.write('doc', 'facts.md', '# Facts\nBlood type O+');
  let t = Date.parse('2026-11-05T21:00:00Z');
  for (let i = 0; i < 3; i++) { rec.snapshot('doc', { now: () => t }); t += 60000; }
  const copies = () => fs.readdirSync(ws('doc')).filter(n => n.startsWith('.records-before-condense-')).sort();
  const before = copies();
  assert.strictEqual(before.length, 3);
  const world = { agents: ['doc'], records: { doc: { used: 250 * 1024, cap: 256 * 1024, pct: 98, files: 1, notLoaded: [] } } };
  const real = createMemoryHealth({ file: path.join(tmp, `mh-real-${++n}.json`), now: () => t, log: () => {},
    listAgents: async () => [{ name: 'doc', display: 'Doc' }], recordsUsage: async () => world.records.doc,
    snapshotRecords: async (a) => rec.snapshot(a.name, { now: () => t, prune: false }),
    discardSnapshot: async (a, snap) => { rec.discardSnapshot(a.name, snap.name); },
    pruneSnapshots: async (a) => rec.pruneSnapshots(a.name),
    startTurn: async () => { if (world.refuse) throw world.refuse; return { done: Promise.resolve('') }; } });
  for (let i = 0; i < 3; i++) {
    world.refuse = Object.assign(new Error('hub halted'), { status: 503 });
    t += 60000;
    assert.strictEqual((await real.act({ action: 'condense', agent: 'doc' })).ok, false);
  }
  assert.deepStrictEqual(copies(), before, 'refused presses leave the earlier copies exactly as they were');
  world.refuse = null; t += 60000;
  const ok = await real.act({ action: 'condense', agent: 'doc' });
  assert.strictEqual(ok.ok, true);
  const after = copies();
  assert.deepStrictEqual(after, [...before.slice(1), after[2]], 'the oldest went, and the newest is this press\'s copy');
  assert.match(ok.message, new RegExp(after[2].replace(/\./g, '\\.')));
});

test('two tidies at once: each press gets its own outcome, and every outcome is on the check after it', async () => {
  const world = { agents: ['alpha', 'beta'], archives: { alpha: { entries: 10, fileBytes: 1, recent: 0 }, beta: { entries: 10, fileBytes: 1, recent: 0 } } };
  const steps = { alpha: 0, beta: 0 };
  world.tidyResult = {};
  const { mh } = make(world);
  // alpha: its second step fails; beta: done at its second step
  Object.defineProperty(world.tidyResult, 'alpha', { get: () => { if (++steps.alpha === 2) throw new Error('disk I/O error'); return { done: false }; } });
  Object.defineProperty(world.tidyResult, 'beta', { get: () => ({ done: ++steps.beta >= 2 }) });
  const tick = () => new Promise(r => setImmediate(r));
  let release; world.pauseGate = new Promise(r => { release = r; });
  const pa = mh.act({ action: 'tidy-index', agent: 'alpha' });
  for (let i = 0; i < 10; i++) await tick();   // alpha has failed; the check after it waits
  const pb = mh.act({ action: 'tidy-index', agent: 'beta' });
  for (let i = 0; i < 10; i++) await tick();   // beta is done; its check waits behind alpha's
  world.pauseGate = null; release();
  const [ra, rb] = await Promise.all([pa, pb]);
  assert.deepStrictEqual(ra, { ok: false, error: 'Couldn\'t finish tidying Alpha\'s search index: disk I/O error.' });
  assert.deepStrictEqual([rb.ok, rb.message], [true, 'Tidied Beta\'s search index (2 steps).']);
  const notes = mh.stored().tidies.map(x => [x.agent, x.ok]);
  assert.deepStrictEqual(notes, [['alpha', false], ['beta', true]]);
  assert.ok(mh.stored().epoch && mh.stored().epoch === rb.result.epoch, 'one epoch per process');
  const other = (await make({ agents: [] }).mh.run()).epoch;
  assert.ok(other && other !== rb.result.epoch, 'another instance (a restart): another epoch');
});

test('a tidy\'s outcome is there to follow even when the check after it fails', async () => {
  const world = { agents: ['watchman'], archives: { watchman: { entries: 10, fileBytes: 1, recent: 0 } }, tidyDoneAt: 2 };
  const { mh } = make(world);
  await mh.run();
  let calls = 0; world.listFail = () => ++calls > 1;   // the press itself lists the agents; the check after the tidy can't
  const r = await mh.act({ action: 'tidy-index', agent: 'watchman' });
  assert.deepStrictEqual([r.ok, r.message, r.result], [true, 'Tidied Watchman\'s search index (2 steps).', null]);
  assert.deepStrictEqual(mh.stored().tidies.map(x => [x.agent, x.ok, x.message]), [['watchman', true, 'Tidied Watchman\'s search index (2 steps).']]);
});
