'use strict';
// Source-level checks for the browser side of agent-authored context compression: the
// "Context compression" section on the agent settings page (GET/PUT /api/agents/<name>/compaction,
// POST .../compaction/run), the context line and compaction_start / compaction_end notices in
// desktop chats, and the mobile "Compress now" menu item. Offline: the pages are read as text.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html');
const app = read('app.js');
const mhtml = read('mobile.html');
const mjs = read('mobile.js');
const sw = read('sw.js');

// removed (P4-2): the two 'agent settings: ... Context compression' tests pinned the old page's compaction section (mode and threshold selects, status lines, Save /
// Compress now / Done-read-the-brief, the context-window input, GET / PUT / POST run on /api/agents/<name>/compaction, the 5 s poll). The card's Memory rows
// (OPT-0040 mode, 0041 threshold, 0042 window, 0043 / 0044 status lines, 0833 Compress now) are tested in test/ui-agent-card.test.js and ui-agent-card-more.test.js.
// Not on the card (no test to port): the "assisted" mode's long label, the local-model hint, the 5 s poll with its "Done, read the brief" button.

test('desktop: a context line under each solo chat toolbar from the first reading on, fetched on open and after turn_end', () => {
  assert.ok(app.includes('<div class="compaction-line" id="compaction-line-${chatId}" style="display:none"'), 'line element per chat');
  assert.ok(app.indexOf('id="compaction-line-${chatId}"') > app.indexOf('id="recall-btn-${chatId}"') && app.indexOf('id="compaction-line-${chatId}"') < app.indexOf('<div class="messages" id="messages-${chatId}"></div>'), 'between the toolbar and the messages');
  assert.ok(app.includes('filesApi(`/api/agents/${encodeURIComponent(chat.agent)}/compaction`)'), 'GET compaction');
  assert.match(app, /renderSoloChatPanel\(chatId\);[\s\S]{0,260}compactionRefresh\(chatId\);/, 'fetched once when a chat opens (on screen or in the background)');
  assert.match(app, /function onHubTurnEnd\(ev\) \{[\s\S]{0,400}setTimeout\(\(\) => compactionRefresh\(c\.id\), 3500\);/, 'and after turn_end for that agent, once the hub has recorded the size');
  assert.ok(app.includes("if (!d || (!pct && !tokens)) { el.style.display = 'none'; el.textContent = ''; return; }"), 'hidden only until the first reading (no 50% floor)');
  assert.ok(app.includes('el.textContent = `context ${pct}%${size}${mode}${d.running ? \' · writing the brief…\' : \'\'}`;'), 'status line "context 14% · 141K of 1M tokens · compression: on at 90%"');
  assert.ok(app.includes("const mode = !d.mode ? '' : d.mode === 'off' ? ' · compression: off' : ` · compression: ${compactionModeLabel(d.mode)} at ${at}%`;"), 'mode and threshold');
  assert.match(app, /function updateContextHealth\(chatId, data\) \{[\s\S]{0,800}renderCompactionLine\(chatId, chat\.compaction\);/, 'live context_health readings move the line during a turn');
  assert.ok(html.includes('.compaction-line {') && html.includes('.compaction-line.hot'), 'styled');
});

test('phone: the chat header shows "N% context" from the compaction GET and the stream\'s live readings', () => {
  const mhtml = read('mobile.html');
  const mjs = read('mobile.js');
  assert.ok(mhtml.includes('<span class="sub" id="chat-ctx" hidden></span>') && mhtml.includes('#chat-ctx.hot'), 'header element + style');
  assert.ok(mjs.includes('el.textContent = `${pct}% context`;'), 'label');
  assert.match(mjs, /fillModelPick\(\); fillEffortPick\(\);\s*\n\s*paintCtx\(\); refreshCtx\(name\);/, 'on open');
  assert.match(mjs, /function onTurnEnd\(ev\) \{[\s\S]{0,400}setTimeout\(\(\) => refreshCtx\(ev\.agent\), 3500\);/, 'after each turn, once the hub has recorded the size');
  assert.ok(mjs.includes("case 'context_health': noteCtxReading(rec.agent, g); break;"), 'live during the reply');
});

test('desktop: compaction_start / compaction_end on the hub EventSource become system notices in that agent\'s chat', () => {
  assert.ok(app.includes("source.addEventListener('compaction_start', e => { const ev = parse(e); if (ev) onCompactionStart(ev); });"), 'compaction_start');
  assert.ok(app.includes("source.addEventListener('compaction_end', e => { const ev = parse(e); if (ev) onCompactionEnd(ev); });"), 'compaction_end');
  assert.ok(app.includes("appendSystemNotice(chat.id, `⚙ ${who} is writing its working brief (${compactionModeLabel(ev.mode)})…`, 'working');"), 'start notice');
  assert.ok(app.includes("else appendSystemNotice(chat.id, ev.reset ? '✓ brief written, fresh session started' : '✓ brief written', 'complete');"), 'end notice, with reset');
  assert.ok(app.includes("appendSystemNotice(chat.id, `⚠ compression failed: ${ev.error || 'unknown error'}`, 'failed');"), 'failure notice');
  assert.match(app, /function onCompactionStart\(ev\) \{\s*\n\s*const chat = findSoloChat\(ev\.agent\);/, 'routed to that agent\'s open chat');
  // compaction_progress { agent, part, parts }: the same notice line is updated, not five appended.
  assert.ok(app.includes("source.addEventListener('compaction_progress', e => { const ev = parse(e); if (ev) onCompactionProgress(ev); });"), 'compaction_progress');
  assert.ok(app.includes('const text = `⚙ ${who} is extracting slice ${ev.part} of ${ev.parts}…`;'), 'progress text');
  assert.ok(app.includes('chat.compactionNotice = appendSystemNotice(chat.id, `⚙ ${who} is writing its working brief'), 'the start notice is kept');
  assert.ok(app.includes('if (chat.compactionNotice && chat.compactionNotice.isConnected) chat.compactionNotice.textContent = text;'), 'updated in place');
  assert.ok(app.includes("const COMPACTION_MODE_LABEL = { off: 'off', dry: 'dry run', on: 'on', assisted: 'assisted' };"), 'assisted labelled');
});

test('mobile: the same notices in the open chat, and a chat-only Compress now menu item that confirms and POSTs run', () => {
  assert.ok(mhtml.includes('<button id="menu-compact" class="chat-only">&#x2699; Compress now</button>'), 'menu item, chat only');
  assert.ok(mjs.includes("$('menu-compact').addEventListener('click', compressNow);"), 'wired');
  assert.ok(mjs.includes("on('compaction_start', onCompactionStart);") && mjs.includes("on('compaction_end', onCompactionEnd);"), 'the two events');
  assert.ok(mjs.includes('if (!ev || !chatOpenFor(ev.agent)) return;'), 'only the open chat');
  assert.ok(mjs.includes('addNote(`⚙ ${displayName(ev.agent)} is writing its working brief (${compactionModeLabel(ev.mode)})…`);'), 'start note');
  assert.ok(mjs.includes("else addNote(ev.reset ? '✓ brief written, fresh session started' : '✓ brief written');"), 'end note');
  assert.ok(mjs.includes("addNote(`⚠ compression failed: ${ev.error || 'unknown error'}`);"), 'failure note');
  assert.ok(mjs.includes("on('compaction_progress', onCompactionProgress);"), 'compaction_progress');
  assert.ok(mjs.includes('const text = `⚙ ${displayName(ev.agent)} is extracting slice ${ev.part} of ${ev.parts}…`;'), 'progress text');
  assert.ok(mjs.includes('if (compactionNote && compactionNote.isConnected && compactionNote.dataset.agent === ev.agent) compactionNote.textContent = text;'), 'the same note line updated in place');
  assert.ok(mjs.includes("const COMPACTION_MODE_LABEL = { off: 'off', dry: 'dry run', on: 'on', assisted: 'assisted' };"), 'assisted labelled');
  assert.ok(mjs.includes("if (!current) { toast('Open an agent\\'s chat first'); return; }"), 'needs an open chat');
  assert.match(mjs, /if \(!confirm\(`Compress now\?[\s\S]*?api\(`\/api\/agents\/\$\{encodeURIComponent\(agent\)\}\/compaction\/run`, \{ method: 'POST'/, 'confirm, then POST run through api() so a 401 goes to login');
  assert.ok(mjs.includes('api(`/api/agents/${encodeURIComponent(agent)}/compaction`)'), 'reads the mode first so the confirm says what will happen');
});

test('service worker cache bumped to v18', () => {
  assert.ok(sw.includes("const VERSION = 'hub-mobile-v107';"));
});
