'use strict';
// The Active section on the desktop page: wiring in app.js and the CSS in index.html.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const BEGIN = '// ── active agents helpers (begin) ──';
const END = '// ── active agents helpers (end) ──';
const outside = app.slice(0, app.indexOf(BEGIN)) + app.slice(app.indexOf(END));

function body(src, header) {
  const i = src.indexOf(header);
  assert.ok(i >= 0, header + ' present');
  const next = src.indexOf('\n    function ', i + header.length);
  return src.slice(i, next < 0 ? undefined : next);
}

test('renderAgents puts the Active container under the New Agent / Clone row, above the first group, and paints it', () => {
  const r = body(app, 'function renderAgents()');
  assert.ok(r.includes(`let html = groupActions + '<div id="agent-active-group" class="agent-group active-group" data-category="active" hidden></div>';`),
    'container after groupActions, before the category groups');
  assert.ok(r.includes('activeWireHold()'));
  assert.ok(/paintAllAgentStatus\(\);\s*paintActiveSection\(true\);/.test(r));
});

test('paintAgentsWorking repaints the Active section once per burst of status events (first fill ordered by start)', () => {
  assert.ok(/function paintAgentsWorking\(\)[\s\S]*?activePaintSoon\(\);\s*\n    \}/.test(app));
  const q = body(app, 'function activePaintSoon(');
  assert.ok(q.includes('queueMicrotask(') && q.includes('activePaintQueued'));
});

test('paintActiveSection uses the helpers with held and enabled', () => {
  const p = body(app, 'function paintActiveSection(');
  assert.ok(p.includes("AGENTS.map(a => a.name).filter(n => document.getElementById('agent-btn-' + n))"), 'only agents with a row');
  assert.ok(p.includes('activeBusyFrom(agentStatus, localBusy, visible)'));
  assert.ok(/activeStep\(activeState,[^\n]*held: activeHeld[^\n]*enabled: activeTopOn\(\)/.test(p));
  assert.ok(p.includes('activeMembersChanged('), 'rebuild only when rows join, leave or move');
  assert.ok(!p.includes('paintAgentsWorking'), 'no recursion');
  assert.ok(p.includes("prefers-reduced-motion: reduce"));
  assert.ok(p.includes('.animate('));
  assert.ok(p.includes("toggleCategoryCollapse('active', this)"));
  assert.ok(p.includes('cat-collapsed-active'));
});

test('copies drop ids, are marked, and done rows say done; a worker-only parent reads as working', () => {
  const c = body(app, 'function activeMakeCopy(');
  assert.ok(c.includes('cloneNode(true)'));
  assert.ok(c.includes("removeAttribute('id')"));
  assert.ok(c.includes("'active-copy'"));
  assert.ok(c.includes('activeDress(copy, row, orig)'));
  assert.ok(c.includes('startSoloChat(copy.dataset.agent, copy.dataset.model)'));
  const d = body(app, 'function activeDress(');
  assert.ok(d.includes("'active-done'") && d.includes("remove('is-busy')") && d.includes('\\u2713 done'));
  assert.ok(d.includes('\\u23F3 working'), 'a row busy only through its temporary workers');
  assert.ok(d.includes('agent-busy-line'));
});

test('hold listeners use a 2000 ms timer', () => {
  const h = body(app, 'function activeWireHold(');
  for (const ev of ['mouseenter', 'mousemove', 'mouseleave']) assert.ok(h.includes(`'${ev}'`), ev);
  assert.ok(h.includes('2000'));
  assert.ok(/setInterval\(\(\) => paintActiveSection\(\), 1000\)/.test(app));
});

test('the setting defaults on and has a checkbox', () => {
  assert.ok(/function activeTopOn\(\) \{ try \{ return localStorage.getItem\('hub-active-top'\) !== 'off'; \} catch \{ return true; \} \}/.test(app));
  assert.ok(app.includes('id="st-active-top"'));
  assert.ok(app.includes('saveActiveTop(this.checked)'));
  assert.ok(app.includes("'hub-active-top', on ? 'on' : 'off'"));
});

test('CSS rules exist', () => {
  assert.ok(/\.active-group \.active-count\s*\{/.test(html));
  assert.ok(/\.agent-btn\.active-done\s*\{[^}]*opacity:\s*\.6/.test(html));
  assert.ok(/\.active-copy \.action-btn\s*\{\s*display:\s*none/.test(html));
  assert.ok(/prefers-reduced-motion: reduce\)\s*\{\s*#agent-active-group\s*\{[^}]*animation:\s*none/.test(html));
});

test('page code does not redeclare the helpers', () => {
  for (const n of ['activeInitial', 'activeIsWorker', 'activeBusyFrom', 'activeStep', 'activeChanged', 'activeTitle'])
    assert.strictEqual(app.split(`function ${n}(`).length - 1, 1, n);
  for (const n of ['activeInitial', 'activeStep', 'activeChanged', 'activeTitle', 'activeBusyFrom', 'activeIsWorker'])
    assert.ok(!outside.includes(`function ${n}(`) && !new RegExp(`(const|let|var) ${n}\\b`).test(outside), n + ' not in page code');
});

test('unchanged rows are refreshed in place, done marks included (a row under the pointer is never replaced mid-click); any movement holds again', () => {
  const p = app.slice(app.indexOf('function paintActiveSection('), app.indexOf('function activeWireHold('));
  assert.ok(/if \(membersChanged \|\| !items\) \{[\s\S]*items\.replaceChildren/.test(p), 'rebuild only when rows join, leave or move');
  assert.ok(/const byName = new Map\(\[\.\.\.items\.children\]\.map\(c => \[c\.dataset\.agent, c\]\)\);[\s\S]*if \(copy\) \{ activeDress\(copy, row,/.test(p), 'otherwise in place, matched by agent');
  const d = app.slice(app.indexOf('function activeDress('), app.indexOf('function activeMakeCopy('));
  assert.ok(d.includes("dd.className = 'agent-status live-idle'") && d.includes("dd.className = 'agent-status live-busy'"), 'the dot agrees with the line');
  const h = app.slice(app.indexOf('function activeWireHold('), app.indexOf('function activeWireHold(') + 900);
  assert.ok(/'mousemove', \(\) => \{ activeHeld = true; restart\(\); \}/.test(h));
});
