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
// What a tool of this list returns is never outside text: everything else taints the turn (memory, job and list tools can carry text from outside).
const UNTAINTED_TOOLS = new Set(['change_setting', 'ask_user', 'for_owner']);
/** Fixed words kept in the journal for a change by the lead: the free reason of the agent is never passed on (it could hold a secret). */
const JOURNAL_WHY = 'asked in chat';
const TURN_ORIGINS_OK = new Set(['user']);

const DESCRIPTION = 'Look up and change a setting for the person who is typing to you (find, get, set). Use it when they ask to change, turn on or off, raise or lower something in Maestro; use find first when you do not know the record. '
  + 'A setting that is safe is changed at once and the chat shows one line with Undo; one that needs care shows the person a card with the old and new value and waits for Confirm; '
  + 'a setting that is only theirs to change (keys, passwords, wallets, access, safety switches) is never changed by you: the answer holds the exact markdown link that opens its screen, so include that link in your reply. '
  + 'An admin\'s own agent\'s box (OPT-0053), shared and other folders (OPT-0017, OPT-0018, one path at a time with value {add: path} or {remove: path}) and command lockbox (OPT-0054) can be changed with the owner\'s confirm: always a card, never at once; a member\'s agent stays on its own screen. '
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
/** The person's own typed words: the message without any pasted block. */
function typedText(message) {
  return String(message || '').replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content[^>]*>|$)/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
}
// Concrete code from the reviewer (GPT-6, round 2, R2-1), integrated as given.
// Call only after the existing person, turn, voice, taint and permission checks.
// Pass the validated, typed value. Record aliases must identify this setting
// in the current scope; resolve collisions to a card before calling.
// current is intentionally unused: "toggle", "more" and "less" need a card.
function intentFor({ typed, record, value, current }) {
  if (typeof typed !== 'string' || !record || typed.length > 500) return 'card';
  if (/[^\x20-\x7e]/.test(typed)) return 'card';

  const norm = s => s.trim().toLowerCase().replace(/ +/g, ' ');
  const text = norm(typed).replace(/^please /, '').replace(/[.!]$/, '');
  if (/[?;!]/.test(text)) return 'card';
  if (/\b(how|what|why|should|can|could|would|is|does|not|never|don't|dont|no longer|if|unless|except|instead|then|also|and)\b/.test(text)) {
    return 'card';
  }

  const aliases = [record.name, ...(record.labels || []), ...(record.words || [])]
    .filter(s => typeof s === 'string' && s.trim().length >= 3)
    .map(norm);

  // Compare whole commands. A matching fragment in a question, quotation,
  // second instruction or discussion is insufficient.
  for (const alias of aliases) {
    const name = /^(the|my) /.test(alias) ? alias : `the ${alias}`;
    for (const target of new Set([alias, name])) {
      if (typeof value === 'boolean') {
        const state = value ? 'on' : 'off';
        const verbs = value ? ['enable', 'show', 'allow', 'start', 'use']
                            : ['disable', 'hide', 'block', 'stop'];
        if (verbs.some(verb => text === `${verb} ${target}`)) return 'at_once';
        if (text === `turn ${target} ${state}` || text === `turn ${state} ${target}` ||
            text === `set ${target} to ${state}`) return 'at_once';
        continue;
      }

      if (typeof value === 'number' && Number.isFinite(value)) {
        const prefix = `set ${target} to `;
        if (!text.startsWith(prefix)) continue;
        const number = text.slice(prefix.length);
        if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(number) &&
            number === String(value)) return 'at_once';
        continue;
      }

      // Exact single-token values only. Free text, multiword values and
      // display labels without a trusted value mapping take the card path.
      if (typeof value === 'string' && /^[a-z0-9_-]+$/i.test(value)) {
        // Preserve value case: a case-sensitive string must match exactly.
        const raw = typed.trim().replace(/^please +/i, '').replace(/[.!]$/, '');
        if (text === `set ${target} to ${value.toLowerCase()}` &&
            raw.endsWith(` ${value}`)) return 'at_once';
      }
    }
  }
  return 'card';
}
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
    try { auth = getAuth(); has = auth.hasUsers(); } catch { return null; }   // a failed lookup denies, never grants
    if (!has) return { id: key, isAdmin: true, user: { id: key }, name: key };
    let u = null; try { u = auth.getUser(key); } catch { u = null; }
    if (!u || u.disabled) return null;
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
    const pool = records.forUser(person && person.user, { isAdmin: !!(person && person.isAdmin) }).filter((r) => !r.mergedInto && (r.kind === 'setting' || target(r).kind === 'action'));
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
  /** An agent a member owns (the owner is not an admin account): the same test the server uses (memberOwned). Fails closed: unknown is a member's. */
  function isMemberAgent(a) {
    if (!a || !a.owner) return false;
    try { return !getAuth().admins().some((u) => String(u.id) === String(a.owner)); } catch { return true; }
  }

  // ── Where to send the person ──
  function doorLink(record, agent) {
    const id = record.id;
    const surfaces = new Set((record.anchors || []).map((a) => a.surface));
    // P4-6b: the agent card's records carry no anchor (the card finds its rows by record id); their home says so
    if (!surfaces.has('desktop') && !surfaces.has('phone') && (surfaces.has('agent-settings') || /^Agent card/.test(record.home || ''))) {
      // an agent's own page: the link needs the agent
      return agent ? `[Open ${agentLabel(agent)}'s settings](/#agent-card=${encodeURIComponent(agent.name)}&row=${id})` : null;
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
    // Stop all agents: for an admin, Stop is at once (a card when the turn is tainted) and Resume is always a card; set() decides per value
    if (t.kind === 'action') return person && person.isAdmin ? 'once' : 'screen';
    if (t.kind === 'device' || t.kind === 'screen') return 'screen';
    // P4-lead: an agent's Access rows (box, folders, command lockbox): a card (never at once) for an admin person and an agent that is not a member's; screen otherwise
    if (record.leadAgentAccess === true) {
      if (record.lead !== 'confirm' || t.kind !== 'agent' || !person || !person.isAdmin || !agentName) return 'screen';
      const a = resolveAgent(agentName);
      return a && !isMemberAgent(a) ? 'confirm' : 'screen';
    }
    if (record.danger === 'dangerous' || record.lead === 'screen' || record.lead === 'none') return 'screen';
    if (isSecret(record, agentName, person)) return 'screen';
    if (person && !person.isAdmin && record.who === 'admin' && t.kind !== 'agent') return 'screen';
    return record.lead === 'apply' ? 'once' : 'confirm';
  }
  const CLASS_WORDS = { once: 'at once', confirm: 'needs your confirm', screen: 'only on its screen' };
  const ACTION_CLASS_WORDS = 'Stop (set it to "stopped"): at once; Resume (set it to "running"): needs your confirm';
  const classText = (record, person, agentName) => { const c = classOf(record, person, agentName); return target(record).kind === 'action' && c === 'once' ? ACTION_CLASS_WORDS : CLASS_WORDS[c]; };

  // ── Stop all agents / Resume (the kill switch as an action record) ──
  /** The person's own typed words of this turn are exactly a Stop command (nothing else in them). */
  function typedIsStop(typed) {
    if (typeof typed !== 'string' || typed.length > 200 || /[^\x20-\x7e]/.test(typed)) return false;
    const text = typed.trim().toLowerCase().replace(/ +/g, ' ').replace(/^please /, '').replace(/[.!]$/, '');
    if (/[?;!]/.test(text)) return false;
    return ['stop all agents', 'stop all the agents', 'halt all agents', 'stop everything', 'emergency stop', 'use the kill switch', 'stop all agents now', 'stop everything now'].includes(text);
  }
  function heldTaskCount() {
    try {
      const list = deps.heldTasks ? deps.heldTasks() : require('./sdk-chat').getScheduledTasks().heldList();
      return Array.isArray(list) ? list.length : Number(list) || 0;
    } catch { return 0; }
  }
  /** The running jobs an admin marked "keep running when all agents are stopped": they stay up through a Stop. */
  function keptJobNames() {
    try {
      const list = deps.keptJobs ? deps.keptJobs() : require('./sdk-chat').getJobRunner().haltView().kept;
      return (Array.isArray(list) ? list : []).map((j) => String((j && j.name) || j)).filter(Boolean);
    } catch { return []; }
  }
  const keptLine = (names) => names.length ? `${names.length} job${names.length === 1 ? '' : 's'} marked keep ${names.length === 1 ? 'stays' : 'stay'} running: ${names.join(', ')}.` : '';
  async function setAction(args, ctx, record, person) {
    const turn = ctx.turn;
    if (!person.isAdmin) return 'Not changed: only an admin can stop or resume all agents.';
    const c = settingsApply.check({ record, value: args.value, user: person.user, isAdmin: person.isAdmin, ownSession: false });
    if (!c.ok) return `Not changed: ${refusal(c.error, record, person).text}`;
    const to = c.value;
    const now = settingsApply.current({ record, user: person.user });
    if (now === to) return to === 'stopped' ? 'All agents are already stopped. Nothing was changed.' : 'All agents are already running. Nothing was changed.';
    let question, change;
    if (to === 'stopped') {
      const kept = keptLine(keptJobNames());
      question = `Stop all agents? Everything they are doing stops now and nothing new starts until you Resume.${kept ? ` ${kept}` : ''}`;
      change = { name: record.name, agent: null, before: 'running', after: 'stopped', meaning: 'Every running turn, worker, job and research run stops, and nothing new starts until Resume.', restart: false };
    } else {
      const held = heldTaskCount();
      question = `Resume all agents? ${held ? `${held} scheduled task${held === 1 ? '' : 's'} that came due while stopped will run, one at a time, at least 30 seconds apart.` : 'No scheduled task is waiting.'}`;
      change = { name: record.name, agent: null, before: 'stopped', after: 'running', meaning: held ? `${held} held task${held === 1 ? '' : 's'} will run one at a time, at least 30 seconds apart.` : 'Agents can work again.', restart: false };
    }
    // Stop goes at once only when the person's own typed words of this turn are that command in a clean turn; Resume is always a card.
    const atOnce = to === 'stopped' && turn && !isTainted(turn) && turn.voice !== true && typedIsStop(turn.typed);
    if (!atOnce) {
      let answer;
      try { answer = await ctx.ask({ question, options: OPTIONS.slice(), header: to === 'stopped' ? 'Stop all agents' : 'Resume all agents', allow_skip: false, fixed: true, change, adminOnly: true, forUser: person.id }); } catch { answer = 'NO_ANSWER'; }
      if (answer !== 'Confirm') return `Not changed: the person did not confirm. All agents are still ${now === 'stopped' ? 'stopped' : 'running'}.`;
      if (!ctx.stillOffered()) return `Not changed: ${NOT_OFFERED}`;
    }
    const p2 = personOf(ctx.turn);
    if (!p2 || p2.id !== person.id || !p2.isAdmin) return `Not changed: ${NOT_OFFERED}`;
    if (settingsApply.current({ record, user: person.user }) === to) return `Already ${to === 'stopped' ? 'stopped' : 'running'}. Nothing was changed.`;
    const held = to === 'running' ? heldTaskCount() : 0;
    const actor = { kind: 'lead', agent: ctx.agentName, user: person.id, turn: ctx.turn && ctx.turn.turnId, why: JOURNAL_WHY };
    let r;
    try { r = await settingsApply.apply({ record, value: to, user: person.user, isAdmin: person.isAdmin, ownSession: false, actor, by: person.name }); }
    catch (e) { return `Not changed: ${(e && e.message) || 'it could not be done'}.`; }
    if (!r.ok) return `Not changed: ${refusal(r.error, record, person).text}`;
    if (to === 'stopped') { const kept = keptLine(keptJobNames()); return `Stopped all agents. Everything running was stopped and nothing new starts until Resume.${kept ? ` ${kept}` : ''} To resume, press Resume in Settings > Emergency or on the red banner.`; }
    return `Resumed all agents.${held ? ` ${held} held task${held === 1 ? '' : 's'} will run now, one at a time, at least 30 seconds apart.` : ''}`;
  }

  // ── Current value, for a person who may read it ──
  function readable(record, person, agent) {
    const t = target(record);
    if (t.kind === 'settings' || t.kind === 'env') return !!(person && person.isAdmin);
    if (t.kind === 'agent') return !!(person && (person.isAdmin || (agent && agent.owner && String(agent.owner) === person.id)));
    if (t.kind === 'action') return !!(person && person.isAdmin);
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

  /** Two records answer the same words: the words of the command that matched (a name, label or word of this record) are also a name, label
   *  or word of another record the person can see, so the words cannot tell which one they meant: a card. Only the aliases the typed command
   *  really used count (a generic word like "tab" in a record's word list does not matter when the command used its name). */
  function aliasCollides(record, person, typed, value) {
    const aliasesOf = (r) => [r.name, ...(r.labels || []), ...(r.words || [])].filter((s) => typeof s === 'string' && s.trim().length >= 3).map(norm);
    const used = new Set(aliasesOf(record).filter((a) => intentFor({ typed, record: { name: a }, value }) === 'at_once'));
    if (!used.size) return true;
    const pool = records.forUser(person && person.user, { isAdmin: !!(person && person.isAdmin) });
    return pool.some((r) => r.id !== record.id && !r.mergedInto && r.kind === 'setting' && aliasesOf(r).some((a) => used.has(a)));
  }
  /** R3-1: the person's own typed command names this agent (name or display name, case-insensitive, whole word) and exactly that one agent
   *  matches. A leading "the " / "my " is stripped on both sides, so "x" and "the x" are the same name (two agents so named: no match).
   *  Returns the typed command without the agent's mention (" for forge") for intentFor, or null when the agent is not named by the person. */
  function typedNamingAgent(typed, agent) {
    if (typeof typed !== 'string' || !agent || !agent.name) return null;

    const text = typed.trim().replace(/\s+/g, ' ');
    const normalize = (s) => String(s || '').trim().replace(/\s+/g, ' ')
      .toLowerCase().replace(/^(?:the|my) /, '');
    const matches = [];

    // Try every terminal target phrase. "for Head of Sales" can match
    // both "Head of Sales" and "Sales"; in that case use the card.
    for (const m of text.matchAll(/\s+(?:for|of|on|in)\s+/gi)) {
      const target = normalize(text.slice(m.index + m[0].length).replace(/[.!]$/, ''));
      if (target.length < 3) continue;
      for (const a of agentList()) {
        if (!a || !a.name) continue;
        if ([a.name, a.display].some((alias) => normalize(alias) === target)) {
          matches.push({ name: a.name, command: text.slice(0, m.index) });
        }
      }
    }
    if (matches.length !== 1 || matches[0].name !== agent.name) return null;
    return matches[0].command || null;
  }
  /** Is a value that find/get returns free of stored text written by someone else? A boolean, a number, "set" / "not set" for a secret,
   *  or one of a record's fixed choices (a preference store that checks the value against its own list). Any other string may be outside text. */
  function isFixedValue(record, raw, person, agent) {
    if (raw === undefined || raw === null || typeof raw === 'boolean') return true;
    if (typeof raw === 'number') return Number.isFinite(raw);
    if (isObj(raw)) return Object.keys(raw).length === 1 && typeof raw.set === 'boolean';
    if (typeof raw === 'string' && target(record).kind === 'action') return raw === 'stopped' || raw === 'running';
    if (typeof raw !== 'string' || target(record).kind !== 'prefs') return false;
    try { return settingsApply.check({ record, value: raw, agent: agent && agent.name, user: person && person.user, isAdmin: !!(person && person.isAdmin), ownSession: false }).ok === true; } catch { return false; }
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
        if (v && !isFixedValue(r, v.raw, person, agent)) taint(turn);   // stored free text of someone else
        return { id: r.id, name: r.name, class: classText(r, person, agent && agent.name), current: v ? v.text : null, home: r.home || null, scope: r.scope || null };
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
    if (v && !isFixedValue(r, v.raw, person, agent)) taint(turn);   // stored free text of someone else
    const out = { id: r.id, name: r.name, what: r.what || null, when: r.when || null, risk: r.risk || null, def: r.def || null, current: v ? v.text : null, class: target(r).kind === 'action' && cls === 'once' ? ACTION_CLASS_WORDS : CLASS_WORDS[cls], home: r.home || null, restart: !!r.restart };
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
    // the agent's hands (tools) change rebuilds its box, which ends its current session
    const tools = record.storedAs === 'agents[].tools' && agent;
    return { name: record.name, agent: agentLabel(agent), before: beforeText, after: afterText, meaning: tools ? `${meaning} This restarts ${agentLabel(agent)}'s current session.`.slice(0, 300) : meaning, restart: !!record.restart || !!tools };
  }

  // ── An agent's Access rows (box, folders, command lockbox): P4-lead ──
  const accessField = (record) => target(record).field;
  const BOX_WORDS = { container: 'in a box', off: 'outside a box', inherit: 'the default' };
  /** The agent as stored now (a fresh read: the policy for the compare-and-set, the box for the card). */
  function agentRecord(name) {
    try { return deps.agentRecord ? deps.agentRecord(name) : require('./agents').loadAgentsFromDisk().find((a) => a.name === name) || null; } catch { return null; }
  }
  const policyOf = (name) => { const a = agentRecord(name); return JSON.parse(JSON.stringify((a && a.policy) || {})); };
  /** Does the agent run in a box now (the resolved mode, not just the stored word)? */
  function isBoxed(name) {
    const a = agentRecord(name);
    try { return deps.boxed ? !!deps.boxed(a) : require('./sandbox').getSandbox().isSandboxed(a); } catch { return !!(a && a.sandbox === 'container'); }
  }
  function folderPaths() {
    try {
      if (deps.folders) return deps.folders().map((f) => f.path);
      const adminIds = new Set(getAuth().admins().map((u) => String(u.id)));
      return require('./folders').listFolders({ agents: agentList(), adminIds }).map((f) => f.path);
    } catch { return []; }
  }
  /** The value of an Access row as the person's words say it: box and lockbox words, or the roots list for an add / remove of one path. */
  function accessNow(record, now) {
    const f = accessField(record), raw = now ? now.raw : undefined;
    if (f === 'sandbox' || f === 'lockbox') return raw === undefined || raw === null || raw === '' ? 'inherit' : raw;
    return Array.isArray(raw) ? raw.slice() : [];
  }
  function accessShow(record, v) {
    const f = accessField(record);
    if (f === 'sandbox') return BOX_WORDS[v] || show(v);
    if (f === 'lockbox') return v === 'inherit' ? 'the hub default' : String(v);
    return Array.isArray(v) && v.length ? v.join(', ') : 'none';
  }
  /** The new value from the model's words: { value, op? } or { error }. Roots: op {add|remove: path} applied to the roots now. */
  function accessInput(record, rawValue, nowRoots) {
    const f = accessField(record);
    if (f === 'sandbox') {
      const w = String(rawValue == null ? '' : rawValue).trim().toLowerCase().replace(/\s+/g, ' ');
      const map = { container: 'container', box: 'container', boxed: 'container', 'in a box': 'container', on: 'container', true: 'container',
        off: 'off', 'outside a box': 'off', 'no box': 'off', unboxed: 'off', false: 'off', inherit: 'inherit', default: 'inherit', 'the default': 'inherit' };
      return map[w] ? { value: map[w] } : { error: 'Not changed: the box is "container" (in a box), "off" (outside a box) or "inherit" (the default).' };
    }
    if (f === 'lockbox') {
      const w = String(rawValue == null ? '' : rawValue).trim().toLowerCase();
      return ['inherit', 'off', 'watch', 'enforce'].includes(w) ? { value: w } : { error: 'Not changed: the command lockbox is "inherit", "off", "watch" (only report) or "enforce" (block).' };
    }
    let op = rawValue;
    if (typeof op === 'string') { try { op = JSON.parse(op); } catch { /* not json */ } }
    const keys = isObj(op) ? Object.keys(op) : [];
    if (keys.length !== 1 || !['add', 'remove'].includes(keys[0]) || typeof op[keys[0]] !== 'string' || !op[keys[0]].trim()) {
      return { error: 'Not changed: folders change one path at a time. Give the value as {"add": "<path>"} or {"remove": "<path>"}.' };
    }
    const p = op[keys[0]].trim();
    if (p.length >= 400) return { error: 'Not changed: that path is too long.' };
    if (f === 'policy.roots' && record.id === 'OPT-0017' && !folderPaths().includes(p)) return { error: 'Not changed: that is not one of the shared folders in the list. Use "Other folders it can see" for a path of your own.' };
    if (keys[0] === 'add') return { value: nowRoots.includes(p) ? nowRoots : [...nowRoots, p], op: { add: p } };
    if (!nowRoots.includes(p)) return { error: `Not changed: ${p} is not in the list of folders.` };
    return { value: nowRoots.filter((r) => r !== p), op: { remove: p } };
  }
  /** What the card says gets looser, and that the session restarts (plain words, no real names). */
  function accessMeaning(record, agent, value, op, boxedNow) {
    const n = agentLabel(agent), f = accessField(record);
    const short = (p) => (p.length > 120 ? `${p.slice(0, 117)}...` : p);
    const session = `This restarts ${n}'s current session.`;
    if (f === 'sandbox') {
      if (value === 'container') return boxedNow ? `${n} stays in a box. ${session}` : `${n} runs outside a box now; boxing it restarts its session.`;
      if (value === 'off') return `${n}'s commands and file work would run directly on this computer, outside its box. ${session}`;
      return `${n} would follow the family default for a box; if that is no box, its commands and file work would run directly on this computer. ${session}`;
    }
    if (f === 'lockbox') {
      if (value === 'off') return `The command lockbox would stop limiting ${n}'s commands.`;
      if (value === 'watch') return `The command lockbox would only report what it would block for ${n}, not stop it.`;
      if (value === 'enforce') return `The command lockbox would block ${n}'s commands it cannot keep inside its limits.`;
      return `${n} would follow the hub's command lockbox default.`;
    }
    if (op && op.add) return `${n} could change files in ${short(op.add)} without asking. ${session}`;
    return `${n} would no longer reach ${short((op && op.remove) || '')}. ${session}`;
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
    if (t.kind === 'action') {
      if (args.value === undefined) return 'A value is needed: "stopped" to stop all agents, "running" to resume. Use get to see the state now.';
      return await setAction(args, ctx, record, person);
    }
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
    const access = record.leadAgentAccess === true;   // P4-lead rows: the card is always shown, and the write carries the proof of the owner's Confirm
    const now = valueNow(record, person, agent);
    // Stored folder paths (shared and other folders) are free text; an answer or an error of this call may carry them: the turn has read outside text.
    const rootsText = access && accessField(record) === 'policy.roots';
    let accessOp = null, value;
    if (access) {
      const inp = accessInput(record, args.value, accessNow(record, now));
      if (inp.error) { if (rootsText) taint(turn); return inp.error; }
      value = inp.value; accessOp = inp.op || null;
    } else value = coerce(args.value, now && now.raw);
    const checkArgs = { record, value, agent: agent && agent.name, user: person.user, isAdmin: person.isAdmin, ownSession: false, internal: access ? settingsApply.leadConfirmed() : null };
    const c = settingsApply.check(checkArgs);
    if (!c.ok) {
      const f = refusal(c.error, record, person);
      return f.door ? screenAnswer(record, agent, f.text) : `Not changed: ${f.text}`;
    }
    const beforeText = access ? accessShow(record, accessNow(record, now)) : (now ? now.text : 'not set');
    let afterText = access ? accessShow(record, c.value) : show(c.value);
    // The result echoes the stored text and the new text: free text that is not a fixed value taints the turn (like find/get). The taint
    // marks what comes after this result; this call's own decision below is made from the person's words before it.
    const echoesText = !access && ((now && !isFixedValue(record, now.raw, person, agent)) || !isFixedValue(record, c.value, person, agent));
    if (access && sameValue(accessNow(record, now), c.value)) { if (rootsText) taint(turn); return `${record.name} for ${agentLabel(agent)} is already ${afterText}. Nothing was changed.`; }
    if (!access && now && sameValue(now.raw, c.value)) { if (echoesText) taint(turn); return `${record.name}${agent ? ` for ${agentLabel(agent)}` : ''} is already ${afterText}. Nothing was changed.`; }

    // The agent the change is for, as it is now: the card and the commit are for this one agent only (a name made again is another agent).
    let stamp = agent ? stampOfAgent(agent.name) : undefined;
    // At once only when the person's own typed words of this turn name the setting and ask for a change; a voice turn, a tainted turn and
    // the Codex path always show the card.
    // A per-agent record goes at once only when the person's typed command names the agent too (R3-1): the model picks the agent otherwise.
    const typedForIntent = perAgent
      ? typedNamingAgent(turn && turn.typed, agent)
      : turn && turn.typed;
    const needCard = cls === 'confirm' || isTainted(turn) || !turn || turn.voice === true
      || typedForIntent === null
      || intentFor({ typed: typedForIntent, record, value: c.value, current: now && now.raw }) !== 'at_once'
      || aliasCollides(record, person, typedForIntent, c.value);
    if (echoesText || rootsText) taint(turn);
    if (!needCard) return doApply(ctx, { record, agent, person, value, beforeText, afterText, stamp });

    // The card: tied to the value it was made from.
    let shownBefore = beforeText, rawBefore = access ? accessNow(record, now) : (now ? now.raw : undefined);
    let policyIfMatch = access && accessField(record) === 'policy.roots' ? policyOf(agent.name) : undefined;   // the policy the card was made from (compare-and-set)
    let boxedNow = access && accessField(record) === 'sandbox' ? isBoxed(agent.name) : false;
    for (let round = 0; round < 2; round++) {
      const change = changeFor(record, person, agent, shownBefore, afterText);
      if (access) { change.meaning = accessMeaning(record, agent, value, accessOp, boxedNow); change.restart = ['sandbox', 'policy.roots'].includes(accessField(record)); }
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
      const curRaw = access ? accessNow(record, cur) : (cur ? cur.raw : undefined);
      const curText = access ? accessShow(record, curRaw) : (cur ? cur.text : 'not set');
      if (sameValue(curRaw, rawBefore)) return doApply(ctx, { record, agent, person, value, beforeText: shownBefore, afterText, stamp, access, policyIfMatch });
      if (round === 1) return `Not changed: ${record.name} changed again while the card was open. It is now ${curText}.`;
      shownBefore = curText; rawBefore = curRaw;
      if (access) {
        // the new card is made from what is stored now: the one path is added or removed again on the list as it is
        const again = accessInput(record, args.value, curRaw);
        if (again.error) return again.error;
        value = again.value; accessOp = again.op || null;
        if (policyIfMatch !== undefined) policyIfMatch = policyOf(agent.name);
        stamp = stampOfAgent(agent.name);   // the second card is made from the agent as it is now
        boxedNow = accessField(record) === 'sandbox' ? isBoxed(agent.name) : false;
      }
      const re = settingsApply.check({ ...checkArgs, value, internal: access ? settingsApply.leadConfirmed() : null });
      if (!re.ok) return `Not changed: ${refusal(re.error, record, person).text}`;
      if (sameValue(curRaw, re.value)) return `${record.name} is already ${access ? accessShow(record, re.value) : afterText}. Nothing was changed.`;
      if (access) afterText = accessShow(record, re.value);
    }
    return 'Not changed.';
  }

  /** The agent's stable stamp now (agents stampOf), or null when there is none. */
  function stampOfAgent(name) {
    try { return deps.agentStamp ? deps.agentStamp(name) : require('./agents').agentStamp(name); } catch { return null; }
  }

  async function doApply(ctx, { record, agent, person: asked, value, beforeText, afterText, stamp, access = false, policyIfMatch }) {
    // At commit: read the account again (a card may have waited a long time). The person must still be that person, enabled, and what
    // they may do is judged again on what the account is now; the agent must still be the one the card was made for.
    const person = personOf(ctx.turn);
    if (!person || person.id !== asked.id) return `Not changed: ${NOT_OFFERED}`;
    if (agent) {
      const now = stampOfAgent(agent.name);
      if (!now || (stamp !== undefined && now !== stamp)) return 'Not changed: the agent changed while the card was open.';
    }
    // The Access rows get the proof of the owner's Confirm only here: doApply is reached for them only after Confirm on the fixed card, and only
    // when the class still says confirm (an admin person, an agent that is not a member's) at the moment of the write.
    if (access && classOf(record, person, agent && agent.name) !== 'confirm') return screenAnswer(record, agent, 'Maestro does not change this one.');
    const internal = access ? settingsApply.leadConfirmed() : null;
    const again = settingsApply.check({ record, value, agent: agent && agent.name, user: person.user, isAdmin: person.isAdmin, ownSession: false, internal });
    if (!again.ok) {
      const f = refusal(again.error, record, person);
      return f.door ? screenAnswer(record, agent, f.text) : `Not changed: ${f.text}`;
    }
    const actor = { kind: 'lead', agent: ctx.agentName, user: person.id, turn: ctx.turn && ctx.turn.turnId, why: JOURNAL_WHY };
    let r;
    try {
      r = await settingsApply.apply({ record, value, agent: agent && agent.name, user: person.user, isAdmin: person.isAdmin, ownSession: false, internal, policyIfMatch, actor, expectStamp: agent ? stamp : undefined, onAgentChanged: ctx.onAgentChanged || null });
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
    // Saved, but the history line could not be written: no Undo is promised and no line goes to the chat strip (apply() gives no ids).
    if (r.history === false) return `${line} It is saved, but the history line could not be written, so there is no Undo for it; it can be changed back the same way or on its screen.${record.restart ? ' It takes effect after a restart.' : ''}`;
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
  JOURNAL_WHY, typedText, intentFor, offeredFor, pastedIn, taintsTurn, taint, noteTool, isTainted, shortName,
};
