'use strict';
// The "Agent needs your input" card (desktop app.js showQuestionModal, phone mobile.js showQuestion): answers in a text
// box that grows and can be dragged larger, and the hub's "Skip" choice as a Skip button beside Submit that answers at
// once. Checked at the source level, like the other page tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('desktop: a growing, resizable text box; Return is a new line, ⌘Return / Ctrl+Enter sends', () => {
  const app = read('app.js'), html = read('index.html');
  assert.match(app, /<textarea rows="3" placeholder="\$\{textOnly \? 'Type your answer…' : 'Type your own answer…'\}" id="question-custom-input"><\/textarea>/);
  assert.ok(!/<input type="text" placeholder="Type your answer\.\.\." id="question-custom-input">/.test(app), 'the one-line field is gone');
  assert.match(app, /if \(e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\) && customInput\.value\.trim\(\)\) \{ e\.preventDefault\(\); submitAll\(\); \}/);
  assert.match(app, /customInput\.addEventListener\('input', \(\) => \{ grow\(\); refresh\(\); \}\);/);
  assert.match(html, /\.question-custom textarea \{[^}]*resize: vertical;/);
});

test('desktop: Skip is a button beside Submit that answers at once; a single question no longer lists Skip as a choice', () => {
  const app = read('app.js'), html = read('index.html');
  assert.match(app, /const isSkip = \(o\) => o && String\(o\.label \|\| ''\)\.trim\(\)\.toLowerCase\(\) === 'skip';/);
  assert.match(app, /const shownOptions = \(q\) => \(q\.options \|\| \[\]\)\.filter\(o => !\(isSkip\(o\) && questions\.length === 1\)\);/);
  assert.match(app, /'<span class="question-buttons">' \+ \(canSkip \? '<button id="question-skip" type="button">Skip<\/button>' : ''\) \+ '<button id="question-submit" disabled>Submit<\/button><\/span><\/div>';/);
  assert.match(app, /questions\.forEach\(\(q, i\) => \{ answers\[i\.toString\(\)\] = \(q\.options \|\| \[\]\)\.find\(isSkip\)\.label; \}\);\n\s+submitAnswers\(answers\);/, 'the agent still receives the "Skip" answer it offered');
  assert.match(app, /if \(!textOnly\) html \+= '<div class="question-divider">or type a custom answer<\/div>';/);
  assert.match(html, /#question-skip \{/);
});

test('phone: the same text box and Skip button', () => {
  const m = read('mobile.js'), html = read('mobile.html');
  assert.match(m, /custom\.innerHTML = `<textarea rows="3" placeholder="\$\{textOnly \? 'Type your answer' : 'Or type your own answer'\}"><\/textarea>`;/);
  assert.match(m, /\(canSkip \? '<button class="qskip" type="button">Skip<\/button>' : ''\)/);
  assert.match(m, /for \(const opt of shownOptions\(q\)\) \{/);
  assert.match(m, /submit\(answers, 'Skipped'\);/);
  assert.ok(!/input\.addEventListener\('keydown', \(e\) => \{ if \(e\.key === 'Enter' && input\.value\.trim\(\)\) send\(\); \}\);/.test(m), 'Return no longer sends on the phone: it is a new line');
  assert.match(html, /\.question \.qcustom textarea \{[^}]*resize: vertical;/);
  assert.match(html, /\.question \.qcustom textarea \{[^}]*font-size: 16px;/, '16px: iOS does not zoom into the box');
});
