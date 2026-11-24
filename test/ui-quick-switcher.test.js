'use strict';
// The quick switcher (app.js): ⌘K on a Mac, Ctrl+K elsewhere, opens a search over the agents, like Slack's "Jump to…".
// The tests run the page's real functions (taken out of app.js) with small stand-ins for the page around them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const fn = (name) => {
  const m = app.match(new RegExp(`\\n    (?:async )?function ${name}\\(.*\\) \\{\\n[\\s\\S]*?\\n    \\}\\n`));
  assert.ok(m, `app.js has function ${name}`);
  return m[0];
};
const one = (name) => {   // a one-line function
  const m = app.match(new RegExp(`\\n    function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`));
  assert.ok(m, `app.js has function ${name}`);
  return m[0];
};

function storage(init = {}) {
  const s = { ...init };
  return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, _s: s };
}
function ctx(extra = {}) {
  const c = { localStorage: storage(), ...extra };
  vm.runInNewContext(
    [one('qsRecentStore'), fn('qsRecent'), fn('qsNoteOpened'), fn('qsScore'), fn('qsRank')].join('')
    + '\nthis.qsRecent = qsRecent; this.qsNoteOpened = qsNoteOpened; this.qsScore = qsScore; this.qsRank = qsRank;', c);
  return c;
}
const A = (name, display, extra = {}) => ({ name, display, ...extra });
const names = (list) => [...list].map(a => a.name);

test('an empty search: unread first, then the agents opened last on this device, then the rest by name', () => {
  const c = ctx();
  const agents = [A('scout', 'Scout'), A('aide', 'Aide'), A('forge', 'Forge'), A('agent-lead', 'Compass'), A('beacon', 'Beacon')];
  const out = c.qsRank(agents, '', { recent: ['forge', 'agent-lead'], unread: new Set(['scout']) });
  assert.deepStrictEqual(names(out), ['scout', 'forge', 'agent-lead', 'aide', 'beacon']);
});

test('typing: a name that starts with it, then a word that does, then anywhere, then the letters in order; no match is left out', () => {
  const c = ctx();
  const agents = [A('researcher', 'Researcher'), A('aide', 'Aide'), A('opportunity', 'Opportunity'), A('agent-lead', 'Compass'), A('code-reviewer', 'Code Reviewer'), A('beacon', 'Beacon')];
  assert.deepStrictEqual(names(c.qsRank(agents, 're', {})), ['researcher', 'code-reviewer']);   // starts with, then the word "reviewer"
  assert.deepStrictEqual(names(c.qsRank(agents, 'com', {})), ['agent-lead']);                    // by display name
  assert.deepStrictEqual(names(c.qsRank(agents, 'lead', {})), ['agent-lead']);                   // by name, a word in it
  assert.deepStrictEqual(names(c.qsRank(agents, 'con', {})), ['beacon']);                        // anywhere in the name
  assert.deepStrictEqual(names(c.qsRank(agents, 'opy', {})), ['opportunity']);                   // letters in order
  assert.deepStrictEqual(names(c.qsRank(agents, 'zzz', {})), []);
  assert.deepStrictEqual(names(c.qsRank(agents, '  AIDE ', {})), ['aide'], 'case and spaces around it do not matter');
});

test('among equal matches the recent one comes first, and unread does not reorder typed results', () => {
  const c = ctx();
  const agents = [A('scout', 'Scout'), A('scribe', 'Scribe'), A('sage', 'Sage')];
  assert.deepStrictEqual(names(c.qsRank(agents, 's', { recent: ['scribe'], unread: new Set(['sage']) })), ['scribe', 'sage', 'scout']);
});

test('recents: an opened agent moves to the front, without duplicates, at most 30; a broken store reads as none', () => {
  const c = ctx();
  c.qsNoteOpened('aide'); c.qsNoteOpened('forge'); c.qsNoteOpened('aide');
  assert.deepStrictEqual([...c.qsRecent()], ['aide', 'forge']);
  for (let i = 0; i < 40; i++) c.qsNoteOpened(`a${i}`);
  assert.strictEqual(c.qsRecent().length, 30);
  assert.strictEqual(c.qsRecent()[0], 'a39');
  const broken = ctx({ localStorage: storage({ 'hub-qs-recent': '{not json' }) });
  assert.deepStrictEqual([...broken.qsRecent()], []);
  const odd = ctx({ localStorage: storage({ 'hub-qs-recent': JSON.stringify(['ok', 3, null, '']) }) });
  assert.deepStrictEqual([...odd.qsRecent()], ['ok']);
});

