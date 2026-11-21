'use strict';
// A tool call the hub's policy refused used to show the green tick: the refusal reaches the page only as the
// call's result text, and the pages marked a call failed only when that text began with "Error". Both pages now
// share one rule (toolResultDenied, a verbatim copy of lib/ui-tool-denied.js) and show a refused call as failed (red ✗)
// with the tooltip "Denied by policy", live and when history is reloaded.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mjs = read('mobile.js');
const lib = require('../lib/ui-tool-denied');
const policy = require('../lib/tool-policy');

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

const BEGIN = '// ── tool-result helpers (begin) ──';
const END = '// ── tool-result helpers (end) ──';
function block(src, indent) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'markers present');
  return src.slice(a + BEGIN.length, b).split('\n').map(l => (indent && l.startsWith(indent) ? l.slice(indent.length) : l)).join('\n').trim();
}

// The refusal texts exactly as the server builds them.
const DENIED_POLICY = '[DENIED BY POLICY] reading outside your own folders is not allowed for this agent (reader policy: read_outside = deny; Read /etc/passwd). Do not work around it: report what you need to the agent that asked you, or to the owner.';
const DENIED_OWNER = '[DENIED BY OWNER] The owner declined running a command as root (sudo) (Bash sudo ls). Do not retry it; say so in your reply and continue without it.';
const NOT_APPROVED = '[NOT APPROVED] The owner did not answer the approval request for web access within the time limit, so it was not done (WebFetch x). Say so in your reply and continue without it.';
const DENIED_PLAIN = '[DENIED] Agent "x" is not authorised to use wallet tools.';

test('the helper is a verbatim copy in lib, app.js and mobile.js', () => {
  const l = block(read('lib/ui-tool-denied.js'), '');
  assert.strictEqual(block(app, '    '), l, 'app.js copy differs');
  assert.strictEqual(block(mjs, ''), l, 'mobile.js copy differs');
});

test('the helper recognises the real denial strings (and the server still produces them)', () => {
  const real = policy.denialText({ decision: 'deny', cls: 'read_outside', role: 'reader', reason: 'reader policy: read_outside = deny', summary: 'Read /etc/passwd' });
  assert.ok(real.startsWith('[DENIED BY POLICY]'));
  for (const t of [real, DENIED_POLICY, DENIED_OWNER, NOT_APPROVED, DENIED_PLAIN, `  \n${DENIED_POLICY}`]) assert.strictEqual(lib.toolResultDenied(t), true, t.slice(0, 30));
  assert.ok(policy.denialText({ decision: 'ask', cls: 'web', role: 'r', reason: '', summary: 's' }, { by: 'owner' }).startsWith('[DENIED BY OWNER]'));
  assert.ok(policy.denialText({ decision: 'ask', cls: 'web', role: 'r', reason: '', summary: 's' }, { by: 'timeout' }).startsWith('[NOT APPROVED]'));
});

test('the helper ignores ordinary text that merely mentions policy', () => {
  for (const t of ['', null, undefined, 'ok', 'Error: ENOENT', 'The file says: [DENIED BY POLICY] is the marker', 'denied by policy', 'This policy was DENIED', '[DENIEDX] no', 'see [NOT APPROVED] later', '[ERROR] x'])
    assert.strictEqual(lib.toolResultDenied(t), false, String(t));
});

const SDK_WRAPPED = `PreToolUse:mcp__hub__Bash hook error: ${DENIED_POLICY.replace('reading outside your own folders', 'writing outside your allowed folders')}`;

test('the helper recognises a refusal wrapped by the Claude SDK hook prefix', () => {
  const real = 'PreToolUse:mcp__hub__Bash hook error: [DENIED BY POLICY] writing outside your allowed folders is not allowed for this agent (worker policy: write_outside = deny; ls /x). Do not work around it: report what you need to the agent that asked you, or to the owner.';
  assert.strictEqual(lib.toolResultDenied(real), true);
  assert.strictEqual(lib.toolResultDenied(SDK_WRAPPED), true);
  assert.strictEqual(lib.toolResultDenied(real.replace('hook error:', 'hook blocking error:')), true);
  assert.strictEqual(lib.toolResultDenied(`  ${real}`), true);
  assert.strictEqual(lib.toolResultDenied(real.replace('[DENIED BY POLICY]', '[NOT APPROVED]')), true);
});

