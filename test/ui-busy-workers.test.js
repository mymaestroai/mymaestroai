'use strict';
// The busy chip and the hub-wide worker groups (lib/ui-busy-workers.js), shared by the desktop and phone pages: who counts
// as busy, agent vs worker, the chip's words, grouping of hub workers under their caller, and the short clock.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const L = require('../lib/ui-busy-workers');

const ROOT = path.join(__dirname, '..');
const BEGIN = '// ── busy and hub workers helpers (begin) ──';
const END = '// ── busy and hub workers helpers (end) ──';
function helperBlock(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

for (const [file, indent] of [['app.js', '    '], ['mobile.js', '']]) {
  test(`the busy helpers in ${file} are byte-identical to lib/ui-busy-workers.js`, (t) => {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (!src.includes(BEGIN)) return t.skip(`${file} has no marker yet`);
    const lib = helperBlock(fs.readFileSync(path.join(ROOT, 'lib/ui-busy-workers.js'), 'utf8'), '');
    assert.strictEqual(helperBlock(src, indent), lib, `${file} copy differs`);
  });
}

test('the helper block is plain browser JavaScript', () => {
  const block = helperBlock(fs.readFileSync(path.join(ROOT, 'lib/ui-busy-workers.js'), 'utf8'), '');
  assert.ok(!/\b(require|module|process|Buffer)\b/.test(block));
});

const idle = { busy: false, busySince: null, activity: null, pendingQuestion: null };
const busy = (extra = {}) => ({ busy: true, busySince: '2026-01-01T00:00:00.000Z', activity: 'x', pendingQuestion: null, ...extra });

test('one named agent plus six tw workers -> "1 agent · 6 workers working"', () => {
  const m = { lead: busy(), helper: idle };
  for (let i = 1; i <= 6; i++) m[`tw-lead-${i}-ab12`] = busy({ worker: true, parent: 'lead' });
  const s = L.busySplit(m, []);
  assert.deepStrictEqual(s.agents, ['lead']);
  assert.strictEqual(s.workers.length, 6);
  assert.strictEqual(L.busyChipLabel(s, false), '1 agent · 6 workers working');
});

test('worker detection: flag, tw- prefix, worker:false named', () => {
  const m = {
    'tw-lead-1-ab12': busy(),
    'casework-a': busy({ worker: true }),
    'tw-odd': busy({ worker: false }),
    lead: busy(),
  };
  const s = L.busySplit(m, []);
  assert.deepStrictEqual(s.workers, ['casework-a', 'tw-lead-1-ab12']);
  assert.deepStrictEqual(s.agents, ['lead', 'tw-odd']);
});

test('pendingQuestion counts; idle does not', () => {
  const m = { lead: { ...idle, pendingQuestion: 'ok?' }, helper: idle, 'tw-lead-2-cd34': { ...idle, pendingQuestion: { q: 1 } } };
  assert.deepStrictEqual(L.busySplit(m, []), { agents: ['lead'], workers: ['tw-lead-2-cd34'] });
});

test('local busy names always count; no entry -> agent unless tw-; deduped and sorted', () => {
  const m = { lead: busy(), helper: idle };
  const s = L.busySplit(m, ['lead', 'helper', 'casework-a', 'tw-lead-3-ef56', 'tw-lead-3-ef56']);
  assert.deepStrictEqual(s, { agents: ['casework-a', 'helper', 'lead'], workers: ['tw-lead-3-ef56'] });
  assert.deepStrictEqual(L.busySplit(undefined, undefined), { agents: [], workers: [] });
});

test('chip label words, plurals and the filtering suffix', () => {
  const sp = (a, w) => ({ agents: Array(a).fill('a'), workers: Array(w).fill('w') });
  assert.strictEqual(L.busyChipLabel(sp(0, 0), true), '');
  assert.strictEqual(L.busyChipLabel(sp(2, 0), false), '2 agents working');
  assert.strictEqual(L.busyChipLabel(sp(0, 3), false), '3 workers working');
  assert.strictEqual(L.busyChipLabel(sp(0, 1), false), '1 worker working');
  assert.strictEqual(L.busyChipLabel(sp(1, 0), true), '1 agent working · showing only these ✕');
  assert.strictEqual(L.busyChipLabel(sp(1, 2), true), '1 agent · 2 workers working · showing only these ✕');
  assert.strictEqual(L.busyChipLabel(sp(0, 3), true), '3 workers working');
});

const NOW = Date.parse('2026-01-01T01:00:00.000Z');
const known = { lead: 'Lead', helper: 'Helper', 'casework-a': 'Casework A' };

test('groups by parent, labels from known, null parent last as "Unknown agent"', () => {
  const m = {
    'tw-lead-1-ab12': busy({ worker: true, parent: 'lead', label: 'Check files', model: 'm1' }),
    'tw-helper-1-cd34': busy({ parent: 'helper' }),
    'tw-orphan-1-ef56': busy({ worker: true, parent: null, label: 'Lost' }),
    'tw-zed-1-aa11': busy({ parent: 'zed' }),
  };
  const g = L.hubWorkerGroups(m, { known, now: NOW });
  assert.deepStrictEqual(g.map(x => [x.parent, x.parentLabel]), [['helper', 'Helper'], ['lead', 'Lead'], ['zed', 'zed'], [null, 'Unknown agent']]);
  const lead = g.find(x => x.parent === 'lead').items[0];
  assert.deepStrictEqual(lead, { id: 'tw-lead-1-ab12', kind: 'temporary', label: 'Check files', model: 'm1', startedAt: Date.parse('2026-01-01T00:00:00.000Z'), elapsedMs: 3600000 });
  const h = g.find(x => x.parent === 'helper').items[0];
  assert.deepStrictEqual([h.label, h.model], ['Worker', '']);
  assert.strictEqual(L.hubWorkerCount(g), 4);
});

test('consulted named agents group under the caller', () => {
  const m = {
    'casework-a': busy({ consultedBy: 'lead', model: 'm2' }),
    helper: busy({ consultedBy: 'lead' }),
    other: busy({ consultedBy: 'lead' }),
    quiet: busy({ consultedBy: '' }),
    lead: busy(),
  };
  const g = L.hubWorkerGroups(m, { known, now: NOW });
  assert.strictEqual(g.length, 1);
  assert.strictEqual(g[0].parentLabel, 'Lead');
  assert.deepStrictEqual(g[0].items.map(i => [i.id, i.kind, i.label]), [['casework-a', 'consulted', 'Casework A'], ['helper', 'consulted', 'Helper'], ['other', 'consulted', 'other']]);
  assert.strictEqual(g[0].items[0].model, 'm2');
});

test('skipIds and skipKeys leave out what the page already shows', () => {
  const m = {
    'tw-lead-1-ab12': busy({ parent: 'lead' }),
    'tw-lead-2-cd34': busy({ parent: 'lead' }),
    'casework-a': busy({ consultedBy: 'lead' }),
    helper: busy({ consultedBy: 'lead' }),
  };
  const g = L.hubWorkerGroups(m, { known, now: NOW, skipIds: ['tw-lead-1-ab12'], skipKeys: ['lead>casework-a', 'other>helper'] });
  assert.deepStrictEqual(g[0].items.map(i => i.id).sort(), ['helper', 'tw-lead-2-cd34']);
  const none = L.hubWorkerGroups(m, { known, now: NOW, skipIds: ['tw-lead-1-ab12', 'tw-lead-2-cd34', 'helper'], skipKeys: ['lead>casework-a'] });
  assert.deepStrictEqual(none, []);
});

test('idle entries are excluded; nothing matches -> []', () => {
  const m = { 'tw-lead-1-ab12': { ...idle, parent: 'lead' }, helper: { ...idle, consultedBy: 'lead' }, lead: busy() };
  assert.deepStrictEqual(L.hubWorkerGroups(m, { now: NOW }), []);
  assert.deepStrictEqual(L.hubWorkerGroups({}, { now: NOW }), []);
  assert.strictEqual(L.hubWorkerCount([]), 0);
});

test('elapsed time and ordering: oldest first, no start last, then id', () => {
  const at = (iso) => ({ busySince: iso });
  const m = {
    'tw-lead-3-cc': busy({ parent: 'lead', ...at('2026-01-01T00:30:00.000Z') }),
    'tw-lead-1-aa': busy({ parent: 'lead', ...at('2026-01-01T00:10:00.000Z') }),
    'tw-lead-9-zz': busy({ parent: 'lead', busySince: null }),
    'tw-lead-8-yy': busy({ parent: 'lead', busySince: null }),
    'tw-lead-2-bb': busy({ parent: 'lead', ...at('2026-01-01T00:30:00.000Z') }),
    'tw-lead-4-dd': busy({ parent: 'lead', ...at('2026-01-01T02:00:00.000Z') }),
  };
  const items = L.hubWorkerGroups(m, { now: NOW })[0].items;
  assert.deepStrictEqual(items.map(i => i.id), ['tw-lead-1-aa', 'tw-lead-2-bb', 'tw-lead-3-cc', 'tw-lead-4-dd', 'tw-lead-8-yy', 'tw-lead-9-zz']);
  assert.strictEqual(items[0].elapsedMs, 50 * 60000);
  assert.strictEqual(items[3].elapsedMs, 0);
  assert.strictEqual(items[4].elapsedMs, null);
  assert.strictEqual(items[4].startedAt, null);
});

test('fmtElapsedShort', () => {
  assert.deepStrictEqual([null, undefined, -1, NaN].map(L.fmtElapsedShort), ['', '', '', '']);
  assert.deepStrictEqual([0, 5000, 102000, 3599000, 3725000].map(L.fmtElapsedShort), ['0:00', '0:05', '1:42', '59:59', '1:02:05']);
});
