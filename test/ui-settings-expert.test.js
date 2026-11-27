'use strict';
// Settings > expert values, read-only .env rows, protected settings and the memory limit (lib/ui-settings-expert.js). Offline: a fake fetchJson and a fake host.
const test = require('node:test');
const assert = require('node:assert');
const X = require('../lib/ui-settings-expert.js');
const files = require('../lib/static-files.js');

const records = [
  { id: 'OPT-0991', name: 'Time zone of this Maestro', storedAs: 'env:HUB_TZ', what: 'Sets the time zone for jobs. More words.', def: "Default: this computer's own time zone." },
  { id: 'OPT-0993', name: 'Nightly memory check', storedAs: 'env:HUB_MEMORY_HEALTH', what: 'Controls the nightly look.' },
  { id: 'OPT-0800', name: 'Port', storedAs: 'env:PORT', what: 'The port your Maestro listens on. Extra.', lead: 'screen' },
  { id: 'OPT-0900', name: 'Password for the web login', storedAs: 'env:HUB_AUTH_PASSWORD', what: 'The login password.', lead: 'screen' },
  { id: 'OPT-0910', name: 'Team templates', storedAs: 'settings.teamTemplates', what: 'Saved team layouts.', lead: 'screen' },
  { id: 'OPT-1095', name: 'Memory limit for background work', storedAs: 'settings.jobMemoryLimitGb', what: 'How much memory one job may use.' },
];
const row = (key, x) => Object.assign({ key, value: null, set: false, writable: false, readonly: false, danger: false, running: null, pending: false }, x);
const ROWS = [
  row('HUB_TZ', { value: 'Europe/Berlin', set: true, writable: true, running: null, pending: true }),
  row('HUB_MEMORY_HEALTH', { writable: true }),
  row('PORT', { value: '3000', set: true, readonly: true, running: '3000' }),
  row('HUB_AUTH_PASSWORD', { value: null, set: true, danger: true, readonly: true }),
  row('HUB_BIND_HOST', { value: '192.0.2.5', set: true, danger: true, readonly: true }),
];

function fakeHost() {
  const h = { innerHTML: '', handlers: {}, inputs: {} };
  h.addEventListener = (t, f) => { h.handlers[t] = f; };
  h.querySelector = (sel) => { const m = sel.match(/\[([\w-]+)="?([^"\]]*)"?\]|\[([\w-]+)\]/); const k = m[2] !== undefined ? m[1] + '=' + m[2] : m[3]; return h.inputs[k] || null; };
  h.click = (act, key) => h.handlers.click({ target: { getAttribute: (a) => (a === 'data-act' ? act : a === 'data-key' ? key : null) } });
  return h;
}

test('model: three blocks, names from records, protected includes the settings keys', () => {
  const m = X.models(ROWS, records, { teamTemplates: [{}, {}, {}], toolPolicy: {} });
  assert.deepStrictEqual(m.expert.map((x) => x.key), ['HUB_TZ', 'HUB_MEMORY_HEALTH']);
  assert.strictEqual(m.expert[0].name, 'Time zone of this Maestro');
  assert.strictEqual(m.expert[0].id, 'OPT-0991');
  assert.deepStrictEqual(m.file.map((x) => x.key), ['PORT']);
  assert.strictEqual(m.file[0].help, 'The port your Maestro listens on.');
  assert.deepStrictEqual(m.protectedRows.map((x) => x.key), ['HUB_AUTH_PASSWORD', 'HUB_BIND_HOST', ...X.DANGER_SETTINGS]);
  const tt = m.protectedRows.find((x) => x.key === 'teamTemplates');
  assert.strictEqual(tt.shown, '3 templates');
  assert.strictEqual(tt.where, X.SCREEN_HELP);
  assert.strictEqual(m.protectedRows.find((x) => x.key === 'HUB_BIND_HOST').where, X.FILE_HELP);
});

