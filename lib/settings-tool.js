'use strict';
// The lead's settings tool: change_setting { action: find | get | set }. It reads the settings records (templates/settings-records.json,
// lib/settings-records) and changes a setting through lib/settings-apply, so a change by Maestro is held to the rules a change on a
// screen is held to, and is journaled once (lib/settings-journal) as made by the lead, with the person's words as the reason.
//
//   at once     the record says lead "apply" and the danger is not "dangerous": done now, one line in the chat with Undo for 24 hours
//   confirm     the record says lead "confirm": a card (hub-built ask_user, fixed buttons Confirm / Cancel, no typed answer) shows the
//               setting, the agent, now, after and what it means; nothing changes until Confirm
//   screen      lead "screen" or "none", dangerous, a secret, a setting kept on the device, or a target no route writes: refused,
//               with the exact link to its screen
// A turn is "tainted" when the person's message holds pasted text, or when, earlier in the turn, a tool other than the short allowlist
// below ran (its result may hold text from outside) or an interjection came from an API token: every "at once" then becomes a card.
// The card says nothing about that; it just appears.
//
// The card is tied to the value it was made from: on Confirm the current value is read again; if it is not the card's "before", ONE new
// card ("It is now <current>. Change it to <after>?") asks again. Cancel, no answer, a stopped turn and a turn that is no longer the
// person's own change nothing. This module has no state of its own: sdk-chat.js gives it the turn, the card and the event.
const TOOL_NAME = 'change_setting';
const OPTIONS = ['Confirm', 'Cancel'];
const UNDO_NOTE = 'Undo is in the chat for 24 hours.';
const NOT_OFFERED = 'Settings can only be changed in a turn the person you work for started by typing their own message.';
// What a tool of this list returns is never outside text: everything else taints the turn.
const UNTAINTED_TOOLS = new Set(['change_setting', 'ask_user', 'for_owner', 'read_memory', 'record_list', 'list_agents', 'list_scheduled_tasks', 'job_status', 'list_jobs']);
const TURN_ORIGINS_OK = new Set(['user']);

const DESCRIPTION = 'Look up and change a setting for the person who is typing to you (find, get, set). Use it when they ask to change, turn on or off, raise or lower something in Maestro; use find first when you do not know the record. '
  + 'A setting that is safe is changed at once and the chat shows one line with Undo; one that needs care shows the person a card with the old and new value and waits for Confirm; '
  + 'a setting that is only theirs to change (keys, passwords, wallets, access, safety switches) is never changed by you: the answer holds the exact markdown link that opens its screen, so include that link in your reply. '
  + 'Never edit data/settings.json, agents.json or any settings file yourself. Say what you changed in your own words, once.';
const PARAMETERS = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['find', 'get', 'set'], description: 'find: records matching some words; get: one record with its help, value and class; set: change it' },
    words: { type: 'string', description: 'find: what the person called it (a name, a label or a few words)' },
    setting: { type: 'string', description: 'get, set: the record id (OPT-0123) or its exact name' },
    agent: { type: 'string', description: 'get, set: the agent (its name or the name shown in the list) for a per-agent setting' },
    value: { description: 'set: the new value (on/off as true/false, a number, or text, as the record needs)' },
    reason: { type: 'string', description: 'set: the person\'s request in a few words, kept in the journal' },
  },
  required: ['action'],
};
/** The tool's zod shape for the Claude client path (the caller passes its own z). */
function zodShape(z) {
  return {
    action: z.enum(['find', 'get', 'set']).describe(PARAMETERS.properties.action.description),
    words: z.string().optional().describe(PARAMETERS.properties.words.description),
    setting: z.string().optional().describe(PARAMETERS.properties.setting.description),
    agent: z.string().optional().describe(PARAMETERS.properties.agent.description),
    value: z.any().optional().describe(PARAMETERS.properties.value.description),
    reason: z.string().optional().describe(PARAMETERS.properties.reason.description),
  };
}

