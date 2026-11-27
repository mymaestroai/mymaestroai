'use strict';
// Desktop page: the background-work ring, the blue line, the header count, the `background` event, the panel's Stop calls.
// Page functions are cut out of app.js and run with fakes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AgentDot = require('../lib/ui-agent-dot.js');
const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extract(name) {
  let at = src.indexOf(`async function ${name}(`);
  if (at < 0) at = src.indexOf(`function ${name}(`);
  assert.ok(at >= 0, `${name} present`);
  let p = src.indexOf('(', at); let pd = 0;
  for (; p < src.length; p++) { if (src[p] === '(') pd++; else if (src[p] === ')' && --pd === 0) break; }
  let i = src.indexOf('{', p); let depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
  return src.slice(at, i + 1);
}

// a tiny element: classes, attributes, children, textContent
function el(cls = '') {
  const classes = new Set(cls.split(' ').filter(Boolean)); const attrs = {};
  const e = {
    children: [], parentNode: null, title: '', _text: '',
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on) => { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); } },
    setAttribute: (k, v) => { attrs[k] = v; }, attrs, classes,
    appendChild(c) { c.parentNode = e; e.children.push(c); return c; },
    insertBefore(c, ref) { c.parentNode = e; const i = e.children.indexOf(ref); e.children.splice(i < 0 ? e.children.length : i, 0, c); return c; },
    remove() { if (e.parentNode) e.parentNode.children = e.parentNode.children.filter((x) => x !== e); e.parentNode = null; },
    querySelector(sel) { const c = sel.replace(/^\./, ''); const find = (n) => { for (const k of n.children) { if (k.classes.has(c)) return k; const r = find(k); if (r) return r; } return null; }; return find(e); },
    get textContent() { return e._text + e.children.map((k) => k.textContent).join(''); },
    set textContent(v) { e._text = String(v); e.children = []; },
  };
  Object.defineProperty(e, 'className', { get: () => [...classes].join(' '), set: (v) => { classes.clear(); String(v).split(' ').filter(Boolean).forEach((c) => classes.add(c)); } });
  return e;
}
function row() { const btn = el('agent-btn'); const info = el('agent-info'); btn.appendChild(info); const dot = el('agent-status live-idle'); btn.appendChild(dot); return { btn, info, dot }; }

function paint(status, name = 'hazel', { busy = false, question = false } = {}) {
  const body = `${['bgCountOf', 'bgPaintRow'].map(extract).join('\n')}\nreturn { bgCountOf, bgPaintRow };`;
  const api = new Function('agentStatus', 'AgentDot', 'document', body)(status, AgentDot, { createElement: () => el() });
  const r = row();
  api.bgPaintRow(name, r.dot, r.btn, busy, question);
  return { ...r, ...api };
}

test('statusPatchOf copies background from the snapshot and the poll; bgCountOf reads it', () => {
  const body = `${['statusPatchOf', 'bgCountOf'].map(extract).join('\n')}\nreturn { statusPatchOf, bgCountOf };`;
  const status = {};
  const api = new Function('agentStatus', body)(status);
  assert.strictEqual(api.statusPatchOf({ busy: false, background: 2 }, false).background, 2);
  assert.strictEqual(api.statusPatchOf({ busy: false, background: 3 }, true).background, 3, 'a poll carries it too');
  assert.strictEqual(api.statusPatchOf({ busy: false }, false).background, 0, 'the full feed omits it at 0: cleared');
  assert.ok(!('background' in api.statusPatchOf({ busy: false }, true)), 'the /api/agents list has none: left as it is');
  status.hazel = { background: 2 }; status.doc = { background: 0 };
  assert.strictEqual(api.bgCountOf('hazel'), 2);
  assert.strictEqual(api.bgCountOf('doc'), 0);
  assert.strictEqual(api.bgCountOf('nobody'), 0);
});

