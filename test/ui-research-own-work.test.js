'use strict';
// Research an agent starts for its own work: the non-blocking notice in the research line (desktop app.js, phone mobile.js, and Simple,
// which shows the same box on both), its Stop and Make it thorough buttons, and the admin settings for the wait and the daily caps.
// Design fixes (E1 to E8): the notice is one line until opened, Stop is red, the lines after Stop / Make it thorough, the question line
// after nobody answered, the label of a research report turn, the short Settings labels, the plainer titles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('app.js'), mob = read('mobile.js');

// ── a small fake page: elements that keep their children, text, class, disabled and click handler ──
function mkEl(tag) {
  const e = { tag, children: [], className: '', hidden: true, attrs: {}, dataset: {}, disabled: false, onclick: null, type: '', _t: '',
    setAttribute(k, v) { this.attrs[k] = v; }, appendChild(c) { this.children.push(c); return c; }, querySelector() { return null; } };
  Object.defineProperty(e, 'textContent', { get() { return this._t; }, set(v) { this._t = String(v); this.children.length = 0; } });
  return e;
}
const walk = (e, f) => { f(e); for (const c of e.children) walk(c, f); };
const textsOf = (e) => { const out = []; walk(e, (n) => { if (n._t) out.push(n._t); }); return out; };
const buttonsOf = (e) => { const out = []; walk(e, (n) => { if (n.tag === 'button') out.push(n); }); return out; };
const cards = (box) => box.children.filter((c) => /research-notice/.test(c.className));
const toggleOf = (card) => buttonsOf(card).find((b) => b.className === 'research-toggle');
const xOf = (card) => buttonsOf(card).find((b) => b.className === 'research-x');
const labels = (card) => buttonsOf(card).map((b) => b.textContent);
// presses ▾ on the first notice and returns the repainted notice
const openFirst = (p) => { toggleOf(cards(p.box)[0]).onclick(); return cards(p.box)[0]; };

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
    Date, Number, String, Map, Set, Array, Math, Promise, JSON, Error, setTimeout: () => 0, console, ...page, ...extra });
  vm.runInContext(src.slice(a, b) + '\nthis.apply = researchLineApply; this.runs = researchRuns; this.wait = researchWaitWords; this.loadRuns = researchLineLoad;', ctx);
  const target = box(name === 'desktop' ? 'research-lines-c1' : 'research-lines');
  return { c: ctx, box: target, posts, toasts, setReply: (f) => { reply = f; } };
}
const ev = (o) => ({ agent: 'sam-bot', id: 'dr-1', level: 'quick', label: 'searching', state: 'running', startedAt: Date.now() - 30000, seq: 1,
  startedBy: 'agent', reason: 'to size the market for the plan', question: 'How big is the market for sleep trackers?', costLine: 'About $0.40 on this model.', active: true, upgradable: true, ...o });

