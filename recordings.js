'use strict';
// recordings.js: the Recordings page (/recordings). It lists the call recordings of the agents whose "who can download" list
// holds the signed-in person, plays them, downloads them and deletes them. Every request goes to /api/recordings/*; the routes
// refuse (403) anyone who is not on the list. Nothing here is cached (fetch with cache: 'no-store') and every piece of
// recorded text (transcripts, the agent's lines, the first words) is put on the page as plain text (textContent), never as HTML.

const API = '/api/recordings';
const content = document.getElementById('content');
const dlg = document.getElementById('delete-dialog');
const delBox = document.getElementById('delete-box');
const delOk = document.getElementById('delete-confirm');
const delErr = document.getElementById('delete-err');
const guard = typeof createDialogGuard === 'function' ? createDialogGuard({ trackSaves: false }) : null;   // Escape, Cancel and the backdrop close the dialog the same way everywhere

// The phone's pages live under /mobile; the desktop's chat is the home page.
const fromPhone = /(?:^|[?&])from=mobile(?:&|$)/.test(location.search) || (window.matchMedia && window.matchMedia('(max-width: 700px)').matches);
const backLink = document.getElementById('back-link');
if (fromPhone) { backLink.href = '/mobile'; backLink.textContent = '← Back to chat'; }

function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid) e.appendChild(kid);
  return e;
}
function show(...nodes) { content.replaceChildren(...nodes.filter(Boolean)); }
function plain(text, cls) { return el('div', { class: cls || 'plain', text }); }

async function getJson(url) {
  const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
  let body = null;
  try { body = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) { const e = new Error((body && body.error) || 'failed'); e.status = r.status; e.code = body && body.error; throw e; }
  return body;
}
function failText(e) {
  if (e && e.status === 403) return "You can't open these recordings.";
  return "These recordings couldn't be loaded. Try again in a moment.";
}

