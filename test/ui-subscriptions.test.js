'use strict';
// Subscriptions on the pages: Settings -> Subscriptions (desktop), the chat-header badges, the phone sheet. The pure
// bar/badge functions are sliced out of app.js and mobile.js and run in a vm with a stub escapeHtml.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mjs = read('mobile.js');
const BEGIN = '// ── subscriptions helpers (begin) ──';
const END = '// ── subscriptions helpers (end) ──';

function slice(src) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  return src.slice(a, b + END.length);
}
function load(src) {
  const ctx = vm.createContext({ Date, Math, Number, String, Array, Object, Number });
  vm.runInContext("function escapeHtml(s) { return String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' }[c])); }", ctx);
  vm.runInContext(slice(src), ctx);
  return ctx;
}
const NOW = Date.parse('2026-11-19T15:00:00Z');
const iso = (mins) => new Date(NOW + mins * 60000).toISOString();

const proSnap = () => ({
  enabled: true, readAt: iso(-5), planType: 'pro', resetCredits: null, error: null, warn: { at: [75, 90] },
  limits: [{ id: 'codex', label: 'Codex', reached: false, windows: [{ key: 'w', minutes: 10080, label: 'weekly', usedPercent: 42, resetsAt: iso(3000), weekly: true, short: false, expired: false }] }],
  weekly: [{ limit: 'codex', label: 'Codex', usedPercent: 42, resetsAt: iso(3000), reached: false }],
});

