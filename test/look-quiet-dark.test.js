'use strict';
// Quiet Page, dark colour set (looks/quiet.css): html[data-look="quiet"].mm-dark gets a dark value for every light variable and raw
// colour; the light set (no class, or .mm-light) is unchanged; the dark text and marks keep their contrast.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'looks', 'quiet.css'), 'utf8');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const SCOPE = 'html[data-look="quiet"]';

// ---- a small rule reader: [{ sels: [..], body, index }] in file order (at-rule blocks are skipped: only keyframes and no @media in this file) ----
function readRules(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open < 0) break;
    const head = src.slice(i, open).trim();
    let depth = 1, j = open + 1, paren = 0;
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === '(') paren++; else if (c === ')') paren--;
      else if (c === '{') depth++; else if (c === '}') depth--;
    }
    const body = src.slice(open + 1, j - 1);
    if (head.startsWith('@')) { i = j; continue; }
    const sels = []; let cur = '', p = 0, b = 0;
    for (const c of head) {
      if (c === '(') p++; else if (c === ')') p--; else if (c === '[') b++; else if (c === ']') b--;
      if (c === ',' && p === 0 && b === 0) { sels.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) sels.push(cur.trim());
    out.push({ sels, body, index: out.length });
    i = j;
  }
  return out;
}
const rules = readRules(bare);

function decls(body) {
  const m = new Map();
  const re = /(--[\w-]+|[a-z-]+)\s*:\s*((?:[^;()]|\([^)]*\))+);?/gi;
  let x;
  while ((x = re.exec(body))) m.set(x[1], x[2].replace(/\s*!important\s*$/, '').trim());
  return m;
}
const byHead = (head) => rules.find((r) => r.sels.join(', ') === head);
const LIGHT_MAIN = SCOPE + ':not(.mm-simple)';
const DARK_MAIN = SCOPE + '.mm-dark:not(.mm-simple)';
const LIGHT_SIMPLE = SCOPE + '.mm-simple, ' + SCOPE + '.mm-simple.mm-light';
const DARK_SIMPLE = SCOPE + '.mm-simple.mm-dark';

const lightMain = byHead(LIGHT_MAIN), darkMain = byHead(DARK_MAIN), lightSimple = byHead(LIGHT_SIMPLE), darkSimple = byHead(DARK_SIMPLE);
const L = lightMain && decls(lightMain.body), D = darkMain && decls(darkMain.body);
const LS = lightSimple && decls(lightSimple.body), DS = darkSimple && decls(darkSimple.body);

function specificity(sel) {
  // (ids, classes+attributes+pseudo-classes, elements); :not(x) counts as x
  let s = sel.replace(/:not\(([^)]*)\)/g, ' $1 ');
  s = s.replace(/::[\w-]+/g, ' E ');
  const ids = (s.match(/#[\w-]+/g) || []).length;
  s = s.replace(/#[\w-]+/g, '');
  const attrs = (s.match(/\[[^\]]*\]/g) || []).length;
  s = s.replace(/\[[^\]]*\]/g, ' ');
  const cls = (s.match(/\.[\w-]+/g) || []).length + (s.match(/:[\w-]+(\([^)]*\))?/g) || []).length;
  s = s.replace(/\.[\w-]+/g, ' ').replace(/:[\w-]+(\([^)]*\))?/g, ' ');
  const els = (s.match(/(^|[\s>+~])[a-z][\w-]*/gi) || []).length + (/ E /.test(' ' + sel) ? 0 : 0);
  return [ids, attrs + cls, els];
}
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]; return 0; };

test('the four colour blocks exist: light and dark, main and Simple', () => {
  assert.ok(lightMain && darkMain && lightSimple && darkSimple, 'a block is missing');
  assert.ok(L.size > 300 && D.size > 300);
  assert.ok(LS.size > 50 && DS.size > 50);
});

