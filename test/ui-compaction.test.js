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
const settings = read('agent-settings.html');
const sw = read('sw.js');

test('agent settings: a Context compression section after Records with mode, threshold, status lines and the buttons', () => {
  assert.ok(settings.includes('<div class="section" id="compaction-section">'), 'section present');
  assert.ok(settings.indexOf('id="compaction-section"') > settings.indexOf('id="records-section"'), 'after the Records section');
  assert.ok(settings.includes('the agent writes its own carry-forward') && settings.includes('the provider never summarises'), 'plain-language intro');
  assert.ok(settings.includes('Dry run = the brief only') && settings.includes('fresh session seeded from Records + recent turns + recall'), 'dry run vs on explained');
  for (const id of ['compaction-mode', 'compaction-at', 'compaction-now', 'compaction-last', 'compaction-running', 'compaction-run-btn', 'compaction-brief-btn', 'compaction-status']) {
    assert.ok(settings.includes(`id="${id}"`), `part ${id}`);
  }
  assert.ok(settings.includes('<option value="off">Off</option>') && settings.includes('<option value="dry">Dry run (brief only)</option>') && settings.includes('<option value="on">On (brief, then fresh session)</option>'), 'off, dry, on');
  assert.ok(settings.includes('<option value="assisted">Assisted (small / local models: the hub feeds the transcript in slices sized to the window; the agent extracts into its Records from each slice, then writes the brief on a fixed template; then a fresh start)</option>'), 'the 4th mode, assisted');
  assert.ok(settings.includes("const COMPACTION_MODES = { off: 'off', dry: 'dry run', on: 'on', assisted: 'assisted' };"), 'assisted is a known mode (select keeps it, labels name it)');
  assert.ok(settings.includes('id="compaction-local-hint"') && settings.includes('Local model: assisted mode at 60% is the default.'), 'local hint');
  assert.ok(settings.includes("document.getElementById('compaction-local-hint').style.display = d.local ? '' : 'none';"), 'shown when GET says local: true');
  assert.ok(settings.includes("`${agentName} gets its transcript in slices sized to its window"), 'the Compress now confirm explains assisted');
  for (const v of ['0.5', '0.55', '0.6', '0.65', '0.7', '0.75', '0.8', '0.85', '0.9']) {
    assert.ok(settings.includes(`<option value="${v}">${Math.round(Number(v) * 100)}% of context window</option>`), `threshold ${v}`);
  }
  assert.ok(settings.includes('onclick="saveCompaction()"') && settings.includes('onclick="compressNow()"') && settings.includes('onclick="openBrief()"'), 'Save, Compress now, Done-read-the-brief');
  assert.ok(settings.includes('`Context now: ${pct}% (${tokens.toLocaleString()} of ${limit.toLocaleString()} tokens)${d.model ? ` · ${d.model}` : \'\'}`'), 'Context now line, with the model when GET reports it');
  assert.match(settings, /document\.getElementById\('compaction-now'\)\.textContent = limit\s*\n\s*\? `Context now:/, 'rendered whenever limit > 0');
  assert.ok(settings.includes("let last = 'Last compression: never';") && settings.includes("${d.lastReset ? ', session reset' : ''}"), 'Last compression line, never / session reset');
  assert.ok(settings.includes("document.getElementById('compaction-running').style.display = running ? '' : 'none';") && settings.includes("document.getElementById('compaction-run-btn').disabled = running;"), 'running indicator, button disabled while running');
  assert.match(settings, /loadRecords\(\);\s*\n\s*loadCompaction\(\);/, 'loaded at init');
});

test('agent settings: GET, PUT { mode, at } and POST run on /api/agents/<name>/compaction; polls every 5 s; the brief opens in the Records editor', () => {
  assert.ok(settings.includes('const compactionUrl = () => `/api/agents/${encodeURIComponent(agentName)}/compaction`;'), 'route');
  assert.ok(settings.includes('data = await apiFetch(compactionUrl());'), 'GET');
  assert.ok(settings.includes("data = await apiFetch(compactionUrl(), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, at }) });"), 'PUT { mode, at }');
  assert.ok(settings.includes("if (!data || !data.success)"), 'PUT answers { success }');
  // contextWindow: a number input, read from the agent record, saved by PATCH /api/agents/<name> { contextWindow } with the same Save.
  assert.ok(settings.includes('<input type="number" id="compaction-window"'), 'Context window (tokens) input');
  assert.ok(settings.includes('<label for="compaction-window" style="font-size:12px;">Context window (tokens)</label>'), 'labelled');
  assert.ok(settings.includes("Leave blank to detect (LM Studio reports the loaded model's window; cloud models use a table)"), 'hint');
  assert.ok(settings.includes("const agentData = await apiFetch('/api/agents');") && settings.includes('const cw = agent && agent.contextWindow;'), 'loaded from GET /api/agents');
  assert.ok(settings.includes("const contextWindow = raw ? Math.round(Number(raw)) : null;"), 'blank -> null (detect)');
  assert.ok(settings.includes("r = await apiFetch(`/api/agents/${encodeURIComponent(agentName)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contextWindow }) });"), 'PATCH { contextWindow }');
  assert.ok(settings.indexOf("body: JSON.stringify({ mode, at })") < settings.indexOf("body: JSON.stringify({ contextWindow })"), 'Save = PUT compaction, then PATCH agent');
  assert.ok(settings.includes('if (contextWindow !== (compactionState.contextWindow || null)) {'), 'PATCH only when the window changed');
  assert.match(settings, /loadCompaction\(\);\s*\n\s*loadContextWindow\(\);/, 'both loaded at init');
  assert.ok(settings.includes("data = await apiFetch(`${compactionUrl()}/run`, { method: 'POST'"), 'POST run');
  assert.match(settings, /if \(!confirm\(`Compress now\?[\s\S]*?\/run`, \{ method: 'POST'/, 'confirm before the POST');
  assert.ok(settings.includes("`${agentName} will write its working brief (working-brief.md), then its session is reset") && settings.includes('the session goes on unchanged (dry run)'), 'the confirm says what the current mode does');
  assert.ok(settings.includes('}, 5000);') && settings.includes('if (d.running || d.requested) return;'), 'polls GET every 5 s until running is false');
  assert.ok(settings.includes("compactionStatus('success', d.lastReset ? '✅ Done: brief written, fresh session started' : '✅ Done, read the brief');"), 'Done, read the brief');
  assert.ok(settings.includes("document.getElementById('compaction-brief-btn').style.display = '';"), 'the brief button appears when done');
  assert.ok(settings.includes("const name = compactionState.briefFile || 'working-brief.md';") && settings.includes('const i = recordsState.records.findIndex(r => r.name === name);') && settings.includes('await openRecord(i);'), 'openBrief opens working-brief.md in the Records editor');
});

test('desktop: a context line under each solo chat toolbar from the first reading on, fetched on open and after turn_end', () => {
  assert.ok(app.includes('<div class="compaction-line" id="compaction-line-${chatId}" style="display:none"'), 'line element per chat');
  assert.ok(app.indexOf('id="compaction-line-${chatId}"') > app.indexOf('id="recall-btn-${chatId}"') && app.indexOf('id="compaction-line-${chatId}"') < app.indexOf('<div class="messages" id="messages-${chatId}"></div>'), 'between the toolbar and the messages');
  assert.ok(app.includes('filesApi(`/api/agents/${encodeURIComponent(chat.agent)}/compaction`)'), 'GET compaction');
  assert.match(app, /renderSoloChatPanel\(chatId\);\s*\n\s*switchToChat\(chatId\);[\s\S]{0,200}compactionRefresh\(chatId\);/, 'fetched once when a chat opens');
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
  assert.ok(sw.includes("const VERSION = 'hub-mobile-v46';"));
});
