'use strict';
// Research an agent starts for its own work: the non-blocking notice in the research line (desktop app.js, phone mobile.js, and Simple,
// which shows the same box on both), its Stop and Make it thorough buttons, and the admin settings for the wait and the daily caps.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js');

// ── a small fake page: elements that keep their children, text, class, disabled and click handler ──
function mkEl(tag) {
  const e = { tag, children: [], className: '', hidden: true, attrs: {}, disabled: false, onclick: null, type: '', _t: '',
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; } };
  Object.defineProperty(e, 'textContent', { get() { return this._t; }, set(v) { this._t = String(v); this.children.length = 0; } });
  return e;
}
const walk = (e, f) => { f(e); for (const c of e.children) walk(c, f); };
const textsOf = (e) => { const out = []; walk(e, (n) => { if (n._t) out.push(n._t); }); return out; };
const buttonsOf = (e) => { const out = []; walk(e, (n) => { if (n.tag === 'button') out.push(n); }); return out; };
const cards = (box) => box.children.filter((c) => /research-notice/.test(c.className));

const T0 = 1_000_000_000_000;
function load(name, extra = {}) {
  const src = name === 'desktop' ? app : mob;
  const a = src.indexOf('// Deep research progress line');
  const b = src.indexOf('setInterval(() => { if (researchRuns.size) researchLinePaint(); }, 60000);');
  assert.ok(a > 0 && b > a, 'the progress line block is there');
  const boxes = {};
  const box = (id) => (boxes[id] ||= mkEl('div'));
  const posts = [], toasts = [];
  let reply = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const doFetch = async (url, opts) => { posts.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null }); return reply(); };
  const page = name === 'desktop'
    ? { chats: { c1: { agent: 'sam-bot' } }, fetch: doFetch, hubToast: (t) => toasts.push(t), agentDisplayName: (n) => 'Sam' }
    : { screen: 'chat', current: 'sam-bot', api: doFetch, toast: (t) => toasts.push(t), displayName: () => 'Sam' };
  const ctx = vm.createContext({ document: { createElement: mkEl, getElementById: (id) => (id in boxes ? boxes[id] : null) },
    Date, Number, String, Map, Array, Math, Promise, JSON, Error, setTimeout: () => 0, console, ...page, ...extra });
  vm.runInContext(src.slice(a, b) + '\nthis.apply = researchLineApply; this.runs = researchRuns; this.wait = researchWaitWords; this.loadRuns = researchLineLoad;', ctx);
  const target = box(name === 'desktop' ? 'research-lines-c1' : 'research-lines');
  return { c: ctx, box: target, posts, toasts, setReply: (f) => { reply = f; } };
}
const ev = (o) => ({ agent: 'sam-bot', id: 'dr-1', level: 'quick', label: 'searching', state: 'running', startedAt: Date.now() - 30000, seq: 1,
  startedBy: 'agent', reason: 'to size the market for the plan', question: 'How big is the market for sleep trackers?', costLine: 'About $0.40 on this model.', active: true, upgradable: true, ...o });

