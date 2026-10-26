'use strict';
// The tool panel: every tool call of a reply sits in one panel under its reasoning panel, closed until the reader
// opens it, so a reply that runs many tools no longer grows a line per call. The header updates in place (calls done,
// failed ones in red, what runs now and for how long; the totals once the reply is over); opened, one short line per
// call with its output a click away. The text the agent writes between calls stays in the reply. The model and row
// builders are pure and run here as they do in the pages; the wiring is pinned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mjs = read('mobile.js');
const css = read('index.html');
const mcss = read('mobile.html');

function extract(src, name) {
  const at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}
const fns = (src, names, ret, pre = '') => new Function(`${pre}${names.map(n => extract(src, n)).join('\n')}; return { ${ret} };`)();

const D = fns(app, ['escapeHtmlSafe', 'fmtDur', 'durClass', 'toolPanelModel', 'toolSpanMs', 'toolSummaryText', 'toolDurHtml', 'toolDetailText', 'toolRowsHtml', 'sameToolRows'],
  'toolPanelModel, toolSpanMs, toolSummaryText, toolRowsHtml, toolDetailText, sameToolRows', 'const TOOL_DETAIL_MAX = 20000;\n');
const steps = [
  { text: 'Looking.', tools: [{ tool: 'Read', input: 'lib/a.js', status: 'done', result: 'x', startedAt: 1000, durationMs: 100 },
    { tool: 'Bash', input: 'npm test', status: 'error', result: 'Error: 1 failing', startedAt: 1050, durationMs: 1000 }] },
  { text: 'Again.', tools: [{ tool: 'Bash', input: 'npm test', status: 'running', result: null, startedAt: 5000 }] },
  { text: 'Done.', tools: [] },
];

test('desktop: the model counts calls, failures and what runs; a call still running when the reply ends did not finish', () => {
  const live = D.toolPanelModel(steps, true);
  assert.strictEqual(live.rows.length, 3);
  assert.deepStrictEqual(live.rows.map(r => r.group), [0, 0, 1], 'a group per step');
  assert.strictEqual(live.done, 2); assert.strictEqual(live.failed, 1); assert.strictEqual(live.running.length, 1);
  assert.strictEqual(D.toolSummaryText(live), '2 done');
  const over = D.toolPanelModel(steps, false);
  assert.strictEqual(over.running.length, 0);
  assert.strictEqual(over.rows[2].status, 'stopped');
  assert.strictEqual(D.toolSummaryText(over), '3 calls');
  assert.strictEqual(D.toolSummaryText(D.toolPanelModel([{ text: '', tools: [{ tool: 'Read', status: 'running', startedAt: 1 }] }], true)), '1 running');
  assert.strictEqual(D.toolSummaryText(D.toolPanelModel([{ text: '', tools: [{ tool: 'Read', status: 'done' }] }], false)), '1 call');
});

test('desktop: the time is the union of the calls (side by side counts once), unknown when no call has times', () => {
  assert.strictEqual(D.toolSpanMs([{ startedAt: 1000, durationMs: 100 }, { startedAt: 1050, durationMs: 1000 }, { startedAt: 5000, durationMs: 500 }]), 1050 + 500);
  assert.strictEqual(D.toolSpanMs([{ startedAt: 1000, durationMs: 100 }, { startedAt: 1200, durationMs: 100 }]), 200);
  assert.strictEqual(D.toolSpanMs([{ startedAt: null, durationMs: 5 }]), null);
  assert.strictEqual(D.toolSpanMs([{ startedAt: 1000, durationMs: 100 }, { startedAt: null, durationMs: null }]), null, 'a call without times: no total, not a partial one');
  assert.strictEqual(D.toolPanelModel(steps, false).spanMs, null, 'a call that did not finish: no total');
});

