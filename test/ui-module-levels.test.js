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
const WARNING = 'An agent can be misled by a web page or an email. With asking off, it could then use this computer without you knowing in time.';

// A fake document: elements are created on demand by id; `controls` is what querySelectorAll sees.
function load() {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', classList: { add() {}, remove() {}, contains() { return false; } }, scrollIntoView() {} });
  const calls = [];
  const state = { controls: [], responses: [] };
  const document = {
    hidden: false,
    getElementById: el,
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
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method: opts && opts.method, url, body });
    const r = state.responses.shift() || { status: 200, json: {} };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  const ctx = vm.createContext({ document, fetch, location: { origin: 'http://hub', search: '', hash: '', pathname: '/modules' }, history: { replaceState() {} }, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, URLSearchParams });
  vm.runInContext(script + '\nthis.t = { levelsConfig, protectedSettingKeys, visibleSettings, readSettings, settingField, permissionLookup, permControlsHtml, readPermissions, permsNeedWarning, savePermissions, saveGrant, permWarnConfirm, permWarnCancel, onPermChange, stepHtml, overviewHtml, leadRows, setCurrent(m) { current = m; }, getCurrent() { return current; }, pending() { return permPending; } };', ctx);
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
  const m = detail({ settings: { tiers: ['sam:edit'], quiet: ['sam'] } }); t.setCurrent(m);
  state.controls = controlsFrom(t.stepHtml(m.steps[0]));
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
  const { t, calls, state } = load();
  const m = detail({ settings: { tiers: ['sam:admin'], quiet: ['sam'] } }); t.setCurrent(m);
  state.controls = controlsFrom(t.stepHtml(m.steps[0]));
  const saved = detail({ settings: { tiers: ['sam:admin'], quiet: ['sam'] } });
  const after = detail({ settings: { tiers: ['sam:admin'], quiet: ['sam'] } }); after.steps[0].done = true;
  state.responses.push({ status: 200, json: { ok: true, module: saved } }, { status: 200, json: { ok: true, module: after } });
  await t.saveGrant('g', null);
  await t.permWarnConfirm();
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].url, '/api/modules/demo/agent-permissions');
  assert.strictEqual(calls[0].method, 'POST');
  assert.deepStrictEqual(calls[0].body, { agents: ['sam'], permissions: { owner: { level: 'view', askEachSession: true }, sam: { level: 'admin', askEachSession: false } }, acknowledged: true });
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

test('remote-computers setup: id levels kept, session length only; grant step explains the levels', () => {
  const setup = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'setup.json'), 'utf8'));
  const by = Object.fromEntries(setup.steps.map(s => [s.id, s]));
  assert.deepStrictEqual(by.levels.fields, ['session_minutes']);
  assert.strictEqual(by.levels.title, 'Session length');
  assert.strictEqual(by.levels.type, 'settings');
  assert.ok(!/maestro:look|one entry per agent/i.test(by.levels.body));
  assert.strictEqual(by.agents.type, 'grant');
  for (const w of ['Look', 'Act', 'Drive', 'Ask me before each session']) assert.ok(by.agents.body.includes(w), w);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'modules', 'remote-computers', 'module.json'), 'utf8'));
  assert.deepStrictEqual(setup.steps.flatMap(s => s.fields || []).filter(k => k === manifest.levels.setting || k === manifest.levels.sessionApproval.setting), []);
});
