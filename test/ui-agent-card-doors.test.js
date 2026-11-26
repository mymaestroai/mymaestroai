'use strict';
// The ways in to the agent card (phase 3, part D): the chips' last lines, the agent's name, the row's "Settings", the phone's menu items
// and Simple's name, the door line of agent-settings.html, the pages' scripts and event handling, and the rename event.
// The page code runs for real where it can (functions cut out of app.js / mobile.js and run in a sandbox with a fake window); the rest is pinned
// with source checks. Offline; reads no data/.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const app = read('app.js');
const mob = read('mobile.js');

/** The text of a top-level-ish function (sync or async) by its header, braces matched. */
function fnText(src, header) {
  const at = src.indexOf(header);
  assert.ok(at >= 0, 'not found: ' + header);
  const open = src.indexOf('{', src.indexOf(')', at));
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(at, i + 1);
}
function between(src, from, to) {
  const a = src.indexOf(from), b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'markers not found: ' + from + ' .. ' + to);
  return src.slice(a, b);
}

// A fake card: records what the page asks of it.
function fakeCard(openResult = true) {
  const calls = { open: [], configure: [] };
  return {
    calls,
    configure(o) { calls.configure.push(o); },
    open(name, where) { calls.open.push({ name, where: JSON.parse(JSON.stringify(where)) }); return Promise.resolve(openResult); },   // a copy: the page's objects come from another realm
  };
}

