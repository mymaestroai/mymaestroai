'use strict';
// The Teams tree reads as a tree: a row is always indented further right than the row it reports to (phone, Simple, desktop).
// No browser here: the x offsets are computed from the CSS rules themselves (the numbers are CSS variables / declarations), and the
// markup is rendered by the real functions to check which wrapper each row sits in.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const mjs = read('mobile.js'), mhtml = read('mobile.html'), app = read('app.js'), ihtml = read('index.html');
const hubTeams = require('../lib/ui-teams.js');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── a tiny CSS reader: the body of the first rule whose selector is exactly `sel` ──
function body(css, sel) {
  const re = new RegExp('^\\s*' + sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&') + ' \\{([^}]*)\\}', 'm');
  const m = re.exec(css);
  assert.ok(m, 'CSS rule: ' + sel);
  return m[1];
}
function vars(css) {
  const out = {};
  for (const m of css.matchAll(/(--[a-z-]+):\s*(-?[\d.]+)px/g)) out[m[1]] = parseFloat(m[2]);
  return out;
}
function px(v, V) {
  const m = /var\((--[a-z-]+)\)/.exec(v);
  if (m) { assert.ok(m[1] in V, 'variable ' + m[1]); return V[m[1]]; }
  return parseFloat(v);
}
function prop(b, name, V) {
  const m = new RegExp('(?:^|[;\\s])' + name + ':\\s*([^;]+)').exec(b);
  assert.ok(m, name + ' in { ' + b.trim() + ' }');
  return px(m[1].trim(), V);
}
// padding-left of a `padding: a b c d` shorthand
function padL(b) {
  const m = /(?:^|[;\s])padding:\s*([^;]+)/.exec(b);
  assert.ok(m, 'padding in ' + b);
  const v = m[1].trim().split(/\s+/).map(parseFloat);
  return v.length === 1 ? v[0] : v.length === 2 ? v[1] : v.length === 3 ? v[1] : v[3];
}

// ── the real phone / desktop renderers on a small company ──
const slice = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + a.length); assert.ok(i >= 0 && j > i, a); return src.slice(i, j); };
function phoneHtml(agents, open) {
  const names = ['esc', 'hubTeams', 'window', 'isAdmin', 'agents', 'live', 'unread', 'statusKnown', 'isBusy', 'busyText', 'shortModel', 'workingFilter', 'AgentDot', 'bgStateOf', 'bgCountOf', 'loadJson', 'saveJson', 'localStorage', 'document', 'screen', 'renderAgents', 'renderBgChip', 'buildingTeam'];
  const store = { 'hub-teams-open': JSON.stringify(open) };
  const vals = [esc, hubTeams, { hubTeams }, () => true, agents, {}, {}, true, () => false, () => '', (m) => String(m), false, require('../lib/ui-agent-dot.js'), () => 'free', () => 0,
    (k, d) => { try { return JSON.parse(store[k]) ?? d; } catch { return d; } }, (k, v) => { store[k] = JSON.stringify(v); },
    { getItem: (k) => (k in store ? store[k] : null), setItem() {} }, { querySelectorAll: () => [] }, 'agents', () => {}, () => {}, () => false];
  const src = slice(mjs, '// ── Teams view of the agent list', '// One row of the agent list') + '\n' + slice(mjs, 'function agentRowHtml(', '// The Active section at the top') +
    '\nreturn teamsListHtml();';
  return new Function(...names, src)(...vals);
}
const A = (name, extra) => Object.assign({ name, display: name[0].toUpperCase() + name.slice(1), category: 'specialist' }, extra);

