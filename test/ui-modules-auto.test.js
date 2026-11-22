'use strict';
// modules.html: the "Before you start" check, the one-button step (progress, choice, administrator choices), the Advanced fold,
// suggested settings and the run-mode line. The page script runs in a vm with a small fake document.
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
  const calls = [];
  const state = { responses: [], radio: null, gate: null };
  const listeners = {};   // document-level listeners the page registered: type -> [fn]
  const document = {
    hidden: false,
    getElementById: (id) => el(id),
    createElement: () => ({ set innerHTML(v) { this._h = v; this.firstChild = { innerHTML: v.replace(/^<div id="auto-area">/, '').replace(/<\/div>$/, '') }; }, get innerHTML() { return this._h; } }),
    querySelector: (sel) => (sel === 'input[name="auto-choice"]:checked' ? state.radio : null),
    querySelectorAll: () => [],
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
  };
  const fetch = async (url, opts) => {
    if (url === '/api/modules') return { ok: true, status: 200, json: async () => ({ modules: [] }) };
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method: (opts && opts.method) || 'GET', url, body });
    if (state.gate) await state.gate;
    const r = state.responses.shift() || { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  const ctx = vm.createContext({ document, window: { addEventListener() {} }, fetch, location: { origin: 'http://hub', search: '', hash: '', pathname: '/modules' }, history: { replaceState() {} }, navigator: { clipboard: { writeText: async (t) => { state.copied = t; } } }, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, URLSearchParams });
  vm.runInContext(script + '\nthis.t = { stepHtml, overviewHtml, settingField, advancedHtml, render, openModule, selectStep, loadSuggestions, checkAgain, runAutoStep, askMaestro, autoContinue, autoAdmin, copyAdminCmd, loadPrecheck, saveAdvanced, setCurrent(m) { current = m; }, getCurrent() { return current; }, setSelected(s) { selected = s; }, setPre(x) { preRes = x; }, getPre() { return preRes; }, setSug(x) { suggestions = x; }, getSug() { return suggestions; }, setAuto(x) { autoRes = x; }, getAuto() { return autoRes; }, setPollMs(n) { AUTO_POLL_MS = n; }, hasPollTimer() { return autoPollTimer !== null; }, autoAreaHtml };', ctx);
  const fire = (type, target) => (listeners[type] || []).forEach(fn => fn({ target }));
  return { t: ctx.t, calls, state, els, fire };
}

const SETTINGS = [
  { key: 'address_name', type: 'string', label: 'Name', suggest: 'tailnet_host' },
  { key: 'listen_ip', type: 'string', label: 'Address', suggest: 'tailnet_ip' },
  { key: 'control_port', type: 'number', label: 'Control port', advanced: true },
  { key: 'run_as', type: 'choice', label: 'How it runs', options: ['auto', 'service', 'hub'], advanced: true },
  { key: 'limit', type: 'number', label: 'Limit' },
];
const ADMIN = { label: 'Run it without an administrator', warning: 'The server then has the same access to files as your Maestro.' };
const STEPS = [
  { id: 'about', type: 'explain', title: 'What this does', body: 'Body', precheck: 'prereqs', confirm: 'I understand.', done: false },
  { id: 'setup', type: 'auto', title: 'Set it up', body: 'Installs it.', precheck: 'prereqs', install: true, prepare: true, check: 'server', adminChoice: { setting: 'run_as', value: 'hub', ...ADMIN }, done: false },
  { id: 'done', type: 'finish', title: 'Finish', body: '', done: false },
];
function detail(over = {}) {
  return { id: 'demo', name: 'Demo', state: 'setup', steps: STEPS.map(s => ({ ...s })), manifest: { settings: SETTINGS }, settings: { address_name: '', listen_ip: '', control_port: 9971, run_as: 'auto', limit: 5 }, candidates: [], agents: [], leads: ['owner'], leadsAlways: true, enabled: false, finishedAt: null, secretsSet: [], installed: false, ...over };
}
const flush = () => new Promise(r => setImmediate(r));