test('values: a secret is only set / not set, never its text', () => {
  assert.strictEqual(X.formatValue({ key: 'HUB_AUTH_PASSWORD', value: 'hunter2', set: true }), 'set');
  assert.strictEqual(X.formatValue({ key: 'HUB_AUTH_PASSWORD', value: null, set: false }), 'not set');
  assert.strictEqual(X.formatValue({ key: 'PORT', value: '3000', set: true }), '3000');
  const html = X.expertHtml(X.models([row('HUB_AUTH_PASSWORD', { value: 'hunter2', set: true, danger: true })], records, null));
  assert.ok(!html.includes('hunter2'));
  assert.ok(html.includes('>set<'));
});

test('pending text and the review item', () => {
  assert.strictEqual(X.pendingText({ pending: false }), 'Takes effect after a restart.');
  assert.strictEqual(X.pendingText({ pending: true }), 'Saved. Restart your Maestro to use it.');
  assert.strictEqual(X.reviewItem([row('A'), row('B')]), null);
  const it = X.reviewItem([row('A', { writable: true, pending: true }), row('B', { writable: true, pending: true }), row('C', { writable: true })]);
  assert.strictEqual(it.tier, 'worth');
  assert.strictEqual(it.title, 'Restart your Maestro to use the new expert values (2)');
  // a read-only or protected value that differs from what runs is not this page's to wait for
  assert.strictEqual(X.reviewItem([row('PORT', { readonly: true, pending: true }), row('HUB_BIND_HOST', { danger: true, readonly: true, pending: true })]), null);
});

test('review source registers and reports only when something is pending', async () => {
  const seen = [];
  const hub = { register: (s) => { seen.push(s); return true; } };
  let answer = { rows: ROWS };
  assert.strictEqual(X.registerReview(hub, async () => answer), true);
  assert.strictEqual(seen[0].id, 'expert-values');
  // the review list hands sources a plain fetch (a Response); the source reads through its own fetchJson
  const plainFetch = async () => ({ ok: true, json: async () => ({ rows: [] }) });
  const r = await seen[0].load(plainFetch);
  assert.strictEqual(r.problems.length, 1);
  answer = { rows: [row('A', { writable: true })] };
  assert.deepStrictEqual(await seen[0].load(plainFetch), { problems: [] });
  answer = { error: 'no' };
  await assert.rejects(seen[0].load(plainFetch));
  assert.strictEqual(X.registerReview(null, null), false);
});

test('html: controls per key, escaped, data-setting on each row', () => {
  const html = X.expertHtml(X.models(ROWS, records, null));
  assert.ok(html.includes('data-setting="OPT-0991"'));
  assert.ok(html.includes('Saved. Restart your Maestro to use it.'));
  assert.ok(html.includes('Takes effect after a restart.'));
  assert.ok(html.includes('Expert values') && html.includes('Set in the .env file') && html.includes('Protected settings'));
  assert.ok(html.includes('Change it in the .env file in your Maestro&#39;s folder; takes effect after a restart.'));
  assert.ok(html.includes('<select id="st-env-HUB_MEMORY_HEALTH" data-envin="HUB_MEMORY_HEALTH">'));   // the id is the record's anchor for its help
  const evil = X.expertHtml(X.models([row('HUB_TZ', { writable: true, value: '"><script>x</script>', set: true })], records, null));
  assert.ok(!evil.includes('<script>'));
});

test('checkValue: numbers refused outside range, empty accepted', () => {
  const m = X.models([row('HUB_UPDATE_CHECK_HOURS', { writable: true })], [], null).expert[0];
  assert.strictEqual(m.name, 'HUB_UPDATE_CHECK_HOURS');
  assert.strictEqual(X.checkValue(m, ''), '');
  assert.strictEqual(X.checkValue(m, '12'), '');
  assert.match(X.checkValue(m, 'abc'), /whole number/);
  assert.match(X.checkValue(m, '0'), /1 or more/);
  assert.match(X.checkValue(m, '99999'), /or less/);
});

