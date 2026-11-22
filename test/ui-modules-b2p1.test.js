'use strict';
// modules.html: the one-button step says it was done after a reload, the check step prints its time in words, and the
// administrator choice names the computer Maestro runs on. The page script runs in a vm with a small fake document.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'modules.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];

function load() {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', disabled: false, classList: { add() {}, remove() {}, contains() { return false; } }, scrollIntoView() {} });
  const document = {
    hidden: false,
    getElementById: (id) => el(id),
    createElement: () => ({ set innerHTML(v) { this._h = v; this.firstChild = { innerHTML: v.replace(/^<div id="auto-area">/, '').replace(/<\/div>$/, '') }; }, get innerHTML() { return this._h; } }),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
  };
  const fetch = async (url) => (url === '/api/modules' ? { ok: true, status: 200, json: async () => ({ modules: [] }) } : { ok: true, status: 200, json: async () => ({}) });
  const ctx = vm.createContext({ document, window: { addEventListener() {} }, fetch, location: { origin: 'http://hub', search: '', hash: '', pathname: '/modules' }, history: { replaceState() {} }, navigator: { clipboard: { writeText: async () => {} } }, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, URLSearchParams });
  vm.runInContext(script + '\nthis.t = { stepHtml, setCurrent(m) { current = m; }, setSelected(s) { selected = s; }, setAuto(x) { autoRes = x; }, autoAreaHtml };', ctx);
  return ctx.t;
}

const ADMIN = { label: 'Run it without an administrator', warning: 'The server then has the same access to files as your Maestro.' };
const DONE_AT = new Date(2026, 10, 22, 15, 40).toISOString();   // 22 Nov 2026, 15:40 on whatever clock runs this
const STEPS = (over = {}) => [
  { id: 'about', type: 'explain', title: 'What this does', body: 'Body', confirm: 'I understand.', done: true, doneAt: DONE_AT },
  { id: 'setup', type: 'auto', title: 'Set it up', body: 'Installs it.', install: true, prepare: true, check: 'server', adminChoice: { setting: 'run_as', value: 'hub', ...ADMIN }, done: false, doneAt: null, ...over },
  { id: 'add', type: 'check', title: 'Add a computer', body: 'Add it.', check: 'installer', done: false, doneAt: null },
  { id: 'done', type: 'finish', title: 'Finish', body: '', done: false, doneAt: null },
];
function detail(stepOver = {}, over = {}) {
  return { id: 'demo', name: 'Demo', state: 'setup', steps: STEPS(stepOver), manifest: { settings: [] }, settings: {}, candidates: [], agents: [], leads: ['owner'], leadsAlways: true, enabled: false, finishedAt: null, secretsSet: [], installed: true, lastCheck: null, ...over };
}

test('a done one-button step, after a reload (nothing pressed): says when it was done, shows the Next button, and keeps "Set it up"', () => {
  const t = load(); const m = detail({ done: true, doneAt: DONE_AT }); t.setCurrent(m); t.setAuto({});
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /<div class="msg show ok" id="auto-done">Done on Nov 22, 2026, 3:40\s?[AP]M\.<\/div>/);
  assert.match(out, /<button class="primary" onclick="selectStep\('add'\)">Next: Add a computer<\/button>/);
  assert.match(out, /id="btn-auto"[^>]*>Set it up<\/button>/, 'the button to run it again stays');
  assert.ok(!/2026-11/.test(out), 'no raw timestamp');
});

test('a done one-button step with no later open step: the Done line, no Next button; a step not done shows neither', () => {
  const t = load(); const m = detail({ done: true, doneAt: DONE_AT });
  m.steps.forEach(s => { s.done = true; s.doneAt = DONE_AT; }); m.steps[3].done = false;   // only the finish is open: that is the next
  t.setCurrent(m); t.setAuto({});
  assert.match(t.stepHtml(m.steps[1]), /Next: Add a computer|Next: Finish/);
  m.steps[3].done = true; t.setCurrent(m);
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /id="auto-done">Done on Nov 22/);
  assert.ok(!/Next:/.test(out));
  const open = detail(); t.setCurrent(open);
  const o2 = t.stepHtml(open.steps[1]);
  assert.ok(!/auto-done/.test(o2) && !/Done/.test(o2.replace(/id="btn-auto"[^>]*>Set it up/, '')));
});

test('after pressing the button this visit, the pressed-done text is used, not the reload text', () => {
  const t = load(); const m = detail({ done: true, doneAt: DONE_AT }); t.setCurrent(m);
  t.setAuto({ setup: { done: true, lines: [], check: { ok: true, summary: 'The server is running.' } } });
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /<div class="msg show ok">Done\. The server is running\.<\/div>/);
  assert.ok(!/auto-done/.test(out));
});

test('the check step prints its time as a date and time in words, never the raw ISO string', () => {
  const t = load(); const m = detail({}, { lastCheck: { ok: true, summary: 'The installer link is ready.', lines: [], warnings: [], at: '2026-11-22T20:40:00.000Z' } });
  t.setCurrent(m);
  const out = t.stepHtml(m.steps[2]);
  assert.match(out, /<span class="dim">Checked Nov 2[23], 2026, \d{1,2}:\d{2}\s?[AP]M<\/span>/);
  assert.ok(!/2026-11-22T/.test(out), 'no ISO string');
});

test('the page prints no other raw timestamp: every .at and doneAt that reaches the page goes through fmtStamp or fmtDay', () => {
  const raw = [...script.matchAll(/\$\{esc\(([^)]*\b(?:at|doneAt|finishedAt|verified)\b)\)\}/g)].map(x => x[1]);
  assert.deepStrictEqual(raw.filter(x => !/fmtStamp|fmtDay/.test(x)), []);
});

const adminState = (computer) => ({ setup: { error: 'x', check: { summary: 'The server could not be started as a service.', lines: [] }, admin: { command: 'sudo systemctl start <demo>', label: ADMIN.label, warning: ADMIN.warning, ask: true, ...(computer === undefined ? {} : { computer }) }, choices: {}, lines: [] } });

test('administrator choice: the heading and the copy line name the computer Maestro runs on', () => {
  const t = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup'); t.setAuto(adminState('hub.example.ts.net'));
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /<p><b>The server needs an administrator on the computer your Maestro runs on \(hub\.example\.ts\.net\) to finish\. Pick one:<\/b><\/p>/);
  assert.match(out, /<div class="dim"[^>]*>Copy the command and run it as an administrator on the computer your Maestro runs on \(hub\.example\.ts\.net\):<\/div>/);
});

test('administrator choice: without a name the same sentences have no bracket (null, missing or empty)', () => {
  for (const c of [undefined, null, '']) {
    const t = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup'); t.setAuto(adminState(c));
    const out = t.stepHtml(m.steps[1]);
    assert.match(out, /<b>The server needs an administrator on the computer your Maestro runs on to finish\. Pick one:<\/b>/);
    assert.match(out, /Copy the command and run it as an administrator on the computer your Maestro runs on:<\/div>/);
    assert.ok(!/\(\)/.test(out) && !/\(null\)|\(undefined\)/.test(out));
  }
});

test('administrator choice: the computer name is escaped', () => {
  const t = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup'); t.setAuto(adminState('<img src=x onerror=alert(1)>'));
  const out = t.stepHtml(m.steps[1]);
  assert.ok(!/<img/.test(out));
  assert.match(out, /\(&lt;img src=x onerror=alert\(1\)&gt;\)/);
});
