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
// Changed (redesign: sections, size pill, one-line members): the indent no longer comes from --tm-bar / .tm-leaders / a left fold column; every row is a .tm-line with its own padding, joined by .tm-v lines at --tm-x1 / --tm-x2.
test('phone: the indent numbers come out so every row is right of its boss (390px)', () => {
  const V = vars(mhtml);
  const row = (rank) => body(mhtml, '.tm-line.tm-r-' + rank + ' > .agent-row');
  const icon = prop(body(mhtml, '.agent-icon'), 'width', V);
  // main: no fold column any more (the pill is after the name), icon at the row padding
  const mainIcon = padL(row('main')), mainName = mainIcon + icon + prop(row('main'), 'gap', V);
  assert.deepStrictEqual([mainIcon, mainName], [14, 62], 'main: icon 14, name 62 (page x = list x, the list has no left padding)');
  // a direct report (worker rank at level 1): icon right of the main's name
  const memberIcon = padL(row('worker'));
  assert.ok(memberIcon >= mainName, `member icon ${memberIcon} >= main name ${mainName}`);
  // a leader (level 1): same left as a member, its name ends before its own workers' icons
  const lIconW = prop(body(mhtml, '.tm-line.tm-r-spec .agent-icon, .tm-line.tm-r-leader .agent-icon'), 'width', V);
  const leaderIcon = padL(row('leader')), leaderName = leaderIcon + lIconW + prop(row('leader'), 'gap', V);
  assert.ok(leaderIcon >= mainName, `leader icon ${leaderIcon} >= main name ${mainName}`);
  // the leader's workers (level 2): further right than the leader's name
  const kidIcon = prop(body(mhtml, '.tm-line.tm-r-worker.tm-lv2 > .agent-row'), 'padding-left', V);
  assert.ok(kidIcon >= leaderName, `leader's worker icon ${kidIcon} >= leader name ${leaderName}`);
  assert.deepStrictEqual([memberIcon, leaderIcon, leaderName, kidIcon], [64, 64, 102, 104]);
  // the joining lines: x1 under the main's icon centre (14 + 36/2 = 32), x2 under the leader's icon centre (64 + 28/2 = 78), a tick into each row
  const line = body(mhtml, '.tm-line');
  assert.deepStrictEqual([prop(line, '--tm-x1', V), prop(line, '--tm-x2', V)], [32, 78]);
  assert.strictEqual(mainIcon + icon / 2, 32);
  assert.strictEqual(leaderIcon + lIconW / 2, 78);
  assert.match(body(mhtml, '.tm-x1'), /left: var\(--tm-x1\)/);
  assert.match(body(mhtml, '.tm-x2'), /left: var\(--tm-x2\)/);
  assert.match(body(mhtml, '.tm-v'), /width: 1px; background: var\(--border-strong\)/);
  assert.match(body(mhtml, '.tm-tk'), /height: 1px; background: var\(--border-strong\)/);
  // 36px tap targets (member row, the pill button) stay
  assert.ok(prop(row('worker'), 'min-height', V) >= 36);
  assert.ok(prop(body(mhtml, '.tm-pill-btn'), 'height', V) >= 36);
});