test('every variable set in a light block has a dark value in the matching dark block (main and Simple)', () => {
  for (const [light, dark, label] of [[L, D, 'main'], [LS, DS, 'Simple']]) {
    const missing = [...light.keys()].filter((k) => !dark.has(k));
    assert.deepStrictEqual(missing, [], label + ' variables with no dark value: ' + missing.join(', '));
    // Simple's light look takes these from the page's own defaults (white ink, the deep bars); only its dark block needs them (ink on sage, mid-tone banners)
    const darkOnly = /^--(on-[a-z-]+|toggle-knob|approval-actions-approve-text|banner-[a-z-]+-bg|health-notice-bg|halt-banner-bg|pacing-bar-bg(-2)?)$/;
    const stray = [...dark.keys()].filter((k) => !light.has(k) && !(label === 'Simple' && darkOnly.test(k)));
    assert.deepStrictEqual(stray, [], label + ' dark variables the light block does not set: ' + stray.join(', '));
  }
  assert.strictEqual(L.get('color-scheme'), 'light');
  assert.strictEqual(D.get('color-scheme'), 'dark');
  assert.strictEqual(LS.get('color-scheme'), 'light');
  assert.strictEqual(DS.get('color-scheme'), 'dark');
});

test('colour values that must not be the light ones differ in dark (only the listed ones stay the same)', () => {
  const SAME = new Set(['--radius', '--chat-max-width', '--chat-pad-x', '--sidebar-bg', '--msg-agent-text', '--msg-agent-bg', '--msg-agent-border',
    '--qr-bg', '--agent-btn-cyber-tag-bg', '--agent-btn-cyber-tag-text', '--recall-panel-mark-bg-x']);
  const same = [...L.keys()].filter((k) => k.startsWith('--') && L.get(k).toLowerCase() === D.get(k).toLowerCase() && !SAME.has(k));
  assert.deepStrictEqual(same, [], 'dark value equals the light value: ' + same.join(', '));
});

test('the dark set uses the .mm-dark selector, and only dark rules carry dark values', () => {
  const darkRules = rules.filter((r) => r.sels.some((s) => /\.mm-dark\b/.test(s)));
  assert.ok(darkRules.length >= 4);
  for (const r of darkRules) for (const s of r.sels) {
    assert.ok(s.startsWith(SCOPE + '.mm-dark') || s.startsWith(SCOPE + '.mm-simple.mm-dark'), 'bad dark selector: ' + s);
  }
  // a rule that sets color-scheme: dark, or uses the dark page/ink colours, must be a dark rule
  for (const r of rules) {
    const isDark = r.sels.every((s) => /\.mm-dark\b/.test(s));
    if (isDark) continue;
    assert.ok(!/color-scheme\s*:\s*dark/.test(r.body), 'color-scheme: dark outside the dark rules: ' + r.sels[0]);
    for (const dv of ['#1B1814', '#24201A', '#131110', '#ECE5D8', '#8FBC93', '#3D4A36', '#2C2720']) {
      assert.ok(!r.body.toUpperCase().includes(dv), dv + ' in a rule that is not dark: ' + r.sels[0]);
    }
  }
});