test('the helper still ignores the marker after other words or a non-hook prefix', () => {
  for (const t of ['The log says PreToolUse:mcp__hub__Bash hook error: fine and [DENIED BY POLICY] later', 'note: PreToolUse:x hook error: [DENIED BY POLICY] x',
    'PreToolUse:mcp__hub__Bash hook error: it failed. [DENIED BY POLICY] x', 'PreToolUse:mcp__hub__Bash hook error: ok', 'hook error: [DENIED BY POLICY] x'])
    assert.strictEqual(lib.toolResultDenied(t), false, t);
});

// ── desktop ──
const D = fns(app, ['escapeHtmlSafe', 'fmtDur', 'durClass', 'toolResultDenied', 'toolPanelModel', 'toolSpanMs', 'toolSummaryText', 'toolDurHtml', 'toolDetailText', 'toolRowsHtml', 'buildToolsHtml'],
  'toolPanelModel, toolRowsHtml, buildToolsHtml', 'const TOOL_DETAIL_MAX = 20000;\n');
const dStep = (tool, result, status = 'done') => ({ text: '', tools: [{ tool, input: 'x', status, result, startedAt: 1, durationMs: 5 }] });

test('desktop Tools panel: a denied Read and Bash show ✗ with the tooltip; success stays ✓; an ordinary error stays ✗', () => {
  // the call arrived with status "done" (as a saved reply or the live path used to give it): the result decides
  const m = D.toolPanelModel([dStep('Read', DENIED_POLICY), dStep('Bash', DENIED_OWNER), dStep('Read', 'fine'), dStep('Bash', 'Error: boom', 'error')], false);
  assert.deepStrictEqual(m.rows.map(r => r.status), ['error', 'error', 'done', 'error']);
  assert.strictEqual(m.failed, 3);
  const html = D.toolRowsHtml(m, new Set(), false);
  const rows = html.split('<div class="ts-row ').slice(1);
  assert.match(rows[0], /<span title="Denied by policy">✗<\/span>/);
  assert.match(rows[1], /<span title="Denied by policy">✗<\/span>/);
  assert.match(rows[2], /✓/); assert.doesNotMatch(rows[2], /✗|Denied/);
  assert.match(rows[3], /✗/); assert.doesNotMatch(rows[3], /Denied/);
});

test('desktop inline tool lines: a denied result is paired as an error with the tooltip', () => {
  const act = [{ type: 'call', tool: 'Read', input: 'a' }, { type: 'result', output: DENIED_POLICY }, { type: 'call', tool: 'Bash', input: 'b' }, { type: 'result', output: 'ok' },
    { type: 'call', tool: 'Bash', input: 'c' }, { type: 'result', output: 'Error: x' }];
  const html = D.buildToolsHtml(act, false);
  const lines = html.split('<div class="tool-call-line ').slice(1);
  assert.match(lines[0], /^error/); assert.match(lines[0], /title="Denied by policy">✗/);
  assert.match(lines[1], /^done/); assert.match(lines[1], /✓/);
  assert.match(lines[2], /^error/); assert.doesNotMatch(lines[2], /Denied/);
});

