'use strict';
// Phone: the background-work ring, the blue line, the blue chip, the `background` event, the Stop calls of the "Working on" panel.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const AgentDot = require('../lib/ui-agent-dot.js');

function fnSource(name) {
  const m = new RegExp('(?:async )?function ' + name + '\\(').exec(js);
  assert.ok(m, name);
  let depth = 0; let j = js.indexOf('{', js.indexOf(')', m.index));
  const i = m.index;
  for (; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}') { depth--; if (!depth) break; } }
  return js.slice(i, j + 1);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el() {
  const classes = new Set(); const attrs = {};
  return {
    dataset: {}, textContent: '', className: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    setAttribute: (k, v) => { attrs[k] = v; }, attrs, classes,
  };
}

function setup(extra = {}) {
  const calls = { open: [], onBackground: [], navigate: [], paint: 0, toasts: [], fetches: [] };
  const chip = el();
  const hoc = { open: (a) => calls.open.push(a), onBackground: (a) => calls.onBackground.push(a) };
  const ctx = {
    AgentDot, esc, calls, chip,
    live: {}, streams: new Map(), statusKnown: true, unread: {},
    agents: [{ name: 'hazel', display: 'Hazel', icon: 'H' }, { name: 'forge', display: 'Forge' }, { name: 'maestro', display: 'Maestro' }],
    displayName: (n) => ({ hazel: 'Hazel', forge: 'Forge', maestro: 'Maestro' }[n] || n),
    isBusy: (n) => !!(ctx.live[n] && (ctx.live[n].busy || ctx.live[n].pendingQuestion)),
    busyText: () => '⏳ replying', shortModel: (m) => m || '', activeJobTitle: () => '', activeJobLead: () => '', activeJobTail: () => '',
    $: (id) => (id === 'bg-chip' ? chip : null),
    HandOffCard: hoc, window: { HandOffCard: hoc },
    navigate: (s, a) => calls.navigate.push([s, a]),
    paintStatus: () => { calls.paint++; },
    toast: (t) => calls.toasts.push(t),
    api: async (url, opts) => { calls.fetches.push([url, opts]); return { ok: true, json: async () => ({ success: true, ok: true }) }; },
    JSON, Number, Math, Object, Set, Map,
    ...extra,
  };
  ctx.setLive = (name, patch) => { ctx.live[name] = { ...(ctx.live[name] || { busy: false }), ...patch }; };
  vm.createContext(ctx);
  return ctx;
}
const load = (ctx, ...names) => vm.runInContext(names.map(fnSource).join('\n'), ctx);

test('applySnapshot copies the background count (poll and snapshot), and the event keeps it, repaints and tells the panel', () => {
  const src = fnSource('applySnapshot');
  assert.match(src, /patch\.background = /);
  const ctx = setup({ wkSeen: new Map(), wkGoneState: {}, openTurns: {}, turnSteps: {}, busyIsWorker: () => false, workerGoneStep: () => ({ next: {}, gone: [] }), wkInferEnd() {}, repaintAgentStatus() {}, reattachIfIdle() {}, followedHubTurn: () => false, current: null, paintStatusX: 0 });
  load(ctx, 'bgCountOf', 'onBackgroundEvent', 'applySnapshot');
  vm.runInContext('this.snap = (m, o) => applySnapshot(m, false, o);', ctx);
  ctx.snap({ hazel: { busy: false, background: 2 }, forge: { busy: false } });
  assert.strictEqual(vm.runInContext("bgCountOf('hazel')", ctx), 2);
  assert.strictEqual(vm.runInContext("bgCountOf('forge')", ctx), 0);
  ctx.snap({ hazel: { busy: false } });   // the hub leaves the key out at 0
  assert.strictEqual(vm.runInContext("bgCountOf('hazel')", ctx), 0);
  ctx.snap({ hazel: { busy: false, background: 3 } });
  ctx.snap({ hazel: { busy: false } }, { namedOnly: true });   // the plain agent list has no counts: it does not clear them
  assert.strictEqual(vm.runInContext("bgCountOf('hazel')", ctx), 3);
  vm.runInContext("onBackgroundEvent({ agent: 'forge', count: 1 })", ctx);
  assert.strictEqual(vm.runInContext("bgCountOf('forge')", ctx), 1);
  assert.strictEqual(ctx.calls.paint, 1, 'repainted');
  assert.deepStrictEqual(ctx.calls.onBackground, ['forge']);
  vm.runInContext("onBackgroundEvent({ agent: 'forge', count: 0 })", ctx);
  assert.strictEqual(vm.runInContext("bgCountOf('forge')", ctx), 0);
  assert.match(js, /on\('background', onBackgroundEvent\)/, 'subscribed like the other hub events');
});

function row(ctx, a, opts) {
  load(ctx, 'bgCountOf', 'bgStateOf', 'agentRowHtml');
  return vm.runInContext('agentRowHtml', ctx)(a, opts);
}

test('a free row with background work gets the ring class, the label and the blue line', () => {
  const ctx = setup();
  ctx.live.hazel = { busy: false, background: 2 };
  const h = row(ctx, ctx.agents[0]);
  assert.match(h, /class="dot idle bg-work"/);
  assert.match(h, /title="Free to talk · 2 things running in the background"/);
  assert.match(h, /aria-label="Free to talk · 2 things running in the background"/);
  assert.match(h, /<div class="agent-bg-line"[^>]*>Free · 2 in background<\/div>/);
  assert.strictEqual(row(ctx, ctx.agents[0]).includes('class="agent-model"'), false);
});

test('busy or a question wins over background; background 0 shows no ring and no line', () => {
  const ctx = setup();
  ctx.live.hazel = { busy: true, background: 2 };
  let h = row(ctx, ctx.agents[0]);
  assert.ok(!/bg-work|agent-bg-line/.test(h));
  assert.match(h, /class="dot busy"/);
  ctx.live.hazel = { busy: true, pendingQuestion: true, background: 2 };
  h = row(ctx, ctx.agents[0]);
  assert.ok(!/bg-work|agent-bg-line/.test(h));
  assert.match(h, /class="dot question"/);
  ctx.live.hazel = { busy: false, background: 0 };
  h = row(ctx, ctx.agents[0]);
  assert.ok(!/bg-work|agent-bg-line/.test(h));
  assert.match(h, /class="dot idle"/);
  ctx.live.hazel = { busy: false, background: 1 };
  assert.match(row(ctx, ctx.agents[0]), /Free · 1 in background/);
  ctx.live.hazel = { busy: false, background: 4 };   // a finished Active-section row keeps its tick and no ring
  assert.ok(!/bg-work/.test(row(ctx, ctx.agents[0], { done: true, active: true })));
});

test('the blue chip names agents with background work that are not busy, and is hidden when none', () => {
  const ctx = setup();
  load(ctx, 'bgCountOf', 'renderBgChip');
  const run = () => vm.runInContext('renderBgChip()', ctx);
  run();
  assert.strictEqual(ctx.chip.textContent, '');
  assert.ok(!ctx.chip.classes.has('on'));
  ctx.live.hazel = { busy: false, background: 2 };
  ctx.live.forge = { busy: false, background: 1 };
  ctx.live.maestro = { busy: true, background: 3 };   // busy: left out
  run();
  assert.strictEqual(ctx.chip.textContent, 'Hazel, Forge: background work');
  assert.ok(ctx.chip.classes.has('on'));
  assert.strictEqual(ctx.chip.dataset.agent, 'hazel');
  ctx.live.hazel.background = 0; ctx.live.forge.background = 0;
  run();
  assert.strictEqual(ctx.chip.textContent, '');
  assert.ok(!ctx.chip.classes.has('on'));
  assert.match(html, /#bg-chip\.on \{ display: block; \}/);
  assert.match(html, /html\.mm-simple #working-chip, html\.mm-simple #bg-chip/, 'hidden in Simple like the working chip');
  assert.match(html, /<script src="\/ui-agent-dot\.js"><\/script>\s*<script src="\/ui-hand-off-card\.js"><\/script>/);
});

test('tapping the ring, the blue line or the chip opens the chat and never asks the panel to expand', () => {
  const ctx = setup();
  load(ctx, 'bgOpenChat');
  vm.runInContext("bgOpenChat('hazel')", ctx);
  assert.deepStrictEqual(ctx.calls.open, [], 'the panel is not asked to open: the next chat starts collapsed');
  assert.deepStrictEqual(ctx.calls.navigate, [['chat', 'hazel']]);
  assert.match(js, /e\.target\.closest\('\.dot\.bg-work, \.agent-bg-line'\)\) \{ bgOpenChat\(r\.dataset\.agent\)/);
  assert.match(js, /\$\('bg-chip'\)\?\.addEventListener\('click', \(\) => bgOpenChat\(\$\('bg-chip'\)\.dataset\.agent\)\)/);
});

test('Simple dots: ring for a free agent with background work, busy wins, none without', () => {
  const ctx = setup();
  load(ctx, 'bgCountOf', 'simpleDotClass', 'simpleDotPaint', 'simpleMoreDotPaint');
  const paint = (name) => { const d = el(); vm.runInContext('simpleDotPaint', ctx)(d, name); return d; };
  ctx.live.hazel = { busy: false, background: 2 };
  let d = paint('hazel');
  assert.ok(d.classes.has('bg-work')); assert.strictEqual(d.className, 'sa-dot ');
  ctx.live.hazel = { busy: true, background: 2 };
  d = paint('hazel');
  assert.ok(!d.classes.has('bg-work')); assert.strictEqual(d.className, 'sa-dot busy');
  ctx.live.hazel = { busy: false, background: 0 };
  assert.ok(!paint('hazel').classes.has('bg-work'));
  const more = el();
  vm.runInContext('simpleMoreDotPaint', ctx)(more, { hiddenBusy: false, hiddenBg: 3 });
  assert.ok(more.classes.has('bg-work'));
  const more2 = el();
  vm.runInContext('simpleMoreDotPaint', ctx)(more2, { hiddenBusy: true, hiddenBg: 3 });
  assert.ok(!more2.classes.has('bg-work')); assert.strictEqual(more2.className, 'sa-dot busy');
  assert.match(html, /html\.mm-simple \.sa-dot\.bg-work:not\(\.busy\):not\(\.question\)/);
  assert.match(html, /\.dot\.bg-work:not\(\.busy\):not\(\.question\) \{[^}]*border: 2px solid var\(--bg-work-ring\)[^}]*background: transparent/);
  assert.match(html, /--bg-work-ring: #3987e5;/, 'the ring colour, defined once in :root');
});

test('the Simple agent model counts the hidden agents\' background work, not that of a replying one', () => {
  const ctx = setup({ window: { hubSimple: { agentGroups: (list) => ({ primary: [list[0]], more: [{ key: 'm', items: list.slice(1) }] }) } } });
  load(ctx, 'simpleAgentSheetModel');
  const m = vm.runInContext('simpleAgentSheetModel', ctx)(ctx.agents, 'hazel', false, (n) => n === 'maestro', (n) => ({ forge: 2, maestro: 5 }[n] || 0));
  assert.strictEqual(m.hiddenBg, 2);
});

test('track gets isAdmin, stopJob and stopWorker; stopJob posts /api/jobs/cancel and stopWorker /api/cancel-worker', async () => {
  assert.match(js, /HandOffCard\.track\(\{[^}]*isAdmin: \(\) => isAdmin\(\),\s*stopJob: \(id\) => handOffStopJob\(id\),\s*stopWorker: \(id, agent\) => handOffStopWorker\(id, agent\)/);
  const ctx = setup();
  load(ctx, 'handOffStopJob', 'handOffStopWorker');
  await vm.runInContext("handOffStopJob('ab12cd34')", ctx);
  await vm.runInContext("handOffStopWorker('tw-hazel-1-x', 'hazel')", ctx);
  const [job, worker] = ctx.calls.fetches;
  assert.strictEqual(job[0], '/api/jobs/cancel');
  assert.strictEqual(job[1].method, 'POST');
  assert.deepStrictEqual(JSON.parse(job[1].body), { id: 'ab12cd34' });
  assert.strictEqual(worker[0], '/api/cancel-worker');
  assert.strictEqual(worker[1].method, 'POST');
  assert.deepStrictEqual(JSON.parse(worker[1].body), { worker_id: 'tw-hazel-1-x', agent: 'hazel' });
});

test('the phone service worker is v79 and the panel has its CSS', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8'), /const VERSION = 'hub-mobile-v104'/);
  for (const c of ['.wo-ring', '.wo-row', '.wo-kind', '.wo-title', '.wo-sub', '.wo-quiet', '.wo-stop']) assert.ok(html.includes(c), c);
  assert.match(html, /\.wo-quiet \{[^}]*dashed/);
});

test('r2 phone wiring: openChat calls HandOffCard.follow() right after current changes', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const src = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  // The same line may also take down the voice hint (voiceHintSync); the panel follows on the next line.
  assert.match(src, /current = name;[^\n]*\n\s*try \{ if \(window\.HandOffCard && typeof HandOffCard\.follow === 'function'\) HandOffCard\.follow\(\)/);
});
