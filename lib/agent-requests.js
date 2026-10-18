'use strict';
// Requests for more agents, filed by an agent on behalf of its owner (members cannot create agents).
// A request lands on the admin's Users page, the event stream and push; approving it creates the
// agent or template team for that owner, declining sends a note back into the requesting chat.
//
// data/agent-requests.json: [{ id, byAgent, ownerId, kind: 'agent'|'team', name, description, template,
//                               status: pending|approved|declined, createdAt, resolvedAt, resolvedBy, note, created }]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = process.env.HUB_AGENT_REQUESTS_FILE || path.join(__dirname, '..', 'data', 'agent-requests.json');

function createAgentRequests({ file = FILE, now = Date.now, onEvent = null, log = console.log,
  createTeam = null, createAgent = null, appendLog = null, getUser = null, defaultModel = () => 'claude-sdk/claude-sonnet-5-5' } = {}) {
  let list = null;
  function load() { if (list) return list; try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { list = []; } if (!Array.isArray(list)) list = []; return list; }
  function save() { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(load(), null, 2), { mode: 0o600 }); }
  function emit(type, data) { if (onEvent) { try { onEvent({ type, ...data }); } catch {} } }

  /** create({ byAgent, ownerId, kind, name, description }) -> { ok, request } | { ok: false, error } */
  function create({ byAgent, ownerId = null, kind = 'agent', name = '', description = '' }) {
    kind = kind === 'team' ? 'team' : 'agent';
    description = String(description || '').trim().slice(0, 1500);
    name = String(name || '').trim().slice(0, 60);
    if (!byAgent) return { ok: false, error: 'byAgent required' };
    if (!description) return { ok: false, error: 'say what the agent or team is for' };
    const pending = load().filter(r => r.status === 'pending' && r.ownerId === ownerId);
    if (pending.length >= 5) return { ok: false, error: 'there are already 5 requests waiting for the administrator; wait for an answer' };
    const r = { id: `rq_${crypto.randomBytes(4).toString('hex')}`, byAgent: String(byAgent), ownerId: ownerId ? String(ownerId) : null, kind, name, description,
      template: kind === 'team' ? (/legal|law|estate/i.test(description + ' ' + name) ? 'legal' : 'medical') : null,
      status: 'pending', createdAt: new Date(now()).toISOString(), resolvedAt: null, resolvedBy: null, note: null, created: null };
    load().push(r); save();
    log(`[agent-requests] ${r.byAgent} asks for a ${kind}${name ? ` "${name}"` : ''}: ${description.slice(0, 100)}`);
    emit('agent_request', { id: r.id, byAgent: r.byAgent, ownerId: r.ownerId, kind, name, description: description.slice(0, 300) });
    return { ok: true, request: r };
  }

  function all(status = null) { return load().filter(r => !status || r.status === status).slice().reverse(); }
  function get(id) { return load().find(r => r.id === id) || null; }

  /**
   * resolve(id, { action: 'approve'|'decline', by, note, template, model, name }) -> { ok, request, created }
   * Approving a team request creates the template team for the owner; approving an agent request creates
   * one agent (name from the request or given, personality from the description) owned by the requester's owner.
   */
  async function resolve(id, { action, by = null, note = '', template = null, model = null, name = null } = {}) {
    const r = get(id);
    if (!r) return { ok: false, error: 'no such request' };
    if (r.status !== 'pending') return { ok: false, error: `already ${r.status}` };
    let created = null;
    if (action === 'approve') {
      const user = getUser ? getUser(r.ownerId) : null;
      if (r.kind === 'team') {
        if (!createTeam) return { ok: false, error: 'team creation unavailable' };
        const t = await createTeam({ user: user || { id: r.ownerId, login: r.ownerId }, template: template || r.template || 'medical' });
        if (!t.ok) return { ok: false, error: t.error };
        created = { kind: 'team', agents: t.agents, head: t.head };
      } else {
        if (!createAgent) return { ok: false, error: 'agent creation unavailable' };
        const base = String(name || r.name || 'helper').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 20) || 'helper';
        const prefix = user && user.login ? String(user.login).split('@')[0].toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16) : (r.ownerId || 'hub');
        const agentName = r.ownerId ? `${/^[a-z]/.test(prefix) ? prefix : 'm' + prefix}_${base}` : base;
        const c = await createAgent(agentName, model || defaultModel(), r.description, null, 'specialist', r.ownerId);
        if (!c.success) return { ok: false, error: c.error };
        created = { kind: 'agent', agents: [agentName] };
      }
    } else if (action !== 'decline') return { ok: false, error: 'action must be approve or decline' };
    r.status = action === 'approve' ? 'approved' : 'declined';
    r.resolvedAt = new Date(now()).toISOString(); r.resolvedBy = by; r.note = String(note || '').slice(0, 500) || null; r.created = created;
    save();
    emit('agent_request_resolved', { id: r.id, byAgent: r.byAgent, ownerId: r.ownerId, status: r.status, created, note: r.note });
    // Tell the requesting chat what happened (an assistant-side note, no model call).
    if (appendLog) {
      const what = r.kind === 'team' ? 'team' : `agent${r.name ? ` "${r.name}"` : ''}`;
      const text = r.status === 'approved'
        ? `[Hub notice] The administrator approved the request for a ${what}. Created: ${(created && created.agents || []).join(', ')}. ${created && created.kind === 'team' ? 'The new team head will introduce itself in its own chat.' : 'It appears in the agent list now.'}${r.note ? ` Note from the administrator: ${r.note}` : ''}`
        : `[Hub notice] The administrator declined the request for a ${what}.${r.note ? ` Note: ${r.note}` : ''} Carry on with what you have, or ask again with more detail.`;
      try { appendLog(r.byAgent, 'assistant', text); } catch {}
    }
    log(`[agent-requests] ${r.id} ${r.status} by ${by || '?'}${created ? ` -> ${created.agents.join(', ')}` : ''}`);
    return { ok: true, request: r, created };
  }

  return { create, all, get, resolve, file };
}

let shared = null;
function getAgentRequests(opts) { if (!shared) shared = createAgentRequests(opts); return shared; }

module.exports = { createAgentRequests, getAgentRequests };
