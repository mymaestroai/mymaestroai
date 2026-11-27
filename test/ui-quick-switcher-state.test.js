'use strict';
// The quick switcher and the sidebar say an agent's state in the SAME words (one function, agentStateWords), the short
// name shows only when it was what matched, agents waiting for the owner's answer sort first, and the waiting dot pulses
// as the sidebar's does. Same extraction approach as ui-quick-switcher.test.js (real functions out of app.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const AgentDot = require('../lib/ui-agent-dot');
const fn = (name) => {
  const m = app.match(new RegExp(`\\n    (?:async )?function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n    \\}\\n`));
  assert.ok(m, `app.js has function ${name}`);
  return m[0];
};

// The sidebar's own builders (agentStateWords, agentBusyWords, agentLiveState) on stand-ins for its data.
function sidebar({ status = {}, doing = {}, busy = new Set(), bg = {} } = {}) {
  const c = {
    AgentDot, agentStatus: status, localBusy: new Map([...busy].map(n => [n, 1])), statusKnown: true, isHubAdmin: () => true,
    busyRun: {}, chatViewActivityWord: (a) => a || '', elapsedLabel: () => '', bgCountOf: (n) => bg[n] || 0,
    agentDoingNow: (n) => doing[n] || { words: '', detail: '' },
  };
  vm.runInNewContext(['agentStateWords', 'agentBusyWords', 'agentLiveState'].map(fn).join('')
    + '\nthis.live = agentLiveState; this.words = agentStateWords; this.busyWords = agentBusyWords;', c);
  return c;
}

test('state words: one function, the sidebar\'s own case', () => {
  const c = sidebar();
  assert.strictEqual(c.words('question'), 'waiting for your answer');
  assert.strictEqual(c.words('busy', { words: 'Replying to your message' }), 'Replying to your message', 'the turn\'s words, untouched (no capital added)');
  assert.strictEqual(c.words('busy', { words: 'working' }), 'working');
  assert.strictEqual(c.words('background', { background: 2 }), 'Free · 2 in background');
  assert.strictEqual(c.words('free'), '');
  assert.strictEqual(c.words('background', { background: 2 }), AgentDot.bgLine(2));
});

test('the sidebar line carries exactly those words (what it shows today is unchanged)', () => {
  const c = sidebar({
    status: { forge: { pendingQuestion: true, busy: true }, wk: { busy: true, worker: true, activity: 'working' }, scout: { busy: true } },
    doing: { scout: { words: 'Replying to your message', detail: '' } },
  });
  assert.strictEqual(c.live('forge').line, '❓ waiting for your answer');
  assert.strictEqual(c.live('wk').line, '⏳ working');
  assert.strictEqual(c.live('scout').line, '⏳ Replying to your message');
  assert.strictEqual(c.live('forge').tip, 'Waiting for your answer · working', 'the tooltip keeps its own wording');
  // the switcher's row words are the same strings, taken from the line
  assert.strictEqual(c.busyWords('scout', 'working'), 'Replying to your message');
  assert.strictEqual(c.busyWords('wk', 'working'), 'working');
});

