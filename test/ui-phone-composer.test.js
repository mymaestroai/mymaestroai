'use strict';
// The phone composer: the voice settings button sits in the voice strip (not the send row), the message box gets the width of attach /
// camera / the strip while it is in use, and the call panel goes compact while typing or on a short screen. CSS and markup are checked
// on the source; the two paint functions are cut out of mobile.js and RUN against a small fake DOM.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const html = read('mobile.html'), mob = read('mobile.js');

function fnSource(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name);
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return src.slice(i, k + 1);
  }
  throw new Error('unterminated ' + name);
}

function el(id, parent) {
  const classes = new Set();
  const e = {
    id, parentNode: parent || null, value: '',
    classList: {
      toggle: (c, on) => { if (on === undefined) on = !classes.has(c); if (on) classes.add(c); else classes.delete(c); return on; },
      contains: (c) => classes.has(c),
    },
    closest(sel) { const want = sel.replace(/^\./, ''); for (let x = this; x; x = x.parentNode) if (x.cls === want) return x; return null; },
  };
  return e;
}

function harness({ inDrawer = false, vvHeight = 800 } = {}) {
  const win = { visualViewport: vvHeight == null ? null : { height: vvHeight }, innerHeight: 900 };
  const doc = { activeElement: null };
  const drawer = el('drawer'); drawer.cls = 'ucd-drawer';
  const els = { composer: el('composer'), 'msg-input': el('msg-input'), 'call-panel': el('call-panel', inDrawer ? drawer : null) };
  const $ = (id) => els[id] || null;
  const src = fnSource(mob, 'composerTypingPaint') + '\n' + fnSource(mob, 'callPanelCompactPaint') + '\n' + fnSource(mob, 'composerPaintAll');
  const api = new Function('$', 'document', 'window', src + '\nreturn { composerTypingPaint, callPanelCompactPaint, composerPaintAll };')($, doc, win);
  return { api, els, doc, win };
}