for (const [name, src] of [['app.js', app], ['mobile.js', mjs]]) {
  const C = load(src);
  const html = (c, x, o) => C.subsWindowsHtml(c, x, Object.assign({ now: NOW, levels: [75, 90], codexAgents: true }, o || {}));
  const bars = (h) => (h.match(/class="subs-bar"/g) || []).length;

  test(`${name}: the real Pro reading is one weekly bar and no 5-hour bar`, () => {
    const h = html(null, proSnap());
    assert.strictEqual(bars(h), 1);
    assert.ok(h.includes('>Weekly<') && !h.includes('5-hour'));
    assert.ok(h.includes('ChatGPT (pro)') && h.includes('42% used'));
    assert.ok(h.includes('role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="42" aria-label="Weekly"'));
    assert.ok(h.includes('width:42%;background:#3987e5'));
    assert.ok(h.includes('Read ') && !h.includes('Last seen'), 'fresh reading');
  });

  test(`${name}: two windows are listed shortest first; two limits prefix their labels`, () => {
    const s = proSnap();
    s.limits[0].windows.unshift({ minutes: 300, label: '5-hour', usedPercent: 10, resetsAt: iso(60), weekly: false, short: true, expired: false });
    s.limits[0].windows.reverse();   // the long one first in the data
    let h = html(null, s);
    assert.ok(h.indexOf('>5-hour<') > 0 && h.indexOf('>5-hour<') < h.indexOf('>Weekly<'));
    s.limits.push({ id: 'spark', label: 'Codex Spark', reached: false, windows: [{ minutes: 10080, label: 'weekly', usedPercent: 5, resetsAt: iso(100), weekly: true }] });
    h = html(null, s);
    assert.ok(h.includes('>Codex, 5-hour<') && h.includes('>Codex, weekly<') && h.includes('>Codex Spark, weekly<'));
  });

  test(`${name}: an expired window says when it reset instead of a percentage`, () => {
    const s = proSnap();
    s.limits[0].windows[0].expired = true;
    const h = html(null, s);
    assert.ok(h.includes('Reset at ') && h.includes('; no reading since'));
    assert.ok(!h.includes('42% used'));
    assert.ok(h.includes('aria-valuenow="0"'));
  });

  test(`${name}: a reached limit shows a red line with its own reachedUntil, or "it resets"`, () => {
    const s = proSnap();
    s.limits[0].reached = true;
    s.limits[0].reachedUntil = iso(30);
    s.limits[0].windows.push({ minutes: 300, label: '5-hour', usedPercent: 100, resetsAt: iso(30), weekly: false, short: true });
    let h = html(null, s);
    assert.ok(h.includes(`class="subs-note subs-reached">ChatGPT plan limit reached until ${C.subsWhen(iso(30))}<`), 'the 5-hour window ran out: its reset, not the weekly one');
    assert.ok(!h.includes(`reached until ${C.subsWhen(iso(3000))}`));
    assert.ok(h.includes('background:#d4588b'));
    s.limits[0].reachedUntil = null;
    h = html(null, s);
    assert.ok(h.includes('ChatGPT plan limit reached until it resets<'), 'null: never the longest window');
    s.limits[0].windows = [];
    h = html(null, s);
    assert.ok(h.includes('ChatGPT plan limit reached until it resets<'));
  });

  test(`${name}: colours at 0, the first level, the last level and 100`, () => {
    assert.strictEqual(C.subsColor(0, false, [75, 90]), '#3987e5');
    assert.strictEqual(C.subsColor(74, false, [75, 90]), '#3987e5');
    assert.strictEqual(C.subsColor(75, false, [75, 90]), '#c9a227');
    assert.strictEqual(C.subsColor(89, false, [75, 90]), '#c9a227');
    assert.strictEqual(C.subsColor(90, false, [75, 90]), '#d95926');
    assert.strictEqual(C.subsColor(100, false, [75, 90]), '#d4588b');
    assert.strictEqual(C.subsColor(10, true, [75, 90]), '#d4588b');
    assert.strictEqual(C.subsColor(80, false, [80]), '#d95926', 'one level: it is also the last');
  });

  test(`${name}: texts from the server are escaped`, () => {
    const s = proSnap();
    s.limits[0].label = 'Codex <b>"x"</b>';
    s.limits.push({ id: 'b', label: "O'Neil <i>", windows: [{ minutes: 60, label: '<u>hour</u>', usedPercent: 1, resetsAt: iso(5) }] });
    s.planType = '<script>';
    s.error = 'bad <b>thing</b>';
    const h = html(null, s);
    assert.ok(!h.includes('<b>') && !h.includes('<i>') && !h.includes('<script>') && !h.includes('<u>'));
    assert.ok(h.includes('Codex &lt;b&gt;&quot;x&quot;&lt;/b&gt;, weekly'));
    assert.ok(h.includes('bad &lt;b&gt;thing&lt;/b&gt;'));
  });

  test(`${name}: Claude windows; models replace seven_day_opus / seven_day_sonnet; oauth apps skipped`, () => {
    const c = {
      fetchedAt: iso(-1), subscription: 'max', error: null, warn: { at: [75, 90] },
      windows: { five_hour: { utilization: 30, resets_at: iso(60) }, seven_day: { utilization: 55, resets_at: iso(3000) }, seven_day_opus: { utilization: 60, resets_at: iso(3000) }, seven_day_sonnet: { utilization: 20, resets_at: iso(3000) }, seven_day_oauth_apps: { utilization: 99, resets_at: iso(3000) } },
      models: {},
    };
    let h = html(c, null);
    assert.strictEqual(bars(h), 4);
    for (const l of ['5-hour', 'Weekly, all models', 'Weekly, Opus', 'Weekly, Sonnet']) assert.ok(h.includes(`>${l}<`), l);
    assert.ok(h.includes('Claude (max)') && !h.includes('99%'));
    c.models = { opus: { utilization: 61, resets_at: iso(3000), display_name: 'Opus' }, fable: { utilization: 91, resets_at: iso(3000), display_name: 'Fable' } };
    h = html(c, null);
    assert.ok(h.includes('61% used') && !h.includes('60% used'), 'the model entry replaces seven_day_opus');
    assert.ok(h.includes('>Weekly, Fable<') && h.includes('background:#d95926'));
    assert.ok(h.includes('>Weekly, Sonnet<'));
    c.error = 'no token';
    assert.ok(html(c, null).includes('subs-err">no token'));
  });

  test(`${name}: off gives no bars; ChatGPT block only with a codex agent or a reading`, () => {
    assert.strictEqual(html({ windows: { five_hour: { utilization: 1 } } }, proSnap(), { on: false }), '');
    const noRead = { enabled: true, readAt: null, limits: [], planType: null };
    assert.strictEqual(html(null, noRead, { codexAgents: false }), '');
    const h = html(null, noRead, { codexAgents: true });
    assert.ok(h.includes('No reading yet. Codex reports it during its turns, or press Read now.'));
  });

  test(`${name}: "Last seen" after 30 minutes, reset credits, error`, () => {
    const s = proSnap();
    s.readAt = iso(-45); s.resetCredits = 2; s.error = 'offline';
    const h = html(null, s);
    assert.ok(h.includes('Last seen ') && h.includes('2 reset credits available') && h.includes('offline'));
  });

  test(`${name}: codexBadge`, () => {
    const lv = [75, 90];
    let b = C.codexBadge(proSnap(), lv, NOW);
    assert.strictEqual(b.text, 'ChatGPT 42%');
    assert.strictEqual(b.cls, '');
    assert.ok(b.title.startsWith("ChatGPT plan: 42% of this week's allowance, resets ") && !b.title.includes('last seen'));
    // the highest non-expired weekly over all limits
    let s = proSnap();
    s.limits.push({ id: 'x', label: 'X', windows: [{ minutes: 10080, label: 'weekly', usedPercent: 80, weekly: true, resetsAt: iso(10) }, { minutes: 10080, label: 'weekly', usedPercent: 99, weekly: true, expired: true }] });
    b = C.codexBadge(s, lv, NOW);
    assert.strictEqual(b.text, 'ChatGPT 80%');
    assert.strictEqual(b.cls, 'warn');
    s.limits[1].windows[0].usedPercent = 92;
    assert.strictEqual(C.codexBadge(s, lv, NOW).cls, 'hot');
    // 5h appended above 50 only
    s = proSnap();
    s.limits[0].windows.push({ minutes: 300, label: '5-hour', usedPercent: 50, short: true, weekly: false, resetsAt: iso(30) });
    assert.strictEqual(C.codexBadge(s, lv, NOW).text, 'ChatGPT 42%');
    s.limits[0].windows[1].usedPercent = 51;
    assert.strictEqual(C.codexBadge(s, lv, NOW).text, 'ChatGPT 42% · 5h 51%');
    // no weekly: the longest window with its label
    s = proSnap();
    s.limits[0].windows = [{ minutes: 300, label: '5-hour', usedPercent: 40, short: true, weekly: false, resetsAt: iso(30) }];
    assert.strictEqual(C.codexBadge(s, lv, NOW).text, 'ChatGPT 5-hour 40%');
    // reached
    s = proSnap(); s.limits[0].reached = true; s.limits[0].reachedUntil = iso(30);
    s.limits[0].windows.push({ minutes: 300, label: '5-hour', usedPercent: 100, short: true, weekly: false, resetsAt: iso(30) });
    b = C.codexBadge(s, lv, NOW);
    assert.deepStrictEqual([b.text, b.cls], ['ChatGPT limit reached', 'refused']);
    assert.ok(b.title.includes(`until ${C.subsWhen(iso(30))}`) && !b.title.includes(C.subsWhen(iso(3000))), 'the 5-hour reset');
    s.limits[0].reachedUntil = null;
    assert.ok(C.codexBadge(s, lv, NOW).title.includes('until it resets'));
    // an expired reading alone never looks current
    s = proSnap(); s.limits[0].windows[0].expired = true; s.limits[0].windows[0].usedPercent = 95;
    assert.strictEqual(C.codexBadge(s, lv, NOW), null);
    s.limits.push({ id: 'y', label: 'Y', windows: [{ minutes: 300, label: '5-hour', usedPercent: 20, short: true, weekly: false, resetsAt: iso(30), expired: false }] });
    assert.strictEqual(C.codexBadge(s, lv, NOW).text, 'ChatGPT 5-hour 20%', 'a live window is chosen over the expired one');
    // last seen in the title
    s = proSnap(); s.readAt = iso(-40);
    assert.ok(C.codexBadge(s, lv, NOW).title.includes('; last seen '));
    // null without readings
    assert.strictEqual(C.codexBadge(null, lv, NOW), null);
    assert.strictEqual(C.codexBadge({ readAt: null, limits: [] }, lv, NOW), null);
    s = proSnap(); s.readAt = null;
    assert.strictEqual(C.codexBadge(s, lv, NOW), null);
    assert.strictEqual(C.codexBadge({ readAt: iso(-1), limits: [] }, lv, NOW), null);
  });
}