test('the shortcut: ⌘K on a Mac and Ctrl+K elsewhere open (and close) it; other combinations are left alone', () => {
  const run = (mac, ev) => {
    let opened = 0, prevented = false, stopped = false;
    const c = { QS_MAC: mac, openQuickSwitcher: () => { opened++; } };
    vm.runInNewContext(fn('qsShortcut') + '\nthis.go = qsShortcut;', c);
    c.go({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...ev, preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
    return { opened, prevented, stopped };
  };
  assert.deepStrictEqual(run(true, { metaKey: true }), { opened: 1, prevented: true, stopped: true });
  assert.deepStrictEqual(run(true, { metaKey: true, key: 'K' }), { opened: 1, prevented: true, stopped: true }, 'Caps Lock on');
  assert.strictEqual(run(true, { ctrlKey: true }).opened, 0, 'Ctrl+K on a Mac deletes to the end of the line: left alone');
  assert.strictEqual(run(true, { metaKey: true, shiftKey: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, altKey: true }).opened, 0);
  assert.strictEqual(run(true, { metaKey: true, isComposing: true }).opened, 0, 'an input method composing text');
  assert.strictEqual(run(true, { metaKey: true, key: 'j' }).opened, 0);
  assert.deepStrictEqual(run(false, { ctrlKey: true }), { opened: 1, prevented: true, stopped: true });
  assert.strictEqual(run(false, { metaKey: true }).opened, 0);
  assert.strictEqual(run(false, {}).opened, 0, 'a plain k is typing');
});

test('a Mac is recognised however the browser names it ("macOS" in Chrome, "MacIntel", the user agent)', () => {
  const c = {};
  vm.runInNewContext(one('qsIsMac') + '\nthis.isMac = qsIsMac;', c);
  assert.strictEqual(c.isMac({ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }), true);
  assert.strictEqual(c.isMac({ platform: 'MacIntel' }), true);
  assert.strictEqual(c.isMac({ platform: 'iPad' }), true);
  assert.strictEqual(c.isMac({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), true);
  assert.strictEqual(c.isMac({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), false);
  assert.strictEqual(c.isMac({ platform: 'Linux x86_64' }), false);
  assert.strictEqual(c.isMac(undefined), false);
});

test('keys in the search box: ↓/↑ and Ctrl+N/P move round the list, Enter opens the chosen agent', () => {
  const c = { qsList: [A('a'), A('b'), A('c')], qsSel: 0, opened: [], painted: 0 };
  c.qsPaintSel = () => { c.painted++; };
  c.qsOpen = (n) => c.opened.push(n);
  vm.runInNewContext('var qsList = this.qsList, qsSel = 0;\n' + fn('qsKey') + '\nthis.key = qsKey; this.sel = () => qsSel;', c);
  const k = (ev) => { let p = false; c.key({ key: '', ctrlKey: false, metaKey: false, isComposing: false, ...ev, preventDefault: () => { p = true; } }); return p; };
  assert.ok(k({ key: 'ArrowDown' })); assert.strictEqual(c.sel(), 1);
  k({ key: 'ArrowDown' }); k({ key: 'ArrowDown' }); assert.strictEqual(c.sel(), 0, 'wraps to the top');
  k({ key: 'ArrowUp' }); assert.strictEqual(c.sel(), 2, 'wraps to the bottom');
  k({ key: 'p', ctrlKey: true }); assert.strictEqual(c.sel(), 1);
  k({ key: 'n', ctrlKey: true }); assert.strictEqual(c.sel(), 2);
  assert.ok(k({ key: 'Enter' })); assert.deepStrictEqual(c.opened, ['c']);
  k({ key: 'Enter', isComposing: true }); assert.deepStrictEqual(c.opened, ['c'], 'Enter that ends an input method composition does not open');
  assert.strictEqual(k({ key: 'a' }), false, 'typing is left to the box');
});

test('wiring: a dialog the shared layer manages, recents recorded on every solo chat, the shortcut in the capture phase', () => {
  const open = fn('openQuickSwitcher');
  assert.match(open, /ov\.className = 'gs-overlay qs-overlay'/, 'found by the dialog layer (.gs-overlay): Escape, backdrop, Tab, focus back');
  assert.match(open, /ov\.dataset\.noDirty = '1'/, 'a search box: closing never asks "Discard changes?"');
  assert.match(open, /ov\.__dialogClose = \(\) => ov\.remove\(\);/);
  assert.match(open, /if \(qsIsOpen\(\)\) \{ closeQuickSwitcher\(\); return; \}/, '⌘K again closes it');
  assert.match(fn('qsOpen'), /startSoloChat\(a\.name, a\.model\)[\s\S]*document\.getElementById\(`input-\$\{id\}`\)[\s\S]*box\.focus\(\)/, 'the chat opens with the message box ready');
  assert.match(fn('switchToChat'), /if \(opened && !opened\.isGroup && !opened\.isWorker && !opened\.isHistory && opened\.agent\) qsNoteOpened\(opened\.agent\);/);
  assert.match(app, /document\.addEventListener\('keydown', qsShortcut, true\);/);
  assert.match(fn('renderQuickSwitcher'), /hubEsc\(shown\)/, 'names are escaped');
  assert.match(index, /\.gs-overlay\.qs-overlay \{/);
});
