'use strict';
// Simple's message box on a phone: no safe-area inset under the box while the keyboard is open (the home indicator is under the
// keyboard, as normal mode's tab bar already assumes), and the controls row stays on one line at 320 px.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');

test('the page marks the keyboard with body.kbd (the state the rule keys on)', () => {
  assert.match(js, /addEventListener\('focus', \(\) => document\.body\.classList\.add\('kbd'\)\)/);
  assert.match(js, /addEventListener\('blur', \(\) => document\.body\.classList\.remove\('kbd'\)\)/);
  assert.match(html, /body\.kbd #tabbar \{ display: none; \}/);
});

test('Simple composer: calc(6px + var(--sab)) normally, plain 6px under the box while the keyboard is open', () => {
  assert.match(html, /html\.mm-simple #composer \{[^}]*padding: 8px 12px calc\(6px \+ var\(--sab\)\);/);
  const m = html.match(/html\.mm-simple body\.kbd #composer \{([^}]*)\}/);
  assert.ok(m, 'a body.kbd rule for the Simple composer exists');
  assert.match(m[1], /padding-bottom: 6px;/);
  assert.ok(!/--sab/.test(m[1]), 'no inset in the keyboard rule');
  // it comes after the base rule, so it wins at equal or higher specificity
  assert.ok(html.indexOf('html.mm-simple body.kbd #composer {') > html.indexOf('html.mm-simple #composer { position: relative'));
});

test('320 px: the Simple controls row fits one line (tighter gaps and padding, the chip may shrink, taps stay >= 36)', () => {
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