test('render: saves through POST /api/settings/env, "Use default" sends empty, errors show the server words', async () => {
  const calls = []; const toasts = [];
  let fail = null;
  const fetchJson = async (url, opts) => {
    calls.push([url, opts && opts.method, opts && opts.body]);
    if (opts && opts.method === 'POST') { if (fail) throw new Error(fail); return { ok: true, restartNeeded: true }; }
    if (url === '/api/settings/env') return { rows: ROWS };
    return {};
  };
  const host = fakeHost();
  let loads = 0;
  await X.render(host, { records, fetchJson, toast: (t) => toasts.push(t), settings: {}, loaded: (h) => { assert.strictEqual(h, host); loads++; } });
  assert.strictEqual(loads, 1, 'the drawn values are handed to the dialog guard as saved');
  assert.ok(host.innerHTML.includes('Time zone of this Maestro'));
  host.inputs['data-envin=HUB_TZ'] = { value: 'America/Chicago' };
  await host.click('save', 'HUB_TZ');
  const lastPost = () => [...calls].reverse().find((c) => c[1] === 'POST');
  assert.deepStrictEqual(lastPost(), ['/api/settings/env', 'POST', JSON.stringify({ key: 'HUB_TZ', value: 'America/Chicago' })]);
  assert.deepStrictEqual(calls[calls.length - 1], ['/api/settings/env', undefined, undefined], 'the rows are read back after a save');
  assert.deepStrictEqual(toasts.pop(), 'Saved. Restart your Maestro to use it.');
  assert.strictEqual(loads, 2, 'and the redrawn values are saved for the guard again');
  await host.click('default', 'HUB_TZ');
  assert.strictEqual(JSON.parse(lastPost()[2]).value, '');
  fail = 'That is not a time zone.';
  await host.click('save', 'HUB_TZ');
  assert.strictEqual(toasts.pop(), 'That is not a time zone.');
});

test('render: a failed read says so; no request goes out for a bad number', async () => {
  const host = fakeHost();
  await X.render(host, { records, fetchJson: async () => { throw new Error('Admins only.'); } });
  assert.ok(host.innerHTML.includes('Could not read the expert values: Admins only.'));
  const calls = []; const toasts = [];
  const h2 = fakeHost();
  await X.render(h2, { records, fetchJson: async (u, o) => { calls.push(o && o.method); return { rows: [row('HUB_UPDATE_CHECK_HOURS', { writable: true })] }; }, toast: (t) => toasts.push(t), settings: {} });
  h2.inputs['data-envin=HUB_UPDATE_CHECK_HOURS'] = { value: '-3' };
  await h2.click('save', 'HUB_UPDATE_CHECK_HOURS');
  assert.ok(!calls.includes('POST'));
  assert.match(toasts[0], /whole number/);
});

test('memory limit (OPT-1095): model, payload, and saving through POST /api/settings', async () => {
  assert.strictEqual(X.memoryModel({}, records).shown, 'Automatic');
  assert.strictEqual(X.memoryModel({ jobMemoryLimitGb: null }, records).automatic, true);
  assert.strictEqual(X.memoryModel({ jobMemoryLimitGb: 0 }, records).shown, 'Off (no limit)');
  assert.strictEqual(X.memoryModel({ jobMemoryLimitGb: 8 }, records).shown, '8 GB');
  assert.strictEqual(X.memoryModel({ jobMemoryLimitGb: -2 }, records).shown, 'Automatic');
  assert.deepStrictEqual(X.memoryPayload(''), { body: { jobMemoryLimitGb: null } });
  assert.deepStrictEqual(X.memoryPayload('0'), { body: { jobMemoryLimitGb: 0 } });
  assert.deepStrictEqual(X.memoryPayload('12.5'), { body: { jobMemoryLimitGb: 12.5 } });
  assert.ok(X.memoryPayload('lots').error);
  assert.ok(X.memoryPayload('5000').error);
  const calls = []; const toasts = [];
  const host = fakeHost();
  await X.renderMemoryLimit(host, { records, settings: { jobMemoryLimitGb: 4 }, fetchJson: async (u, o) => { calls.push([u, o.body]); return { ok: true }; }, toast: (t) => toasts.push(t) });
  assert.ok(host.innerHTML.includes('data-setting="OPT-1095"') && host.innerHTML.includes('Memory limit for background work'));
  host.inputs['data-memin'] = { value: '16' };
  await host.click('mem-save');
  assert.deepStrictEqual(calls.pop(), ['/api/settings', JSON.stringify({ jobMemoryLimitGb: 16 })]);
  await host.click('mem-default');
  assert.strictEqual(calls.pop()[1], JSON.stringify({ jobMemoryLimitGb: null }));
  assert.ok(host.innerHTML.includes('Automatic'));
});