test('explain step with a precheck: not ok shows a plain red box, the lines, a Check again button; the tick box and Continue are disabled', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  t.setPre({ about: { ok: false, summary: "Tailscale isn't installed on the computer your Maestro runs on.", lines: ['Get it at https://tailscale.com/download, then come back to this page.'], blocker: 'tailscale-missing' } });
  const out = t.stepHtml(m.steps[0]);
  assert.match(out, /Before you start/);
  assert.match(out, /class="msg show err">Tailscale isn&#39;t installed/);
  assert.match(out, /come back to this page/);
  assert.match(out, /Check again/);
  assert.match(out, /id="confirm" disabled/);
  assert.match(out, /id="btn-next" disabled/);
  assert.ok(!/class="msg show ok"/.test(out));
});

test('explain step with a precheck: ok shows a green tick and each line, and the tick box and Continue work', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  t.setPre({ about: { ok: true, summary: 'This computer is ready.', lines: ['Found this computer on your private network: hub.example.ts.net (100.101.102.103).'], blocker: null } });
  const out = t.stepHtml(m.steps[0]);
  assert.match(out, /class="msg show ok"><span class="tick">✓<\/span> This computer is ready\./);
  assert.match(out, /<li>Found this computer on your private network: hub\.example\.ts\.net \(100\.101\.102\.103\)\.<\/li>/);
  assert.ok(!/id="confirm" disabled/.test(out) && !/id="btn-next" disabled/.test(out));
  assert.match(out, /Check again/);
});

test('while the check has not answered yet the controls are off and it says so; an explain step without a precheck is unchanged', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  const out = t.stepHtml(m.steps[0]);
  assert.match(out, /Checking this computer/);
  assert.match(out, /id="confirm" disabled/);
  const plain = t.stepHtml({ id: 'p', type: 'explain', title: 'P', body: 'b', confirm: 'ok', done: false });
  assert.ok(!/disabled/.test(plain) && !/Before you start/.test(plain));
  assert.match(plain, /doStep\('p', \{ confirmed: document\.getElementById\('confirm'\)\.checked \}\)/);
});

test('opening a step with a precheck runs it (GET precheck/<name>) and repaints; Check again runs it again; a refused call is shown as not ok', async () => {
  const { t, calls, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('about');
  state.responses.push({ status: 200, json: { ok: false, summary: 'Not signed in.', lines: ['Open Tailscale and sign in.'], blocker: 'tailscale-off' } });
  t.render(); await flush(); await flush();
  assert.deepStrictEqual(calls.map(c => [c.method, c.url]), [['GET', '/api/modules/demo/precheck/prereqs']]);
  assert.match(els['step-area'].innerHTML, /Not signed in\./);
  state.responses.push({ status: 200, json: { ok: true, summary: 'Ready.', lines: [], blocker: null } });
  t.loadPrecheck('about'); await flush(); await flush();
  assert.strictEqual(calls.length, 2);
  assert.match(els['step-area'].innerHTML, /Ready\./);
  state.responses.push({ status: 403, json: { error: 'Only a signed-in admin can see this.' } });
  t.loadPrecheck('about'); await flush(); await flush();
  assert.match(els['step-area'].innerHTML, /Only a signed-in admin can see this\./);
  assert.match(els['step-area'].innerHTML, /id="btn-next" disabled/);
});

test('auto step: the body, one primary button with the step title, no lines yet; the Advanced fold under it', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /Installs it\./);
  assert.match(out, /<button class="primary" id="btn-auto"[^>]*onclick="runAutoStep\('setup', \{\}, this\)">Set it up<\/button>/);
  assert.ok(!/Working:/.test(out));
  assert.match(out, /<details class="advanced" id="advanced"><summary>Advanced settings<\/summary>/);
});

