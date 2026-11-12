'use strict';
// "Auto" in the chat header's model picker (app.js; the phone's picker in mobile.js). Auto is the first choice and turns
// the agent's Auto setting on (PATCH autoModel, as the agent settings page does); a real model turns it off. An Auto
// agent's picker keeps showing "Auto" (once its list loads it used to jump to the model the agent happens to be set to),
// then "Auto · <model>" after a turn's auto_model event. That event used to rewrite the header's textContent, which
// flattened the picker, the effort picker and the plan badge into one long line of option text.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const mob = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const fn = (src, name) => src.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n    \\}\\n`))[0];

// A stand-in <select>: options with value/textContent, insertAdjacentHTML('afterbegin', '<option value="x">…'), value.
function select(values) {
  const sel = { options: values.map(v => ({ value: v, textContent: v })), title: 'manual tip', dataset: { tip: 'manual tip' } };
  sel.insertAdjacentHTML = (_, html) => sel.options.unshift({ value: html.match(/value="([^"]*)"/)[1], textContent: '' });
  let v = values[0];
  Object.defineProperty(sel, 'value', { get: () => v, set: (x) => { v = sel.options.some(o => o.value === x) ? x : ''; } });
  return sel;
}
function ctxWith(chat, sel, extra = {}) {
  const ctx = { chats: { c1: chat }, document: { getElementById: (id) => (id === 'model-pick-c1' ? sel : null) }, ...extra };
  vm.runInNewContext(`const AUTO_PICK='__auto__'; const AUTO_TIP='Auto picks the model and effort for each turn.'; const OR_MORE='__or_more__';\n`
    + ['autoPickLabel', 'paintAutoPick', 'noteAutoModel', 'setChatAuto', 'changeChatModel'].map(n => fn(app, n)).join('\n')
    + '\nthis.paintAutoPick=paintAutoPick; this.noteAutoModel=noteAutoModel; this.changeChatModel=changeChatModel;', ctx);
  return ctx;
}

test('Auto is the first choice in both pickers; the old header rewrite is gone', () => {
  assert.match(app, /let html = `<optgroup label="Auto"><option value="\$\{AUTO_PICK\}">\$\{esc\(autoPickLabel\(chat\)\)\}<\/option><\/optgroup>`;/);
  assert.match(mob, /let html = `<optgroup label="Auto"><option value="\$\{AUTO_PICK\}">Auto<\/option><\/optgroup>`;/);
  assert.match(mob, /sel\.value = a\.autoModel \? AUTO_PICK : cur;/);
  assert.match(mob, /function modelText\(a\) \{ return a && a\.autoModel \? 'Auto' : shortModel\(a\?\.model\); \}/);
  assert.ok(!/headerSpan\.textContent\s*=/.test(app), 'no handler rewrites the header text');
  assert.strictEqual((app.match(/noteAutoModel\(chatId, modelShort\);/g) || []).length, 2, 'both stream readers use the helper');
});

test('an Auto agent keeps "Auto" selected after the list loads, then shows "Auto · <model>"; a fixed agent shows its model', () => {
  const chat = { id: 'c1', agent: 'compass', model: 'claude-sdk/sonnet', autoModel: true };
  const sel = select(['__auto__', 'claude-sdk/sonnet', 'claude-sdk/opus']);
  sel.value = 'claude-sdk/sonnet';   // what fillModelPickNow's sel.value = cur does
  const ctx = ctxWith(chat, sel);
  ctx.paintAutoPick('c1');
  assert.strictEqual(sel.value, '__auto__'); assert.strictEqual(sel.options[0].textContent, 'Auto');
  assert.strictEqual(sel.title, 'Auto picks the model and effort for each turn.');
  ctx.noteAutoModel('c1', 'claude-sonnet-5-5');
  assert.strictEqual(sel.options[0].textContent, 'Auto · claude-sonnet-5-5'); assert.strictEqual(sel.value, '__auto__');
  chat.autoModel = false; chat.lastAutoModel = null; ctx.paintAutoPick('c1');
  assert.strictEqual(sel.value, 'claude-sdk/sonnet'); assert.strictEqual(sel.options[0].textContent, 'Auto'); assert.strictEqual(sel.title, 'manual tip');
});

test('picking Auto turns the setting on; a real model turns it off (switching first if it differs)', async () => {
  const run = async (chat, pick) => {
    const calls = [];
    const fetch = async (url, o) => { calls.push(`${o.method} ${url} ${o.body}`); return { ok: true, status: 200, json: async () => ({ success: true }) }; };
    const ctx = ctxWith(chat, select(['__auto__', 'claude-sdk/sonnet', 'claude-sdk/opus']), { fetch, alert: () => {}, refreshEffortPick: () => {}, openOrPicker: () => {}, testBeforeSwitch: async () => true });
    const r = await ctx.changeChatModel('c1', pick);
    return { r, calls, auto: chat.autoModel };
  };
  let o = await run({ id: 'c1', agent: 'compass', model: 'claude-sdk/sonnet', autoModel: false }, '__auto__');
  assert.deepStrictEqual(o.calls, ['PATCH /api/agents/compass {"autoModel":true}']); assert.strictEqual(o.auto, true);
  o = await run({ id: 'c1', agent: 'compass', model: 'claude-sdk/sonnet', autoModel: true }, 'claude-sdk/opus');
  assert.deepStrictEqual(o.calls, ['POST /api/agents/compass/model {"model":"claude-sdk/opus"}', 'PATCH /api/agents/compass {"autoModel":false}']); assert.strictEqual(o.auto, false);
  o = await run({ id: 'c1', agent: 'compass', model: 'claude-sdk/sonnet', autoModel: true }, 'claude-sdk/sonnet');
  assert.deepStrictEqual(o.calls, ['PATCH /api/agents/compass {"autoModel":false}'], 'the model it was set to: only Auto goes off');
  o = await run({ id: 'c1', agent: 'compass', model: 'claude-sdk/sonnet', autoModel: true }, '__auto__');
  assert.deepStrictEqual(o.calls, [], 'already on Auto: nothing to do');
  o = await run({ id: 'c1', agent: 'compass', model: 'claude-sdk/sonnet', autoModel: false }, 'claude-sdk/opus');
  assert.deepStrictEqual(o.calls, ['POST /api/agents/compass/model {"model":"claude-sdk/opus"}'], 'a fixed agent: just the switch, as before');
});
