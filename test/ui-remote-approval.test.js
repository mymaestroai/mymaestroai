'use strict';
// Agent approvals section of the Remote computers detail (modules.html): the page script runs in a vm with a small fake document.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'modules.html'), 'utf8');
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
const URL_POLICY = '/api/modules/remote-computers/approval-policy';
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function load() {
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, innerHTML: '', textContent: '', className: '', hidden: false, classList: { add() {}, remove() {}, contains() { return false; } }, scrollIntoView() {} });
  const calls = [];
  const state = { get: { status: 200, json: {} }, posts: [] };
  const document = { hidden: false, getElementById: el, addEventListener() {}, querySelectorAll() { return []; } };
  const fetch = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (url === '/api/modules') return { ok: true, status: 200, json: async () => ({ modules: [] }) };
    if (url === URL_POLICY && method === 'GET') { const r = state.get; return { ok: r.status < 400, status: r.status, json: async () => r.json }; }
    const body = opts && opts.body ? JSON.parse(opts.body) : undefined;
    calls.push({ method, url, body });
    const r = state.posts.shift() || { status: 200, json: { ok: true } };
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  const ctx = vm.createContext({ document, fetch, location: { origin: 'http://hub', search: '', hash: '', pathname: '/modules' }, history: { replaceState() {} }, navigator: {}, setTimeout, clearTimeout, setInterval, clearInterval, Date, console, URLSearchParams });
  vm.runInContext(script + '\nthis.t = { loadApprovals, apprSave, apprAck, apprCancel, overviewHtml, setCurrent(m, sel) { current = m; selected = sel === undefined ? null : sel; } };', ctx);
  return { t: ctx.t, calls, state, els };
}

const MOD = { id: 'remote-computers', enabled: true, settings: {}, manifest: {}, steps: [], name: 'Remote computers' };
const ANSWER = {
  ok: true,
  computers: [{ id: 'pc-a-1', nodeid: 'n1', name: 'PC-A', online: true }, { id: 'pc-b-2', nodeid: 'n2', name: 'PC-B', online: false }],
  agents: [{ name: 'helper', level: 'drive' }, { name: 'sam', level: 'act' }, { name: 'scout', level: 'read' }],
  policy: { 'pc-a-1': { mode: 'day', trusted: ['sam'] } },
};

// Builds a fake row (and buttons that find it) from the rendered markup of one .appr-row.
function rowsFrom(markup, overrides = {}) {
  const out = {};
  for (const m of markup.matchAll(/<div class="appr-row" data-computer="([^"]*)">([\s\S]*?)<div class="appr-warn">/g)) {
    const id = unesc(m[1]); const inner = m[2];
    const sel = /<option value="([^"]*)" selected/.exec(inner);
    const row = {
      warn: { innerHTML: '' },
      getAttribute: (n) => (n === 'data-computer' ? id : null),
      querySelector: (s) => (s === 'select.appr-mode' ? { value: overrides.mode || (sel ? sel[1] : 'session') } : s === '.appr-warn' ? row.warn : null),
      querySelectorAll: (s) => s === 'input.appr-trust'
        ? [...inner.matchAll(/<input type="checkbox" class="appr-trust" data-agent="([^"]*)" (checked)?>/g)].map(x => ({ checked: overrides.trusted ? overrides.trusted.includes(unesc(x[1])) : !!x[2], getAttribute: () => unesc(x[1]) }))
        : [],
    };
    row.button = { closest: () => row, disabled: false };
    out[id] = row;
  }
  return out;
}

test('page: the section is placed after the Computers box, hidden until it loads, and Refresh reloads it', () => {
  assert.match(html, /id="desk-box">[\s\S]*?<\/div><div class="desk-box" id="appr-box" hidden><h3[^>]*>Agent approvals<\/h3>/);
  assert.match(html, /loadDesktopBox\(\); loadApprovals\(\); return false/);
  assert.match(html, /if \(!selected\) loadApprovals\(\);/);
});

