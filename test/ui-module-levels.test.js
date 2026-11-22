'use strict';
// Per-agent levels on the Data connectors page (modules.html): the page script runs in a vm with a small fake document,
// so these tests drive the real rendering, reading and save code for any module whose manifest declares `levels`.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'modules.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const WARNING = 'An agent can be misled by a web page or an email. With asking off, it could then use your remote computers without you knowing in time.';

// A fake document: elements are created on demand by id; `controls` is what querySelectorAll sees.
function load() {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {}, contains() { return false; } }, scrollIntoView() {} });
  const calls = [];
  const state = { controls: [], responses: [], me: { status: 200, json: { user: { totpEnabled: false } } }, meCalls: 0, pass: { value: '' }, code: { value: '' } };
  // The warning box: its two fields exist only when the markup in it has them (as in a real page).
  const box = () => {
    const b = el('perm-warning');
    b.querySelector = (q) => (q === 'input.perm-pass' && /class="perm-pass /.test(b.innerHTML) ? state.pass : q === 'input.perm-code' && /class="perm-code /.test(b.innerHTML) ? state.code : null);
    return b;
  };
  const document = {
    hidden: false,
    getElementById: (id) => (id === 'perm-warning' ? box() : el(id)),
    addEventListener() {},
    querySelectorAll(sel) {
      if (sel === 'input.grant:checked') return state.controls.filter(c => c.kind === 'grant' && c.checked);
      if (sel === 'input.perm-ask') return state.controls.filter(c => c.kind === 'ask');
      if (sel === 'select.perm-level') return state.controls.filter(c => c.kind === 'level');
      return [];
    },
  };
  const fetch = async (url, opts) => {
    if (url === '/api/modules') return { ok: true, status: 200, json: async () => ({ modules: [] }) };   // the card list reload, not part of what is asserted
    if (url === '/api/me') { state.meCalls++; const r = state.me; return { ok: r.status < 400, status: r.status, json: async () => r.json }; }
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method: opts && opts.method, url, body });
    if (state.gate) await state.gate;   // a slow request, for the double-click tests
    const r = state.responses.shift() || { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  const ctx = vm.createContext({ document, window: { addEventListener() {} }, fetch, location: { origin: 'http://hub', search: '', hash: '', pathname: '/modules' }, history: { replaceState() {} }, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, URLSearchParams });
  vm.runInContext(script + '\nthis.t = { levelsConfig, protectedSettingKeys, visibleSettings, readSettings, settingField, permissionLookup, permControlsHtml, readPermissions, permsNeedWarning, savePermissions, saveGrant, postPermissions, permWarnConfirm, permWarnCancel, onPermChange, showPermWarning, stepHtml, overviewHtml, leadRows, setCurrent(m) { current = m; }, getCurrent() { return current; }, pending() { return permPending; } };', ctx);
  return { t: ctx.t, calls, state, els };
}

// Turns rendered control markup into the fake controls readPermissions looks at (value = the selected option).
function controlsFrom(markup, ticked) {
  const out = [];
  for (const m of markup.matchAll(/<select class="perm-level" data-agent="([^"]*)"[^>]*?(disabled)?>([\s\S]*?)<\/select>/g)) {
    const sel = /<option value="([^"]*)" selected/.exec(m[3]);
    out.push({ kind: 'level', dataset: { agent: unesc(m[1]) }, value: sel ? unesc(sel[1]) : '', disabled: !!m[2] });
  }
  for (const m of markup.matchAll(/<input type="checkbox" class="perm-ask" data-agent="([^"]*)" (checked)?>/g)) out.push({ kind: 'ask', dataset: { agent: unesc(m[1]) }, checked: !!m[2] });
  for (const m of markup.matchAll(/<input type="checkbox" class="grant" value="([^"]*)"[^>]*?>/g)) out.push({ kind: 'grant', value: unesc(m[1]), checked: / checked/.test(m[0]) });
  return out;
}
// The page as the owner leaves it when asking is turned off for sam: starts from controls built from what is saved, then unticks sam's ask box and sets the level.
function turnOff(controls, name = 'sam', level) {
  const ask = controls.find(c => c.kind === 'ask' && c.dataset.agent === name); if (ask) ask.checked = false;
  if (level) controls.find(c => c.kind === 'level' && c.dataset.agent === name).value = level;
  return controls;
}
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// A made-up connector with its own level names, to show nothing is specific to one module.
const GENERIC = {
  levels: { setting: 'tiers', choices: ['view', 'edit', 'admin'], default: 'view', sessionApproval: { setting: 'quiet', levels: ['edit', 'admin'] } },
};
function detail(over = {}) {
  return {
    id: 'demo', name: 'Demo', steps: [{ id: 'g', type: 'grant', title: 'Who', body: '', done: false }, { id: 'done', type: 'finish', title: 'Finish', done: false }],
    manifest: { settings: [{ key: 'tiers', type: 'list', label: 'Tiers' }, { key: 'quiet', type: 'list', label: 'Quiet' }, { key: 'minutes', type: 'number', label: 'Minutes' }], ...GENERIC, ...(over.manifest || {}) },
    settings: { tiers: [], quiet: [], minutes: 30, ...(over.settings || {}) },
    candidates: over.candidates || [{ name: 'sam', display: 'Sam', eligible: true }, { name: 'ray', display: 'Ray', eligible: true }],
    agents: over.agents || ['sam'], leads: over.leads || ['owner'], leadsAlways: true, enabled: true, state: 'ready', finishedAt: over.finishedAt || null, secretsSet: [],
  };
}

