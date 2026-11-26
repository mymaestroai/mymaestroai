'use strict';
// Phone: the ↻ arrows (chat header, agent list header) do a full "Reload app" and the app comes back in the same chat, scrolled to the
// bottom, with the half-typed message back in the box. The helper functions are cut out of mobile.js and RUN against fakes.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const js = read('mobile.js'), html = read('mobile.html');

function fnSource(name) {
  const i = js.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name);
  let depth = 0;
  for (let k = js.indexOf('{', i); k < js.length; k++) {
    if (js[k] === '{') depth++;
    else if (js[k] === '}' && --depth === 0) return js.slice(i, k + 1);
  }
  throw new Error('unterminated ' + name);
}
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

function page({ session = store(), agents = ['ann', 'bea'], screen = 'chat', current = 'bea', typed = '' } = {}) {
  const calls = [];
  const box = { value: typed, style: {}, scrollHeight: 30 };
  const els = { 'msg-input': box, 'chat-resync': { classList: { add: () => calls.push('spin:chat') } }, 'agents-refresh': { classList: { add: () => calls.push('spin:agents') } } };
  const ctx = {
    sessionStorage: session, screen, current, stick: false, JSON, Promise, Math,
    $: (id) => els[id] || null,
    agentByName: (n) => (agents.includes(n) ? { name: n } : undefined),
    saveDraft: (a, t) => calls.push('saveDraft:' + a + ':' + t),
    composerTypingPaint: () => {}, scrollChat: (f) => calls.push('scroll:' + f),
    reloadApp: () => { calls.push('reloadApp'); ctx.reloadKeepChatSeen = ctx.api.keep; return false; },   // false = the attempt never started
  };
  vm.createContext(ctx);
  const src = js.slice(js.indexOf('const RELOAD_STATE_KEY'), js.indexOf('function toggleMenu('));
  vm.runInContext(src + '\nthis.api = { reloadStash, reloadResume, reloadResumeFinish, reloadArrowClick, get keep() { return reloadKeepChat; } };', ctx);
  return { ctx, calls, box, session, api: ctx.api };
}

