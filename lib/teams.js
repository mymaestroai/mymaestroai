'use strict';
// Team templates: give a member a whole team of their own in one step. The admin's medical and legal
// teams are the templates: each agent's workspace files are copied to a new agent named
// <prefix>_<role>, owned by the member, with every teammate name and every team folder path rewritten
// so the new team talks to itself and keeps its files under users/<userId>/.
//
// Nothing of the admin's data is copied: no conversations, no memory, no patient or matter files.

const fs = require('fs');
const path = require('path');
const http = require('http');

const HUB_ROOT = path.resolve(__dirname, '..');
const { HUB_HOME } = require('./hub-home');   // share/, users/, medical/, legal/: see lib/hub-home
const AGENTS_FILE = path.join(HUB_ROOT, 'data', 'agents.json');
const WORKSPACES = path.join(HUB_ROOT, 'workspaces');

// Templates live in the owner's settings (settings.teamTemplates), never in code: they name the owner's own agents.
//   { medical: { folder: 'medical', members: ['<agent>', ...], head: '<agent>' }, ... }
let templateOverride = null;   // tests (and embedders) can supply templates without touching settings
function useTemplates(t) { templateOverride = t && typeof t === 'object' ? t : null; }
function templates() {
  if (templateOverride) return templateOverride;
  try { const t = require('./settings').getSetting('teamTemplates'); return t && typeof t === 'object' ? t : {}; } catch { return {}; }
}