test('custom choices: every allowed row, the locked lead too, shows the manifest choices; defaults to the manifest default with asking on', () => {
  const { t } = load();
  const m = detail(); t.setCurrent(m);
  const out = t.stepHtml(m.steps[0]);
  assert.match(out, /\(lead\): always/);
  const leadPerm = /data-agent="owner"[^>]*>(?:(?!<\/select>)[\s\S])*<\/select>/.exec(out);
  assert.ok(leadPerm, 'the lead has a level choice');
  for (const c of ['View', 'Edit', 'Admin']) assert.ok(out.includes(`>${c}</option>`), c);
  assert.ok(!/>Look<|>Act<|>Drive</.test(out), 'no hard-coded level names');
  const c = controlsFrom(out);
  const lv = Object.fromEntries(c.filter(x => x.kind === 'level').map(x => [x.dataset.agent, x]));
  assert.deepStrictEqual(Object.keys(lv).sort(), ['owner', 'ray', 'sam']);
  assert.strictEqual(lv.owner.value, 'view');
  assert.strictEqual(lv.sam.value, 'view');
  assert.ok(lv.ray.disabled, 'an agent that is not ticked has its choice off');
  assert.ok(!lv.sam.disabled && !lv.owner.disabled);
  assert.ok(/class="perm-ask" data-agent="sam" checked/.test(out), 'asking is on by default');
  assert.match(out, /Ask me before each session/);
  // the ask box is hidden while the level does not need a yes
  assert.match(out, /<label class="chk perm-ask-wrap" style="display:none"/);
});

test('saved lists drive the rows: level per agent, duplicates take the lowest rank, no_ask unticks the box and shows it for edit/admin', () => {
  const { t } = load();
  const m = detail({ settings: { tiers: ['sam:admin', 'sam:edit', 'owner:edit', 'ray:bogus', 'nocolon'], quiet: ['sam'] }, agents: ['sam', 'ray'] });
  const look = t.permissionLookup(m);
  assert.deepStrictEqual({ ...look('sam') }, { level: 'edit', askEachSession: false });
  assert.deepStrictEqual({ ...look('owner') }, { level: 'edit', askEachSession: true });
  assert.deepStrictEqual({ ...look('ray') }, { level: 'view', askEachSession: true }, 'an invalid entry falls back to the default');
  assert.deepStrictEqual({ ...look('constructor') }, { level: 'view', askEachSession: true });
  t.setCurrent(m);
  const out = t.stepHtml(m.steps[0]);
  assert.ok(/class="perm-ask" data-agent="sam" >/.test(out), 'sam is not asked');
  assert.ok(/class="perm-ask" data-agent="owner" checked/.test(out));
  assert.match(out, /<label class="chk perm-ask-wrap" ><input type="checkbox" class="perm-ask" data-agent="sam"/, 'shown, since edit needs a session yes');
});

