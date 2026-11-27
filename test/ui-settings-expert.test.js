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
  assert.ok(html.includes('Startup values') && !html.includes('Expert values') && html.includes('Set in the .env file') && html.includes('Protected settings'));
  assert.ok(html.includes('Change it in the .env file in your Maestro&#39;s folder; takes effect after a restart.'));
  // the id and data-setting on the control are the record's anchor for its help; the label's for= points at the id so the ⓘ lands right after the label
  assert.ok(html.includes('<select id="st-env-HUB_MEMORY_HEALTH" data-envin="HUB_MEMORY_HEALTH" data-setting="OPT-0993">'));
  assert.ok(html.includes('<label for="st-env-HUB_MEMORY_HEALTH">Nightly memory check</label>'));
  const evil = X.expertHtml(X.models([row('HUB_TZ', { writable: true, value: '"><script>x</script>', set: true })], records, null));
  assert.ok(!evil.includes('<script>'));
});

test('Startup values rows use the Expert values layout: st-xrow, label + one help paragraph with Default: on the left, box on the right', () => {
  const recs = [{ id: 'OPT-0950', name: 'Update check', storedAs: 'env:HUB_UPDATE_CHECK_HOURS', what: 'How often your Maestro looks for updates. More.', def: '24 hours' }];
  const html = X.expertHtml(X.models([row('HUB_UPDATE_CHECK_HOURS', { writable: true })], recs, null));
  assert.ok(html.includes('<div class="st-row st-xrow" data-expert="HUB_UPDATE_CHECK_HOURS">'));
  const xl = /<div class="st-xl">([\s\S]*?)<\/div><div class="st-xr">/.exec(html);
  assert.ok(xl, 'left column');
  assert.ok(xl[1].startsWith('<label for="st-env-HUB_UPDATE_CHECK_HOURS">Update check</label>'));
  assert.match(xl[1], /<div class="st-hint st-xhelp">How often your Maestro looks for updates\. Default: <span data-for="HUB_UPDATE_CHECK_HOURS">24 hours<\/span>\.<\/div>/);
  assert.strictEqual((xl[1].match(/class="st-hint/g) || []).length, 1, 'one dim paragraph');
  const xr = /<div class="st-xr">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(xr.includes('<input type="number"') && xr.includes('data-envin="HUB_UPDATE_CHECK_HOURS"') && xr.includes('data-setting="OPT-0950"'));
  assert.ok(xr.includes('data-act="save"') && xr.includes('data-act="default"') && xr.includes('hours'));
  assert.ok(!xl[1].includes('<input'), 'the box is not in the left column');
  assert.match(xr, /placeholder="24"/, 'the placeholder is the default number');
  assert.ok(!/placeholder="Default"/.test(html));
});

test('Startup values placeholder: a default that is not one number leaves the box empty; "Default:" in the record is not doubled', () => {
  const mk = (def) => X.expertHtml(X.models([row('HUB_UPDATE_CHECK_HOURS', { writable: true })], [{ id: 'OPT-0950', name: 'N', storedAs: 'env:HUB_UPDATE_CHECK_HOURS', what: 'Words.', def }], null));
  assert.match(mk('off'), /placeholder=""/);
  assert.match(mk('Default: 6 hours.'), /placeholder="6"/);
  assert.ok(!mk('Default: 6 hours.').includes('Default: Default'));
  assert.ok(mk('Default: 6 hours.').includes('Default: <span data-for="HUB_UPDATE_CHECK_HOURS">6 hours</span>.'));
  assert.match(X.expertHtml(X.models([row('HUB_UPDATE_CHECK_HOURS', { writable: true })], [], null)), /placeholder=""/);
});

test('Startup values: a read-only row keeps its words in the same layout', () => {
  const html = X.expertHtml(X.models([row('PORT', { value: '3000', set: true, readonly: true, running: '3000' })], records, null));
  assert.ok(html.includes('<div class="st-row st-xrow" data-readonly="PORT" data-setting="OPT-0800"><div class="st-xl"><label>Port</label>'));
  assert.ok(html.includes('The port your Maestro listens on.') && html.includes(X.FILE_HELP.replace(/'/g, '&#39;')));
  assert.match(html, /<div class="st-xr"><span class="st-value" id="st-ro-PORT">3000<\/span><\/div>/);
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
  assert.deepStrictEqual(lastPost(), ['/api/settings/env', 'POST', JSON.stringify({ key: 'HUB_TZ', value: 'America/Chicago', expect: 'Europe/Berlin' })]);
  assert.deepStrictEqual(calls[calls.length - 1], ['/api/settings/env', undefined, undefined], 'the rows are read back after a save');
  assert.deepStrictEqual(toasts.pop(), 'Saved. Restart your Maestro to use it.');
  assert.strictEqual(loads, 1, 'only the saved row is replaced (none in this fake host), never a redraw of every row');
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

test('saving one startup value locks its row, replaces only that row and leaves every other field untouched (review r7)', async () => {
  // a small DOM: rows with their own field objects; replacing a row makes new field objects for it only
  const mkField = (key) => ({ key, value: '', disabled: false, getAttribute: (a) => (a === 'data-envin' ? key : null) });
  const mkButton = (act, key) => ({ disabled: false, hidden: false, act, getAttribute: (a) => (a === 'data-act' ? act : a === 'data-key' ? key : null) });
  const rowsEl = {};
  const mkRow = (key, valueFromHtml) => {
    const f = mkField(key); f.value = valueFromHtml || '';
    const row = { key, field: f, buttons: [mkButton('save', key), mkButton('default', key)], attrs: {}, parentNode: host, removed: false };
    row.querySelectorAll = (sel) => (sel === 'input, select, button' ? [row.field, ...row.buttons] : sel === 'input, select, textarea' ? [row.field] : []);
    row.querySelector = (sel) => (/data-envin/.test(sel) ? row.field : row.buttons.find((b) => sel.includes(b.act)) || null);
    row.setAttribute = (k, v) => { row.attrs[k] = v; }; row.removeAttribute = (k) => { delete row.attrs[k]; };
    row.contains = () => false;
    row.insertAdjacentHTML = (pos, html) => { const v = (html.match(/data-envin="[A-Z_]+"[^>]*\bvalue="([^"]*)"/) || [])[1]; row.nextElementSibling = mkRow(key, v); };
    row.remove = () => { row.removed = true; rowsEl[key] = row.nextElementSibling; };
    rowsEl[key] = row;
    return row;
  };
  const host = { handlers: {} };
  Object.defineProperty(host, 'innerHTML', { get: () => '', set: (v) => { for (const k of ['HUB_TZ', 'HUB_SECURITY_CHECK_HOURS']) if (v.includes(`data-envin="${k}"`)) mkRow(k, (v.match(new RegExp(`data-envin="${k}"[^>]*\\bvalue="([^"]*)"`)) || [])[1]); } });
  host.addEventListener = (t, f) => { host.handlers[t] = f; };
  host.querySelectorAll = (sel) => Object.values(rowsEl).flatMap((r) => r.querySelectorAll(sel));
  host.querySelector = (sel) => { const k = (sel.match(/"([A-Z_]+)"/) || [])[1]; const r = rowsEl[k]; return !r ? null : /data-expert/.test(sel) ? r : r.field; };
  const rows = [
    { key: 'HUB_TZ', value: 'UTC', set: true, writable: true, readonly: false, danger: false, running: 'UTC', pending: false },
    { key: 'HUB_SECURITY_CHECK_HOURS', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false },
  ];
  let after = rows, lockedDuringPost = null, release;
  const gate = new Promise((r) => { release = r; });
  const fetchJson = async (url, opts) => {
    if (opts && opts.method === 'POST') { lockedDuringPost = rowsEl.HUB_TZ.field.disabled && rowsEl.HUB_TZ.buttons.every((b) => b.disabled); await gate; const b = JSON.parse(opts.body); after = rows.map((r) => (r.key === b.key ? Object.assign({}, r, { value: b.value || null, pending: true }) : r)); return { ok: true }; }
    if (url === '/api/settings/env') return { rows: after };
    return {};
  };
  const handed = [], toasts = [];
  await X.render(host, { records, fetchJson, toast: (t) => toasts.push(t), settings: {}, loaded: (h, fields) => handed.push(fields) });
  const tzRow = rowsEl.HUB_TZ, hoursField = rowsEl.HUB_SECURITY_CHECK_HOURS.field;
  hoursField.value = '12';   // a draft in B
  tzRow.field.value = 'Europe/Rome';   // A
  const click = (act, key) => host.handlers.click({ target: { getAttribute: (a) => (a === 'data-act' ? act : a === 'data-key' ? key : null) } });
  const saving = click('save', 'HUB_TZ');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(lockedDuringPost, true, 'A is locked while it saves (an edit to it cannot be lost under the answer)');
  assert.strictEqual(tzRow.attrs['aria-busy'], 'true');
  await click('save', 'HUB_TZ');
  assert.match(toasts.pop(), /still saving/);
  release(); await saving;
  assert.ok(tzRow.removed && rowsEl.HUB_TZ !== tzRow, 'only A was replaced');
  assert.strictEqual(rowsEl.HUB_SECURITY_CHECK_HOURS.field, hoursField, 'B keeps its own field (the guard tracks it by identity)');
  assert.strictEqual(hoursField.value, '12', 'and its draft');
  const last = handed[handed.length - 1];
  assert.deepStrictEqual(last, [rowsEl.HUB_TZ.field], 'only the new A field is handed to the guard as saved');
  assert.strictEqual(rowsEl.HUB_TZ.field.value, 'Europe/Rome');
  assert.match(toasts.pop(), /Restart your Maestro/);
});

test('a save or read-back with no answer never leaves the row locked; the words say what is not known (review r8)', async () => {
  const rows = [{ key: 'HUB_TZ', value: 'UTC', set: true, writable: true, readonly: false, danger: false, running: 'UTC', pending: false }];
  const never = new Promise(() => {});
  const run = async (hangPost) => {
    const field = { value: '', disabled: false, getAttribute: (a) => (a === 'data-envin' ? 'HUB_TZ' : null) };
    const btn = { disabled: false, getAttribute: () => null };
    const row = { attrs: {}, parentNode: {}, querySelectorAll: () => [field, btn], setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, contains: () => false };
    row.insertAdjacentHTML = () => { row.nextElementSibling = { querySelectorAll: () => [], querySelector: () => null }; };
    row.remove = () => { row.removed = true; };
    const host = { handlers: {}, innerHTML: '' };
    host.addEventListener = (t, f) => { host.handlers[t] = f; };
    host.querySelectorAll = () => [];
    host.querySelector = (sel) => (/data-expert/.test(sel) ? row : field);
    let gets = 0;
    const fetchJson = async (url, opts) => {
      if (opts && opts.method === 'POST') { if (hangPost) return never; return { ok: true }; }
      if (url === '/api/settings/env') { gets++; if (gets > 1) return never; return { rows }; }
      return {};
    };
    const toasts = [];
    await X.render(host, { records, fetchJson, toast: (t) => toasts.push(t), settings: {}, saveMs: 30, readBackMs: 30 });
    field.value = 'Europe/Rome';
    await host.handlers.click({ target: { getAttribute: (a) => (a === 'data-act' ? 'save' : a === 'data-key' ? 'HUB_TZ' : null) } });
    return { toasts, field, btn, row };
  };
  const a = await run(false);
  assert.match(a.toasts.pop(), /Saved, but your Maestro could not be asked whether it waits for a restart/);
  assert.ok(a.row.removed, 'the saved row is replaced (unlocked) after the read-back gave up');
  const b = await run(true);
  assert.match(b.toasts.pop(), /did not answer in time, so this may or may not be saved/);
  assert.strictEqual(b.field.disabled, false, 'a save with no answer unlocks the row');
  assert.strictEqual(b.btn.disabled, false);
  assert.ok(!('aria-busy' in b.row.attrs));
});

test('expect is the value each row last showed, not a newer read-back for another row (review r10)', async () => {
  let rowsNow = [
    { key: 'HUB_TZ', value: 'UTC', set: true, writable: true, readonly: false, danger: false, running: 'UTC', pending: false },
    { key: 'HUB_SECURITY_CHECK_HOURS', value: '12', set: true, writable: true, readonly: false, danger: false, running: '12', pending: false },
  ];
  const posts = [];
  const fetchJson = async (url, opts) => {
    if (opts && opts.method === 'POST') {
      const b = JSON.parse(opts.body); posts.push(b);
      // meanwhile another admin changed the hours to 24: the read-back after A's save shows it
      rowsNow = rowsNow.map((r) => (r.key === b.key ? Object.assign({}, r, { value: b.value }) : r.key === 'HUB_SECURITY_CHECK_HOURS' ? Object.assign({}, r, { value: '24' }) : r));
      return { ok: true };
    }
    if (url === '/api/settings/env') return { rows: rowsNow };
    return {};
  };
  const host = fakeHost();
  await X.render(host, { records, fetchJson, toast: () => {}, settings: {} });
  host.inputs['data-envin=HUB_TZ'] = { value: 'Europe/Rome' };
  await host.click('save', 'HUB_TZ');
  assert.strictEqual(posts[0].expect, 'UTC');
  host.inputs['data-envin=HUB_SECURITY_CHECK_HOURS'] = { value: '6' };   // the row still shows 12 (only A was redrawn)
  await host.click('save', 'HUB_SECURITY_CHECK_HOURS');
  assert.strictEqual(posts[1].expect, '12', 'B sends what B showed, so the hub refuses to overwrite the 24 nobody here saw');
});

test('every startup value and protected row shows its record words with records as the route sends them (no storedAs; proof p3)', () => {
  const fs = require('fs'), path = require('path');
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'settings-records.json'), 'utf8'));
  const routeShaped = (Array.isArray(R) ? R : R.records).map((r) => { const c = Object.assign({}, r); delete c.storedAs; delete c.facts; return c; });
  const EF = require('../lib/env-file.js');
  const rows = [...EF.ENV_WRITABLE, ...EF.ENV_READONLY, ...EF.ENV_DANGER].map((k) => ({ key: k, value: null, set: false, writable: EF.ENV_WRITABLE.includes(k), readonly: !EF.ENV_WRITABLE.includes(k), danger: EF.ENV_DANGER.includes(k), running: null, pending: false }));
  const m = X.models(rows, routeShaped, {});
  const all = [...m.expert, ...m.file, ...m.protectedRows];
  assert.strictEqual(all.length, rows.length + X.DANGER_SETTINGS.length);
  for (const x of all) {
    assert.ok(x.id, `${x.key}: has its record`);
    assert.ok(!/^[A-Z_]+$/.test(x.name) && x.name !== x.key, `${x.key}: shown with words, not the key ("${x.name}")`);
  }
  assert.strictEqual(m.expert.find((x) => x.key === 'HUB_SECURITY_CHECK_HOURS').name, 'Hours between security checks');
  // the matched record is the row's own (it lists the key among its labels), and the five merged records carry their own words
  const byId = new Map(routeShaped.map((r) => [r.id, r]));
  for (const x of all) assert.ok((byId.get(x.id).labels || []).includes(x.key), `${x.key}: matched ${x.id}, whose labels list it`);
  const want = { HUB_UPDATE_CHECK_HOURS: ['OPT-0995', 'Hours between update checks (startup setting)'], HUB_SELFCHECK: ['OPT-0992', 'Self-check at start'],
    HUB_SDK_AUTO_COMPACT_WINDOW: ['OPT-1001', 'Long-chat point for Claude agents'], GATEWAY_PROMPT_CACHE: ['OPT-1010', 'Reuse earlier text (startup setting)'],
    HUB_WALLET_OWNER: ['OPT-1000', 'Wallet owner address (startup setting)'] };
  for (const [k, [id, name]] of Object.entries(want)) {
    const x = all.find((y) => y.key === k);
    assert.deepStrictEqual([x.id, x.name], [id, name], k);
    assert.ok(x.help && x.help.length > 20, `${k}: has help`);
  }
  assert.match(all.find((y) => y.key === 'GATEWAY_PROMPT_CACHE').help, /^No part of your Maestro reads this older startup switch/);
});

test('the page hands its loaded records as a Map (hubSettingsHelp.load): rows still find their words (proof p5)', () => {
  const fs = require('fs'), path = require('path');
  const R = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'templates', 'settings-records.json'), 'utf8'));
  const map = new Map((Array.isArray(R) ? R : R.records).map((r) => { const c = Object.assign({}, r); delete c.storedAs; delete c.facts; return [c.id, c]; }));
  const m = X.models([{ key: 'HUB_SECURITY_CHECK_HOURS', value: null, set: false, writable: true, readonly: false, danger: false, running: null, pending: false }], map, { walletAgents: [] });
  assert.strictEqual(m.expert[0].name, 'Hours between security checks');
  assert.ok(m.protectedRows.every((x) => x.id && !/^[A-Za-z_]+$/.test(x.name) || x.name.includes(' ')), 'protected rows have words too');
  assert.strictEqual(X.memoryModel({}, map).id, 'OPT-1095');
});
