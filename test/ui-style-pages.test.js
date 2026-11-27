'use strict';
// Every page follows the chosen interface style. The pages that kept their own colours (agent settings, recordings,
// Tiger Team, the remote desktop viewer) hold them in page variables with today's values, and one block maps each to
// the style's role variable when a style other than Engineering is on, so Engineering is unchanged and the light
// styles reach every colour. The full contrast check runs in a browser: scripts/ui-contrast-check.py.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const LOOK_FILES = ['looks/broadsheet.css', 'looks/quiet.css'];
const defined = (css) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(m => m[1]));

// page file, its variable prefix, and colours that stay literal in every style (with why)
const PAGES = [
  // agent-settings.html is a redirect page now (P4-2): it has no colours of its own (the link uses the system colour), so it is not listed
  ['recordings.html', '--rc-', ['rgba(0,0,0,.6)']],   // the dialog backdrop dims the page in every style
  ['tiger-team.html', '--tt-', ['rgba(0,0,0,.4)', 'rgba(0,0,0,.6)', 'rgba(0,0,0,.015)']],   // shadows and the scan-line texture
  ['remote-desktop.html', '--rd-', ['#000']],   // the remote computer's screen stays black
];

function blocks(src, prefix) {
  const rootAt = src.search(new RegExp(`:root\\s*\\{[^}]*${prefix}`));
  assert.ok(rootAt >= 0, `${prefix} :root block`);
  const root = src.slice(rootAt, src.indexOf('}', rootAt) + 1);
  const mapAt = src.indexOf('html[data-look]:not([data-look="engineering"])', rootAt);
  assert.ok(mapAt > rootAt, `${prefix} mapping block after the :root block`);
  const map = src.slice(mapAt, src.indexOf('}', mapAt) + 1);
  // every :root block only defines variables (Tiger Team keeps its role variables in its own first :root block)
  const rest = (src.slice(0, rootAt) + src.slice(rootAt + root.length).replace(map, '')).replace(/:root\s*\{[^}]*\}/g, '');
  return { root, map, rest };
}

for (const [file, prefix, keep] of PAGES) {
  test(`${file}: every page colour follows the interface style (variables, mapping, no stray literals)`, () => {
    const src = read(file);
    const { root, map, rest } = blocks(src, prefix);
    const vars = [...root.matchAll(new RegExp(`(${prefix}[a-z0-9-]+)\\s*:`, 'g'))].map(m => m[1]);
    assert.ok(vars.length >= 5, `${file} has its page variables`);
    for (const v of vars) assert.match(map, new RegExp(`${v}\\s*:`), `${file}: ${v} is mapped for the light styles`);
    // the mapping uses only role variables both light styles define (or the page's own variables)
    const roles = [...map.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]).filter(v => !v.startsWith(prefix));
    for (const lf of LOOK_FILES) {
      const have = defined(read(lf));
      for (const r of roles) assert.ok(have.has(r), `${file}: ${r} is defined in ${lf}`);
    }
    // outside the two blocks no colour literal is left, apart from the listed ones (comments are not colours)
    const code = rest.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    // a colour is #rgb, #rgba, #rrggbb, #rrggbbaa or rgb()/rgba(); ids such as #add-dropdown are not (the lookahead)
    const colours = [...code.matchAll(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})(?![\w-])|rgba?\([^)]*\)/g)]
      .map(m => m[0].replace(/\s+/g, '').replace(/([(,])0\./g, '$1.')).filter(l => !keep.includes(l));   // rgba(0,0,0,0.4) = rgba(0,0,0,.4)
    assert.deepStrictEqual(colours, [], `${file}: colours outside the variable blocks`);
  });
}

test('remote-desktop.html loads the interface style before its styles', () => {
  const src = read('remote-desktop.html');
  const loader = src.indexOf('<script src="/ui-looks.js"></script>'), style = src.indexOf('<style');
  assert.ok(loader > 0 && loader < style);
});