test('auto step while it runs: the working line, button off; then the lines one per row and a way to the next step', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  t.setAuto({ setup: { running: true, lines: [] } });
  const run = t.stepHtml(m.steps[1]);
  assert.match(run, /Working: this can take a few minutes the first time\./);
  assert.match(run, /id="btn-auto" disabled/);
  t.setAuto({ setup: { done: true, lines: ['Downloaded and installed the server.', 'Found <b>this</b> computer.'] } });
  const done = t.stepHtml(m.steps[1]);
  assert.strictEqual((done.match(/class="auto-line"/g) || []).length, 2);
  assert.match(done, /Downloaded and installed the server\./);
  assert.match(done, /Found &lt;b&gt;this&lt;\/b&gt; computer\./, 'lines are escaped');
  assert.match(done, /selectStep\('done'\)/);
  t.setAuto({ setup: { done: true, lines: ['a'], check: { ok: true, summary: 'The server is running as its own locked-down service. No computer has been added yet.' } } });
  assert.match(t.stepHtml(m.steps[1]), /<div class="auto-lines">.*<\/div><div class="msg show ok">Done\. The server is running as its own locked-down service\. No computer has been added yet\.<\/div>/);
});

test('the lines are a plain list in every outcome: choice, administrator and error as well', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  const base = { error: 'x', lines: ['One.', 'Two.'] };
  for (const extra of [{ choose: { key: 'k', label: 'Which?', options: [{ value: 'a', label: 'a' }] } }, { admin: { command: 'c', label: null, warning: null, ask: true } }, {}]) {
    t.setAuto({ setup: { ...base, ...extra } });
    const out = t.stepHtml(m.steps[1]);
    assert.strictEqual((out.match(/class="auto-line"/g) || []).length, 2, Object.keys(extra)[0] || 'error');
  }
});

test('choose: the label and radio options with the first selected and a Continue button; Continue re-runs with choices', async () => {
  const { t, calls, state } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  t.setAuto({ setup: { error: 'Which address?', choose: { key: 'listen_ip', label: 'Which address?', options: [{ value: '100.101.102.103', label: '100.101.102.103' }, { value: '100.101.102.104', label: '100.101.102.104' }] }, choices: {}, lines: [] } });
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /Which address\?/);
  assert.match(out, /<input type="radio" name="auto-choice" value="100\.101\.102\.103" checked> 100\.101\.102\.103/);
  assert.match(out, /<input type="radio" name="auto-choice" value="100\.101\.102\.104" > 100\.101\.102\.104/);
  assert.match(out, /onclick="autoContinue\('setup', this\)">Continue/);
  state.radio = { value: '100.101.102.104' };
  state.responses.push({ status: 200, json: { ok: true, step: 'setup', result: { lines: ['Using 100.101.102.104.'] }, module: detail({ steps: STEPS.map(s => ({ ...s, done: s.id === 'setup' })) }) } });
  t.autoContinue('setup', null); await flush(); await flush();
  assert.deepStrictEqual(calls[0].body, { step: 'setup', input: { choices: { listen_ip: '100.101.102.104' } } });
  assert.deepStrictEqual(t.getAuto().setup.lines, ['Using 100.101.102.104.']);
  assert.strictEqual(t.getAuto().setup.done, true);
});