// changed on purpose (owner: the bottom of the phone screen was too busy): #voice-settings-btn, #attach-btn and #camera-btn are menu
// items in the + sheet, the strip keeps only the mode chip, and the Notify bell lives in the chat header.
test('(a) #voice-settings-btn is a menu item in #plus-sheet: not in #voice-strip, still one element, still wired by id', () => {
  const strip = html.match(/<div id="voice-strip"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.ok(strip.includes('id="voice-mode-chip"'));
  assert.ok(!strip.includes('voice-settings-btn'), 'the strip holds only the mode chip');
  const sheet = html.match(/<div id="plus-sheet"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.ok(sheet.includes('id="voice-settings-btn"'));
  assert.ok(/id="voice-settings-btn"[^>]*role="menuitem"/.test(sheet));
  assert.ok(!/#voice-strip #voice-settings-btn/.test(html), 'dead strip rule removed');
  assert.equal(html.split('id="voice-settings-btn"').length - 1, 1);
  assert.ok(/\$\('voice-settings-btn'\)\?\.addEventListener\('click'/.test(mob), 'still wired by id');
});

// Owner, 2026-11-13: "I can no longer add file attachments": nothing is hidden on focus alone; attach and camera live in the + sheet.
test('(b) CSS hides only the strip under #composer.typing inside max-width 600px (attach and camera now live in the + sheet)', () => {
  const m = html.match(/@media \(max-width: 600px\) \{\s*(#composer\.typing[^}]*)\}\s*\}/);
  assert.ok(m, 'media block');
  const body = m[1];
  assert.ok(body.includes('#composer.typing #voice-strip { display: none;'));
  assert.ok(!body.includes('#attach-btn') && !body.includes('#camera-btn'));
  assert.ok(!/#composer\.typing #(attach|camera|plus)-btn[^{]*\{[^}]*display: none/.test(html), 'attach, camera and + are never hidden on focus');
  assert.ok(!/#composer\.typing[^,{]*(#mic-btn|#send-btn)/.test(body), 'mic and send stay');
});

test('(b) the Notify bell in the header shows only its bell, at the header icon size; no composer notify rules are left', () => {
  assert.ok(/#chat-head \.notify-chip \.nlabel \{ display: none; \}/.test(html), 'label hidden in the header');
  assert.ok(!/#chat-head \.notify-chip \{[^}]*display: none/.test(html), 'the bell itself is not hidden by a rule');
  assert.ok(!/#composer[^{]*\.notify-chip/.test(html), 'no rule left for the old composer position');
  assert.ok(/<button class="iconbtn notify-chip" id="chat-notify-btn"/.test(html), 'iconbtn: same size as the other header buttons');
});

test('(b) composerTypingPaint: typing only while the box has focus (a draft left in the box still lets you attach a file)', () => {
  const { api, els, doc } = harness();
  const c = els.composer, i = els['msg-input'];
  api.composerTypingPaint();
  assert.equal(c.classList.contains('typing'), false, 'initial paint: unfocused');
  doc.activeElement = i; api.composerTypingPaint();
  assert.equal(c.classList.contains('typing'), true, 'focus');
  doc.activeElement = null; api.composerTypingPaint();
  assert.equal(c.classList.contains('typing'), false, 'blur with an empty box');
  i.value = 'hello'; doc.activeElement = i; api.composerTypingPaint();
  assert.equal(c.classList.contains('typing'), true, 'typing with text');
  doc.activeElement = null; api.composerTypingPaint();
  assert.equal(c.classList.contains('typing'), false, 'blur with a draft: attach and camera come back');
  i.value = ''; doc.activeElement = i; api.composerTypingPaint();
  assert.equal(c.classList.contains('typing'), true, 'cleared while focused stays typing');
});

test('(b) listeners, initial paint and programmatic fills are wired', () => {
  assert.ok(/for \(const ev of \['focus', 'input'\]\) input\.addEventListener\(ev, composerPaintAll\);/.test(mob));
  // review r1: the repaint on blur waits, so a tap on a call-panel button (Now / Later / Skip) lands before the panel grows back
  assert.ok(/input\.addEventListener\('blur', \(\) => setTimeout\(composerPaintAll, 300\)\);/.test(mob));
  assert.ok(/visualViewport.*addEventListener\('resize', callPanelCompactPaint\)|vvPaint\.addEventListener\('resize', callPanelCompactPaint\)/.test(mob));
  assert.ok(/window\.addEventListener\('resize', callPanelCompactPaint\)/.test(mob));
  assert.ok(/composerPaintAll\(\);\n/.test(mob), 'initial paint');
  for (const name of ['sendInterjection', 'restoreDraft', 'voiceInsert', 'sendMessage']) {
    assert.ok(/composerTypingPaint\(\)/.test(fnSource(mob, name)), name + ' repaints after touching the box');
  }
  assert.ok(/input\.value = text;\n\s+saveDraft\(agent, text\);\n\s+composerTypingPaint\(\);/.test(mob));
  assert.ok(/input\.value = ra\.text; composerTypingPaint\(\)/.test(mob));
});

test('(c) compact rules hide exactly the listed parts, keep .cp-top, and never apply inside the call display drawer', () => {
  const rules = html.match(/(?::not\(\.ucd-section\) > )?#call-panel\.compact[^{]*\{[^}]*\}/g).join('\n');
  const sels = rules.match(/[^,{\n]*#call-panel\.compact [^,{]+/g).map((s) => s.trim());
  // review r1: every rule is scoped to a panel that is not in a .ucd-section (the drawer wraps an adopted panel in one), so a panel
  // that was compact when the display adopted it shows in full in the drawer
  for (const s of sels) assert.ok(s.startsWith(':not(.ucd-section) > #call-panel.compact '), s);
  assert.deepEqual(sels.map((s) => s.replace(':not(.ucd-section) > ', '')).sort(), [
    '#call-panel.compact #cp-activity', '#call-panel.compact #cp-heard', '#call-panel.compact .cp-dnd', '#call-panel.compact .cp-disp',
    '#call-panel.compact .cp-actions', '#call-panel.compact #cp-help', '#call-panel.compact #cp-mic:not(.cp-mic-lost)',
  ].sort());
  assert.ok(!/cp-top|cp-held|cp-retry-mic|cp-state|cp-meter/.test(rules));
  assert.equal((rules.match(/display: none/g) || []).length, 2);
  const lib = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'ui-call-display.js'), 'utf8');
  assert.ok(/el\('div', 'ucd-section'/.test(lib), 'the display wraps an adopted control in .ucd-section');
});

// review r1: a reply to an earlier dictation is never read aloud over a call or after Hang up
test('read-aloud: nothing owed to an earlier dictation is read over a call or after Hang up (phone and desktop)', () => {
  const auto = fnSource(mob, 'voiceAutoRead');
  assert.ok(/if \(voiceCall \|\| !rec \|\| rec\.readGen !== voiceAutoReadGen\) return;/.test(auto), 'phone: not during a call, not for an older generation');
  assert.ok(/function voiceAutoReadReset\(\) \{ voiceAutoReadGen\+\+; voiceDictatedFor = null; \}/.test(mob));
  assert.ok(/readGen: voiceAutoReadGen/.test(fnSource(mob, 'sendMessage')), 'a new message records the generation');
  for (const name of ['voiceCallStart', 'voiceCallTeardown']) assert.ok(/voiceAutoReadReset\(\)/.test(fnSource(mob, name)), name + ' resets');
  // behaviour: the guard, run with a fake rec
  const run = (voiceCall, gen, rec) => { let spoke = 0; new Function('voiceCall', 'voiceAutoReadGen', 'voicePrefsNow', 'current', 'voiceSpeak', auto + '\nreturn voiceAutoRead;')(voiceCall, gen, () => ({ readAloud: true }), 'bob', () => { spoke++; })(rec); return spoke; };
  const rec = { dictated: true, full: 'Hello.', agent: 'bob', readGen: 4 };
  assert.equal(run(null, 4, rec), 1, 'same generation, no call: read');
  assert.equal(run({}, 4, rec), 0, 'a call is up: not read');
  assert.equal(run(null, 5, rec), 0, 'a call started or ended since: not read');
  const app = require('fs').readFileSync(require('path').join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(/function voiceAutoRead\(chat, msgId, text\) \{\n\s+if \(voiceCallS\.call\) return;/.test(app), 'desktop: not during a call');
  assert.ok(/function voiceCallTeardown\(\) \{\n[^\n]*\n\s+for \(const c of Object\.values\(chats\)\) if \(c\) \{ c\.voiceTurn = false; c\.voiceDictated = false; \}/.test(app), 'desktop: the call ending drops it');
});

test('(c) callPanelCompactPaint: focus, short viewport, tall viewport, not in the drawer', () => {
  let h = harness({ vvHeight: 800 });
  h.api.callPanelCompactPaint();
  assert.equal(h.els['call-panel'].classList.contains('compact'), false, 'tall, unfocused');
  h.doc.activeElement = h.els['msg-input']; h.api.callPanelCompactPaint();
  assert.equal(h.els['call-panel'].classList.contains('compact'), true, 'focus');
  h.doc.activeElement = null; h.api.callPanelCompactPaint();
  assert.equal(h.els['call-panel'].classList.contains('compact'), false, 'blur');
  h.win.visualViewport.height = 420; h.api.callPanelCompactPaint();
  assert.equal(h.els['call-panel'].classList.contains('compact'), true, 'short visualViewport');
  h = harness({ vvHeight: null }); h.win.innerHeight = 500; h.api.callPanelCompactPaint();
  assert.equal(h.els['call-panel'].classList.contains('compact'), true, 'short innerHeight fallback');
  h = harness({ inDrawer: true, vvHeight: 300 }); h.doc.activeElement = h.els['msg-input']; h.api.callPanelCompactPaint();
  assert.equal(h.els['call-panel'].classList.contains('compact'), false, 'never inside .ucd-drawer');
});

// ── one calm bottom row: + , message box, mic, Send ──
const rowHtml = () => html.slice(html.indexOf('<div class="row">', html.indexOf('id="composer"')), html.indexOf('id="file-input"'));
const idsOf = (s) => [...s.matchAll(/<(?:button|textarea)\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);

test('(d) the row is: + button, message box, mic, Send (the sheet is not part of the order)', () => {
  const row = rowHtml();
  const noSheet = row.replace(/<div id="plus-sheet"[\s\S]*?<\/div>/, '');
  assert.deepEqual(idsOf(noSheet), ['plus-btn', 'msg-input', 'mic-btn', 'send-btn']);
  const plus = noSheet.match(/<button[^>]*id="plus-btn"[^>]*>\+<\/button>/)[0];
  assert.ok(/class="iconbtn"/.test(plus) && /aria-label="More: attach, camera, voice settings"/.test(plus) && /aria-haspopup="true"/.test(plus) && /aria-expanded="false"/.test(plus));
  for (const gone of ['attach-btn', 'camera-btn', 'chat-notify-btn', 'voice-settings-btn']) assert.ok(!noSheet.includes('id="' + gone + '"'), gone + ' left the row');
});

test('(d) #plus-sheet is a hidden menu holding Attach file, Camera and Voice settings as labelled menu items', () => {
  const sheet = html.match(/<div id="plus-sheet"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.ok(/role="menu"/.test(sheet) && /\bhidden>/.test(sheet.split('>')[0] + '>'), 'menu, hidden by default');
  assert.deepEqual(idsOf(sheet), ['attach-btn', 'camera-btn', 'voice-settings-btn']);
  for (const [id, label] of [['attach-btn', 'Attach file'], ['camera-btn', 'Camera'], ['voice-settings-btn', 'Voice settings']]) {
    const b = sheet.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>[\\s\\S]*?</button>'))[0];
    assert.ok(/role="menuitem"/.test(b), id + ' is a menuitem');
    assert.ok(b.includes('<span class="ps-label">' + label + '</span>'), id + ' has a visible label');
  }
  assert.ok(/id="voice-settings-btn"[^>]*\bhidden\b/.test(sheet), 'Voice settings starts hidden (voice off)');
  assert.ok(/#plus-sheet \{ position: absolute; left: 0; bottom: 100%/.test(html), 'above the row, left-aligned');
  assert.ok(!/[\u{FE0F}]/u.test(sheet + rowHtml()), 'no emoji variation selector');
});

test('(d) #chat-notify-btn is in #chat-head right before #chat-stop-btn, and not in the composer', () => {
  const head = html.slice(html.indexOf('id="chat-head"'), html.indexOf('id="chat-scroll"'));
  const bell = head.indexOf('id="chat-notify-btn"'), stop = head.indexOf('id="chat-stop-btn"');
  assert.ok(bell > 0 && stop > bell, 'bell before Stop');
  assert.ok(!head.slice(bell, stop).includes('<button class="iconbtn" id'), 'directly before Stop (no other button between)');
  assert.ok(!html.slice(html.indexOf('id="composer"'), html.indexOf('id="file-input"')).includes('chat-notify-btn'));
  assert.ok(/id="chat-notify-btn" type="button" aria-pressed="false" aria-label="Notify me when this reply is done"[^>]*hidden>/.test(head));
});

test('(d) plusSheetShow toggles hidden and aria-expanded; plusSheetOpen follows', () => {
  const sheet = { hidden: true }, btn = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
  const $ = (id) => (id === 'plus-sheet' ? sheet : id === 'plus-btn' ? btn : null);
  const api = new Function('$', fnSource(mob, 'plusSheetOpen') + '\n' + fnSource(mob, 'plusSheetShow') + '\nreturn { plusSheetOpen, plusSheetShow };')($);
  assert.equal(api.plusSheetOpen(), false);
  api.plusSheetShow(true);
  assert.equal(sheet.hidden, false); assert.equal(btn.attrs['aria-expanded'], 'true'); assert.equal(api.plusSheetOpen(), true);
  api.plusSheetShow(false);
  assert.equal(sheet.hidden, true); assert.equal(btn.attrs['aria-expanded'], 'false'); assert.equal(api.plusSheetOpen(), false);
  assert.doesNotThrow(() => new Function('$', fnSource(mob, 'plusSheetShow') + '\nplusSheetShow(true);')(() => null), 'no sheet on the page: nothing happens');
});

test('(d) opening the + sheet closes an open voice panel and moves focus to its first shown item (keyboard reachable; review r1)', () => {
  let focused = null, panelOpen = true;
  const item = (id, hidden) => ({ id, hidden, focus() { focused = id; } });
  const items = [item('attach-btn', true), item('camera-btn', false), item('voice-settings-btn', false)];
  const sheet = { hidden: true, querySelectorAll: (sel) => (sel === '[role="menuitem"]' ? items : []) };
  const btn = { setAttribute() {} };
  const $ = (id) => (id === 'plus-sheet' ? sheet : id === 'plus-btn' ? btn : null);
  const api = new Function('$', 'voicePanelOpen', 'voicePanelShow', fnSource(mob, 'plusSheetShow') + '\nreturn { plusSheetShow };')($, () => panelOpen, (v) => { panelOpen = !!v; });
  api.plusSheetShow(true);
  assert.equal(panelOpen, false, 'the voice panel closed');
  assert.equal(focused, 'camera-btn', 'first shown item has focus (a hidden one is skipped)');
  focused = null; api.plusSheetShow(false);
  assert.equal(focused, null, 'closing moves no focus');
});

test('(d) plusSheetWire: second tap on + closes, outside tap, Escape (focus back on +), box focus, menu item (before it acts); send and openChat close it', () => {
  const listeners = {};
  const mk = (name) => ({ name, hidden: true, attrs: {}, focused: 0, on: {}, setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f, cap) { (this.on[t] = this.on[t] || []).push({ f, cap }); }, focus() { this.focused++; }, contains(x) { return x === this || (x && x.inSheet); } });
  const sheet = mk('sheet'), btn = mk('btn'), input = mk('input'), doc = mk('doc');
  const $ = (id) => ({ 'plus-sheet': sheet, 'plus-btn': btn, 'msg-input': input }[id] || null);
  const src = ['plusSheetOpen', 'plusSheetShow', 'plusSheetWire'].map((n) => fnSource(mob, n)).join('\n');
  new Function('$', 'document', src + '\nplusSheetWire();')($, doc);
  const fire = (o, t, e) => (o.on[t] || []).forEach((l) => l.f(e));
  const ev = (o = {}) => Object.assign({ stopPropagation() {}, preventDefault() {}, target: { closest: () => null } }, o);
  fire(btn, 'click', ev()); assert.equal(sheet.hidden, false, 'tap on +'); assert.equal(btn.attrs['aria-expanded'], 'true');
  fire(btn, 'click', ev()); assert.equal(sheet.hidden, true, 'second tap on +');
  fire(btn, 'click', ev()); fire(doc, 'click', ev({ target: { closest: (s) => (s === '#plus-btn' ? {} : null) } })); assert.equal(sheet.hidden, false, 'a click on + itself is not an outside tap');
  fire(doc, 'click', ev()); assert.equal(sheet.hidden, true, 'tap outside');
  fire(btn, 'click', ev()); fire(sheet, 'keydown', ev({ key: 'Escape' })); assert.equal(sheet.hidden, true, 'Escape'); assert.equal(btn.focused, 1, 'focus back on +');
  fire(btn, 'click', ev()); fire(input, 'focus', ev()); assert.equal(sheet.hidden, true, 'the box got focus');
  fire(btn, 'click', ev()); fire(sheet, 'click', ev({ target: { closest: (s) => (s === '[role="menuitem"]' ? {} : null) } })); assert.equal(sheet.hidden, true, 'a menu item closes it');
  assert.ok(sheet.on.click[0].cap === true, 'the item listener runs in the capture phase: it closes before the item acts');
  assert.ok(/async function sendMessage\(fallback\) \{\n\s+if \(typeof plusSheetShow === 'function'\) plusSheetShow\(false\);/.test(mob), 'sending closes it (guarded: page tests cut sendMessage with stubs)');
  assert.ok(/voicePanelShow\(false\); \$\('plus-btn'\)\?\.focus\(\);/.test(mob), 'Escape in the voice panel returns focus to + (its opener sits in the closed sheet)');
  assert.ok(/async function openChat\(name\) \{[^]*?plusSheetShow\(false\);/.test(mob.slice(mob.indexOf('async function openChat(name)'), mob.indexOf('async function openChat(name)') + 400)), 'opening a chat closes it');
  assert.ok(/plusSheetWire\(\);\n\s+\$\('attach-btn'\)\.addEventListener\('click', \(\) => \$\('file-input'\)\.click\(\)\);\n\s+\$\('camera-btn'\)\.addEventListener\('click', \(\) => \$\('camera-input'\)\.click\(\)\);/.test(mob), 'attach and camera still click the file inputs directly, in the same tap');
});