test('protected keys (levels list and not-asked list) are skipped by generic rendering and reading, even when named', () => {
  const { t } = load();
  const m = detail(); t.setCurrent(m);
  assert.deepStrictEqual([...t.protectedSettingKeys(m)], ['tiers', 'quiet']);
  assert.deepStrictEqual(t.visibleSettings(m).map(s => s.key), ['minutes']);
  const step = { id: 's', type: 'settings', title: 'S', body: '', fields: ['tiers', 'quiet', 'minutes'] };
  const out = t.stepHtml(step);
  assert.ok(!out.includes('id="set-tiers"') && !out.includes('id="set-quiet"'), 'no hidden editable text box');
  assert.ok(out.includes('id="set-minutes"'));
  assert.ok(/readSettings\(\[/.test(out), 'the field list is only a filter; readSettings drops protected keys itself');
  // overview of a finished module: limits and settings lack both keys
  const done = detail({ finishedAt: 'x' }); t.setCurrent(done);
  const ov = t.overviewHtml();
  assert.ok(!ov.includes('id="set-tiers"') && !ov.includes('id="set-quiet"') && ov.includes('id="set-minutes"'));
});

test('a module without levels keeps every setting and the old grant rows', () => {
  const { t } = load();
  const m = detail({ manifest: { levels: undefined } }); delete m.manifest.levels; t.setCurrent(m);
  assert.deepStrictEqual([...t.protectedSettingKeys(m)], []);
  assert.strictEqual(t.visibleSettings(m).length, 3);
  const out = t.stepHtml(m.steps[0]);
  assert.ok(!/perm-level|perm-ask|perm-warning/.test(out));
  assert.match(out, /<label class="agent-row"><input type="checkbox" checked disabled> owner \(lead\): always<\/label>/);
});

test('readSettings skips protected keys even when asked for them, and with no list', () => {
  const { t, els } = load();
  const m = detail(); t.setCurrent(m);
  els['set-minutes'] = { value: '45' };
  assert.deepStrictEqual({ ...t.readSettings(['tiers', 'quiet', 'minutes']) }, { minutes: '45' });
  assert.deepStrictEqual({ ...t.readSettings() }, { minutes: '45' });
});

test('Act/Drive without a yes: warning first (exact text), nothing sent; Cancel keeps the unchecked state and sends nothing', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ settings: { tiers: ['sam:edit'], quiet: [] } }); t.setCurrent(m);
  state.controls = turnOff(controlsFrom(t.stepHtml(m.steps[0])));
  const perms = t.readPermissions();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(perms)), { owner: { level: 'view', askEachSession: true }, sam: { level: 'edit', askEachSession: false } }, 'unticked ray is not sent');
  assert.ok(t.permsNeedWarning(perms));
  await t.saveGrant('g', null);
  assert.strictEqual(calls.length, 0, 'nothing is sent before the warning is accepted');
  assert.ok(els['perm-warning'].innerHTML.includes(WARNING), 'the exact short warning is shown');
  assert.ok(t.pending());
  t.permWarnCancel();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(els['perm-warning'].innerHTML, '');
  assert.strictEqual(t.pending(), null);
  assert.strictEqual(state.controls.find(c => c.kind === 'ask' && c.dataset.agent === 'sam').checked, false, 'the box stays as the person left it');
});

test('accepting the warning posts agent-permissions with acknowledged:true, then marks the grant step through the generic step', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ settings: { tiers: ['sam:edit'], quiet: [] } }); t.setCurrent(m);
  state.controls = turnOff(controlsFrom(t.stepHtml(m.steps[0])), 'sam', 'admin');
  const saved = detail({ settings: { tiers: ['sam:admin'], quiet: ['sam'] } });
  const after = detail({ settings: { tiers: ['sam:admin'], quiet: ['sam'] } }); after.steps[0].done = true;
  state.responses.push({ status: 200, json: { ok: true, module: saved } }, { status: 200, json: { ok: true, module: after } });
  await t.saveGrant('g', null);
  await tick();   // /api/me answers first (no two-factor on this account): the box is drawn again without a code field
  assert.ok(!/perm-code/.test(els['perm-warning'].innerHTML), 'no code field for an account without two-factor');
  state.pass.value = 'pw-1';
  await t.permWarnConfirm();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, '/api/modules/demo/agent-permissions');
  assert.strictEqual(calls[0].method, 'POST');
  assert.deepStrictEqual(calls[0].body, { agents: ['sam'], permissions: { owner: { level: 'view', askEachSession: true }, sam: { level: 'admin', askEachSession: false } }, acknowledged: true, password: 'pw-1' }, 'the account has no two-factor, so no code is sent');
  assert.strictEqual(calls[1].url, '/api/modules/demo/step');
  assert.deepStrictEqual(calls[1].body, { step: 'g', input: { agents: ['sam'] } }, 'permissions never travel in the generic step');
});