// ── The turn: who typed it, and whether outside text came into it ───────────────────────────────────
/** The hub marks pasted content in a message with <pasted_content> tags: a message that holds any is not only the person's own words. */
function pastedIn(message) { return /<pasted_content\b/i.test(String(message || '')); }
/** The tool's name as the allowlist knows it (the Claude client calls the hub's tools mcp__agent-hub__<name>). */
function shortName(tool) { return String(tool || '').replace(/^mcp__agent-hub__/, ''); }
function taintsTurn(tool) { return !UNTAINTED_TOOLS.has(shortName(tool)); }
/** Marks the turn tainted. turn: the turn's record in sdk-chat turnTrack (or null). */
function taint(turn) { if (turn && typeof turn === 'object') turn.tainted = true; }
/** A tool is about to run (or just returned) in this turn: any tool outside the allowlist may bring outside text. Never throws. */
function noteTool(turn, tool) { try { if (turn && taintsTurn(tool)) taint(turn); } catch { /* the observer never changes the turn */ } }
const isTainted = (turn) => !!(turn && turn.tainted === true);

/** Is the tool offered in this turn? The flagged lead's own turn (depth 0, not a temporary worker, not a tiger team member), started by
 *  the person: the turn's origin is "user" (never a consultation, hand-off, schedule, job, alert, task, consult reply or team set-up
 *  turn). Checked when the tool list is built and again at call time. */
function offeredFor({ agentName, depth = 0, virtual = false, tigerTeam = false, turn = null, leads = [] } = {}) {
  if (!agentName || depth !== 0 || virtual || tigerTeam) return false;
  if (!Array.isArray(leads) || !leads.includes(agentName)) return false;
  if (!turn || typeof turn !== 'object') return false;
  const kind = turn.origin && turn.origin.kind;
  if (!TURN_ORIGINS_OK.has(kind)) return false;
  return typeof turn.personKey === 'string' && turn.personKey !== '';
}

// ── Small helpers ───────────────────────────────────────────────────────────────────────────────────
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function sameValue(a, b) {
  if (a === undefined || b === undefined) return a === b;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}