test('the light set did not change: key light values, and the Simple light block still serves both Simple variants', () => {
  const pin = {
    'color-scheme': 'light', '--bg-dark': '#FAF7F0', '--bg-card': '#FFFDF6', '--bg-input': '#F6F1E6', '--text': '#2A2620', '--text-dim': '#6E6558',
    '--text-tertiary': '#756A5A', '--accent': '#3F6B4D', '--accent-hover': '#2F5A3E', '--success': '#2A724A', '--warning': '#8F5E00', '--error': '#B3261E',
    '--blue': '#2F5F9E', '--purple': '#6B4FA8', '--link': '#2B5F8A', '--code-text': '#8A3F20', '--tool-accent': '#94492A', '--reasoning': '#70529A',
    '--border': '#E6DCCA', '--border-strong': '#8F8470', '--field-border': '#857B6E', '--on-color-text': '#ffffff', '--on-accent': '#ffffff',
    '--toggle-knob': '#ffffff', '--toggle-slider-bg': '#CFC5B0', '--msg-user-bg': '#EEF2E6', '--msg-user-text': '#2A2620', '--step-text': '#4A4236',
    '--banner-info-bg': '#1F5C7A', '--banner-critical-bg': '#8E1F1A', '--call-bg': '#B3261E', '--usage-critical-tint': '#B3261E22',
    '--overlay-bg': 'rgba(42,38,32,0.50)', '--shadow-color': 'rgba(60,48,30,0.16)', '--agent-btn-active-bg': 'rgba(63,107,77,0.10)',
    '--hover-tint-strong': 'rgba(42,38,32,0.08)', '--voice-ready': '#2A2620', '--on-voice-ready': '#FAF7F0',
  };
  for (const [k, v] of Object.entries(pin)) assert.strictEqual(L.get(k), v, 'light main ' + k);
  const pinS = {
    'color-scheme': 'light', '--sm-page': '#FAF7F0', '--sm-raised': '#F6F1E6', '--sm-text': '#2A2620', '--sm-shadow': '0 2px 12px rgba(0,0,0,.08)',
    '--sp-shadow': '0 2px 12px rgba(0,0,0,.08)', '--sm-sel': 'color-mix(in srgb, #3F6B4D 13%, transparent)',
    '--sm-hover': 'color-mix(in srgb, #2A2620 5%, transparent)', '--sm-user-bg': 'color-mix(in srgb, #3F6B4D 12%, #F6F1E6)',
    '--sp-me-bg': 'color-mix(in srgb, #3F6B4D 12%, #F6F1E6)', '--sm-user-code': 'color-mix(in srgb, #2A2620 10%, transparent)',
    '--sp-me-code': 'color-mix(in srgb, #2A2620 10%, transparent)', '--simple-interject-bg': '#3F6B4D', '--simple-raised-bg': '#F6F1E6',
    '--accent': '#3F6B4D', '--text': '#2A2620', '--error': '#B3261E', '--on-warning': '#ffffff', '--field-border': '#857B6E',
  };
  for (const [k, v] of Object.entries(pinS)) assert.strictEqual(LS.get(k), v, 'light Simple ' + k);
  // both Simple variants keep the light values: the no-class (Simple's own dark variant) and .mm-light, and neither is touched by mm-dark
  assert.ok(lightSimple.sels.includes(SCOPE + '.mm-simple.mm-light'));
  assert.ok(lightSimple.sels.includes(SCOPE + '.mm-simple'));   // untouched: the dark block overrides it (higher specificity, later)
  assert.strictEqual([...L.keys()].filter((k) => k.startsWith('--')).length, 361, 'the light main block still sets the same variables');
  assert.strictEqual([...LS.keys()].filter((k) => k.startsWith('--')).length, 58, 'the light Simple block still sets the same variables');
  // the light user-message borders keep their raw colour
  assert.ok(/html\[data-look="quiet"\]:not\(\.mm-simple\) \.message\.user\s*\{[^}]*border: 1px solid #D8DFCB/.test(bare));
  assert.ok(/html\[data-look="quiet"\]:not\(\.mm-simple\) \.msg\.user\s*\{[^}]*border: 1px solid #D8DFCB/.test(bare));
});

test('every dark variable block wins over its light block: same or higher specificity, placed after', () => {
  for (const [dark, light] of [[darkMain, lightMain], [darkSimple, lightSimple]]) {
    assert.ok(dark.index > light.index, 'dark block must come after the light block');
    for (const ds of dark.sels) {
      const dsp = specificity(ds);
      for (const ls of light.sels) {
        // only compare when both can match the same element (dark Simple vs the .mm-light selector never co-occur)
        if (/mm-light/.test(ls)) continue;
        assert.ok(cmp(dsp, specificity(ls)) >= 0, ds + ' must be at least as specific as ' + ls);
      }
    }
  }
  // Simple's dark block also beats the light selector that does carry .mm-light (never both classes at once, but be safe)
  assert.ok(cmp(specificity(DARK_SIMPLE), specificity(SCOPE + '.mm-simple.mm-light')) >= 0);
  // the dark main block beats every other light rule that sets one of the same variables (only the Simple block does, and it is :not-excluded)
  for (const r of rules) {
    if (r === lightMain || r === darkMain || r === darkSimple) continue;
    for (const k of decls(r.body).keys()) {
      if (!k.startsWith('--') || !D.has(k)) continue;
      if (r === lightSimple) continue;   // Simple vs main never match one element (:not(.mm-simple))
      assert.fail('variable ' + k + ' is also set in another rule: ' + r.sels[0]);
    }
  }
});

test('every light rule with a raw colour has a dark counterpart that wins', () => {
  const RAW = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|color-mix\(/;
  const colourProps = (r) => [...decls(r.body)].filter(([k, v]) => !k.startsWith('--') && RAW.test(v)).map(([k]) => k);
  const lightRaw = rules.filter((r) => r !== lightMain && r !== darkMain && r !== lightSimple && r !== darkSimple
    && r.sels.every((s) => !/\.mm-dark\b/.test(s)) && colourProps(r).length);
  assert.ok(lightRaw.length >= 2, 'expected the two user-message border rules');
  for (const r of lightRaw) {
    for (const prop of colourProps(r)) {
      for (const sel of r.sels) {
        const want = sel.replace(SCOPE, SCOPE + '.mm-dark');
        const dr = rules.find((x) => x.index > r.index && x.sels.includes(want) && [...decls(x.body).keys()].some((k) => k === prop || k.startsWith(prop + '-')));
        assert.ok(dr, 'no dark counterpart for ' + prop + ' in ' + sel);
        assert.ok(cmp(specificity(want), specificity(sel)) > 0);
      }
    }
  }
  // the two user-message borders become #3D4A36 in dark, on desktop and phone
  for (const sel of ['.message.user', '.msg.user']) {
    assert.ok(new RegExp('html\\[data-look="quiet"\\]\\.mm-dark:not\\(\\.mm-simple\\) ' + sel.replace(/\./g, '\\.') + '\\s*\\{[^}]*border-color: #3D4A36').test(bare), sel);
  }
});

test('the dark set holds the palette: core colours, status colours, banners flip, no raw hex in the Simple dark block', () => {
  const core = {
    '--bg-dark': '#1B1814', '--bg-card': '#24201A', '--bg-input': '#131110', '--msg-user-bg': '#263023', '--text': '#ECE5D8', '--text-dim': '#B8AD9B',
    '--text-tertiary': '#A69B88', '--step-text': '#D2C9B8', '--accent': '#8FBC93', '--accent-hover': '#A6CDA9', '--success': '#56BA80', '--warning': '#E2AC55',
    '--error': '#EF7F72', '--blue': '#88ABEB', '--bg-work-ring': '#6DB1DD', '--link': '#8CBDE6', '--tool-accent': '#DC9A76', '--code-text': '#E6A583',
    '--reasoning': '#BCA2DD', '--purple': '#AC97EA', '--alert': '#EE8DB6', '--border': '#353026', '--border-strong': '#8C8270', '--field-border': '#948A78',
    '--toggle-slider-bg': '#7D7362', '--toggle-knob': '#1B1814', '--on-color-text': '#1B1814', '--on-accent': '#1B1814', '--qr-bg': '#ffffff',
    '--banner-info-bg': '#5C9FC2', '--banner-critical-bg': '#D4675B', '--halt-banner-bg': '#DB5F54', '--call-bg-hover': '#F59A8F',
    '--usage-critical-tint': '#EF7F7233', '--usage-warn-tint': '#E2AC5533', '--agent-btn-cyber-tag-bg': '#F0A04B',
  };
  for (const [k, v] of Object.entries(core)) assert.strictEqual(D.get(k).toLowerCase(), v.toLowerCase(), 'dark ' + k);
  assert.strictEqual(DS.get('--sm-raised'), '#2C2720');
  assert.strictEqual(DS.get('--simple-raised-bg'), '#2C2720');
  assert.strictEqual(DS.get('--sm-shadow'), '0 2px 12px rgba(0,0,0,.40)');
  assert.strictEqual(DS.get('--sp-shadow'), '0 2px 12px rgba(0,0,0,.40)');
  assert.strictEqual(DS.get('--sm-sel'), 'color-mix(in srgb, #8FBC93 13%, transparent)');
  assert.strictEqual(DS.get('--sm-hover'), 'color-mix(in srgb, #ECE5D8 5%, transparent)');
  assert.strictEqual(DS.get('--sm-user-bg'), 'color-mix(in srgb, #8FBC93 12%, #131110)');
  assert.strictEqual(DS.get('--sp-me-bg'), 'color-mix(in srgb, #8FBC93 12%, #131110)');
  assert.strictEqual(DS.get('--sm-user-code'), 'color-mix(in srgb, #ECE5D8 10%, transparent)');
  assert.strictEqual(DS.get('--sp-me-code'), 'color-mix(in srgb, #ECE5D8 10%, transparent)');
  // none of the light Simple literals survive inside the dark Simple block
  for (const v of DS.values()) assert.ok(!/#3F6B4D|#2A2620|#F6F1E6|rgba\(0,0,0,\.08\)/i.test(v), 'a light literal in the dark Simple block: ' + v);
});

// ---- contrast, computed from the dark blocks ----
function lum(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const hex = (map, n) => { const v = map.get(n); assert.ok(/^#[0-9a-f]{6}$/i.test(v), n + ' should be a plain hex: ' + v); return v; };

test('dark text, links, accents and status colours reach 4.5:1 on the page, card and input', () => {
  for (const [map, label] of [[D, 'main'], [DS, 'Simple']]) {
    const surfaces = [hex(map, '--bg-dark'), hex(map, '--bg-card'), hex(map, '--bg-input')];
    const names = ['--text', '--text-dim', '--text-tertiary', '--accent', '--accent-hover', '--success', '--warning', '--error', '--blue'];
    if (map === D) names.push('--link', '--code-text', '--step-text', '--tool-accent', '--reasoning', '--purple', '--alert', '--alert-text', '--caution',
      '--status-high', '--tool-slow-text', '--status-info', '--job-status-done', '--agent-color-7-text', '--tool-text');
    for (const s of surfaces) {
      for (const n of names) {
        if (map === D && n === '--accent-hover' && s === surfaces[2]) continue;   // the palette measures hover on page and card only
        if (['--link', '--code-text', '--tool-accent'].includes(n) && s === surfaces[2] && map === D && n !== '--link' && n !== '--code-text') continue;
        assert.ok(ratio(hex(map, n), s) >= 4.5, label + ' ' + n + ' on ' + s + ' = ' + ratio(hex(map, n), s).toFixed(2));
      }
    }
  }
  // your message (the green wash)
  const wash = hex(D, '--msg-user-bg');
  for (const n of ['--msg-user-text', '--text', '--text-dim', '--text-tertiary', '--accent', '--success']) assert.ok(ratio(hex(D, n), wash) >= 4.5, n + ' on the green wash');
  // Simple's own text colours on its surfaces
  for (const n of ['--sm-text', '--sm-sec', '--sm-muted']) for (const s of ['--sm-page', '--sm-side', '--sm-raised', '--sm-bubble']) {
    assert.ok(ratio(hex(DS, n), hex(DS, s)) >= 4.5, n + ' on ' + s);
  }
});

test('dark colour fills carry page-colour text at 4.5:1 (accent, status, voice and every banner)', () => {
  const ink = hex(D, '--on-color-text');
  assert.strictEqual(ink.toLowerCase(), hex(D, '--bg-dark').toLowerCase());
  const fills = ['--accent', '--accent-hover', '--success', '--warning', '--error', '--blue', '--purple', '--worker-busy', '--call-bg', '--call-bg-hover',
    '--st-btn-bk-danger-bg', '--st-btn-bk-danger-hover-bg', '--banner-backup-bg', '--banner-critical-bg', '--banner-info-bg', '--banner-pending-bg',
    '--banner-setup-bg', '--banner-warn-bg', '--halt-banner-bg', '--health-notice-bg', '--pacing-bar-bg', '--pacing-bar-bg-2', '--voice-listening', '--voice-ready'];
  for (const n of fills) assert.ok(ratio(ink, hex(D, n)) >= 4.5, n + ' with page-colour text = ' + ratio(ink, hex(D, n)).toFixed(2));
  for (const [t, f] of [['--on-accent', '--accent'], ['--approval-actions-approve-text', '--success'], ['--on-warning', '--warning'], ['--on-error', '--error'],
    ['--on-health-notice', '--health-notice-bg'], ['--on-pacing', '--pacing-bar-bg'], ['--on-voice-listening', '--voice-listening'], ['--on-voice-ready', '--voice-ready']]) {
    assert.ok(ratio(hex(D, t), hex(D, f)) >= 4.5, t + ' on ' + f);
  }
  assert.ok(ratio(hex(D, '--agent-btn-cyber-tag-text'), hex(D, '--agent-btn-cyber-tag-bg')) >= 4.5, 'orange tag');
  assert.ok(ratio(hex(DS, '--on-warning'), hex(DS, '--warning')) >= 4.5, 'Simple on-warning');
  assert.ok(ratio(hex(D, '--bg-dark'), hex(D, '--text')) >= 4.5, 'toast: page colour on ink');
});

test('dark borders, dots and controls reach 3:1 on the page, card and input', () => {
  for (const [map, label] of [[D, 'main'], [DS, 'Simple']]) {
    for (const s of ['--bg-dark', '--bg-card', '--bg-input']) {
      for (const n of ['--border-strong', '--field-border', '--warning', '--blue', '--accent', '--success', '--error']) {
        assert.ok(ratio(hex(map, n), hex(map, s)) >= 3, label + ' ' + n + ' on ' + s);
      }
    }
  }
  for (const s of ['--bg-dark', '--bg-card']) {
    for (const n of ['--toggle-slider-bg', '--bg-work-ring', '--mic-rec', '--meter-ok', '--meter-warn', '--chat-tab-status-paused-bg', '--toggle-on-bg']) {
      assert.ok(ratio(hex(D, n), hex(D, s)) >= 3, n + ' on ' + s + ' = ' + ratio(hex(D, n), hex(D, s)).toFixed(2));
    }
  }
  assert.ok(ratio(hex(D, '--toggle-knob'), hex(D, '--toggle-slider-bg')) >= 3, 'knob on the off track');
  assert.ok(ratio(hex(D, '--toggle-knob'), hex(D, '--toggle-on-bg')) >= 3, 'knob on the on track');
});

test('the header comment carries the dark contrast table and its stated ratios are right', () => {
  const header = css.match(/^\s*\/\*[\s\S]*?\*\//)[0];
  assert.ok(/Dark colour set/.test(header));
  const dark = header.slice(header.indexOf('Dark colour set'));
  let n = 0;
  for (const line of dark.split('\n')) {
    const m = line.match(/(#[0-9A-Fa-f]{6}) on (#[0-9A-Fa-f]{6})\s+([\d.]+)/);
    if (!m) continue;
    n++;
    const r = ratio(m[1], m[2]);
    assert.ok(Math.abs(r - parseFloat(m[3])) <= 0.06, 'stated ' + m[3] + ' computed ' + r.toFixed(2) + ': ' + line.trim());
    assert.ok(r >= (/\(UI\b/.test(line) ? 3 : 4.5), 'too low: ' + line.trim());
  }
  assert.ok(n >= 100, 'expected the dark table, found ' + n + ' rows');
});

// ---- Simple dark: ink on filled controls, and the banner mid-tones in both dark blocks ----
const BANNERS = {
  '--banner-critical-bg': '#D4675B', '--health-notice-bg': '#D4675B', '--halt-banner-bg': '#DB5F54', '--banner-info-bg': '#5C9FC2',
  '--banner-setup-bg': '#C5804F', '--banner-pending-bg': '#CB9242', '--pacing-bar-bg': '#CB9242', '--pacing-bar-bg-2': '#C08737',
  '--banner-warn-bg': '#BFA646', '--banner-backup-bg': '#B99B58',
};

test('the Simple dark block defines every --on-* variable the main dark block defines, plus --toggle-knob and the approve text, all page-colour ink', () => {
  const onNames = [...D.keys()].filter((k) => k.startsWith('--on-'));
  assert.ok(onNames.length >= 8, 'the main dark block has the --on-* set: ' + onNames.join(' '));
  for (const n of [...onNames, '--toggle-knob', '--approval-actions-approve-text']) {
    assert.ok(DS.has(n), 'Simple dark defines ' + n);
    assert.strictEqual(hex(DS, n).toLowerCase(), hex(D, n).toLowerCase(), 'Simple dark ' + n + ' equals the main dark value');
  }
  for (const n of ['--on-accent', '--on-color-text', '--on-light-text', '--on-error', '--on-health-notice', '--on-pacing', '--on-warning', '--toggle-knob', '--approval-actions-approve-text']) {
    assert.strictEqual(hex(DS, n).toLowerCase(), '#1b1814', n + ' is #1B1814');
  }
});

test('banner mid-tones: both dark blocks carry them, and the light blocks keep the deep bars', () => {
  for (const [n, v] of Object.entries(BANNERS)) {
    assert.strictEqual(hex(D, n).toLowerCase(), v.toLowerCase(), 'main dark ' + n);
    assert.strictEqual(hex(DS, n).toLowerCase(), v.toLowerCase(), 'Simple dark ' + n);
  }
  assert.strictEqual(L.get('--banner-critical-bg').toLowerCase(), '#8e1f1a');
  assert.strictEqual(L.get('--halt-banner-bg').toLowerCase(), '#a31d1d');
  assert.strictEqual(L.get('--pacing-bar-bg').toLowerCase(), '#8f5400');
});

test('dark ink on every new banner tone and on the sage accent reaches 4.5:1 (computed from the CSS)', () => {
  for (const map of [D, DS]) {
    const ink = hex(map, '--on-color-text');
    for (const n of Object.keys(BANNERS)) assert.ok(ratio(ink, hex(map, n)) >= 4.5, n + ' = ' + ratio(ink, hex(map, n)).toFixed(2));
    assert.ok(ratio(hex(map, '--on-pacing'), hex(map, '--pacing-bar-bg')) >= 4.5 && ratio(hex(map, '--on-pacing'), hex(map, '--pacing-bar-bg-2')) >= 4.5, 'pacing bar text');
    assert.ok(ratio(hex(map, '--on-health-notice'), hex(map, '--health-notice-bg')) >= 4.5, 'health notice text');
    assert.ok(ratio(hex(map, '--on-accent'), hex(map, '--accent')) >= 4.5, 'on-accent on sage');
    assert.ok(ratio('#1B1814', hex(map, '--accent')) >= 4.5, '#1B1814 on the sage accent');
  }
});

test('the dark-only focus frame and the new-members select rules sit under .mm-dark, and the blurb says light or dark', () => {
  const r = rules.find((x) => x.sels.includes(DARK_MAIN + ' #st-look-new'));
  assert.ok(r, 'new-members select rule');
  assert.ok(/background:\s*var\(--bg-input\)/.test(r.body) && /color:\s*var\(--text\)/.test(r.body));
  const f = rules.find((x) => x.sels.includes(DARK_MAIN + ' .st-modal'));
  assert.ok(f && /outline-color:\s*var\(--border-strong\)/.test(f.body), 'settings dialog frame');
  assert.ok(f.sels.includes(DARK_MAIN + ' #prof-tz'), 'time-zone field frame');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'lib', 'ui-looks.js'), 'utf8').includes("blurb: 'A calm notebook, light or dark.'"));
});