test('R7/R11: a value set outside the .env file and an export line are said in words; only writable pending rows count', () => {
  const rows = [row('HUB_TZ', { writable: true, outside: 'UTC' }), row('HUB_MEMORY_HEALTH', { writable: true, note: 'export' }), row('PORT', { readonly: true, value: null, outside: '3000', running: '3000' }), row('HUB_AUTH_PASSWORD', { danger: true, readonly: true, set: true, outside: 'hunter2' })];
  const html = X.expertHtml(X.models(rows, records, null));
  assert.ok(html.includes('Set outside the .env file: UTC'));
  assert.ok(html.includes('Set outside the .env file: 3000'), 'a read-only row too');
  assert.ok(html.includes('This line starts with export, so it is not read.'));
  assert.ok(!html.includes('hunter2'), 'a secret never shows its running value');
  assert.ok(!html.includes('Set outside the .env file: null') && !html.includes('Set outside the .env file: </'), 'no line when nothing runs outside');
  assert.strictEqual(X.reviewItem([row('PORT', { readonly: true, pending: true }), row('X', { danger: true, writable: true, pending: true })]), null);
  assert.strictEqual(X.pendingCount([row('A', { writable: true, pending: true }), row('B', { pending: true })]), 1);
});

test('R12: a value the control does not know is its own selected option; the number limits are the server\'s', () => {
  const html = X.expertHtml(X.models([row('HUB_COMMS_DISABLED', { writable: true, value: 'true', set: true }), row('HUB_CODEX_TRANSPORT', { writable: true, value: 'exec', set: true })], records, null));
  assert.ok(html.includes('<option value="true" selected>true (now)</option>'), html);
  assert.ok(html.includes('<option value="exec" selected>exec</option>') && !html.includes('exec (now)'));
  const lim = (k) => [X.KEYS[k].min, X.KEYS[k].max];
  assert.deepStrictEqual(lim('HUB_SECURITY_CHECK_HOURS'), [1, 8760]);
  assert.deepStrictEqual(lim('HUB_UPDATE_CHECK_HOURS'), [1, 8760]);
  assert.deepStrictEqual(lim('HUB_UPDATE_CHECK_FIRST_SECONDS'), [1, 86400]);
  assert.deepStrictEqual(lim('HUB_CONSULT_BUSY_WAIT_MS'), [1000, 600000]);
  assert.deepStrictEqual(lim('HUB_DELIVERY_COOLDOWN_MS'), [1000, 3600000]);
  assert.deepStrictEqual(lim('HUB_SDK_AUTO_COMPACT_WINDOW'), [10000, 2000000]);
  const m = X.models([row('HUB_CONSULT_BUSY_WAIT_MS', { writable: true })], [], null).expert[0];
  assert.match(X.checkValue(m, '999'), /1000 or more/);
  assert.match(X.checkValue(m, '600001'), /600000 or less/);
});

test('R13: a read-only address shows without user:pass@ and with the query replaced', () => {
  assert.strictEqual(X.safeUrl('https://sam:pw@gw.example.com:8443/v1/x?token=abc&y=1'), 'https://gw.example.com:8443/v1/x?…');
  assert.strictEqual(X.safeUrl('https://gw.example.com/v1'), 'https://gw.example.com/v1');
  assert.strictEqual(X.safeUrl('3000'), '3000');
  const html = X.expertHtml(X.models([row('GATEWAY_URL', { readonly: true, set: true, value: 'https://sam:pw@gw.example.com/a?key=SECRET' })], [], null));
  assert.ok(html.includes('https://gw.example.com/a?…') && !html.includes('SECRET') && !html.includes('sam:pw'), html);
});

test('the module is served to the browser', () => {
  assert.ok(JSON.stringify([...files.PUBLIC_FILES || []]).length >= 0);
  assert.ok(require('fs').readFileSync(require('path').join(__dirname, '../lib/static-files.js'), 'utf8').includes("['ui-settings-expert.js', 'lib/ui-settings-expert.js']"));
});
