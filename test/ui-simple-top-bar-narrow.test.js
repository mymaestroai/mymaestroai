'use strict';
// Simple mode on an iPhone: the top bar never overlaps and never cuts a label to a bare dot or icon, and the composer's bottom space is the
// safe-area inset plus a small constant (not the inset added twice). Source pins on the Simple CSS in mobile.html.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'mobile.html'), 'utf8');
const css = /<style id="simple-css">([\s\S]*?)<\/style>/.exec(html)[1];

// every rule (selector list + declarations) with the media query it sits in ('' = none); good enough for this flat stylesheet
function rules(src) {
  const out = [];
  const re = /(@media[^{]+)\{|([^{}@]+)\{([^{}]*)\}|\}/g;
  let m, media = '';
  while ((m = re.exec(src))) {
    if (m[1]) media = m[1].trim();
    else if (m[2] !== undefined) out.push({ media, sel: m[2].trim(), body: m[3] });
    else media = '';
  }
  return out;
}
const R = rules(css.replace(/\/\*[\s\S]*?\*\//g, ''));
const hides = (r) => /display:\s*none/.test(r.body);

test('no rule hides the "Talking to:" words or the theme label at any width', () => {
  for (const r of R) {
    if (!hides(r)) continue;
    for (const part of r.sel.split(',').map((x) => x.trim())) {
      assert.ok(!/\.st-to\b/.test(part), 'st-to hidden by: ' + r.media + ' ' + part);
      assert.ok(!/\.stb-lab\b/.test(part), 'stb-lab hidden by: ' + r.media + ' ' + part);
    }
  }
});

test('the agent name keeps its room: it truncates with an ellipsis and is never hidden', () => {
  const nm = R.find((r) => /\.st-pill \.st-pname$/.test(r.sel));
  assert.ok(nm && /text-overflow:\s*ellipsis/.test(nm.body) && /min-width:\s*0/.test(nm.body));
  for (const r of R) if (hides(r)) for (const part of r.sel.split(',')) assert.ok(!/\.st-pname\b/.test(part.trim()), 'name hidden: ' + part);
});

test('the bar wraps; under 700px the pill takes its own full-width second row under the controls', () => {
  const top = R.find((r) => r.sel === 'html.mm-simple #simple-top' && !r.media);
  assert.match(top.body, /flex-wrap:\s*wrap/);
  const m = R.filter((r) => /max-width:\s*699px/.test(r.media));
  const pill = m.find((r) => /#simple-top \.st-pill$/.test(r.sel));
  assert.ok(pill, 'pill rule in the phone media query');
  assert.match(pill.body, /flex:\s*1 1 100%/);
  assert.match(pill.body, /width:\s*100%/);
  const ord = (re) => Number((m.find((r) => re.test(r.sel)).body.match(/order:\s*(\d+)/) || [])[1]);
  assert.ok(ord(/\.st-mark$/) < ord(/\.mode-toggle$/) && ord(/\.mode-toggle$/) < ord(/\.simple-theme-btn$/) && ord(/\.simple-theme-btn$/) < ord(/\.st-avatar$/) && ord(/\.st-avatar$/) < ord(/\.st-pill$/), 'row 1 controls come before the pill');
  // the brand mark is no longer hidden on a narrow phone
  for (const r of R) if (hides(r) && r.media !== '@media (min-width: 700px)') assert.ok(!/\.st-mark\b/.test(r.sel), 'mark hidden by ' + r.media);
});

test('under 350px the theme button moves out of the bar (the settings sheet keeps Appearance)', () => {
  const n = R.find((r) => /max-width:\s*349px/.test(r.media) && /simple-theme-btn/.test(r.sel));
  assert.ok(n && hides(n));
  const js = fs.readFileSync(path.join(__dirname, '..', 'mobile.js'), 'utf8');
  assert.match(js, /<div class="ss-title">Light or dark<\/div>/);
});

test('wide Simple (the sidebar layout) is unchanged: pill, mark and avatar hidden from 700px', () => {
  const w = R.find((r) => r.media === '@media (min-width: 700px)' && /#simple-top \.st-pill/.test(r.sel));
  assert.ok(w && hides(w));
  assert.ok(R.some((r) => r.media === '@media (min-width: 700px)' && r.sel === 'html.mm-simple #simple-top' && /justify-content:\s*flex-end/.test(r.body)));
});

test('the composer bottom space is the safe-area inset plus a small constant, not added twice', () => {
  const c = R.find((r) => r.sel === 'html.mm-simple #composer');
  const m = /padding:\s*(\d+)px (\d+)px calc\((\d+)px \+ var\(--sab\)\)/.exec(c.body);
  assert.ok(m, 'padding uses calc(<n>px + var(--sab))');
  assert.ok(Number(m[3]) >= 4 && Number(m[3]) <= 8, 'constant is 4-8px, got ' + m[3]);
  // the page's own bottom elements: the tab bar (hidden in Simple) is the only other --sab user at the bottom, and body has no bottom padding
  assert.match(html, /padding: var\(--sat\) var\(--sar\) 0 var\(--sal\);/);
  assert.match(html, /#tabbar \{[^}]*padding-bottom: var\(--sab\);/);
  assert.match(css, /html\.mm-simple \.topbar[^{]*#tabbar[^{]*\{ display: none !important; \}/);
});

test('safe areas: env(safe-area-inset-*) appears only where the --sat/--sab/--sal/--sar variables are defined', () => {
  const lines = html.split('\n').filter((l) => /env\(safe-area-inset/.test(l));
  assert.strictEqual(lines.length, 4, lines.join('\n'));
  for (const l of lines) assert.match(l, /^\s*--sa[tblr]: env\(safe-area-inset-(top|bottom|left|right), 0px\);/);
});