test('desktop inline status word: "Denied" for a denied call, "Error" for an ordinary error, "Done" for success', () => {
  const act = [{ type: 'call', tool: 'Bash', input: 'a' }, { type: 'result', output: SDK_WRAPPED }, { type: 'call', tool: 'Bash', input: 'b' }, { type: 'result', output: 'Error: x' },
    { type: 'call', tool: 'Bash', input: 'c' }, { type: 'result', output: 'ok' }];
  const lines = D.buildToolsHtml(act, false).split('<div class="tool-call-line ').slice(1);
  assert.match(lines[0], /tool-call-status error">Denied</); assert.doesNotMatch(lines[0], />Error</);
  assert.match(lines[1], /tool-call-status error">Error</); assert.doesNotMatch(lines[1], />Denied</);
  assert.match(lines[2], /tool-call-status done">Done</);
});

test('phone screen-reader status text: "<tool> denied" for a denied call, "<tool> done" otherwise', () => {
  const F = new Function(`${['toolResultDenied', 'feedStatus'].map(n => extract(mjs, n)).join('\n')}
    const clipText = (s) => s; const workerName = () => 'w'; return { feedStatus };`)();
  const feed = (output, status = 'done') => ({ items: new Map([['t', { kind: 'tool', id: 't', tool: 'Read', status, summary: 's', output }]]) });
  assert.strictEqual(F.feedStatus(feed(DENIED_POLICY)), 'Read denied');
  assert.strictEqual(F.feedStatus(feed(SDK_WRAPPED)), 'Read denied');
  assert.strictEqual(F.feedStatus(feed('file contents')), 'Read done');
  assert.strictEqual(F.feedStatus(feed('Error: boom')), 'Read done');
  assert.strictEqual(F.feedStatus(feed(DENIED_POLICY, 'running')), 'running Read: s');
});

test('desktop live and reloaded paths test the result with the helper', () => {
  assert.match(app, /status: it\.done \? \(\/\^\(Error\|⚠\|✗\)\/\.test\(it\.output \|\| ''\) \|\| toolResultDenied\(it\.output\) \? 'error' : 'done'\) : 'running'/);
  assert.match(app, /runningTool\.status = oc2\.output\?\.startsWith\('Error'\) \|\| toolResultDenied\(oc2\.output\) \? 'error' : 'done';/);
});

// ── phone ──
function fakeEl() {
  const el = { children: [], attrs: {}, classes: new Set(), dataset: {}, textContent: '', className: '', parentNode: null,
    classList: { add: (c) => el.classes.add(c) }, removeAttribute: (k) => { delete el.attrs[k]; }, replaceChildren: (...a) => { el.textContent = a.map(x => (typeof x === 'string' ? x : x.textContent)).join(''); },
    appendChild: (c) => { c.parentNode = el; el.children.push(c); } };
  Object.defineProperty(el, 'title', { get: () => el.attrs.title, set: (v) => { el.attrs.title = v; } });
  return el;
}
function phoneRow(output, status = 'done') {
  const it = { kind: 'tool', id: 't1', tool: 'Read', status, summary: 'f', output };
  const P = new Function('fakeEl', `${['toolResultDenied', 'tsnFailed', 'tsnEntryText', 'paintFeedRow'].map(n => extract(mjs, n)).join('\n')}
    const document = { createElement: () => fakeEl() }; const clipText = (s) => s; const workerName = () => 'w'; const shortModel = (m) => m; const tailText = (s) => s;
    return { paintFeedRow, tsnEntryText, tsnFailed };`)(fakeEl);
  const list = fakeEl();
  // build the row's three children the way paintFeedRow's innerHTML does
  const origCreate = list.appendChild;
  list.appendChild = (c) => { c.children = [fakeEl(), fakeEl(), fakeEl()]; origCreate(c); };
  P.paintFeedRow({}, it, list);
  return { it, line: it.el.children[0], P };
}

test('phone feed: a denied Read and Bash show ✗, red "failed" class and the tooltip; success stays ✓; an ordinary error stays ✗', () => {
  for (const out of [DENIED_POLICY, DENIED_OWNER]) {
    const { it, line, P } = phoneRow(out);
    assert.ok(line.textContent.startsWith('✗ '), line.textContent);
    assert.strictEqual(line.title, 'Denied by policy');
    assert.ok(it.el.classes.has('failed'));
    assert.strictEqual(P.tsnFailed(it), true);
    assert.ok(P.tsnEntryText(it).startsWith('✗ Read'), 'the full-screen list marks it too');
  }
  const ok = phoneRow('file contents');
  assert.ok(ok.line.textContent.startsWith('✓ ')); assert.strictEqual(ok.line.title, undefined); assert.ok(!ok.it.el.classes.has('failed'));
  const mention = phoneRow('The policy says [DENIED BY POLICY] in the docs');
  assert.ok(mention.line.textContent.startsWith('✓ '));
  const err = phoneRow('Error: ENOENT');
  assert.ok(err.line.textContent.startsWith('✗ ')); assert.strictEqual(err.line.title, undefined); assert.ok(err.it.el.classes.has('failed'));
  const running = phoneRow(DENIED_POLICY, 'running');
  assert.ok(running.line.textContent.startsWith('⚙ '), 'a call still running is not marked');
});