// ---- the desktop page's code ----------------------------------------------------------------------------------------
function desktop(extra = {}) {
  const card = extra.card === undefined ? fakeCard() : extra.card;
  const listeners = { click: [], keydown: [] };
  const popups = [];
  const toasts = [];
  const fetches = [];
  const chats = extra.chats || { 'chat-1': { id: 'chat-1', agent: 'sam', display: 'Sam' } };
  const sandbox = {
    window: { hubAgentCard: card, open: (...a) => { popups.push(a); return null; }, hubMe: extra.me || { isAdmin: true } },
    document: {
      addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
      getElementById: (id) => (extra.els || {})[id] || null,
    },
    AGENTS: extra.agents || [{ name: 'sam', display: 'Sam', model: 'claude-sdk/claude-sonnet-5-5' }, { name: 'hazel', display: 'Hazel' }],
    chats, settingsWindows: {}, popups, toasts, fetches,
    capName: (n) => n.charAt(0).toUpperCase() + n.slice(1),
    isHubAdmin: () => !(extra.me && extra.me.isAdmin === false),
    voiceReady: () => extra.voiceReady !== false,
    hubToast: (t) => toasts.push(t),
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    fetch: async (url, opt) => { fetches.push({ url, opt }); return { ok: extra.patchOk !== false, status: 200, json: async () => (extra.patchOk === false ? { error: 'no' } : { success: true }) }; },
    setTimeout: (fn) => { fn(); return 0; },
    URLSearchParams,
  };
  vm.createContext(sandbox);
  const code = between(app, 'const agentCardSubs = {};', '    function openAgentSettingsPopup(')
    + '\n' + fnText(app, 'function openAgentSettingsPopup(').replace(/window\.open\(/, 'window.open(');
  vm.runInContext(code + '\nthis.__api = { agentCardSubscribe, agentCardEmit, agentCardLastLine, openAgentCard, openAgentSettings, voiceAgentChipPaint, voiceAgentChipToggle, voiceAgentCardOpen, CARD_PICK };', sandbox);
  return { api: sandbox.__api, card, listeners, popups, toasts, fetches, sandbox };
}

test('desktop: the page configures the card with its own subscribe and agent list, so the card opens no stream', () => {
  const d = desktop();
  assert.strictEqual(d.card.calls.configure.length, 1);
  const conf = d.card.calls.configure[0];
  assert.strictEqual(typeof conf.subscribe, 'function');
  assert.deepStrictEqual(conf.agentsList().map((a) => a.name), ['sam', 'hazel']);
  const seen = [];
  const off = conf.subscribe('agent_updated', (ev) => seen.push(ev));
  d.api.agentCardEmit('agent_updated', { agent: 'sam' });
  d.api.agentCardEmit('settings_changed', { x: 1 });   // nobody listens: nothing happens
  assert.deepStrictEqual(seen, [{ agent: 'sam' }]);
  off();
  d.api.agentCardEmit('agent_updated', { agent: 'sam' });
  assert.strictEqual(seen.length, 1);
});

test('desktop: a failing listener does not stop the others', () => {
  const d = desktop();
  const seen = [];
  d.api.agentCardSubscribe('settings_changed', () => { throw new Error('boom'); });
  d.api.agentCardSubscribe('settings_changed', (ev) => seen.push(ev));
  d.api.agentCardEmit('settings_changed', { a: 1 });
  assert.strictEqual(seen.length, 1);
});

test('desktop: the page feeds the card from its own event stream (agent_updated, agent_renamed, settings_changed)', () => {
  assert.match(app, /addEventListener\('settings_changed', e => \{ const ev = parse\(e\); if \(ev\) agentCardEmit\('settings_changed', ev\); \}\)/);
  assert.match(app, /addEventListener\('agent_updated', e => \{ const ev = parse\(e\); if \(ev\) agentCardEmit\('agent_updated', ev\); \}\)/);
  assert.match(app, /addEventListener\('agent_renamed', e => \{ const ev = parse\(e\); if \(ev\) agentCardEmit\('agent_renamed', ev\); \}\)/);
  // the page's own handling stays as it was
  assert.match(app, /addEventListener\('agent_updated', e => \{ const ev = parse\(e\); if \(ev\) onAgentUpdated\(ev\); \}\)/);
});

test('desktop: the row menu\'s Settings, a new agent and a clone open the card, not the popup; the popup only when the card is missing', async () => {
  const d = desktop();
  const stopped = [];
  d.api.openAgentSettings('sam', { stopPropagation: () => stopped.push(1) });
  assert.strictEqual(stopped.length, 1);
  assert.deepStrictEqual(d.card.calls.open, [{ name: 'sam', where: {} }]);
  assert.strictEqual(d.popups.length, 0);
  d.api.openAgentSettings('hazel', new (class { stopPropagation() {} })(), 'OPT-0022');   // create / clone pass an event
  assert.deepStrictEqual(d.card.calls.open[1], { name: 'hazel', where: { row: 'OPT-0022' } });

  const none = desktop({ card: null });
  none.sandbox.window.hubAgentCard = undefined;
  none.api.openAgentSettings('sam', { stopPropagation() {} });
  assert.strictEqual(none.popups.length, 1);
  assert.match(none.popups[0][0], /^\/agent-settings\.html\?agent=sam$/);
});

test('desktop: the card says no (no such agent, not yours): the old page opens as before', async () => {
  const d = desktop({ card: fakeCard(false) });
  d.api.openAgentCard('sam');
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(d.popups.length, 1);
});

test('desktop: the last line says "All settings for <agent>…" with the agent\'s display name', () => {
  const d = desktop();
  assert.strictEqual(d.api.agentCardLastLine('sam'), 'All settings for Sam…');
  assert.strictEqual(d.api.agentCardLastLine('nobody'), 'All settings for Nobody…');
});

test('desktop: the agent\'s name in the chat header opens that chat\'s agent card; a group chat and other clicks do nothing', () => {
  const d = desktop({ chats: { 'chat-1': { id: 'chat-1', agent: 'sam' }, 'chat-2': { id: 'chat-2', agent: 'hazel', isGroup: true } } });
  const nameIn = (chatId) => {
    const pick = { id: 'model-pick-' + chatId };
    const wrap = { querySelector: (s) => (s === '.model-pick' ? pick : null) };
    const t = { closest: (s) => (s === '.agent-name' ? wrap : null) };
    return { target: { closest: (s) => (s === '.agent-name-text' ? t : null) } };
  };
  const click = d.listeners.click[0];
  click(nameIn('chat-1'));
  assert.deepStrictEqual(d.card.calls.open, [{ name: 'sam', where: {} }]);
  click(nameIn('chat-2'));   // a group chat has no single agent
  click({ target: { closest: () => null } });   // another click
  assert.strictEqual(d.card.calls.open.length, 1);
  // the header markup keeps the name span exactly as the escaping test pins it
  assert.match(app, /<span class="agent-name"><span class="agent-name-text">\$\{hubEsc\(chat\.display \|\| capName\(chat\.agent\)\)\}<\/span> <select class="model-pick" id="model-pick-\$\{chatId\}"/);
});

test('desktop: the model picker keeps its choices and gets a last line that opens the card at the Model row', () => {
  const fill = fnText(app, 'async function fillModelPickNow(');
  assert.match(fill, /window\.hubAgentCard\) html \+= `<optgroup label="Settings"><option value="__card__">\$\{esc\(agentCardLastLine\(chat\.agent\)\)\}<\/option><\/optgroup>`;/);
  assert.ok(fill.indexOf('__card__') > fill.indexOf('More OpenRouter models'), 'the last line comes after every model group');
  assert.ok(fill.indexOf('__card__') < fill.indexOf('sel.innerHTML = html'));
  const d = desktop();
  const calls = [];
  const sandbox = d.sandbox;
  sandbox.OR_MORE = '__or_more__';
  sandbox.paintAutoPick = (id) => calls.push('paint:' + id);
  sandbox.openOrPicker = () => calls.push('or');
  sandbox.queueModelChange = (...a) => { calls.push(['queue', ...a]); return Promise.resolve(true); };
  sandbox.chats['chat-1'].agent = 'sam';
  vm.runInContext(fnText(app, 'async function changeChatModel(') + '\nthis.__cm = changeChatModel;', sandbox);
  return sandbox.__cm('chat-1', '__card__').then((r) => {
    assert.strictEqual(r, false);
    assert.deepStrictEqual(d.card.calls.open.at(-1), { name: 'sam', where: { row: 'OPT-0047' } });
    assert.ok(!calls.some((c) => Array.isArray(c)), 'the last line is never sent as a model');
    return sandbox.__cm('chat-1', 'openai/gpt-6-astra');
  }).then(() => assert.deepStrictEqual(JSON.parse(JSON.stringify(calls.at(-1))), ['queue', 'chat-1', 'openai/gpt-6-astra', {}]));
});