function firstSentence(text, max = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  const r = m ? m[1] : s;
  return r.length > max ? `${r.slice(0, max - 3)}...` : r;
}
function show(v) {
  if (v === undefined || v === null) return 'not set';
  if (v === true) return 'on';
  if (v === false) return 'off';
  if (typeof v === 'string') return v === '' ? '(empty)' : (v.length > 160 ? `${v.slice(0, 157)}...` : v);
  let s; try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
/** A model sends "true" or "6" for a switch or a number: take it for what the setting holds now. */
function coerce(value, now) {
  if (typeof value !== 'string') return value;
  const t = value.trim().toLowerCase();
  if (typeof now === 'boolean') {
    if (['true', 'on', 'yes'].includes(t)) return true;
    if (['false', 'off', 'no'].includes(t)) return false;
  }
  if (typeof now === 'number' && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  return value;
}

/**
 * The tool. deps (all optional; the hub's own are the defaults): records, apply (lib/settings-apply), auth, agents (() => list).
 */
function createSettingsTool(deps = {}) {
  const records = deps.records || require('./settings-records');
  const settingsApply = deps.apply || require('./settings-apply');
  const getAuth = () => deps.auth || require('./auth').getAuth();
  const agentList = () => { try { return (deps.agents ? deps.agents() : require('./agents').getAgentsSync()) || []; } catch { return []; } };

  // ── The person ──
  function personOf(turn) {
    const key = turn && typeof turn.personKey === 'string' ? turn.personKey : '';
    if (!key) return null;
    let auth = null, has = false;
    try { auth = getAuth(); has = auth.hasUsers(); } catch { has = false; }
    if (!has) return { id: key, isAdmin: true, user: { id: key }, name: key };
    let u = null; try { u = auth.getUser(key); } catch { u = null; }
    if (!u) return null;
    return { id: String(u.id), isAdmin: u.role === 'admin', user: u, name: u.name || u.login || String(u.id) };
  }

  // ── Records ──
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const followMerge = (r) => { let x = r, n = 0; while (x && x.mergedInto && n++ < 5) x = records.byId(x.mergedInto) || x; return x; };
  function recordText(r) { return norm([r.name, ...(r.labels || []), ...(r.words || []), r.what].filter(Boolean).join(' ')); }
  /** Up to `limit` records for some words: the phrase appears in the record's name, labels, words or what (as the ⓘ search matches),
   *  or every word of it does; a name hit first. Admins match every record, anyone else the records a member may see. */
  function search(words, person, limit = 8) {
    const q = norm(words);
    if (!q) return [];
    const parts = q.split(' ').filter((w) => w.length >= 2);
    const pool = records.forUser(person && person.user, { isAdmin: !!(person && person.isAdmin) }).filter((r) => !r.mergedInto && r.kind === 'setting');
    const scored = [];
    for (const r of pool) {
      const text = recordText(r), name = norm(r.name);
      let score = 0;
      if (name === q) score = 100;
      else if (name.includes(q)) score = 80;
      else if (text.includes(q)) score = 60;
      else if (parts.length > 1 && parts.every((w) => text.includes(w))) score = 40;
      if (score) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score || (a.r.id < b.r.id ? -1 : 1));
    return scored.slice(0, limit).map((x) => x.r);
  }
  /** One record from an id or an exact name. { record } | { error } (several records with that name: their ids). */
  function resolve(setting, person) {
    const s = String(setting || '').trim();
    if (!s) return { error: 'Which setting? Give its id (OPT-0123) or exact name; use find to look one up.' };
    let r = /^OPT-\d+$/i.test(s) ? records.byId(s.toUpperCase()) : null;
    if (!r) {
      const visible = records.forUser(person && person.user, { isAdmin: !!(person && person.isAdmin) });
      const hits = visible.filter((x) => !x.mergedInto && norm(x.name) === norm(s));
      if (hits.length === 1) r = hits[0];
      else if (hits.length > 1) return { error: `Several settings are called "${s}": ${hits.slice(0, 6).map((h) => `${h.id} (${h.home || 'Settings'})`).join('; ')}. Use the id.` };
    }
    if (!r) return { error: `No setting is called "${s}". Use find with a few words to look for it.` };
    r = followMerge(r);
    // An admin-only record is not a member's to change... except a field of an agent they own, which settings-apply check() decides.
    if (person && !person.isAdmin && r.who === 'admin' && target(r).kind !== 'agent') return { record: r, adminOnly: true };
    return { record: r };
  }
  function resolveAgent(name) {
    const s = String(name || '').trim();
    if (!s) return null;
    const list = agentList();
    const exact = list.find((a) => a && a.name === s);
    if (exact) return exact;
    const byDisplay = list.filter((a) => a && a.display && norm(a.display) === norm(s));
    if (byDisplay.length === 1) return byDisplay[0];
    const byName = list.filter((a) => a && a.name && norm(a.name) === norm(s));
    return byName.length === 1 ? byName[0] : null;
  }
  const agentLabel = (a) => (a ? (a.display || a.name) : null);

  // ── Where to send the person ──
  function doorLink(record, agent) {
    const id = record.id;
    const surfaces = new Set((record.anchors || []).map((a) => a.surface));
    if (!surfaces.has('desktop') && !surfaces.has('phone') && surfaces.has('agent-settings')) {
      // an agent's own page: the link needs the agent
      return agent ? `[Open ${record.name}](/agent-settings.html?agent=${encodeURIComponent(agent.name)}#rec=${id})` : null;
    }
    return `[Open ${record.name}](/#settings-for=${id})`;
  }
  function screenAnswer(record, agent, why) {
    const link = doorLink(record, agent);
    if (link) return `${why} ${record.name} is changed on its screen, in ${record.home || 'Settings'}. Give the person this link: ${link}`;
    return `${why} ${record.name} is changed on an agent's own settings page, in ${record.home || 'Settings'}. Ask which agent they mean and call get again with that agent: the answer then holds the exact link.`;
  }

  // ── Class ──
  const target = (record) => settingsApply.target(record);
  function isSecret(record, agentName, person) {
    const r = settingsApply.check({ record, value: null, agent: agentName, user: person && person.user, isAdmin: !!(person && person.isAdmin) });
    return r && r.ok === false && r.error === 'secret';
  }
  /** 'at once' | 'needs your confirm' | 'only on its screen' for this person (the record decides; check() later decides the value). */
  function classOf(record, person, agentName) {
    const t = target(record);
    if (t.kind === 'device' || t.kind === 'screen') return 'screen';
    if (record.danger === 'dangerous' || record.lead === 'screen' || record.lead === 'none') return 'screen';
    if (isSecret(record, agentName, person)) return 'screen';
    if (person && !person.isAdmin && record.who === 'admin' && t.kind !== 'agent') return 'screen';
    return record.lead === 'apply' ? 'once' : 'confirm';
  }
  const CLASS_WORDS = { once: 'at once', confirm: 'needs your confirm', screen: 'only on its screen' };

  // ── Current value, for a person who may read it ──
  function readable(record, person, agent) {
    const t = target(record);
    if (t.kind === 'settings') return !!(person && person.isAdmin);
    if (t.kind === 'agent') return !!(person && (person.isAdmin || (agent && agent.owner && String(agent.owner) === person.id)));
    return t.kind === 'prefs';
  }
  /** { text, raw }: the value in words ("set" / "not set" for a secret), or null when it cannot be read here. */
  function valueNow(record, person, agent) {
    const t = target(record);
    if (t.kind === 'device' || t.kind === 'screen') return null;
    if (!readable(record, person, agent)) return null;
    if ((t.kind === 'agent' || (t.kind === 'prefs' && t.store === 'notify' && t.scope === 'agent')) && !agent) return null;
    let v;
    try { v = settingsApply.current({ record, agent: agent && agent.name, user: person && person.user }); } catch { return null; }
    if (isObj(v) && Object.keys(v).length === 1 && typeof v.set === 'boolean') return { text: v.set ? 'set' : 'not set', raw: v, secret: true };
    return { text: show(v), raw: v };
  }

  // ── find / get ──
  function find(args, turn) {
    const person = personOf(turn);
    if (!person) return NOT_OFFERED;
    const agent = args.agent ? resolveAgent(args.agent) : null;
    const hits = search(args.words || args.setting, person, 8);
    if (!hits.length) return JSON.stringify({ records: [], note: 'No setting matches those words. Try other words the person might use.' });
    return JSON.stringify({
      records: hits.map((r) => {
        const v = valueNow(r, person, agent);
        return { id: r.id, name: r.name, class: CLASS_WORDS[classOf(r, person, agent && agent.name)], current: v ? v.text : null, home: r.home || null, scope: r.scope || null };
      }),
    });
  }
  function get(args, turn) {
    const person = personOf(turn);
    if (!person) return NOT_OFFERED;
    const res = resolve(args.setting, person);
    if (res.error) return res.error;
    const r = res.record;
    const agent = args.agent ? resolveAgent(args.agent) : null;
    if (args.agent && !agent) return `No agent is called "${args.agent}".`;
    const cls = res.adminOnly ? 'screen' : classOf(r, person, agent && agent.name);
    const v = res.adminOnly ? null : valueNow(r, person, agent);
    const out = { id: r.id, name: r.name, what: r.what || null, when: r.when || null, risk: r.risk || null, def: r.def || null, current: v ? v.text : null, class: CLASS_WORDS[cls], home: r.home || null, restart: !!r.restart };
    if (cls === 'screen') {
      const link = doorLink(r, agent);
      if (link) out.open = link; else out.note = 'This is on an agent\'s own settings page: call get again with the agent to get the exact link.';
    }
    if (res.adminOnly) out.note = 'Only an admin changes this one.';
    return JSON.stringify(out);
  }

  // ── set ──
  /** The plain words of a refusal from settings-apply check(): { text, door } (door: the person should be sent to the screen). */
  function refusal(error, record, person) {
    switch (error) {
      case 'secret': return { text: 'It holds a secret (a key, a password or a token), so it is never changed from a chat.', door: true };
      case 'screen': return { text: 'It is not something Maestro can change from a chat.', door: true };
      case 'protected': return { text: 'No route writes this one except its own screen.', door: true };
      case 'admin': return { text: 'Only an admin can change it.', door: false };
      case 'not your agent': return { text: 'It belongs to an agent that is not theirs.', door: false };
      case 'no such agent': return { text: 'There is no such agent.', door: false };
      case 'sign in': return { text: 'It needs a signed-in person.', door: false };
      default: {
        const t = String(error || 'That value is not allowed.');
        const door = /sign in|admin account|own session|browser/i.test(t);
        return { text: t, door };
      }
    }
  }

  function changeFor(record, person, agent, beforeText, afterText) {
    const meaning = /^none\b/i.test(String(record.risk || '').trim()) || !record.risk ? firstSentence(record.what) : firstSentence(record.risk);
    return { name: record.name, agent: agentLabel(agent), before: beforeText, after: afterText, meaning, restart: !!record.restart };
  }

  async function set(args, ctx) {
    const turn = ctx.turn;
    const person = personOf(turn);
    if (!person) return NOT_OFFERED;
    const res = resolve(args.setting, person);
    if (res.error) return res.error;
    const record = res.record;
    if (res.adminOnly) return screenAnswer(record, null, 'Only an admin can change this.');
    const t = target(record);
    const perAgent = t.kind === 'agent' || (t.kind === 'prefs' && t.store === 'notify' && t.scope === 'agent');
    let agent = null;
    if (perAgent) {
      if (!args.agent) return `${record.name} is set for one agent at a time. Which agent? Give its name.`;
      agent = resolveAgent(args.agent);
      if (!agent) return `No agent is called "${args.agent}".`;
    } else if (args.agent) agent = resolveAgent(args.agent);   // a screen-only record on an agent's page: the link needs the agent
    const cls = classOf(record, person, agent && agent.name);
    if (cls === 'screen') {
      const why = record.danger === 'dangerous' ? 'This one is only ever changed by the person themselves.'
        : (t.kind === 'device' ? 'It is kept on each device, so Maestro cannot reach it.' : 'Maestro does not change this one.');
      return screenAnswer(record, agent, why);
    }
    if (args.value === undefined) return 'A value is needed. Use get to see what the setting holds now.';
    const now = valueNow(record, person, agent);
    const value = coerce(args.value, now && now.raw);
    const checkArgs = { record, value, agent: agent && agent.name, user: person.user, isAdmin: person.isAdmin, ownSession: false };
    const c = settingsApply.check(checkArgs);
    if (!c.ok) {
      const f = refusal(c.error, record, person);
      return f.door ? screenAnswer(record, agent, f.text) : `Not changed: ${f.text}`;
    }
    const beforeText = now ? now.text : 'not set';
    const afterText = show(c.value);
    if (now && sameValue(now.raw, c.value)) return `${record.name}${agent ? ` for ${agentLabel(agent)}` : ''} is already ${afterText}. Nothing was changed.`;

    const reason = String(args.reason || '').replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    const needCard = cls === 'confirm' || isTainted(turn);
    if (!needCard) return doApply(ctx, { record, agent, person, value, reason, beforeText, afterText });

    // The card: tied to the value it was made from.
    let shownBefore = beforeText, rawBefore = now ? now.raw : undefined;
    for (let round = 0; round < 2; round++) {
      const change = changeFor(record, person, agent, shownBefore, afterText);
      const question = round === 0
        ? `Change ${record.name}${agent ? ` for ${agentLabel(agent)}` : ''} from ${shownBefore} to ${afterText}?`
        : `It is now ${shownBefore}. Change ${record.name}${agent ? ` for ${agentLabel(agent)}` : ''} to ${afterText}?`;
      let answer;
      try {
        answer = await ctx.ask({ question, options: OPTIONS.slice(), header: 'Change a setting', allow_skip: false, fixed: true, change, adminOnly: record.who === 'admin' && person.isAdmin, forUser: person.id });   // forUser: only the person who asked can answer
      } catch { answer = 'NO_ANSWER'; }
      if (answer !== 'Confirm') return `Not changed: the person did not confirm. ${record.name}${agent ? ` for ${agentLabel(agent)}` : ''} is still ${shownBefore}.`;
      if (!ctx.stillOffered()) return `Not changed: ${NOT_OFFERED}`;
      // Read again: the person pressed Confirm on the value the card was made from only if it still holds it.
      const cur = valueNow(record, person, agent);
      const curRaw = cur ? cur.raw : undefined;
      if (sameValue(curRaw, rawBefore)) return doApply(ctx, { record, agent, person, value, reason, beforeText: shownBefore, afterText });
      if (round === 1) return `Not changed: ${record.name} changed again while the card was open. It is now ${cur ? cur.text : 'not set'}.`;
      shownBefore = cur ? cur.text : 'not set'; rawBefore = curRaw;
      const re = settingsApply.check(checkArgs);
      if (!re.ok) return `Not changed: ${refusal(re.error, record, person).text}`;
      if (sameValue(curRaw, re.value)) return `${record.name} is already ${afterText}. Nothing was changed.`;
    }
    return 'Not changed.';
  }

  async function doApply(ctx, { record, agent, person, value, reason, beforeText, afterText }) {
    const actor = { kind: 'lead', agent: ctx.agentName, user: person.id, turn: ctx.turn && ctx.turn.turnId, why: reason };
    let r;
    try {
      r = await settingsApply.apply({ record, value, agent: agent && agent.name, user: person.user, isAdmin: person.isAdmin, ownSession: false, actor, onAgentChanged: ctx.onAgentChanged || null });
    } catch (e) { return `Not changed: ${(e && e.message) || 'it could not be saved'}.`; }
    if (!r.ok) {
      const f = refusal(r.error, record, person);
      return f.door ? screenAnswer(record, agent, f.text) : `Not changed: ${f.text}`;
    }
    const ids = Array.isArray(r.journalIds) ? r.journalIds : [];
    if (ids.length && typeof ctx.emit === 'function') { try { ctx.emit(ids); } catch { /* the line in the chat is a courtesy; the journal has it */ } }
    const forAgent = agent ? ` for ${agentLabel(agent)}` : '';
    const after = r.after !== undefined ? r.after : value;
    let line;
    if (typeof after === 'boolean') line = `Turned ${after ? 'on' : 'off'} ${record.name}${forAgent}.`;
    else line = `Changed ${record.name}${forAgent} from ${beforeText} to ${show(after)}.`;
    if (!ids.length) return `${line} (It already held that value, so nothing new was written.)`;
    return `${line} ${UNDO_NOTE}${record.restart ? ' Saved; it takes effect after a restart.' : ''}`;
  }

  /**
   * Runs one call. ctx: { agentName, turn (the turn's record), stillOffered() (re-checked at call time), ask(args) (the hub's card),
   * emit(ids) (settings_changed), onAgentChanged(name, fields) }. Always resolves a text for the agent.
   */
  async function run(args, ctx) {
    try {
      if (!ctx || typeof ctx.stillOffered !== 'function' || !ctx.stillOffered()) return NOT_OFFERED;
      const a = args && typeof args === 'object' ? args : {};
      if (a.action === 'find') return find(a, ctx.turn);
      if (a.action === 'get') return get(a, ctx.turn);
      if (a.action === 'set') return await set(a, ctx);
      return 'action must be find, get or set.';
    } catch (e) {
      return `Not changed: ${(e && e.message) || 'something went wrong'}.`;
    }
  }

  return { run, find, get, set, search, resolve, classOf, personOf, doorLink };
}

let singleton = null;
function getSettingsTool() { return singleton || (singleton = createSettingsTool()); }

module.exports = {
  TOOL: { name: TOOL_NAME, description: DESCRIPTION, parameters: PARAMETERS },
  TOOL_NAME, DESCRIPTION, PARAMETERS, OPTIONS, NOT_OFFERED, UNTAINTED_TOOLS, UNDO_NOTE,
  zodShape, createSettingsTool, getSettingsTool,
  offeredFor, pastedIn, taintsTurn, taint, noteTool, isTainted, shortName,
};
