'use strict';
// Source-level checks for Recall (transcript search in every chat: desktop docked panel and mobile
// sheet, server routes /api/recall and /api/recall/context) and for the Records section of the
// agent settings page (/api/agents/<name>/records). Offline: the pages are read as text, not run.
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

test('desktop: a Recall button in every chat toolbar opens a docked Recall panel for that chat\'s agent', () => {
  assert.match(app, /<button onclick="saveChat\('\$\{chatId\}'\)">💾 Save<\/button>\s*\n\s*<button onclick="openRecallPanel\('\$\{chatId\}'\)" id="recall-btn-\$\{chatId\}"[^>]*>🔎 Recall<\/button>/, 'button after Save, per chat');
  assert.ok(app.includes('function openRecallPanel(chatId)'), 'opener');
  assert.ok(app.includes("const agent = chat && !chat.isGroup && chat.agent ? String(chat.agent) : '';"), 'agent = that chat\'s agent (solo chats)');
  assert.ok(app.includes('gsModal(`<div id="recall-panel">') && app.includes("const dock = { dock: true, title: `🔎 Recall · ${esc(chat.display || capName(agent))}` };"), 'docked like the Files panel');
  for (const id of ['recall-q', 'recall-from', 'recall-to', 'recall-archive', 'recall-status', 'recall-list']) {
    assert.ok(app.includes(`id="${id}"`), `panel part ${id}`);
  }
  assert.ok(app.includes("[['user', 'user'], ['assistant', 'assistant'], ['tool_result', 'tool results'], ['tool_use', 'tool calls']]"), 'the four kind checkboxes');
  assert.ok(app.includes('class="recall-kind-box"'), 'kind checkboxes');
  assert.ok(app.includes("q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recallSearch(); } });"), 'Enter searches');
  assert.ok(html.includes('#recall-panel {') && html.includes('#recall-panel mark') && html.includes('#recall-panel .recall-row.hit'), 'panel, mark and hit row styled');
  const m = app.match(/function applyMemberView\(\) \{[\s\S]*?\n\s*\}\n/);
  assert.ok(m && !m[0].includes('recall'), 'members keep the Recall button (their own agent\'s history)');
  assert.match(app, /if \(document\.getElementById\('recall-panel'\)[^\n]*openRecallPanel\(chatId\);/, 'an open panel follows the active chat tab');
});

test('desktop: search hits GET /api/recall with agent, q, from/to, kinds and limit; context hits GET /api/recall/context', () => {
  assert.ok(app.includes("const params = new URLSearchParams({ agent: recallState.agent, q, kinds: kinds.join(','), limit: '30' });"), 'agent, q, kinds, limit');
  assert.ok(app.includes("if (from) params.set('from', new Date(from + 'T00:00:00').toISOString());") && app.includes("if (to) params.set('to', new Date(to + 'T23:59:59.999').toISOString());"), 'optional from/to as ISO');
  assert.ok(app.includes('filesApi(`/api/recall?${params.toString()}`)'), 'GET /api/recall (credentials via filesApi)');
  assert.ok(app.includes('filesApi(`/api/recall?agent=${encodeURIComponent(recallState.agent)}&q=&limit=1`)'), 'stats fetched on open');
  assert.ok(app.includes('filesApi(`/api/recall/context?agent=${encodeURIComponent(recallState.agent)}&id=${encodeURIComponent(h.id)}&before=6&after=6`)'), 'GET /api/recall/context?agent&id&before=6&after=6');
  assert.ok(app.includes("credentials: 'include'"), 'cookies carry the session');
  assert.ok(app.includes('`Archive: ${s.entries} entries from ${recallFmtDate(s.first)} to ${recallFmtDate(s.last)}`'), 'archive line from stats');
  assert.ok(app.includes('`No entries match "${recallState.q}".`') && app.includes("Type a few words and press Enter to search this agent's history."), 'empty states');
  assert.ok(app.includes("recallStatus(`Search failed: ${e.message}`, 'error');"), 'failures shown');
});

test('desktop: [bracketed] matches render as <mark> after escaping; Show context expands rows inline with the hit highlighted', () => {
  assert.ok(app.includes("return esc(snippet || '').replace(/\\[([^\\[\\]\\n]+)\\]/g, '<mark>$1</mark>');"), 'escape first, then brackets -> <mark>');
  assert.ok(app.includes('${recallSnippetHtml(h.snippet || h.text || \'\')}'), 'snippet rendered through it');
  assert.ok(app.includes('<a class="recall-ctx-link" onclick="recallShowContext(${i})">Show context</a>'), 'per-hit link');
  assert.ok(app.includes('<div class="recall-ctx" id="recall-ctx-${i}" style="display:none"></div>'), 'inline box');
  assert.ok(app.includes('async function recallShowContext(i)'));
  assert.ok(app.includes("`<div class=\"recall-row${r.hit ? ' hit' : ''}\">"), 'hit row highlighted');
  assert.ok(app.includes("if (box.style.display !== 'none') { box.style.display = 'none'; if (link) link.textContent = 'Show context'; return; }"), 'second click folds');
  assert.ok(app.includes('${esc(recallFmtTime(h.ts))}') && app.includes('${esc(recallKindLabel(h.kind, h.tool))}') && app.includes('${esc(r.text || \'\')}'), 'time, kind + tool and text are escaped');
});

test('mobile: a chat-only Recall menu item opens a Recall sheet; tap a hit for its context', () => {
  assert.ok(mhtml.includes('<button id="menu-recall" class="chat-only">&#x1F50E; Recall</button>'), 'menu item, chat only');
  assert.ok(mhtml.includes('<dialog id="recall-sheet"></dialog>'), 'sheet element');
  assert.ok(mhtml.includes('#recall-sheet {') && mhtml.includes('#recall-sheet mark') && mhtml.includes('#recall-sheet .rc-row.hit'), 'sheet, mark and hit row styled');
  assert.ok(mjs.includes("$('menu-recall').addEventListener('click', openRecallSheet);"), 'wired');
  assert.ok(mjs.includes('function openRecallSheet()'));
  assert.match(mjs, /function openRecallSheet\(\) \{[\s\S]*?if \(!sheet\.open\) sheet\.showModal\(\);/, 'opened like the Files sheet');
  assert.ok(mjs.includes("if (!current) { toast('Open an agent\\'s chat first'); return; }"), 'rooted on the open agent (current)');
  assert.ok(mjs.includes('if (current !== recallState.agent) { recallState.agent = current;'), 'a different agent starts fresh');
  for (const id of ['rc-q', 'rc-go', 'rc-kinds', 'rc-archive', 'rc-msg', 'rc-list', 'rc-close']) assert.ok(mjs.includes(`id="${id}"`), `sheet part ${id}`);
  assert.ok(mjs.includes("$('rc-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recallSearch(); } });"), 'Enter searches');
  assert.ok(mjs.includes("const params = new URLSearchParams({ agent: recallState.agent, q, kinds: kinds.join(','), limit: '30' });") && mjs.includes('recallApi(`/api/recall?${params.toString()}`)'), 'GET /api/recall');
  assert.ok(mjs.includes('recallApi(`/api/recall/context?agent=${encodeURIComponent(recallState.agent)}&id=${encodeURIComponent(h.id)}&before=6&after=6`)'), 'GET /api/recall/context');
  assert.ok(mjs.includes("let r; try { r = await api(path); }"), 'through api() so a 401 goes to login');
  assert.ok(mjs.includes("function recallSnippetHtml(snippet) { return esc(snippet || '').replace(/\\[([^\\[\\]\\n]+)\\]/g, '<mark>$1</mark>'); }"), 'escape then brackets -> <mark>');
  assert.ok(mjs.includes("const head = e.target.closest('button.rc-head');") && mjs.includes('recallToggleContext(Number(head.dataset.i))'), 'tap a hit');
  assert.ok(mjs.includes("`<div class=\"rc-row${r.hit ? ' hit' : ''}\">"), 'hit row highlighted');
  assert.ok(mjs.includes('`Archive: ${s.entries} entries from ${recallFmtDate(s.first)} to ${recallFmtDate(s.last)}`'), 'archive line');
});

test('agent settings: a Records section after Tool policy lists, edits, creates and deletes records over /api/agents/<name>/records', () => {
  assert.ok(settings.includes('<div class="section" id="records-section">'), 'section present');
  assert.ok(settings.indexOf('id="records-section"') > settings.indexOf('id="policy-section"'), 'after the Tool policy section');
  assert.ok(settings.includes('Records are loaded in full into this agent\'s context on every turn'), 'one-line explanation');
  assert.ok(settings.includes('id="records-cap"') && settings.includes("document.getElementById('records-cap').textContent = recordsState.maxBytes ? humanBytes(recordsState.maxBytes) : 'not set';"), 'cap shown from maxBytes');
  for (const id of ['records-total', 'records-list', 'records-editor', 'records-content', 'records-status']) assert.ok(settings.includes(`id="${id}"`), `part ${id}`);
  assert.ok(settings.includes('const recordsBase = () => `/api/agents/${encodeURIComponent(agentName)}/records`;'), 'list route');
  assert.ok(settings.includes('const recordUrl = (name) => `${recordsBase()}/${encodeURIComponent(name)}`;'), 'file route');
  assert.ok(settings.includes('data = await apiFetch(recordsBase());'), 'GET list');
  assert.ok(settings.includes('data = await apiFetch(recordUrl(r.name));'), 'GET one file on click');
  assert.ok(settings.includes("data = await apiFetch(recordUrl(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });"), 'PUT { content } on Save');
  assert.ok(settings.includes("data = await apiFetch(recordUrl(name), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '' }) });"), 'New record: PUT with empty content');
  assert.ok(settings.includes("prompt('Name for the new record (a file name, e.g. clients.md):', '')"), 'New record asks for a name');
  assert.match(settings, /if \(!confirm\(`Delete the record "\$\{name\}"\?[^`]*`\)\) return;[\s\S]*?method: 'DELETE'/, 'Delete confirms first');
  assert.ok(settings.includes('onclick="newRecord()"') && settings.includes('onclick="saveRecord()"') && settings.includes('onclick="deleteRecord()"'), 'buttons');
  assert.ok(settings.includes("const link = r.symlink ? `<div style=\"font-size:11px;color:#777;\">link → ${escapeHtml(r.target || '?')}</div>` : '';"), 'symlinks show link → target');
  assert.ok(settings.includes('${humanBytes(r.bytes)}') && settings.includes("when && !isNaN(when) ? escapeHtml(when.toLocaleString()) : ''"), 'size and updated time');
  assert.ok(settings.includes('const over = recordsState.maxBytes && total > recordsState.maxBytes;') && settings.includes("totalEl.style.color = over ? '#e74c3c' : '#888';"), 'total vs cap, red when over');
  assert.ok(settings.includes("if (!data || !data.ok)"), 'checks { ok } (not success)');
  assert.match(settings, /loadPolicy\(\);\s*\n\s*loadRecords\(\);/, 'loaded at init');
});

test('service worker cache bumped to v18', () => {
  assert.ok(sw.includes("const VERSION = 'hub-mobile-v56';"));
});
