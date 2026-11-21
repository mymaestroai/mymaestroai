// Simple mode, desktop main page: the mode switch, the theme button, colours, busy dot, Primary agents + "More agents".
// Source-text checks plus the pure helper evaluated from app.js. Reads no hub data.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const hubSimple = require(path.join(ROOT, 'lib', 'ui-simple.js'));

const cssBlock = (() => {
  const a = html.indexOf('<style id="simple-mode-css">');
  assert.ok(a > 0);
  return html.slice(a, html.indexOf('</style>', a));
})();

function fnSrc(name) {
  const a = app.indexOf(`function ${name}(`);
  assert.ok(a > 0, `${name} exists`);
  const open = app.indexOf('{', app.indexOf(')', a));
  let depth = 0;
  for (let i = open; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}' && --depth === 0) return app.slice(a, i + 1);
  }
  throw new Error('unbalanced');
}

test('the switch: markup, both modes, saved choice then reload', () => {
  const s = fnSrc('simpleTopSync');
  assert.match(s, /className = 'mode-toggle'/);
  assert.match(s, /setAttribute\('role', 'switch'\)/);
  assert.match(s, /<span class="mt-lab">Simple<\/span><span class="mt-track"><span class="mt-knob"><\/span><\/span>/);
  assert.match(s, /setAttribute\('aria-checked', String\(simple\)\)/);
  assert.match(s, /Simple view \$\{simple \? 'on' : 'off'\}/);
  assert.match(s, /simpleSwitchMode\(simpleOn\(\) \? 'advanced' : 'simple'\)/);
  assert.match(fnSrc('simpleSwitchMode'), /simplePrefs\(\{ uiMode: mode \}\);\s*location\.reload\(\)/);
  // Advanced: next to the header buttons (before Files); Simple: the top-right group in the chat area
  assert.match(s, /getElementById\('files-btn'\)/);
  assert.match(s, /insertBefore\(tog, files\)/);
  assert.match(s, /id = 'simple-top-ctl'/);
});

test('the switch: hidden for the legacy login (no real account), and hooked in guarded', () => {
  const s = fnSrc('simpleTopSync');
  assert.match(s, /const ok = simpleAccountOk\(me\)/);
  assert.match(s, /if \(!ok\) \{ if \(tog\) tog\.remove\(\); if \(ctl\) ctl\.remove\(\); return; \}/);
  assert.match(app, /if \(typeof simpleTopSync === 'function'\) simpleTopSync\(\);/);
  assert.match(fnSrc('renderUserChip'), /simpleTopSync/);
  assert.match(app, /loadMe[\s\S]{0,1800}simpleTopSync/);
});

