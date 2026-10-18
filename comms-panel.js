'use strict';

// comms-panel.js — owner UI for lib/comms (Telegram etc). Loaded as its own <script>
// tag after app.js; reuses gsModal/gsClose/esc as globals, otherwise self-contained.

async function commsApi(path, body) {
  const r = await fetch('/api/comms/' + path, body === undefined ? { credentials: 'include' }
    : { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
}

function commsV(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function commsChk(id) { const el = document.getElementById(id); return el ? el.checked : false; }

async function openCommsPanel(flash) {
  const dock = { dock: true, title: '💬 Comms' };
  const field = 'width:100%;padding:8px;border-radius:6px;border:1px solid #555;background:transparent;color:inherit;font:inherit;margin:6px 0';
  let s, audit;
  try {
    s = await commsApi('status');
    audit = await commsApi('audit?limit=30');
  } catch (e) {
    return gsModal(`<div class="gs-box"><h4>Comms</h4><p>${esc(e.message)}</p></div><div class="gs-actions">${gsClose}</div>`, dock);
  }
  const t = s.channels.telegram;
  const walletSet = new Set(s.walletAgents || []);

  const statusLine = `<div class="gs-box"><h4>Telegram</h4>
    <p>${t.enabled ? (t.paused ? '⏸ enabled, paused' : '🟢 enabled') : '⚪ disabled'}
    ${t.botUsername ? ` · bot @${esc(t.botUsername)}` : ''}
    ${t.polling ? ' · polling' : ''}
    ${t.pendingCount ? ` · ${t.pendingCount} queued` : ''}</p>
    ${t.lastError ? `<p style="color:#c62828"><small>Last error: ${esc(t.lastError)}</small></p>` : ''}
  </div>`;

  const tokenBox = `<div class="gs-box"><h4>Bot token</h4>
    <p><small>${t.tokenSet ? `Token set${t.botUsername ? ` (@${esc(t.botUsername)})` : ''}.` : 'No token set.'}
    Create a bot with <b>@BotFather</b> on Telegram to get one.</small></p>
    <input id="comms-token" type="password" placeholder="123456:AA..." style="${field}">
    <div class="gs-actions">
      <button class="gs-btn" onclick="commsAct('save-token')">Save token</button>
      <button class="gs-btn secondary" onclick="commsAct('clear-token')">Clear</button>
    </div></div>`;

  const agentsAll = s.agentsAvailable || [];
  const agentsChecked = new Set(t.agents || []);
  const agentBoxes = agentsAll.map(name => `<label style="display:block">
      <input type="checkbox" id="comms-agent-${esc(name)}" ${agentsChecked.has(name) ? 'checked' : ''}>
      ${esc(name)}${walletSet.has(name) ? ' <span style="color:#c62828">(wallet agent — can trade; think twice)</span>' : ''}
    </label>`).join('');
  const defaultOpts = agentsAll.map(n => `<option value="${esc(n)}" ${t.defaultAgent === n ? 'selected' : ''}>${esc(n)}</option>`).join('');

  const switchesBox = `<div class="gs-box"><h4>Settings</h4>
    <label><input type="checkbox" id="comms-enabled" ${t.enabled ? 'checked' : ''}> Enabled</label><br>
    <label><input type="checkbox" id="comms-paused" ${t.paused ? 'checked' : ''}> Paused</label>
    <p><small>Default agent</small></p>
    <select id="comms-default-agent" style="${field}">${defaultOpts}</select>
    <p><small>Agents reachable over Telegram</small></p>
    ${agentBoxes}
    <div class="gs-actions"><button class="gs-btn" onclick="commsAct('save-config')">Save settings</button></div>
  </div>`;

  const senderRows = (t.senders || []).map(sd => `<tr><td>${esc(sd.id)}</td><td>${esc(sd.name)}</td><td>${esc(sd.role || '')}</td>
    <td><button class="gs-btn secondary" onclick="commsAct('set-role','${esc(sd.id)}','${esc(sd.name)}','${sd.role === 'owner' ? 'guest' : 'owner'}')">${sd.role === 'owner' ? 'Make guest' : 'Make owner'}</button>
    <button class="gs-btn secondary" onclick="commsAct('remove-sender','${esc(sd.id)}')">Remove</button></td></tr>`).join('')
    || '<tr><td colspan="4"><i>No allow-listed senders yet.</i></td></tr>';
  const unknownRows = (s.unknown || []).map(u => `<tr><td>${esc(u.id)}</td><td>${esc(u.name || u.username || '')}</td><td>${u.count}</td>
    <td><button class="gs-btn" onclick="commsAct('allow-unknown','${esc(u.id)}','${esc(u.name || u.username || '')}','owner')">Allow as owner</button>
    <button class="gs-btn secondary" onclick="commsAct('allow-unknown','${esc(u.id)}','${esc(u.name || u.username || '')}','guest')">Allow as guest</button></td></tr>`).join('')
    || '<tr><td colspan="4"><i>No unknown senders.</i></td></tr>';
  const sendersBox = `<div class="gs-box"><h4>Senders (allow-list)</h4>
    <p><small>Send <code>/start</code> to the bot from your phone, then allow your id here.</small></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Id</th><th>Name</th><th>Role</th><th></th></tr></thead>
    <tbody>${senderRows}</tbody></table>
    <p><small>Unknown senders</small></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Id</th><th>Name</th><th>Count</th><th></th></tr></thead>
    <tbody>${unknownRows}</tbody></table></div>`;

  const recipRows = (t.recipients || []).map(r => `<tr><td>${esc(r.id)}</td><td>${esc(r.name)}${r.owner ? ' (owner)' : ''}</td>
    <td><button class="gs-btn secondary" onclick="commsAct('remove-recipient','${esc(r.id)}')">Remove</button></td></tr>`).join('')
    || '<tr><td colspan="3"><i>No recipients yet.</i></td></tr>';
  const recipientsBox = `<div class="gs-box"><h4>Recipients</h4>
    <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th>Id</th><th>Name</th><th></th></tr></thead>
    <tbody>${recipRows}</tbody></table>
    <input id="comms-recip-id" placeholder="chat id" style="${field}">
    <input id="comms-recip-name" placeholder="name" style="${field}">
    <div class="gs-actions"><button class="gs-btn" onclick="commsAct('add-recipient')">Add recipient</button></div></div>`;

  const recipOpts = (t.recipients || []).map(r => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
  const testBox = `<div class="gs-box"><h4>Test send</h4>
    <select id="comms-test-to" style="${field}">${recipOpts}</select>
    <input id="comms-test-text" placeholder="message text" style="${field}">
    <div class="gs-actions"><button class="gs-btn" onclick="commsAct('test-send')">Send</button></div></div>`;

  const when = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const auditRows = (audit || []).map(a => `<tr><td><small>${esc(when(a.ts))}</small></td><td>${esc(a.dir)}</td>
    <td>${esc(a.agent || '')}</td><td>${esc(a.senderName || a.chatId || '')}</td><td><small>${esc(a.note || '')}</small></td></tr>`).join('')
    || '<tr><td colspan="5"><i>No activity yet.</i></td></tr>';
  const activityBox = `<div class="gs-box"><h4>Recent activity</h4>
    <table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr><th>When</th><th>Dir</th><th>Agent</th><th>Who</th><th>Note</th></tr></thead>
    <tbody>${auditRows}</tbody></table>
    <p><a href="/api/comms/audit.csv" target="_blank">Download CSV</a></p></div>`;

  gsModal(`${flash ? `<div class="gs-ok">${esc(flash)}</div>` : ''}
    ${statusLine}${tokenBox}${switchesBox}${sendersBox}${recipientsBox}${testBox}${activityBox}
    <div class="gs-actions">${gsClose}</div>`, dock);
}

async function commsAct(action, arg1, arg2, arg3) {
  try {
    if (action === 'save-token') {
      const token = commsV('comms-token');
      await commsApi('telegram/token', { token: token || null });
      return openCommsPanel(token ? 'Token saved.' : 'Token cleared.');
    }
    if (action === 'clear-token') {
      await commsApi('telegram/token', { token: null });
      return openCommsPanel('Token cleared.');
    }
    if (action === 'save-config') {
      const s = await commsApi('status');
      const agentsAll = s.agentsAvailable || [];
      const agents = agentsAll.filter(n => commsChk('comms-agent-' + n));
      await commsApi('telegram/config', {
        enabled: commsChk('comms-enabled'),
        paused: commsChk('comms-paused'),
        defaultAgent: commsV('comms-default-agent'),
        agents,
      });
      return openCommsPanel('Settings saved.');
    }
    if (action === 'remove-sender') {
      await commsApi('telegram/senders', { remove: arg1 });
      return openCommsPanel('Sender removed.');
    }
    if (action === 'allow-unknown') {
      const role = arg3 === 'owner' ? 'owner' : 'guest';
      await commsApi('telegram/senders', { add: { id: arg1, name: arg2 || arg1, role } });
      return openCommsPanel(`Sender allowed as ${role}.`);
    }
    if (action === 'set-role') {
      const role = arg3 === 'owner' ? 'owner' : 'guest';
      await commsApi('telegram/senders', { add: { id: arg1, name: arg2 || arg1, role } });
      return openCommsPanel(`Role set to ${role}.`);
    }
    if (action === 'remove-recipient') {
      const s = await commsApi('status');
      const recipients = (s.channels.telegram.recipients || []).filter(r => String(r.id) !== String(arg1));
      await commsApi('telegram/config', { recipients });
      return openCommsPanel('Recipient removed.');
    }
    if (action === 'add-recipient') {
      const id = commsV('comms-recip-id'), name = commsV('comms-recip-name');
      if (!id || !name) return openCommsPanel('Id and name are required.');
      const s = await commsApi('status');
      const recipients = (s.channels.telegram.recipients || []).concat([{ id, name }]);
      await commsApi('telegram/config', { recipients });
      return openCommsPanel('Recipient added.');
    }
    if (action === 'test-send') {
      const to = commsV('comms-test-to'), text = commsV('comms-test-text');
      await commsApi('telegram/test', { to, text });
      return openCommsPanel('Test message sent.');
    }
  } catch (e) { openCommsPanel('Error: ' + e.message); }
}