test('asking left on: no warning and no acknowledged field; a failed permission save does not complete the step', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ settings: { tiers: ['sam:edit'] } }); t.setCurrent(m);
  state.controls = controlsFrom(t.stepHtml(m.steps[0]));
  state.responses.push({ status: 400, json: { error: 'Nope' } });
  els['step-msg'] = { className: '', textContent: '' };
  await t.saveGrant('g', null);
  assert.strictEqual(calls.length, 1, 'no step call after a failure');
  assert.ok(!('acknowledged' in calls[0].body));
  assert.strictEqual(els['step-msg'].textContent, 'Nope');
  assert.ok(!els['perm-warning'] || els['perm-warning'].innerHTML === '');
});

test('Status and limits: editable rows for the lead and granted agents, Save permissions posts the same body; saved values show after the reply', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ finishedAt: 'x', agents: ['sam'], settings: { tiers: ['sam:edit'] } }); t.setCurrent(m);
  const ov = t.overviewHtml();
  assert.match(ov, /Save permissions/);
  assert.match(ov, /\(lead\): always/);
  state.controls = controlsFrom(ov);
  const reply = detail({ finishedAt: 'x', agents: ['sam'], settings: { tiers: ['sam:admin', 'owner:edit'], quiet: [] } });
  state.responses.push({ status: 200, json: { ok: true, module: reply } });
  state.controls.find(c => c.kind === 'level' && c.dataset.agent === 'owner').value = 'edit';
  state.controls.find(c => c.kind === 'level' && c.dataset.agent === 'sam').value = 'admin';
  els['step-msg'] = { className: '', textContent: '' };
  els.panel = { classList: { add() {}, remove() {}, contains() { return true; } }, innerHTML: '' };
  await t.savePermissions(null);
  assert.deepStrictEqual(calls[0].body, { agents: ['sam'], permissions: { owner: { level: 'edit', askEachSession: true }, sam: { level: 'admin', askEachSession: true } } });
  const reloaded = t.overviewHtml();
  const c = controlsFrom(reloaded).filter(x => x.kind === 'level');
  assert.strictEqual(c.find(x => x.dataset.agent === 'sam').value, 'admin');
  assert.strictEqual(c.find(x => x.dataset.agent === 'owner').value, 'edit');
});

test('agent names and choices are escaped in the rows', () => {
  const { t } = load();
  const evil = '"><img src=x onerror=alert(1)>';
  const m = detail({ candidates: [{ name: evil, display: '<b>x</b>', eligible: true }], agents: [evil], leads: ['<i>lead</i>'] });
  m.manifest.levels = { ...GENERIC.levels, choices: ['v<b>', 'edit'], default: 'v<b>' };
  t.setCurrent(m);
  const out = t.stepHtml(m.steps[0]);
  assert.ok(!out.includes('<img') && !out.includes('<i>lead') && !out.includes('<b>x</b>') && !out.includes('v<b>'));
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'));
  const c = controlsFrom(out).filter(x => x.kind === 'level');
  assert.deepStrictEqual(c.map(x => x.dataset.agent).sort(), [evil, '<i>lead</i>'].sort());
});

test('changing a level shows the ask box only for the levels that need a yes; any edit withdraws a waiting warning', () => {
  const { t, els, state } = load();
  const m = detail(); t.setCurrent(m);
  const wrap = { style: { display: 'none' } };
  const row = { querySelector: (q) => q === '.perm-ask-wrap' ? wrap : null };
  const mk = (cls, extra) => ({ classList: { contains: (c) => cls.includes(c) }, closest: () => row, ...extra });
  t.onPermChange(mk(['perm-level'], { value: 'admin' }));
  assert.strictEqual(wrap.style.display, '');
  t.onPermChange(mk(['perm-level'], { value: 'view' }));
  assert.strictEqual(wrap.style.display, 'none');
  void state;
  els['perm-warning'] = { innerHTML: 'x' };
  t.onPermChange(mk(['perm-ask'], {}));
  assert.strictEqual(els['perm-warning'].innerHTML, '');
});

