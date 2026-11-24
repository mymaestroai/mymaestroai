'use strict';
// The owner 2026-11-24 07:48: "I'm seeing differences between the mobile app and the web site. ... On the mobile I see \"3 agents\". desktop website I see \"3\". Everything should alwasy be consistent."
// Layout may differ by screen size; the words and meanings of the Teams list may not. These tests pin the shared words: the size pill ("3 agents ▾" / "1 agent ▸") at every width on
// both pages and in both Simple layouts, the pill's aria-label and title, the section header's arrow (the glyph and its side), the background line and the busy text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mobile = read('mobile.js'), html = read('index.html'), mhtml = read('mobile.html');
const AgentDot = require('../lib/ui-agent-dot.js');

// The source of one function: from its "function name(" line to the first closing brace line at the same indent (one-liners end on their own line).
function fnSrc(src, name) {
  const i = src.search(new RegExp(`^[ \\t]*(?:async )?function ${name}\\(`, 'm'));
  assert.ok(i >= 0, `${name} exists`);
  const start = src.lastIndexOf('\n', src.search(new RegExp(`function ${name}\\(`))) + 1;
  const indent = /^[ \t]*/.exec(src.slice(start))[0];
  const lineEnd = src.indexOf('\n', start);
  if (/\}\s*(\/\/.*)?$/.test(src.slice(start, lineEnd)) && !/\{\s*(\/\/.*)?$/.test(src.slice(start, lineEnd))) return src.slice(start, lineEnd);
  const close = src.indexOf('\n' + indent + '}', lineEnd);
  assert.ok(close >= 0, `${name} closes`);
  return src.slice(start, close + 2 + indent.length);
}
const plain = (s) => s.replace(/<[^>]*>/g, '').replace(/&#x25BE;/g, '▾').replace(/&#x25B8;/g, '▸').replace(/&#x2009;/g, ' ').trim();

// both pages' pill functions, loaded the same way
const desk = {}; vm.runInNewContext([fnSrc(app, 'teamsPillText'), fnSrc(app, 'teamsPillLabel'), fnSrc(app, 'teamsPillHtml'), 'this.t = teamsPillText; this.l = teamsPillLabel; this.h = teamsPillHtml;'].join('\n'), desk);
const ph = {}; vm.runInNewContext([fnSrc(mobile, 'teamsPillInner'), fnSrc(mobile, 'teamsPillLabel'), 'this.i = teamsPillInner; this.l = teamsPillLabel;'].join('\n'), ph);
const phoneOf = (n, open, name) => ({ n, open, node: { agent: { name: name.toLowerCase(), display: name } } });

test('the pill reads the same words on the desktop and on the phone: "3 agents ▾", "1 agent ▸" (open and folded)', () => {
  for (const n of [1, 3, 12, 24]) for (const open of [true, false]) {
    const d = plain(desk.t(n, open)), p = plain(ph.i(phoneOf(n, open, 'Ann')));
    assert.strictEqual(d, p, `n=${n} open=${open}`);
    assert.strictEqual(d, `${n} agent${n === 1 ? '' : 's'} ${open ? '▾' : '▸'}`);
  }
  assert.strictEqual(plain(desk.t(3, true)), '3 agents ▾');
  assert.strictEqual(plain(desk.t(1, false)), '1 agent ▸');
  assert.strictEqual(plain(ph.i(phoneOf(3, true, 'Ann'))), '3 agents ▾');
  assert.strictEqual(plain(ph.i(phoneOf(1, false, 'Ann'))), '1 agent ▸');
  assert.strictEqual(plain(ph.i(phoneOf(3, true, 'Ann'), true)), '3 agents', 'the working filter: plain text, the same words, no arrow');
});

test('the pill aria-label and title read the same on the desktop and on the phone: "Fold Ann: 3 agents" / "Unfold Ann: 1 agent"', () => {
  for (const n of [1, 3]) for (const open of [true, false]) {
    assert.strictEqual(desk.l(n, open, 'Ann'), ph.l(phoneOf(n, open, 'Ann')), `n=${n} open=${open}`);
  }
  assert.strictEqual(desk.l(3, true, 'Ann'), 'Fold Ann: 3 agents');
  assert.strictEqual(desk.l(1, false, 'Ann'), 'Unfold Ann: 1 agent');
  const b = desk.h('ann', 3, true, 'Ann');
  assert.match(b, /aria-label="Fold Ann: 3 agents" title="Fold Ann: 3 agents"/);
  assert.doesNotMatch(b, /hide team|show team|Hide |Show /, 'the old desktop wording is gone');
  // the phone's markup carries the same title (regular list and Simple)
  assert.match(mobile, /aria-label="\$\{esc\(teamsPillLabel\(r\)\)\}" title="\$\{esc\(teamsPillLabel\(r\)\)\}"/);
  assert.match(mobile, /pb\.setAttribute\('aria-label', teamsPillLabel\(tm\)\); pb\.title = teamsPillLabel\(tm\);/);
});

test('desktop: the pill markup holds the words at every width; no CSS hides them (the 160 px container query included)', () => {
  const b = desk.h('ann', 24, false, 'Ann');
  assert.match(b, /<span class="teams-pill">24 agents &#x25B8;<\/span>/);
  assert.doesNotMatch(b, /<span aria-hidden/, 'one text, no number-only span');
  const i = html.indexOf('@container (max-width: 186px)');
  const blk = html.slice(i, html.indexOf('\n    }\n', i));
  assert.ok(blk.length > 200, 'the narrow container query is found');
  for (const line of blk.split('\n')) {
    if (/teams-pill/.test(line)) assert.doesNotMatch(line, /display:\s*none|font-size:\s*0|visibility:\s*hidden|width:\s*0|overflow:\s*hidden/, `the narrow query does not hide pill words: ${line.trim()}`);
  }
  assert.doesNotMatch(html, /\.teams-pill-w|\.teams-pw|teams-pill(?!-btn\))[^{]*\{[^}]*display:\s*none/, 'no rule anywhere hides the pill or its words (the never-a-stub rules hide the STATUS words after the pill, selected by :has(.teams-pill-btn))');
  // the name gives way: ellipsis; the pill keeps its words and never shrinks or wraps
  assert.match(html, /\.teams-row \.name-text \{[^}]*min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/);
  assert.match(html, /\.teams-pill-btn \{[^}]*flex: none;/);
  assert.match(html, /\.teams-pill \{[^}]*display: block;[^}]*white-space: nowrap;/, 'a block (not flex): the space inside the pill stays');
});

test('phone and Simple: .tm-pw is gone; no rule hides the pill words; the sidebar keeps "N agents"', () => {
  assert.doesNotMatch(mhtml, /tm-pw/, 'no CSS names the old words span');
  assert.doesNotMatch(mobile, /tm-pw/, 'no markup uses it');
  assert.doesNotMatch(mhtml, /\.tm-pill[^{]*\{[^}]*display:\s*none/, 'no rule hides a pill');
  assert.match(mhtml, /html\.mm-simple \.sa-l1 b \{[^}]*min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;/, 'Simple: the name truncates');
  assert.match(mhtml, /\.tm-l1 \.agent-name \{ flex: 0 1 auto; min-width: 0; \}/, 'phone: the name truncates');
  assert.match(mhtml, /\.tm-pill-btn \{ flex: none;/, 'the pill never shrinks');
});

test('section headers: label left, ▾ (open) / ▸ (folded) at the RIGHT, the same glyphs on the desktop, the phone and Simple', () => {
  // desktop: both header builders
  const r = fnSrc(app, 'renderTeams');
  assert.strictEqual((r.match(/<span>\$\{title\}<\/span><span class="teams-glyph" aria-hidden="true">\$\{(?:o|secOpen) \? '&#x25BE;' : '&#x25B8;'\}<\/span>/g) || []).length, 2, 'Other and the four sections: label, then the arrow');
  assert.doesNotMatch(r, /▶|teams-glyph\$\{/, 'no rotating left triangle');
  assert.doesNotMatch(html, /\.teams-glyph\.open|rotate\(90deg\)[^}]*teams-glyph|\.teams-glyph \{[^}]*rotate/, 'no rotation rule');
  assert.match(html, /\.teams-title-fold \{ justify-content: space-between; \}/);
  // phone
  const p = fnSrc(mobile, 'teamsSecHeadHtml');
  assert.match(p, /<span>\$\{esc\(title\)\}<\/span><span aria-hidden="true">\$\{open \? '&#x25BE;' : '&#x25B8;'\}<\/span>/);
  // Simple (sheet and sidebar)
  const s = fnSrc(mobile, 'simpleTeamsFill');
  assert.match(s, /'<span class="sa-sec-t"><\/span><span class="sa-sec-g" aria-hidden="true"><\/span>'/);
  assert.match(s, /textContent = s\.open \? '▾' : '▸'/);
  assert.match(mhtml, /html\.mm-simple \.sa-sec-h \{[^}]*justify-content: space-between;/);
});

test('the blue background line reads "Free · N in background" everywhere; the full sentence is the tooltip', () => {
  assert.strictEqual(AgentDot.bgLine(1), 'Free · 1 in background');
  assert.strictEqual(AgentDot.bgLine(3), 'Free · 3 in background');
  assert.strictEqual(AgentDot.dotLabel('background', { background: 3 }), 'Free to talk · 3 things running in the background', 'the tooltip keeps the full sentence');
  assert.match(fnSrc(app, 'teamsRowHtml'), /teams-bg-line" title="\$\{hubEsc\(dotTip\)\}">\$\{hubEsc\(AgentDot\.bgLine\(bgN\)\)\}/, 'desktop Teams uses AgentDot.bgLine, tooltip = dotLabel');
  assert.doesNotMatch(app, /in background`\)/, 'no second hand-typed wording on the desktop');
  assert.match(fnSrc(mobile, 'simpleTmLine'), /AgentDot\.bgLine\(n\)/, 'Simple (phone)');
  assert.match(fnSrc(mobile, 'agentRowHtml'), /AgentDot\.bgLine\(bgN\)/, 'phone Teams and All Agents');
  assert.doesNotMatch(read('lib/ui-agent-dot.js'), /things\(num\(n\)\) \+ ' in the background'/, 'the long line is gone');
});

test('busy text in Teams has no hourglass anywhere: desktop strips it, the phone strips it, Simple strips it for a main row and a member', () => {
  assert.match(fnSrc(app, 'teamsRowHtml'), /replace\(\/\^⏳\\s\*\/, ''\)/);
  assert.match(fnSrc(mobile, 'agentRowHtml'), /busyText\(a\.name\)\.replace\(\/\^⏳\\s\*\/, ''\)/);
  const s = fnSrc(mobile, 'simpleTmLine');
  assert.match(s, /const words = busy \? busyText\(name\)\.replace\(\/\^⏳\\s\*\/, ''\) : '';/);
  assert.match(s, /return \{ sub: words, cls: 'busy', tip \};/);
  assert.match(s, /live: words \? '· ' \+ words : '', tip/);
});

test('the same words on both pages: Build team, the crown, the helpers line, the Undo line and the section names', () => {
  assert.match(fnSrc(app, 'buildTeamCtlHtml'), /'Build team'/);
  assert.match(mobile, /buildTeamBtnHtml\(a\.name, 'build-team-link', 'Build team', true\)/);
  assert.match(fnSrc(app, 'teamsRowHtml'), /title="Lead agent">👑/);
  assert.match(fnSrc(mobile, 'agentRowHtml'), /title="Lead agent">👑/);
  assert.match(fnSrc(app, 'teamsSubtreeHtml'), /⚡ \$\{n\.helpers\} helper\$\{n\.helpers === 1 \? '' : 's'\} under /);
  assert.match(fnSrc(mobile, 'teamsRowHtml'), /⚡ \$\{esc\(teamsHelpers\(r\.node\.helpers\)\)\} under /);
  assert.match(fnSrc(app, 'teamSetupLineHtml'), /Team setup: \$\{n\} team\$\{n === 1 \? '' : 's'\} recorded/);
  assert.match(fnSrc(mobile, 'teamSetupLineHtml'), /Team setup: \$\{n\} team\$\{n === 1 \? '' : 's'\} recorded/);
  // the section names and the counts come from the one shared helper on both pages
  assert.match(app, /hubTeams\.sections\(t, \(nm\) => agentWorksAlone\(nm\)\)/);
  assert.match(mobile, /window\.hubTeams\.sections\(t, worksAlone\)/);
  assert.match(mobile, /window\.hubTeams\.sections\(t, worksAlone\)\.map\(/, 'Simple reads the same sections');
});