test('desktop: rows are text, one per call, a line between groups, details only where opened', () => {
  const m = D.toolPanelModel([{ text: '', tools: [{ tool: '<img src=x onerror=alert(1)>', input: '"><script>x</script>', status: 'done', result: '<b>out</b>' }] },
    { text: '', tools: [{ tool: 'Read', input: 'a', status: 'done', result: 'ok' }] }], false);
  const closed = D.toolRowsHtml(m, new Set());
  assert.ok(!/<img|<script|<b>/.test(closed), 'names, inputs and outputs are escaped');
  assert.strictEqual((closed.match(/class="ts-row /g) || []).length, 2);
  assert.strictEqual((closed.match(/ts-sep/g) || []).length, 1, 'one line between the two groups');
  assert.ok(!closed.includes('ts-detail'), 'closed rows show no output');
  assert.ok(closed.includes('role="button" tabindex="0" aria-expanded="false"'));
  const opened = D.toolRowsHtml(m, new Set([m.rows[1].key]));
  assert.strictEqual((opened.match(/class="ts-detail"/g) || []).length, 1);
  assert.ok(opened.includes('Read: a\n\nok'), 'the detail: the call, then its output');
  const all = D.toolRowsHtml(m, null, true);
  assert.strictEqual((all.match(/class="ts-detail"/g) || []).length, 2, 'the full view shows every output');
  assert.ok(!all.includes('role="button"'), 'and its rows are not buttons');
  assert.ok(all.includes('&lt;b&gt;out&lt;/b&gt;'));
  const two = D.toolPanelModel([{ text: '', tools: [{ tool: 'Bash', input: 'npm test', status: 'done', result: 'a' }, { tool: 'Bash', input: 'npm test', status: 'done', result: 'b' }] }], false);
  assert.notStrictEqual(two.rows[0].key, two.rows[1].key, 'the same call twice: two rows, two keys');
  const big = D.toolDetailText({ tool: 'Read', input: 'f', status: 'done', result: 'x'.repeat(25000) });
  assert.ok(big.endsWith('… (5,000 more characters not shown)') && big.length < 20100, 'a very long output is cut, and says so');
  assert.ok(D.toolDetailText({ tool: 'Read', input: 'f', status: 'done', result: 'x'.repeat(25000) }, true).endsWith('x'.repeat(100)), '...but not in the full view');
});

test('desktop: rows are compared by value, keyed by the call\'s own id when it has one', () => {
  const mk = (result, extra = {}) => D.toolPanelModel([{ text: '', tools: [{ tool: 'Bash', input: 'npm test', status: 'done', result, startedAt: 5, durationMs: 1, ...extra }] }], false);
  const sfx = 'x'.repeat(30);
  assert.strictEqual(D.sameToolRows(mk('PASS' + sfx), mk('PASS' + sfx)), true);
  assert.strictEqual(D.sameToolRows(mk('PASS' + sfx), mk('FAIL' + sfx)), false, 'same length, same ending, different text');
  assert.strictEqual(D.sameToolRows(mk('a'), D.toolPanelModel([{ text: '', tools: [{ tool: 'Bash', input: 'npm test', status: 'done', result: 'a', startedAt: 5, durationMs: 1 }] }], true)), false, 'live and over differ');
  assert.strictEqual(D.sameToolRows(null, mk('a')), false);
  assert.strictEqual(D.sameToolRows(mk('a', { id: 'c1' }), mk('a', { id: 'c1', startedAt: 9 })), false, 'same id, a new start time');
  assert.strictEqual(D.sameToolRows(mk('a', { id: 'c1' }), mk('a', { id: 'c1', tool: 'Read' })), false, 'same id, another tool name');
  assert.strictEqual(mk('a', { toolCallId: 'toolu_1' }).rows[0].key, 'id:toolu_1', 'the stream\'s tool call id');
  assert.strictEqual(mk('a', { id: 'act-7' }).rows[0].key, 'id:act-7', 'the hub\'s item id');
  assert.strictEqual(mk('a', { input: '' }).rows[0].key !== mk('a', { input: 'later' }).rows[0].key, true, 'without an id the key follows what went in');
  assert.strictEqual(mk('a', { id: 'act-7', input: '' }).rows[0].key, mk('a', { id: 'act-7', input: 'later' }).rows[0].key, '...with one it does not');
});

test('desktop: the reply text stays in the message, the calls go to one panel kept across rewrites, closed at first', () => {
  const rs = extract(app, 'renderSteps');
  assert.ok(!rs.includes('tool-calls-container'), 'no tool lines between the text any more');
  assert.match(rs, /setMessageHtml\(el, html\);\s*paintToolPanel\(el, msgId, steps, isStreaming\);/);
  assert.match(extract(app, 'setMessageHtml'), /const tools = el\.querySelector\(':scope > \.tool-stream'\);[\s\S]*if \(tools\) placeToolPanel\(el, tools\);\s*if \(focused && focused\.isConnected\) focused\.focus\(\{ preventScroll: true \}\);/, 'a reader keyboard focus on a panel survives rewrites');
  assert.match(extract(app, 'paintToolPanel'), /const fKey = [\s\S]*body\.querySelector\(`\.ts-row\[data-i="\$\{j\}"\]`\)\?\.focus/, '...and row rebuilds');
  assert.match(extract(app, 'paintToolsFull'), /if \(!ov \|\| !box \|\| !box\._model\) \{ if \(ov && toolsFullFor\) closeToolsFull\(\); return; \}/, 'the full view closes when its reply is gone');
  assert.match(extract(app, 'paintToolPanel'), /box\.className = 'tool-stream collapsed';/);
  assert.match(extract(app, 'placeToolPanel'), /const rsn = host\.querySelector\(':scope > \.reason-stream'\);\s*if \(rsn\) \{ rsn\.after\(box\); return; \}/, 'right under the reasoning panel');
  assert.match(extract(app, 'clearLiveActivity'), /finishReasoning\(msgId\);\s*finishToolPanel\(msgId\);/, 'the end of a reply settles the panel');
  assert.match(app, /currentStep\.tools\.find\(t => t\.toolCallId === oc2\.tool_call_id && t\.status === 'running'\)\) \|\| currentStep\.tools\.find\(t => t\.status === 'running'\)/, 'a result goes to its own call (by id) when two run side by side');
  assert.match(app, /\(oc2\.tool_call_id && currentStep\.tools\.find\(t => t\.toolCallId === oc2\.tool_call_id\)\) \|\| currentStep\.tools\.findLast\(t => t\.tool === oc2\.tool\)/, '...and so does its input');
  assert.match(extract(app, 'handleKeyDown'), /if \(toolsFullFor\) \{ event\.preventDefault\(\); closeToolsFull\(\); return; \}/);
  assert.match(extract(app, 'paintToolHead'), /now\.innerHTML = `now: <b>\$\{escapeHtmlSafe\(cur\.tool\)\}<\/b> \$\{escapeHtmlSafe\(cur\.input\)\}/);
  for (const sel of ['.tool-stream.collapsed .ts-body', '.ts-row {', '.ts-detail {', '.tools-full .rsn-full-box', '.ts-fail[hidden]']) assert.ok(css.includes(sel), sel);
});

const P = fns(mjs, ['clipText', 'tsnDur', 'tsnFailed', 'tsnSpan', 'tsnModel', 'tsnSummary'], 'tsnDur, tsnFailed, tsnSpan, tsnModel, tsnSummary');
const feed = (ended, rows) => ({ ended, items: new Map(rows.map((r, i) => [`i${i}`, { id: `i${i}`, ...r }])) });

test('phone: the model counts calls and workers, a failed tool by its output and a failed worker by its status', () => {
  const f = feed(false, [{ kind: 'tool', status: 'done', output: 'ok', t0: 1000, t1: 1100 },
    { kind: 'tool', status: 'done', output: 'Error: boom', t0: 1050, t1: 2050 },
    { kind: 'worker', status: 'failed', t0: 3000, t1: 3500 },
    { kind: 'tool', status: 'running', t0: 4000, t1: null }]);
  const m = P.tsnModel(f);
  assert.strictEqual(m.live, true); assert.strictEqual(m.done, 3); assert.strictEqual(m.failed, 2); assert.strictEqual(m.running.length, 1);
  assert.strictEqual(P.tsnSummary(m), '3 done');
  assert.strictEqual(m.spanMs, null, 'a call still running: no total yet');
  assert.strictEqual(P.tsnSpan([...f.items.values()].slice(0, 3)), 1050 + 500, 'every call timed: the union of their times');
  const over = P.tsnModel(feed(true, [{ kind: 'tool', status: 'done', output: '', t0: 1, t1: 2 }]));
  assert.strictEqual(over.live, false); assert.strictEqual(P.tsnSummary(over), '1 call');
  assert.strictEqual(P.tsnSummary(P.tsnModel(feed(false, [{ kind: 'tool', status: 'running' }]))), '1 running');
  assert.strictEqual(P.tsnSpan([{ t0: null, t1: 5 }]), null);
  assert.deepStrictEqual([P.tsnDur(50), P.tsnDur(1500), P.tsnDur(42000), P.tsnDur(72000)], ['<0.1s', '1s', '42s', '1m 12s']);
});

test('phone: the reply text stays in the bubble, the calls go to one panel above it, closed at first, rows still tap open', () => {
  const pr = extract(mjs, 'paintReply');
  assert.match(pr, /if \(b\.type !== 'text'\) continue;   \/\/ the calls go into the tool panel/);
  assert.match(pr, /paintTools\(holder, blocks, changed\);/);
  assert.ok(!pr.includes("'feed fgroup'"), 'no rows between the text any more');
  const pt = extract(mjs, 'paintTools');
  assert.match(pt, /box\.className = 'tsn closed';/);
  assert.match(pt, /const rsn = el\.querySelector\(':scope > \.rsn'\);\s*el\.insertBefore\(box, rsn \? rsn\.nextSibling : /, 'under the reasoning panel');
  assert.match(pt, /feedEls\.set\(box, feed\);/);
  assert.match(extract(mjs, 'onMessagesClick'), /if \(onReasoningClick\(e\)\) return;\s*if \(onToolsClick\(e\)\) return;/);
  assert.match(extract(mjs, 'onFeedClick'), /e\.target\.closest\('\.feed, \.tsn'\)/);
  assert.match(extract(mjs, 'feedUpsert'), /t0: Date\.parse\(item\.ts\) \|\| Date\.now\(\)/);
  assert.match(extract(mjs, 'paintSaved'), /t0: Date\.parse\(a\.ts\) \|\| null, t1: Date\.parse\(a\.doneTs\) \|\| null/);
  assert.match(mjs, /\$\('messages'\)\.addEventListener\('pointerdown', onToolsGrip\);/);
  assert.match(extract(mjs, 'paintToolsSheet'), /if \(!tsnSheetFor\.bubble \|\| !tsnSheetFor\.bubble\.el\.isConnected\) \{ closeToolsSheet\(\); return; \}/, 'the full screen closes when its reply leaves the page');
  assert.match(extract(mjs, 'openChat'), /if \(!same && tsnSheetFor\) closeToolsSheet\(\);/, '...and when another chat opens');
  assert.match(extract(mjs, 'paintTsnHead'), /if \(!tsnTimer\) tsnTimer = setInterval\(tsnTick, 1000\);/, 'the time ticks whenever a call runs');
  assert.match(extract(mjs, 'openToolsSheet'), /if \(e\.key !== 'Tab'\) return;[\s\S]*\(document\.activeElement === close \? body : close\)\.focus\(\);/, 'the sheet keeps Tab inside');
  assert.match(extract(mjs, 'closeToolsSheet'), /back\.focus\(\{ preventScroll: true \}\)/, 'and gives focus back');
  assert.ok(!/slice\(0, 3000\)/.test(extract(mjs, 'tsnEntryText')), 'the full screen shows the whole output the page has');
  for (const sel of ['.tsn.closed .tsn-body', '.tsn .frow .fline { display: block; white-space: nowrap;', '.tsn-now[hidden]', '.tsn-sheet .rsn-sheet-title']) assert.ok(mcss.includes(sel), sel);
});
