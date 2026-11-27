'use strict';
// The red Fix now banner on the phone: "Open For your review" and the first item's fix are two separate controls, as on the desktop
// (the fix as a link, e.g. Open the Welcome page, is drawn as a button, never a second run of underlined text), with the same words.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

function rule(css, selector) {
  // the rule whose whole selector (from the start of its line) is `selector`
  const m = new RegExp('\\n\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\{').exec(css);
  assert.ok(m, 'rule for ' + selector);
  return css.slice(m.index, css.indexOf('}', m.index) + 1);
}

test('phone: the fix as a link is drawn as a button (border, padding, no underline, never wider than the banner)', () => {
  const mob = read('mobile.html');
  const shared = rule(mob, '#review-banner button.rvb-fix, #review-banner a.rvb-fix');
  for (const want of ['border: 1px solid var(--on-health-notice)', 'padding: 2px 10px', 'border-radius: 4px', 'margin-left: 4px']) assert.ok(shared.includes(want), want);
  const own = rule(mob, '#review-banner a.rvb-fix');
  for (const want of ['display: inline-block', 'text-decoration: none', 'max-width: 100%', 'box-sizing: border-box', 'white-space: normal']) assert.ok(own.includes(want), want);
  // the general link rule (underlined) comes first, so the fix-link rules win by order as well as weight
  assert.ok(mob.indexOf('#review-banner a {') < /\n\s*#review-banner a\.rvb-fix \{/.exec(mob).index);
  assert.ok(rule(mob, '#review-banner a.rvb-open').includes('white-space: nowrap'), 'Open For your review never splits');
  const tapArea = rule(mob, '#review-banner a.rvb-open::after, #review-banner .rvb-fix::after');
  assert.ok(/height: (3[6-9]|[4-9]\d)px/.test(tapArea) && tapArea.includes('position: absolute'), 'a tap area of 36 px or more around both controls');
});

test('the same words on the phone and the desktop: Open For your review, then the fix label', () => {
  const app = read('app.js'), mjs = read('mobile.js');
  assert.ok(app.includes('>Open For your review</a> <span class="rv-banner-fix">'));
  assert.ok(mjs.includes('<a href="#" class="rvb-open">Open For your review</a>'));
  assert.ok(mjs.includes('<a href="${esc(f.href)}" class="rvb-fix">${esc(f.label)}</a>'), 'the phone draws the fix link with the class the rule styles');
});

test('the phone remembers the banner height after every settled paint, so a taller banner is followed (no stale reserved height)', () => {
  const mjs = read('mobile.js');
  assert.ok(mjs.includes("rememberBanner(store(), 'phone', { h: bar.getBoundingClientRect().height })"));
});
