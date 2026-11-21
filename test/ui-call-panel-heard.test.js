'use strict';
// The call panel's 'Heard: ...' line may wrap to two lines; the Microphone line below it must never be overlapped.
// Cause: #call-panel is a flex column with a max-height; its rows had the default flex-shrink:1, so the heard row
// (explicit min-height 1.3em) shrank to one line and its second line was drawn over #cp-mic.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const css = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/g) || []).join('\n');

function rules(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const sels = m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim());
    if (sels.includes(selector)) out.push(m[2]);
  }
  return out;
}
const heard = () => rules('#cp-heard').join(';');

test('heard line is clamped to two lines', () => {
  const h = heard();
  assert.match(h, /-webkit-line-clamp:\s*2/);
  assert.match(h, /overflow:\s*hidden/);
  assert.match(h, /display:\s*-webkit-box/);
});

test('heard line has no fixed height / max-height / overlap-causing layout', () => {
  const h = heard();
  assert.doesNotMatch(h, /(^|[;\s])height\s*:/);
  assert.doesNotMatch(h, /max-height\s*:/);
  assert.doesNotMatch(h, /position\s*:\s*(absolute|fixed)/);
  assert.doesNotMatch(h, /margin[^:;]*:[^;]*-\d/);
  assert.doesNotMatch(h, /transform\s*:/);
  const mic = rules('#cp-mic').join(';');
  assert.doesNotMatch(mic, /position\s*:\s*(absolute|fixed)/);
  assert.doesNotMatch(mic, /margin[^:;]*:[^;]*-\d/);
});

test('call panel rows never shrink inside the max-height column', () => {
  assert.ok(rules('#call-panel > *').some((r) => /flex-shrink:\s*0/.test(r)), 'rows need flex-shrink:0');
});

test('an empty heard line is still a plain block (one row of min-height)', () => {
  assert.ok(rules('#cp-heard:empty').some((r) => /display:\s*block/.test(r)));
  assert.match(heard(), /min-height:\s*1\.3em/);
});

test('compact mode still hides the heard line and the healthy mic line; hang up stays in the panel', () => {
  assert.match(html, /#call-panel\.compact #cp-heard/);
  assert.match(html, /#call-panel\.compact #cp-mic:not\(\.cp-mic-lost\)\s*\{\s*display:\s*none/);
  assert.match(html, /id="cp-hangup"/);
  assert.ok(html.indexOf('id="cp-heard"') < html.indexOf('id="cp-mic"'));
});

test('JS sets no sizes on the heard / mic lines', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.doesNotMatch(js, /cp-heard'\)[^;\n]*\.style\.(height|maxHeight)/);
  assert.doesNotMatch(js, /\bh\.style\.(height|maxHeight)/);
});
