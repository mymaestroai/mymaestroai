'use strict';
// Source-level checks for the Files feature (upload / download / browse) in the desktop app
// (index.html + app.js) and the mobile app (mobile.html + mobile.js + sw.js). Offline.
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

test('desktop: a Files header button before the scheduler opens a docked Files panel', () => {
  assert.ok(html.includes('id="files-btn"'), 'files-btn in the header');
  assert.ok(html.indexOf('id="files-btn"') < html.indexOf('id="schedule-btn"'), 'placed before #schedule-btn');
  assert.match(html, /id="files-btn" class="header-btn"[^>]*onclick="openFilesPanel\(\)"/);
  assert.ok(app.includes('<div id="files-panel">'), 'the panel wrapper');
  assert.ok(app.includes("const dock = { dock: true, title: '📁 Files' };") && app.includes('gsModal(`<div id="files-panel">'), 'docked like the other panels');
  for (const id of ['files-root', 'files-crumbs', 'files-list', 'files-drop', 'files-upload-input', 'files-status', 'files-progress']) {
    assert.ok(app.includes(`id="${id}"`), `panel part ${id}`);
  }
  assert.ok(html.includes('#files-panel .files-drop.over'), 'drag-over highlight styled');
});

test('desktop: talks to every /api/files route with the owner and agent query the server expects', () => {
  assert.ok(app.includes("return `/api/files${route}?${filesOwnerParam()}${filesAgentParam(agent)}${q}`"), 'list/upload/download/delete share one URL builder that carries owner= and agent=');
  assert.ok(app.includes("function filesAgentParam(agent) { return agent ? 'agent=' + encodeURIComponent(agent) + '&' : ''; }"), 'agent= sent when a chat is open, omitted otherwise');
  assert.ok(app.includes("filesApi(filesUrl('', { path: filesState.path }))"), 'GET /api/files list');
  assert.ok(app.includes("filesUrl('/upload'") && app.includes("xhr.open('POST', filesUrl('/upload', { path: dir, name: file.name, overwrite: overwrite ? '1' : '' }, agent))"), 'POST /api/files/upload with agent=');
  assert.ok(app.includes("filesUrl('/download', { path: filesJoin(filesState.path, e.name) })"), 'GET /api/files/download (agent= via the builder default)');
  assert.ok(app.includes("filesApi(filesUrl('', { path: filesJoin(filesState.path, e.name) }), { method: 'DELETE' })"), 'DELETE /api/files');
  assert.ok(app.includes("const body = filesState.agent ? { agent: filesState.agent } : {};"), 'JSON bodies carry agent');
  assert.ok(app.includes("filesApi('/api/files/mkdir', { json: { ...filesOwnerBody(), path: filesState.path, name: n } })"), 'POST /api/files/mkdir { owner, agent, path, name }');
  assert.ok(app.includes("filesApi('/api/files/rename', { json: { ...filesOwnerBody(), path: filesJoin(filesState.path, e.name), newName: n } })"), 'POST /api/files/rename { owner, agent, path, newName }');
  assert.ok(app.includes("xhr.setRequestHeader('Content-Type', 'application/octet-stream')"), 'raw bytes upload');
  assert.ok(app.includes('xhr.upload.onprogress'), 'upload progress');
  assert.ok(app.includes("if (!me || !me.isAdmin) return '';") && app.includes("v === 'infra' ? 'mine' : v"), 'members omit owner; admins pass the owner view with infra mapped to mine');
  assert.ok(app.includes("credentials: 'include'") && app.includes('xhr.withCredentials = true'), 'cookies carry the session');
  assert.match(app, /if \(!confirm\(msg\)\) return;[\s\S]*?method: 'DELETE'/, 'delete asks first');
  assert.ok(app.includes("drop.addEventListener('drop'") && app.includes('filesUploadFiles(e.dataTransfer.files)'), 'drag-and-drop uploads into the current folder');
  assert.ok(app.includes('function humanSize('), 'human-readable sizes');
  assert.ok(app.includes('No files yet. Drop files here or use Upload.'), 'empty state');
});

test('desktop: the panel is per agent: it follows the active chat tab and titles itself with root.label', () => {
  assert.ok(app.includes("return c && !c.isGroup && c.agent ? String(c.agent) : '';"), 'agent = the active chat tab\'s agent (solo chats)');
  assert.ok(app.includes("if (agent !== filesState.agent) { filesState.agent = agent; filesState.path = ''; }"), 'a new agent starts at the top of its own root');
  assert.match(app, /window\.__activeChatId = chatId;\s*\n\s*if \(document\.getElementById\('files-panel'\)\) filesRefresh\(\);/, 'switching chat tabs re-fetches the open panel');
  assert.match(app, /window\.__activeChatId = null;[\s\S]{0,200}if \(document\.getElementById\('files-panel'\)\) filesRefresh\(\);/, 'closing the last chat drops back to the general folder');
  assert.ok(app.includes("h3.textContent = `📁 ${root.label || 'Files'}${filesState.agent ? '' : ' (no chat open)'}`"), 'title is root.label, marked when no chat is open');
  assert.ok(app.includes("const agent = chats[chatId] && !chats[chatId].isGroup && chats[chatId].agent ? String(chats[chatId].agent) : '';"), 'paperclip uploads go to that chat\'s agent');
  assert.ok(app.includes("uploadFileToHub(file, '', { agent, onProgress"), 'paperclip passes agent=');
});