test('remote-computers setup: no step holds the levels setting; the session length lives under Advanced; grant step explains the levels', () => {
  const setup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'setup.json'), 'utf8'));
  const by = Object.fromEntries(setup.steps.map(s => [s.id, s]));
  assert.strictEqual(by.levels, undefined, 'the session length has no step of its own');
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'module.json'), 'utf8'));
  assert.strictEqual(mf.settings.find(s => s.key === 'session_minutes').advanced, true);
  assert.ok(!/maestro:look|one entry per agent/i.test(by.agents.body));
  assert.strictEqual(by.agents.type, 'grant');
  for (const w of ['Look', 'Act', 'Drive', 'Ask me before each session']) assert.ok(by.agents.body.includes(w), w);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'module.json'), 'utf8'));
  assert.deepStrictEqual(setup.steps.flatMap(s => s.fields || []).filter(k => k === manifest.levels.setting || k === manifest.levels.sessionApproval.setting), []);
});

// ── step-up: the account password (and two-factor code) before asking is turned off ──
const tick = () => new Promise((r) => setImmediate(r));
const askOff = () => detail({ settings: { tiers: ['sam:edit'], quiet: [] } });   // saved: sam is asked
const offControls = (markup) => turnOff(controlsFrom(markup), 'sam', 'admin');   // what the owner leaves on screen: sam not asked, at admin

test('the warning asks for the account password: label, password input, no code field when the account has no two-factor', async () => {
  const { t, calls, state, els } = load();
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  await t.saveGrant('g', null);
  await tick();
  const h = els['perm-warning'].innerHTML;
  assert.ok(h.includes(WARNING));
  assert.match(h, /Your account password(?! and two-factor)/);
  assert.match(h, /<input type="password" data-eye class="perm-pass su-pass" autocomplete="current-password" placeholder="account password">/);
  assert.ok(!/perm-code|one-time-code/.test(h), 'no code field');
  assert.match(h, /Save with asking off/); assert.match(h, />Cancel</);
  assert.strictEqual(calls.length, 0, 'nothing sent before the confirm');
  assert.strictEqual(state.meCalls, 1, 'the page read /api/me once');
});

test('two-factor account (from /api/me): the label and a numeric one-time-code field appear', async () => {
  const { t, state, els } = load();
  state.me = { status: 200, json: { user: { totpEnabled: true } } };
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  await t.saveGrant('g', null);
  await tick();
  const h = els['perm-warning'].innerHTML;
  assert.match(h, /Your account password and two-factor code/);
  assert.match(h, /<input type="text" class="perm-code su-code" inputmode="numeric" autocomplete="one-time-code" placeholder="123 456">/);
  // asked again later: /api/me is not read a second time
  await t.saveGrant('g', null);
  assert.strictEqual(state.meCalls, 1);
});

test('when /api/me cannot be read the code field is shown anyway, labelled "if you use one"', async () => {
  const { t, state, els } = load();
  state.me = { status: 500, json: {} };
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  await t.saveGrant('g', null);
  await tick();
  const h = els['perm-warning'].innerHTML;
  assert.match(h, /two-factor code, if you use one/);
  assert.match(h, /class="perm-code su-code"/);
});

test('confirm posts acknowledged + password + code, read from the fields at click time and cleared from the field', async () => {
  const { t, calls, state } = load();
  state.me = { status: 200, json: { user: { totpEnabled: true } } };
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  const after = askOff(); after.steps[0].done = true;
  state.responses.push({ status: 200, json: { ok: true, module: askOff() } }, { status: 200, json: { ok: true, module: after } });
  await t.saveGrant('g', null);
  await tick();
  state.pass.value = 's3cret'; state.code.value = '123 456';
  await t.permWarnConfirm();
  assert.strictEqual(calls[0].url, '/api/modules/demo/agent-permissions');
  assert.strictEqual(calls[0].body.acknowledged, true);
  assert.strictEqual(calls[0].body.password, 's3cret');
  assert.strictEqual(calls[0].body.code, '123 456');
  assert.strictEqual(state.pass.value, '', 'the field is emptied');
  assert.strictEqual(t.pending(), null, 'accepted: the box is closed');
});