for (const name of ['desktop', 'phone']) {
  test(`${name}: an agent-started run shows the notice card: title, quoted question, Why, cost line, progress`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    const [card] = cards(p.box);
    assert.ok(card, 'a card, not a plain strip');
    assert.deepEqual(textsOf(card).slice(0, 4), [
      'Sam started a quick research run for its work.',
      '“How big is the market for sleep trackers?”',
      'Why: to size the market for the plan',
      'About $0.40 on this model.']);
    assert.match(textsOf(card)[4], /^Deep research \(Quick\): searching/);
    assert.equal(p.box.hidden, false);
  });
  test(`${name}: a no-answer run says how long nobody answered (2 minutes, 1 minute, 30 seconds) and has no Why line`, () => {
    for (const [sec, words] of [[120, '2 minutes'], [60, '1 minute'], [30, '30 seconds']]) {
      const p = load(name);
      p.c.apply(ev({ startedBy: 'no-answer', waitSeconds: sec, reason: 'ignored here' }));
      const t = textsOf(cards(p.box)[0]);
      assert.equal(t[0], `Nobody answered within ${words}, so Sam started a quick research run.`);
      assert.ok(!t.some((x) => /^Why:/.test(x)));
    }
    assert.equal(load(name).c.wait(300), '5 minutes');
  });
  test(`${name}: the buttons are real text buttons while active; Make it thorough only when upgradable; none once it is not active`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    let bs = buttonsOf(cards(p.box)[0]);
    assert.deepEqual(bs.map((b) => b.textContent), ['Stop', 'Make it thorough']);
    assert.ok(bs.every((b) => b.type === 'button' && b.disabled === false));
    p.c.apply(ev({ seq: 2, upgradable: false }));
    assert.deepEqual(buttonsOf(cards(p.box)[0]).map((b) => b.textContent), ['Stop']);
    p.c.apply(ev({ seq: 3, active: false, upgradable: false }));
    assert.equal(buttonsOf(cards(p.box)[0]).length, 0);
  });
  test(`${name}: Stop POSTs /api/research/stop {id}, is disabled while it runs, then says "Stopped. Sam was told."`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    let release; const gate = new Promise((r) => { release = r; });
    p.setReply(() => gate.then(() => ({ ok: true, status: 200, json: async () => ({ ok: true, run: {} }) })));
    const stop = buttonsOf(cards(p.box)[0])[0];
    const done = stop.onclick();
    assert.equal(p.posts.length, 1);
    assert.equal(p.posts[0].url, '/api/research/stop');
    assert.equal(p.posts[0].opts.method, 'POST');
    assert.deepEqual(p.posts[0].body, { id: 'dr-1' });
    assert.ok(buttonsOf(cards(p.box)[0]).every((b) => b.disabled), 'both buttons off while the request runs');
    p.c.apply(ev({ seq: 2 }));   // an event meanwhile repaints: still disabled
    assert.ok(buttonsOf(cards(p.box)[0]).every((b) => b.disabled));
    release(); await done;
    const t = textsOf(cards(p.box)[0]);
    assert.ok(t.includes('Stopped. Sam was told.'));
    assert.equal(buttonsOf(cards(p.box)[0]).length, 0);
    // the run ending afterwards (delivered/failed event) leaves the answer on screen for a while
    p.c.apply(ev({ seq: 3, state: 'failed' }));
    assert.ok(textsOf(cards(p.box)[0]).includes('Stopped. Sam was told.'));
  });
  test(`${name}: Make it thorough POSTs /api/research/upgrade {id} and says "Thorough research started. Its report will come here."`, async () => {
    const p = load(name);
    p.c.apply(ev({ startedBy: 'no-answer', waitSeconds: 120 }));
    await buttonsOf(cards(p.box)[0])[1].onclick();
    assert.equal(p.posts[0].url, '/api/research/upgrade');
    assert.deepEqual(p.posts[0].body, { id: 'dr-1' });
    assert.ok(textsOf(cards(p.box)[0]).includes('Thorough research started. Its report will come here.'));
  });
  test(`${name}: a refused request shows the error in a toast and the buttons come back`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    p.setReply(() => ({ ok: false, status: 403, json: async () => ({ error: 'You may not stop this run.' }) }));
    await buttonsOf(cards(p.box)[0])[0].onclick();
    assert.deepEqual(p.toasts, ['You may not stop this run.']);
    const bs = buttonsOf(cards(p.box)[0]);
    assert.equal(bs.length, 2);
    assert.ok(bs.every((b) => !b.disabled));
    p.setReply(() => { throw new Error('offline'); });
    await bs[0].onclick();
    assert.equal(p.toasts[1], 'offline');
  });
  test(`${name}: a run the person started (or made thorough) keeps today's plain line, no buttons`, () => {
    for (const startedBy of ['person', 'upgrade', undefined]) {
      const p = load(name);
      p.c.apply(ev({ startedBy, level: 'thorough', label: 'reading sources in full (3 of 12)', startedAt: Date.now() - 14 * 60000 }));
      assert.equal(cards(p.box).length, 0);
      assert.equal(p.box.children.length, 1);
      assert.match(p.box.children[0].className, /ho-strip research-line/);
      assert.equal(p.box.children[0].textContent, 'Deep research (Thorough): reading sources in full (3 of 12) · 14 min');
      assert.equal(buttonsOf(p.box).length, 0);
    }
  });
  test(`${name}: names, questions and reasons are text only (markup stays text; no innerHTML in the notice code)`, () => {
    const p = load(name);
    p.c.apply(ev({ question: '<img src=x onerror=alert(1)> what?', reason: '<b>bold</b>', costLine: '<i>$1</i>' }));
    const t = textsOf(cards(p.box)[0]);
    assert.ok(t.includes('“<img src=x onerror=alert(1)> what?”'));
    assert.ok(t.includes('Why: <b>bold</b>'));
    const src = name === 'desktop' ? app : mob;
    const a = src.indexOf('const RESEARCH_NOTICE_SHOW_MS'), b = src.indexOf('function researchLineFill');
    assert.ok(a > 0 && b > a);
    assert.doesNotMatch(src.slice(a, b), /innerHTML|insertAdjacentHTML|outerHTML/);
  });
  test(`${name}: a long question is cut to one line (ellipsis in the text and in the CSS)`, () => {
    const p = load(name);
    p.c.apply(ev({ question: 'q'.repeat(500) }));
    const q = textsOf(cards(p.box)[0])[1];
    assert.ok(q.length <= 302 && q.endsWith('…”'));
  });
  test(`${name}: a 'stopped' event removes the notice on a page that did not press Stop; a stopped status entry is not shown`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    assert.equal(cards(p.box).length, 1);
    p.c.apply(ev({ seq: 2, state: 'stopped', active: false, upgradable: false }));
    assert.equal(cards(p.box).length, 0);
    assert.equal(p.box.hidden, true);
    p.c.apply(ev({ seq: 3 }));   // a late older-looking running event does not bring it back
    assert.equal(cards(p.box).length, 0);
    const q = load(name);
    q.setReply(() => ({ ok: true, status: 200, json: async () => ({ runs: [{ id: 'dr-9', level: 'quick', state: 'stopped', active: false, startedAt: Date.now(), seq: 1, startedBy: 'agent', question: 'Q?' }] }) }));
    await q.c.loadRuns('sam-bot');
    assert.equal(cards(q.box).length, 0);
  });
  test(`${name}: an upgrade seen from another device: old quick run stopped, the new thorough run (startedBy upgrade) is a plain line`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    p.c.apply(ev({ seq: 2, state: 'stopped', active: false, upgradable: false }));
    p.c.apply(ev({ id: 'dr-2', startedBy: 'upgrade', level: 'thorough', upgradable: false, label: 'planning' }));
    assert.equal(cards(p.box).length, 0);
    assert.equal(p.box.children.length, 1);
    assert.match(p.box.children[0].className, /research-line/);
  });
  test(`${name}: a 'stopped' event after pressing Stop here keeps "Stopped. Sam was told."`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    await buttonsOf(cards(p.box)[0])[0].onclick();
    p.c.apply(ev({ seq: 2, state: 'stopped', active: false, upgradable: false }));
    assert.ok(textsOf(cards(p.box)[0]).includes('Stopped. Sam was told.'));
  });
  test(`${name}: an Always-yes run shows the notice: title by level, no Why, question and cost; Stop; Make it thorough only while upgradable`, () => {
    const p = load(name);
    p.c.apply(ev({ startedBy: 'always', level: 'quick', reason: 'ignored' }));
    let card = cards(p.box)[0];
    assert.ok(card, 'a card');
    assert.deepEqual(textsOf(card).slice(0, 3), ['Sam started a quick research run under your Always yes.', '“How big is the market for sleep trackers?”', 'About $0.40 on this model.']);
    assert.ok(!textsOf(card).some((x) => /^Why:/.test(x)));
    assert.deepEqual(buttonsOf(card).map((b) => b.textContent), ['Stop', 'Make it thorough']);
    const t = load(name);
    t.c.apply(ev({ startedBy: 'always', level: 'thorough', upgradable: false }));
    card = cards(t.box)[0];
    assert.equal(textsOf(card)[0], 'Sam started a thorough research run under your Always yes.');
    assert.deepEqual(buttonsOf(card).map((b) => b.textContent), ['Stop']);
    const n = load(name);
    n.c.apply(ev({ startedBy: 'always', costLine: undefined }));
    assert.ok(!textsOf(cards(n.box)[0]).some((x) => /\$/.test(x)));
  });
  test(`${name}: status entries carry the new fields to the card (the status route, not only the event)`, async () => {
    const p = load(name);
    p.setReply(() => ({ ok: true, status: 200, json: async () => ({ runs: [{ id: 'dr-5', level: 'quick', label: 'x', startedAt: Date.now(), seq: 1, startedBy: 'no-answer', waitSeconds: 30, question: 'Q?', costLine: 'C.', active: true, upgradable: true }] }) }));
    await p.c.loadRuns('sam-bot');
    const t = textsOf(cards(p.box)[0]);
    assert.equal(t[0], 'Nobody answered within 30 seconds, so Sam started a quick research run.');
    assert.deepEqual(buttonsOf(cards(p.box)[0]).map((b) => b.textContent), ['Stop', 'Make it thorough']);
  });
}

