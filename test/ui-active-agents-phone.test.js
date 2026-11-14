'use strict';
// The Active section on the phone page: row markup, section, hold, animation, menu switch.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js');
const html = read('mobile.html');
const slice = (a, b) => { const i = js.indexOf(a), j = js.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a + ' .. ' + b); return js.slice(i, j); };
const ROW = () => slice('function agentRowHtml(', '// The Active section at the top');
const RENDER = () => slice('function renderAgents() {', 'function updateDots()');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The row markup as the old inline loop in renderAgents built it (copied from the code it replaced).
function oldRow(a, env) {
  const { unread, live, isBusy, statusKnown, busyText, shortModel } = env;
  const n = unread[a.name] || 0;
  const s = live[a.name];
  const question = !!(s && s.pendingQuestion);
  const working = isBusy(a.name);
  const dotCls = question ? ' question' : working ? ' busy' : statusKnown ? ' idle' : '';
  const sub = working
    ? `<div class="agent-model working${question ? ' question' : ''}">${esc(busyText(a.name))}</div>`
    : `<div class="agent-model" title="${esc(a.blurb || '')}">${esc(a.blurb || shortModel(a.model))}</div>`;
  return `<button class="agent-row${working ? ' is-busy' : ''}" data-agent="${esc(a.name)}">` +
    `<span class="agent-icon">${esc(a.icon || '🤖')}</span>` +
    `<span class="agent-meta"><div class="agent-name">${esc(a.display || a.name)}${a.lead ? ' <span class="lead-badge" title="Lead agent">👑</span>' : ''}</div>${sub}</span>` +
    `<span class="dot${dotCls}" title="${esc(working ? busyText(a.name) : '')}">${question ? '?' : ''}</span>` +
    (n ? `<span class="badge">${n > 99 ? '99+' : n}</span>` : '') +
    '</button>';
}

function rowEnv(over) {
  const env = {
    unread: { carol: 120, dave: 3 }, live: { bob: { busy: true }, erin: { busy: true, pendingQuestion: true } },
    isBusy: (n) => n === 'bob' || n === 'erin', statusKnown: true, busyText: (n) => n + ' is working', shortModel: (m) => 'm:' + m, esc,
  };
  Object.assign(env, over || {});
  const names = Object.keys(env);
  const agentRowHtml = new Function(...names, ROW() + '\nreturn agentRowHtml;')(...names.map((n) => env[n]));
  return { env, agentRowHtml };
}

const AGENTS = {
  busy: { name: 'bob', display: 'Bob', icon: '🛠', model: 'x' },
  idle: { name: 'alice', display: 'Alice', blurb: 'Does <things>', model: 'y' },
  lead: { name: 'lee', lead: true, model: 'z' },
  unread: { name: 'carol', icon: '📬', model: 'q' },
  unread3: { name: 'dave', model: 'q' },
  question: { name: 'erin', model: 'q' },
};

test('agentRowHtml(a) is byte-for-byte the old inline markup', () => {
  const { env, agentRowHtml } = rowEnv();
  for (const [k, a] of Object.entries(AGENTS)) assert.strictEqual(agentRowHtml(a), oldRow(a, env), k);
  assert.strictEqual(agentRowHtml(AGENTS.busy, undefined), oldRow(AGENTS.busy, env));
  assert.match(agentRowHtml(AGENTS.unread), /<span class="badge">99\+<\/span>/);
  assert.match(agentRowHtml(AGENTS.lead), /lead-badge/);
});

test('agentRowHtml(a) with statusKnown false also matches', () => {
  const { env, agentRowHtml } = rowEnv({ statusKnown: false });
  for (const a of Object.values(AGENTS)) assert.strictEqual(agentRowHtml(a), oldRow(a, env));
});

test('done rows carry active-done, "✓ done", no is-busy and an idle dot', () => {
  const { agentRowHtml } = rowEnv();
  const r = agentRowHtml(AGENTS.busy, { done: true });
  assert.ok(r.includes('class="agent-row active-done"'), r);
  assert.ok(r.includes('<div class="agent-model working">✓ done</div>'));
  assert.ok(!r.includes('is-busy'));
  assert.ok(r.includes('class="dot idle"'));
  assert.ok(!agentRowHtml(AGENTS.busy, { done: false }).includes('active-done'));
});

test('the old inline row code is gone from the loop; it calls agentRowHtml', () => {
  const body = RENDER();
  assert.ok(body.includes('html += agentRowHtml(a);'));
  assert.ok(!body.includes('class="agent-row'));
});