test('a 403 with stepUp shows the error, keeps the box open with the password field cleared, and the next try posts again', async () => {
  const { t, calls, state, els } = load();
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  els['step-msg'] = { className: '', textContent: '' };
  state.responses.push({ status: 403, json: { error: 'That password is not right.', stepUp: true } });
  await t.saveGrant('g', null);
  await tick();
  state.pass.value = 'wrong';
  await t.permWarnConfirm();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(els['step-msg'].className, 'msg show err');
  assert.strictEqual(els['step-msg'].textContent, 'That password is not right.');
  assert.ok(els['perm-warning'].innerHTML.includes(WARNING), 'the box is still there');
  assert.ok(t.pending(), 'and still waiting');
  assert.strictEqual(state.pass.value, '', 'nothing typed is kept');
  // second try
  const after = askOff(); after.steps[0].done = true;
  state.responses.push({ status: 200, json: { ok: true, module: askOff() } }, { status: 200, json: { ok: true, module: after } });
  state.pass.value = 'right';
  await t.permWarnConfirm();
  assert.strictEqual(calls[1].url, '/api/modules/demo/agent-permissions');
  assert.strictEqual(calls[1].body.password, 'right');
  assert.strictEqual(calls[1].body.acknowledged, true);
  assert.strictEqual(t.pending(), null);
});

test('Cancel sends nothing and leaves no password anywhere', async () => {
  const { t, calls, state, els } = load();
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  await t.saveGrant('g', null);
  await tick();
  state.pass.value = 'typed';
  t.permWarnCancel();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(els['perm-warning'].innerHTML, '');
  assert.strictEqual(t.pending(), null);
});

test('tightening and asking left on never show the password fields', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ settings: { tiers: ['sam:edit'] } }); t.setCurrent(m);
  state.controls = controlsFrom(t.stepHtml(m.steps[0]));
  await t.saveGrant('g', null);
  assert.ok(calls.length >= 1, 'permissions went straight out');
  assert.ok(!('password' in calls[0].body) && !('acknowledged' in calls[0].body));
  assert.ok(!els['perm-warning'] || !/perm-pass/.test(els['perm-warning'].innerHTML));
});

test('Status and limits: Save permissions with asking off goes through the same box and sends the password', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ finishedAt: 'x', agents: ['sam'], settings: { tiers: ['sam:edit'], quiet: [] } }); t.setCurrent(m);
  state.controls = offControls(t.overviewHtml());
  els['step-msg'] = { className: '', textContent: '' };
  els.panel = { classList: { add() {}, remove() {}, contains() { return true; } }, innerHTML: '' };
  await t.savePermissions(null);
  await tick();
  assert.strictEqual(calls.length, 0);
  assert.match(els['perm-warning'].innerHTML, /perm-pass/);
  state.responses.push({ status: 200, json: { ok: true, module: m } });
  state.pass.value = 'pw';
  await t.permWarnConfirm();
  assert.strictEqual(calls[0].body.password, 'pw');
  assert.strictEqual(calls[0].body.acknowledged, true);
});

// ── review fixes: the approval policy has its own route; warn only when the save really asks less; no double confirm ──
const overviewSetup = (els) => { els['step-msg'] = { className: '', textContent: '' }; els.panel = { classList: { add() {}, remove() {}, contains() { return true; } }, innerHTML: '' }; };

test('the approval policy setting (levels.sessionApproval.policy) is protected: not a "Limits and settings" field and never sent by Save settings', () => {
  const { t, els } = load();
  const m = detail({ finishedAt: 'x' });
  m.manifest.settings.push({ key: 'approval_policy', type: 'list', label: 'Approval policy' });
  m.manifest.levels = { ...GENERIC.levels, sessionApproval: { setting: 'quiet', levels: ['edit', 'admin'], policy: 'approval_policy' } };
  m.settings.approval_policy = ['pc1:day'];
  t.setCurrent(m);
  assert.deepStrictEqual([...t.protectedSettingKeys(m)], ['tiers', 'quiet', 'approval_policy']);
  assert.deepStrictEqual(t.visibleSettings(m).map(x => x.key), ['minutes']);
  assert.ok(!t.overviewHtml().includes('set-approval_policy'), 'no raw field');
  els['set-minutes'] = { value: '45' };
  assert.deepStrictEqual({ ...t.readSettings() }, { minutes: '45' });
});

test('an unchanged save with an agent that is already not asked posts directly: no warning, no acknowledged, no password', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ finishedAt: 'x', agents: ['sam'], settings: { tiers: ['sam:edit'], quiet: ['sam'] } }); t.setCurrent(m);
  state.controls = controlsFrom(t.overviewHtml());
  overviewSetup(els);
  state.responses.push({ status: 200, json: { ok: true, module: m } });
  await t.savePermissions(null);
  assert.strictEqual(calls.length, 1);
  assert.ok(!('acknowledged' in calls[0].body) && !('password' in calls[0].body));
  assert.ok(!els['perm-warning'] || els['perm-warning'].innerHTML === '');
});

