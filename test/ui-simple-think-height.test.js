'use strict';
// Simple's Thinking box is capped by HEIGHT (about five lines), not by counting newline-separated lines: long
// paragraphs wrap into many visual lines. The newest text stays at the bottom; the top is cut and faded.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const CAP = /max-height: calc\(1\.55em \* 5\); overflow: hidden; display: flex; flex-direction: column; justify-content: flex-end;/;

test('desktop: .st-body is capped at five lines, newest text at the bottom, top faded', () => {
  const html = read('index.html');
  const rule = html.slice(html.indexOf('html.mm-simple .simple-think .st-body {'), html.indexOf('html.mm-simple .simple-think .st-body:empty'));
  assert.match(rule, /line-height: 1\.55;/);
  assert.match(rule, CAP);
  assert.match(rule, /mask-image: linear-gradient\(to bottom, transparent 0, #000 60%\)/);
});

test('phone: .st-lines is capped at five lines, newest text at the bottom, top faded; hidden still hides', () => {
  const html = read('mobile.html');
  const rule = html.slice(html.indexOf('html.mm-simple .st-lines {'), html.indexOf('html.mm-simple .st-consult {'));
  assert.match(rule, /line-height: 1\.55;/);
  assert.match(rule, CAP);
  assert.match(rule, /mask-image: linear-gradient\(to bottom, transparent 0, #000 60%\)/);
  assert.match(rule, /html\.mm-simple \.st-lines\[hidden\] \{ display: none; \}/);
  assert.match(rule, /html\.mm-simple \.st-lines > div \{ flex: none; \}/);
});
