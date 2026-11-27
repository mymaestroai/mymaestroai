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
  test(`${name}: a run the person started keeps today's plain line, no buttons (a run Make it thorough started is a notice since G2)`, () => {
    for (const startedBy of ['person', undefined]) {
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
  test(`${name}: an upgrade seen from another device: old quick run stopped, the new thorough run (startedBy upgrade) is one collapsed notice`, () => {
    const p = load(name);
    p.c.apply(ev({}));
    p.c.apply(ev({ seq: 2, state: 'stopped', active: false, upgradable: false }));
    p.c.apply(ev({ id: 'dr-2', startedBy: 'upgrade', level: 'thorough', upgradable: false, label: 'planning' }));
    assert.equal(cards(p.box).length, 1);
    assert.equal(p.box.children.length, 1);
    assert.deepEqual(textsOf(cards(p.box)[0]), ['Thorough research started. Its report will come here.', 'Stop', '▾', '×']);
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
  // the turn was stopped while the question was open (ask_user_done stopped: true): it says so, never "no answer in time" (review r6)
  const b5 = P.box(); P.boxes.set('p5', b5); P.ctx.texts.set('p5', [RESEARCH_Q]);
  P.ctx.close('p5', 'no_answer', undefined, true);
  assert.equal(b5.children.length, 0);
  assert.equal(b5.innerHTML, '<div class="done">Question closed when the turn stopped</div>');
  // the phone's event handler passes ev.stopped on
  assert.ok(mob.includes('closeQuestion(ev.request_id, ev.result, ev.waitedSeconds, ev.stopped)'), 'ask_user_done passes stopped');
  const b4 = P.box(); P.boxes.set('p4', b4); P.ctx.texts.set('p4', [RESEARCH_Q]);
  P.ctx.close('p4', 'no_answer', 30);
  assert.equal(b4.children[0]._t, 'Sam asked whether to research “Which judge is best?”. Nobody answered within 30 seconds.');
  // an answered-elsewhere box keeps its old words
  const b3 = P.box(); P.boxes.set('p3', b3); P.ctx.texts.set('p3', ['Go on?']);
  P.ctx.close('p3', 'answered');
  assert.equal(b3.innerHTML, '<div class="done">Answered elsewhere</div>');
  assert.ok(mob.includes('questionTexts.set(request_id, questions.map('));
  assert.ok(mob.includes('closeQuestion(ev.request_id, ev.result, ev.waitedSeconds, ev.stopped);'));
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

// ── Easel's second review (G1 to G4) ──
const LONG_NAME = 'abcdefghij'.repeat(4);   // 40 characters
for (const name of ['desktop', 'phone']) {
  // G1
  test(`G1 ${name}: collapsed, a long agent name is cut to 20 characters + "…" and the rest of the sentence is whole; opened, the full name, not clamped`, () => {
    const p = load(name, name === 'desktop' ? { agentDisplayName: () => LONG_NAME } : { displayName: () => LONG_NAME });
    p.c.apply(ev({}));
    const title = cards(p.box)[0].children[0].children[0];
    assert.equal(title._t, 'abcdefghijabcdefghij…' + ' started a quick research run for its work.');
    assert.match(title.className, /research-title-clamp/);
    const opened = openFirst(p).children[0].children[0];
    assert.equal(opened._t, LONG_NAME + ' started a quick research run for its work.');
    assert.doesNotMatch(opened.className, /research-title-clamp/);
    assert.match(opened.className, /ho-title/);
    // the other titles cut the name the same way; a name of 20 or fewer is left alone
    const q = load(name, name === 'desktop' ? { agentDisplayName: () => LONG_NAME } : { displayName: () => LONG_NAME });
    q.c.apply(ev({ startedBy: 'always', level: 'thorough' }));
    assert.equal(textsOf(cards(q.box)[0])[0], 'abcdefghijabcdefghij… started a thorough research run because you chose Always yes.');
    const s = load(name, name === 'desktop' ? { agentDisplayName: () => 'x'.repeat(20) } : { displayName: () => 'x'.repeat(20) });
    s.c.apply(ev({}));
    assert.equal(textsOf(cards(s.box)[0])[0], 'x'.repeat(20) + ' started a quick research run for its work.');
  });
  test(`G1 ${name}: the CSS clamps the collapsed title to two lines (display -webkit-box, -webkit-line-clamp: 2, line-clamp: 2, overflow hidden) and only the collapsed class carries it`, () => {
    const css = read(name === 'desktop' ? 'index.html' : 'mobile.html');
    const rule = /\.research-lines \.research-head \.ho-title\.research-title-clamp \{([^}]*)\}/.exec(css);
    assert.ok(rule, 'a clamp rule');
    assert.match(rule[1], /display: -webkit-box/);
    assert.match(rule[1], /-webkit-box-orient: vertical/);
    assert.match(rule[1], /-webkit-line-clamp: 2/);
    assert.match(rule[1], /(^|[^-])line-clamp: 2/);
    assert.match(rule[1], /overflow: hidden/);
    const base = /\.research-lines \.research-head \.ho-title \{([^}]*)\}/.exec(css)[1];
    assert.doesNotMatch(base, /line-clamp|overflow: hidden/, 'the plain title (opened) is not clamped');
  });
  // G2
  test(`G2 ${name}: after Make it thorough the box holds one bar: the new run's collapsed notice; the old run's confirmation is gone; opened: question and progress only`, async () => {
    const p = load(name);
    p.c.apply(ev({}));
    openFirst(p);
    await buttonsOf(cards(p.box)[0]).find((b) => b.textContent === 'Make it thorough').onclick();
    assert.equal(p.box.children.length, 1, 'before the new run shows: the confirmation');
    assert.equal(textsOf(cards(p.box)[0])[0], 'Thorough research started. Its report will come here.');
    p.c.apply(ev({ id: 'dr-2', seq: 1, startedBy: 'upgrade', level: 'thorough', label: 'quick pass', upgradable: false, startedAt: Date.now(), costLine: 'About $9 on this model.' }));
    assert.equal(p.box.children.length, 1, 'exactly one research element for the agent');
    const [card] = cards(p.box);
    assert.deepEqual(textsOf(card), ['Thorough research started. Its report will come here.', 'Stop', '▾', '×']);
    assert.match(card.children[0].children[0].className, /research-title-clamp/);
    assert.equal(p.c.runs.get('sam-bot').has('dr-1'), false, 'the old record is gone');
    const t = textsOf(openFirst(p));
    assert.equal(t[4], '“How big is the market for sleep trackers?”');
    assert.match(t[5], /^Deep research \(Thorough\): quick pass · just started$/);
    assert.equal(t.length, 6, 'no Why, no cost line, no Make it thorough');
    assert.deepEqual(labels(cards(p.box)[0]), ['Stop', '▴', '×']);
    // a late event of the old run does not bring its line back
    p.c.apply(ev({ seq: 9, state: 'running' }));
    assert.equal(p.box.children.length, 1);
  });
  test(`G2 ${name}: a run Make it thorough started is a notice (researchNoticeOn) and shows with an outcome-less record only once`, () => {
    const p = load(name);
    p.c.apply(ev({ id: 'dr-2', startedBy: 'upgrade', level: 'thorough', upgradable: false, label: 'planning' }));
    assert.equal(p.box.children.length, 1);
    assert.match(cards(p.box)[0].className, /research-notice/);
    assert.equal(cards(p.box)[0].children[0].children[0]._t, 'Thorough research started. Its report will come here.');
  });
}

// ── G3: the research report's row says what it is once ──
const Q_REPORT = 'How big is the market for sleep trackers?';
function helperCtx(src, extra = {}) {
  const a = src.indexOf('// ── auto-turn helpers (begin) ──'), b = src.indexOf('// ── auto-turn helpers (end) ──');
  assert.ok(a > 0 && b > a);
  const ctx = vm.createContext({ String, Array, Math, Number, ...extra });
  vm.runInContext(src.slice(a, b) + '\nthis.info = autoInfoOf; this.group = autoGroupHistory; this.kindOf = autoCardKind;', ctx);
  return ctx;
}
const reportHistory = (origin, content = `[Deep research finished] "${Q_REPORT}" (id dr-0a1b2c3d).\n\nThe research run finished.`) => [
  { role: 'user', content, origin, ts: '2026-11-25T23:31:00Z' },
  { role: 'assistant', content: 'Research finished. Here is the report.', for_owner: true },
];
function fakeNode(tag) {
  return { tag, className: '', textContent: '', children: [], attrs: {}, dataset: {}, hidden: false, parentNode: null,
    setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; }, addEventListener() {},
    append(...c) { for (const x of c) this.appendChild(x); }, appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    after(x) {   // like the DOM: x leaves its old place first
      if (x.parentNode && x.parentNode.children) { const o = x.parentNode.children.indexOf(x); if (o >= 0) x.parentNode.children.splice(o, 1); }
      const s = this.parentNode.children; s.splice(s.indexOf(this) + 1, 0, x); x.parentNode = this.parentNode;
    } };
}
const cardTexts = (wrap) => wrap.children[0].children.map((c) => c.textContent);
const fromLines = (panel) => panel.children.filter((c) => c.className === 'auto-from');

test('G3 lib/ui-auto-turns.js and both pages: a research_report turn gives its label and the question in quotes (both from its own message) as the row note; the card has no from line; other kinds are unchanged', () => {
  for (const [nm, src] of [['lib', read('lib/ui-auto-turns.js')], ['desktop', app], ['phone', mob]]) {
    const ctx = helperCtx(src);
    const o = { kind: 'research_report', from: 'hub' };
    const u = (origin, content = 'x') => ({ role: 'user', content, origin });
    const i = ctx.info(u(o, `[Deep research finished] "${Q_REPORT}" (id dr-0a1b2c3d).\n\nDone.`));
    assert.equal(i.label, 'Research finished', nm);
    assert.equal(i.note, '“' + Q_REPORT + '”', nm);
    assert.equal(i.noFrom, true, nm);
    // the four message forms (the stop / thorough ones have no "id ")
    const forms = [
      [`[Deep research finished] "Q1?" (id dr-0a1b2c3d): report`, 'Research finished'],
      [`[Deep research failed] "Q1?" (id dr-0a1b2c3d): it failed`, 'Research failed'],
      [`[Deep research stopped] "Q1?" (dr-0a1b2c3d): the person stopped this run.`, 'Research stopped'],
      [`[Deep research made thorough] "Q1?" (dr-0a1b2c3d): the person chose a thorough run`, 'Research made thorough'],
    ];
    for (const [msg, label] of forms) {
      const r = ctx.info(u(o, msg));
      assert.equal(r.label, label, nm + ': ' + msg);
      assert.equal(r.note, '“Q1?”', nm);
      assert.equal(r.noFrom, true, nm);
    }
    // an origin label or what is never read
    assert.equal(ctx.info(u({ ...o, label: 'Secret', what: 'stopped' }, `[Deep research finished] "Q1?" (id dr-0a1b2c3d)`)).label, 'Research finished', nm);
    assert.equal(ctx.info(u({ ...o, label: 'Secret' }, 'x')).note, '', nm);
    // a question with quotes, newlines and a long one
    assert.equal(ctx.info(u(o, `[Deep research finished] "Is "X" better\nthan  Y?" (id dr-0a1b2c3d)`)).note, '“Is "X" better than Y?”', nm);
    const long = ctx.info(u(o, `[Deep research stopped] "${'q'.repeat(300)}" (dr-0a1b2c3d)`));
    assert.equal(long.note, '“' + 'q'.repeat(119) + '…”', nm);
    assert.equal(ctx.info(u(o, `[Deep research finished] "${'q'.repeat(120)}" (id dr-0a1b2c3d)`)).note, '“' + 'q'.repeat(120) + '”', nm);
    // no match: "Research finished" and no note
    for (const bad of ['x', '', undefined, '[Deep research finished] "Q" (id dr-1)', '[Deep research paused] "Q" (dr-0a1b2c3d)']) {
      const none = ctx.info(u(o, bad));
      assert.equal(none.label, 'Research finished', nm);
      assert.equal(none.note, '', nm);
      assert.equal(none.noFrom, true, nm);
    }
    // the grouped card: its one line is the question (never the label again), no from line is wanted
    const [card] = ctx.group(reportHistory(o));
    assert.equal(card.type, 'card', nm);
    assert.equal(card.label, 'Research finished', nm);
    assert.equal(card.firstLine, '“' + Q_REPORT + '”', nm);
    assert.equal(card.noFrom, true, nm);
    assert.deepEqual([...card.open], [1], nm);
    const [bare] = ctx.group(reportHistory(o, 'x'));
    assert.equal(bare.firstLine, '', nm + ': no question, no second "Research finished"');
    // other kinds keep what they had
    assert.deepEqual({ ...ctx.info(u({ kind: 'alert', from: 'm' })) }, { kind: 'notice', from: 'm', label: 'Monitor alert' }, nm);
    assert.deepEqual({ ...ctx.info(u({ kind: 'consultation', from: 'bob' })) }, { kind: 'consultation', from: 'bob', label: 'Consultation from bob' }, nm);
    const [other] = ctx.group([{ role: 'user', content: 'x', origin: { kind: 'consultation', from: 'bob' } }, { role: 'assistant', content: 'Reply here', for_owner: true }]);
    assert.equal(other.noFrom, undefined, nm);
    assert.equal(other.firstLine, 'x', nm + ': the prompt line, as before');
  }
});
test('G3 desktop: the history card row reads "Research finished", the time, the question; no from line under the reply; a consultation still has its from line', () => {
  const a = app.indexOf('function foldToggle('), b = app.indexOf('function foldPromptLine(');
  assert.ok(a > 0 && b > a);
  const ctx = helperCtx(app, { document: { createElement: fakeNode }, foldCardTime: () => 'T' });
  vm.runInContext(app.slice(a, b) + '\nthis.render = foldRenderHistoryCard;', ctx);
  const draw = (panel) => (k, o) => { if (o.push === false) panel.appendChild({ className: 'entry', children: [] }); };
  const panel = fakeNode('div');
  const [card] = ctx.group(reportHistory({ kind: 'research_report', from: 'hub' }));
  ctx.render(draw(panel), card, panel, null, () => '11:31 PM');
  assert.deepEqual(cardTexts(panel.children[0]), ['Research finished', '11:31 PM', '“' + Q_REPORT + '”', '▸']);
  assert.equal(fromLines(panel).length, 0, 'no "from Research finished" line');
  assert.equal(panel.children.filter((c) => c.className === 'entry').length, 1, 'the reply is still shown');
  const p2 = fakeNode('div');
  const [cons] = ctx.group([{ role: 'user', content: 'x', origin: { kind: 'consultation', from: 'bob' } }, { role: 'assistant', content: 'Reply here', for_owner: true }]);
  ctx.render(draw(p2), cons, p2, null, () => 'T');
  assert.deepEqual(fromLines(p2).map((l) => l.textContent), ['from Consultation from bob']);
});
test('G3 desktop live: the report card keeps the question as its line when the turn ends, and the reply moves out with no from line', () => {
  const a = app.indexOf('function foldToggle('), b = app.indexOf('function foldPromptLine(');
  const ctx = helperCtx(app, { document: { createElement: fakeNode }, foldCardTime: () => 'T' });
  vm.runInContext(app.slice(a, b) + '\nthis.build = foldBuildCard;', ctx);
  const panel = fakeNode('div');
  const info = ctx.info({ role: 'user', content: `[Deep research finished] "${Q_REPORT}" (id dr-0a1b2c3d)`, origin: { kind: 'research_report', from: 'hub' } });
  const built = ctx.build(panel, { kind: info.kind, label: info.label, ts: 1, firstLine: 'working…', ...(info.noFrom ? { noFrom: true, note: info.note } : {}) }, () => 'T');
  assert.deepEqual(cardTexts(built.wrap), ['Research finished', 'T', '“' + Q_REPORT + '”', '▸']);
  built.setLine('Research finished. Here is the report.');   // turn end: the reply's first line
  built.setLine('');
  assert.equal(built.wrap.children[0].children[2].textContent, '“' + Q_REPORT + '”');
  assert.equal(built.noFrom, true);
  // an ordinary card still falls back to its label
  const o = ctx.build(panel, { kind: 'notice', label: 'Monitor alert', ts: 1, firstLine: 'working…' }, () => 'T');
  o.setLine('');
  assert.equal(o.wrap.children[0].children[2].textContent, 'Monitor alert');
  // hubMoveReplyOut: no from line for the report
  const src = app.slice(app.indexOf('function hubMoveReplyOut('), app.indexOf('function onHubForOwner('));
  const mk = (parentNode) => Object.assign(fakeNode('div'), { parentNode, isConnected: true });
  const pn = mk(null); const wrap = mk(pn); pn.children.push(wrap); wrap.classList = { remove() {} };
  const reply = mk(pn); reply.id = 'm1'; pn.children.push(reply);
  let fromCalls = 0;
  const fn = new Function('chats', 'document', 'foldFromLine', `${src}; return hubMoveReplyOut;`)({ c1: {} }, { getElementById: (id) => (id === 'messages-c1' ? pn : id === 'm1' ? reply : null) }, () => { fromCalls++; return mk(null); });
  const card = { chatId: 'c1', msgId: 'm1', label: 'Research finished', wrap, noFrom: true };
  fn(card);
  assert.equal(card.moved, true);
  assert.equal(fromCalls, 0);
  assert.deepEqual(pn.children.map((c) => c === wrap ? 'card' : c === reply ? 'reply' : '?'), ['card', 'reply']);
});
test('G3 phone: the history card row reads label, time, question; no from line under the reply; a consultation keeps it', () => {
  const a = mob.indexOf('function makeFoldHeader('), b = mob.indexOf('function promptCardLine(');
  const c = mob.indexOf('function renderAutoCard('), d = mob.indexOf('// Three or more cards in a row');
  assert.ok(a > 0 && b > a && c > b && d > c);
  const run = (history) => {
    const chat = fakeNode('div');
    let target = chat;
    const stubs = {
      document: { createElement: fakeNode }, chatEl: () => chat, bubbleHost: () => chat,
      withRenderTarget: (t, f) => { const prev = target; target = t || chat; f(); target = prev; },
      renderEntry: (e) => target.appendChild({ className: 'entry', children: [], textContent: e.content }),
      timeLabel: () => 'T', chatHistory: [], current: 'a', lastHistoryCard: null,
    };
    const ctx = helperCtx(mob, stubs);
    vm.runInContext(mob.slice(a, b) + mob.slice(c, d) + '\nthis.render = renderAutoCard;', ctx);
    const [it] = ctx.group(history);
    ctx.render(it, history.map(() => 'T'), chat, history, () => '11:31 PM');
    return chat;
  };
  const chat = run(reportHistory({ kind: 'research_report', from: 'hub' }));
  assert.deepEqual(chat.children[0].children[0].children.map((x) => x.textContent), ['Research finished', '11:31 PM', '“' + Q_REPORT + '”', '▸']);
  assert.equal(fromLines(chat).length, 0, 'no "from Research finished" line');
  assert.equal(chat.children.filter((x) => x.className === 'entry').length, 1);
  const other = run([{ role: 'user', content: 'x', origin: { kind: 'consultation', from: 'bob' } }, { role: 'assistant', content: 'Reply here', for_owner: true }]);
  assert.deepEqual(fromLines(other).map((l) => l.textContent), ['from Consultation from bob']);
});
test('G3 phone live: the report card keeps the question at turn end and the reply moves out with no from line', () => {
  const src = mob.slice(mob.indexOf('function moveReplyOut('), mob.indexOf('function onForOwner('));
  const mk = (parentNode) => Object.assign(fakeNode('div'), { parentNode, isConnected: true });
  const run = (card) => {
    const panel = mk(null); const wrap = mk(panel); panel.children.push(wrap);
    const el = mk(panel); panel.children.push(el);
    let created = 0;
    const fn = new Function('chatOpenFor', 'chatEl', 'document', 'scrollChat', 'unhideHubTurn', `${src}; return moveReplyOut;`)(() => true, () => panel, { createElement: () => { created++; return mk(null); } }, () => {}, () => {});
    const t = { agent: 'a', el, card: { ...card, wrap } };
    fn(t);
    return { t, created, panel, wrap, el };
  };
  const r = run({ label: 'Research finished', noFrom: true, note: '“q”' });
  assert.equal(r.t.card.moved, true);
  assert.equal(r.created, 0, 'no from line');
  assert.deepEqual(r.panel.children.map((c) => c === r.wrap ? 'card' : c === r.el ? 'el' : '?'), ['card', 'el']);
  const o = run({ label: 'Consultation from bob' });
  assert.equal(o.created, 1, 'other kinds keep the from line');
  // the live card and its turn-end line (the question stays; the label is not repeated)
  assert.ok(mob.includes("if (t.card && t.card.noFrom) t.card.line.textContent = t.card.note || '';"));
  assert.ok(mob.includes("if (info.noFrom) card.line.textContent = info.note || '';"));
  assert.ok(mob.includes("if (t.card && info.noFrom) { t.card.noFrom = true; t.card.note = info.note || ''; }"));
});
test('R10 server: the research turn origin is exactly { kind: research_report, from: hub }; no question or what travels in it', () => {
  const sdk = read('lib/sdk-chat.js');
  assert.ok(!sdk.includes('researchReportLabel'), 'the label helper is gone');
  assert.match(sdk, /wake: \(agent, message\) => new Promise/);
  assert.ok(sdk.includes("(text) => (String(text || '').trim() ? resolve() : reject(new Error('the report turn ended without a reply'))), { kind: 'research_report', from: 'hub' })"));
  assert.ok(!/research_report'[^\n]*(label|what)/.test(sdk.slice(sdk.indexOf('function getResearchRunner('), sdk.indexOf('slowTries: 138'))), 'no label / what next to the origin');
  assert.ok(!sdk.includes("meta?.what"), 'wakeAgent has no what');
  const rs = read('lib/research.js');
  assert.equal((rs.match(/await wake\(run\.agent, message\)/g) || []).length, 2, 'the report delivery and tellAgent pass only the message');
  assert.ok(!/wake\(run\.agent, message,/.test(rs));
  assert.ok(rs.includes('function tellAgent(run, message) {'));
  assert.ok(rs.includes("carry on without it.`);") && rs.includes("its report will come here.`);"));
  // the log keeps no what, and still the other fields
  const a = sdk.indexOf('function logOriginOf'), b = sdk.indexOf('function loadConversationLog');
  assert.ok(a > 0 && b > a);
  assert.ok(!/\.what\b|'what'/.test(sdk.slice(a, b)), 'logOriginOf has no what');
  const logOriginOf = new Function(sdk.slice(a, b) + '\nreturn logOriginOf;')();
  assert.deepEqual(logOriginOf({ kind: 'research_report', from: 'hub', what: 'stopped' }), { kind: 'research_report', from: 'hub' });
});
test('R10 live: the desktop and phone cards read the turn_start message, not the origin', () => {
  assert.ok(app.includes("autoInfoOf({ role: 'user', origin: ev.origin, content: ev.message || '' })"), 'desktop onHubTurnStart passes the message');
  assert.ok(mob.includes("autoInfoOf({ role: 'user', origin: ev.origin, content: ev.message || '' })"), 'phone onTurnStart passes the message');
  for (const src of [app, mob]) {
    assert.ok(!/o\.what\b/.test(src.slice(src.indexOf('function autoInfoOf('), src.indexOf('function autoFirstLine('))), 'autoInfoOf does not read origin.what');
    assert.ok(!/o\.label[^\n]*replace\(\/\\s\+\/g/.test(src), 'no origin.label question read');
  }
});

// ── G4: a question card opens at its top ──
test('G4 desktop: showQuestionModal focuses without scrolling and leaves the tall card scrolled to its top', () => {
  const a = app.indexOf('function showQuestionModal('), b = app.indexOf('// A question asked during a reply');
  assert.ok(a > 0 && b > a);
  const modal = { scrollTop: 0 };
  const focusCalls = [];
  const area = { value: '', scrollHeight: 0, clientHeight: 0, style: {}, addEventListener() {}, focus(o) { focusCalls.push(o); if (!o || o.preventScroll !== true) modal.scrollTop = 400; } };
  const submit = { disabled: true, addEventListener() {} }, hint = { textContent: '' };
  const overlay = { className: '', dataset: {}, scrollTop: 0, innerHTML: '', remove() {},
    querySelector(s) { return { '#question-custom-input': area, '#question-submit': submit, '#question-hint': hint, '.question-modal': modal }[s] || null; },
    querySelectorAll() { return []; } };
  const queue = [];
  const ctx = vm.createContext({ document: { createElement: () => overlay, body: { appendChild() { modal.scrollTop = 300; overlay.scrollTop = 200; } } }, shownQuestions: new Set(), escapeHtmlSafe: String,
    questionNotices: new Map(), questionOverlays: {}, questionChecklistOf: () => null, questionChecklistHtml: () => '', retireQuestionNotices() {}, askResponseBody() { return '{}'; },
    chats: {}, fetch: async () => ({ ok: true }), navigator: { platform: 'Linux' }, Option: function Option() {}, setTimeout: (f) => queue.push(f), console, Promise, String, Array, Map, Set, JSON });
  vm.runInContext(app.slice(a, b) + '\nthis.show = showQuestionModal;', ctx);
  ctx.show({ request_id: 'r1', questions: [{ question: 'Research this? ' + 'x'.repeat(2000), options: [{ label: 'Quick' }, { label: 'Thorough' }] }] }, null);
  assert.equal(modal.scrollTop, 0, 'at the top as soon as it is shown');
  assert.equal(queue.length, 1);
  queue.forEach((f) => f());
  assert.equal(focusCalls.length, 1);
  assert.deepEqual({ ...focusCalls[0] }, { preventScroll: true });
  assert.equal(modal.scrollTop, 0, 'still at the top after the focus');
  assert.equal(overlay.scrollTop, 0);
});
test('G4 phone: a question box taller than the chat opens with its top at the top of the chat, not scrolled past the question', () => {
  const a = mob.indexOf('function showQuestion(data, onAnswered) {'), b = mob.indexOf('// ── Action approvals');
  assert.ok(a > 0 && b > a);
  const stub = () => ({ value: '', disabled: false, textContent: '', style: {}, children: [], dataset: {}, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild(c) { this.children.push(c); return c; } });
  const mkBox = () => { const q = {}; const e = stub(); e.className = ''; e.querySelector = (s) => (q[s] ||= stub()); e.querySelectorAll = () => []; return e; };
  // review r8: #messages (chatEl) is the content wrapper, taller than the box; the visible, scrolling area is #chat-scroll
  const host = { children: [], clientHeight: 3000, scrollTop: 0, appendChild(c) { this.children.push(c); return c; }, getBoundingClientRect: () => ({ top: -2600 }) };
  const view = { clientHeight: 400, scrollTop: 0, getBoundingClientRect: () => ({ top: 0 }) };
  let box = null;
  const ctx = vm.createContext({ document: { createElement: () => mkBox() }, shownQuestions: new Set(), questionBoxes: new Map(), questionTexts: new Map(), voiceHintSync() {}, api: async () => ({ ok: true }), toast() {}, esc: String,
    $: (id) => (id === 'chat-scroll' ? view : null), stick: true,
    chatEl: () => host, scrollChat: () => { view.scrollTop = 1000; }, retireSoon() {}, Option: function Option() {}, current: 'a', Map, String, Array, JSON, Promise, console });
  const origAppend = host.appendChild.bind(host);
  host.appendChild = (c) => { origAppend(c); if (c.className === 'question') { box = c; c.offsetHeight = 900; c.getBoundingClientRect = () => ({ top: 1700 - view.scrollTop }); } return c; };
  vm.runInContext(mob.slice(a, b) + '\nthis.show = showQuestion;', ctx);
  ctx.show({ request_id: 'r1', questions: [{ question: 'Research this?', options: [{ label: 'Quick' }, { label: 'Thorough' }] }] });
  assert.ok(box, 'the box is in the chat');
  assert.equal(box.getBoundingClientRect().top, 0, 'the box top is at the top of the visible chat area');
  assert.equal(ctx.stick, false, 'the chat stops following new text, so a later delta does not scroll past the question');
});

test('R10: the real research messages (built by lib/research.js) give the row its label and question after a reload, through the saved origin', () => {
  const src = read('lib/sdk-chat.js');
  const a = src.indexOf('function logOriginOf'); const b = src.indexOf('function loadConversationLog');
  const logOriginOf = new Function(src.slice(a, b) + '\nreturn logOriginOf;')();
  const lib = require('../lib/ui-auto-turns.js');
  const rs = read('lib/research.js');
  assert.ok(rs.includes('[Deep research stopped] "${String(run.question).slice(0, 200)}" (${run.id})') && rs.includes('[Deep research made thorough] "${String(run.question).slice(0, 200)}" (${run.id})'), 'the messages have the shape the pages read');
  const saved = logOriginOf({ kind: 'research_report', from: 'hub' });
  for (const [kind, label] of [['finished', 'Research finished'], ['failed', 'Research failed'], ['stopped', 'Research stopped'], ['made thorough', 'Research made thorough']]) {
    const i = lib.autoInfoOf({ role: 'user', content: `[Deep research ${kind}] "Which heat pump brands are most reliable?" (dr-0a1b2c3d): x`, origin: saved });
    assert.equal(i.label, label);
    assert.equal(i.note, '“Which heat pump brands are most reliable?”');
  }
});

test('review r11: every message form lib/research.js builds gives its own row label and keeps the question (finished, failed, interrupted)', () => {
  const research = require('../lib/research.js');
  const lib = require('../lib/ui-auto-turns.js');
  const q = 'Which supplier? The "cheap" one';
  const row = (content) => lib.autoInfoOf({ role: 'user', content, origin: { kind: 'research_report', from: 'hub' } });
  const forms = [
    [research.reportMessage({ id: 'dr-0a1b2c3d', question: q, report: 'All done.' }), 'Research finished'],
    [research.reportMessage({ id: 'dr-0a1b2c3d', question: q, failed: 'no sources' }), 'Research failed'],
    [research.reportMessage({ id: 'dr-0a1b2c3d', question: q, interrupted: true, report: 'Not done: the last steps.' }), 'Research interrupted'],
  ];
  for (const [msg, label] of forms) {
    const i = row(msg);
    assert.equal(i.label, label, msg.slice(0, 60));
    assert.equal(i.note, '“' + q + '”', msg.slice(0, 60));
  }
  for (const src of [app, mob, read('lib/ui-auto-turns.js')]) assert.ok(src.includes('(finished|failed|interrupted|stopped|made thorough)'), 'all three copies know the interrupted form');
});