test('the warning opens for an agent that was asked, one that could not use the module, or one that gets a higher level (all not asked now)', () => {
  const { t } = load();
  const m = detail({ agents: ['sam'], settings: { tiers: ['sam:edit', 'ray:view'], quiet: ['sam'] } }); t.setCurrent(m);
  const need = (p) => t.permsNeedWarning(p);
  assert.strictEqual(need({ sam: { level: 'edit', askEachSession: false } }), false, 'unchanged');
  assert.strictEqual(need({ sam: { level: 'view', askEachSession: false } }), false, 'a lower level');
  assert.strictEqual(need({ sam: { level: 'admin', askEachSession: false } }), true, 'higher level');
  assert.strictEqual(need({ sam: { level: 'edit', askEachSession: true } }), false, 'asked');
  assert.strictEqual(need({ ray: { level: 'edit', askEachSession: false } }), true, 'ray could not use the module (and was asked)');
  const n = detail({ agents: ['sam'], settings: { tiers: ['sam:edit', 'ray:edit'], quiet: ['sam', 'ray', 'owner'] } }); t.setCurrent(n);
  assert.strictEqual(need({ ray: { level: 'edit', askEachSession: false } }), true, 'a stale entry of an agent that has no grant does not count');
  assert.strictEqual(need({ owner: { level: 'view', askEachSession: false } }), false, 'a lead could use it and was not asked');
  const o = detail({ agents: ['sam'], settings: { tiers: ['sam:edit'], quiet: [] } }); t.setCurrent(o);
  assert.strictEqual(need({ sam: { level: 'edit', askEachSession: false } }), true, 'asking turned off');
});

test('a 409 needsAck from the hub opens the warning (the hub decides); confirming resends with acknowledged and the password', async () => {
  const { t, calls, state, els } = load();
  const m = detail({ finishedAt: 'x', agents: ['sam'], settings: { tiers: ['sam:edit'], quiet: ['sam'] } }); t.setCurrent(m);
  state.controls = controlsFrom(t.overviewHtml());
  overviewSetup(els);
  state.responses.push({ status: 409, json: { error: 'sam would start edit sessions without asking.', needsAck: true, needsStepUp: true, totp: false } });
  await t.savePermissions(null);
  await tick();
  assert.strictEqual(calls.length, 1);
  assert.ok(els['perm-warning'].innerHTML.includes(WARNING), 'the warning is open, not just a message');
  assert.ok(t.pending());
  state.responses.push({ status: 200, json: { ok: true, module: m } });
  state.pass.value = 'pw';
  await t.permWarnConfirm();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[1].body.acknowledged, true);
  assert.strictEqual(calls[1].body.password, 'pw');
});

test('confirm with an empty password sends nothing and says so; the box stays open', async () => {
  const { t, calls, state, els } = load();
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  els['step-msg'] = { className: '', textContent: '' };
  await t.saveGrant('g', null);
  await tick();
  state.pass.value = '';
  await t.permWarnConfirm();
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(els['step-msg'].className, 'msg show err');
  assert.strictEqual(els['step-msg'].textContent, 'Enter your account password.');
  assert.ok(t.pending());
});

test('a second click on Save with asking off while the first request is in flight does nothing', async () => {
  const { t, calls, state, els } = load();
  const m = askOff(); t.setCurrent(m);
  state.controls = offControls(t.stepHtml(m.steps[0]));
  els['step-msg'] = { className: '', textContent: '' };
  await t.saveGrant('g', null);
  await tick();
  let release; state.gate = new Promise((r) => { release = r; });
  state.responses.push({ status: 200, json: { ok: true, module: askOff() } });
  state.pass.value = 'pw';
  const first = t.permWarnConfirm();
  await tick();
  state.pass.value = 'pw-again';
  const second = t.permWarnConfirm();
  await tick();
  assert.strictEqual(calls.filter(c => c.url.endsWith('/agent-permissions')).length, 1, 'only one request');
  state.gate = null; release();
  await Promise.all([first, second]);
  assert.strictEqual(calls.filter(c => c.url.endsWith('/agent-permissions')).length, 1);
});