// ── PHONE ──
test('phone: the indent numbers come out so every row is right of its boss (390px)', () => {
  const V = vars(mhtml.slice(mhtml.indexOf('html { --vvh: 100vh; --tm-bar')));
  for (const k of ['--tm-bar', '--tm-gap', '--tm-kid-bar', '--tm-kid-gap', '--tm-deep-bar']) assert.ok(k in V, k);
  const fold = prop(body(mhtml, '.tm-fold, .tm-fold-sp'), 'width', V);
  const rowPad = padL(body(mhtml, '.agent-row')), rowGap = prop(body(mhtml, '.agent-row'), 'gap', V);
  const icon = prop(body(mhtml, '.agent-icon'), 'width', V);
  const mainIcon = fold + rowPad, mainName = mainIcon + icon + rowGap;
  assert.deepStrictEqual([mainIcon, mainName], [54, 102]);
  // direct reports sit in .tm-leaders
  const lead = body(mhtml, '.tm-leaders');
  const leadersAt = prop(lead, 'margin-left', V) + 1 + prop(lead, 'padding-left', V);
  assert.match(lead, /border-left: 1px solid var\(--border-strong\)/, 'the connector line');
  // a direct worker: no fold, worker padding
  const wPad = padL(body(mhtml, '.tm-r-worker > .tm-line > .agent-row'));
  const workerIcon = leadersAt + wPad;
  assert.ok(workerIcon >= mainName, `direct worker icon ${workerIcon} >= main name ${mainName}`);
  assert.strictEqual(workerIcon, 107);
  // a leader row: its own (36px) fold at the far left of its row, then its icon
  const lFold = prop(body(mhtml, '.tm-r-leader > .tm-line > .tm-fold, .tm-r-leader > .tm-line > .tm-fold-sp'), 'width', V);
  const lPad = padL(body(mhtml, '.tm-r-leader > .tm-line > .agent-row'));
  const lIconW = prop(body(mhtml, '.tm-r-leader .agent-icon'), 'width', V);
  const leaderIcon = leadersAt + lFold + lPad, leaderName = leaderIcon + lIconW + rowGap;
  assert.ok(leaderIcon >= mainName, `leader icon ${leaderIcon} >= main name ${mainName}`);
  // the leader's workers sit in .tm-kids inside the leader's block
  const kids = body(mhtml, '.tm-kids');
  assert.match(kids, /border-left: 1px solid var\(--border-strong\)/);
  const kidWorkerIcon = leadersAt + prop(kids, 'margin-left', V) + 1 + prop(kids, 'padding-left', V) + wPad;
  assert.ok(kidWorkerIcon >= leaderName, `leader's worker icon ${kidWorkerIcon} >= leader name ${leaderName}`);
  assert.deepStrictEqual([leaderIcon, leaderName, kidWorkerIcon], [139, 179, 179]);
  // a worker that has people under it: its own fold, then deeper again
  const wFold = prop(body(mhtml, '.tm-r-worker > .tm-line > .tm-fold'), 'width', V);
  const wIconW = prop(body(mhtml, '.tm-r-worker > .tm-line .agent-icon'), 'width', V);
  const wGap = prop(body(mhtml, '.tm-r-worker > .tm-line > .agent-row'), 'gap', V);
  const boxAt = leadersAt + prop(kids, 'margin-left', V) + 1 + prop(kids, 'padding-left', V);
  const deepName = boxAt + wFold + wPad + wIconW + wGap;
  const deepIcon = boxAt + prop(body(mhtml, '.tm-block .tm-block > .tm-kids'), 'margin-left', V) + 1 + wPad;
  assert.ok(deepIcon >= deepName, `deeper worker icon ${deepIcon} >= its boss's name ${deepName}`);
  // the line hangs under the boss's icon centre: main icon 54..90 -> 72; --tm-bar 71 + 1px
  assert.strictEqual(prop(lead, 'margin-left', V), 71);
  // 36px tap targets and the smaller worker look stay
  assert.ok(prop(body(mhtml, '.tm-r-worker > .tm-line > .agent-row'), 'min-height', V) >= 36);
  assert.ok(prop(body(mhtml, '.tm-r-worker > .tm-line > .tm-fold'), 'min-height', V) >= 36);
  assert.match(mhtml, /\.tm-r-worker > \.tm-line \.agent-name \{ font-size: 12\.5px/);
});

test('phone: main with three direct reports, and a main with a leader that has two workers (markup)', () => {
  const h = phoneHtml([A('maestro', { category: 'primary', lead: true }), A('r1', { reportsTo: 'maestro' }), A('r2', { reportsTo: 'maestro' }), A('r3', { reportsTo: 'maestro' }),
    A('boss', { category: 'primary' }), A('lead1', { reportsTo: 'boss' }), A('w1', { reportsTo: 'lead1' }), A('w2', { reportsTo: 'lead1' })], { maestro: true, boss: true, lead1: true });
  const mb = h.slice(h.indexOf('data-agent="maestro"'), h.indexOf('data-agent="boss"'));
  const wrap = mb.indexOf('<div class="tm-leaders">');
  assert.ok(wrap > 0, 'reports are inside the indented wrapper');
  for (const n of ['r1', 'r2', 'r3']) assert.ok(mb.indexOf(`data-agent="${n}"`) > wrap, n + ' under the wrapper');
  assert.strictEqual((mb.match(/tm-block tm-r-worker/g) || []).length, 3);
  assert.strictEqual((mb.match(/class="tm-fold"/g) || []).length, 1, 'one fold arrow: the main row');
  const bb = h.slice(h.indexOf('data-agent="boss"'));
  const lw = bb.indexOf('<div class="tm-leaders">'), kids = bb.indexOf('<div class="tm-kids">');
  assert.ok(lw > 0 && kids > lw, 'leader inside the main wrapper, its workers in .tm-kids after the leader row');
  assert.ok(bb.indexOf('data-agent="lead1"') < kids && kids < bb.indexOf('data-agent="w1"') && bb.indexOf('data-agent="w1"') < bb.indexOf('data-agent="w2"'));
  assert.ok(/data-fold="lead1"/.test(bb), 'the leader keeps its own fold arrow');
});

test('phone: Build team sits in the main agent\'s row area as the compact "No team yet · Build team" line, not a button of its own', () => {
  const h = phoneHtml([A('solo', { category: 'primary' }), A('b', { category: 'primary' }), A('c', { reportsTo: 'b' })], {});
  assert.doesNotMatch(h, /tm-build"|build-team-btn/);
  assert.doesNotMatch(h, /tm-build-line|class="build-line/, 'no line of its own below the row');
  assert.match(h, /<button class="agent-row" data-agent="solo">(?:(?!<\/button>)[\s\S])*<div class="agent-model agent-build-sub">No team yet · <span role="button" tabindex="0" class="build-team-link" data-build-team="solo">Build team<\/span><\/div>(?:(?!<\/button>)[\s\S])*<\/button><\/div>/, 'the link is the second line inside the agent-row of that agent');
  assert.strictEqual((h.match(/data-build-team=/g) || []).length, 1, 'only the main without a team');
  const V = {};
  assert.ok(!/\.tm-build-line/.test(mhtml));
  const lk = body(mhtml, '.agent-build-sub .build-team-link');
  assert.ok(prop(lk, 'padding', V) !== undefined || /padding: 10px 8px/.test(lk), 'padding makes the tap area >= 36px');
  assert.match(lk, /padding: 10px 8px; margin: -10px -8px -10px -2px/, '17px line + 2 x 10px = 37px tap area, margin takes it back so the row keeps its height');
  assert.ok(!/\.tm-build \{/.test(mhtml));
});

// ── Simple (phone): .sa-row with --d ──
test('Simple (phone sheet and wide side list): a direct report starts right of the main agent\'s name, with a line under the main\'s icon', () => {
  const V = vars(mhtml);
  const sheetRow = body(mhtml, 'html.mm-simple .sa-row').includes('gap: 14px') ? body(mhtml, 'html.mm-simple .sa-row') : null;
  const base = mhtml.split('\n').find((l) => /^html\.mm-simple \.sa-row \{ display: flex/.test(l));
  assert.ok(base && sheetRow === null || sheetRow);
  const gap = parseFloat(/gap: (\d+)px/.exec(base)[1]);
  const pad = padL(base.replace(/^.*?\{/, ''));
  const icW = prop(body(mhtml, 'html.mm-simple .sa-ic'), 'width', V);
  const mainName = pad + icW + gap;
  const step = V['--sa-step'];   // the last --sa-step in the sheet is the 50px one
  const sheet = /html\.mm-simple \{ --sa-step: (\d+)px; --sa-bar: (\d+)px; \}/.exec(mhtml);
  assert.ok(sheet && mhtml.includes('html.mm-simple .sa-row { padding-left: calc(12px + var(--d, 0) * var(--sa-step)); }'), 'sheet rule');
  assert.ok(12 + 1 * Number(sheet[1]) >= mainName, `sheet: depth-1 icon ${12 + Number(sheet[1])} >= main name ${mainName}`);
  assert.ok(Number(sheet[2]) > 12 && Number(sheet[2]) < 12 + icW, 'line under the main icon');
  const side = /html\.mm-simple #simple-side \{ --sa-step: (\d+)px; --sa-bar: (\d+)px; \}[^\n]*\n\s*html\.mm-simple #simple-side \.sa-row \{ padding-left: calc\(12px \+ var\(--d, 0\) \* var\(--sa-step\)\); \}/.exec(mhtml);
  assert.ok(side, 'side rule');
  const sideName = 12 + prop(body(mhtml, 'html.mm-simple #simple-side .sa-ic').replace(/^/, ''), 'width', V) + 10;
  assert.ok(12 + Number(side[1]) >= sideName, `side: depth-1 icon ${12 + Number(side[1])} >= main name ${sideName}`);
  assert.ok(step >= 0);
  assert.match(mjs, /if \(opts\.depth >= 1\) b\.classList\.add\('sa-kid'\)/);
  assert.match(mhtml, /\.sa-row\.sa-kid::before \{[^}]*width: 1px[^}]*var\(--border-strong\)/);
});

// ── DESKTOP ──
test('desktop: the indent numbers put every row\'s icon at least one step right of its boss\'s icon', () => {
  const V = vars(ihtml.slice(ihtml.indexOf('--tm-step: 18px')));
  const step = V['--tm-step'];
  const fold = prop(body(ihtml, '.teams-fold'), 'width', V), lineGap = prop(body(ihtml, '.teams-line'), 'gap', V);
  const row = body(ihtml, '.teams-row'), rowGap = prop(row, 'gap', V);
  const mainIcon = fold + lineGap + 1 + padL(row) + prop(body(ihtml, '.teams-dot'), 'width', V) + rowGap;
  assert.strictEqual(mainIcon, 53);
  const lead = body(ihtml, '.teams-leaders');
  assert.match(lead, /border-left: 1px solid var\(--border-strong\)/);
  const at = prop(lead, 'margin-left', V) + 1 + prop(lead, 'padding-left', V);
  // direct worker (fold hidden): its icon
  const wRow = body(ihtml, '.teams-row.rank-worker');
  const wDot = prop(body(ihtml, '.teams-row.rank-worker .teams-dot'), 'width', V);
  const wIconOff = 1 + padL(wRow) + wDot + prop(wRow, 'gap', V);
  assert.match(ihtml, /\.teams-line\.rank-worker > \.teams-fold\.none \{ display: none; \}/);
  assert.ok(at + wIconOff >= mainIcon + step, `direct worker icon ${at + wIconOff} >= ${mainIcon + step}`);
  // leader: its hidden fold takes no room now
  assert.match(ihtml, /\.teams-line\.rank-leader > \.teams-fold\.none \{ display: none; \}/);
  const lRow = body(ihtml, '.teams-row.rank-leader');
  const leaderIcon = at + 1 + padL(lRow) + prop(body(ihtml, '.teams-dot'), 'width', V) + rowGap;
  assert.ok(leaderIcon >= mainIcon + step, `leader icon ${leaderIcon}`);
  // the leader's workers
  const kids = body(ihtml, '.teams-kids');
  assert.match(kids, /border-left: 1px solid var\(--border-strong\)/);
  const kidBox = at + prop(kids, 'margin-left', V) + 1 + prop(kids, 'padding-left', V);
  const kidIcon = kidBox + wIconOff;
  assert.ok(kidIcon >= leaderIcon + step, `leader's worker icon ${kidIcon} >= ${leaderIcon + step}`);
  const deepIcon = kidBox + prop(body(ihtml, '.teams-block .teams-block > .teams-kids'), 'margin-left', V) + 1 + prop(kids, 'padding-left', V) + wIconOff;
  assert.ok(deepIcon >= kidIcon + step, 'a worker\'s own people step right again');
  assert.deepStrictEqual([mainIcon, at + wIconOff, leaderIcon, kidIcon], [53, 71, 79, 97]);
});

test('desktop: markup order (direct reports inside .teams-leaders after the main row; workers inside .teams-kids after their leader); Build Team stays inside the row', () => {
  const fn = (name) => { const a = app.indexOf('function ' + name + '('); const open = app.indexOf('{', app.indexOf(')', a)); let d = 0; for (let i = open; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(a, i + 1); } };
  assert.match(fn('teamsBlockHtml'), /teams-block rank-\$\{rank\}\$\{lo\}">\$\{teamsRowHtml\(n, false, parent\)\}\$\{teamsSubtreeHtml\(n\)\}/);
  const sub = fn('teamsSubtreeHtml');
  assert.match(sub, /n\.depth === 0 \? 'teams-leaders' : 'teams-kids'/);
  const rowSrc = fn('teamsRowHtml');
  assert.ok(rowSrc.includes("${buildBtn && sub === 'No team yet' ? '<span class=\"tbs-prefix\">No team yet · </span>' + buildBtn : subText}</span>"), 'the Build Team link ends the "No team yet" sub-line');
  assert.ok(rowSrc.indexOf('class="teams-row') < rowSrc.indexOf('<span class="teams-info">') && rowSrc.indexOf('<span class="teams-info">') < rowSrc.indexOf('${subHtml}'), 'and that sub-line sits inside the row (teams-info)');
  assert.match(rowSrc, /buildTeamCtlHtml\(a, 'link', 'span'\)/, 'a small link, not the bordered button');
});

// ── page fixes after the design review: Simple indent, leaders' folds, the 160px sidebar ──
test('item 1 + 4 (desktop Simple): numbers - a direct report\'s icon is right of the main\'s name (90 / 90); a leader\'s worker icon is right of the leader\'s name (136 / 136)', () => {
  const V = vars(ihtml.slice(ihtml.indexOf('--tm-step: 18px')));
  for (const k of ['--tms-bar', '--tms-kid-bar', '--tms-fold']) V[k] = Number(new RegExp('html \\{[^}]*' + k + ': (\\d+)px').exec(ihtml)[1]);   // the defaults in html { } (the 160px rules set their own further down)
  const S = (sel) => body(ihtml, 'html.mm-simple #teams-list ' + sel);
  const baseRow = S('.teams-row');
  const fold = prop(body(ihtml, '.teams-fold'), 'width', V), lineGap = prop(body(ihtml, '.teams-line'), 'gap', V);
  const dot = prop(body(ihtml, '.teams-dot'), 'width', V);
  const mainName = fold + lineGap + padL(baseRow) + dot + prop(baseRow, 'gap', V) + prop(S('.teams-row .agent-icon'), 'width', V) + prop(baseRow, 'gap', V);
  assert.strictEqual(mainName, 90);
  const lead = S('.teams-leaders');
  const box = prop(lead, 'margin-left', V) + 1 + prop(body(ihtml, '.teams-leaders'), 'padding-left', V);
  assert.strictEqual(V['--tms-bar'], 52);
  // a direct worker: no fold, the worker row
  const wRow = S('.teams-row.rank-worker'), wDot = prop(body(ihtml, '.teams-row.rank-worker .teams-dot'), 'width', V);
  const wIcon = box + padL(wRow) + wDot + prop(wRow, 'gap', V);
  assert.ok(wIcon >= mainName, `direct worker icon ${wIcon} >= main name ${mainName}`);
  assert.strictEqual(wIcon, 90);
  // a leader: its own fold column (Simple only), then the row
  const lFold = prop(S('.teams-fold-leader'), 'width', V), lGap = prop(S('.teams-line.rank-leader'), 'gap', V);
  const lRow = S('.teams-row.rank-leader');
  const lIcon = box + lFold + lGap + padL(lRow) + dot + prop(lRow, 'gap', V);
  const lName = lIcon + prop(S('.teams-row.rank-leader .agent-icon'), 'width', V) + prop(lRow, 'gap', V);
  assert.ok(lIcon >= mainName, `leader icon ${lIcon} >= main name ${mainName}`);
  // the leader's workers: .teams-kids inside the leader's block (box), then the worker row
  const kids = S('.teams-block.leader-open > .teams-kids');
  const kidBox = box + prop(kids, 'margin-left', V) + 1 + prop(body(ihtml, '.teams-kids'), 'padding-left', V);
  const kidIcon = kidBox + padL(wRow) + wDot + prop(wRow, 'gap', V);
  assert.ok(kidIcon >= lName, `leader's worker icon ${kidIcon} >= leader name ${lName}`);
  assert.deepStrictEqual([lIcon, lName, kidIcon], [106, 136, 136]);
  assert.match(body(ihtml, '.teams-kids'), /border-left: 1px solid var\(--border-strong\)/, 'the connector line');
  // worker rows one size down from the leader (the Simple worker ranks)
  assert.ok(prop(S('.teams-row.rank-worker .name'), 'font-size', V) < prop(S('.teams-row.rank-leader .name'), 'font-size', V));
  assert.ok(prop(S('.teams-row.rank-worker .agent-icon'), 'font-size', V) < prop(S('.teams-row.rank-leader .agent-icon'), 'font-size', V));
});
test('item 5 (desktop Teams at 160px): the empty fold column keeps its width, so every main row starts at the same x (22) with or without an arrow', () => {
  const V = vars(ihtml.slice(ihtml.indexOf('--tm-step: 18px')));
  const a = ihtml.indexOf('@container (max-width: 190px)'), blk = ihtml.slice(a, ihtml.indexOf('\n    }\n', a));
  assert.ok(!/teams-fold/.test(blk), 'no narrow rule changes the fold column');
  assert.match(ihtml, /\.teams-fold\.none \{ visibility: hidden; \}/, 'hidden, not removed');
  const fold = prop(body(ihtml, '.teams-fold'), 'width', V), gap = prop(body(ihtml, '.teams-line'), 'gap', V);
  assert.strictEqual(fold + gap, 22, 'a main row starts at 22 whether its arrow is drawn or not');
  // leaders and workers carry their margin and bar variables into the narrow rules, so the Simple rules do not undo them
  assert.match(blk, /\.teams-leaders \{ margin-left: 10px; --tms-bar: 10px; \}/);
  assert.match(blk, /\.teams-kids \{ margin-left: 10px; padding-left: 4px; --tms-kid-bar: 10px; \}/);
});
test('item 1 (phone Simple): a leader\'s worker icon starts right of the leader\'s name (sheet 112 / 106, side list 92 / 86), with a line under the leader\'s icon centre', () => {
  const V = vars(mhtml);
  V['--sa-bar2'] = Number(/html \{[^}]*--sa-bar2: (\d+)px/.exec(mhtml)[1]);
  const sheet = /html\.mm-simple \{ --sa-step: (\d+)px; --sa-bar: (\d+)px; \}/.exec(mhtml), side = /html\.mm-simple #simple-side \{ --sa-step: (\d+)px; --sa-bar: (\d+)px; \}/.exec(mhtml);
  const lIcon = (w) => prop(body(mhtml, w), 'width', V);
  const sheetRow = mhtml.split('\n').find((l) => /^html\.mm-simple \.sa-row \{ display: flex/.test(l));
  const gapS = parseFloat(/gap: (\d+)px/.exec(sheetRow)[1]);
  const leaderIcon = 12 + Number(sheet[1]), leaderName = leaderIcon + lIcon('html.mm-simple .sa-rank-leader .sa-ic') + gapS;
  const workerIcon = 12 + 2 * Number(sheet[1]);
  assert.deepStrictEqual([leaderName, workerIcon], [106, 112]);
  assert.ok(workerIcon >= leaderName);
  assert.strictEqual(V['--sa-bar2'], leaderIcon + lIcon('html.mm-simple .sa-rank-leader .sa-ic') / 2, 'the second line hangs under the leader\'s icon centre (sheet)');
  const sideIcon = 12 + Number(side[1]), sideLeaderIc = lIcon('html.mm-simple #simple-side .sa-rank-leader .sa-ic');
  const sideGap = parseFloat(/#simple-side \.sa-row \{[^}]*gap: (\d+)px/.exec(mhtml)[1]);
  const sideName = sideIcon + sideLeaderIc + sideGap, sideWorker = 12 + 2 * Number(side[1]);
  assert.deepStrictEqual([sideName, sideWorker], [86, 92]);
  assert.match(mhtml, /html\.mm-simple #simple-side \{ --sa-bar2: 64px; \}/);
  assert.strictEqual(sideIcon + sideLeaderIc / 2, 64, 'side: leader icon 52 + half of 24 = 64');
  assert.match(mhtml, /html\.mm-simple \.sa-row\.sa-kid2::after \{[^}]*left: var\(--sa-bar2\)[^}]*width: 1px/);
  assert.match(mhtml, /html\.mm-simple \.sa-fold-arrow \{[^}]*min-width: 36px; min-height: 36px;/, '36px tap target');
});
