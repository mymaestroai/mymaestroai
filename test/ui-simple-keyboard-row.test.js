'use strict';
// Simple's message box on a phone: no safe-area inset under the box while the ON-SCREEN keyboard is up (the home indicator is under the
// keyboard, as normal mode's tab bar already assumes) - but not when a hardware keyboard only focuses the box - and the controls row stays
// on one line at 340 px and below.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
const fnSrc = (src, name) => {
  const i = src.search(new RegExp('function ' + name + '\\('));
  assert.ok(i >= 0, name + ' exists');
  let depth = 0, j = src.indexOf('{', i);
  for (; j < src.length; j++) { if (src[j] === '{') depth++; else if (src[j] === '}') { depth--; if (!depth) break; } }
  return src.slice(i, j + 1);
};

test('body.kbd still follows focus (tab bar, voice tip); body.kbd-up is painted by composerKbdUpPaint on focus, blur and viewport resize / scroll', () => {
  assert.match(js, /addEventListener\('focus', \(\) => document\.body\.classList\.add\('kbd'\)\)/);
  assert.match(js, /addEventListener\('blur', \(\) => document\.body\.classList\.remove\('kbd'\)\)/);
  assert.match(html, /body\.kbd #tabbar \{ display: none; \}/);
  assert.match(js, /input\.addEventListener\('focus', composerKbdUpPaint\)/);
  assert.match(js, /input\.addEventListener\('blur', composerKbdUpPaint\)/);
  assert.match(js, /visualViewport\.addEventListener\('resize', composerKbdUpPaint\)/);
  assert.match(js, /visualViewport\.addEventListener\('scroll', composerKbdUpPaint\)/);
  assert.match(js, /window\.addEventListener\('resize', composerKbdUpPaint\)/);
});

test('Simple composer: calc(6px + var(--sab)) normally, plain 6px under the box only under body.kbd-up (not body.kbd)', () => {
  assert.match(html, /html\.mm-simple #composer \{[^}]*padding: 8px 12px calc\(6px \+ var\(--sab\)\);/);
  const m = html.match(/html\.mm-simple body\.kbd-up #composer \{([^}]*)\}/);
  assert.ok(m, 'a body.kbd-up rule for the Simple composer exists');
  assert.match(m[1], /padding-bottom: 6px;/);
  assert.ok(!/--sab/.test(m[1]), 'no inset in the keyboard rule');
  assert.ok(!/html\.mm-simple body\.kbd #composer/.test(html), 'no padding rule keys on focus alone');
  // it comes after the base rule, so it wins at equal or higher specificity
  assert.ok(html.indexOf('html.mm-simple body.kbd-up #composer {') > html.indexOf('html.mm-simple #composer { position: relative'));
});

// ── the detection rule, run on the real source with a fake DOM ──
function page({ innerHeight = 800 } = {}) {
  const cls = new Set();
  const input = { id: 'msg-input' };
  const vv = { height: innerHeight, width: 390, scale: 1 };
  const ctx = {
    window: { visualViewport: vv, innerHeight, innerWidth: 390 },
    document: { activeElement: null, body: { classList: { toggle: (c, v) => { if (v) cls.add(c); else cls.delete(c); } } } },
    $: (id) => (id === 'msg-input' ? input : null),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(js, 'composerKbdUpPaint') + '\nthis.paint = composerKbdUpPaint;', ctx);
  return { ctx, vv, input, cls,
    focus() { ctx.document.activeElement = input; ctx.paint(); },
    blur() { ctx.document.activeElement = null; ctx.paint(); },
    resize(h, layout) { vv.height = h; if (layout) ctx.window.innerHeight = h; ctx.paint(); },
    rotate(w, h) { vv.width = w; vv.height = h; ctx.window.innerWidth = w; ctx.window.innerHeight = h; ctx.paint(); } };
}

test('kbd-up: focus without a viewport shrink (hardware keyboard) keeps the inset class off', () => {
  const p = page(); p.focus();
  assert.ok(!p.cls.has('kbd-up'));
  p.resize(800 - 100);   // a small shrink (a bar, not a keyboard) does not count either
  assert.ok(!p.cls.has('kbd-up'));
});

test('kbd-up: focus plus a 300 px shrink sets it; the viewport recovering with focus kept clears it; blur clears it', () => {
  const p = page(); p.focus();
  p.resize(500); assert.ok(p.cls.has('kbd-up'), 'keyboard up');
  p.resize(800); assert.ok(!p.cls.has('kbd-up'), 'the keyboard went away (focus kept): inset back');
  p.resize(500); assert.ok(p.cls.has('kbd-up'));
  p.blur(); assert.ok(!p.cls.has('kbd-up'), 'blur clears it');
});

test('kbd-up: a browser whose layout viewport shrinks with the keyboard also counts; a rotation while focused does not', () => {
  const p = page(); p.focus();
  p.resize(500, true); assert.ok(p.cls.has('kbd-up'), 'layout and visual viewport both shrank after focus');
  p.resize(800, true); assert.ok(!p.cls.has('kbd-up'), 'recovered');
  const r = page(); r.focus(); r.rotate(844, 390); assert.ok(!r.cls.has('kbd-up'), 'landscape is not a keyboard');
});

test('kbd-up: a shrink without focus does nothing; a pinch-zoomed page is not a keyboard; no visualViewport = off', () => {
  const p = page(); p.resize(500); assert.ok(!p.cls.has('kbd-up'), 'not focused');
  const z = page(); z.focus(); z.vv.scale = 2; z.resize(400); assert.ok(!z.cls.has('kbd-up'), 'zoomed');
  const n = page(); n.focus(); n.ctx.window.visualViewport = null; n.ctx.paint(); assert.ok(!n.cls.has('kbd-up'));
});

test('340 px and below: the Simple controls row fits one line (tighter gaps and padding, the chip may shrink, taps stay >= 44)', () => {
  const at = html.indexOf('@media (max-width: 340px) { /* Simple composer');
  assert.ok(at > 0, 'a max-width 340px Simple composer media block exists');
  const blk = html.slice(at, html.indexOf('\n}', at) + 2);
  assert.match(blk, /html\.mm-simple #composer \.row \{[^}]*gap: 4px 4px;/);
  assert.match(blk, /html\.mm-simple #composer \.row \{[^}]*padding: 8px 6px 10px;/);
  assert.match(blk, /html\.mm-simple #composer \{[^}]*padding-left: 8px; padding-right: 8px;/);
  assert.match(blk, /html\.mm-simple #simple-effort-btn \{[^}]*min-width: 0; flex: 0 1 auto;[^}]*padding: 0 10px;/);
  assert.match(blk, /html\.mm-simple #simple-effort-btn \.lvl-label \{[^}]*overflow: hidden; text-overflow: ellipsis;/);
  for (const sel of ['#plus-btn', '#simple-call-btn', '#send-btn']) {
    const r = blk.match(new RegExp('html\\.mm-simple ' + sel + ' \\{([^}]*)\\}'));
    assert.ok(r, sel);
    const w = r[1].match(/(?:min-)?width: (\d+)px/), h = r[1].match(/(?:min-)?height: (\d+)px/);
    assert.ok(+w[1] >= 44 && +h[1] >= 44, sel + ' tap area at least 44px');
  }
});

test('RTL: the brand mark uses logical margins (margin-inline-end), no physical margin-right', () => {
  const rules = html.match(/html\.mm-simple #simple-top \.st-mark \{[^}]*\}/g) || [];
  assert.ok(rules.length >= 2);
  for (const r of rules) assert.ok(!/margin-right|margin-left/.test(r), r);
  assert.match(html, /\.st-mark \{ order: 1; margin-inline-end: auto; \}/);
});