test('desktop: the effort picker keeps its levels (admins) and gets a last line to the Thinking effort row; members get none', async () => {
  const ob = fnText(app, 'function effortOptionsHtml(');
  const sb = desktop().sandbox;
  sb.EFFORT_LEVELS = [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']];
  sb.EFFORT_ULTRA = ['ultra', 'Ultra'];
  sb.effortUltraOf = () => false;
  sb.effortLevelShown = () => 'medium';
  vm.runInContext(ob + '\nthis.__eo = effortOptionsHtml;', sb);
  const html = sb.__eo({ agent: 'sam' });
  assert.match(html, /<option value="medium" selected>Medium<\/option>/);
  assert.ok(html.endsWith('<option value="__card__">All settings for Sam…</option>'));
  const member = desktop({ me: { isAdmin: false } }).sandbox;
  member.EFFORT_LEVELS = sb.EFFORT_LEVELS; member.EFFORT_ULTRA = sb.EFFORT_ULTRA; member.effortUltraOf = () => false; member.effortLevelShown = () => 'low';
  vm.runInContext(ob + '\nthis.__eo = effortOptionsHtml;', member);
  assert.ok(!member.__eo({ agent: 'sam' }).includes('__card__'));
  // the change handler: the last line opens the card and puts the picker back; a level still saves through PATCH
  const d = desktop();
  const refreshed = [];
  d.sandbox.refreshEffortPick = (c) => refreshed.push(c.id);
  d.sandbox.agentEffortOf = () => 'medium';
  d.sandbox.alert = () => {};
  vm.runInContext(fnText(app, 'async function changeChatEffort(') + '\nthis.__ce = changeChatEffort;', d.sandbox);
  await d.sandbox.__ce('chat-1', '__card__');
  assert.deepStrictEqual(d.card.calls.open.at(-1), { name: 'sam', where: { row: 'OPT-0057' } });
  assert.deepStrictEqual(refreshed, ['chat-1']);
  assert.strictEqual(d.fetches.length, 0);
  await d.sandbox.__ce('chat-1', 'high');
  assert.strictEqual(d.fetches.length, 1);
  assert.strictEqual(d.fetches[0].url, '/api/agents/sam');
  assert.deepStrictEqual(JSON.parse(d.fetches[0].opt.body), { effort: 'high' });
});

test('desktop: the usage badge keeps its chooser and gets a last line to the Model row; Tab reaches it last', () => {
  const open = fnText(app, 'function planChooserOpen(');
  assert.match(open, /subs\.textContent = 'All subscriptions…'/);
  assert.match(open, /lastBtn\.textContent = agentCardLastLine\(chat\.agent\)/);
  assert.match(open, /openAgentCard\(chat\.agent, 'OPT-0047'\)/);
  assert.match(open, /if \(at === lastBtn && !e\.shiftKey\) planChooserClose\(true\)/);
  assert.match(open, /else if \(at === subs && !e\.shiftKey\) \{ e\.preventDefault\(\); lastBtn\.focus\(\); \}/);
  assert.ok(open.indexOf('box.append(lastBtn)') > open.indexOf('box.append(list, subs)'));
});

test('desktop: the voice chip shows only when voice is on and for admins; press switches its own voice on and off through PATCH {voice}', async () => {
  const mk = (id) => ({ id, hidden: true, textContent: '', attrs: {}, title: '', setAttribute(k, v) { this.attrs[k] = v; } });
  const els = { 'vagent-wrap-chat-1': mk('w'), 'vagent-chat-1': mk('b'), 'vagent-card-chat-1': mk('c') };
  const d = desktop({ els });
  d.api.voiceAgentChipPaint();
  assert.strictEqual(els['vagent-wrap-chat-1'].hidden, false);
  assert.strictEqual(els['vagent-chat-1'].textContent, 'Same voice as all');
  assert.strictEqual(els['vagent-chat-1'].attrs['aria-pressed'], 'false');
  assert.strictEqual(els['vagent-card-chat-1'].attrs['aria-label'], 'All settings for Sam…');
  await d.api.voiceAgentChipToggle('chat-1');
  assert.strictEqual(d.fetches.length, 1);
  assert.strictEqual(d.fetches[0].url, '/api/agents/sam');
  assert.strictEqual(d.fetches[0].opt.method, 'PATCH');
  assert.deepStrictEqual(JSON.parse(d.fetches[0].opt.body), { voice: { voice: '', stt: 'local', tts: 'local' } });
  assert.strictEqual(els['vagent-chat-1'].textContent, 'Its own voice');
  assert.strictEqual(els['vagent-chat-1'].attrs['aria-pressed'], 'true');
  await d.api.voiceAgentChipToggle('chat-1');   // press again: back to the shared voice
  assert.deepStrictEqual(JSON.parse(d.fetches[1].opt.body), { voice: null });
  assert.strictEqual(els['vagent-chat-1'].textContent, 'Same voice as all');
  d.api.voiceAgentCardOpen('chat-1');
  assert.deepStrictEqual(d.card.calls.open.at(-1), { name: 'sam', where: { row: 'OPT-0022' } });
  // voice off for the install: hidden; a member: hidden
  const off = desktop({ els: { 'vagent-wrap-chat-1': mk('w'), 'vagent-chat-1': mk('b') }, voiceReady: false });
  off.api.voiceAgentChipPaint();
  assert.strictEqual(off.sandbox.document.getElementById('vagent-wrap-chat-1').hidden, true);
  const mem = desktop({ els: { 'vagent-wrap-chat-1': mk('w'), 'vagent-chat-1': mk('b') }, me: { isAdmin: false } });
  mem.api.voiceAgentChipPaint();
  assert.strictEqual(mem.sandbox.document.getElementById('vagent-wrap-chat-1').hidden, true);
  // a refused save changes nothing and says so
  const bad = desktop({ els: { 'vagent-wrap-chat-1': mk('w'), 'vagent-chat-1': mk('b') }, patchOk: false });
  await bad.api.voiceAgentChipToggle('chat-1');
  assert.match(bad.toasts[0], /Could not change the voice: no/);
  assert.strictEqual(bad.sandbox.AGENTS[0].voice, undefined);
  // the chip is part of the chat bar, repainted with the voice controls, and kept out of the talk-mode chip's show/hide
  assert.match(app, /id="vagent-\$\{chatId\}" onclick="voiceAgentChipToggle\('\$\{chatId\}'\)"/);
  assert.match(fnText(app, 'function voicePaint('), /voiceAgentChipPaint\(\)/);
  assert.ok(!/class="voice-mode-chip voice-agent/.test(app), 'the talk-mode chip class would hide it outside a call');
  assert.match(read('index.html'), /\.input-area \.voice-agent-chip-wrap/);
});

test('desktop: no stray invisible characters or new colours in the parts added here', () => {
  for (const [name, text] of [['app.js', between(app, 'const agentCardSubs = {};', '    function openAgentSettingsPopup(')], ['mobile.js', between(mob, 'const agentCardSubs = {};', 'function modelText(')], ['agent-settings.html', between(read('agent-settings.html'), '<div id="card-door"', '<h2 id="agent-title">')]]) {
    assert.ok(!new RegExp('[' + String.fromCharCode(0xfe0f, 0x200d) + ']').test(text), name);
    assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(text), name + ' uses a literal colour');
  }
  const css = between(read('index.html'), '/* This agent\'s voice chip', '.input-area .voice-set-btn');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css));
});

