'use strict';
// Settings phase 7, part C1 (design fixes): the one Expert values row layout, no duplicate heading, a summary that is not red for a part
// that is not a fault, the spend caps rows, Agents and teams (New agent, Workers at once). String checks of app.js / index.html plus the
// real functions pulled out of app.js and run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const G = require('../lib/ui-settings-groups.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const idx = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// the source of one function of app.js (brace matched from the body's first "{")
function fnSrc(name, pre = '') {
  const i = app.indexOf(`${pre}function ${name}(`);
  assert.ok(i >= 0, `${name} is in app.js`);
  let d = 0, j = app.indexOf(') {', i) + 2;
  for (; j < app.length; j++) { if (app[j] === '{') d++; else if (app[j] === '}' && --d === 0) break; }
  return app.slice(i, j + 1);
}
const row = (k) => G.P5C.find((r) => r.key === k);
const rowHtml = (r) => new Function('STG', 'esc', `${fnSrc('p5cPlaceholder')}\n${fnSrc('p5cRowHtml')}\nreturn p5cRowHtml;`)(G, esc)(r, {});
const sectionSrc = (id) => { const at = app.indexOf(`id="${id}"`); assert.ok(at > 0, id); return app.slice(at, app.indexOf('</div>`;', at)); };

// ── 1. Expert values rows: one layout ───────────────────────────────────────────────
test('an Expert values row: label then help then "Default: ..." on the left, the box and its unit on the right', () => {
  const r = row('filesMaxUploadMb');
  const h = rowHtml(r);
  const left = h.slice(h.indexOf('class="st-xl"'), h.indexOf('class="st-xr"'));
  const right = h.slice(h.indexOf('class="st-xr"'));
  assert.match(left, /^class="st-xl"><label for="st-p5c-filesMaxUploadMb">Biggest upload \(MB\)<\/label><div class="st-hint st-xhelp">The largest single file that can be uploaded to a Files folder\. <span id="st-p5c-filesMaxUploadMb-def">Default: 512 MB\.<\/span><\/div>/, 'the label first (its ⓘ goes right after it), then one dim paragraph: the help sentence, then Default');
  assert.ok(!left.includes('<input'), 'no control on the left');
  assert.match(right, /<input type="number" id="st-p5c-filesMaxUploadMb" data-setting="OPT-0951" min="1" max="100000" step="1" placeholder="512"/);
  assert.match(right, /<span[^>]*>MB<\/span>/, 'the unit follows the box');
  assert.match(right, /id="st-p5c-filesMaxUploadMb-use" hidden onclick="p5cSave\('OPT-0951', true\)">Use default<\/button>/, 'Use default is kept');
  assert.ok(!/<div class="st-hint">/.test(h), 'no separate hint row any more');
});

test('the empty number box shows the default number; a word or empty default leaves the placeholder empty', () => {
  const ph = (k) => (rowHtml(row(k)).match(/placeholder="([^"]*)"/) || [])[1];
  assert.strictEqual(ph('filesMaxUploadMb'), '512');
  assert.strictEqual(ph('filesZipMaxMb'), '2048', 'no thousands comma in a number box');
  assert.strictEqual(ph('connectorsUnlockMinutes'), '240');
  assert.strictEqual(ph('updateCheck.hours'), '24', '"every 24 hours"');
  assert.strictEqual(ph('compactionAt'), '0.75');
  assert.strictEqual(ph('sandboxCpus'), '2');
  for (const r of G.P5C.filter((x) => x.kind === 'num')) assert.ok(!/placeholder="default"/.test(rowHtml(r)), `${r.key}: not the word default`);
  const p = new Function(`${fnSrc('p5cPlaceholder')}\nreturn p5cPlaceholder;`)();
  for (const def of ['on', 'off', '', 'practice run', 'Google']) assert.strictEqual(p({ def }), '', `"${def}" stays empty`);
  assert.strictEqual(p({}), '');
});

test('every row of the table keeps its ids, data-setting and save path in the new layout', () => {
  for (const r of G.P5C) {
    const h = rowHtml(r);
    assert.ok(h.includes(`id="${r.id}"`), `${r.key} id`);
    assert.ok(h.includes(`data-setting="${r.opt}"`), `${r.key} data-setting`);
    assert.ok(h.includes(`id="${r.id}-def"`) && h.includes(`id="${r.id}-use"`), `${r.key} Default and Use default`);
    if (r.kind !== 'models') assert.ok(h.includes(`onchange="p5cSave('${r.opt}')"`), `${r.key} save`);   // the member models boxes are ticked boxes drawn later (p5cAfterDraw), each saving on its own
    assert.strictEqual((h.match(/<div class="st-row st-xrow">/g) || []).length, 1, `${r.key} one row`);
  }
});