test('the theme button: label text, cycles with nextTheme, saves and restores on failure', () => {
  const p = fnSrc('simpleThemeBtnPaint');
  assert.match(p, /themeLabel\(me && me\.theme\)/);
  assert.match(p, /`\$\{t\.icon\} \$\{t\.label\}`/);
  assert.match(p, /Appearance: \$\{t\.label\}\. Tap to change\./);
  assert.match(fnSrc('simpleTopSync'), /className = 'simple-theme-btn'/);
  const n = fnSrc('simpleThemeNext');
  assert.match(n, /nextTheme\(before\)/);
  assert.match(n, /hs\.apply\(me\)[\s\S]*simplePrefs\(\{ theme: next \}\)/);
  assert.match(n, /me\.theme = before/);
  assert.match(n, /hubToast\(/);
  // only in Simple
  const t = fnSrc('simpleTopSync');
  assert.match(t, /if \(theme\) theme\.remove\(\)/);
});

test('no emoji variation selector in the new code', () => {
  for (const n of ['simpleMoreState', 'simpleAgentsSync', 'simpleTopSync', 'simpleThemeNext', 'simpleThemeBtnPaint']) assert.ok(!fnSrc(n).includes('\uFE0F'), n);
  assert.ok(!cssBlock.includes('\uFE0F'));
});

test('CSS: colours of the person vs the agent, scoped under html.mm-simple', () => {
  assert.match(cssBlock, /--sm-user-bg: #5b46a8; --sm-user-text: #ffffff;/);
  assert.match(cssBlock, /html\.mm-simple\.mm-light \{[^}]*--sm-user-bg: #ebe6fb; --sm-user-text: #1d1640;/);
  assert.match(cssBlock, /html\.mm-simple \.message\.user \{ background: var\(--sm-user-bg\); color: var\(--sm-user-text\);/);
  assert.match(cssBlock, /html\.mm-simple \.message\.assistant \{ background: none;/);
  assert.match(cssBlock, /html\.mm-simple \.message\.user a \{ color: inherit;/);
  assert.match(cssBlock, /html\.mm-simple \.message\.user :not\(pre\) > code \{/);
});

test('CSS: the switch is visible in Advanced too, and styled for Simple', () => {
  assert.match(html, /\n    \.mode-toggle \{[^}]*display: inline-flex/);
  assert.match(html, /\.mode-toggle\[aria-checked="true"\] \.mt-track \{ background: #8b6fd6; \}/);
  assert.match(html, /\.mode-toggle\[aria-checked="true"\] \.mt-knob \{ transform: translateX/);
  assert.match(cssBlock, /html\.mm-simple #simple-top-ctl \{ position: absolute; top: 8px; right: 16px;/);
  assert.match(cssBlock, /html\.mm-simple \.simple-theme-btn \{/);
  assert.match(cssBlock, /html\.mm-simple \.mode-toggle \{/);
});

test('CSS: busy / question dot in the Simple agent list, more specific than the hiding rule', () => {
  assert.match(cssBlock, /html\.mm-simple #agent-list \.agent-btn \.agent-status\.live-busy,\s*html\.mm-simple #agent-list \.agent-btn \.agent-status\.live-question \{ display: block !important; position: absolute;[^}]*right: 14px;/);
  assert.match(cssBlock, /\.agent-status\.live-busy \{ background: var\(--warning[^}]*animation: pulse 1s infinite;/);
  assert.match(cssBlock, /html\.mm-simple #agent-list \.simple-more-hide \{ display: none !important; \}/);
  assert.match(cssBlock, /html\.mm-simple #agent-list \.simple-more \.sm-dot \{ display: none;/);
  assert.match(cssBlock, /\.simple-more\.has-busy \.sm-dot \{ display: block; \}/);
  assert.match(cssBlock, /html\.mm-simple #agent-list \.simple-more-h \{/);
});

test('the Simple style block: every rule stays under html.mm-simple', () => {
  const body = cssBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^<style[^>]*>/, '');
  const sels = []; let depth = 0, cur = '';
  for (const ch of body) {
    if (ch === '{') { if (!/^\s*@(media|keyframes)/.test(cur) && depth <= 1) sels.push(cur); depth++; cur = ''; }
    else if (ch === '}') { depth--; cur = ''; } else cur += ch;
  }
  const bad = sels.flatMap(s => s.split(',')).map(s => s.trim()).filter(s => s && !s.startsWith('html.mm-simple') && !/^(\d+%|from|to)/.test(s));
  assert.deepStrictEqual(bad, []);
});

// ── "More agents" ─────────────────────────────────────────────────────────────
const ctx = vm.createContext({ window: { hubSimple } });
vm.runInContext(fnSrc('simpleMoreState') + '\nthis.simpleMoreState = simpleMoreState;', ctx);
const more = ctx.simpleMoreState;
const A = (name, category) => ({ name, category });
const LIST = [A('owner', 'primary'), A('sam', 'specialist'), A('helper', 'worker'), A('lab', 'experimental'), A('sam2', 'specialist')];
const st = (list, cur, busy, open) => JSON.parse(JSON.stringify(more(hubSimple.agentGroups(list), cur, busy, open)));

test('More agents: closed by default, the other agents hidden, no headings', () => {
  const s = st(LIST, '', [], false);
  assert.strictEqual(s.hasMore, true);
  assert.strictEqual(s.open, false);
  assert.deepStrictEqual(s.hidden.sort(), ['helper', 'lab', 'sam', 'sam2']);
  assert.ok(s.groups.every(g => !g.show && !g.heading));
  assert.strictEqual(s.dot, false);
});

test('More agents: open shows every non-empty group with its plain-word heading', () => {
  const s = st(LIST, '', [], true);
  assert.strictEqual(s.open, true);
  assert.deepStrictEqual(s.hidden, []);
  assert.deepStrictEqual(s.groups.map(g => [g.key, g.label, g.show, g.heading]), [
    ['specialist', 'Specialists', true, true], ['worker', 'Helpers', true, true], ['experimental', 'Experimental', true, true]]);
  assert.deepStrictEqual(st([A('owner', 'primary'), A('helper', 'worker')], '', [], true).groups.map(g => g.label), ['Helpers']);   // only non-empty groups
});

test('More agents: the agent whose chat is open stays visible in a closed group', () => {
  const s = st(LIST, 'sam', [], false);
  assert.ok(!s.hidden.includes('sam'));
  assert.deepStrictEqual(s.hidden.sort(), ['helper', 'lab', 'sam2']);
  assert.strictEqual(s.groups.find(g => g.key === 'specialist').show, true);
  assert.strictEqual(s.groups.find(g => g.key === 'specialist').heading, false);
  assert.strictEqual(s.groups.find(g => g.key === 'worker').show, false);
});

test('More agents: a busy hidden agent puts a dot on the closed control; a visible or open one does not', () => {
  assert.strictEqual(st(LIST, '', new Set(['helper']), false).dot, true);
  assert.strictEqual(st(LIST, '', ['lab'], false).dot, true);
  assert.strictEqual(st(LIST, 'helper', ['helper'], false).dot, false);   // visible: it shows its own dot
  assert.strictEqual(st(LIST, '', ['helper'], true).dot, false);
  assert.strictEqual(st(LIST, '', ['owner'], false).dot, false);          // Primary is always visible
});

test('More agents: no Primary agent means every agent shows and there is no control', () => {
  const s = st([A('sam', 'specialist'), A('helper', 'worker')], '', ['helper'], false);
  assert.strictEqual(s.hasMore, false);
  assert.strictEqual(s.open, false);
  assert.deepStrictEqual(s.hidden, []);
  assert.strictEqual(s.dot, false);
  assert.strictEqual(more(null, '', null, true).hasMore, false);
});

test('More agents: wiring (localStorage MORE_KEY, one control after the primary group, guarded hooks)', () => {
  const sync = fnSrc('simpleAgentsSync');
  assert.match(sync, /const open = simpleMoreOpen\(\);/);
  assert.match(fnSrc('simpleMoreOpen'), /if \(simpleMoreMem !== null\) return simpleMoreMem;[\s\S]*localStorage\.getItem\(window\.hubSimple\.MORE_KEY\) === '1'/);
  assert.match(sync, /hs\.agentGroups\(AGENTS\)/);
  assert.match(sync, /prim\.after\(btn\)/);
  assert.match(sync, /More agents/);
  assert.match(fnSrc('simpleMoreToggle'), /simpleMoreMem = !simpleMoreOpen\(\);[\s\S]*localStorage\.setItem\(window\.hubSimple\.MORE_KEY, simpleMoreMem \? '1' : '0'\)/);
  assert.match(app, /if \(typeof simpleAgentsSoon === 'function'\) simpleAgentsSoon\(\);/);
  assert.match(fnSrc('simpleScan'), /simpleAgentsSync\(\); simpleTopSync\(\);/);
  assert.match(fnSrc('simpleAgentsSync'), /if \(!simpleOn\(\)/);   // Advanced never runs it
});
