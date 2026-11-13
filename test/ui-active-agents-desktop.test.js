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

test('renderAgents puts the Active container first and paints it', () => {
  const r = body(app, 'function renderAgents()');
  assert.ok(r.includes(`let html = '<div id="agent-active-group" class="agent-group active-group" data-category="active" hidden></div>' + groupActions;`) ||
    /let html = [^\n]*agent-active-group[^\n]*groupActions/.test(r), 'container before groupActions');
  assert.ok(r.includes('activeWireHold()'));
  assert.ok(/paintAllAgentStatus\(\);\s*paintActiveSection\(true\);/.test(r));
});

test('paintAgentsWorking repaints the Active section', () => {
  assert.ok(/function paintAgentsWorking\(\)[\s\S]*?paintActiveSection\(\);\s*\n    \}/.test(app));
});

test('paintActiveSection uses the helpers with held and enabled', () => {
  const p = body(app, 'function paintActiveSection(');
  assert.ok(p.includes('activeBusyFrom(agentStatus, localBusy, AGENTS.map(a => a.name))'));
  assert.ok(/activeStep\(activeState,[^\n]*held: activeHeld[^\n]*enabled: activeTopOn\(\)/.test(p));
  assert.ok(p.includes('activeChanged('));
  assert.ok(!p.includes('paintAgentsWorking'), 'no recursion');
  assert.ok(p.includes("prefers-reduced-motion: reduce"));
  assert.ok(p.includes('.animate('));
  assert.ok(p.includes("toggleCategoryCollapse('active', this)"));
  assert.ok(p.includes('cat-collapsed-active'));
});

test('copies drop ids, are marked, and done rows say done', () => {
  const c = body(app, 'function activeMakeCopy(');
  assert.ok(c.includes('cloneNode(true)'));
  assert.ok(c.includes("removeAttribute('id')"));
  assert.ok(c.includes("'active-copy'"));
  assert.ok(c.includes("'active-done'"));
  assert.ok(c.includes("remove('is-busy')"));
  assert.ok(c.includes('✓ done'));
  assert.ok(c.includes('agent-busy-line'));
  assert.ok(c.includes('startSoloChat(copy.dataset.agent, copy.dataset.model)'));
});

test('hold listeners use a 2000 ms timer', () => {
  const h = body(app, 'function activeWireHold(');
  for (const ev of ['mouseenter', 'mousemove', 'mouseleave']) assert.ok(h.includes(`'${ev}'`), ev);
  assert.ok(h.includes('2000'));
  assert.ok(/setInterval\(paintActiveSection, 1000\)/.test(app));
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

test('unchanged rows are refreshed in place (a row under the pointer is never replaced mid-click); any movement holds again', () => {
  const p = app.slice(app.indexOf('function paintActiveSection('), app.indexOf('function activeWireHold('));
  assert.ok(/if \(changed \|\| items\.children\.length !== activeState\.rows\.length\) \{\s*items\.replaceChildren/.test(p), 'rebuild only on a change');
  assert.ok(/else \{[\s\S]*dst\.textContent = src\.textContent/.test(p), 'in-place status line update otherwise');
  const h = app.slice(app.indexOf('function activeWireHold('), app.indexOf('function activeWireHold(') + 900);
  assert.ok(/'mousemove', \(\) => \{ activeHeld = true; restart\(\); \}/.test(h));
});
