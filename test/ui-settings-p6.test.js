'use strict';
// P6: a way to make a new agent from Settings, the ⓘ on its label's line on the phone, no stray dot in the phone group header.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), idx = read('index.html');

test('the New agent section is first in Agents and teams and drawn for admins only', () => {
  const g = G.GROUPS.find((x) => x.id === 'agents');
  assert.strictEqual(g.sections[0], 'st-newagent-section');
  assert.deepStrictEqual(G.groupOfSection('st-newagent-section'), { group: 'agents', more: false });
  const at = app.indexOf('id="st-newagent-section"');
  assert.ok(at > 0);
  assert.match(app.slice(Math.max(0, at - 120), at), /if \(isHubAdmin\(\)\) \{\s*html \+= `<div class="st-section" $/, 'inside an isHubAdmin() gate');
  const sec = app.slice(at, app.indexOf('</div>`;', at));
  assert.match(sec, /<h4>New agent<\/h4>/);
  assert.match(sec, /<label[^>]*>New agent<\/label>/);
  assert.match(sec, /id="st-new-agent-btn"[^>]*onclick="openCreateAgent\(null\)">Make a new agent…<\/button>/);
  assert.ok(sec.includes('Give it a name and describe its role; your Maestro sets it up. You can also ask your lead to make one for you.'));
});

test('openCreateAgent takes no event, and in the phone frame Create stays in Settings', () => {
  assert.match(app, /function openCreateAgent\(event\) \{\s*if \(event && event\.stopPropagation\) event\.stopPropagation\(\);/);
  const c = app.slice(app.indexOf('async function confirmCreateAgent()'));
  const ok = c.slice(0, c.indexOf("errEl.textContent = result.error || 'Create failed'"));
  assert.match(ok, /await loadAgents\(\);[\s\S]*?classList\.contains\('mm-settings-only'\)\) settingsOnlyPost\('mm-agents-changed'\);\s*else openAgentSettings\(name/);
  assert.match(idx, /html\.mm-settings-only \.question-modal \{ min-width: 0 !important;/);
});

test('the phone group header has no separator dot', () => {
  assert.ok(!/\.st-phone-title::before/.test(idx));
  assert.ok(!/content: "\\00b7/.test(idx.slice(idx.indexOf('.st-phone-back {'), idx.indexOf('.st-phone-back {') + 900)));
});

test('the ⓘ stays on its label\'s line in the phone frame and under 721 px', () => {
  // label (or checkbox label) followed by its ⓘ in a row: the label is capped so the ⓘ always fits beside it
  assert.match(idx, /html\.mm-settings-only \.st-row > label:has\(\+ \.st-info\) \{[^}]*max-width: calc\(100% - 44px\) !important;/);
  // the share links block (a column of bare labels and selects) becomes a wrapping row; a label with its ⓘ shares a line
  assert.match(idx, /html\.mm-settings-only #st-share-block \{ flex-direction: row !important; flex-wrap: wrap;/);
  assert.match(idx, /html\.mm-settings-only #st-share-block > label:has\(\+ \.st-info\) \{ flex: 0 1 auto; max-width: calc\(100% - 44px\); \}/);
  assert.match(idx, /html\.mm-settings-only #st-share-block > \* \{ flex: 1 0 100%;/);
  // workers at once: the ⓘ between the rows and the hint floats so the hint starts beside it
  assert.match(idx, /html\.mm-settings-only #st-wao-rows \+ \.st-info \{ float: left;/);
  // the same under 721 px in a desktop window
  const m = idx.slice(idx.indexOf('@media (max-width: 720px) {\n      .st-modal #st-share-block'));
  const block = m.slice(0, m.indexOf('\n    }'));
  for (const re of [/\.st-modal #st-share-block \{ flex-direction: row !important;/, /\.st-modal #st-share-block > label:has\(\+ \.st-info\)/, /\.st-modal \.st-row > label:has\(\+ \.st-info\) \{ max-width: calc\(100% - 44px\); \}/, /\.st-modal #st-wao-rows \+ \.st-info \{ float: left;/]) {
    assert.match(block, re);
  }
});

test('the phone page refreshes its agent list when an agent was made in its Settings frame', () => {
  const fs = require('fs'), path = require('path');
  const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  const i = mob.indexOf('function settingsSheetMessage(e)');
  const body = mob.slice(i, mob.indexOf('\n}\n', i));
  assert.ok(/e\.source !== s\.frame\.contentWindow \|\| e\.origin !== location\.origin/.test(body), 'only from its own frame');
  assert.ok(/type === 'mm-agents-changed'\) Promise\.resolve\(\)\.then\(loadAgents\)\.catch\(/.test(body));
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes("'mm-agents-changed'"), 'the frame posts it after Create');
});
