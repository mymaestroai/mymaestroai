'use strict';
// Data connectors box on the desktop Settings page (app.js openSettings + the cx* functions).
// Source-string tests in the ui-*.test.js pattern: the page is not executed here.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js');
const index = read('index.html');

test('Settings has a Data connectors section with a plain-language hint', () => {
  assert.match(app, /<div class="st-section" id="st-cx-section"><h4>Data connectors<\/h4>/);
  const at = app.indexOf('id="st-cx-section"');
  const hint = app.slice(at, at + 1500);
  assert.match(hint, /passphrase/);
  assert.match(hint, /connectorsUnlockMinutes, default 240/);
  assert.match(hint, /all agents or only to the ones you name/);
  assert.match(app, /setTimeout\(loadConnectors, 0\);/, 'box loads after the modal opens');
  assert.match(app, /onclick="cxLockAll\(\)">Lock everything<\/button>/);
});

test('the box functions exist', () => {
  for (const fn of ['loadConnectors', 'renderConnectorsBox', 'renderConnectorGroups', 'renderConnectorList', 'renderConnectorForm', 'renderGroupForm',
    'cxUnlock', 'cxLock', 'cxLockAll', 'cxToggle', 'cxDelete', 'cxTest', 'cxEdit', 'cxNew', 'cxSave', 'cxCancel',
    'cxGroupUnlock', 'cxGroupLock', 'cxGroupDelete', 'cxGroupCreate', 'cxGroupNewForm',
    'cxFormKindChange', 'cxFormProtectChange', 'cxFormAgentsChange', 'cxAddSecretRow', 'cxParseArgs', 'cxTakePass', 'cxApi', 'cxStatus', 'onConnectorsChanged']) {
    assert.ok(new RegExp(`\\n    (?:async )?function ${fn}\\(`).test(app), `app.js defines ${fn}`);
  }
});

test('talks to the connectors API exactly, with credentials', () => {
  assert.match(app, /credentials: 'include', body: body \? JSON\.stringify\(body\) : undefined/, 'cxApi sends cookies');
  assert.match(app, /cxApi\('\/api\/connectors'\)/, 'GET list');
  assert.match(app, /cxApi\('\/api\/connectors', 'POST', body\)/, 'save');
  assert.match(app, /cxApi\(`\/api\/connectors\/\$\{encodeURIComponent\(id\)\}`, 'DELETE'\)/);
  assert.match(app, /cxApi\(`\/api\/connectors\/\$\{encodeURIComponent\(id\)\}\/unlock`, 'POST', \{ passphrase \}\)/);
  assert.match(app, /cxApi\(`\/api\/connectors\/\$\{encodeURIComponent\(id\)\}\/lock`, 'POST', \{\}\)/);
  assert.match(app, /cxApi\(`\/api\/connectors\/\$\{encodeURIComponent\(id\)\}\/test`, 'POST', \{\}\)/);
  assert.match(app, /cxApi\('\/api\/connectors\/lock-all', 'POST', \{\}\)/);
  assert.match(app, /cxApi\('\/api\/connector-groups', 'POST', \{ id, label: label \|\| id, passphrase: pass \}\)/);
  assert.match(app, /cxApi\(`\/api\/connector-groups\/\$\{encodeURIComponent\(id\)\}\/unlock`, 'POST', \{ passphrase \}\)/);
  assert.match(app, /cxApi\(`\/api\/connector-groups\/\$\{encodeURIComponent\(id\)\}\/lock`, 'POST', \{\}\)/);
  assert.match(app, /cxApi\(`\/api\/connector-groups\/\$\{encodeURIComponent\(id\)\}`, 'DELETE', \{ passphrase \}\)/);
  assert.match(app, /cxApi\('\/api\/skills'\)/, 'skill picker');
  assert.match(app, /cxApi\('\/api\/agents'\)/, 'agents picker fallback');
  // Save body carries the documented fields.
  const save = app.slice(app.indexOf('async function cxSave()'), app.indexOf('function onConnectorsChanged'));
  for (const k of ['body.command', 'body.args = cxParseArgs', 'body.skillId', 'body.agents = chk(\'st-cx-f-all\') ? null', 'body.group', 'body.passphrase = curpass', 'body.newPassphrase = np', 'body.secrets = secrets', 'body.tools[s.dataset.cxTool] = { cls:']) {
    assert.ok(save.includes(k), `cxSave sets ${k}`);
  }
  assert.match(save, /sensitive: chk\('st-cx-f-sensitive'\)/);
  assert.match(save, /dataHome: v\('st-cx-f-dataHome'\)\.trim\(\)/);
  assert.match(save, /notes: v\('st-cx-f-notes'\)/);
});