test('the background event is subscribed, repaints through setAgentLive and calls HandOffCard.onBackground', () => {
  assert.ok(/source\.addEventListener\('background', e => \{ const ev = parse\(e\); if \(ev\) onHubBackground\(ev\); \}\);/.test(src), 'subscribed like the other hub events');
  const calls = [];
  const body = `${extract('onHubBackground')}\nreturn onHubBackground;`;
  const fn = new Function('setAgentLive', 'bgPaintChat', 'findSoloChat', 'HandOffCard', body)(
    (n, p) => calls.push(['live', n, p]), (c) => calls.push(['chat', c && c.agent]), (n) => ({ agent: n }), { onBackground: (n) => calls.push(['panel', n]) });
  fn({ agent: 'hazel', count: 2 });
  assert.deepStrictEqual(calls, [['live', 'hazel', { background: 2 }], ['chat', 'hazel'], ['panel', 'hazel']]);
  calls.length = 0;
  fn({ agent: 'hazel', count: 0 });
  assert.deepStrictEqual(calls[0], ['live', 'hazel', { background: 0 }]);
  calls.length = 0;
  fn({});
  assert.strictEqual(calls.length, 0, 'no agent: nothing');
});

test('a free row with background work gets bg-work, the label and the blue line', () => {
  const p = paint({ hazel: { busy: false, background: 2 } });
  assert.ok(p.dot.classList.contains('bg-work'));
  assert.ok(p.dot.classList.contains('live-idle'), 'the existing class stays');
  assert.strictEqual(p.dot.attrs.title, 'Free to talk · 2 things running in the background');
  const line = p.info.querySelector('agent-bg-line');
  // changed (the owner 2026-11-24 07:48: "Everything should alwasy be consistent."): the short line on every list, the full sentence is the tooltip
  assert.ok(line, 'the blue line');
  assert.strictEqual(line.textContent, 'Free · 2 in background');
  const one = paint({ hazel: { background: 1 } });
  assert.strictEqual(one.info.querySelector('agent-bg-line').textContent, 'Free · 1 in background');
});

test('replying or asking wins over background; background 0 shows no ring and no line', () => {
  for (const flags of [{ busy: true }, { question: true }]) {
    const p = paint({ hazel: { background: 3 } }, 'hazel', flags);
    assert.ok(!p.dot.classList.contains('bg-work'), JSON.stringify(flags));
    assert.strictEqual(p.info.querySelector('agent-bg-line'), null);
  }
  const none = paint({ hazel: { background: 0 } });
  assert.ok(!none.dot.classList.contains('bg-work'));
  assert.strictEqual(none.info.querySelector('agent-bg-line'), null);
  // it was background, now it is not: ring and line go
  const p = paint({ hazel: { background: 2 } });
  const status = { hazel: { background: 0 } };
  const api = new Function('agentStatus', 'AgentDot', 'document', `${['bgCountOf', 'bgPaintRow'].map(extract).join('\n')}\nreturn { bgPaintRow };`)(status, AgentDot, { createElement: () => el() });
  api.bgPaintRow('hazel', p.dot, p.btn, false, false);
  assert.ok(!p.dot.classList.contains('bg-work'));
  assert.strictEqual(p.info.querySelector('agent-bg-line'), null);
});