test('renderAgents steps the section with live, streams, agents, held and enabled', () => {
  const body = RENDER();
  const now = slice('function activeBusyNow()', '// The finger left');
  assert.match(now, /activeBusyFrom\(live, new Map\(\[\.\.\.streams\.keys\(\)\]\.map\(n => \[n, null\]\)\), agents\.map\(a => a\.name\)\)/);
  // changed: the step also passes jobs (the agents' running background jobs); everything else it checks is the same
  assert.match(body, /activeStep\(activeState, \{ busy: activeBusyNow\(\), jobs: activeJobs, now: Date\.now\(\), held: activeHeld, enabled: activeTopOn\(\) \}\)/);
  assert.ok(body.indexOf('No agents found.') < body.indexOf('activeBusyNow('), 'after the empty-list return');
  assert.ok(body.indexOf('activeBusyNow(') < body.indexOf('const known'), 'before the groups loop');
});

// Runs renderAgents against stubs and returns what it wrote.
function renderEnv(over) {
  const o = over || {};
  const list = { innerHTML: '', querySelector: () => null, addEventListener() {} };
  const env = {
    $: (id) => (id === 'agents-list' ? list : null), renderWorkingChip() {}, agents: o.agents || [], GROUPS: [{ key: 'worker', title: 'Workers' }],
    esc, collapsed: o.collapsed || {}, workingFilter: !!o.workingFilter, isBusy: (n) => !!(o.busy || []).includes(n),
    live: o.live || {}, streams: new Map(), unread: {}, statusKnown: true, busyText: () => 'busy', shortModel: (m) => m,
    activeInitial: () => ({ rows: [] }), activeBusyFrom: (l, s, v) => { env.calls.push(['busyFrom', l, s, v]); return {}; },
    activeStep: (st, inp) => { env.calls.push(['step', inp]); return o.state || { rows: [] }; }, activeTitle: (s) => 'Active ' + s.rows.length,
    activeTopOn: () => true, screen: 'agents', matchMedia: () => ({ matches: false }), setInterval: () => 1, clearInterval() {},
    activeHeld: false, activeMissed: false, activeLastH: 0, activeLastCount: 0, activeTicker: null, calls: [], localStorage: {},
    // changed: renderAgents and agentRowHtml now also read the jobs helpers and state (stubbed: no jobs)
    activeJobsFrom: () => ({}), activeJobLabel: () => '', activeJobTitle: () => '', activeJobsSync() {}, activeJobsNow: () => ({}),
    activeJobsRelabel() {}, activeJobs: {}, activeJobsTick: null,
  };
  const names = Object.keys(env).filter((n) => n !== 'calls');
  const src = ROW() + '\nlet activeState = activeInitial();\nfunction activeWireHold() {}\n' + slice('function activeBusyNow()', '// The finger left') + RENDER();
  const fn = new Function(...names, 'env', src + '\nreturn { renderAgents, setState(s) { activeState = s; } };')(...names.map((n) => env[n]), env);
  return { env, list, fn };
}

test('renderAgents: no rows -> no Active section; the empty text still shows under the working filter', () => {
  const agents = [{ name: 'a', model: 'm' }];
  const r = renderEnv({ agents });
  r.fn.renderAgents();
  assert.ok(!r.list.innerHTML.includes('active-sec'));
  assert.ok(r.list.innerHTML.includes('data-group="worker"'));
  const f = renderEnv({ agents, workingFilter: true, state: { rows: [{ name: 'a', since: 1, doneAt: null }] }, busy: [] });
  f.fn.renderAgents();
  assert.ok(f.list.innerHTML.includes('active-sec'));
  assert.ok(f.list.innerHTML.includes('No agent is working right now.'));
});

