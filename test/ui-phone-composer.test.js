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

test('(a) #voice-settings-btn is in #voice-strip, not in the composer .row', () => {
  const strip = html.match(/<div id="voice-strip"[^>]*>[\s\S]*?<\/div>/)[0];
  assert.ok(strip.includes('id="voice-settings-btn"'));
  assert.ok(strip.indexOf('id="voice-mode-chip"') < strip.indexOf('id="voice-settings-btn"'), 'after the chip');
  const row = html.slice(html.indexOf('<div class="row">', html.indexOf('id="composer"')), html.indexOf('id="file-input"'));
  assert.ok(!row.includes('voice-settings-btn'));
  assert.ok(/#voice-strip #voice-settings-btn \{[^}]*margin-left: auto/.test(html));
  assert.equal(html.split('id="voice-settings-btn"').length - 1, 1);
  assert.ok(/\$\('voice-settings-btn'\)\?\.addEventListener\('click'/.test(mob), 'still wired by id');
});

test('(b) CSS hides attach, camera and the strip under #composer.typing inside max-width 600px', () => {
  const m = html.match(/@media \(max-width: 600px\) \{\s*(#composer\.typing[^}]*)\}\s*\}/);
  assert.ok(m, 'media block');
  const body = m[1];
  assert.ok(body.includes('#composer.typing #attach-btn'));
  assert.ok(body.includes('#composer.typing #camera-btn'));
  assert.ok(body.includes('#composer.typing #voice-strip'));
  assert.ok(/display: none/.test(body));
  assert.ok(!/#composer\.typing[^,{]*(#mic-btn|#send-btn)/.test(body), 'mic and send stay');
});

test('(b) while typing during a running reply, the Notify chip shows only its bell (inside max-width 600px)', () => {
  const m = html.match(/@media \(max-width: 600px\) \{\s*(#composer\.typing \.notify-chip \.nlabel[^}]*\}[^}]*\})\s*\}/);
  assert.ok(m, 'media block for the chip');
  assert.ok(/#composer\.typing \.notify-chip \.nlabel \{ display: none; \}/.test(m[1]), 'label hidden');
  assert.ok(/#composer\.typing \.notify-chip \{ padding: 0 10px; \}/.test(m[1]), 'narrow padding');
  assert.ok(!/#composer\.typing \.notify-chip \{[^}]*display: none/.test(html), 'the chip itself stays');
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