function readAgents() { try { return JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8')); } catch { return []; } }
function writeAgents(list) { fs.writeFileSync(AGENTS_FILE, JSON.stringify(list, null, 2)); try { require('./agents').getAgents(true); } catch {} }

function prefixFor(user, prefix) {
  const raw = String(prefix || (user.login || '').split('@')[0] || user.name || 'member').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 16);
  return /^[a-z]/.test(raw) ? raw : `m${raw}`;
}

/** Rewrite teammate names and team folder paths inside a workspace file. */
function rewrite(text, { nameMap, oldFolder, newFolder }) {
  let out = String(text);
  for (const [from, to] of Object.entries(nameMap)) out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  out = out.split(`~/agent-hub/${oldFolder}`).join(newFolder).split(path.join(HUB_HOME, oldFolder)).join(newFolder);
  return out;
}

/**
 * createTeamForUser({ user, template, prefix }) -> { ok, agents: [names], folder } | { ok: false, error }
 */
async function createTeamForUser({ user, template, prefix = null, fsImpl = fs } = {}) {
  const t = templates()[String(template || '').toLowerCase()];
  if (!user || !user.id) return { ok: false, error: 'user required' };
  if (!t) return { ok: false, error: Object.keys(templates()).length ? `unknown template (${Object.keys(templates()).join(', ')})` : 'no team templates on this hub (settings.teamTemplates)' };
  const pre = prefixFor(user, prefix);
  const all = readAgents();
  const byName = new Map(all.map(a => [a.name, a]));
  const missing = t.members.filter(n => !byName.has(n));
  if (missing.length) return { ok: false, error: `template agents missing on this hub: ${missing.join(', ')}` };
  const nameMap = Object.fromEntries(t.members.map(n => [n, `${pre}_${n}`]));
  const clash = Object.values(nameMap).filter(n => byName.has(n));
  if (clash.length) return { ok: false, error: `agents already exist: ${clash.join(', ')} (choose another prefix)` };

  const userDir = path.join(HUB_HOME, 'users', String(user.id));
  const folder = path.join(userDir, t.folder);
  for (const sub of ['inbox', 'patients', 'matters', 'documents', 'reference']) fsImpl.mkdirSync(path.join(folder, sub), { recursive: true, mode: 0o700 });
  try { fsImpl.chmodSync(userDir, 0o700); } catch {}

  const created = [];
  for (const src of t.members) {
    const a = byName.get(src);
    const name = nameMap[src];
    const ws = path.join(WORKSPACES, name);
    fsImpl.mkdirSync(ws, { recursive: true });
    const srcWs = path.join(WORKSPACES, src);
    let files = [];
    try { files = fsImpl.readdirSync(srcWs).filter(f => /\.md$/i.test(f)); } catch {}
    for (const f of files) {
      const text = fsImpl.readFileSync(path.join(srcWs, f), 'utf8');
      fsImpl.writeFileSync(path.join(ws, f), rewrite(text, { nameMap, oldFolder: t.folder, newFolder: folder }), 'utf8');
    }
    fsImpl.writeFileSync(path.join(ws, 'USER.md'), userFile(user, { team: t.folder, head: src === t.head }), 'utf8');
    const rec = { ...a, name, owner: String(user.id), display: a.display || src, lead: undefined, sharedWith: undefined, policy: undefined };
    delete rec.lead; delete rec.sharedWith; delete rec.policy;
    all.push(rec);
    created.push(name);
  }
  writeAgents(all);
  // The team head introduces itself before the member ever opens the chat (runs in the background).
  greetAgent(nameMap[t.head], user).catch(() => {});
  return { ok: true, agents: created, head: nameMap[t.head], folder, prefix: pre };
}

/** USER.md for a member-owned agent: who it belongs to and the ground rules. */
function userFile(user, { team = null, head = false } = {}) {
  return `# USER.md — About the person you work for

## Owner
- **Name:** ${user.name || user.login}
- **Email:** ${user.login}
- **Role on this hub:** member. ${head ? 'This team is theirs; you are its head.' : 'You are one of their team.'}
- The hub administrator can also open this chat and your settings.

## Files folder
- ${path.join(HUB_HOME, 'users', String(user.id), 'files')}
- Files the owner uploads in the hub's Files panel (or attaches with the paperclip) land here, and anything you save here they can download. Read and write it directly; keep deliverables here, not in your own folder.

## Boundaries
- You and your teammates only see this person's agents, files and shared notes. You cannot reach the administrator's agents or files, send email, or post anywhere; if something needs that, say so plainly.
${team ? `- Working folder for this team: see the paths in SOUL.md (under the owner's users/ tree).\n` : ''}
## First run
- The first time you speak with them, introduce yourself: who you are, what you do, your teammates by their display names, where files go, and two or three example requests. Then ask what they would like help with.
`;
}

const GREETING_PROMPT = (user) => `[First run, from the hub] You were just created for ${user.name || user.login}. This is the first message in your chat with them and they have not written yet. Introduce yourself to them directly, in 6 to 10 short lines: who you are, what you do, which teammates you can bring in (use display names, not internal ids), where their files live, and two or three example things they can ask you. Warm, plain, no jargon, no lists of limitations. Do not use any tools, do not consult anyone, do not ask questions that need an answer right now. End with a single line inviting them to tell you what they need.`;

/** Default poster: the hub's own loopback chat endpoint, as an ephemeral turn (nothing but the reply is kept). */
function defaultPost(agent, message) {
  return new Promise((resolve, reject) => {
    const auth = require('./auth');
    const body = JSON.stringify({ agent, message, ephemeral: true, origin: { kind: 'task', from: 'hub' } });
    const req = http.request({ hostname: '127.0.0.1', port: parseInt(process.env.PORT || '8888', 10), path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), [auth.SERVICE_HEADER]: auth.SERVICE_TOKEN } }, (res) => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => { try { resolve(JSON.parse(data).response || ''); } catch { resolve(''); } });
    });
    req.on('error', reject); req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('greeting timed out')));
    req.write(body); req.end();
  });
}

/**
 * greetAgent(name, user, { post, append }) -> introduction text. The agent writes its own introduction in
 * an ephemeral turn and only the reply is placed in its chat, so the member's first view is the agent
 * saying hello. Skipped when the chat already has history.
 */
async function greetAgent(name, user, { post = defaultPost, append = null, hasHistory = null } = {}) {
  const sdk = () => require('./sdk-chat');
  const history = hasHistory ? hasHistory(name) : (() => { try { return sdk().loadConversationLog(name).length > 0; } catch { return false; } })();
  if (history) return null;
  const text = String(await post(name, GREETING_PROMPT(user)) || '').trim();
  if (!text) return null;
  (append || ((n, t) => sdk().appendConversationLog(n, 'assistant', t)))(name, text);
  return text;
}

/** For an agent whose owner was just switched to a member: greet if it is a head (category primary) with an empty chat. */
async function greetIfFresh(name, user, opts = {}) {
  try {
    const a = readAgents().find(x => x.name === name);
    if (!a || a.category !== 'primary') return null;
    const ws = path.join(WORKSPACES, name);
    try { if (!fs.existsSync(path.join(ws, 'USER.md'))) fs.writeFileSync(path.join(ws, 'USER.md'), userFile(user, { head: true }), 'utf8'); } catch {}
    return await greetAgent(name, user, opts);
  } catch { return null; }
}

/** SOUL for a member's personal assistant: generalist, team-aware, knows its boundaries and how to ask for more. */
function assistantSoul(user) {
  const who = user.name || user.login;
  return `# SOUL.md — Who you are

You are ${who}'s personal assistant on My Maestro AI: a sharp, warm generalist who gets things done and asks good questions. You work for ${who} only.

## First conversation
- Introduce yourself briefly, explain what you can do, and ask what ${who} would like to call you. When they answer, call the \`rename_me\` tool with that name and use it from then on. If they do not care, keep "Assistant".
- Ask what they want help with first.

## What you can do
- Research, writing, planning, summarising, explaining, organising ${who}'s files in their Files folder (your working folder: see USER.md).
- Run several threads at once with \`spawn_workers\` (temporary helpers that inherit your limits) when a task splits naturally.
- Consult ${who}'s other agents with \`consult_agent\` once they have some (\`list_agents\` shows them). You only ever see ${who}'s agents.
- Remember things: \`append_memory\` for durable notes about ${who}'s preferences and projects, \`write_shared_memory\` for facts the whole team should know.

## What you cannot do, and what to do instead
- You cannot send email or messages, reach the administrator's agents or files, or change hub settings. Say so plainly when it comes up.
- You cannot create permanent agents. When ${who} needs a specialist or a whole team (for example a medical or legal team), call \`request_agent\` with a clear description; the administrator approves or declines and you will see a hub notice in this chat. Tell ${who} the request is in and what happens next.
- Web access may be off: if a fetch is refused, say it needs the administrator's grant.

## Style
- Lead with the answer. Short paragraphs, plain words. Ask one question at a time.
- Never invent facts; say when you do not know.
`;
}

/**
 * createDefaultAssistant(user, { model }) -> { ok, name } : one personal agent for a new member, then its introduction.
 */
async function createDefaultAssistant(user, { model = null, fsImpl = fs } = {}) {
  if (!user || !user.id) return { ok: false, error: 'user required' };
  const pre = prefixFor(user);
  const name = `${pre}_assistant`;
  const all = readAgents();
  if (all.some(a => a.name === name)) return { ok: true, name, existed: true };
  const chosen = model || (() => { try { return require('./settings').getSetting('memberDefaultModel', 'claude-sdk/claude-sonnet-5-5'); } catch { return 'claude-sdk/claude-sonnet-5-5'; } })();
  const ws = path.join(WORKSPACES, name);
  fsImpl.mkdirSync(ws, { recursive: true });
  fsImpl.mkdirSync(path.join(HUB_HOME, 'users', String(user.id), 'files'), { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(path.join(ws, 'SOUL.md'), assistantSoul(user), 'utf8');
  fsImpl.writeFileSync(path.join(ws, 'IDENTITY.md'), `# IDENTITY.md\n\n## Name\nAssistant\n\n## Role\n${user.name || user.login}'s personal assistant on My Maestro AI.\n\n## Platform\nMy Maestro AI\n`, 'utf8');
  fsImpl.writeFileSync(path.join(ws, 'USER.md'), userFile(user, { head: true }), 'utf8');
  all.push({ name, model: chosen, display: 'Assistant', icon: '🙂', type: 'normal', category: 'primary', owner: String(user.id), blurb: `${user.name || user.login}'s personal assistant` });
  writeAgents(all);
  greetAgent(name, user).catch(() => {});
  return { ok: true, name };
}

module.exports = { createTeamForUser, createDefaultAssistant, assistantSoul, templates, useTemplates, prefixFor, rewrite, userFile, greetAgent, greetIfFresh, GREETING_PROMPT };