test('renders a row per computer: mode selected, trusted ticked, only act/drive agents, pills', async () => {
  const { t, state, els } = load();
  state.get = { status: 200, json: ANSWER };
  els['appr-box'] = { hidden: true, innerHTML: '' };
  t.setCurrent(MOD);
  await t.loadApprovals();
  const h = els['appr-list'].innerHTML;
  assert.strictEqual(els['appr-box'].hidden, false);
  assert.match(h, /Every session: you approve each agent&#39;s first Act or Drive in a session\./);
  assert.strictEqual((h.match(/class="appr-row"/g) || []).length, 2);
  const a = h.split('class="appr-row"')[1], b = h.split('class="appr-row"')[2];
  assert.match(a, /data-computer="pc-a-1"/);
  assert.match(a, /<option value="day" selected>Once a day/);
  assert.match(a, /aria-label="How often agents must ask on PC-A"/);
  assert.match(a, /data-agent="sam" checked>/);
  assert.match(a, /data-agent="helper" >/);
  assert.ok(!a.includes('scout'));
  assert.match(a, />Online</);
  assert.match(b, /<option value="session" selected>Every session/);
  assert.match(b, />Offline</);
  assert.match(h, /Don't ask these agents on this computer:/);
  assert.match(h, /class="appr-mode"/);
});

test('shows the dim text when no agent can act or drive', async () => {
  const { t, state, els } = load();
  state.get = { status: 200, json: { ...ANSWER, agents: [{ name: 'scout', level: 'read' }] } };
  t.setCurrent(MOD);
  await t.loadApprovals();
  assert.match(els['appr-list'].innerHTML, /No agent here can act or drive\./);
  assert.ok(!els['appr-list'].innerHTML.includes('appr-trust'));
});

test('a 403 (not an admin) paints nothing and hides the section; other errors show a Refresh', async () => {
  const { t, state, els } = load();
  els['appr-box'] = { hidden: false };
  t.setCurrent(MOD);
  state.get = { status: 403, json: { error: 'Admins only' } };
  await t.loadApprovals();
  assert.strictEqual(els['appr-box'].hidden, true);
  assert.strictEqual(els['appr-list'].innerHTML, '');
  state.get = { status: 500, json: { error: 'boom' } };
  await t.loadApprovals();
  assert.strictEqual(els['appr-box'].hidden, false);
  assert.match(els['appr-list'].innerHTML, /Could not load the approval settings\./);
  assert.match(els['appr-list'].innerHTML, /Refresh/);
});

test('a disabled module or another module loads nothing', async () => {
  const { t, state, els } = load();
  state.get = { status: 200, json: ANSWER };
  t.setCurrent({ ...MOD, enabled: false });
  await t.loadApprovals();
  t.setCurrent({ ...MOD, id: 'other' });
  await t.loadApprovals();
  assert.strictEqual(els['appr-list'], undefined);
});

test('hostile computer and agent names are escaped', async () => {
  const { t, state, els } = load();
  state.get = { status: 200, json: {
    ok: true,
    computers: [{ id: 'x"><img src=x onerror=1>', nodeid: 'n', name: '<script>alert(1)</script>', online: true }],
    agents: [{ name: '"><b>evil</b>', level: 'act' }],
    policy: {},
  } };
  t.setCurrent(MOD);
  await t.loadApprovals();
  const h = els['appr-list'].innerHTML;
  assert.ok(!h.includes('<script>'));
  assert.ok(!h.includes('<img'));
  assert.ok(!h.includes('<b>evil'));
  assert.match(h, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(h, /data-agent="&quot;&gt;&lt;b&gt;evil&lt;\/b&gt;"/);
  assert.ok(!/onclick="[^"]*pc-|onclick="apprSave\('/.test(h));   // ids live in data- attributes, never in inline JS
});

async function loaded() {
  const w = load();
  w.state.get = { status: 200, json: ANSWER };
  w.t.setCurrent(MOD);
  await w.t.loadApprovals();
  w.rows = rowsFrom(w.els['appr-list'].innerHTML);
  return w;
}

test('Save posts exactly {computer, mode, trusted} for that row and reloads', async () => {
  const w = await loaded();
  await w.t.apprSave(w.rows['pc-a-1'].button);
  assert.deepStrictEqual(w.calls, [{ method: 'POST', url: URL_POLICY, body: { computer: 'pc-a-1', mode: 'day', trusted: ['sam'] } }]);
  assert.strictEqual(w.els['step-msg'].className, 'msg show ok');
  assert.strictEqual(w.els['step-msg'].textContent, 'Saved. Agents on this computer start new sessions under the new setting.');
});

test('a server error is shown as an error message', async () => {
  const w = await loaded();
  w.state.posts.push({ status: 400, json: { error: 'Nope' } });
  await w.t.apprSave(w.rows['pc-b-2'].button);
  assert.strictEqual(w.els['step-msg'].className, 'msg show err');
  assert.strictEqual(w.els['step-msg'].textContent, 'Nope');
});

test('409 needsAck shows the warning; Save anyway re-posts with acknowledged: true', async () => {
  const w = await loaded();
  w.state.posts.push({ status: 409, json: { error: 'ack', needsAck: true } });
  await w.t.apprSave(w.rows['pc-a-1'].button);
  const warn = w.rows['pc-a-1'].warn.innerHTML;
  assert.match(warn, /An agent can be misled by a web page or an email\. With asking reduced, it could then use this computer without you knowing in time\./);
  assert.match(warn, /Save anyway/);
  assert.match(warn, /Cancel/);
  assert.strictEqual(w.calls.length, 1);
  assert.ok(!('acknowledged' in w.calls[0].body));
  await w.t.apprAck(w.rows['pc-a-1'].button);
  assert.strictEqual(w.calls.length, 2);
  assert.deepStrictEqual(w.calls[1].body, { computer: 'pc-a-1', mode: 'day', trusted: ['sam'], acknowledged: true });
});

test('Cancel sends nothing and clears the warning; a later Save anyway does nothing', async () => {
  const w = await loaded();
  w.state.posts.push({ status: 409, json: { error: 'ack', needsAck: true } });
  await w.t.apprSave(w.rows['pc-a-1'].button);
  w.t.apprCancel(w.rows['pc-a-1'].button);
  assert.strictEqual(w.rows['pc-a-1'].warn.innerHTML, '');
  await w.t.apprAck(w.rows['pc-a-1'].button);
  assert.strictEqual(w.calls.length, 1);
});

test('a stale (older generation) answer paints nothing', async () => {
  const w = load();
  w.t.setCurrent(MOD);
  // a load for a module that is no longer open paints nothing
  w.state.get = { status: 200, json: ANSWER };
  const p = w.t.loadApprovals();
  w.t.setCurrent({ ...MOD, id: 'other' });
  await p;
  assert.strictEqual(w.els['appr-list'], undefined);
  // and an overlapping load: only the newest paints
  w.t.setCurrent(MOD);
  w.state.get = { status: 200, json: { ...ANSWER, computers: [{ id: 'old', nodeid: 'o', name: 'OLD', online: true }] } };
  const first = w.t.loadApprovals();
  w.state.get = { status: 200, json: ANSWER };
  const second = w.t.loadApprovals();
  await Promise.all([first, second]);
  assert.ok(!w.els['appr-list'].innerHTML.includes('OLD'));
  assert.match(w.els['appr-list'].innerHTML, /PC-A/);
});