test('both arrows call the reload path (Reload app), not the old refresh / re-sync', () => {
  assert.match(js, /\$\('chat-resync'\)\?\.addEventListener\('click', reloadArrowClick\);/);
  assert.match(js, /\$\('agents-refresh'\)\.addEventListener\('click', reloadArrowClick\);/);
  assert.ok(!/'chat-resync'\)\?\.addEventListener\('click', resyncClick/.test(js) && !/agents-refresh'\)\.addEventListener\('click', loadAgents/.test(js));
  assert.match(js, /\$\('menu-reload'\)\?\.addEventListener\('click', \(e\) => \{ e\.stopPropagation\(\); \$\('menu'\)\.classList\.remove\('open'\); reloadApp\(\); \}\);/, 'the menu entry is unchanged');
  const t = page();
  return t.api.reloadArrowClick().then(() => {
    assert.ok(t.calls.includes('reloadApp'), 'the same reloader as the menu');
    assert.strictEqual(t.ctx.reloadKeepChatSeen, true, 'asked to keep the chat');
    assert.strictEqual(t.api.keep, false, 'the flag is reset when the attempt did not start');
  });
});

// The REAL reloadApp / createAppReloader / reloadArrowClick against fakes, with the preparation held open by the test.
function realPage({ typed = 'half a thought', answers = [] } = {}) {
  const session = store(), reloads = [], asked = [], timers = [];
  const box = { value: typed, style: {}, scrollHeight: 30 };
  const els = { 'msg-input': box, 'chat-resync': { classList: { add() {} } }, 'agents-refresh': { classList: { add() {} } } };
  let release; const gate = new Promise((r) => { release = r; });
  const ctx = {
    sessionStorage: session, screen: 'chat', current: 'bea', JSON, Promise, Math, Set, Array,
    $: (id) => els[id] || null,
    saveDraft: () => {}, toast: () => {}, voiceCall: false, APP_RELOAD_CALL_QUESTION: 'call?',
    pendingImages: [], imagesPreparing: new Set(),
    appReloadUrls: () => [], appFreshFetch: () => gate, fetch: () => null, document: {},
    navigator: {}, setTimeout: (f) => { timers.push(f); return 0; },
    window: { confirm: (q) => { asked.push(q); return answers.length ? answers.shift() : true; } },
    location: { origin: 'http://x', reload: () => reloads.push('reload') },
  };
  vm.createContext(ctx);
  const src = js.slice(js.indexOf('function createAppReloader('), js.indexOf('// ── app reload (end)')) + '\n' + js.slice(js.indexOf('function paintReloadBusy('), js.indexOf('function toggleMenu('));
  vm.runInContext(src + '\nthis.api = { reloadArrowClick, get keep() { return reloadKeepChat; } };', ctx);
  return { ctx, box, session, reloads, asked, timers, release, api: ctx.api };
}
const settle = () => new Promise((r) => setImmediate(r));

test('arrow: a photo attached during the wait is asked about at the final check; Cancel = no reload, photo kept, flag cleared', async () => {
  const t = realPage({ answers: [false] });   // the only question is the final one: Cancel
  const first = t.api.reloadArrowClick();
  assert.strictEqual(await first, true);
  assert.strictEqual(t.api.keep, true, 'the flag stays set while the files are being prepared');
  t.ctx.pendingImages.push({ name: 'p.jpg' });   // attached during the wait
  t.release();
  await settle();
  assert.deepStrictEqual(t.asked, ['Reload and remove the attached photo(s)? The text stays.'], 'asked once, at the final check');
  assert.deepStrictEqual(t.reloads, [], 'Cancel: no reload');
  assert.strictEqual(t.ctx.pendingImages.length, 1, 'the photo is still there');
  assert.strictEqual(t.session.m.size, 0, 'nothing stashed');
  assert.strictEqual(t.api.keep, false, 'the flag is cleared when the attempt ends');
});

test('arrow: no photo, preparation completes, go stashes the chat and the draft and reloads', async () => {
  const t = realPage({ typed: 'half a thought' });
  await t.api.reloadArrowClick();
  assert.strictEqual(t.api.keep, true);
  t.release();
  await settle();
  assert.deepStrictEqual(t.asked, []);
  assert.deepStrictEqual(JSON.parse(t.session.m.get('hub-mobile-reload')), { screen: 'chat', agent: 'bea' });
  assert.strictEqual(t.session.m.get('hub-mobile-reload-draft:bea'), 'half a thought');
  assert.deepStrictEqual(t.reloads, ['reload']);
  assert.strictEqual(t.api.keep, false);
});

test('arrow: a second tap during preparation is ignored (does not clear or restart the first)', async () => {
  const t = realPage();
  assert.strictEqual(await t.api.reloadArrowClick(), true);
  assert.strictEqual(await t.api.reloadArrowClick(), false, 'ignored');
  assert.strictEqual(t.api.keep, true, 'the first attempt keeps its flag');
  t.release();
  await settle();
  assert.deepStrictEqual(t.reloads, ['reload'], 'one reload');
  assert.ok(t.session.m.has('hub-mobile-reload'), 'the first attempt still stashed the chat');
});

test('arrow: Cancel at the first question (photo already attached) clears the flag', async () => {
  const t = realPage({ answers: [false] });
  t.ctx.pendingImages.push({ name: 'p.jpg' });
  assert.strictEqual(await t.api.reloadArrowClick(), false);
  assert.strictEqual(t.api.keep, false);
  assert.deepStrictEqual(t.reloads, []);
});

test('aria-label and tooltip of both arrows are "Reload"', () => {
  assert.match(html, /<button class="iconbtn" id="chat-resync" aria-label="Reload" title="Reload">/);
  assert.match(html, /id="agents-refresh" aria-label="Reload" title="Reload"/);
});

test('the reload stashes {screen, agent} and the half-typed message of that agent in sessionStorage', () => {
  const t = page({ typed: 'half a thought' });
  t.api.reloadStash();
  assert.deepStrictEqual(JSON.parse(t.session.m.get('hub-mobile-reload')), { screen: 'chat', agent: 'bea' });
  assert.strictEqual(t.session.m.get('hub-mobile-reload-draft:bea'), 'half a thought');
  const e = page({ typed: '   ' }); e.api.reloadStash();
  assert.strictEqual(e.session.m.size, 1, 'an empty box stores no draft');
  const l = page({ screen: 'agents', current: 'bea', typed: 'x' }); l.api.reloadStash();
  assert.deepStrictEqual(JSON.parse(l.session.m.get('hub-mobile-reload')), { screen: 'agents', agent: null });
  assert.strictEqual(l.session.m.size, 1, 'no draft from the list screen');
});

test('simulated reload: start-up reopens the same chat, restores the draft into an empty box, clears the saved state, scrolls to the bottom', () => {
  const s = store();
  page({ session: s, typed: 'half a thought' }).api.reloadStash();
  const t = page({ session: s, screen: 'agents', current: null });   // the new page
  const r = t.api.reloadResume({ screen: 'agents', agent: null });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.route)), { screen: 'chat', agent: 'bea' });
  assert.strictEqual(r.draft, 'half a thought');
  assert.strictEqual(r.fromArrow, true);
  assert.strictEqual(s.m.size, 0, 'both keys cleared');
  t.ctx.current = 'bea';
  t.api.reloadResumeFinish('bea', r.draft);
  assert.strictEqual(t.box.value, 'half a thought');
  assert.ok(t.calls.includes('saveDraft:bea:half a thought'));
  assert.ok(t.calls.includes('scroll:true') && t.ctx.stick === true, 'scrolled to the bottom');
  const u = page({ typed: 'new text' }); u.api.reloadResumeFinish('bea', 'old');
  assert.strictEqual(u.box.value, 'new text', 'a box that is not empty keeps what it has');
});