test('a refused run shows what the hub says: e.choose from the error answer, e.admin from it, a plain error otherwise', async () => {
  const { t, calls, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  state.responses.push({ status: 400, json: { error: 'Which address?', choose: { key: 'listen_ip', label: 'Which address?', options: [{ value: '100.101.102.103', label: 'a' }] } } });
  await t.runAutoStep('setup', {}, null);
  assert.deepStrictEqual(t.getAuto().setup.choose.options, [{ value: '100.101.102.103', label: 'a' }]);
  assert.match(els['step-area'].innerHTML, /name="auto-choice"/);
  state.responses.push({ status: 400, json: { error: 'The server could not be started.', check: { ok: false, summary: 'The server could not be started.', lines: ['needs an administrator'] }, admin: { command: 'sudo start-it', label: ADMIN.label, warning: ADMIN.warning, ask: true } } });
  await t.runAutoStep('setup', {}, null);
  assert.ok(t.getAuto().setup.admin);
  assert.deepStrictEqual(calls[1].body, { step: 'setup', input: {} });
  state.responses.push({ status: 400, json: { error: 'The setup is already running' } });
  await t.runAutoStep('setup', {}, null);
  assert.match(els['step-area'].innerHTML, /class="msg show err">The setup is already running/);
  assert.strictEqual((els['step-msg'] || { textContent: '' }).textContent, '', 'the generic step message is not also filled for the auto step');
  assert.strictEqual((els['step-area'].innerHTML.match(/already running/g) || []).length, 1, 'the error is shown once');
});

test('an error shows the progress lines as a list, then the error once with its summary (never the lines again inside the red box)', async () => {
  const { t, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  state.responses.push({ status: 400, json: { error: 'The server runs, but its device group is not ready yet.', check: { ok: false, summary: 'The server runs, but its device group is not ready yet.', lines: ['Downloaded and installed the server.', 'Using the saved ports 9975 and 9976.'] } } });
  await t.runAutoStep('setup', {}, null);
  const out = els['step-area'].innerHTML;
  assert.strictEqual((out.match(/class="auto-line"/g) || []).length, 2);
  assert.strictEqual((out.match(/Using the saved ports 9975 and 9976\./g) || []).length, 1, 'each line once');
  assert.strictEqual((out.match(/device group is not ready yet/g) || []).length, 1, 'the error once');
  assert.strictEqual((out.match(/class="msg show err"/g) || []).length, 1);
  assert.strictEqual((els['step-msg'] || { textContent: '' }).textContent, '');
});

test('Ask Maestro quotes the error shown in the auto area', async () => {
  const { t, calls, state } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  state.responses.push({ status: 400, json: { error: 'Nothing answers on its port.', check: { ok: false, summary: 'Nothing answers on its port.', lines: ['Found this computer.'] } } });
  await t.runAutoStep('setup', {}, null);
  state.responses.push({ status: 200, json: { agent: 'lead', message: 'help' } }, { status: 200, json: {} });
  await t.askMaestro('setup', null);
  assert.match(decodeURIComponent(calls[1].url.replace(/\+/g, ' ')), /error=Nothing answers on its port\.\nFound this computer\./);
});

test('admin: the check summary, then three choices: Ask Maestro, the command in a code box with a copy button, and the label button with its warning', async () => {
  const { t, calls, state } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  t.setAuto({ setup: { error: 'x', check: { summary: 'The server could not be started as a service.', lines: [] }, admin: { command: 'sudo systemctl start <demo>', label: ADMIN.label, warning: ADMIN.warning, ask: true }, choices: { listen_ip: '100.101.102.103' }, lines: [] } });
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /The server could not be started as a service\./);
  assert.match(out, /<div class="msg show info"[^>]*>The server could not be started as a service\.<\/div>/, 'a plain info box, not red');
  assert.ok(!/msg show err/.test(out));
  assert.match(out, /onclick="askMaestro\('setup', this\)">Ask Maestro<\/button>/);
  assert.strictEqual((out.match(/Ask Maestro<\/button>/g) || []).length, 1, 'one Ask Maestro on the screen (the step\'s own is hidden)');
  assert.strictEqual((out.match(/sudo systemctl start &lt;demo&gt;/g) || []).length, 1, 'the command appears once');
  assert.match(out, /<pre class="redirect-uri mono" id="admin-cmd"[^>]*>sudo systemctl start &lt;demo&gt;<\/pre><button onclick="copyAdminCmd\(this\)">Copy the command<\/button>/);
  assert.match(out, /<button onclick="autoAdmin\('setup', this\)">Run it without an administrator<\/button><div class="dim"[^>]*>The server then has the same access to files as your Maestro\.<\/div>/);
  // copy button
  const { t: t2, els: e2, state: s2 } = load(); e2['admin-cmd'] = { textContent: 'sudo start-it' };
  const btn = { textContent: '' }; await t2.copyAdminCmd(btn);
  assert.strictEqual(s2.copied, 'sudo start-it'); assert.strictEqual(btn.textContent, 'Copied');
  // the label button re-runs with adminChoice true, keeping earlier choices
  state.responses.push({ status: 200, json: { ok: true, step: 'setup', result: { lines: ["It will run under your Maestro's own account."] }, module: detail() } });
  t.autoAdmin('setup', null); await flush(); await flush();
  assert.deepStrictEqual(calls[0].body, { step: 'setup', input: { choices: { listen_ip: '100.101.102.103' }, adminChoice: true } });
});

test('without an adminChoice label in the answer only the first two choices show', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  t.setAuto({ setup: { error: 'x', check: { summary: 'down', lines: [] }, admin: { command: 'run it', label: null, warning: null, ask: true }, lines: [] } });
  const out = t.stepHtml(m.steps[1]);
  assert.match(out, /Ask Maestro/); assert.match(out, /Copy the command/); assert.ok(!/autoAdmin/.test(out));
});

