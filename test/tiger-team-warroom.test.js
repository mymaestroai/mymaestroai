'use strict';
// The Tiger Team war room on a phone (decision D3): the phone layout of tiger-team.html, each member's current step,
// the phone app's menu entry and the Teams list. The page's own functions are cut out of its source and run in a vm
// with a very small fake DOM (the pattern of tiger-team-page-batch1 / tiger-team-b2-page).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../tiger-team.html'), 'utf8');
const mobileHtml = fs.readFileSync(path.join(__dirname, '../mobile.html'), 'utf8');
const mobileJs = fs.readFileSync(path.join(__dirname, '../mobile.js'), 'utf8');

function cut(from, to) {
  const a = html.indexOf(from); assert.ok(a > 0, from + ' not found');
  const b = html.indexOf(to, a); assert.ok(b > a, to + ' not found');
  return html.slice(a, b);
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── The phone stylesheet (source checks) ──
const PHONE = html.slice(html.indexOf('@media (max-width: 700px)'), html.indexOf('</style>'));
const rule = (sel) => { const m = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(PHONE); assert.ok(m, 'phone rule ' + sel + ' missing'); return m[1]; };

test('CSS: a max-width 700px block holds the chip strip, the More menu and the fixed input bar', () => {
  assert.ok(PHONE.startsWith('@media (max-width: 700px)'));
  // roster strip: the side column goes, a horizontally scrollable strip of chips comes
  assert.match(rule('.roster-panel'), /display:\s*none/);
  assert.match(rule('.member-strip'), /display:\s*flex/);
  assert.match(rule('.member-strip'), /overflow-x:\s*auto/);
  assert.match(rule('.member-chip'), /min-height:\s*44px/);
  // More menu: a list that opens under the header
  assert.match(rule('.tt-more'), /display:\s*none/);
  assert.match(rule('.tt-more'), /position:\s*absolute/);
  assert.match(rule('.tt-more.open'), /display:\s*flex/);
  assert.match(rule('.tt-more-btn'), /display:\s*flex/);
  // fixed input bar, label above the box, room under the timeline
  assert.match(rule('.input-bar'), /position:\s*fixed/);
  assert.match(rule('.input-bar'), /bottom:\s*0/);
  assert.match(rule('.input-bar'), /flex-wrap:\s*wrap/);
  assert.match(rule('.input-bar .input-label'), /flex:\s*0 0 100%/);
  assert.match(rule('.timeline-scroll'), /padding:[^;]*var\(--input-h[^;]*\)/, 'the content is not hidden behind the bar');
});

test('CSS: nothing on the phone can make the page scroll sideways; long text and code wrap', () => {
  assert.match(rule('html, body'), /overflow-x:\s*hidden/);
  assert.match(rule('.timeline-scroll'), /overflow-x:\s*hidden/);
  assert.match(rule('.agent-block-body'), /overflow-wrap:\s*anywhere/);
  assert.match(rule('.agent-block-body pre'), /white-space:\s*pre-wrap/);
  assert.match(rule('.agent-block-body table'), /overflow-x:\s*auto/);
  assert.match(rule('.agent-block-body img'), /max-width:\s*100%/);
  assert.match(rule('.tt-header'), /flex-wrap:\s*wrap/);
  assert.match(rule('.tt-header .objective'), /min-width:\s*0/);
  assert.doesNotMatch(PHONE, /(?:^|[;{\s])(?:min-)?width:\s*\d{3,}px/, 'no fixed width of 100 px or more on a phone');
  // tool rows stay on one line
  assert.match(rule('.tool-call-info'), /flex-wrap:\s*nowrap/);
  assert.match(rule('.tool-call-input'), /min-width:\s*0/);
  assert.doesNotMatch(rule('.agent-block-body'), /white-space:\s*nowrap/);
});

test('CSS: the final report reads at 15 px or more and is not clipped; touch targets are at least 40 px', () => {
  assert.match(rule('.agent-block-body'), /font-size:\s*(?:1[5-9]|[2-9]\d)px/);
  assert.match(rule('.agent-block'), /overflow:\s*visible/, 'a card no longer clips its text');
  assert.match(rule('.tt-controls .tt-btn'), /min-height:\s*40px/, 'Stop, Resume, More');
  assert.match(rule('.input-bar .send-btn'), /min-height:\s*40px/);
  assert.match(rule('.input-bar textarea'), /min-height:\s*40px/);
  assert.match(rule('.approval-actions button'), /min-height:\s*40px/);
  assert.match(rule('.agent-block-body button'), /min-height:\s*40px/, 'the rounds approval buttons');
  assert.match(rule('.member-chip'), /min-height:\s*(?:4\d|[5-9]\d)px/);
  assert.match(rule('.input-bar textarea'), /font-size:\s*(?:1[6-9]|[2-9]\d)px/, 'a 16 px box does not zoom the page on a phone');
});

test('markup: Stop stays in the header; Save, Resolve unknowns, Full record and Load sit in the More menu; the input is a textarea', () => {
  const more = cut('<div class="tt-more" id="tt-more">', '<span class="status-badge');
  for (const id of ['btn-save', 'btn-load']) assert.match(more, new RegExp('id="' + id + '"'));
  assert.match(more, /reconcileUnknownOutcomes\(\)/);
  assert.match(more, /downloadFullRecord\(\)/);
  assert.doesNotMatch(more, /btn-stop|round-counter|status-badge/);
  const controls = cut('<div class="tt-controls">', '<div id="tt-error-banner"');
  assert.ok(controls.indexOf('id="btn-stop"') < controls.indexOf('id="tt-more"'), 'Stop is outside the menu');
  assert.ok(controls.indexOf('id="round-counter"') >= 0 && controls.indexOf('id="status-badge"') >= 0, 'round counter and status badge stay');
  assert.match(html, /<textarea id="user-input" rows="1"/);
  assert.match(html, /\.tt-header \.objective \{[^}]*white-space: nowrap;[^}]*text-overflow: ellipsis/s, 'the mission is one line');
  assert.match(cut('function showObjective', 'function setMoreMenu'), /parentElement\.title = String\(text/, 'the full mission is also the title');
  assert.match(html, /<div class="member-strip" id="member-strip"/);
  assert.match(cut('.member-strip { display: none; }', '.chip-dot {'), /display: none/, 'the strip is phone-only');
});

test('From the phone app: ?from=mobile adds a Back link to /mobile; the teams list shows only when there is no team to open', () => {
  assert.match(html, /<a class="tt-btn tt-back" id="tt-back" href="\/mobile"/);
  assert.match(html, /const fromMobile = params\.get\('from'\) === 'mobile';\s*\n\s*if \(fromMobile\) document\.body\.classList\.add\('from-mobile'\)/);
  assert.match(html, /\.from-mobile \.tt-back \{ display: flex/);
  assert.match(html, /\.tt-more-btn, \.tt-back \{ display: none; \}/, 'hidden unless opened from the phone app');
  assert.match(html, /if \(fromMobile && !launchId && !loadParam && !coordinator\) \{ await showTeamsHome\(\); return; \}/);
  // the desktop launch flow is not touched: it still starts from launch/coordinator parameters
  assert.match(html, /if \(launchId && !loadSaveId\) await fetchStagedParams\(\);/);
});

// ── Current step per member: the page's own handler in a vm ──
function mkEl(tag) {
  const kids = new Map();
  const el = {
    tag, innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, children: [], disabled: false, value: '', isConnected: true,
    classList: {
      _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; if (on) this._s.add(c); else this._s.delete(c); return on; },
    },
    querySelector(sel) { if (!kids.has(sel)) kids.set(sel, mkEl(sel)); return kids.get(sel); },
    querySelectorAll() { return []; },
    appendChild(n) { el.children.push(n); return n; },
    insertBefore(n) { el.children.unshift(n); return n; },
    remove() {}, addEventListener() {}, setAttribute() {}, after() {},
  };
  return el;
}

/** The page's state, helpers and event handler (setDot .. end of handleEvent) in a vm with a fake DOM. */
function pageCtx() {
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
  const ctx = {
    esc, console,
    document: { getElementById: getEl, createElement: mkEl, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: mkEl('body') },
    scrollBottom() {}, autoSave() {}, startAutoSave() {}, stopAutoSave() {}, localStorage: { setItem() {}, getItem() { return null; }, removeItem() {} },
    fetch: async () => ({ ok: false, status: 404 }),
  };
  vm.createContext(ctx);
  const code = [
    "let coordinator = 'boss', participants = ['atlas', 'bea', 'cy'], mode = 'led', challenger = '', maxRounds = 5, objective = 'x';",
    cut('    // ── State ──', '    // ── Agent color assignment'),
    cut('    const agentColorMap', '    // ── Marked config'),
    cut('    const purifyReady', '    /** Seconds as the war room'),
    cut('    /** Seconds as the war room', '    let userScrolledUp'),
    cut('    function setDot', '    // ── Phone: the header'),
    "globalThis.snap = () => JSON.parse(JSON.stringify(Object.fromEntries(memberStates)));",
  ].join('\n');
  vm.runInContext(code, ctx);
  vm.runInContext("agents = { boss: { display: 'Boss', icon: 'B' }, atlas: { display: '<b>Atlas</b>', icon: 'A' }, bea: { display: 'Bea', icon: 'E' }, cy: { display: 'Cy', icon: 'C' } };", ctx);
  const run = (src) => vm.runInContext(src, ctx);
  ctx.run = run;
  return { ctx, el: getEl, run };
}
let seq = 0;
const at = (hhmm) => '2026-11-18T' + hhmm + ':00';   // no zone: the local clock time the page prints
const member = (slug, call, gateway, hhmm, extra = {}) => ({ tt_seq: ++seq, tt_at: at(hhmm), tt_call: call, tt_role: 'participant', tt_agent: slug, gateway, ...extra });
const bare = (gateway, hhmm) => ({ tt_seq: ++seq, tt_at: at(hhmm), gateway });

test('a member goes through dispatch, a tool, tool result, text and completion: state, step and chip text follow', () => {
  seq = 0;
  const { ctx, el } = pageCtx();
  const step = () => ctx.snap().atlas;
  ctx.handleEvent(bare({ type: 'tt_dispatch', agent: 'atlas', role: 'participant', call_key: 'c1', task: 'read it' }, '22:40'));
  assert.equal(step().state, 'working');
  assert.equal(el('chipdot-atlas').className, 'chip-dot working');
  assert.equal(el('dot-atlas').className, 'activity-dot working');
  ctx.handleEvent(member('atlas', 'c1', { type: 'tool_start', tool: 'Read', tool_call_id: 't1', input: '' }, '22:41'));
  assert.equal(step().step, 'Read');
  ctx.handleEvent(member('atlas', 'c1', { type: 'tool_use', tool: 'Read', tool_call_id: 't1', input: '{"file_path":"/work/notes/draft.txt"}' }, '22:41'));
  assert.equal(step().state, 'working');
  assert.equal(step().step, 'Read draft.txt', 'the running tool\'s name and a short summary');
  assert.equal(el('chipstep-atlas').textContent, 'Read draft.txt');
  assert.equal(el('step-atlas').textContent, 'Read draft.txt', 'the side roster shows the step too');
  ctx.handleEvent(member('atlas', 'c1', { type: 'tool_result', tool: 'Read', tool_call_id: 't1', output: 'ok' }, '22:42'));
  assert.equal(step().step, 'thinking…');
  ctx.handleEvent(member('atlas', 'c1', null, '22:42', { choices: [{ delta: { content: 'Here is the draft' } }] }));
  assert.equal(step().step, 'writing…');
  assert.equal(el('chipstep-atlas').textContent, 'writing…');
  ctx.handleEvent(bare({ type: 'tt_dispatch_complete', agent: 'atlas', call_key: 'c1' }, '22:51'));
  assert.equal(step().state, 'done');
  assert.equal(el('chipstep-atlas').textContent, 'done 22:51');
  assert.equal(el('step-atlas').textContent, 'done 22:51');
  assert.equal(el('chipdot-atlas').className, 'chip-dot done');
  assert.equal(el('dot-atlas').className, 'activity-dot done');
  assert.equal(typeof step().at, 'number');
});

test('a failed member reads "failed"; a busy or voice-call notice reads "waiting: ..." until its first step', () => {
  seq = 0;
  const { ctx, el } = pageCtx();
  ctx.handleEvent(bare({ type: 'tt_dispatch', agent: 'bea', role: 'participant', call_key: 'c2' }, '22:40'));
  ctx.handleEvent(bare({ type: 'tt_dispatch_failed', agent: 'bea', agent_display: 'Bea', call_key: 'c2', error: 'boom' }, '22:44'));
  assert.equal(ctx.snap().bea.state, 'failed');
  assert.equal(el('chipstep-bea').textContent, 'failed');
  assert.equal(el('chipdot-bea').className, 'chip-dot failed');
  assert.equal(el('dot-bea').className, 'activity-dot failed');

  ctx.handleEvent(bare({ type: 'tt_dispatch', agent: 'cy', role: 'participant', call_key: 'c3' }, '22:45'));
  ctx.handleEvent(member('cy', 'c3', { type: 'tt_member_notice', agent: 'cy', message: 'cy is busy with another conversation; waiting up to 5 minutes for it to finish.' }, '22:45'));
  assert.equal(ctx.snap().cy.state, 'waiting');
  assert.equal(el('chipstep-cy').textContent, 'waiting: busy');
  assert.equal(el('chipdot-cy').className, 'chip-dot waiting');
  ctx.handleEvent(member('cy', 'c3', { type: 'tt_member_notice', agent: 'cy', message: 'cy is on a voice call; waiting up to 5 minutes for it to finish.' }, '22:46'));
  assert.equal(el('chipstep-cy').textContent, 'waiting: on a voice call');
  ctx.handleEvent(member('cy', 'c3', { type: 'tool_start', tool: 'Bash', tool_call_id: 'b1', input: '{"command":"ls -la /tmp"}' }, '22:47'));
  assert.equal(ctx.snap().cy.state, 'working', 'the first step ends the wait');
  assert.equal(el('chipstep-cy').textContent, 'Bash ls -la /tmp');
});

test('the coordinator has a state too (its tools and text), and a replay rebuilds every state from the same events', () => {
  seq = 0;
  const { ctx, el } = pageCtx();
  const events = [
    bare({ type: 'tt_coordinator_start' }, '22:30'),
    bare({ type: 'tool_start', tool: 'Grep', tool_call_id: 'g1', input: '{"pattern":"TODO"}' }, '22:31'),
    bare({ type: 'tt_dispatch', agent: 'atlas', role: 'participant', call_key: 'c1' }, '22:32'),
    member('atlas', 'c1', { type: 'tool_start', tool: 'Read', tool_call_id: 't1', input: '/a/b/plan.md' }, '22:33'),
    bare({ type: 'tt_dispatch_complete', agent: 'atlas', call_key: 'c1' }, '22:34'),
  ];
  for (const e of events) ctx.handleEvent(e);
  assert.equal(ctx.snap().atlas.state, 'done');
  assert.equal(el('chipstep-atlas').textContent, 'done 22:34');
  assert.equal(ctx.snap().boss.state, 'done', 'its card closed when the dispatch began');
  const first = JSON.stringify(ctx.snap());
  // a replay: forget everything the page drew (loadTeam does) and draw the same events again
  ctx.run('memberStates.clear(); callBlocks.clear(); currentBlock = null; lastSeq = 0;');
  assert.equal(JSON.stringify(ctx.snap()), '{}');
  for (const e of events) ctx.handleEvent(e);
  assert.equal(JSON.stringify(ctx.snap()), first);
  // the coordinator's own tool and text, with no dispatch in the way
  ctx.run('lastSeq = 0; memberStates.clear();');
  ctx.handleEvent({ tt_seq: 1, tt_at: at('23:00'), gateway: { type: 'tt_coordinator_start' } });
  ctx.handleEvent({ tt_seq: 2, tt_at: at('23:00'), gateway: { type: 'tool_start', tool: 'Grep', tool_call_id: 'g2', input: '{"pattern":"TODO"}' } });
  assert.equal(ctx.snap().boss.step, 'Grep TODO');
  ctx.handleEvent({ tt_seq: 3, tt_at: at('23:01'), choices: [{ delta: { content: 'Final answer' } }] });
  assert.equal(ctx.snap().boss.step, 'writing…');
});

test('escaping: a member name or tool summary with HTML never becomes markup; the step is set as text', () => {
  seq = 0;
  const { ctx, el } = pageCtx();
  ctx.run('buildChips()');
  const strip = el('member-strip').innerHTML;
  assert.match(strip, /&lt;b&gt;Atlas&lt;\/b&gt;/, 'the member name is escaped');
  assert.doesNotMatch(strip, /<b>Atlas/);
  assert.match(strip, /data-slug="atlas"/);
  assert.match(strip, /id="chipstep-atlas"/);
  assert.doesNotMatch(strip, /onclick/, 'no inline handler: a delegated click on the strip scrolls to the card');
  // a slug that tries to break out of its attributes
  ctx.run("participants = ['x\" onmouseover=\"alert(1)']; buildChips();");
  const evil = el('member-strip').innerHTML;
  assert.doesNotMatch(evil, /onmouseover="alert/);
  assert.match(evil, /&quot; onmouseover=&quot;alert\(1\)/);

  ctx.handleEvent(bare({ type: 'tt_dispatch', agent: 'atlas', role: 'participant', call_key: 'c9' }, '22:40'));
  ctx.handleEvent(member('atlas', 'c9', { type: 'tool_start', tool: '<script>x()</script>', tool_call_id: 'e1', input: '{"query":"<img src=x onerror=alert(1)>"}' }, '22:41'));
  const chip = el('chipstep-atlas');
  assert.equal(chip.textContent, '<script>x()</script> <img src=x onerror=alert(1)>', 'kept as plain text');
  assert.equal(chip.innerHTML, '', 'never written as markup');
  assert.equal(el('step-atlas').innerHTML, '');
  // the roster row's step line is in the markup the roster builds, with an escaped id
  assert.match(cut('function agentRosterHTML', 'function setDot'), /<div class="agent-step" id="step-\$\{esc\(slug\)\}"><\/div>/);
});

test('step text: a path shows its file name, a command its first words, long text is cut; nothing breaks on odd input', () => {
  const { run } = pageCtx();
  const t = (name, input) => run('toolStepText(' + JSON.stringify(name) + ', ' + JSON.stringify(input) + ')');
  assert.equal(t('Read', '{"file_path":"/home/a/b/draft.txt"}'), 'Read draft.txt');
  assert.equal(t('Read', { path: 'C:\\docs\\x.txt' }), 'Read x.txt');
  assert.equal(t('Bash', { command: 'git   status\n--short' }), 'Bash git status --short');
  assert.equal(t('Fetch', 'https://example.org/a'), 'Fetch https://example.org/a');
  assert.equal(t('Search', { foo: 1, bar: 'baz' }), 'Search baz');
  assert.equal(t('Noop', ''), 'Noop');
  assert.equal(t('Noop', null), 'Noop');
  assert.equal(t('Noop', '{not json'), 'Noop {not json');
  assert.equal(t('Bash', { command: 'x'.repeat(100) }), 'Bash ' + 'x'.repeat(40) + '…');
  assert.equal(t('', 'a'), 'tool a');
});

test('the chip strip: one chip per member (the coordinator first, no duplicates); tapping scrolls to the latest card of that member', () => {
  seq = 0;
  const { ctx, el, run } = pageCtx();
  run("participants = ['atlas', 'boss', 'bea']; challenger = 'cy'; buildChips();");
  const strip = el('member-strip').innerHTML;
  const order = [...strip.matchAll(/data-slug="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, ['boss', 'atlas', 'bea', 'cy']);
  assert.match(strip, /class="member-chip agent-color-\d"/);
  // the click handler: delegated on the strip
  assert.match(html, /document\.getElementById\('member-strip'\)\.addEventListener\('click'/);
  const cards = [{ dataset: { agent: 'atlas' }, scrolled: 0, scrollIntoView() { this.scrolled++; } }, { dataset: { agent: 'bea' }, scrollIntoView() { this.scrolled = (this.scrolled || 0) + 1; } }, { dataset: { agent: 'atlas' }, scrolled: 0, scrollIntoView() { this.scrolled++; } }];
  el('timeline').querySelectorAll = () => cards;
  run("scrollToMember('atlas')");
  assert.equal(cards[2].scrolled, 1, 'the latest card of the member');
  assert.equal(cards[0].scrolled, 0);
  assert.equal(cards[1].scrolled || 0, 0);
  run("scrollToMember('nobody')");   // no card: nothing happens, nothing throws
  // every card carries its member for that lookup
  assert.match(cut('function makeBlock', 'function openBlock'), /block\.dataset\.agent = slug;/);
  const cardEl = el('timeline').children[0];
  void ctx; void cardEl;
});

// ── Phone entry: the ⋮ menu of the phone app ──
test('mobile.html: #menu-tiger is a link to /tiger-team?from=mobile, hidden by default, with an entity-encoded tiger and the text "Tiger Teams"', () => {
  const m = /<a id="menu-tiger" href="\/tiger-team\?from=mobile" hidden>([^<]*)<\/a>/.exec(mobileHtml);
  assert.ok(m, 'the link is in the menu');
  assert.match(m[1], /^&#x[0-9A-Fa-f]+; Tiger Teams$/);
  assert.equal(/[\u{1F000}-\u{1FFFF}\uFE0F]/u.test(m[0]), false, 'no raw emoji or variation selector');
  assert.ok(mobileHtml.indexOf('id="menu-tiger"') > mobileHtml.indexOf('id="menu-recordings"'), 'next to Recordings in the same menu');
});

test('mobile.js shows #menu-tiger only for an admin (isAdmin === true), and never for a member or before the account is known', () => {
  const start = mobileJs.indexOf("{ const ti = $('menu-tiger');");
  assert.ok(start > 0, 'the line is in loadMe');
  const stmt = mobileJs.slice(start, mobileJs.indexOf('\n', start));
  assert.ok(mobileJs.indexOf('async function loadMe()') < start && start < mobileJs.indexOf('async function loadMe()') + 600, 'inside loadMe, right after the account is read');
  const run = (hubMe) => { const link = { hidden: true }; vm.runInNewContext(stmt, { $: (id) => (id === 'menu-tiger' ? link : null), hubMe }); return link.hidden; };
  assert.equal(run({ isAdmin: true }), false, 'an admin sees it');
  assert.equal(run({ isAdmin: false }), true, 'a member does not');
  assert.equal(run({}), true, 'no isAdmin flag: hidden');
  assert.equal(run(null), true);
  // the menu's other users are untouched
  assert.match(mobileJs, /const ri = \$\('menu-recordings'\)/);
});

// ── The Teams list ──
const listCtx = () => {
  const ctx = { esc, encodeURIComponent, Date, Number, Array, Date };
  vm.createContext(ctx);
  vm.runInContext(cut('    function clockTime', '    /** The stamp on a card') + cut('    const TEAM_LIVE_STATUSES', '    async function showTeamsHome'), ctx);
  return ctx;
};
const SESSIONS = [
  { id: 'old1', status: 'completed', objective: 'Older finished', completed_at: '2026-11-17T10:00:00.000Z' },
  { id: 'x y/1', status: 'running', objective: '<img src=x onerror=alert(1)> plan the launch', completed_at: null },
  { id: 'new1', status: 'completed', objective: 'Newest finished', completed_at: '2026-11-18T10:00:00.000Z' },
  { id: 'bad1', status: 'interrupted', objective: 'Was cut off', completed_at: null },
  { id: 'run2', status: 'retrying', objective: 'Second running', completed_at: null },
  { id: '', status: 'running', objective: 'no id: skipped' },
];

test('Teams list: running first, then the latest finished; a status chip, the objective and a time on every row', () => {
  const out = listCtx().teamsListHTML(SESSIONS);
  const ids = [...out.matchAll(/href="\/tiger-team\?load=([^&"]+)&amp;from=mobile"/g)].map(m => decodeURIComponent(m[1]));
  assert.deepEqual(ids.slice(0, 2).sort(), ['run2', 'x y/1'], 'running and retrying teams come first');
  assert.deepEqual(ids.slice(2), ['new1', 'old1', 'bad1'], 'then the latest finished, those with no end time last');
  assert.equal(ids.length, 5, 'a row without an id is not a link');
  assert.match(out, /<span class="team-chip running">running<\/span><span class="team-time">running now<\/span>/);
  assert.match(out, /<span class="team-chip completed">completed<\/span><span class="team-time">ended [^<]+\d\d:\d\d<\/span>/);
  assert.match(out, /<span class="team-chip problem">interrupted<\/span>/);
  assert.match(out, /<div class="team-obj">Newest finished<\/div>/);
});

test('Teams list: every link carries load=<id>&from=mobile (the id URL-encoded); the objective and status are escaped', () => {
  const out = listCtx().teamsListHTML(SESSIONS);
  assert.match(out, /href="\/tiger-team\?load=x%20y%2F1&amp;from=mobile"/);
  assert.match(out, /href="\/tiger-team\?load=new1&amp;from=mobile"/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt; plan the launch/);
  assert.doesNotMatch(out, /<img/);
  const hostile = listCtx().teamsListHTML([{ id: 'a"><script>1</script>', status: '<b>', objective: '"><script>x</script>' }]);
  assert.doesNotMatch(hostile, /<script|<b>/);
  assert.match(hostile, /load=a%22%3E%3Cscript%3E1%3C%2Fscript%3E&amp;from=mobile/);
  assert.equal(listCtx().teamsListHTML([]).includes('No Tiger Teams yet.'), true);
  assert.equal(listCtx().teamsListHTML(null).includes('No Tiger Teams yet.'), true);
  assert.match(html, /\.team-obj \{[^}]*-webkit-line-clamp: 2/, 'one or two lines');
  assert.match(html, /\.team-row \{[^}]*min-height: 44px/);
});

test('showTeamsHome: fetches GET /api/tiger-team/list, draws the answer (or an escaped error), and puts the page in list mode', async () => {
  const run = async (fetchImpl) => {
    const els = new Map();
    const getEl = (id) => { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); };
    const calls = [];
    const ctx = {
      esc, encodeURIComponent, Date, document: { getElementById: getEl, body: mkEl('body') },
      showObjective(t) { ctx.objectiveShown = t; }, setStatus(c, t) { ctx.statusShown = [c, t]; },
      fetch: async (u, o) => { calls.push([u, o]); return fetchImpl(u, o); },
    };
    vm.createContext(ctx);
    vm.runInContext(cut('    function clockTime', '    /** The stamp on a card') + cut('    const TEAM_LIVE_STATUSES', '    // Enter key sends'), ctx);
    await ctx.showTeamsHome();
    return { ctx, calls, tl: getEl('timeline') };
  };
  const ok = await run(async () => ({ ok: true, json: async () => ({ sessions: SESSIONS }) }));
  assert.equal(ok.calls[0][0], '/api/tiger-team/list');
  assert.equal(ok.ctx.document.body.classList.contains('teams-view'), true);
  assert.equal(ok.ctx.objectiveShown, 'Tiger Teams');
  assert.match(ok.tl.innerHTML, /class="team-row"/);
  assert.match(ok.tl.innerHTML, /load=new1&amp;from=mobile/);
  const bad = await run(async () => ({ ok: false, status: 403 }));
  assert.match(bad.tl.innerHTML, /Could not load the teams: HTTP 403/);
  const boom = await run(async () => { throw new Error('<i>offline</i>'); });
  assert.match(boom.tl.innerHTML, /&lt;i&gt;offline&lt;\/i&gt;/);
  assert.doesNotMatch(boom.tl.innerHTML, /<i>/);
  // the list view hides the controls, the roster and the input bar
  assert.match(html, /\.teams-view \.input-bar, \.teams-view \.roster-panel, \.teams-view \.member-strip \{ display: none !important; \}/);
  assert.match(html, /\.teams-view \.tt-controls > :not\(\.status-badge\) \{ display: none !important; \}/);
});

test('review r1: Escape closes the More menu and returns the focus; Enter confirming an input-method candidate never sends', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '../tiger-team.html'), 'utf8');
  assert.match(page, /if \(e\.isComposing \|\| e\.keyCode === 229\) return;\n\s*if \(e\.key === 'Enter' && !e\.shiftKey\)/);
  assert.match(page, /if \(e\.key === 'Escape' && menu && menu\.classList\.contains\('open'\)\) \{ setMoreMenu\(false\);[^\n]*b\.focus\(\)/);
});

test('review r1: a member running two tools keeps showing the one still running when the first returns', () => {
  const page = require('node:fs').readFileSync(require('node:path').join(__dirname, '../tiger-team.html'), 'utf8');
  const body = page.slice(page.indexOf('function completeTool(callId, result) {'), page.indexOf('function completeTool(callId, result) {') + 900);
  assert.match(body, /const other = \[\.\.\.toolMap\.values\(\)\]\.find\(t => t !== entry && t\.slug === entry\.slug && t\.line && \/\\brunning\\b\/\.test\(t\.line\.className \|\| ''\)\);/);
  assert.match(body, /setMemberStep\(entry\.slug, other \? toolStepText\(other\.name\) : 'thinking…'\);/);
});

test('review r1: the phone menu link is set after Simple mode is applied (the order the Simple tests pin)', () => {
  const mob = require('node:fs').readFileSync(require('node:path').join(__dirname, '../mobile.js'), 'utf8');
  const apply = mob.indexOf("window.hubSimple.apply(hubMe)");
  const link = mob.indexOf("$('menu-tiger')");
  assert.ok(apply > 0 && link > apply, 'menu-tiger comes after the Simple apply');
});