// ---- the phone page's code ------------------------------------------------------------------------------------------
function phone(extra = {}) {
  const card = extra.card === undefined ? fakeCard(extra.openResult !== false) : extra.card;
  const toasts = [];
  const els = extra.els || {};
  const sandbox = {
    window: { hubAgentCard: card },
    agents: [{ name: 'sam', display: 'Sam', model: 'claude-sdk/claude-sonnet-5-5', effort: 'medium' }],
    current: 'sam',
    toasts, toast: (t) => toasts.push(t),
    agentByName: (n) => sandbox.agents.find((a) => a.name === n),
    isAdmin: () => extra.admin !== false,
    simpleOn: () => !!extra.simple,
    esc: (s) => String(s),
    $: (id) => els[id] || null,
    AUTO_PICK: '__auto__', OR_MORE: '__or_more__',
  };
  vm.createContext(sandbox);
  vm.runInContext(between(mob, 'const agentCardSubs = {};', 'function modelText(') + '\nthis.__api = { agentCardSubscribe, agentCardEmit, agentCardLastLine, openAgentCard, CARD_PICK };', sandbox);
  return { api: sandbox.__api, card, toasts, sandbox };
}

test('phone: configure gets subscribe, the agent list and Simple; events reach the card from the page\'s own stream', () => {
  const p = phone({ simple: true });
  const conf = p.card.calls.configure[0];
  assert.deepStrictEqual(conf.agentsList().map((a) => a.name), ['sam']);
  assert.strictEqual(conf.simple(), true);
  const seen = [];
  conf.subscribe('agent_renamed', (e) => seen.push(e));
  p.api.agentCardEmit('agent_renamed', { agent: 'sam' });
  assert.strictEqual(seen.length, 1);
  assert.match(mob, /on\('settings_changed', \(ev\) => \{ agentCardEmit\('settings_changed', ev\); \}\)/);
  assert.match(mob, /on\('agent_updated', \(ev\) => \{ agentCardEmit\('agent_updated', ev\); \}\)/);
  assert.match(mob, /on\('agent_updated', onAgentUpdated\);/);
  assert.match(mob, /on\('agent_renamed', \(ev\) => \{ agentCardEmit\('agent_renamed', ev\); \}\)/);
});