test('Advanced fold: collapsed, holds exactly the advanced settings, on the auto step and the overview; the overview list has the rest', () => {
  const { t } = load(); const m = detail({ finishedAt: '2026-01-01', state: 'ready', enabled: true }); t.setCurrent(m);
  const auto = t.stepHtml(m.steps[1]);
  const fold = /<details class="advanced" id="advanced">([\s\S]*?)<\/details>/.exec(auto)[1];
  assert.ok(!/<details[^>]* open/.test(auto), 'collapsed');
  assert.match(fold, /id="set-control_port"/); assert.match(fold, /id="set-run_as"/);
  assert.ok(!/id="set-address_name"|id="set-listen_ip"|id="set-limit"/.test(fold));
  assert.match(fold, /onclick="saveAdvanced\(this\)"/);
  const ov = t.overviewHtml();
  const ovFold = /<details class="advanced" id="advanced">([\s\S]*?)<\/details>/.exec(ov)[1];
  assert.match(ovFold, /id="set-control_port"/); assert.match(ovFold, /onclick="saveAll\(this\)"/);
  const outside = ov.replace(/<details class="advanced"[\s\S]*?<\/details>/, '');
  assert.match(outside, /id="set-limit"/); assert.match(outside, /id="set-address_name"/);
  assert.ok(!/id="set-control_port"|id="set-run_as"/.test(outside), 'advanced settings appear once, in the fold');
  const none = detail({ manifest: { settings: SETTINGS.filter(s => !s.advanced) } }); t.setCurrent(none);
  assert.ok(!/Advanced settings/.test(t.stepHtml(none.steps[1])));
});

test('saving the fold posts only the advanced settings to the settings route', async () => {
  const m = detail();
  const { t, calls, state, els } = load(); t.setCurrent(m);
  // the fake document hands out an element per id; give the two advanced fields their values
  els['set-control_port'] = { value: '9981' }; els['set-run_as'] = { value: 'hub' };
  state.responses.push({ status: 200, json: { module: detail({ settings: { run_as: 'hub', control_port: 9981 } }) } });
  await t.saveAdvanced(null);
  assert.strictEqual(calls[0].url, '/api/modules/demo/settings');
  assert.deepStrictEqual(calls[0].body, { values: { control_port: '9981', run_as: 'hub' } });
});