// ── Formats ──
function fmtDuration(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${r} s` : `${r} s`;
}
function fmtSize(bytes) {
  const mb = (Number(bytes) || 0) / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
function fmtHours(ms) { return ((Number(ms) || 0) / 3600000).toFixed(1); }
const when = (iso) => new Date(iso);   // shown in the person's own time zone
const dateOf = (iso) => when(iso).toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const timeOf = (iso) => when(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const dateTimeOf = (iso) => when(iso).toLocaleString(undefined, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ── The agents ──
async function start() {
  let data;
  try { data = await getJson(API); } catch (e) { show(plain(failText(e), 'error')); return; }
  const agents = (data && data.agents) || [];
  if (!agents.length) { show(plain('There are no recordings you can open.')); return; }
  if (agents.length === 1) { openAgent(agents[0], false); return; }
  show(el('h3', { text: 'Choose an agent' }), el('div', { class: 'agents' }, ...agents.map((a) => el('button', {
    type: 'button', class: 'btn agent-row', onclick: () => openAgent(a, true),
  }, el('b', { text: a.display || a.name }), el('span', { class: 'note', text: `${a.sessions} sessions` })))));
}

async function openAgent(agent, canGoBack) {
  const enc = encodeURIComponent(agent.name);
  const head = [];
  if (canGoBack) head.push(el('button', { type: 'button', class: 'btn', onclick: start, text: '← All agents' }));
  head.push(el('h2', { text: agent.display || agent.name, style: 'margin-top:12px' }));
  head.push(el('div', { class: 'summary', text: `${agent.sessions} sessions, ${fmtHours(agent.speechMs)} hours of speech, ${fmtSize(agent.bytes)} on disk` }));
  head.push(el('a', { class: 'btn btn-primary', href: `${API}/${enc}/all.zip`, download: '', text: 'Download everything' }));
  head.push(el('div', { class: 'note', text: 'One file with every recording, its transcripts and details.' }));
  const listBox = el('div', { id: 'sessions' }, plain('Loading…'));
  show(...head, listBox);
  let sessions;
  try { sessions = (await getJson(`${API}/${enc}/sessions`)).sessions || []; } catch (e) { listBox.replaceChildren(plain(failText(e), 'error')); return; }
  renderSessions(agent, listBox, sessions);
}

function renderSessions(agent, box, sessions) {
  box.replaceChildren();
  if (!sessions.length) { box.appendChild(plain('There are no recordings yet.')); return; }
  let day = null;
  for (const s of sessions) {   // the hub sends newest first
    if (!s.damaged) {
      const d = dateOf(s.startedAt);
      if (d !== day) { day = d; box.appendChild(el('h3', { text: d })); }
    } else if (day !== '?') { day = '?'; box.appendChild(el('h3', { text: 'Unreadable' })); }
    box.appendChild(sessionRow(agent, s));
  }
}

function sessionRow(agent, s) {
  const enc = encodeURIComponent(agent.name), sid = encodeURIComponent(s.sessionId);
  const row = el('div', { class: 'session' });
  const detail = el('div', { class: 'convo' }); detail.hidden = true;
  if (s.damaged) {
    row.appendChild(el('div', { class: 's-when', text: s.sessionId }));
    row.appendChild(el('div', { class: 's-flag', text: "This session can't be opened." }));
    row.appendChild(el('div', { class: 's-btns' }, deleteButton(agent, s, row)));
    return row;
  }
  row.appendChild(el('div', { class: 's-when', text: dateTimeOf(s.startedAt) }));
  const meta = `${fmtDuration(s.durationMs)} · ${s.segments} segment${s.segments === 1 ? '' : 's'}`;
  row.appendChild(el('div', { class: 's-meta', text: meta }));
  if (s.firstWords) row.appendChild(el('div', { class: 's-first', text: `“${s.firstWords}”` }));
  if (s.unfinished) row.appendChild(el('div', { class: 's-flag', text: '(ended without hanging up)' }));
  const openBtn = el('button', { type: 'button', class: 'btn', text: 'Open' });
  openBtn.addEventListener('click', async () => {
    if (!detail.hidden) { detail.hidden = true; openBtn.textContent = 'Open'; return; }
    detail.hidden = false; openBtn.textContent = 'Close';
    if (detail.dataset.loaded) return;
    detail.replaceChildren(plain('Loading…'));
    try { renderConversation(detail, agent, s, await getJson(`${API}/${enc}/${sid}/manifest`)); detail.dataset.loaded = '1'; }
    catch (e) { detail.replaceChildren(plain(e && e.status === 404 ? "This session can't be opened." : failText(e), 'error')); }
  });
  row.appendChild(el('div', { class: 's-btns' },
    openBtn,
    el('a', { class: 'btn', href: `${API}/${enc}/${sid}.zip`, download: '', text: 'Download' }),
    deleteButton(agent, s, row)));
  row.appendChild(detail);
  return row;
}

const EVENT_TEXT = { pause: 'Recording paused', resume: 'Recording resumed', consent: 'Consent line spoken' };

function renderConversation(box, agent, s, man) {
  box.replaceChildren();
  const enc = encodeURIComponent(agent.name), sid = encodeURIComponent(s.sessionId);
  const entries = Array.isArray(man && man.entries) ? man.entries : [];
  if (!entries.length) { box.appendChild(plain('Nothing was recorded in this session.')); return; }
  for (const e of entries) {
    if (e.kind === 'event') {
      box.appendChild(el('div', { class: 'event', text: EVENT_TEXT[e.type] || 'Recording event' }));
    } else if (e.kind === 'text') {
      box.appendChild(el('div', { class: 'line agent' }, el('div', { class: 'who', text: 'Agent' }), el('div', { class: 'said', text: String(e.text || '') })));
    } else if (e.kind === 'segment') {
      const line = el('div', { class: `line ${e.speaker === 'agent' ? 'agent' : 'person'}` });
      line.appendChild(el('div', { class: 'who', text: e.speaker === 'agent' ? 'Agent' : 'Person' }));
      line.appendChild(el('audio', { controls: '', preload: 'none', src: `${API}/${enc}/${sid}/${Number(e.seq)}.flac` }));
      line.appendChild(el('div', { class: 'said', text: e.transcript ? String(e.transcript) : '(no transcript)' }));
      box.appendChild(line);
    }
  }
}

// ── Delete ──
function deleteButton(agent, s, row) {
  return el('button', { type: 'button', class: 'btn btn-danger', text: 'Delete', onclick: () => askDelete(agent, s, row) });
}

let pending = null;   // { agent, s, row } while the dialog is open
function askDelete(agent, s, row) {
  pending = { agent, s, row };
  const label = s.damaged ? s.sessionId : dateTimeOf(s.startedAt);
  document.getElementById('delete-text').textContent = `Recording from ${label}. This deletes the recording and its transcript from this computer for good. Backups made before today still hold it. Type DELETE to confirm.`;
  delBox.value = ''; delOk.disabled = true; delErr.textContent = '';
  if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  delBox.focus();
}
delBox.addEventListener('input', () => { delOk.disabled = delBox.value !== 'DELETE'; });
document.getElementById('delete-cancel').addEventListener('click', () => { if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open'); pending = null; });
dlg.addEventListener('close', () => { pending = null; });
const DELETE_ERRORS = { in_use: 'That call is still going on.', not_allowed: "You can't delete these recordings.", not_found: 'That recording is already gone.' };
delOk.addEventListener('click', async () => {
  if (!pending || delBox.value !== 'DELETE') return;   // only the exact word posts
  const { agent, s, row } = pending;
  delOk.disabled = true; delErr.textContent = '';
  try {
    const r = await fetch(`${API}/${encodeURIComponent(agent.name)}/${encodeURIComponent(s.sessionId)}/delete`, {
      method: 'POST', credentials: 'include', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'DELETE' }),
    });
    let body = null; try { body = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) { delErr.textContent = DELETE_ERRORS[body && body.error] || "The recording couldn't be deleted. Try again in a moment."; delOk.disabled = delBox.value !== 'DELETE'; return; }
    row.remove();
    dlg.close();
  } catch { delErr.textContent = "The recording couldn't be deleted. Check the connection and try again."; delOk.disabled = delBox.value !== 'DELETE'; }
});

start();