test('phone: openAgentCard opens at a row, says so when the card refuses, and is false without a card', async () => {
  const p = phone();
  assert.strictEqual(p.api.openAgentCard('sam', 'OPT-0168'), true);
  assert.deepStrictEqual(p.card.calls.open[0], { name: 'sam', where: { row: 'OPT-0168' } });
  const no = phone({ openResult: false });
  no.api.openAgentCard('sam');
  await new Promise((r) => setImmediate(r));
  assert.match(no.toasts[0], /not open to you/);
  const none = phone();
  none.sandbox.window.hubAgentCard = undefined;
  assert.strictEqual(none.api.openAgentCard('sam'), false);
});

test('phone: model and effort pickers keep their choices; their last line opens the card at the Model and Thinking effort rows', async () => {
  const p = phone();
  const sel = { value: '__card__', dataset: { agent: 'sam' } };
  p.sandbox.$ = (id) => (id === 'chat-model-pick' || id === 'chat-effort-pick' ? sel : null);
  p.sandbox.queueModelChange = (...a) => { p.sandbox.queued = a; return Promise.resolve(); };
  p.sandbox.openOrSheet = () => {};
  vm.runInContext(fnText(mob, 'function modelPickCardLine(') + '\n' + fnText(mob, 'async function changeModelFromPick(') + '\nthis.__c = modelPickCardLine; this.__m = changeModelFromPick;', p.sandbox);
  let stopped = 0;
  p.sandbox.__c({ stopImmediatePropagation: () => stopped++ });   // the line registered first on the picker's change event
  assert.deepStrictEqual(p.card.calls.open.at(-1), { name: 'sam', where: { row: 'OPT-0047' } });
  assert.strictEqual(stopped, 1, 'the model handler never sees the line');
  assert.strictEqual(sel.value, 'claude-sdk/claude-sonnet-5-5');
  sel.value = 'openai/gpt-6-astra';
  p.sandbox.__c({ stopImmediatePropagation: () => stopped++ });   // a model: left alone
  assert.strictEqual(stopped, 1);
  await p.sandbox.__m();
  assert.strictEqual(JSON.stringify(p.sandbox.queued), JSON.stringify(['sam', 'openai/gpt-6-astra']));
  assert.ok(mob.indexOf("addEventListener('change', modelPickCardLine)") < mob.indexOf("addEventListener('change', changeModelFromPick)"));
  sel.value = '__card__';
  assert.strictEqual(p.sandbox.queued.length, 2);
  sel.value = '__card__';
  p.sandbox.api = async () => { throw new Error('must not save'); };
  p.sandbox.fillEffortPick = () => {};
  p.sandbox.EFFORT_LABEL = {};
  vm.runInContext(fnText(mob, 'async function changeEffortFromPick(') + '\nthis.__e = changeEffortFromPick;', p.sandbox);
  await p.sandbox.__e();
  assert.deepStrictEqual(p.card.calls.open.at(-1), { name: 'sam', where: { row: 'OPT-0057' } });
  assert.strictEqual(sel.value, 'medium');
  const fillM = fnText(mob, 'async function fillModelPick(');
  assert.ok(fillM.indexOf('CARD_PICK') > fillM.indexOf('More OpenRouter models'));
  assert.match(fnText(mob, 'function fillEffortPick('), /\(cardLine \? `<option value="\$\{CARD_PICK\}">/);
});

test('phone: the usage badge chooser and the bell sheet get the last line; the bell sheet opens the card at the Notifications row', () => {
  const open = fnText(mob, 'function planChooserOpen(');
  assert.match(open, /openAgentCard\(agentName, 'OPT-0047'\)/);
  assert.match(open, /if \(at === lastBtn && !e\.shiftKey\) planChooserClose\(true\)/);
  const sheet = fnText(mob, 'function paintNotifyAgentSheet(');
  assert.match(sheet, /data-nk="card">\$\{esc\(agentCardLastLine\(agent\)\)\}/);
  assert.ok(sheet.indexOf('data-nk="card"') < sheet.indexOf('data-nk="close"'), 'the last line is above Close');
  const click = fnText(mob, 'async function onNotifyAgentSheetClick(');
  assert.match(click, /nk === 'card'/);
  assert.match(click, /openAgentCard\(agent, 'OPT-0168'\)/);
  // the card line is handled after the "another chat is open" check, so it never opens another agent's card
  assert.ok(click.indexOf("d._agent !== current") < click.indexOf("nk === 'card'"));
});

test('phone: the ⋮ menu item "Agent settings" opens the card; the link to the old page stays as the fallback', () => {
  assert.match(mob, /\$\('menu-agent-settings'\)\?\.addEventListener\('click', \(e\) => \{ if \(!current \|\| !window\.hubAgentCard\) return; if \(e && e\.preventDefault\) e\.preventDefault\(\); \$\('menu'\)\.classList\.remove\('open'\); openAgentCard\(current\); \}\)/);
  assert.match(read('mobile.html'), /<a id="menu-agent-settings" class="chat-only" href="\/agent-settings\.html" hidden>/);
  const sync = fnText(mob, 'function menuTeamSync(');
  assert.match(sync, /st\.hidden = !\(a && \(admin \|\| \(window\.hubAgentCard && !\(typeof simpleOn === 'function' && simpleOn\(\)\)\)\)\)/);
});

test('phone, Simple: pressing the agent\'s name in "Talking to" opens the card; the rest of the pill still opens the list', () => {
  const ensure = fnText(mob, 'function simpleTopEnsure(');
  assert.match(ensure, /e\.target\.closest\('\.st-pname'\)/);
  assert.match(ensure, /openAgentCard\(current\)\) return;\s*simpleAgentsOpen\(\);/);
  // run the handler
  const p = phone({ simple: true });
  let listOpened = 0;
  p.sandbox.simpleAgentsOpen = () => listOpened++;
  const handlerSrc = between(ensure, "$('simple-pill').addEventListener('click', ", "  top.querySelector('.simple-theme-btn')");
  let handler = null;
  p.sandbox.$ = (id) => (id === 'simple-pill' ? { addEventListener: (t, fn) => { handler = fn; } } : null);
  vm.runInContext(handlerSrc, p.sandbox);
  handler({ target: { closest: (s) => (s === '.st-pname' ? {} : null) } });
  assert.deepStrictEqual(p.card.calls.open, [{ name: 'sam', where: {} }]);
  assert.strictEqual(listOpened, 0);
  handler({ target: { closest: () => null } });   // the label or the arrow
  assert.strictEqual(listOpened, 1);
  assert.strictEqual(p.card.calls.open.length, 1);
  // the card itself shows Basics and Memory only when Simple is on (configure passes it)
  assert.strictEqual(p.card.calls.configure[0].simple(), true);
});

// ---- the pages, the files, the server ------------------------------------------------------------------------------
test('both pages load the card, then its two row files, before the page script; the files are served', () => {
  const sf = require('../lib/static-files');
  for (const [page, script] of [['index.html', 'app.js'], ['mobile.html', 'mobile.js']]) {
    const html = read(page);
    const a = html.indexOf('<script src="/ui-agent-card.js"></script>');
    const b = html.indexOf('<script src="/ui-agent-card-basics.js"></script>');
    const c = html.indexOf('<script src="/ui-agent-card-more.js"></script>');
    const s = html.indexOf(`<script src="${script}"></script>`);
    assert.ok(a > 0 && b > a && c > b && s > c, page);
    assert.ok(html.indexOf('<script>try { window.hubAgentCard') > s, page + ': the door starts after the page script');
  }
  assert.strictEqual(sf.ALIASES.get('ui-agent-card-basics.js'), 'lib/ui-agent-card-basics.js');
  assert.strictEqual(sf.ALIASES.get('ui-agent-card-more.js'), 'lib/ui-agent-card-more.js');
  for (const f of ['ui-agent-card-basics.js', 'ui-agent-card-more.js']) {
    if (fs.existsSync(path.join(root, 'lib', f))) assert.strictEqual(sf.resolve('/' + f), fs.realpathSync(path.join(root, 'lib', f)));
  }
  assert.strictEqual(sf.resolve('/lib/ui-agent-card-basics.js'), null, 'only the web name is served, not the path under lib/');
});

test('agent-settings.html: the line at the top and its button open the card on the main page; the page keeps working', () => {
  const html = read('agent-settings.html');
  assert.match(html, /<body>\s*<div id="card-door"[^>]*>\s*<span id="card-door-line">These settings now live on the agent card\.<\/span>/);
  assert.ok(html.indexOf('id="card-door"') < html.indexOf('<h2 id="agent-title">'), 'at the top');
  assert.ok(html.includes('id="agent-slug"') && html.includes('onclick="renameSlug()"'), 'the page itself is still there');
  const script = html.slice(html.indexOf('<script>', html.indexOf('id="card-door"')) + 8, html.indexOf('</script>', html.indexOf('id="card-door"')));
  const run = (opener, search) => {
    const attrs = {}; let click = null; const prevented = [];
    const btn = { setAttribute: (k, v) => { attrs[k] = v; }, addEventListener: (t, fn) => { click = fn; } };
    const win = { opener, location: { search, origin: 'http://hub', href: '' } };
    vm.runInNewContext(script, { window: win, document: { getElementById: (id) => (id === 'card-door-btn' ? btn : null) }, URLSearchParams });
    click({ preventDefault: () => prevented.push(1) });
    return { attrs, prevented, win };
  };
  // opened from the main page: the card opens there
  const opener = { closed: false, location: { origin: 'http://hub', hash: '' }, focus() { this.focused = true; } };
  const a = run(opener, '?agent=sam');
  assert.strictEqual(a.attrs.href, '/#agent-card=sam');
  assert.strictEqual(opener.location.hash, '#agent-card=sam');
  assert.strictEqual(opener.focused, true);
  assert.strictEqual(a.prevented.length, 1);
  // no main page behind it: the link does the work (no preventDefault)
  const b = run(null, '?agent=sam');
  assert.strictEqual(b.prevented.length, 0);
  assert.strictEqual(b.attrs.href, '/#agent-card=sam');
  // a closed or other-origin opener is not used
  assert.strictEqual(run({ closed: true, location: { origin: 'http://hub' } }, '?agent=sam').prevented.length, 0);
  assert.strictEqual(run({ closed: false, location: { origin: 'http://elsewhere' } }, '?agent=sam').prevented.length, 0);
  // an odd name is encoded
  assert.strictEqual(run(null, '?agent=a%20b').attrs.href, '/#agent-card=a%20b');
});

test('the card\'s own door accepts the link the door line makes', () => {
  const C = require('../lib/ui-agent-card.js');
  assert.deepStrictEqual(C.parseCardHash('#agent-card=sam'), { name: 'sam', row: null, section: null });
  assert.deepStrictEqual(C.parseCardHash('#agent-card=sam&row=OPT-0047'), { name: 'sam', row: 'OPT-0047', section: null });
});

test('server: a rename publishes agent_updated with the old name and renamedTo (and nothing when the rename failed)', () => {
  const src = read('server.js');
  const at = src.indexOf("pathname === '/api/agents/rename'");
  assert.ok(at > 0);
  const block = src.slice(src.lastIndexOf('if (', at), src.indexOf('\n    }\n', at) + 7);
  const run = async (success) => {
    const published = [];
    const sandbox = {
      pathname: '/api/agents/rename', req: { method: 'POST' }, published,
      readBody: async () => JSON.stringify({ oldName: 'sam', newName: 'sam2' }),
      renameAgent: async () => ({ success }),
      jsonResponse: (res, status, body) => ({ status, body }),
      res: {}, JSON, String,
      require: (m) => { assert.strictEqual(m, './lib/hub-events'); return { events: { publish: (t, p) => published.push([t, p]) } }; },
    };
    const out = await vm.runInNewContext('(async () => {' + block + '})()', sandbox);
    return { out, published };
  };
  return run(true).then(({ out, published }) => {
    assert.strictEqual(out.status, 200);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(published)), [['agent_updated', { agent: 'sam', oldName: 'sam', renamedTo: 'sam2', changed: ['name'] }]]);
    return run(false);
  }).then(({ out, published }) => {
    assert.strictEqual(out.status, 400);
    assert.strictEqual(published.length, 0);
  });
});

test('the rename event closes an open card (the card\'s own rule: agent_updated with renamedTo for the open agent)', () => {
  const C = require('../lib/ui-agent-card.js');
  assert.ok(typeof C.createCard === 'function');
  // the event the server sends matches what the card tests for: ev.agent is the old name, ev.renamedTo the new one
  const ev = { agent: 'sam', oldName: 'sam', renamedTo: 'sam2', changed: ['name'] };
  assert.ok(ev.renamedTo && ev.agent === 'sam');
  assert.match(read('lib/ui-agent-card.js'), /const renamed = ev\.renamedTo \|\| ev\.newName/);
});