for (const name of ['desktop', 'phone']) {
  // E1
  test(`${name}: the notice is one line until opened: title, Stop, a ▾ toggle (aria-expanded false, "Show details") and a × ("Dismiss")`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    const [card] = cards(p.box);
    assert.ok(card, 'a card, not a plain strip');
    assert.deepEqual(textsOf(card), ['Sam started a quick research run for its work.', 'Stop', '▾', '×']);
    assert.equal(p.box.hidden, false);
    const t = toggleOf(card);
    assert.equal(t.attrs['aria-expanded'], 'false');
    assert.equal(t.attrs['aria-label'], 'Show details');
    assert.equal(xOf(card).attrs['aria-label'], 'Dismiss');
    // Stop sits on the title line
    const head = card.children[0];
    assert.match(head.className, /research-head/);
    assert.deepEqual(head.children.map((c) => c._t), ['Sam started a quick research run for its work.', 'Stop', '▾', '×']);
  });
  test(`${name}: opened (▾ pressed, the toggle shows ▴): the question in full, Why, the cost line, the progress, Make it thorough; Stop stays on the title line`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    const card = openFirst(p);
    const t = textsOf(card);
    assert.deepEqual(t.slice(0, 8), [
      'Sam started a quick research run for its work.', 'Stop', '▴', '×',
      '“How big is the market for sleep trackers?”',
      'Why: to size the market for the plan',
      'About $0.40 on this model.',
      t[7]]);
    assert.match(t[7], /^Deep research \(Quick\): searching/);
    assert.equal(t[8], 'Make it thorough');
    assert.equal(toggleOf(card).attrs['aria-expanded'], 'true');
    assert.deepEqual(card.children[0].children.map((c) => c._t), ['Sam started a quick research run for its work.', 'Stop', '▴', '×']);
    // pressing ▴ closes it again
    toggleOf(card).onclick();
    assert.deepEqual(textsOf(cards(p.box)[0]), ['Sam started a quick research run for its work.', 'Stop', '▾', '×']);
  });
  test(`${name}: Make it thorough shows only while the run is upgradable (opened)`, () => {
    const p = load(name);
    p.c.apply(ev({ upgradable: false }));
    const card = openFirst(p);
    assert.ok(!textsOf(card).includes('Make it thorough'));
    assert.ok(textsOf(card).includes('Stop'));
  });
  test(`${name}: the opened or closed state belongs to the run id and survives a redraw (events, a status reload)`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    openFirst(p);
    p.c.apply(ev({ seq: 2, label: 'reading' }));
    let card = cards(p.box)[0];
    assert.equal(toggleOf(card).attrs['aria-expanded'], 'true', 'an event leaves it open');
    assert.ok(textsOf(card).some((x) => /reading/.test(x)));
    p.setReply(() => ({ ok: true, status: 200, json: async () => ({ runs: [{ id: 'dr-1', level: 'quick', label: 'x', startedAt: Date.now(), seq: 3, startedBy: 'agent', question: 'Q?', active: true, upgradable: true }] }) }));
    await p.c.loadRuns('sam-bot');
    card = cards(p.box)[0];
    assert.equal(toggleOf(card).attrs['aria-expanded'], 'true', 'a status reload leaves it open');
    // another run stays closed
    p.c.apply(ev({ id: 'dr-2', seq: 1, startedAt: Date.now() }));
    const group = cards(p.box);
    assert.ok(group.length >= 1);
    p.c.apply(ev({ id: 'dr-3', seq: 1, state: 'stopped', active: false }));
  });
  test(`${name}: × hides the notice for that run id (kept in memory); the run stays in the page's list of runs; a new run still shows`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    xOf(cards(p.box)[0]).onclick();
    assert.equal(cards(p.box).length, 0);
    assert.equal(p.box.hidden, true);
    assert.ok(p.c.runs.get('sam-bot').has('dr-1'), 'the run itself stays');
    p.c.apply(ev({ seq: 2, label: 'reading' }));   // an event for the same run does not bring it back
    assert.equal(cards(p.box).length, 0);
    p.c.apply(ev({ id: 'dr-2', seq: 1 }));         // another run shows
    assert.equal(cards(p.box).length, 1);
    assert.equal(cards(p.box)[0].children[0].children[0]._t, 'Sam started a quick research run for its work.');
    // a fresh page (a reload) may show it again
    const q = load(name);
    q.c.apply(ev({}));
    assert.equal(cards(q.box).length, 1);
  });
  test(`${name}: two or more notices at once: one line "2 research runs started by agents" with ▾; opened, each run is its own collapsed notice`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    p.c.apply(ev({ id: 'dr-2', startedAt: Date.now() - 10000, startedBy: 'no-answer', waitSeconds: 120 }));
    let cs = cards(p.box);
    assert.equal(cs.length, 1, 'one line');
    assert.deepEqual(textsOf(cs[0]), ['2 research runs started by agents', '▾']);
    assert.equal(toggleOf(cs[0]).attrs['aria-expanded'], 'false');
    assert.equal(toggleOf(cs[0]).attrs['aria-label'], 'Show details');
    toggleOf(cs[0]).onclick();
    cs = cards(p.box);
    assert.equal(cs.length, 3, 'the line and each run');
    assert.deepEqual(textsOf(cs[0]), ['2 research runs started by agents', '▴']);
    assert.deepEqual(textsOf(cs[1]), ['Sam started a quick research run for its work.', 'Stop', '▾', '×']);
    assert.deepEqual(textsOf(cs[2]), ['Nobody answered within 2 minutes, so Sam started a quick research run.', 'Stop', '▾', '×']);
    // a redraw keeps the group open
    p.c.apply(ev({ seq: 2 }));
    assert.equal(cards(p.box).length, 3);
    // dismissing one leaves a single notice again, no group line
    xOf(cards(p.box)[1]).onclick();
    cs = cards(p.box);
    assert.equal(cs.length, 1);
    assert.equal(textsOf(cs[0])[0], 'Nobody answered within 2 minutes, so Sam started a quick research run.');
  });
  test(`${name}: a no-answer run says how long nobody answered (2 minutes, 1 minute, 30 seconds) and has no Why line`, () => {
    for (const [sec, words] of [[120, '2 minutes'], [60, '1 minute'], [30, '30 seconds']]) {
      const p = load(name);
      p.c.apply(ev({ startedBy: 'no-answer', waitSeconds: sec, reason: 'ignored here' }));
      const t = textsOf(openFirst(p));
      assert.equal(t[0], `Nobody answered within ${words}, so Sam started a quick research run.`);
      assert.ok(!t.some((x) => /^Why:/.test(x)));
    }
    assert.equal(load(name).c.wait(300), '5 minutes');
  });
  // E8
  test(`${name}: plainer titles: Always yes by level; no answer with the wait at 0`, () => {
    const p = load(name);
    p.c.apply(ev({ startedBy: 'always', level: 'quick', reason: 'ignored' }));
    assert.equal(textsOf(cards(p.box)[0])[0], 'Sam started a quick research run because you chose Always yes.');
    const t = load(name);
    t.c.apply(ev({ startedBy: 'always', level: 'thorough', upgradable: false }));
    assert.equal(textsOf(cards(t.box)[0])[0], 'Sam started a thorough research run because you chose Always yes.');
    const z = load(name);
    z.c.apply(ev({ startedBy: 'no-answer', waitSeconds: 0 }));
    assert.equal(textsOf(cards(z.box)[0])[0], 'Sam started a quick research run without asking, as your settings allow.');
    const u = load(name);
    u.c.apply(ev({ startedBy: 'no-answer' }));   // no wait given at all: the same
    assert.equal(textsOf(cards(u.box)[0])[0], 'Sam started a quick research run without asking, as your settings allow.');
  });
  test(`${name}: the buttons are real text buttons while active; none but ▾ and × once it is not active`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    let card = openFirst(p);
    assert.deepEqual(labels(card), ['Stop', '▴', '×', 'Make it thorough']);
    assert.ok(buttonsOf(card).every((b) => b.type === 'button' && b.disabled === false));
    p.c.apply(ev({ seq: 2, upgradable: false }));
    assert.deepEqual(labels(cards(p.box)[0]), ['Stop', '▴', '×']);
    p.c.apply(ev({ seq: 3, active: false, upgradable: false }));
    assert.deepEqual(labels(cards(p.box)[0]), ['▴', '×']);
  });
  // E3
  test(`${name}: Stop POSTs /api/research/stop {id}, is disabled while it runs, then the notice is one line "Research stopped. Sam was told." with only a ×`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    let release; const gate = new Promise((r) => { release = r; });
    p.setReply(() => gate.then(() => ({ ok: true, status: 200, json: async () => ({ ok: true, run: {} }) })));
    const stop = buttonsOf(cards(p.box)[0]).find((b) => b.textContent === 'Stop');
    const done = stop.onclick();
    assert.equal(p.posts.length, 1);
    assert.equal(p.posts[0].url, '/api/research/stop');
    assert.equal(p.posts[0].opts.method, 'POST');
    assert.deepEqual(p.posts[0].body, { id: 'dr-1' });
    assert.ok(buttonsOf(cards(p.box)[0]).find((b) => b.textContent === 'Stop').disabled, 'Stop off while the request runs');
    p.c.apply(ev({ seq: 2 }));   // an event meanwhile repaints: still disabled
    assert.ok(buttonsOf(cards(p.box)[0]).find((b) => b.textContent === 'Stop').disabled);
    release(); await done;
    assert.deepEqual(textsOf(cards(p.box)[0]), ['Research stopped. Sam was told.', '×']);
    assert.deepEqual(labels(cards(p.box)[0]), ['×'], 'no Stop, no ▾');
    // the run ending afterwards (delivered/failed event) leaves the answer on screen for a while
    p.c.apply(ev({ seq: 3, state: 'failed' }));
    assert.deepEqual(textsOf(cards(p.box)[0]), ['Research stopped. Sam was told.', '×']);
    assert.ok(!app.includes('`Stopped. ${') && !mob.includes('`Stopped. ${'), 'the old "Stopped." words are gone');
  });
  test(`${name}: Make it thorough POSTs /api/research/upgrade {id}; then one line "Thorough research started. Its report will come here." with a ×`, async () => {
    const p = load(name);
    p.c.apply(ev({ startedBy: 'no-answer', waitSeconds: 120 }));
    openFirst(p);
    await buttonsOf(cards(p.box)[0]).find((b) => b.textContent === 'Make it thorough').onclick();
    assert.equal(p.posts[0].url, '/api/research/upgrade');
    assert.deepEqual(p.posts[0].body, { id: 'dr-1' });
    assert.deepEqual(textsOf(cards(p.box)[0]), ['Thorough research started. Its report will come here.', '×']);
  });
  test(`${name}: the one-line answer goes by itself after RESEARCH_NOTICE_SHOW_MS, and × takes it away at once`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    await buttonsOf(cards(p.box)[0]).find((b) => b.textContent === 'Stop').onclick();
    assert.equal(cards(p.box).length, 1);
    xOf(cards(p.box)[0]).onclick();
    assert.equal(cards(p.box).length, 0);
    const q = load(name);
    q.c.apply(ev({}));
    await buttonsOf(cards(q.box)[0]).find((b) => b.textContent === 'Stop').onclick();
    q.c.runs.get('sam-bot').get('dr-1').outcomeAt = Date.now() - 21000;
    q.c.apply(ev({ id: 'dr-2', seq: 1, startedBy: 'person' }));   // any repaint
    assert.equal(cards(q.box).length, 0, 'gone by itself');
  });
  test(`${name}: a refused request shows the error in a toast and the buttons come back`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    p.setReply(() => ({ ok: false, status: 403, json: async () => ({ error: 'You may not stop this run.' }) }));
    await buttonsOf(cards(p.box)[0])[0].onclick();
    assert.deepEqual(p.toasts, ['You may not stop this run.']);
    const bs = buttonsOf(cards(p.box)[0]);
    assert.deepEqual(bs.map((b) => b.textContent), ['Stop', '▾', '×']);
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
    const t = textsOf(openFirst(p));
    assert.ok(t.includes('“<img src=x onerror=alert(1)> what?”'));
    assert.ok(t.includes('Why: <b>bold</b>'));
    const src = name === 'desktop' ? app : mob;
    const a = src.indexOf('const RESEARCH_NOTICE_SHOW_MS'), b = src.indexOf('function researchLineFill');
    assert.ok(a > 0 && b > a);
    assert.doesNotMatch(src.slice(a, b), /innerHTML|insertAdjacentHTML|outerHTML/);
  });
  test(`${name}: the opened question is shown in full and wraps (no cut in the text, none in the CSS)`, () => {
    const p = load(name);
    const long = 'q'.repeat(500);
    p.c.apply(ev({ question: long }));
    const q = textsOf(openFirst(p))[4];
    assert.equal(q, '“' + long + '”');
    const css = read(name === 'desktop' ? 'index.html' : 'mobile.html');
    const rule = /\.research-lines \.research-q \{([^}]*)\}/.exec(css)[1];
    assert.match(rule, /white-space: normal/);
    assert.doesNotMatch(rule, /text-overflow|nowrap|overflow: hidden/);
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
  test(`${name}: a 'stopped' event after pressing Stop here keeps "Research stopped. Sam was told."`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    await buttonsOf(cards(p.box)[0])[0].onclick();
    p.c.apply(ev({ seq: 2, state: 'stopped', active: false, upgradable: false }));
    assert.ok(textsOf(cards(p.box)[0]).includes('Research stopped. Sam was told.'));
  });
  test(`${name}: an Always-yes run shows the notice: no Why, question and cost when opened; Stop; Make it thorough only while upgradable`, () => {
    const p = load(name);
    p.c.apply(ev({ startedBy: 'always', level: 'quick', reason: 'ignored' }));
    let card = openFirst(p);
    assert.ok(card, 'a card');
    assert.deepEqual(textsOf(card).slice(0, 6), ['Sam started a quick research run because you chose Always yes.', 'Stop', '▴', '×', '“How big is the market for sleep trackers?”', 'About $0.40 on this model.']);
    assert.ok(!textsOf(card).some((x) => /^Why:/.test(x)));
    assert.deepEqual(labels(card), ['Stop', '▴', '×', 'Make it thorough']);
    const t = load(name);
    t.c.apply(ev({ startedBy: 'always', level: 'thorough', upgradable: false }));
    card = openFirst(t);
    assert.equal(textsOf(card)[0], 'Sam started a thorough research run because you chose Always yes.');
    assert.deepEqual(labels(card), ['Stop', '▴', '×']);
    const n = load(name);
    n.c.apply(ev({ startedBy: 'always', costLine: undefined }));
    assert.ok(!textsOf(openFirst(n)).some((x) => /\$/.test(x)));
  });
  test(`${name}: status entries carry the new fields to the card (the status route, not only the event)`, async () => {
    const p = load(name);
    p.setReply(() => ({ ok: true, status: 200, json: async () => ({ runs: [{ id: 'dr-5', level: 'quick', label: 'x', startedAt: Date.now(), seq: 1, startedBy: 'no-answer', waitSeconds: 30, question: 'Q?', costLine: 'C.', active: true, upgradable: true }] }) }));
    await p.c.loadRuns('sam-bot');
    const t = textsOf(cards(p.box)[0]);
    assert.equal(t[0], 'Nobody answered within 30 seconds, so Sam started a quick research run.');
    assert.deepEqual(labels(openFirst(p)), ['Stop', '▴', '×', 'Make it thorough']);
  });
}