test('the layout CSS: two columns, the right one drops under the left at 720 px and in the phone frame', () => {
  assert.match(idx, /\.st-xrow \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 340px\);/);
  assert.match(idx, /@media \(max-width: 720px\) \{\s*\.st-xrow \{ grid-template-columns: minmax\(0, 1fr\); \}\s*\.st-xrow \.st-xr \{ max-width: 340px; \}/);
  assert.match(idx, /html\.mm-settings-only \.st-xrow \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  assert.match(idx, /\.st-xrow \.st-xl > label \{[^}]*text-align: left/);
  // the Startup values rows (drawn by lib/ui-settings-expert.js) use the same .st-xrow classes, so no CSS of their own is left
  assert.ok(!idx.includes('#st-env-values .st-row'), 'no stop-gap rules for the Startup values rows');
});

// ── 2. the heading shows once ───────────────────────────────────────────────────────
test('Expert values has no visible duplicate heading but its words stay reachable', () => {
  const sec = sectionSrc('st-expert-section');
  assert.match(sec, /^id="st-expert-section"><h4 class="st-vh">Expert values<\/h4>/, 'the heading stays in the DOM (search reads it, the More toggle takes its name from it) but visually hidden');
  assert.match(idx, /\.st-vh, \.st-section > h4\.st-vh \{ position: absolute; width: 1px; height: 1px;[^}]*overflow: hidden; clip: rect\(0 0 0 0\)/);
  assert.ok(!/\.st-vh[^{]*\{[^}]*display: ?none/.test(idx), 'not display:none, which would hide it from a screen reader');
  assert.ok(sec.includes('Numbers that tune your Maestro.'), 'the intro sentence follows');
  // every other section keeps its plain visible heading
  assert.match(app, /id="st-newagent-section"><h4>New agent<\/h4>/);
});

// ── 3. the Tools summary: no data connectors is not red ─────────────────────────────
function sumRun(calls) {
  const parts = {};
  const el = { textContent: '', innerHTML: '', crit: false, classList: { toggle(c, on) { if (c === 'st-sum-crit') el.crit = !!on; } } };
  const code = `const stSumParts = parts; const stSumHome = (g) => g;\n${fnSrc('stSum')}\nreturn stSum;`;
  const stSum = new Function('parts', 'document', 'esc', code)(parts, { getElementById: () => el }, esc);
  for (const c of calls) stSum(...c);
  return el;
}
test('"0 data connectors" is drawn plain even when another part of the Tools line is red', () => {
  const el = sumRun([['tools', 'search', 'web search: off', true], ['tools', 'cx', '0 data connectors', false]]);
  assert.strictEqual(el.crit, false, 'the whole line is not red');
  assert.strictEqual(el.innerHTML, '<span class="st-sum-first">web search: off</span> · 0 data connectors', 'only the red part is marked');
  const first = sumRun([['tools', 'cx', '0 data connectors', false], ['tools', 'search', 'web search: off', true]]);
  assert.strictEqual(first.innerHTML, '0 data connectors · <span class="st-sum-first">web search: off</span>');
});
test('a line whose every part is a fault is still red as a whole; a line with none is plain', () => {
  const all = sumRun([['money', 'a', 'monthly cap used up', true]]);
  assert.strictEqual(all.crit, true); assert.strictEqual(all.textContent, 'monthly cap used up');
  const none = sumRun([['tools', 'cx', '0 data connectors', false], ['tools', 'search', 'web search: free fallback', false]]);
  assert.strictEqual(none.crit, false); assert.strictEqual(none.textContent, '0 data connectors · web search: free fallback');
});
test('the data connectors count is sent with no warning flag', () => {
  assert.match(app, /stSum\('tools', 'cx', `\$\{n\} data connector\$\{n === 1 \? '' : 's'\}`, false\);/);
});

// ── 4. spend caps ───────────────────────────────────────────────────────────────────
test('spend caps: one "Save caps" button on its own line after the monthly cap and its day row', () => {
  const sec = sectionSrc('st-spend-section');
  const at = (s) => sec.indexOf(s);
  assert.ok(at('id="st-cap-agent"') < at('id="st-cap-hub"') && at('id="st-cap-hub"') < at('id="st-cap-month"') && at('id="st-cap-month"') < at('id="st-cap-month-day"') && at('id="st-cap-month-day"') < at('id="st-caps-save"'), 'the button comes after the day box');
  const hubRow = sec.slice(sec.lastIndexOf('<div class="st-row">', at('id="st-cap-hub"')), at('id="st-cap-hub"') + 200);
  assert.ok(!hubRow.includes('st-caps-save'), 'not beside the whole-Maestro cap any more');
  const own = sec.slice(sec.lastIndexOf('<div class="st-row">', at('id="st-caps-save"')), sec.indexOf('</div>', at('id="st-caps-save"')));
  assert.strictEqual((own.match(/<(input|select)\b/g) || []).length, 0, 'a line of its own: no box in its row');
  assert.match(sec, /<button class="st-test-btn" id="st-caps-save" onclick="saveSpendCaps\(\)">Save caps<\/button>/);
  assert.ok(!/id="st-caps-save"[^>]*>Save</.test(sec));
});
test('spend caps: the button goes back to "Save caps", not "Save", after Saved', () => {
  const f = fnSrc('saveSpendCaps', 'async ');
  assert.match(f, /btn\.textContent = 'Saving…'/);
  assert.match(f, /btn\.textContent = 'Saved'/);
  assert.match(f, /btn\.textContent = 'Save caps'; \}, 3000\)/);
  assert.ok(!/btn\.textContent = 'Save'; \}, 3000\)/.test(f));
});
test('spend caps: no "whole hub" on screen; the month start day is its own labelled row', () => {
  const sec = sectionSrc('st-spend-section');
  assert.ok(!/whole hub/i.test(sec), 'no whole hub in the Spend rows');
  assert.ok(sec.includes('Daily pay-per-use cap, your whole Maestro ($)'));
  assert.match(app, /\$\{usd\(caps\.hubDailyUsd\)\} for your whole Maestro/, 'the group summary says it too');
  assert.ok(!/whole hub/.test(app.slice(app.indexOf('stSum(\'money\', \'caps\''), app.indexOf('stSum(\'money\', \'caps\'') + 400)));
  assert.ok(!sec.includes('>month starts on day<'), 'no lower-case span with a lone box');
  const d = sec.slice(sec.lastIndexOf('<div class="st-row">', sec.indexOf('id="st-cap-month-day"')), sec.indexOf('id="st-cap-month-day"') + 200);
  assert.match(d, /<label style="flex-basis:150px" for="st-cap-month-day">Month starts on day<\/label>\s*<input type="text" id="st-cap-month-day"/, 'label, then its box: the ⓘ goes right after the label (record OPT-1086 anchors #st-cap-month-day)');
  assert.ok(!d.includes('id="st-cap-month"'), 'its own row, not the monthly cap row');
});

