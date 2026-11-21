'use strict';
// The call screen's Controls drawer shows each control once: what the call bar already has (status line, Display, Hang up, Captions) and what
// the drawer's Voice settings already have (the desktop call bar's sliders) are marked .ucd-dup in the pages and hidden inside the drawer only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const css = read('lib/ui-call-display.css'), mobileHtml = read('mobile.html'), app = read('app.js');
const hasDup = (tag) => /(^|\s)ucd-dup(\s|"|$)/.test((tag.match(/class="([^"]*)"/) || [])[1] || '');
const tagWith = (src, needle) => { const i = src.indexOf(needle); assert.ok(i >= 0, 'found: ' + needle); const s = src.lastIndexOf('<', i); return src.slice(s, src.indexOf('>', i) + 1); };

test('the drawer hides .ucd-dup, and only inside the drawer', () => {
  assert.match(css, /\.ucd-drawer \.ucd-dup\s*\{\s*display:\s*none !important;\s*\}/);
  assert.ok(!/(^|\})\s*\.ucd-dup\s*\{/.test(css), 'no rule hides .ucd-dup outside the drawer');
});

test('phone: the call panel\'s status line, Display and Hang up, and the voice panel\'s Call display and Show captions are marked; the rest of the panel is not', () => {
  for (const n of ['<div class="cp-top', 'for="cp-display"', 'id="cp-hangup"', 'for="vp-display"', 'id="vp-display"']) assert.ok(hasDup(tagWith(mobileHtml, n)), 'marked: ' + n);
  const cap = mobileHtml.slice(mobileHtml.lastIndexOf('<label', mobileHtml.indexOf('id="vp-captions"')), mobileHtml.indexOf('id="vp-captions"'));
  assert.ok(hasDup(cap + '>'), 'marked: the Show captions row');
  for (const n of ['id="cp-dnd"', 'id="cp-levels"', 'id="cp-retry-mic"', 'id="cp-mic"', 'id="cp-held"', 'id="cp-help"', 'id="cp-focus-hint"', 'id="vp-interrupt"', 'id="vp-speed"', 'id="vp-level"', 'id="vp-sens"', 'id="vp-pause"', 'id="vp-display-note"']) {
    assert.ok(!hasDup(tagWith(mobileHtml, n)), 'kept in the drawer: ' + n);
  }
  const dnd = mobileHtml.slice(mobileHtml.lastIndexOf('<label', mobileHtml.indexOf('id="cp-dnd"')), mobileHtml.indexOf('id="cp-dnd"'));
  assert.ok(!hasDup(dnd + '>'), 'Do not disturb stays');
});

test('desktop: the call bar\'s status, meter, Display, Hang up and sliders, and the voice settings\' Call display and Show captions are marked; Do not disturb, the microphone line and the held decisions are not', () => {
  const bar = app.slice(app.indexOf('function voiceCallBarHtml('), app.indexOf('function voiceCallShowBar('));
  for (const n of ['class="vcb-state', 'class="vcb-disp', 'class="vcb-hang', 'class="vcb-sliders']) assert.ok(hasDup(tagWith(bar, n)), 'marked: ' + n);
  const meter = bar.slice(bar.indexOf('<span class="voice-meter'), bar.indexOf('>', bar.indexOf('<span class="voice-meter')) + 1);
  assert.ok(hasDup(meter), 'marked: the status meter');
  for (const n of ['class="vcb-dnd', 'class="vcb-micline', 'class="vcb-held', 'class="vcb-help', 'class="vcb-focus-hint']) assert.ok(!hasDup(tagWith(bar, n)), 'kept: ' + n);
  const pop = app.slice(app.indexOf('function voicePopHtml('), app.indexOf('function voicePopHtml(') + 20000);
  for (const n of ['Call display</span>', 'Show captions</span>']) { const s = pop.lastIndexOf('<label', pop.indexOf(n)); assert.ok(hasDup(pop.slice(s, pop.indexOf('>', s) + 1)), 'marked: ' + n); }
  assert.ok(!hasDup(tagWith(pop, "id=\"${id('display-note')}\"")), 'kept: the display note says why a chosen display is not shown (it is empty otherwise)');
  for (const n of ['Show an Interrupt button</span>', 'Mic level', 'Voice speed']) { assert.ok(!/ucd-dup/.test(pop.slice(pop.lastIndexOf('<label', pop.indexOf(n)), pop.indexOf(n))), 'kept in Voice settings: ' + n); }
});