// Changed (redesign: sections, size pill, one-line members): no .tm-leaders / .tm-kids wrappers and no fold arrow; each row is a flat .tm-line with a joining line, the fold is the pill (data-fold).
test('phone: main with three direct reports, and a main with a leader that has two workers (markup)', () => {
  const h = phoneHtml([A('maestro', { category: 'primary', lead: true }), A('r1', { reportsTo: 'maestro' }), A('r2', { reportsTo: 'maestro' }), A('r3', { reportsTo: 'maestro' }),
    A('boss', { category: 'primary' }), A('lead1', { reportsTo: 'boss' }), A('w1', { reportsTo: 'lead1' }), A('w2', { reportsTo: 'lead1' })], { maestro: true, boss: true, lead1: true });
  const mb = h.slice(h.indexOf('data-agent="maestro"'), h.indexOf('data-agent="boss"'));
  const at = (src, n) => src.indexOf(`data-agent="${n}"`);
  assert.strictEqual((mb.match(/tm-line tm-r-worker tm-lv1/g) || []).length, 3, 'three direct reports, one level below the main');
  assert.ok(at(mb, 'r1') > 0 && at(mb, 'r1') < at(mb, 'r2') && at(mb, 'r2') < at(mb, 'r3'), 'after the main row, in order');
  assert.strictEqual((mb.match(/class="tm-pill-btn" data-fold=/g) || []).length, 1, 'one pill: the main row');
  assert.doesNotMatch(h, /class="tm-fold"|tm-leaders|tm-kids|Reports to/, 'no fold arrow, no wrappers, no Reports to line');
  // every member row carries its joining line (x1 + a tick); the last one ends it
  for (const n of ['r1', 'r2', 'r3']) {
    const rowHtml = mb.slice(mb.lastIndexOf('<div class="tm-line', at(mb, n)), at(mb, n));
    assert.match(rowHtml, /tm-v tm-x1/, n + ' has its joining line');
    assert.match(rowHtml, /tm-tk tm-x1/, n + ' has its tick');
  }
  assert.match(mb.slice(mb.lastIndexOf('<div class="tm-line', at(mb, 'r3')), at(mb, 'r3')), /tm-v tm-x1 tm-end/, 'the line stops at the last report');
  const bb = h.slice(h.indexOf('data-agent="boss"'));
  assert.ok(at(bb, 'boss') < at(bb, 'lead1') && at(bb, 'lead1') < at(bb, 'w1') && at(bb, 'w1') < at(bb, 'w2'), 'main, leader, then the leader\'s workers');
  assert.match(bb.slice(bb.indexOf('<div class="tm-line tm-r-leader'), at(bb, 'lead1')), /tm-lv1[\s\S]*tm-v tm-x2 tm-from/, 'the leader\'s own line starts under its icon');
  assert.strictEqual((bb.match(/tm-line tm-r-worker tm-lv2/g) || []).length, 2, 'the leader\'s workers are one level deeper');
  for (const n of ['w1', 'w2']) assert.match(bb.slice(bb.lastIndexOf('<div class="tm-line', at(bb, n)), at(bb, n)), /tm-v tm-x2[\s\S]*tm-tk tm-x2/, n + ' hangs on the x2 line');
  assert.ok(/data-fold="lead1"/.test(bb), 'the leader keeps its own fold control (its pill)');
});