test('renderAgents: the section uses data-group="active", respects collapsed.active, marks done rows', () => {
  const agents = [{ name: 'a', model: 'm' }, { name: 'b', model: 'm' }];
  const state = { rows: [{ name: 'a', since: 1, doneAt: null }, { name: 'b', since: 2, doneAt: 5 }, { name: 'gone', since: 3, doneAt: null }] };
  const open = renderEnv({ agents, state, busy: ['a'] });
  open.fn.renderAgents();
  const h = open.list.innerHTML;
  assert.ok(h.startsWith('<div class="active-sec"><button class="group-title" data-group="active"><span>⚡ Active 2</span>'), 'the count is the rows drawn: ' + h.slice(0, 160));
  assert.ok(h.includes('&#x25BE;'));
  assert.ok(h.includes('active-done') && h.includes('✓ done'));
  assert.ok(h.indexOf('data-group="active"') < h.indexOf('data-group="worker"'));
  const step = open.env.calls.find((c) => c[0] === 'step')[1];
  assert.strictEqual(step.held, false);
  assert.strictEqual(step.enabled, true);
  const bf = open.env.calls.find((c) => c[0] === 'busyFrom');
  assert.deepStrictEqual(bf[3], ['a', 'b']);
  const closed = renderEnv({ agents, state, busy: ['a'], collapsed: { active: true } });
  closed.fn.renderAgents();
  const c = closed.list.innerHTML;
  assert.ok(c.includes('data-group="active"') && c.includes('&#x25B8;'));
  assert.ok(!c.slice(0, c.indexOf('data-group="worker"')).includes('data-agent='));
});

test('the Active rows have data-agent and the .agent-row class, so the existing click handler opens them', () => {
  assert.ok(ROW().includes('class="agent-row'));
  assert.ok(ROW().includes('data-agent="'));
});

test('the hold: touch listeners on agents-list, passive, 2000 ms', () => {
  const body = slice('function activeRelease()', 'function renderAgents()');
  for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) assert.ok(body.includes(`'${ev}'`), ev);
  assert.ok(body.includes('setTimeout(activeRelease, 2000)'));
  assert.ok((body.match(/\{ passive: true \}/g) || []).length === 4);
  assert.ok(/touchstart', \(\) => \{ if \(!activeTopOn\(\)\) return; activeHeld = true;/.test(body), 'off switch: no hold, no redraw');
  assert.ok(/'touchend', activeRelease/.test(body) && /'touchcancel', activeRelease/.test(body));
  const rel = slice('function activeRelease()', 'function activeWireHold(');
  assert.ok(/if \(!activeMissed && !activeMembersChanged\(activeState, next\)\) return;/.test(rel), 'no redraw unless rows join or leave or one was skipped');
  assert.ok(/if \(activeHeld && list && list\.firstChild\) \{ activeMissed = true; return; \}/.test(RENDER()), 'no redraw from any source while a finger is on the list');
  assert.ok(/setTimeout\(\(\) => \{ if \(!activeHeld && screen === 'agents'\) renderAgents\(\); \}, 400\)/.test(rel), 'the redraw waits until the tap has been delivered');
  assert.ok(!/activeHeld = false;\s*if \(screen === 'agents'\) renderAgents\(\);/.test(rel), 'never a redraw inside touchend');
  assert.ok(RENDER().includes('activeWireHold(list)'));
  assert.ok(body.includes('activeHoldWired'), 'wired once');
});

test('the animation honours reduced motion and runs only when the height changed', () => {
  const body = RENDER();
  assert.ok(body.includes("matchMedia('(prefers-reduced-motion: reduce)').matches"));
  assert.ok(/sec && activeRows\.length !== activeLastCount && h !== activeLastH && !matchMedia/.test(body), 'only when rows join or leave');
  assert.ok(body.includes("sec.animate([{ height: activeLastH + 'px', overflow: 'hidden' }, { height: h + 'px', overflow: 'hidden' }], { duration: 150, easing: 'ease-out' })"));
  assert.ok(body.includes('activeLastH = h;'));
  assert.ok(/prefers-reduced-motion: reduce\) \{ \.active-sec \{ animation: none; \} \}/.test(html));
});

test('the linger ticker runs every second only while a row is done', () => {
  const body = RENDER();
  assert.ok(/if \(!activeTicker && activeState\.rows\.some\(r => r\.doneAt != null\)\)/.test(body));
  assert.ok(body.includes('}, 1000)'));
  assert.ok(body.includes('clearInterval(activeTicker); activeTicker = null;'));
});