// ── 5. Agents and teams ─────────────────────────────────────────────────────────────
test('New agent: the heading and the button, no third title', () => {
  const sec = sectionSrc('st-newagent-section');
  assert.ok(!/<label/.test(sec), 'the row label is gone');
  assert.ok(sec.includes('<h4>New agent</h4>') && sec.includes('>Make a new agent…</button>') && sec.includes('Give it a name and describe its role'));
});
test('Workers at once: number boxes are dark fields, each service row has its own ⓘ, none floating by the help, Local capitalised', () => {
  assert.match(idx, /\.st-row input\[type="number"\] \{[^}]*background: var\(--bg-input\); border: 1px solid var\(--border\);[^}]*color: var\(--text\)/, 'the same dark field as the text boxes, from CSS variables');
  const hw = app.slice(app.indexOf('id="st-hw-minutes"'), app.indexOf('id="st-hw-minutes"') + 400);
  assert.ok(!/(background|color)\s*:\s*(#|rgb|white)/i.test(hw.slice(0, hw.indexOf('</div>'))), 'no inline colour on the box');
  assert.match(app, /input\.type = 'number'; input\.min = '1'; input\.max = '32'; input\.step = '1';\s*input\.className = 'st-wao-input'/);
  assert.ok(!/#st-wao-rows[^{]*\.st-info[^{]*\{ display: none/.test(idx), 'help buttons are not hidden');
  const recs = new Function(`${app.slice(app.indexOf('const WAO_RECORDS'), app.indexOf('};', app.indexOf('const WAO_RECORDS')) + 2)}\nreturn WAO_RECORDS;`)();
  assert.strictEqual(recs['claude-sdk'], 'OPT-0412');
  assert.strictEqual(recs['codex-cli'], 'OPT-0413');
  assert.match(app, /if \(WAO_RECORDS\[c\.provider\]\) label\.dataset\.setting = WAO_RECORDS\[c\.provider\];/, 'the label carries its record, so the ⓘ lands after it');
  const records = require('../templates/settings-records.json');
  const all = Array.isArray(records) ? records : (records.records || Object.values(records));
  for (const id of Object.values(recs)) {
    const r = all.find((x) => x.id === id);
    assert.ok(r && r.anchors.some((a) => a.selector === `[data-setting="${id}"]`), `${id} is anchored on its row's label`);
  }
  const merged = all.find((x) => x.id === 'OPT-0940');
  assert.ok(merged && merged.anchors.length === 0, 'the merged one-row-per-service record draws no ⓘ beside the help paragraph');
  const labels = new Function(`${app.slice(app.indexOf('const WAO_LABELS'), app.indexOf('};', app.indexOf('const WAO_LABELS')) + 2)}\nreturn WAO_LABELS;`)();
  assert.strictEqual(labels.local, 'Local');
  assert.strictEqual(labels['claude-sdk'], 'Claude subscription');
  assert.match(app, /input\.dataset\.provider = c\.provider;/, 'the data value stays "local"');
});
test('Notice-long-waits checkbox: the box and its words on one line, its ⓘ after the label', () => {
  const m = app.match(/<label class="gs-sub"([^>]*)><input type="checkbox" id="st-hw-notice"[^>]*> Tell the lead when an agent has no build partner<\/label>/);
  assert.ok(m, 'the label wraps the box and the words');
  assert.ok(/flex-basis:auto/.test(m[1]), 'the label is as wide as its words (not the 100 px label column), so the words do not wrap beside the box and the ⓘ follows on the same line');
});