// Changed (redesign: sections, size pill, one-line members): the line is now just "Build team" (the "No team yet" section header says the rest), as the second .agent-model line inside a main's agent-meta, only in the No team yet section.
test('phone: Build team sits in the main agent\'s row (its second line) in the No team yet section, not a button of its own', () => {
  const h = phoneHtml([A('solo', { category: 'primary' }), A('b', { category: 'primary' }), A('c', { reportsTo: 'b' })], {});
  assert.doesNotMatch(h, /tm-build"|build-team-btn/);
  assert.doesNotMatch(h, /tm-build-line|class="build-line/, 'no line of its own below the row');
  assert.match(h, /<button class="agent-row" data-agent="solo">(?:(?!<\/button>)[\s\S])*<div class="tm-l1">(?:(?!<\/button>)[\s\S])*<\/div><div class="agent-model agent-build-sub agent-build-only"><span role="button" tabindex="0" class="build-team-link" data-build-team="solo">Build team<\/span><\/div>(?:(?!<\/button>)[\s\S])*<\/button><\/div>/, 'the link is the second line (after the name line) inside the agent-row of that agent');
  assert.strictEqual((h.match(/data-build-team=/g) || []).length, 1, 'only the main without a team');
  // it sits under the "No team yet" header, not under Teams
  const none = h.indexOf('data-tm-sec="none"'), teams = h.indexOf('data-tm-sec="teams"');
  assert.ok(teams >= 0 && none > teams && h.indexOf('data-build-team="solo"') > none, 'Build team only in the No team yet section');
  assert.ok(!/\.tm-build-line/.test(mhtml));
  const lk = body(mhtml, '.agent-build-sub .build-team-link');
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
// Teams redesign: the fold-arrow column is gone (the pill folds), so the numbers are the new ones. Every x below is px from the left of #teams-list's content box = the spec's x minus 12.
const own = (css, sel, p) => { const m = new RegExp('(?:^|[;\\s{])' + p + ':\\s*(-?[\\d.]+)px').exec(body(css, sel)); assert.ok(m, p + ' in ' + sel); return parseFloat(m[1]); };
const padLeft = (css, sel) => { const b = body(css, sel); const m = /(?:^|[;\s])padding-left:\s*(\d+)px/.exec(b); return m ? parseFloat(m[1]) : padL(b); };
test('desktop sidebar 240: dot / icon / name x of every rank are the spec numbers; every icon starts at or right of its boss\'s name', () => {
  const dot = (sel, d) => { const m = /--dot:\s*(\d+)px/.exec(body(ihtml, sel)); return m ? parseFloat(m[1]) : d; };
  const mainDot = 1 + padLeft(ihtml, '.teams-row');
  const mainIcon = mainDot + dot('.teams-row', 0) + own(ihtml, '.teams-dot', 'margin-right');
  const mainName = mainIcon + own(ihtml, '.teams-row .agent-icon', 'width') + own(ihtml, '.teams-row .agent-icon', 'margin-right');
  assert.deepStrictEqual([mainDot, mainIcon, mainName], [10, 26, 54], 'main card: dot 22, icon 38, name 66 in the mock');
  const wrap = own(ihtml, '.teams-leaders', 'margin-left') + own(ihtml, '.teams-leaders', 'padding-left');
  const W = '.teams-row.rank-worker';
  const mDot = wrap + 1 + padLeft(ihtml, W), mIcon = mDot + dot(W, 0) + own(ihtml, W + ' .teams-dot', 'margin-right');
  const mName = mIcon + own(ihtml, W + ' .agent-icon', 'width') + own(ihtml, W + ' .agent-icon', 'margin-right');
  assert.deepStrictEqual([mDot, mIcon, mName], [44, 54, 76], 'member: dot 56, icon 66, name 88');
  const Lr = '.teams-row.rank-leader';
  const card = wrap + own(ihtml, Lr, 'margin-left'), lDot = card + 1 + padLeft(ihtml, Lr), lIcon = lDot + dot(Lr, 0) + own(ihtml, Lr + ' .teams-dot', 'margin-right');
  const lName = lIcon + own(ihtml, Lr + ' .agent-icon', 'width') + own(ihtml, Lr + ' .agent-icon', 'margin-right');
  assert.deepStrictEqual([card, lDot, lIcon, lName], [40, 49, 60, 84], 'leader card 52, dot 61, icon 72, name 96');
  const kids = wrap + own(ihtml, '.teams-kids', 'margin-left') + own(ihtml, '.teams-kids', 'padding-left');
  const wDot = kids + 1 + own(ihtml, '.teams-kids .teams-row.rank-worker', 'padding-left'), wIcon = wDot + 6 + 4, wName = wIcon + 16 + 6;
  assert.deepStrictEqual([wDot, wIcon, wName], [74, 84, 106], 'the leader\'s workers: dot 86, icon 96, name 118');
  assert.deepStrictEqual([wrap - 1, kids - 1], [36, 69], 'joining lines at 48 and 81');
  assert.ok(mIcon >= mainName && lIcon >= mainName, 'a member\'s and a leader\'s icon start at or right of the main\'s name');
  assert.ok(wIcon >= lName, 'a leader\'s workers start at or right of the leader\'s name');
  // row heights: main card 46, leader card 34, member 26
  assert.deepStrictEqual([own(ihtml, '.teams-row', 'height'), own(ihtml, Lr, 'height'), own(ihtml, W, 'height')], [46, 34, 26]);
  assert.match(body(ihtml, '.teams-block::before'), /width: 1px; background: var\(--tm-line\)/, 'the thin joining line');
});
test('desktop: markup order (direct reports inside .teams-leaders after the main row; workers inside .teams-kids after their leader); Build team stays inside the row', () => {
  const fn = (name) => { const a = app.indexOf('function ' + name + '('); const open = app.indexOf('{', app.indexOf(')', a)); let d = 0; for (let i = open; i < app.length; i++) { if (app[i] === '{') d++; else if (app[i] === '}' && --d === 0) return app.slice(a, i + 1); } };
  assert.match(fn('teamsBlockHtml'), /teams-block rank-\$\{rank\}">\$\{teamsRowHtml\(n, open\)\}\$\{teamsSubtreeHtml\(n, rank === 'leader' \? open : true\)\}/);
  const sub = fn('teamsSubtreeHtml');
  assert.match(sub, /n\.depth === 0 \? 'teams-leaders' : 'teams-kids'/);
  const rowSrc = fn('teamsRowHtml');
  assert.match(rowSrc, /buildTeamCtlHtml\(a, 'link', 'span'\)/, 'a small link, not the bordered button');
  assert.ok(rowSrc.indexOf('class="teams-row') < rowSrc.indexOf('<span class="teams-info">') && rowSrc.indexOf('<span class="teams-info">') < rowSrc.indexOf('${l2}'), 'the second line (the Build team link) sits inside the row (teams-info)');
  assert.ok(rowSrc.indexOf("sec === 'none'") > 0, 'the link is only for the No team yet section');
});
// ── page fixes after the design review: Simple indent, leaders' folds, the 160px sidebar ──
test('Simple desktop: dot / icon / name x of every rank are the spec numbers; every icon starts at or right of its boss\'s name', () => {
  const S = (sel) => 'html.mm-simple #teams-list ' + sel;
  const dot = (sel, d) => { const m = /--dot:\s*(\d+)px/.exec(body(ihtml, S(sel))); return m ? parseFloat(m[1]) : d; };
  const base = '.teams-row';
  const mainDot = padLeft(ihtml, S(base)), mainIcon = mainDot + dot(base, 0) + own(ihtml, S('.teams-dot'), 'margin-right');
  const mainName = mainIcon + own(ihtml, S('.teams-row .agent-icon'), 'width') + own(ihtml, S('.teams-row .agent-icon'), 'margin-right');
  assert.deepStrictEqual([mainDot, mainIcon, mainName], [12, 30, 64], 'Simple main: dot 24, icon 42, name 76');
  const wrap = own(ihtml, S('.teams-leaders'), 'margin-left') + own(ihtml, '.teams-leaders', 'padding-left');
  const W = '.teams-row.rank-worker', Lr = '.teams-row.rank-leader';
  const mDot = wrap + padLeft(ihtml, S(W)), mIcon = mDot + dot(W, 0) + own(ihtml, S(W + ' .teams-dot'), 'margin-right');
  const mName = mIcon + own(ihtml, S(W + ' .agent-icon'), 'width') + own(ihtml, S(W + ' .agent-icon'), 'margin-right');
  assert.deepStrictEqual([mDot, mIcon, mName], [52, 64, 90], 'Simple member: dot 64, icon 76, name 102');
  const lDot = wrap + padLeft(ihtml, S(Lr)), lIcon = lDot + dot(Lr, 0) + own(ihtml, S(Lr + ' .teams-dot'), 'margin-right');
  const lName = lIcon + own(ihtml, S(Lr + ' .agent-icon'), 'width') + own(ihtml, S(Lr + ' .agent-icon'), 'margin-right');
  assert.deepStrictEqual([lDot, lIcon, lName], [52, 64, 94], 'Simple leader: dot 64, icon 76, name 106');
  const kids = wrap + own(ihtml, S('.teams-kids'), 'margin-left') + own(ihtml, '.teams-kids', 'padding-left');
  const wDot = kids + own(ihtml, S('.teams-kids ' + W), 'padding-left'), wIcon = wDot + 6 + own(ihtml, S(W + ' .teams-dot'), 'margin-right');
  const wName = wIcon + own(ihtml, S(W + ' .agent-icon'), 'width') + own(ihtml, S(W + ' .agent-icon'), 'margin-right');
  assert.deepStrictEqual([wDot, wIcon, wName], [82, 94, 120], 'the leader\'s workers: dot 94, icon 106, name 132');
  assert.deepStrictEqual([wrap - 1, kids - 1], [42, 75], 'joining lines at 54 and 87');
  assert.ok(mIcon >= mainName && lIcon >= mainName && wIcon >= lName);
  assert.deepStrictEqual([own(ihtml, S('.teams-row'), 'height'), own(ihtml, S(Lr), 'height'), own(ihtml, S(W), 'height')], [48, 40, 30]);
  assert.ok(own(ihtml, S(W + ' .name'), 'font-size') < own(ihtml, S(Lr + ' .name'), 'font-size'));
});
test('desktop sidebar 160 (narrow container, icons hidden): main name 26, member dot 26 / name 38, leader card 26 / dot 30 / name 40, its workers dot 40 / name 50', () => {
  const a = ihtml.indexOf('@container (max-width: 186px)'), blk = ihtml.slice(a, ihtml.indexOf('\n    }\n', a));
  assert.ok(a > 0);
  const inb = (sel, p) => { const m = new RegExp('^\\s*' + sel.replace(/[.*+?^${}()|[\]\\>]/g, '\\$&') + ' \\{[^}]*?(?:^|[;\\s{])' + p + ':\\s*(-?\\d+)px', 'm').exec(blk); assert.ok(m, p + ' in ' + sel); return parseFloat(m[1]); };
  const mainName = 1 + padLeft(ihtml, '.teams-row') + 8 + own(ihtml, '.teams-dot', 'margin-right');
  const wrap = inb('.teams-leaders', 'margin-left') + own(ihtml, '.teams-leaders', 'padding-left');
  const mDot = wrap + 1 + inb('.teams-row.rank-worker', 'padding-left'), mName = mDot + 6 + inb('.teams-row.rank-worker .teams-dot', 'margin-right');
  const card = wrap + inb('.teams-row.rank-leader', 'margin-left'), lDot = card + 1 + inb('.teams-row.rank-leader', 'padding-left'), lName = lDot + 6 + own(ihtml, '.teams-row.rank-leader .teams-dot', 'margin-right');
  const kids = wrap + inb('.teams-kids', 'margin-left') + own(ihtml, '.teams-kids', 'padding-left');
  const wDot = kids + 1 + inb('.teams-kids .teams-row.rank-worker', 'padding-left'), wName = wDot + 6 + inb('.teams-kids .teams-row.rank-worker .teams-dot', 'margin-right');
  assert.deepStrictEqual([mainName, mDot, mName, card, lDot, lName, wDot, wName], [26, 26, 38, 26, 30, 40, 40, 50]);
  assert.deepStrictEqual([wrap - 1, kids - 1], [14, 33], 'joining lines at 26 and 45');
  assert.match(blk, /\.teams-row \.agent-menu-btn|display: none !important/, 'icons hidden');
  assert.match(ihtml, /\.teams-row \.agent-menu-btn \{ width: 16px;/, 'the ⋯ is 16 px wide at every width');
  assert.match(ihtml, /#teams-list \{ padding: 0 2px; \}/, 'the list content box is 4px narrower than the tab padding: card 12..228 at 240, 12..148 at 160');
  assert.doesNotMatch(ihtml, /\.teams-fold\b/, 'no fold-arrow column in the CSS');
});
test('pill: the tap area is at least 36 x 36 (--tms-fold) while the pill looks 18 px (Simple 20 px); the name truncates before the pill', () => {
  assert.match(ihtml, /html \{ --tms-fold: 36px; \}/);
  const btn = body(ihtml, '.teams-pill-btn::before');
  assert.match(btn, /width: max\(calc\(100% \+ 6px\), var\(--tms-fold\)\); height: var\(--tms-fold\)/);
  assert.match(body(ihtml, '.teams-pill-btn'), /flex: none/, 'never shrinks');
  assert.match(body(ihtml, '.teams-pill'), /height: 18px[^}]*white-space: nowrap/);
  assert.match(ihtml, /html\.mm-simple #teams-list \.teams-pill \{ height: 20px;/);
  assert.match(body(ihtml, '.teams-row .name-text'), /flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis/);
  assert.doesNotMatch(ihtml, /--tms-fold: 16px/);
});
// Changed (redesign: sections, size pill, one-line members): the --sa-step / --sa-bar / --sa-bar2 pseudo lines are gone (content: none); rows take --sa-pl0/1/2 paddings and the .tm-v lines sit at --sa-x1 / --sa-x2.
test('item 1 (phone Simple): a leader\'s worker icon starts right of the leader\'s name (sheet 103 / 101, side list 92 / 86), with a line under the leader\'s icon centre', () => {
  const V = vars(mhtml);
  const sheetV = (k) => Number(new RegExp('html\\.mm-simple \\{[^}]*' + k + ': (\\d+)px').exec(mhtml)[1]);
  const sideV = (k) => Number(new RegExp('html\\.mm-simple #simple-side \\{[^}]*' + k + ': (\\d+)px').exec(mhtml.slice(mhtml.indexOf('Simple Teams (phone sheet and wide sidebar)')))[1]);
  const sheetOnly = (sel) => { const m = new RegExp('^html\\.mm-simple #simple-agents-sheet ' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{([^}]*)\\}', 'm').exec(mhtml); assert.ok(m, sel); return m[1]; };
  const rowRule = mhtml.split('\n').find((l) => /^html\.mm-simple #simple-agents-sheet \.sa-row\.sa-tm:is\(\.sa-rank-leader, \.sa-rank-worker\) \{/.test(l));
  const gapS = parseFloat(/gap: (\d+)px/.exec(rowRule)[1]);
  const leaderIc = prop(sheetOnly('.sa-rank-spec .sa-ic, html.mm-simple #simple-agents-sheet .sa-rank-leader .sa-ic'), 'width', V);
  // sheet: leader icon at --sa-pl1, its workers' icons at --sa-pl2
  const leaderIcon = sheetV('--sa-pl1'), leaderName = leaderIcon + leaderIc + gapS, workerIcon = sheetV('--sa-pl2');
  assert.deepStrictEqual([leaderName, workerIcon], [101, 103]);
  assert.ok(workerIcon >= leaderName);
  assert.strictEqual(sheetV('--sa-x2'), leaderIcon + leaderIc / 2, 'the second line hangs under the leader\'s icon centre (sheet)');
  // side list: leader icon 24 wide, row gap 10
  const sideLeaderIc = prop(body(mhtml, 'html.mm-simple #simple-side .sa-rank-leader .sa-ic'), 'width', V);
  const sideGap = parseFloat(/#simple-side \.sa-row \{[^}]*gap: (\d+)px/.exec(mhtml)[1]);
  const sideIcon = sideV('--sa-pl1'), sideName = sideIcon + sideLeaderIc + sideGap, sideWorker = sideV('--sa-pl2');
  assert.deepStrictEqual([sideName, sideWorker], [86, 92]);
  assert.strictEqual(sideV('--sa-x2'), sideIcon + sideLeaderIc / 2, 'side: leader icon 52 + half of 24 = 64');
  // the rows really take those paddings, and the joining lines are the .tm-v spans (old pseudo lines off)
  assert.match(mhtml, /\.sa-row\.sa-tm\.sa-kid \{ padding-left: var\(--sa-pl1\); \}/);
  assert.match(mhtml, /\.sa-row\.sa-tm\.sa-kid2 \{ padding-left: var\(--sa-pl2\); \}/);
  assert.match(mhtml, /\.sa-row\.sa-tm\.sa-kid::before[^{]*\.sa-kid2::after \{ content: none; \}/);
  assert.match(mjs, /teamsLinesHtml\(tm\) \+ '<span class="sa-ic">/, 'Simple rows carry the same joining-line spans');
  assert.match(mhtml, /html\.mm-simple \.sa-fold-arrow \{[^}]*min-width: 36px; min-height: 36px;/, '36px tap target');
});