test('desktop: Use in chat inserts the server path into the active chat, or copies it with no chat open', () => {
  assert.ok(app.includes('const chatId = window.__activeChatId;'));
  assert.ok(app.includes('document.getElementById(`input-${chatId}`)'));
  assert.ok(app.includes('`[file: ${absPath}]`'), 'inserted as [file: <absPath>]');
  assert.ok(app.includes('No chat is open, so the path was copied instead'), 'clipboard fallback with a message');
  assert.ok(app.includes("if (document.getElementById('files-panel')) openFilesPanel('');"), 'owner switcher change re-fetches the list');
});

test('desktop: the paperclip accepts any file; non-images are uploaded and their path appended to the message', () => {
  assert.ok(!app.includes('accept="image/*"'), 'per-chat file inputs no longer image-only');
  assert.match(app, /id="file-input-\$\{chatId\}" multiple style="display:none" onchange="handleFileSelect\(event, '\$\{chatId\}'\)"/);
  assert.match(app, /function handleFileSelect\(event, chatId\) \{[\s\S]*?addImageToChat\(chatId, file\);[\s\S]*?uploadFileForChat\(chatId, file\);/, 'images unchanged, other files uploaded');
  assert.ok(app.includes("uploadFileToHub(file, '', { agent, onProgress"), 'chat uploads land in the root of the agent folder');
  assert.ok(app.includes('`[file: ${abs}] `'), 'path appended to the chat textarea');
  assert.ok(app.includes('alert(`Could not upload ${file.name}: ${e.message}`)'), 'failure is shown');
  assert.ok(app.includes("el.className = 'chat-file-status'") && app.includes('chatFileStatus(chatId, `Uploading ${file.name}…`)'), 'small status while uploading');
});

test('desktop: member view does not hide the Files button', () => {
  const m = app.match(/function applyMemberView\(\) \{[\s\S]*?\n\s*\}\n/);
  assert.ok(m, 'applyMemberView found');
  assert.ok(!m[0].includes('files-btn'), 'files-btn stays visible for members');
});

test('mobile: a Files menu item for everyone opens a Files sheet with the same actions', () => {
  assert.ok(mhtml.includes('<button id="menu-files">'), 'menu item present and not hidden');
  assert.ok(!/id="menu-files"[^>]*hidden/.test(mhtml));
  assert.ok(mhtml.includes('<dialog id="files-sheet"></dialog>'));
  assert.ok(mhtml.includes('<input type="file" id="files-upload-input" multiple hidden>'));
  assert.ok(mjs.includes("$('menu-files').addEventListener('click', openFilesSheet);"));
  assert.ok(mjs.includes("if (!sheet.open) sheet.showModal();"), 'sheet opened like the Security sheet');
  assert.ok(mjs.includes("if (agent) q.set('agent', agent);") && mjs.includes("function filesUrl(route, params, agent = filesState.agent)"), 'list/upload/download/delete URLs carry agent=');
  assert.ok(mjs.includes("filesApi(filesUrl('', { path: filesState.path }))"), 'GET /api/files list');
  assert.ok(mjs.includes("xhr.open('POST', filesUrl('/upload', { path: dir, name: file.name, overwrite: overwrite ? '1' : '' }, agent))"), '/api/files/upload with agent=');
  assert.ok(mjs.includes("window.open(filesUrl('/download', { path: rel }), '_blank')"), '/api/files/download via window.open');
  assert.ok(mjs.includes("filesApi(filesUrl('', { path: rel }), { method: 'DELETE' })"), 'DELETE /api/files');
  assert.ok(mjs.includes("...(filesState.agent ? { agent: filesState.agent } : {})"), 'JSON bodies carry agent');
  assert.ok(mjs.includes("filesJson('/api/files/mkdir', { path: filesState.path, name: n })"));
  assert.ok(mjs.includes("filesJson('/api/files/rename', { path: rel, newName: n })"));
  assert.ok(mjs.includes("const agent = current || '';") && mjs.includes("if (agent !== filesState.agent) { filesState.agent = agent; filesState.path = ''; filesState.openRow = -1; }"), 'rooted on the open agent (current)');
  assert.ok(mjs.includes("if (!same && $('files-sheet')?.open) filesRefresh();"), 'opening another agent re-fetches the open sheet');
  assert.ok(mjs.includes("$('fs-title').textContent = `${root.label || 'Files'}${filesState.agent ? '' : ' (no chat open)'}`"), 'title is root.label, marked when no chat is open');
  assert.match(mjs, /if \(!confirm\(q\)\) return;[\s\S]*?method: 'DELETE'/, 'delete asks first');
  assert.ok(mjs.includes('`[file: ${absPath}]`'), 'Use in chat inserts [file: <absPath>]');
  assert.ok(mjs.includes("if (!hubMe || !hubMe.isAdmin) return null;") && mjs.includes("v === 'infra' ? 'mine' : v"), 'owner query rules');
  assert.ok(mjs.includes("if ($('files-sheet').open) openFilesSheet('');"), 'owner switcher change re-fetches');
  assert.ok(mhtml.includes('#files-sheet {'), 'sheet styled');
});

test('mobile: paperclip accepts any file; non-images upload to the open agent\'s root, camera stays image-only; sw v13', () => {
  assert.ok(mhtml.includes('<input type="file" id="file-input" multiple hidden>'), 'file-input no longer image-only');
  assert.ok(mhtml.includes('id="camera-input" accept="image/*"'), 'camera unchanged');
  assert.ok(mjs.includes("if (f.type.startsWith('image/')) addImageFile(f); else uploadFileForChat(f);"));
  assert.ok(mjs.includes("uploadFileToHub(file, '', false, agent)") && mjs.includes("const agent = current || ''; // this chat's agent folder"), 'chat uploads land in the open agent\'s folder');
  assert.ok(sw.includes("const VERSION = 'hub-mobile-v52';"), 'service worker cache bumped');
});