test('form fields have an edge people can see in the light styles (3:1 on the page, card and field colours)', () => {
  const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const lf of LOOK_FILES) {
    const css = read(lf);
    const val = (n) => { const m = css.match(new RegExp(`^\\s*--${n}:\\s*(#[0-9A-Fa-f]{6})`, 'm')); assert.ok(m, `${lf} --${n}`); return hex(m[1]); };
    const fb = val('field-border');
    for (const surface of ['bg-dark', 'bg-card', 'bg-input']) assert.ok(ratio(fb, val(surface)) >= 3, `${lf}: --field-border on --${surface} is ${ratio(fb, val(surface)).toFixed(2)}:1`);
    assert.match(css, /#owner-view,\s*\S+ input:not\(\[type=checkbox\]\)[^{]*\S+ select,\s*\S+ textarea \{\s*border-color: var\(--field-border\) !important;/, `${lf}: the field rule (over inline and id-level field rules)`);
    assert.match(css, /:focus,?[^{]*\{\s*border-color: var\(--accent\) !important;/, `${lf}: a focused field shows the accent`);
  }
});

test('the browser contrast check and its Engineering list are in the repo', () => {
  const script = read('scripts/ui-contrast-check.py');
  assert.match(script, /sys\.exit\(1 if fail else 0\)/);
  for (const scene of ['main-settings', 'main-files', 'main-scheduler', 'main-chat-recall', 'main-guide', 'main-security', 'mobile-menu', 'mobile-files', 'mobile-security', 'mobile-profile', 'mobile-recall', 'agent-settings', 'users', 'changes', 'help', 'local-models', 'modules', 'tiger-team', 'recordings', 'welcome', 'login']) {
    assert.ok(script.includes(`('${scene}'`), `scene ${scene}`);
  }
  const base = JSON.parse(read('scripts/ui-contrast-engineering-baseline.json'));
  assert.ok(Array.isArray(base.violations) && base.violations.length > 0);
  assert.ok(base.violations.every(v => typeof v === 'string' && v.split('|').length >= 4), 'scene|kind|element|text');
});

test('Simple mode takes each light style\'s palette (both Simple variants), and its text reads at 4.5:1', () => {
  const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(hex(a)), y = lum(hex(b)); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  for (const [id, lf] of [['broadsheet', 'looks/broadsheet.css'], ['quiet', 'looks/quiet.css']]) {
    const css = read(lf).replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf(`html[data-look="${id}"].mm-simple,\nhtml[data-look="${id}"].mm-simple.mm-light {`);
    assert.ok(at >= 0, `${lf}: one block for dark Simple and .mm-light`);
    const block = css.slice(at, css.indexOf('}', at));
    const v = (n) => { const m = block.match(new RegExp(`--${n}:\\s*(#[0-9A-Fa-f]{6});`)); assert.ok(m, `${lf} Simple --${n}`); return m[1]; };
    for (const [fg, bg] of [['sm-text', 'sm-page'], ['sm-sec', 'sm-page'], ['sm-muted', 'sm-page'], ['sm-text', 'sm-side'], ['sm-sec', 'sm-side'], ['sm-muted', 'sm-side'], ['sm-text', 'sm-raised'], ['sm-sec', 'sm-raised'], ['text', 'bg-dark'], ['text-dim', 'bg-card'], ['text-tertiary', 'bg-card']]) {
      assert.ok(ratio(v(fg), v(bg)) >= 4.5, `${lf}: Simple --${fg} on --${bg} is ${ratio(v(fg), v(bg)).toFixed(2)}:1`);
    }
    assert.match(block, /color-scheme: light;/);
  }
});

test('Simple in a light style: status colours, the toggle and the toast take the style, and busy dots keep 3:1 while they pulse', () => {
  const hex = (h) => { h = h.replace('#', ''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const fade = (fg, bg, t) => fg.map((c, i) => Math.round(c * t + bg[i] * (1 - t)));
  for (const [id, lf] of [['broadsheet', 'looks/broadsheet.css'], ['quiet', 'looks/quiet.css']]) {
    const css = read(lf).replace(/\/\*[\s\S]*?\*\//g, '');
    const at = css.indexOf(`html[data-look="${id}"].mm-simple,\nhtml[data-look="${id}"].mm-simple.mm-light {`);
    assert.ok(at >= 0, `${lf}: the Simple block`);
    const block = css.slice(at, css.indexOf('}', at));
    const v = (n) => { const m = block.match(new RegExp(`--${n}:\\s*(#[0-9A-Fa-f]{6});`)); assert.ok(m, `${lf}: Simple sets --${n}`); return hex(m[1]); };
    for (const n of ['line-tint', 'hover-tint-strong']) assert.match(block, new RegExp(`--${n}:\\s*rgba\\(`), `${lf}: Simple sets --${n} (Engineering's is a white tint)`);
    v('on-warning'); v('success'); v('consult');
    assert.ok(ratio(v('toggle-on-bg'), v('bg-card')) >= 3, `${lf}: Simple's switch track`);
    const S = `html[data-look="${id}"].mm-simple`;
    const floor = css.match(new RegExp(`@keyframes ${id}-simple-dot-shrink \\{ 50% \\{ opacity: ([.0-9]+);`));
    const floorD = css.match(new RegExp(`@keyframes ${id}-simple-dot \\{ 0%, 100% \\{ opacity: 1; \\} 50% \\{ opacity: ([.0-9]+);`));
    assert.ok(floor && floorD, `${lf}: the Simple dots' own pulse`);
    for (const dot of ['warning', 'blue']) for (const bg of ['bg-dark', 'bg-card', 'bg-input']) {
      const t = Math.min(Number(floor[1]), Number(floorD[1]));
      const r = ratio(fade(v(dot), v(bg), t), v(bg));
      assert.ok(r >= 3, `${lf}: Simple --${dot} on --${bg} at its dimmest pulse is ${r.toFixed(2)}:1`);
    }
    assert.ok(css.includes(`${S} .sa-dot.busy,\n${S} .sa-dot.question { animation-name: ${id}-simple-dot-shrink; }`), `${lf}: phone dots use it`);
    assert.ok(css.includes(`${S} #agent-list .simple-more .sm-dot { animation-name: ${id}-simple-dot; }`), `${lf}: desktop dots use it`);
    assert.ok(css.includes(`${S} #toast { background: var(--text); color: var(--bg-dark); }`), `${lf}: the phone toast in Simple is ink on paper`);
    assert.ok(ratio(v('bg-dark'), v('text')) >= 4.5, `${lf}: toast text`);
  }
});