test('phone and desktop use the same words and the same notice code', () => {
  const grab = (src, indent) => {
    const a = src.lastIndexOf('\n', src.indexOf('function researchWaitWords')) + 1, b = src.lastIndexOf('\n', src.indexOf('function researchLineFill')) + 1;
    return src.slice(a, b).split('\n').map((l) => l.slice(indent)).join('\n')
      .replace(/function researchAgentName[^\n]*\n/, '').replace(/function researchToast[^\n]*\n/, '').replace(/function researchNoticePost[^\n]*\n/, '');
  };
  assert.equal(grab(app, 4).trim(), grab(mob, 0).trim());
  for (const s of ['started a quick research run for its work.', 'Nobody answered within ', 'research run because you chose Always yes.', "run.startedBy === 'always'", 'so ${who} started a quick research run.', "'Why: '", "'Stop'", "'Make it thorough'",
    'started a quick research run without asking, as your settings allow.', '${count} research runs started by agents', "'Show details'", "'Hide details'", "'Dismiss'", "'▾'", "'▴'", "'×'",
    'Research stopped. ${researchAgentName(agent)} was told.', 'Thorough research started. Its report will come here.', "'/api/research/' + what"]) {
    assert.ok(app.includes(s), 'desktop: ' + s);
    assert.ok(mob.includes(s), 'phone: ' + s);
  }
});
test('Simple shows the notice too: it uses the same research-lines box and no Simple rule hides it; the CSS for the card is on both pages', () => {
  for (const f of ['index.html', 'mobile.html']) {
    const h = read(f);
    assert.doesNotMatch(h, /mm-simple[^{]*(research-lines|research-notice)/);
    assert.match(h, /\.research-lines \.research-actions \{/);
    assert.match(h, /\.research-lines \.research-head \{[^}]*display: flex/);
    assert.match(h, /\.research-lines \.research-q \{[^}]*white-space: normal/);
  }
  assert.match(app, /id="research-lines-\$\{chatId\}"/);
});
// E2
test('Stop is red on both pages (the danger colour variable), in normal and Simple modes; Make it thorough stays a plain button', () => {
  const rule = (h, re) => { const m = re.exec(h); assert.ok(m, 'rule: ' + re); return m[1]; };
  const d = read('index.html'), m = read('mobile.html');
  const dStop = rule(d, /\.research-lines \.research-notice button\.wo-stop \{([^}]*)\}/);
  assert.match(dStop, /color: var\(--handoff-cards-ho-pill-ho-failed-border\)/);
  assert.match(dStop, /border-color: var\(--handoff-cards-ho-pill-ho-failed-border\)/);
  assert.doesNotMatch(dStop, /accent|--danger/, 'the accent is for the main action');
  const mStop = rule(m, /\.research-lines \.research-notice button\.wo-stop \{([^}]*)\}/);
  assert.match(mStop, /color: var\(--pill-failed\)/);
  assert.match(mStop, /border-color: var\(--pill-failed\)/);
  // the desktop red is the one the failed pills use: defined in :root and in every look
  assert.match(d, /--handoff-cards-ho-pill-ho-failed-border: #[0-9a-f]{6};/i);
  for (const l of ['quiet', 'broadsheet']) assert.match(read('looks/' + l + '.css'), /--handoff-cards-ho-pill-ho-failed-border: #/);
  // nothing else colours the notice's buttons (Make it thorough has no rule of its own); Simple has no rule for them
  for (const h of [d, m]) {
    assert.doesNotMatch(h, /research-lines[^{]*ho-status/);
    assert.doesNotMatch(h, /mm-simple[^{]*(research-lines|research-notice|wo-stop)/);
  }
});

// ── E4: the question line after nobody answered (both pages) ──
const RESEARCH_Q = 'Sam asks: research this? “Which judge is best?” This looks like a research question. Research it? Quick takes a few minutes; Thorough usually takes one to two hours (at most 6 hours). Both use your Claude plan allowance. No answer in 2 minutes: Sam starts a quick run if today\'s limit allows.';
function waitWordsSrc(src) {
  const a = src.indexOf('function researchWaitWords');
  return src.slice(a, src.indexOf('\n', src.indexOf("return s === 1 ? '1 second'", a)) + 1) + '\n}';
}
function desktopQuestions() {
  const a = app.indexOf('function retireQuestionNotices(requestId) {'), b = app.indexOf('// Plan card helpers (pure).');
  assert.ok(a > 0 && b > a);
  const notices = new Map(), retired = [];
  const ctx = vm.createContext({ questionNotices: notices, questionOverlays: {}, retireSoon: (n) => { retired.push(n); }, Number, String, Math });
  vm.runInContext(waitWordsSrc(app).replace(/^\s*/, '') + '\n' + app.slice(a, b) + '\nthis.close = closeQuestion; this.line = questionNoAnswerLine;', ctx);
  const line = (q) => { const n = mkEl('div'); n.className = 'system-notice'; n.textContent = '❓ ' + q; n.dataset.question = q; return n; };
  return { ctx, notices, retired, line };
}
function phoneQuestions() {
  const a = mob.indexOf('const questionTexts = new Map();'), b = mob.indexOf('function showQuestion(data, onAnswered) {');
  assert.ok(a > 0 && b > a);
  const boxes = new Map(), retired = [];
  const ctx = vm.createContext({ questionBoxes: boxes, retireSoon: (n) => { retired.push(n); }, document: { createElement: mkEl }, Number, String, Math, Map });
  vm.runInContext(waitWordsSrc(mob) + '\n' + mob.slice(a, b) + '\nthis.close = closeQuestion; this.line = questionNoAnswerLine; this.texts = questionTexts;', ctx);
  const box = () => { const x = mkEl('div'); x.innerHTML = ''; return x; };
  return { ctx, boxes, retired, box };
}
test('desktop: nobody answered, a deep research card: its line drops the ❓, goes muted, and says what was asked and how long nobody answered', () => {
  const P = desktopQuestions();
  const n = P.line(RESEARCH_Q);
  P.notices.set('r1', [n]);
  P.ctx.close('r1', { result: 'no_answer', waitedSeconds: 120 });
  assert.equal(n.textContent, 'Sam asked whether to research “Which judge is best?”. Nobody answered within 2 minutes.');
  assert.doesNotMatch(n.textContent, /❓/);
  assert.match(n.className, /notice-past/);
  assert.doesNotMatch(n.className, /warning|notice-working/);
  assert.deepEqual(P.retired, [n], 'then it retires as before');
  for (const [s, w] of [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes']]) assert.match(P.ctx.line(RESEARCH_Q, s), new RegExp(`Nobody answered within ${w}\\.$`));
  assert.equal(P.ctx.line(RESEARCH_Q), 'Sam asked whether to research “Which judge is best?”. Nobody answered in time.');
  assert.equal(P.ctx.line(RESEARCH_Q, 0), 'Sam asked whether to research “Which judge is best?”. Nobody answered in time.');
});
test('desktop: nobody answered, any other card: the first sentence and "Nobody answered in time."; an answered or skipped card is left alone', () => {
  const P = desktopQuestions();
  const n = P.line('Which database should I use? Postgres is the safer choice.');
  const m = P.line('Pick one');
  P.notices.set('r2', [n, m]);
  P.ctx.close('r2', { result: 'no_answer', waitedSeconds: 30 });
  assert.equal(n.textContent, 'Which database should I use? Nobody answered in time.');
  assert.equal(m.textContent, 'Pick one. Nobody answered in time.');
  assert.deepEqual(P.retired, [n, m]);
  for (const ev of [{ result: 'answered' }, { result: 'skipped' }, undefined]) {
    const k = P.line('Go on?');
    P.notices.set('r3', [k]);
    P.ctx.close('r3', ev);
    assert.equal(k.textContent, '❓ Go on?', 'only no_answer changes the line');
    assert.equal(k.className, 'system-notice');
  }
});
test('desktop: a stopped turn (no_answer without waitedSeconds) leaves the line as it was; with waitedSeconds 30 it says how long', () => {
  const P = desktopQuestions();
  for (const ev of [{ result: 'no_answer' }, { result: 'no_answer', stopped: true }, { result: 'no_answer', waitedSeconds: 0 }]) {
    const n = P.line(RESEARCH_Q);
    P.notices.set('s1', [n]);
    const before = n.textContent;
    P.ctx.close('s1', ev);
    assert.equal(n.textContent, before);
    assert.doesNotMatch(n.textContent, /Nobody answered/);
    assert.equal(n.className, 'system-notice');
    assert.ok(P.retired.includes(n), 'it still retires');
  }
  const t = P.line(RESEARCH_Q);
  P.notices.set('s2', [t]);
  P.ctx.close('s2', { result: 'no_answer', waitedSeconds: 30 });
  assert.equal(t.textContent, 'Sam asked whether to research “Which judge is best?”. Nobody answered within 30 seconds.');
});
test('desktop: every line of the request is changed; the page keeps each question text with its line and passes the whole event on', () => {
  const P = desktopQuestions();
  const a = P.line(RESEARCH_Q), b = P.line('Second question. More.');
  P.notices.set('r4', [a, b]);
  P.ctx.close('r4', { result: 'no_answer', waitedSeconds: 120 });
  assert.match(a.textContent, /^Sam asked whether/);
  assert.equal(b.textContent, 'Second question. Nobody answered in time.');
  assert.ok(app.includes("n.dataset.question = String(q.question == null ? '' : q.question)"));
  assert.ok(app.includes("if (ev && ev.request_id) closeQuestion(ev.request_id, ev); });"));
  assert.match(read('index.html'), /\.system-notice\.notice-past \{[^}]*color: var\(--auto-time-text\)/);
});
test('phone: nobody answered: each question line says what happened, in the box\'s muted done style (a research card and any other card)', () => {
  const P = phoneQuestions();
  const box = P.box();
  P.boxes.set('p1', box); P.ctx.texts.set('p1', [RESEARCH_Q, 'Which database should I use? Postgres is the safer choice.']);
  P.ctx.close('p1', 'no_answer', 120);
  assert.deepEqual(box.children.map((c) => c._t), ['Sam asked whether to research “Which judge is best?”. Nobody answered within 2 minutes.', 'Which database should I use? Nobody answered in time.']);
  assert.ok(box.children.every((c) => c.className === 'done'));
  assert.deepEqual(P.retired, [box]);
  assert.ok(!P.boxes.has('p1') && !P.ctx.texts.has('p1'));
  // without waitedSeconds
  const b2 = P.box(); P.boxes.set('p2', b2); P.ctx.texts.set('p2', [RESEARCH_Q]);
  P.ctx.close('p2', 'no_answer');
  assert.equal(b2.children.length, 0, 'a stopped turn: the old wording, not "Nobody answered"');
  assert.equal(b2.innerHTML, '<div class="done">No answer in time; the agent carried on</div>');
  const b4 = P.box(); P.boxes.set('p4', b4); P.ctx.texts.set('p4', [RESEARCH_Q]);
  P.ctx.close('p4', 'no_answer', 30);
  assert.equal(b4.children[0]._t, 'Sam asked whether to research “Which judge is best?”. Nobody answered within 30 seconds.');
  // an answered-elsewhere box keeps its old words
  const b3 = P.box(); P.boxes.set('p3', b3); P.ctx.texts.set('p3', ['Go on?']);
  P.ctx.close('p3', 'answered');
  assert.equal(b3.innerHTML, '<div class="done">Answered elsewhere</div>');
  assert.ok(mob.includes('questionTexts.set(request_id, questions.map('));
  assert.ok(mob.includes('closeQuestion(ev.request_id, ev.result, ev.waitedSeconds);'));
});
test('desktop and phone say the same words for a question nobody answered (the same function text)', () => {
  const fn = (src) => { const a = src.indexOf('function questionNoAnswerLine'); const rest = src.slice(a); return rest.slice(0, rest.search(/\n\s*\}\n/)).split('\n').map((l) => l.trim()).join('\n'); };
  assert.equal(fn(app), fn(mob));
  assert.ok(fn(app).includes('asked whether to research'));
});

// ── E5: the label above a research report turn ──
test('E5: a research report turn is labelled "Research finished" on both pages (and in the shared helper); other kinds keep their labels', () => {
  const lib = read('lib/ui-auto-turns.js');
  for (const [name, src] of [['desktop', app], ['phone', mob], ['lib', lib]]) {
    const a = src.indexOf('// ── auto-turn helpers (begin) ──'), b = src.indexOf('// ── auto-turn helpers (end) ──');
    assert.ok(a > 0 && b > a, name);
    const ctx = vm.createContext({ String, Array });
    vm.runInContext(src.slice(a, b) + '\nthis.info = autoInfoOf;', ctx);
    const u = (origin) => ({ role: 'user', content: 'x', origin });
    assert.equal(ctx.info(u({ kind: 'research_report', from: 'hub' })).label, 'Research finished', name);
    assert.equal(ctx.info(u({ kind: 'research_report', from: 'hub' })).kind, 'notice', name);
    assert.equal(ctx.info(u({ kind: 'mystery' })).label, 'Hub turn', name);
    assert.equal(ctx.info(u({ kind: 'alert' })).label, 'Monitor alert', name);
  }
  // the "from …" line under the reply and the ⚡ line use the same label
  assert.match(app, /case 'research_report': return 'research finished';/);
  assert.match(mob, /case 'research_report': return 'research finished';/);
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

// E6
test('settings: short labels, the detail in the help lines, the controls and keys, the defaults', () => {
  const { ctx } = settingsPage();
  const h = ctx.html({});
  assert.match(h, /<b>Research started by agents<\/b>/);
  assert.match(h, /<label for="st-ro-wait">Wait for an answer<\/label>/);
  assert.match(h, /<div class="st-hint">How long a research question waits for you\. After that the agent starts a quick run and says so in its report\.<\/div>/);
  for (const o of ['0">Don\'t wait<', '30">30 seconds<', '60">1 minute<', '120" selected>2 minutes<', '300">5 minutes<', '600">10 minutes<']) assert.ok(h.includes('value="' + o), o);
  assert.match(h, /saveResearchOwnWork\('researchOfferWaitSeconds', this\)/);
  assert.match(h, /<label for="st-ro-per-agent">Per agent, per day<\/label>[\s\S]*?id="st-ro-per-agent"[^>]*value="3"/);
  assert.match(h, /<label for="st-ro-install">All agents, per day<\/label>[\s\S]*?id="st-ro-install"[^>]*value="10"/);
  assert.match(h, /saveResearchOwnWork\('perAgent', this\)/);
  assert.match(h, /saveResearchOwnWork\('install', this\)/);
  assert.match(h, /id="st-ro-today" hidden/);
  // one shared help line for the two caps, after both
  assert.equal(h.split('How many research runs agents may start without asking. 0 means no limit.').length - 1, 1);
  assert.match(h, /id="st-ro-install"[\s\S]*?<div class="st-hint">How many research runs agents may start without asking\. 0 means no limit\.<\/div>/);
  assert.doesNotMatch(h, /Research agents may start without asking|Wait for an answer to a research question|start a quick run<\/option>/);
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