test('source: the sidebar and the switcher both read agentStateWords; neither spells the words itself', () => {
  for (const name of ['agentLiveState', 'qsRowState', 'bgPaintRow']) assert.match(fn(name), /agentStateWords\(/, `${name} reads agentStateWords`);
  assert.doesNotMatch(fn('qsRowState'), /waiting for your answer|toUpperCase|bgLine/i, 'the switcher spells no state words and does not recase them');
  assert.doesNotMatch(fn('agentLiveState'), /`❓ waiting/, 'the sidebar line is not spelled out either');
  assert.strictEqual((app.match(/return 'waiting for your answer'/g) || []).length, 1, 'the lower-case words live in one place');
});

// ── the switcher rows, on the harness of ui-quick-switcher.test.js: its state words equal the sidebar's, row by row ──
test('the switcher\'s words, row by row, equal agentStateWords for the same state (same case)', () => {
  // the harness's page() lives in the other test file; here the rule is checked on the real qsRowState directly
  const live = {}, doing = {}, bg = {};
  const c = {
    AgentDot, agentStatus: {}, agentLiveState: (n) => ({ busy: false, question: false, activity: 'working', ...(live[n] || {}) }),
    bgCountOf: (n) => bg[n] || 0, agentDoingNow: (n) => doing[n] || { words: '', detail: '' },
  };
  vm.runInNewContext(['qsRowState', 'agentStateWords', 'agentBusyWords'].map(fn).join('') + '\nthis.row = qsRowState; this.words = agentStateWords;', c);
  live.q = { question: true, busy: true }; live.b = { busy: true }; live.w = { busy: true, activity: 'working' }; bg.g = 3;
  doing.b = { words: 'Replying to your message' };
  c.agentStatus.w = { worker: true };
  assert.strictEqual(c.row('q', false).words, c.words('question'));
  assert.strictEqual(c.row('b', false).words, 'Replying to your message');
  assert.strictEqual(c.row('w', false).words, 'working');
  assert.strictEqual(c.row('g', false).words, c.words('background', { background: 3 }));
  assert.strictEqual(c.row('g', true).words, 'New replies', 'unread keeps its own words (the sidebar has none)');
});

// ── the short name ──
test('the short name shows only when the typed text matched the id and not the display name', () => {
  const src = fn('renderQuickSwitcher');
  const m = src.match(/if \(typed && ([^\n]*)\) row\.appendChild\(span\('qs-id'/);   // the whole condition, evaluated below
  assert.ok(m, 'the qs-id condition is there');
  const cond = new Function('typed', 'shown', 'a', 'qsScore', `return !!(typed && ${m[1]});`);
  const qsScore = new Function(`${fn('qsScore')}\nreturn qsScore;`)();
  const show = (a, typed) => cond(typed, a.display || a.name, a, qsScore);
  const rsch = { name: 'rsch', display: 'Researcher' };
  assert.strictEqual(show(rsch, ''), false, 'no query: the display name alone');
  assert.strictEqual(show(rsch, 'rs'), true, 'matched the id only: the id shows');
  assert.strictEqual(show(rsch, 'resea'), false, 'matched the display name only');
  assert.strictEqual(show({ name: 'scout', display: 'Scout' }, 'sco'), false, 'matched both: the display name alone');
  assert.strictEqual(show({ name: 'scout', display: 'Scout Prime' }, 'sco'), false);
  assert.strictEqual(show({ name: 'rsch', display: 'Research' }, 'res'), false, 'the display name matches better than the id: the display name alone');
  assert.strictEqual(show({ name: 'rsch', display: 'Research' }, 'rs'), true, 'the id starts with it, the display name only has the letters in order: the id matched better');
});

// ── waiting first ──
test('agents waiting for the owner\'s answer sort first, then the existing order', () => {
  const qsScore = fn('qsScore'), qsRank = fn('qsRank');
  const c = {};
  vm.runInNewContext(qsScore + qsRank + '\nthis.rank = qsRank;', c);
  const agents = ['alpha', 'beta', 'gamma', 'delta'].map(n => ({ name: n, display: n[0].toUpperCase() + n.slice(1) }));
  const names = (l) => l.map(a => a.name);
  assert.deepStrictEqual(names(c.rank(agents, '')), ['alpha', 'beta', 'delta', 'gamma'], 'control: by name');
  assert.deepStrictEqual(names(c.rank(agents, '', { waiting: new Set(['gamma']) })), ['gamma', 'alpha', 'beta', 'delta']);
  assert.deepStrictEqual(names(c.rank(agents, '', { waiting: new Set(['gamma', 'beta']) })), ['beta', 'gamma', 'alpha', 'delta'], 'among the waiting: the existing order');
  assert.deepStrictEqual(names(c.rank(agents, '', { waiting: new Set(['gamma']), unread: new Set(['delta']), recent: ['beta'] })), ['gamma', 'delta', 'beta', 'alpha'], 'waiting, then unread, then recent, then name');
  assert.deepStrictEqual(names(c.rank(agents, 'a', { waiting: new Set(['delta']) }))[0], 'delta', 'with a query too (it matched)');
  assert.deepStrictEqual(names(c.rank(agents, 'zzz', { waiting: new Set(['delta']) })), [], 'a waiting agent that does not match stays out');
  assert.deepStrictEqual(c.rank(agents, '', { waiting: new Set(['nobody']) }).length, 4);
});

test('the switcher asks the sidebar\'s own state who is waiting', () => {
  assert.match(fn('renderQuickSwitcher'), /agentLiveState\(a\.name\)\.question[\s\S]*qsRank\(roster, q\.value, \{[^}]*waiting/);
});

// ── the dot ──
test('the waiting dot: same class as the sidebar\'s, same pulse animation, and no motion rule the sidebar lacks', () => {
  const side = index.match(/\.agent-btn \.agent-status\.live-question \{[^}]*\}/);
  assert.ok(side, 'the sidebar rule exists');
  const sideAnim = (side[0].match(/animation:\s*([^;]+);/) || [])[1];
  assert.strictEqual(sideAnim, 'pulse 1.6s infinite', 'the sidebar\'s waiting dot pulses');
  const qs = index.match(/\.qs-dot\.live-question \{[^}]*\}/);
  assert.ok(qs, 'the switcher\'s rule exists');
  assert.strictEqual((qs[0].match(/animation:\s*([^;]+);/) || [])[1], sideAnim, 'the same animation');
  // the sidebar has no prefers-reduced-motion rule for its dot, so the switcher adds none (identical behaviour)
  assert.doesNotMatch(index, /prefers-reduced-motion[^{]*\{[^}]*(live-question|qs-dot)/);
  // the class: the row's dot is written with live-question (the sidebar's class name)
  assert.match(fn('qsRowState'), /mark = 'live-question'/);
  assert.match(fn('qsWriteState'), /dot\.className = 'qs-dot ' \+ st\.mark/);
});