test('the helper blocks of app.js and mobile.js are the same code', () => {
  const norm = (s) => s.split('\n').map(l => l.trim()).join('\n');
  assert.strictEqual(norm(slice(app)), norm(slice(mjs)));
});

test('desktop source: the Subscriptions section is listed before st-plan-section and built before the Claude plan', () => {
  assert.ok(app.includes("'st-or-section', 'st-subs-section', 'st-plan-section'"));
  const a = app.indexOf('id="st-subs-section"'), b = app.indexOf('id="st-plan-section"');
  assert.ok(a > 0 && b > a, 'section built before the Claude plan section');
  assert.ok(app.includes('<h4>Subscriptions</h4>') && app.includes('id="st-subs-on"'));
  assert.ok(app.includes("Shows how much of each subscription's allowance is used, in Settings, the chat header and your lead's notes. Free: no turns are spent to read it."));
  assert.ok(app.includes('JSON.stringify({ subscriptionUsage: !!on })') && app.includes('if (box) box.checked = !on;'), 'saved; reverted on failure');
  assert.ok(app.includes("source.addEventListener('codex_usage'") && app.includes("fetch('/api/codex-usage'"));
  assert.ok(app.includes("await openSettingsAt('st-plan-section')") && app.includes("openSettingsAt('st-subs-section')"));
});