test('phone and desktop use the same words and the same notice code', () => {
  const grab = (src, indent) => {
    const a = src.lastIndexOf('\n', src.indexOf('function researchWaitWords')) + 1, b = src.lastIndexOf('\n', src.indexOf('function researchLineFill')) + 1;
    return src.slice(a, b).split('\n').map((l) => l.slice(indent)).join('\n')
      .replace(/function researchAgentName[^\n]*\n/, '').replace(/function researchToast[^\n]*\n/, '').replace(/function researchNoticePost[^\n]*\n/, '');
  };
  assert.equal(grab(app, 4).trim(), grab(mob, 0).trim());
  for (const s of ['started a quick research run for its work.', 'Nobody answered within ', 'research run under your Always yes.', "run.startedBy === 'always'", 'so ${who} started a quick research run.', "'Why: '", "'Stop'", "'Make it thorough'",
    'Stopped. ${researchAgentName(agent)} was told.', 'Thorough research started. Its report will come here.', "'/api/research/' + what"]) {
    assert.ok(app.includes(s), 'desktop: ' + s);
    assert.ok(mob.includes(s), 'phone: ' + s);
  }
});
test('Simple shows the notice too: it uses the same research-lines box and no Simple rule hides it; the CSS for the card is on both pages', () => {
  for (const f of ['index.html', 'mobile.html']) {
    const h = read(f);
    assert.doesNotMatch(h, /mm-simple[^{]*(research-lines|research-notice)/);
    assert.match(h, /\.research-lines \.research-actions button \{/);
    assert.match(h, /\.research-lines \.research-q \{[^}]*text-overflow: ellipsis/);
  }
  assert.match(app, /id="research-lines-\$\{chatId\}"/);
});

// ── the Settings block (desktop; the phone's Settings frame is this page) ──
function settingsPage(extra = {}) {
  const a = app.indexOf('// Research an agent needs for its own work (admin)');
  const b = app.indexOf('let researchThoroughSaving = false;');
  assert.ok(a > 0 && b > a, 'the settings block is there');
  const els = {};
  const ctx = vm.createContext({ document: { getElementById: (id) => els[id] || null }, Number, String, Math, JSON, Promise, Error, console, ...extra });
  vm.runInContext(src(a, b) + '\nthis.html = researchOwnWorkBlockHtml; this.caps = researchCapsLoad; this.save = saveResearchOwnWork;', ctx);
  return { ctx, els };
}
function src(a, b) { return app.slice(a, b); }
const input = (v, saved) => ({ value: String(v), dataset: { saved: String(saved === undefined ? v : saved) }, hidden: true, textContent: '' });

test('settings: the controls, their labels and keys, the defaults and the hint', () => {
  const { ctx } = settingsPage();
  const h = ctx.html({});
  assert.match(h, /Wait for an answer to a research question/);
  for (const o of ['0">Don\'t wait: start a quick run<', '30">30 seconds<', '60">1 minute<', '120" selected>2 minutes<', '300">5 minutes<', '600">10 minutes<']) assert.ok(h.includes('value="' + o), o);
  assert.match(h, /saveResearchOwnWork\('researchOfferWaitSeconds', this\)/);
  assert.match(h, /Research agents may start without asking, per agent per day[\s\S]*?id="st-ro-per-agent"[^>]*value="3"/);
  assert.match(h, /Research agents may start without asking, for all agents per day[\s\S]*?id="st-ro-install"[^>]*value="10"/);
  assert.match(h, /saveResearchOwnWork\('perAgent', this\)/);
  assert.match(h, /saveResearchOwnWork\('install', this\)/);
  assert.match(h, /id="st-ro-today" hidden/);
  assert.match(h, /starts at the quick level without asking, up to these limits[^<]*you can stop it or make it thorough from the chat\./);
  const h2 = ctx.html({ researchOfferWaitSeconds: 30, researchAgentCaps: { perAgent: 0, install: 25 } });
  assert.match(h2, /value="30" selected/);
  assert.match(h2, /id="st-ro-per-agent"[^>]*value="0"/);
  assert.match(h2, /id="st-ro-install"[^>]*value="25"/);
  assert.match(ctx.html({ researchOfferWaitSeconds: 45 }), /value="45" selected>45 seconds</, 'an unusual saved wait is kept as an option');
  // the page shows the block to admins only, ahead of the Thorough block, and loads the caps line after it is on the page
  assert.match(app, /isHubAdmin\(\) \? researchOwnWorkBlockHtml\(data\) : ''\}\s*\n\s*\$\{isHubAdmin\(\) \? researchThoroughBlockHtml\(data\)/);
  assert.match(app, /loadRootGrants\(\);\s*\n\s*researchCapsLoad\(\);/);
});
test('settings: each control saves through /api/settings with its key; the caps are sent as the pair; a failure puts the value back', async () => {
  const calls = []; const toasts = [];
  let reply = () => ({ ok: true, json: async () => ({}) });
  const page = settingsPage({ fetch: async (u, o) => { calls.push({ u, body: JSON.parse(o.body) }); return reply(); }, hubToast: (t) => toasts.push(t) });
  const sel = input(300, 120), per = input(5, 3), inst = input(10);
  page.els['st-ro-per-agent'] = per; page.els['st-ro-install'] = inst;
  await page.ctx.save('researchOfferWaitSeconds', sel);
  assert.deepEqual(calls[0], { u: '/api/settings', body: { researchOfferWaitSeconds: 300 } });
  assert.equal(sel.dataset.saved, '300');
  await page.ctx.save('perAgent', per);
  assert.deepEqual(calls[1].body, { researchAgentCaps: { perAgent: 5, install: 10 } });
  inst.value = '0'; inst.dataset.saved = '10';
  await page.ctx.save('install', inst);
  assert.deepEqual(calls[2].body, { researchAgentCaps: { perAgent: 5, install: 0 } }, '0 = no limit is a valid value');
  reply = () => ({ ok: false, status: 400, json: async () => ({ error: 'researchAgentCaps.perAgent must be 0 to 100' }) });
  per.value = '7';
  await page.ctx.save('perAgent', per);
  assert.equal(per.value, '5');
  assert.match(toasts.at(-1), /Could not save: researchAgentCaps\.perAgent must be 0 to 100/);
  const n = calls.length; per.value = '101';
  await page.ctx.save('perAgent', per);
  assert.equal(calls.length, n, 'out of range is refused before any request');
  assert.equal(per.value, '5');
});
test('settings: the "Today: n started by agents" line, shown from /api/research/caps and hidden when the route fails', async () => {
  const today = input(0); today.hidden = true;
  let reply = () => ({ ok: true, json: async () => ({ caps: { perAgent: 3, install: 10 }, today: { install: 4, agents: { 'sam-bot': 2 } } }) });
  const seen = [];
  const page = settingsPage({ fetch: async (u) => { seen.push(u); return reply(); } });
  page.els['st-ro-today'] = today;
  await page.ctx.caps();
  assert.equal(seen[0], '/api/research/caps');
  assert.equal(today.textContent, 'Today: 4 started by agents');
  assert.equal(today.hidden, false);
  reply = () => ({ ok: false, status: 403, json: async () => ({ error: 'admin only' }) });
  await page.ctx.caps();
  assert.equal(today.hidden, true);
  reply = () => { throw new Error('offline'); };
  today.hidden = false;
  await page.ctx.caps();
  assert.equal(today.hidden, true);
  const none = settingsPage();
  await none.ctx.caps();   // no element on the page: nothing happens
});
test('settings: the phone adds nothing of its own (its Settings frame is the desktop Settings page)', () => {
  assert.doesNotMatch(mob, /researchOfferWaitSeconds|researchAgentCaps/);
});