test('every passphrase input is type=password, read once and cleared, never echoed', () => {
  const cx = app.slice(app.indexOf('const cxState = {'), app.indexOf('function onConnectorsChanged'));
  for (const id of ['st-cx-gpass-', 'st-cx-gdel-', 'st-cx-pass-', 'st-cx-g-pass"', 'st-cx-g-pass2', 'st-cx-f-curpass"', 'st-cx-f-newpass"', 'st-cx-f-newpass2']) {
    const at = cx.indexOf(`id="${id}`);
    assert.ok(at > 0, `input ${id} exists`);
    const tag = cx.slice(cx.lastIndexOf('<input', at), at);
    assert.match(tag, /type="password"/, `${id} is a password input`);
  }
  assert.match(cx, /class="cx-secret-value" placeholder="value" autocomplete="new-password"/, 'secret values are password inputs');
  assert.match(cx, /<input type="password" class="cx-secret-value"/);
  assert.match(cx, /function cxTakePass\(id\) \{[\s\S]*?el\.value = '';/, 'passphrases are cleared after reading');
  for (const id of ['st-cx-f-curpass', 'st-cx-f-newpass', 'st-cx-f-newpass2', 'st-cx-g-pass', 'st-cx-g-pass2']) assert.ok(cx.includes(`cxTakePass('${id}')`), `${id} read via cxTakePass`);
  assert.ok(cx.includes('cxTakePass(`st-cx-pass-${id}`)') && cx.includes('cxTakePass(`st-cx-gpass-${id}`)') && cx.includes('cxTakePass(`st-cx-gdel-${id}`)'));
  assert.match(cx, /Values are write-only: they are never shown back/);
  assert.ok(!/value="\$\{hubEsc\(c\.secrets/.test(cx), 'secret values never rendered');
});

test('the form: id read-only when editing, kind toggles mcp vs skill rows, agents checkbox list, tool class override', () => {
  assert.match(app, /id="st-cx-f-id" value="\$\{hubEsc\(c\.id \|\| ''\)\}"[^>]*\$\{editing \? 'readonly' : ''\}/);
  assert.match(app, /<option value="mcp"|\[\['mcp', 'mcp: a stdio MCP server the hub starts'\], \['skill', 'skill: a built-in skill'\]\]/);
  assert.match(app, /mcp\.style\.display = kind === 'mcp' \? '' : 'none'/);
  assert.match(app, /skill\.style\.display = kind === 'skill' \? '' : 'none'/);
  assert.match(app, /id="st-cx-f-all" \$\{grantAll \? 'checked' : ''\}/);
  assert.match(app, /data-cx-agent="\$\{hubEsc\(n\)\}"/);
  assert.match(app, /\[\['none', 'none: always on'\], \['own', 'own passphrase'\], \['group', 'group passphrase'\]\]/);
  assert.match(app, /np\.style\.display = protect === 'own' \? '' : 'none'/);
  assert.match(app, /cur\.style\.display = changing \? '' : 'none'/);
  assert.match(app, /data-cx-tool="\$\{hubEsc\(t\.name\)\}"/, 'tool class select');
  assert.match(app, /const CX_CLASSES = \['read', 'write', 'send'\]/);
  assert.match(app, /confirm\(`Delete connector "\$\{id\}"\?/);
  assert.match(app, /if \(err\) err\.textContent = m;/, 'errors shown inline');
  assert.match(app, /hubEsc\(c\.label \|\| c\.id\)/, 'text escaped with hubEsc');
});

test('hub event connectors_changed repaints the box', () => {
  assert.match(app, /source\.addEventListener\('connectors_changed', e => \{ const ev = parse\(e\); if \(ev\) onConnectorsChanged\(ev\); \}\);/);
  assert.match(app, /function onConnectorsChanged\(ev\) \{[\s\S]*?renderConnectorGroups\(\);\s*renderConnectorList\(\);/);
});

test('index.html carries the connector styles', () => {
  for (const cls of ['.cx-row', '.cx-badge', '.cx-form', '.cx-checks', '.cx-secret-row', '.cx-table']) assert.ok(index.includes(cls + ' {'), cls);
});

test('agent sandboxes: Settings box with defaults and build, per-agent selector on the agent page', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'agent-settings.html'), 'utf8');
  for (const s of ['<h4>Agent sandboxes</h4>', 'async function loadSandboxStatus()', 'async function saveSandboxDefaults()', 'async function buildSandboxImage()', "'/api/sandbox/status'", "'/api/sandbox/build'"]) assert.ok(app.includes(s), s);
  for (const s of ['id="sandbox-mode"', 'async function saveSandbox()', "JSON.stringify({ sandbox: v })", "sbSel.value = agent?.sandbox || 'inherit'"]) assert.ok(page.includes(s), s);
});