test('the painters call bgPaintRow / bgPaintChat after their own class logic', () => {
  // changed with the Teams view: paintAgentStatus sets the class from agentLiveState (shared with the Teams rows), then the ring
  assert.ok(/dot\.className = [^;]+;[\s\S]{0,400}bgPaintRow\(name, dot, btn, busy, question\)/.test(extract('paintAgentStatus')), 'agent rows');
  assert.ok(/statusDot\.className = `status-dot \$\{status\}`;\s*\n\s*try \{ bgPaintChat\(chats\[chatId\]\)/.test(extract('setStatus')), 'chat tab and status bar');
  assert.ok(/headerBusyPaint\(chat\); \} catch \{\}\s*\n\s*try \{ bgPaintChat\(chat\)/.test(extract('busyCardRefresh')), 'the hub-driven header paint');
  assert.ok(/AgentDot\.applyDot\(dd,/.test(extract('activeDress')), 'Active section copies');
  assert.ok(/has-bg/.test(extract('simpleAgentsSync')), 'the More agents fold');
});

test('chat tab and status-bar dots: ring only when the agent is free', () => {
  const tab = el('status idle'); const bar = el('status-dot idle');
  const doc = { querySelector: () => tab, getElementById: () => bar };
  const status = { hazel: { busy: false, background: 2 } };
  const body = `${['bgCountOf', 'bgPaintChat'].map(extract).join('\n')}\nreturn { bgPaintChat };`;
  const api = new Function('agentStatus', 'AgentDot', 'document', body)(status, AgentDot, doc);
  api.bgPaintChat({ id: 'c1', agent: 'hazel', status: 'idle' });
  assert.ok(tab.classList.contains('bg-work') && bar.classList.contains('bg-work'));
  api.bgPaintChat({ id: 'c1', agent: 'hazel', status: 'thinking' });
  assert.ok(!tab.classList.contains('bg-work') && !bar.classList.contains('bg-work'), 'thinking wins');
  status.hazel.busy = true;
  api.bgPaintChat({ id: 'c1', agent: 'hazel', status: 'idle' });
  assert.ok(!tab.classList.contains('bg-work'), 'the hub says replying: wins');
  assert.ok(/\.chat-tab \.status\.idle\.bg-work/.test(css) && /\.status-bar \.status-dot\.idle\.bg-work/.test(css), 'CSS: only on an idle dot');
});

// ── the header count ──
function header({ status = {}, local = [], filtering = false } = {}) {
  const box = el(); const list = el();
  const doc = { getElementById: (id) => (id === 'agents-working' ? box : id === 'agent-list' ? list : null), createTextNode: (t) => { const n = el(); n._text = t; return n; }, createElement: () => el() };
  const body = `${['bgCountOf', 'bgAgentCount', 'paintAgentsWorking'].map(extract).join('\n')}\nreturn { paintAgentsWorking };`;
  const busyIsWorker = (n, s) => !!(s && (s.worker === true || String(n).startsWith('tw-')));
  const busySplit = (st) => {
    const agents = []; const workers = [];
    for (const [n, s] of Object.entries(st)) if (s && s.busy) (busyIsWorker(n, s) ? workers : agents).push(n);
    return { agents, workers };
  };
  const busyChipLabel = (sp) => (sp.agents.length && sp.workers.length ? `${sp.agents.length} agent · ${sp.workers.length} workers working` : sp.agents.length ? `${sp.agents.length} agents working` : sp.workers.length ? `${sp.workers.length} workers working` : '');
  const api = new Function('document', 'agentStatus', 'localBusy', 'busySplit', 'busyChipLabel', 'busyIsWorker', 'AgentDot', 'activePaintSoon', 'busyFilterOn', body)(
    doc, status, new Map(local.map((n) => [n, 'x'])), busySplit, busyChipLabel, busyIsWorker, AgentDot, () => {}, filtering);
  api.paintAgentsWorking();
  return { box, list };
}

test('header: no background work -> exactly today\'s text and look', () => {
  const h = header({ status: { a: { busy: true }, b: { busy: true } } });
  assert.strictEqual(h.box.textContent, '2 agents working');
  assert.strictEqual(h.box.children.length, 0, 'plain text, no spans');
  assert.ok(h.box.classList.contains('on') && !h.box.classList.contains('bg-on'));
  const idle = header({ status: { a: { busy: false } } });
  assert.strictEqual(idle.box.textContent, '');
  assert.ok(!idle.box.classList.contains('on') && !idle.box.classList.contains('bg-on'));
});

test('header: both parts -> busy text, then a blue .aw-bg span', () => {
  const h = header({ status: { a: { busy: true }, b: { busy: false, background: 1 }, c: { busy: false, background: 2 } } });
  assert.strictEqual(h.box.textContent, '1 agents working · 2 with background work');
  const bg = h.box.children.find((c) => c.classes.has('aw-bg'));
  assert.ok(bg, 'the blue span');
  assert.strictEqual(bg.textContent, '2 with background work');
  assert.ok(h.box.classList.contains('on'), 'the orange look stays for the busy part');
  assert.ok(!h.box.classList.contains('bg-on'));
});

test('header: background only -> the blue part alone, not the orange .on look', () => {
  const h = header({ status: { a: { busy: false, background: 1 }, b: { busy: false, background: 4 }, w: { busy: false, worker: true, background: 9 } } });
  assert.strictEqual(h.box.textContent, '2 with background work');
  assert.ok(!h.box.classList.contains('on'), 'no orange look');
  assert.ok(h.box.classList.contains('bg-on'));
  assert.ok(h.box.children.every((c) => c.classes.has('aw-bg')));
  // a busy agent does not count as "with background work"
  const busy = header({ status: { a: { busy: true, background: 5 } } });
  assert.strictEqual(busy.box.textContent, '1 agents working');
  // the click still goes to toggleBusyFilter (it does nothing without busy agents)
  assert.ok(/id="agents-working" onclick="toggleBusyFilter\(\)"/.test(css));
  assert.ok(/#agents-working\.bg-on \{[^}]*display: inline-block/.test(css) && /#agents-working \.aw-bg \{ color: var\(--bg-work-ring\)/.test(css) && /--bg-work-ring: #3987e5;/.test(css));
});

// ── the click, the panel's Stop calls ──
test('a click on the ring or the blue line opens that agent\'s chat (its panel starts collapsed)', () => {
  const calls = [];
  const btn = { dataset: { model: 'sonnet' } };
  const body = `${extract('bgOpenChat')}\nreturn bgOpenChat;`;
  new Function('HandOffCard', 'document', 'startSoloChat', body)({ open: (n) => calls.push(['open', n]) }, { getElementById: (id) => (id === 'agent-btn-hazel' ? btn : null) }, (n, m) => calls.push(['chat', n, m]))('hazel');
  assert.deepStrictEqual(calls, [['chat', 'hazel', 'sonnet']], 'no expansion is asked for');
  // changed with the Teams view: the same listener also takes the Teams rows' ring and line, and finds the row of either kind
  assert.ok(/closest\('\.agent-btn \.agent-status\.bg-work, \.agent-btn \.agent-bg-line, \.teams-row \.teams-dot\.bg-work, \.teams-row \.teams-bg-line'\)[\s\S]{0,200}closest\('\.agent-btn, \.teams-row'\)[\s\S]{0,300}bgOpenChat\(name\);\s*\}, true\);/.test(src), 'one capturing listener for the ring and the line, in All Agents and in Teams');
});

test('HandOffCard.track gets isAdmin, stopJob and stopWorker; they post the usual requests', async () => {
  const m = /HandOffCard\.track\(\{ getAgent: filesActiveAgent[\s\S]*?\}\);/.exec(src);
  assert.ok(m, 'track call');
  assert.ok(/isAdmin: \(\) => isHubAdmin\(\)/.test(m[0]), 'the page\'s own admin rule (an install without accounts counts as admin)');
  assert.ok(/stopJob: \(id\) => workingOnPost\('\/api\/jobs\/cancel', \{ id \}, window\.__activeChatId\)/.test(m[0]));
  assert.ok(/stopWorker: \(id, agent\) => workingOnPost\('\/api\/cancel-worker', \{ worker_id: id, agent \}, window\.__activeChatId\)/.test(m[0]));
  const sent = [];
  const fetchFn = (url, opts) => { sent.push({ url, opts }); return Promise.resolve({ json: async () => ({ success: true }) }); };
  const post = new Function('fetch', 'window', `${extract('workingOnPost')}\nreturn workingOnPost;`)(fetchFn, {});
  const r = await post('/api/jobs/cancel', { id: 'j1' });
  assert.deepStrictEqual(r, { success: true });
  await post('/api/cancel-worker', { worker_id: 'tw-hazel-1-ab', agent: 'hazel' });
  assert.strictEqual(sent[0].url, '/api/jobs/cancel');
  assert.strictEqual(sent[0].opts.method, 'POST');
  assert.strictEqual(sent[0].opts.credentials, 'include');
  assert.deepStrictEqual(JSON.parse(sent[0].opts.body), { id: 'j1' });
  assert.strictEqual(sent[1].url, '/api/cancel-worker');
  assert.deepStrictEqual(JSON.parse(sent[1].opts.body), { worker_id: 'tw-hazel-1-ab', agent: 'hazel' });
  assert.strictEqual(sent[1].opts.headers['Content-Type'], 'application/json');
});

test('index.html loads ui-agent-dot.js before ui-hand-off-card.js and styles the ring and the panel', () => {
  const a = css.indexOf('<script src="/ui-agent-dot.js"></script>');
  const b = css.indexOf('<script src="/ui-hand-off-card.js"></script>');
  assert.ok(a > 0 && b > a);
  for (const sel of ['.wo-ring', '.wo-row', '.wo-kind', '.wo-title', '.wo-sub', '.wo-quiet', '.wo-stop', '.agent-bg-line']) assert.ok(css.includes(sel), sel);
  assert.ok(/\.wo-quiet \{[^}]*dashed/.test(css), 'the quiet line has a dashed border');
  assert.ok(/\.simple-more\.has-bg:not\(\.has-busy\)/.test(css), 'Simple: the fold ring yields to busy');
  assert.ok(/html\.mm-simple #agent-list \.agent-btn \.agent-status\.bg-work/.test(css), 'Simple rows');
  assert.ok(/border: 2px solid var\(--bg-work-ring\)/.test(css));
});

test('r1: a refused Stop (403, ok false, success false) shows the reason in the chat status line; a good one shows nothing', async () => {
  const shown = [];
  const run = async (res) => {
    const post = new Function('fetch', 'chatFileStatus', 'window', `${extract('workingOnPost')}\nreturn workingOnPost;`)(() => Promise.resolve(res), (...a) => shown.push(a), { __activeChatId: 'chat-1' });
    return post('/api/jobs/cancel', { id: 'j1' });
  };
  const r = await run({ ok: false, status: 403, json: async () => ({ error: 'admin_only' }) });
  assert.deepStrictEqual(r, { error: 'admin_only' });
  assert.deepStrictEqual(shown, [['chat-1', "Couldn't stop it: admin only", 'error']]);
  shown.length = 0;
  await run({ ok: true, status: 200, json: async () => ({ success: false, error: 'not found' }) });
  assert.equal(shown.length, 1);
  assert.equal(shown[0][2], 'error');
  shown.length = 0;
  await run({ ok: true, status: 200, json: async () => ({ ok: false }) });
  assert.equal(shown.length, 1);
  shown.length = 0;
  await run({ ok: false, status: 500, json: async () => { throw new Error('not json'); } });
  assert.deepStrictEqual(shown, [['chat-1', "Couldn't stop it (500).", 'error']]);
  shown.length = 0;
  await run({ ok: true, status: 200, json: async () => ({ success: true }) });
  assert.deepStrictEqual(shown, []);
});

test('r2 desktop wiring: the panel follows the chat switch at once, and Stop reports in the chat it was pressed in', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(src, /window\.__activeChatId = chatId;\s*\n\s*try \{ if \(window\.HandOffCard && typeof HandOffCard\.follow === 'function'\) HandOffCard\.follow\(\)/);
  assert.match(src, /stopJob: \(id\) => workingOnPost\('\/api\/jobs\/cancel', \{ id \}, window\.__activeChatId\)/);
  assert.match(src, /function workingOnPost\(url, body, chatId = window\.__activeChatId\)/);
  assert.match(src, /Couldn't stop it: the hub did not answer/);
});

test('r2 desktop: a rejected fetch shows the message in the chat captured at the click, not the one active when it fails', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const a = src.indexOf('function workingOnPost(');
  const b = src.indexOf('function filesOwnerParam()');
  assert.ok(a > 0 && b > a);
  const shown = [];
  let rejectFetch;
  const win = { __activeChatId: 'chat-1' };
  const make = new Function('window', 'fetch', 'chatFileStatus', src.slice(a, b) + '\nreturn workingOnPost;');
  const post = make(win, () => new Promise((_, rej) => { rejectFetch = rej; }), (id, text, kind) => shown.push([id, text, kind]));
  const p = post('/api/jobs/cancel', { id: 'j1' }, win.__activeChatId);   // the page passes the id read at the click
  win.__activeChatId = 'chat-2';   // the person moved on before the failure
  rejectFetch(new Error('offline'));
  await p;
  assert.deepStrictEqual(shown, [['chat-1', "Couldn't stop it: the hub did not answer", 'error']]);
});