test('suggested settings: an empty saved value is pre-filled and marked; candidates become a select with the first chosen; a saved value is never replaced', () => {
  const { t } = load(); const m = detail(); t.setCurrent(m);
  t.setSug({ address_name: { value: 'hub.example.ts.net', candidates: ['hub.example.ts.net'], source: 'this computer' }, listen_ip: { value: '100.101.102.103', candidates: ['100.101.102.103', '100.101.102.104'], source: 'this computer' } });
  const name = t.settingField(SETTINGS[0], '');
  assert.match(name, /<input type="text" id="set-address_name" value="hub\.example\.ts\.net">/);
  assert.match(name, /Filled in from this computer/);
  const ip = t.settingField(SETTINGS[1], '');
  assert.match(ip, /<select id="set-listen_ip"><option value="100\.101\.102\.103" selected>100\.101\.102\.103<\/option><option value="100\.101\.102\.104" >/);
  assert.match(ip, /Filled in from this computer/);
  const saved = t.settingField(SETTINGS[0], 'mine.example.ts.net');
  assert.match(saved, /value="mine\.example\.ts\.net"/); assert.ok(!/hub\.example\.ts\.net|Filled in/.test(saved));
  const noSuggestion = t.settingField(SETTINGS[4], 5);
  assert.ok(!/Filled in/.test(noSuggestion));
  t.setSug({ address_name: { value: '<img src=x onerror=1>', candidates: ['<img src=x onerror=1>'], source: 'this computer' } });
  assert.ok(!/<img/.test(t.settingField(SETTINGS[0], '')), 'a hostile suggestion is escaped');
});

test('suggestions are asked for only on an unfinished setup of a module that has suggest settings (an admin page); a finished one asks nothing', async () => {
  const a = load(); a.t.setCurrent(detail({ finishedAt: '2026-01-01', state: 'ready' }));
  await a.t.loadSuggestions(a.t.getCurrent());
  assert.strictEqual(a.calls.length, 0, 'a finished setup detects nothing on load');
  const b = load(); const nosug = detail({ manifest: { settings: SETTINGS.map(({ suggest, ...r }) => r) } }); b.t.setCurrent(nosug);
  await b.t.loadSuggestions(nosug);
  assert.strictEqual(b.calls.length, 0);
  const c = load(); const m = detail(); c.t.setCurrent(m); c.t.setSelected('setup');
  c.state.responses.push({ status: 200, json: { suggestions: { address_name: { value: 'hub.example.ts.net', candidates: ['hub.example.ts.net'], source: 'this computer' } } } });
  await c.t.loadSuggestions(m);
  assert.deepStrictEqual(c.calls.map(x => x.url), ['/api/modules/demo/suggestions']);
  assert.strictEqual(c.t.getSug().address_name.value, 'hub.example.ts.net');
  const d = load(); d.t.setCurrent(m);
  d.state.responses.push({ status: 403, json: { error: 'Only a signed-in admin can see this.' } });
  await d.t.loadSuggestions(m);
  assert.strictEqual(JSON.stringify(d.t.getSug()), '{}', 'a member gets nothing and the page shows nothing');
});

test('suggestions arriving late never wipe typing: only still-empty, untouched fields are filled in place, with the note, and the form is not drawn again', async () => {
  const { t, calls, state, els, fire } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  const notes = [];
  const field = (id, value = '') => (els[id] = { id, value, dataset: {}, insertAdjacentHTML(where, html) { notes.push([id, where, html]); }, parentNode: { querySelector: () => null } });
  const name = field('set-address_name'), ip = field('set-listen_ip');
  els.panel = { id: 'panel', innerHTML: 'SENTINEL: the form as the person sees it', classList: { add() {}, remove() {}, contains() { return false; } }, scrollIntoView() {} };
  let release; state.gate = new Promise(r => { release = r; });
  state.responses.push({ status: 200, json: { suggestions: { address_name: { value: 'hub.example.ts.net', candidates: ['hub.example.ts.net'], source: 'this computer' }, listen_ip: { value: '100.101.102.103', candidates: ['100.101.102.103'], source: 'this computer' } } } });
  const loading = t.loadSuggestions(m);
  await flush();
  // the person types a name while the answer is still on its way
  name.value = 'mine.example.ts.net'; fire('input', name);
  release(); await loading; await flush();
  assert.strictEqual(name.value, 'mine.example.ts.net', 'what was typed is kept');
  assert.strictEqual(ip.value, '100.101.102.103', 'the untouched empty field is filled in place');
  assert.deepStrictEqual(notes.map(n => [n[0], n[1]]), [['set-listen_ip', 'afterend']], 'the note only where something was filled in');
  assert.match(notes[0][2], /Filled in from this computer/);
  assert.strictEqual(els.panel.innerHTML, 'SENTINEL: the form as the person sees it', 'the form was not drawn again');
  assert.strictEqual(t.getSug().listen_ip.value, '100.101.102.103', 'later drawings still know the suggestions');
});