test('the menu switch: button without chat-only, wired, painted, key defaults on', () => {
  const m = html.match(/<button id="menu-active-top"([^>]*)>([^<]*)<\/button>/);
  assert.ok(m, 'button exists');
  assert.ok(!/chat-only/.test(m[1]));
  assert.ok(html.indexOf('id="menu-fold"') < html.indexOf('id="menu-active-top"'));
  assert.ok(js.includes("$('menu-active-top')?.addEventListener('click', toggleActiveTop);"));
  assert.ok(/paintFoldMenu\(\);\s*\$\('menu-active-top'\)\?\.addEventListener\('click', toggleActiveTop\);\s*paintActiveMenu\(\);/.test(js));
  assert.ok(html.includes('.agent-row.active-done { opacity: .6; }') && html.includes('.active-sec { overflow: hidden; }'));
  const fnSrc = slice('function activeTopOn()', 'function activeRelease()');
  const make = (ls) => {
    const els = { 'menu-active-top': { textContent: '' }, menu: { classList: { remove() { els.closed = true; } } } };
    const calls = [];
    // changed: toggleActiveTop also calls activeJobsSync (stubbed here; it is recorded as 'sync' before the redraw)
    const f = new Function('localStorage', '$', 'screen', 'renderAgents', 'activeJobsSync', fnSrc + '\nreturn { activeTopOn, paintActiveMenu, toggleActiveTop };')(ls, (id) => els[id], 'agents', () => calls.push('render'), () => calls.push('sync'));
    return { f, els, calls };
  };
  const store = {};
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  const t = make(ls);
  assert.strictEqual(t.f.activeTopOn(), true);
  t.f.paintActiveMenu();
  assert.strictEqual(t.els['menu-active-top'].textContent, '⬆ Active agents at the top: On');
  t.f.toggleActiveTop();
  assert.strictEqual(store['hub-active-top'], 'off');
  assert.strictEqual(t.els['menu-active-top'].textContent, '⬆ Active agents at the top: Off');
  assert.ok(t.els.closed && t.calls.includes('render'));
  t.f.toggleActiveTop();
  assert.strictEqual(store['hub-active-top'], 'on');
  assert.strictEqual(make({ getItem() { throw new Error('x'); } }).f.activeTopOn(), true);
});

test('the six helper names are declared exactly once in mobile.js', () => {
  for (const n of ['activeInitial', 'activeIsWorker', 'activeBusyFrom', 'activeStep', 'activeChanged', 'activeTitle']) {
    const decl = js.match(new RegExp(`(?:function|let|const|var)\\s+${n}\\b`, 'g')) || [];
    assert.strictEqual(decl.length, 1, n);
  }
  for (const n of ['activeState', 'activeHeld', 'activeHoldTimer', 'activeTicker', 'activeLastH']) {
    assert.strictEqual((js.match(new RegExp(`let\\s+${n}\\b`, 'g')) || []).length, 1, n);
  }
});

test('an Active row whose agent works only through temporary workers reads as working; normal rows are unchanged', () => {
  const { env, agentRowHtml } = rowEnv();
  const r = agentRowHtml(AGENTS.idle, { active: true });
  assert.ok(r.includes('class="agent-row is-busy"') && r.includes('⏳ working') && r.includes('class="dot busy"'), r);
  assert.strictEqual(agentRowHtml(AGENTS.busy, { active: true }), oldRow(AGENTS.busy, env), 'a really busy agent: the usual row');
  assert.strictEqual(agentRowHtml(AGENTS.idle), oldRow(AGENTS.idle, env), 'outside the section: unchanged');
});

test('the linger ticker stops when the Agents screen is left', () => {
  const body = RENDER();
  assert.ok(/if \(screen !== 'agents' \|\| !agents\.length \|\| !activeState\.rows\.some\(r => r\.doneAt != null\)\) \{ clearInterval\(activeTicker\); activeTicker = null; return; \}/.test(body));
});

test('renderAgents does nothing while a finger is on a drawn list, and draws normally otherwise', () => {
  const held = renderEnv({ agents: [{ name: 'a', model: 'm' }] });
  const src = ROW() + '\nlet activeState = activeInitial();\nfunction activeWireHold() {}\n' + slice('function activeBusyNow()', '// The finger left') + RENDER();
  const names = Object.keys(held.env).filter((n) => n !== 'calls' && n !== 'activeHeld' && n !== 'activeMissed');
  const list = { innerHTML: 'old rows', firstChild: {}, querySelector: () => null, addEventListener() {} };
  const env = { ...held.env, $: () => list };
  const fn = new Function(...names, 'activeHeld', 'activeMissed', 'env', src + '\nreturn { renderAgents, missed: () => activeMissed };')(...names.map((n) => env[n]), true, false, env);
  fn.renderAgents();
  assert.strictEqual(list.innerHTML, 'old rows', 'the touched rows stay in place');
  assert.strictEqual(fn.missed(), true, 'the skipped redraw is remembered for the release');
  const free = renderEnv({ agents: [{ name: 'a', model: 'm' }] });
  free.fn.renderAgents();
  assert.ok(free.list.innerHTML.includes('data-agent="a"'));
});