test('phone source: menu-subs is hidden until the account is an admin; the sheet reuses the dialog guard', () => {
  const html = read('mobile.html');
  assert.ok(html.includes('<button id="menu-subs" hidden>&#x1F4CA; Subscriptions</button>'));
  assert.ok(mjs.includes("const su = $('menu-subs'); if (su) su.hidden = !(hubMe && hubMe.isAdmin === true);"));
  assert.ok(mjs.includes("$('menu-subs')?.addEventListener('click', openSubsSheet);"));
  assert.match(mjs, /function openSubsSheet\(\) \{[\s\S]{0,300}dialogGuard\.open\(sh/);
  assert.ok(mjs.includes("on('codex_usage'") && mjs.includes("api('/api/codex-usage')"));
  assert.ok(html.includes('.subs-bar { display: grid; grid-template-columns: minmax(0, 1fr);'), 'one column on the phone: label, bar, then the figures');
});

test('no U+FE0F in the changed files', () => {
  const vs = String.fromCharCode(0xfe0f);
  // the pages already carried some before this change; the new code adds none
  for (const f of ['app.js', 'mobile.js']) assert.ok(!slice(read(f)).includes(vs), `${f}: subscriptions block`);
  assert.ok(!read('test/ui-subscriptions.test.js').includes(vs));
  const html = read('mobile.html');
  assert.ok(!html.match(/<button id="menu-subs"[^\n]*/)[0].includes(vs));
  assert.ok(!html.match(/\.subs-[^\n]*/g).join('\n').includes(vs));
  assert.ok(!read('index.html').match(/#st-subs-body[^\n]*/g).join('\n').includes(vs));
  for (const f of ['app.js', 'mobile.js']) {
    const s = read(f);
    for (const k of ['subsSheet', 'saveSubsOn', 'subsPlanWarning', 'paintSubsBox']) { const i = s.indexOf(`function ${k}(`); if (i > 0) assert.ok(!s.slice(i, i + 1800).includes(vs), `${f}: ${k}`); }
  }
});