test('a field the person typed in and then emptied is left empty (it was touched); a field that already has a value is never replaced', async () => {
  const { t, state, els, fire } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  const mk = (id, value) => (els[id] = { id, value, dataset: {}, insertAdjacentHTML() { throw new Error('no note where nothing was filled in'); }, parentNode: { querySelector: () => null } });
  const name = mk('set-address_name', ''), ip = mk('set-listen_ip', '100.64.0.1');
  name.value = 'x'; fire('input', name); name.value = '';   // typed, then cleared
  state.responses.push({ status: 200, json: { suggestions: { address_name: { value: 'hub.example.ts.net', candidates: ['hub.example.ts.net'], source: 'this computer' }, listen_ip: { value: '100.101.102.103', candidates: ['100.101.102.103'], source: 'this computer' } } } });
  await t.loadSuggestions(m);
  assert.strictEqual(name.value, '');
  assert.strictEqual(ip.value, '100.64.0.1');
});

test('a select-worthy suggestion (several candidates) replaces only that empty untouched field, in place', async () => {
  const { t, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  const ip = { id: 'set-listen_ip', tagName: 'INPUT', value: '', dataset: {}, insertAdjacentHTML() {}, parentNode: { querySelector: () => null } };
  els['set-listen_ip'] = ip;
  state.responses.push({ status: 200, json: { suggestions: { listen_ip: { value: '100.101.102.103', candidates: ['100.101.102.103', '100.101.102.104'], source: 'this computer' } } } });
  await t.loadSuggestions(m);
  assert.match(ip.outerHTML, /^<select id="set-listen_ip"><option value="100\.101\.102\.103" selected>100\.101\.102\.103<\/option><option value="100\.101\.102\.104" >/);
});

test('Check again asks the hub for a fresh look (?fresh=1); opening the step does not', async () => {
  const { t, calls, state } = load(); const m = detail(); t.setCurrent(m); t.setSelected('about');
  state.responses.push({ status: 200, json: { ok: true, summary: 'Ready.', lines: [], blocker: null } }, { status: 200, json: { ok: true, summary: 'Ready.', lines: [], blocker: null } });
  t.render(); await flush(); await flush();
  t.checkAgain('about', null); await flush(); await flush();
  assert.deepStrictEqual(calls.map(c => c.url), ['/api/modules/demo/precheck/prereqs', '/api/modules/demo/precheck/prereqs?fresh=1']);
});

test('the overview shows the run mode line from the last server check', () => {
  const { t } = load();
  for (const [mode, line] of [['service', 'The server is running as its own locked-down service.'], ['hub', "The server is running under your Maestro's own account."]]) {
    const m = detail({ finishedAt: '2026-01-01', state: 'ready', enabled: true, runMode: mode }); t.setCurrent(m);
    assert.ok(t.overviewHtml().includes(line.replace(/'/g, '&#39;')), mode);
  }
  const none = detail({ finishedAt: '2026-01-01', state: 'ready', enabled: true, runMode: null }); t.setCurrent(none);
  assert.ok(!/class="run-mode"/.test(t.overviewHtml()));
});

// ── r3: "getting ready" is not a failure ──
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const GETTING_READY = 'The server is getting ready. This page shows it when it is ready.';
const waitingAnswer = (over = {}) => ({ status: 200, json: { ok: true, step: 'setup', result: { lines: ['Found this computer.'], check: { ok: false, retry: true, summary: GETTING_READY, lines: [] }, waiting: true }, module: detail(), ...over } });

test('r3: a waiting answer is a plain box with the check summary, no red error and no Done; it asks again with { poll: true } and stops at ok, then Next appears', async () => {
  const { t, calls, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup'); t.setPollMs(15);
  state.responses.push(waitingAnswer(), waitingAnswer());
  await t.runAutoStep('setup', {}, null);
  const first = t.stepHtml(t.getCurrent().steps[1]);
  assert.match(first, /class="msg show info" id="auto-waiting">The server is getting ready\. This page shows it when it is ready\./);
  assert.ok(!/class="msg show err"/.test(first) && !/Done\./.test(first));
  assert.strictEqual(t.getAuto().setup.waiting, true);
  assert.deepStrictEqual(calls[0].body, { step: 'setup', input: {} });
  assert.ok(t.hasPollTimer());
  await wait(80);   // the second answer is also waiting; the third look gets the default (empty) answer
  assert.ok(calls.length >= 2);
  assert.deepStrictEqual(calls[1].body, { step: 'setup', input: { poll: true } });
  t.setCurrent(m);
  state.responses.length = 0;
  const doneMod = detail({ steps: STEPS.map(s => ({ ...s, done: s.id === 'setup' })) });
  state.responses.push({ status: 200, json: { ok: true, step: 'setup', result: { lines: [], check: { ok: true, summary: 'The server is running.', lines: [] } }, module: doneMod } });
  await wait(80);
  assert.strictEqual(t.getAuto().setup.done, true);
  assert.match(t.autoAreaHtml(t.getCurrent().steps[1]), /Done\..*Next: Finish/);
  assert.ok(!/auto-waiting/.test(t.autoAreaHtml(t.getCurrent().steps[1])));
  const n = calls.length; await wait(60);
  assert.strictEqual(calls.length, n, 'no more asking once it is ok');
  assert.ok(!t.hasPollTimer());
});

test('r3: the page stops asking when the step is left (and the poll timer is cleared)', async () => {
  const { t, calls, state } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup'); t.setPollMs(15);
  state.responses.push(waitingAnswer());
  await t.runAutoStep('setup', {}, null);
  assert.ok(t.hasPollTimer());
  t.selectStep('done');
  assert.ok(!t.hasPollTimer());
  const n = calls.length; await wait(70);
  assert.strictEqual(calls.length, n);
});

test('r3: tryAgain shows a plain box and a Try again button that runs the step again; no red error', async () => {
  const { t, calls, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  const sentence = 'The helper programs for the other computers could not be downloaded from GitHub (x). Check that the computer your Maestro runs on can reach github.com, then press Try again. What was already downloaded is kept.';
  state.responses.push({ status: 400, json: { error: sentence, check: { ok: false, tryAgain: true, summary: sentence, lines: ['Found this computer.'] } } });
  await t.runAutoStep('setup', {}, null);
  const out = els['step-area'].innerHTML;
  assert.match(out, /class="msg show info" id="auto-tryagain">The helper programs/);
  assert.match(out, /<button class="primary" id="btn-tryagain" onclick="runAutoStep\('setup', \{\}, this\)">Try again<\/button>/);
  assert.ok(!/class="msg show err"/.test(out));
  assert.ok(!t.hasPollTimer());
  state.responses.push(waitingAnswer());
  await t.runAutoStep('setup', {}, null);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(t.getAuto().setup.waiting, true);
  assert.strictEqual(t.getAuto().setup.tryAgain, undefined);
});

test('r3: an ordinary failure is still the red error, with no Try again button', async () => {
  const { t, state, els } = load(); const m = detail(); t.setCurrent(m); t.setSelected('setup');
  state.responses.push({ status: 400, json: { error: 'Broke.', check: { ok: false, summary: 'Broke.', lines: [] } } });
  await t.runAutoStep('setup', {}, null);
  assert.match(els['step-area'].innerHTML, /class="msg show err">Broke\./);
  assert.ok(!/Try again/.test(els['step-area'].innerHTML));
});