test('the saved chat is reopened only if the agent still exists for this user; otherwise the normal route', () => {
  const s = store();
  page({ session: s, typed: 'x' }).api.reloadStash();
  const t = page({ session: s, agents: ['ann'] });
  const r = t.api.reloadResume({ screen: 'agents', agent: null });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.route)), { screen: 'agents', agent: null });
  assert.strictEqual(r.fromArrow, false);
  assert.strictEqual(r.draft, null);
  assert.strictEqual(s.m.size, 0, 'state cleared even when it was not used');
  const n = page({ session: store() }).api.reloadResume({ screen: 'activity', agent: null });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(n.route)), { screen: 'activity', agent: null }, 'no reload state: the address decides as before');
});

test('start-up uses the resumed route and waits for the chat to open; openChat re-attaches a running turn (nothing is cancelled)', () => {
  assert.match(js, /const resumed = reloadResume\(routeFromHash\(\)\);/);
  assert.match(js, /const route = resumed\.route;\n\s+if \(typeof simpleRoute === 'function'\) simpleRoute\(route\);/);
  assert.match(js, /const opened = applyRoute\(route\);\n\s+if \(resumed\.fromArrow\) Promise\.resolve\(opened\)\.then\(\(\) => \{ if \(route\.screen === 'chat' && route\.agent === current\) reloadResumeFinish\(route\.agent, resumed\.draft\); \}\);/);
  assert.match(fnSource('applyRoute'), /return openChat\(state\.agent\);/);
  const stash = fnSource('reloadStash') + fnSource('reloadArrowClick');
  assert.ok(!/abort|cancel|stop/i.test(stash), 'the arrow cancels nothing');
});
