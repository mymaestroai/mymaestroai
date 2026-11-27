/**
 * ui-settings-groups.js — the eight groups of the desktop Settings dialog (pure; no DOM).
 *
 * openSettings() (app.js) still draws its sections one after the other, each with an id "st-<name>-section". This module says
 * which of the eight groups every section belongs to, which sections sit under a group's closed "More", which single rows are
 * lifted out of a section into another group (Agent Defaults dissolves), which group opens first, and which sections a search
 * shows. app.js reads it; tests read it too. Node (tests): module.exports.
 *
 *   GROUPS   [{ id, title, icon, sub, sections: [section id], more: [section id] }] in display order
 *   ROWS     [{ selector, to: groupId, more?: bool, part, partTitle }]  rows moved (with their hints) into a small section
 *            "st-moved-<part>" inside the target group (under its More when more is true); every element id stays
 *   groupOfSection(id)  -> { group, more } (a section nobody knows goes to Upkeep, under More: nothing is ever lost)
 *   defaultGroup({ crit, last }) -> the group to open first: the first with a red summary, else the last one opened, else "you"
 *   moreLabel(group, nameOf) -> "More: A, B" for a closed More button (null when the group has no More content)
 *   search(q, entries) -> [{ group, ids }] the sections a search shows under each group (entries: [{ id, text }])
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.hubSettingsGroups = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GROUPS = [
    { id: 'review', title: 'For your review', icon: '\u{1F514}', sub: 'Problems, new features, recent changes',
      // the list of problems and new features is drawn above these (app.js); the full checks sit under More, where Details opens them
      // Stop all agents (the Emergency section, monthly cap work) sits at the very top of this group
      sections: ['st-emergency-section', 'st-recent-section'], more: ['st-ready-section', 'st-health-section', 'st-sec-section'] },
    { id: 'you', title: 'You and this device', icon: '\u{1F642}', sub: 'Light or dark, text size, notifications, sign-in',
      sections: ['st-looks-section', 'st-notify-section', 'st-chat-section'], more: [] },
    { id: 'agents', title: 'Agents and teams', icon: '\u{1F916}', sub: 'Agents, defaults, teams',
      sections: ['st-workers-section'], more: [] },
    { id: 'money', title: 'Models and money', icon: '\u{1F4B3}', sub: 'Subscriptions, keys, plan usage, caps',
      // P4-14 order: subscriptions and plan usage, spend and caps, local models, then the keys; the local server addresses sit under More
      sections: ['st-subs-section', 'st-plan-section', 'st-spend-section', 'st-local-models-section', 'st-prov-section', 'st-or-section'],
      more: ['st-classifier-section', 'st-tuning-section'] },
    { id: 'voice', title: 'Voice and calls', icon: '\u{1F399}', sub: 'Voices, talk mode, microphone, call display',
      sections: ['st-voice-section'], more: [] },
    { id: 'tools', title: 'Tools and connections', icon: '\u{1F50C}', sub: 'Web search, connectors, computers',
      sections: ['st-ws-section', 'st-comms-section', 'st-cx-section', 'st-modules-section'], more: [] },
    { id: 'safety', title: 'People and safety', icon: '\u{1F6E1}', sub: 'People, boxes, approvals, security check',
      sections: ['st-users-section', 'st-sb-section', 'st-lb-section', 'st-mp-section', 'st-approvals-section', 'st-security-section'], more: [] },
    // st-defaults-section is what is left of Agent Defaults once its rows have moved; it is removed when it is empty.
    { id: 'upkeep', title: 'Upkeep', icon: '\u{1F9F0}', sub: 'Backups, updates, health, expert values',
      sections: ['st-maestro-section', 'st-backups-section', 'st-memory-section', 'st-selfcheck-section', 'st-components-section', 'st-updates-section'],
      more: ['st-defaults-section', 'st-expert-section'] },
  ];

  // Rows lifted out of their section into another group (P4-4). The row is the element's .st-row (or the element itself when it
  // is a block) plus the .st-hint lines that follow it; ids, names and loaders are untouched, so saving keeps working.
  const ROWS = [
    { selector: '#st-reasoning', to: 'you', part: 'reasoning', partTitle: 'Reasoning' },
    { selector: '#st-sidebar-teams', to: 'agents', part: 'teams', partTitle: 'Teams' },
    { selector: '#st-sidebar-tiger', to: 'agents', part: 'teams', partTitle: 'Teams' },
    { selector: '#st-notify-agent', to: 'agents', part: 'own-notify', partTitle: 'Agents with their own setting' },
    { selector: '#st-nb-agent-box', to: 'agents', part: 'own-notify', partTitle: 'Agents with their own setting' },
    { selector: '#prescan-toggle', to: 'agents', more: true, part: 'ship-off', partTitle: 'Features that ship off' },
    { selector: '#caveman-toggle', to: 'agents', more: true, part: 'ship-off', partTitle: 'Features that ship off' },
    { selector: '#st-maxTokens', to: 'money', more: true, part: 'limits', partTitle: 'Limits and suggestions' },
    { selector: '#st-maxContext', to: 'money', more: true, part: 'limits', partTitle: 'Limits and suggestions' },
    { selector: '#st-model-offers', to: 'money', more: true, part: 'limits', partTitle: 'Limits and suggestions' },
    { selector: '#st-url-lmstudio', to: 'money', more: true, part: 'local-servers', partTitle: 'Local server addresses' },
    { selector: '#st-url-ollama', to: 'money', more: true, part: 'local-servers', partTitle: 'Local server addresses' },
    { selector: '#st-url-omlx', to: 'money', more: true, part: 'local-servers', partTitle: 'Local server addresses' },
    { selector: '#st-research-remind', to: 'tools', part: 'research', partTitle: 'Deep research' },
    { selector: '#st-research-ownwork', to: 'tools', part: 'research', partTitle: 'Deep research' },
    { selector: '#st-research-thorough', to: 'tools', part: 'research', partTitle: 'Deep research' },
    { selector: '#st-look-new', to: 'safety', part: 'new-members', partTitle: 'New members' },
  ];

  // The groups that hold something the dialog's shared Save writes (saveSettings in app.js): the provider keys and server addresses and
  // the token/context limits (Models and money), workers at once and the hand-off fields (Agents and teams). Every other box saves on its own,
  // so the phone shows Save on those pages only.
  const SHARED_SAVE_GROUPS = ['money', 'agents'];
  /** Does this group's page need the shared Save button? */
  function usesSharedSave(group) { return SHARED_SAVE_GROUPS.includes(group); }

  const DEFAULT_GROUP = 'you';
  const STORE_KEY = 'hub-settings-group';
  const byId = (id) => GROUPS.find((g) => g.id === id) || null;
  const movedId = (r) => `st-moved-${r.part}`;

  /** The ids of every section the dialog may draw, one list for the whole page (tests compare it with openSettings). */
  function allSectionIds() {
    return GROUPS.flatMap((g) => [...g.sections, ...g.more]);
  }

  /** { group, more } for a section id; "st-moved-<part>" sections follow ROWS; anything unknown lands in Upkeep under More. */
  function groupOfSection(id) {
    for (const g of GROUPS) {
      if (g.sections.includes(id)) return { group: g.id, more: false };
      if (g.more.includes(id)) return { group: g.id, more: true };
    }
    const r = ROWS.find((x) => movedId(x) === id);
    if (r) return { group: r.to, more: !!r.more };
    return { group: 'upkeep', more: true };
  }

  /** Where a moved row ended up, by its selector (null when the table does not move it). */
  function groupOfRow(selector) {
    const r = ROWS.find((x) => x.selector === selector);
    return r ? { group: r.to, more: !!r.more, section: movedId(r) } : null;
  }

  function isGroup(id) { return !!byId(id); }

  /** The group to open: the first (in display order) with a red summary, else the last one opened (when it still exists), else You and this device. */
  function defaultGroup(o) {
    const crit = (o && o.crit) || {};
    const red = (id) => Array.isArray(crit) ? crit.includes(id) : !!crit[id];
    for (const g of GROUPS) if (red(g.id)) return g.id;
    const last = o && o.last;
    return isGroup(last) ? last : DEFAULT_GROUP;
  }

  /** The closed More button's text: "More: Auto model classifier, Tuning" (null when the group has no More content). */
  function moreLabel(group, nameOf, extra) {
    const g = typeof group === 'string' ? byId(group) : group;
    if (!g) return null;
    const names = [...g.more, ...((extra || []).filter(Boolean))].map((id) => (nameOf && nameOf(id)) || id).filter(Boolean);
    return names.length ? `More: ${[...new Set(names)].join(', ')}` : null;
  }

  /**
   * What a search shows, across every group. entries = [{ id: section id, text: lower-case words of that section and its rows }].
   * A group whose title (or sub-line) contains the query shows whole. Result is in group order; groups with nothing are left out.
   */
  function search(q, entries) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const by = new Map();
    for (const g of GROUPS) by.set(g.id, { group: g.id, ids: [], els: [], whole: g.title.toLowerCase().includes(q) });
    for (const e of entries || []) {
      const slot = by.get(e.group) || by.get(groupOfSection(e.id).group);   // e.group: where the page actually put it
      if (slot.whole || String(e.text || '').toLowerCase().includes(q)) { slot.ids.push(e.id); if (e.el) slot.els.push(e.el); }
    }
    // a group whose title matches comes first (it shows whole); the others follow in group order
    const out = [...by.values()].filter((s) => s.ids.length).map((s) => ({ group: s.group, ids: s.ids, els: s.els, whole: s.whole }));
    return [...out.filter((s) => s.whole), ...out.filter((s) => !s.whole)];
  }

  /**
   * Inside a section that a search found by its rows (not by its heading), which of its parts stay. units = [{ text, follows }] in order:
   * the section's rows, hints and ⓘ buttons (follows: true for a hint or an ⓘ, which belong to the row above it). A unit stays when its
   * text has the query; a hint that matches also keeps its row, and a row that matches keeps its hints. When nothing matches (the section
   * was found by words that sit nowhere else) every part stays: nothing is hidden for no reason. -> [bool]
   */
  function searchRows(q, units) {
    q = String(q || '').trim().toLowerCase();
    const list = Array.isArray(units) ? units : [];
    const own = list.map((u) => !!q && String((u && u.text) || '').toLowerCase().includes(q));
    if (!own.some(Boolean)) return list.map(() => true);
    const keep = own.slice();
    let lead = -1;   // the row the hints under it belong to
    list.forEach((u, i) => {
      if (u && u.follows) {
        if (lead >= 0 && own[lead]) keep[i] = true;
        if (own[i] && lead >= 0) keep[lead] = true;
      } else lead = i;
    });
    return keep;
  }

  // ── Phase 5c: one row for each settings.json key that only a file edit changed (admins only) ───────────────────────────────────────
  // app.js draws every row of P5C (p5cRowsHtml) and saves each box on its own through POST /api/settings. A row with `to` is moved by
  // stPlaceRows into that group (ROWS gets its entry below); a row without it stays in the "Expert values" section under Upkeep > More.
  // kind: num (min, max, step, unit, mult: stored = shown x mult), switch (on: the default), select (options [[value, words]], dflt),
  // text (pattern), url (provider address, asks first), model (one model, from the model list), models (many), map, images, cache.
  // `name` is the record's name (a test compares); `def` the words shown as "Default: ...".
  const PROVIDER_ROWS = [['OPT-0931', 'ninfer', 'NInfer'], ['OPT-0933', 'anthropic', 'Anthropic'], ['OPT-0934', 'openai', 'OpenAI'], ['OPT-0935', 'google', 'Google'],
    ['OPT-0936', 'perplexity', 'Perplexity'], ['OPT-0937', 'openrouter', 'OpenRouter'], ['OPT-0938', 'elevenlabs', 'ElevenLabs']];
  const PROVIDER_URLS = { ninfer: 'http://127.0.0.1:8080/v1', anthropic: 'https://api.anthropic.com', openai: 'https://api.openai.com/v1',
    google: 'https://generativelanguage.googleapis.com/v1beta/openai', perplexity: 'https://api.perplexity.ai', openrouter: 'https://openrouter.ai/api/v1', elevenlabs: 'https://api.elevenlabs.io/v1' };
  const mk = (opt, key, name, kind, o) => Object.assign({ opt, key, name, kind, id: `st-p5c-${key.replace(/\./g, '-')}` }, o);
  const MODEL_RE = /^[A-Za-z0-9._:/@[\]-]{1,120}$/;
  const P5C = [
    mk('OPT-0439', 'approvalTimeoutMinutes', 'How long an approval waits', 'num', { min: 1, max: 1440, step: 1, unit: 'minutes', def: '60 minutes', to: 'safety', more: true, part: 'approval-wait', partTitle: 'Approvals', hint: 'How long an approval card waits for your answer before it counts as no.' }),
    mk('OPT-0509', 'connectorsUnlockMinutes', 'Connector unlock time', 'num', { min: 0, max: 1440, step: 1, unit: 'minutes', def: '240 minutes (4 hours)', hint: 'How long a connector stays unlocked after you unlock it. 0 locks it again at once.' }),
    mk('OPT-0930', 'confirmTools', 'Ask before each tool', 'switch', { on: false, def: 'off', hint: 'Every tool call waits for your yes. Most people use each agent\'s tool permissions instead.' }),
    mk('OPT-0943', 'updateCheck.hours', 'Hours between update checks', 'num', { min: 1, max: 720, step: 1, unit: 'hours', def: 'every 24 hours', hint: 'How often your Maestro looks for a new version.' }),
    mk('OPT-0951', 'filesMaxUploadMb', 'Biggest upload (MB)', 'num', { min: 1, max: 100000, step: 1, unit: 'MB', def: '512 MB', hint: 'The largest single file that can be uploaded to a Files folder.' }),
    mk('OPT-0952', 'filesZipMaxMb', 'Biggest zip download (MB)', 'num', { min: 1, max: 3900, step: 1, unit: 'MB', def: '2,048 MB', hint: 'The most a zip download of a folder may hold. 3,900 MB is the top.' }),
    mk('OPT-0953', 'filesZipMaxFiles', 'Most files in a zip', 'num', { min: 1, max: 65535, step: 1, unit: 'files', def: '2,000 files', hint: 'The most files a zip download may hold.' }),
    mk('OPT-0954', 'recordsMaxBytes', 'Records limit for all agents', 'num', { min: 4, max: 2048, step: 1, unit: 'KB', mult: 1024, def: '256 KB', hint: 'How much of an agent\'s Records is read each turn. An agent\'s own limit wins.' }),
    mk('OPT-0955', 'sandboxMemory', 'Memory per box', 'text', { pattern: '^[1-9][0-9]{0,5}[bBkKmMgG]?$', placeholder: '4g', def: '4g (4 gigabytes)', to: 'safety', more: true, part: 'box-size', partTitle: 'Agent boxes', hint: 'How much memory one box may use, like 512m or 4g. A new value reaches boxes made after it; existing boxes keep theirs until rebuilt.' }),
    mk('OPT-0956', 'sandboxCpus', 'Processor share per box', 'num', { min: 0.25, max: 64, step: 0.25, unit: 'processors', def: '2', to: 'safety', more: true, part: 'box-size', partTitle: 'Agent boxes', hint: 'How many processors one box may use. A new value reaches boxes made after it.' }),
    mk('OPT-0957', 'sandboxHomeMoveMinutes', 'Home folder move time', 'num', { min: 1, max: 1440, step: 1, unit: 'minutes', def: '10 minutes', to: 'safety', more: true, part: 'box-size', partTitle: 'Agent boxes', hint: 'How long moving a box\'s home folder may take before it stops.' }),
    mk('OPT-0960', 'hubBrief', 'Hub briefing for the lead', 'switch', { on: true, def: 'on', hint: 'Gives your lead a short note about your Maestro at the start of each turn.' }),
    mk('OPT-0963', 'promptCache', 'Reuse earlier text', 'cache', { def: 'on, remembering for 5 minutes', hint: 'Lets a provider reuse the start of a long chat instead of reading it again, which costs less.' }),
    ...PROVIDER_ROWS.map(([opt, p, label]) => mk(opt, `providers.${p}.url`, `Address for ${label}`, 'url', { provider: p, label, dflt: PROVIDER_URLS[p], def: PROVIDER_URLS[p], to: 'money', more: true, part: 'provider-addresses', partTitle: 'Provider addresses',
      hint: `Where your Maestro sends calls to ${label}. Leave it unless yours is somewhere else.` })),
    mk('OPT-0945', 'planFallback.at', 'Plan level to switch at', 'num', { min: 1, max: 100, step: 1, unit: 'percent', def: '90 percent', to: 'money', more: true, part: 'plan-switch', partTitle: 'When your Claude plan runs low', hint: 'How full the plan is when agents switch to the lighter model. Used only while the automatic switch is on.' }),
    mk('OPT-0946', 'planFallback.map', 'Lighter model to switch to', 'map', { families: [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet']], def: 'Fable to Opus, Opus to Sonnet, Sonnet to Haiku', to: 'money', more: true, part: 'plan-switch', partTitle: 'When your Claude plan runs low', hint: 'The model each family switches to.' }),
    mk('OPT-0948', 'voice.sttModel', 'Speech recognition size', 'select', { options: [['', 'Automatic'], ['tiny.en', 'Small and fast (tiny.en)'], ['small.en', 'Bigger and more exact (small.en)']], dflt: '', def: 'chosen from your computer\'s speed', to: 'voice', more: true, part: 'speech-size', partTitle: 'Speech recognition', hint: 'Takes effect when the speech engines are next installed.' }),
    mk('OPT-0949', 'compactionMode', 'Long-chat default for agents', 'select', { options: [['off', 'Off'], ['dry', 'Practice run (writes the brief, resets nothing)'], ['on', 'On'], ['assisted', 'Assisted (asks first)']], dflt: 'dry', def: 'practice run', to: 'upkeep', more: false, part: 'long-chats', partTitle: 'Long chats', hint: 'What an agent does when its chat gets long. An agent\'s own choice wins.' }),
    mk('OPT-0950', 'compactionAt', 'How full before long-chat step', 'num', { min: 0.3, max: 0.95, step: 0.05, unit: 'of the window', def: '0.75 (three quarters)', to: 'upkeep', more: false, part: 'long-chats', partTitle: 'Long chats', hint: 'How full a chat gets before the long-chat step runs. An agent\'s own choice wins.' }),
    mk('OPT-0958', 'memberDefaultModel', 'Default model for members', 'model', { def: 'the standard Claude Sonnet', to: 'safety', more: true, part: 'member-models', partTitle: 'Models for members', hint: 'The model a new member\'s agents start on.' }),
    mk('OPT-0959', 'memberModels', 'Models members may use', 'models', { def: 'none: members cannot choose', to: 'safety', more: true, part: 'member-models', partTitle: 'Models for members', hint: 'Tick the models members may pick for their own agents. A Codex model gives them a tool that runs on this computer.' }),
    mk('OPT-0961', 'imageProvider', 'Picture service', 'select', { options: [['google', 'Google'], ['openai', 'OpenAI']], dflt: 'google', def: 'Google', to: 'tools', more: true, part: 'pictures', partTitle: 'Pictures', hint: 'Which service makes pictures for your agents. It needs that provider\'s key.' }),
    mk('OPT-0962', 'imageModels', 'Picture models', 'images', { providers: [['google', 'Google'], ['openai', 'OpenAI']], def: 'a built-in quick and best model for each', to: 'tools', more: true, part: 'pictures', partTitle: 'Pictures', hint: 'The model names used for a quick picture and for the best one. Empty keeps the built-in name.' }),
  ];
  const p5cByOpt = (opt) => P5C.find((r) => r.opt === opt) || null;
  const p5cGet = (data, key) => String(key).split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);
  // The value a row shows as set (undefined = unset, so the row shows its default). A provider address equal to the default counts as unset.
  function p5cValue(row, data) {
    const v = p5cGet(data, row.key);
    if (row.kind === 'url') return typeof v === 'string' && v && v !== row.dflt ? v : undefined;
    if (v === null || v === '') return undefined;
    if (row.kind === 'num' && typeof v === 'number' && row.mult) return v / row.mult;   // shown in the row's unit
    return v;
  }
  const toNum = (x) => (typeof x === 'number' ? x : (typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN));

  /**
   * Check what a person typed or picked, in the units the box shows. -> { ok: true, value } (value is what the hub stores; null = use the
   * default) or { ok: false, error } in plain words. Empty (or null) always means use the default.
   */
  function p5cClean(row, raw) {
    const k = row.kind;
    if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return { ok: true, value: null };
    if (k === 'num') {
      const n = toNum(raw);
      if (!Number.isFinite(n) || n < row.min || n > row.max) return { ok: false, error: `${row.name} must be a number from ${row.min} to ${row.max}.` };
      if (row.step >= 1 && !Number.isInteger(n)) return { ok: false, error: `${row.name} must be a whole number.` };
      return { ok: true, value: row.mult ? Math.round(n * row.mult) : n };
    }
    if (k === 'switch') return { ok: true, value: raw === true || raw === 'true' || raw === 'on' };
    if (k === 'select') {
      if (!row.options.some((o) => o[0] === raw)) return { ok: false, error: `${row.name} must be one of: ${row.options.map((o) => o[1]).join(', ')}.` };
      return { ok: true, value: raw };
    }
    if (k === 'text') {
      const s = String(raw).trim();
      if (!new RegExp(row.pattern).test(s)) return { ok: false, error: `${row.name} must look like ${row.placeholder}.` };
      return { ok: true, value: s.toLowerCase() };
    }
    if (k === 'url') {
      let u;
      try { u = new URL(String(raw).trim()); } catch { return { ok: false, error: `${row.name} must be a web address that starts with http:// or https://.` }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, error: `${row.name} must start with http:// or https://.` };
      if (u.username || u.password) return { ok: false, error: `${row.name} must not hold a name or password.` };
      return { ok: true, value: String(raw).trim().replace(/\/+$/, '') };
    }
    if (k === 'model') return MODEL_RE.test(String(raw)) ? { ok: true, value: String(raw) } : { ok: false, error: `${row.name} must be a model from the list.` };
    if (k === 'models') {
      const list = Array.isArray(raw) ? raw.map(String) : null;
      if (!list || list.some((m) => !MODEL_RE.test(m))) return { ok: false, error: `${row.name} must be models from the list.` };
      return { ok: true, value: [...new Set(list)] };
    }
    if (k === 'map') {
      if (typeof raw !== 'object') return { ok: false, error: `${row.name} must name a model for each family.` };
      const out = {};
      for (const [f, m] of Object.entries(raw)) {
        if (!row.families.some((x) => x[0] === f)) return { ok: false, error: `${row.name}: ${f} is not a family you can switch.` };
        if (m === '' || m === null) continue;
        if (!/^claude-sdk\/[\w.[\]-]+$/.test(String(m))) return { ok: false, error: `${row.name} must be a Claude model from the list.` };
        out[f] = String(m);
      }
      return Object.keys(out).length ? { ok: true, value: out } : { ok: true, value: null };
    }
    if (k === 'images') {
      if (typeof raw !== 'object') return { ok: false, error: `${row.name} must name a model for each service.` };
      const out = {};
      for (const [p, o] of Object.entries(raw)) {
        if (!row.providers.some((x) => x[0] === p) || !o || typeof o !== 'object') return { ok: false, error: `${row.name}: ${p} is not a picture service.` };
        for (const w of ['fast', 'best']) {
          const m = String(o[w] === undefined || o[w] === null ? '' : o[w]).trim();
          if (!m) continue;
          if (!MODEL_RE.test(m)) return { ok: false, error: `${row.name}: "${m}" is not a model name.` };
          (out[p] = out[p] || {})[w] = m;
        }
      }
      return Object.keys(out).length ? { ok: true, value: out } : { ok: true, value: null };
    }
    if (k === 'cache') {
      if (typeof raw !== 'object') return { ok: false, error: `${row.name} must say on or off.` };
      const ttl = raw.ttl === undefined || raw.ttl === '' ? '5m' : raw.ttl;
      if (ttl !== '5m' && ttl !== '1h') return { ok: false, error: `${row.name} must remember for 5 minutes or 1 hour.` };
      const enabled = raw.enabled !== false;
      return enabled && ttl === '5m' ? { ok: true, value: null } : { ok: true, value: { enabled, ttl } };
    }
    return { ok: false, error: `${row.name} cannot be set here.` };
  }

  /**
   * The body to POST to /api/settings for a cleaned value (null = back to the default). Nested keys send just their own field
   * (updateCheck, planFallback, voice, a provider address); picture models send only the tiers that changed. Null always means
   * "remove the key, back to the default": the hub takes it so for every key.
   */
  function p5cPatch(row, value, data) {
    const k = row.key;
    if (row.kind === 'url') return { providers: { [row.provider]: { url: value } } };
    if (k === 'updateCheck.hours') return { updateCheck: { hours: value } };   // only this field: the hub merges, null removes it
    if (k === 'planFallback.at') return { planFallback: { at: value } };
    if (k === 'planFallback.map') return { planFallback: { map: value } };
    if (k === 'voice.sttModel') return { voice: { sttModel: value } };
    if (row.kind === 'images') {
      if (value === null) return { imageModels: null };   // back to the built-in names
      // only the tiers that differ from what is stored; a tier that went empty is sent as null (the hub removes it)
      const old = p5cGet(data, 'imageModels') || {};
      const out = {};
      for (const [p] of row.providers) for (const w of ['fast', 'best']) {
        const was = old[p] && typeof old[p][w] === 'string' && old[p][w] ? old[p][w] : null;
        const now = value[p] && value[p][w] ? value[p][w] : null;
        if (was !== now) (out[p] = out[p] || {})[w] = now;
      }
      return { imageModels: out };
    }
    return { [k]: value };
  }

  /** The question before a provider address changes (a reset included): names the provider, the new address and the old one. */
  function p5cConfirmText(row, value, before) {
    const to = value === null || value === undefined ? row.dflt : value;
    const from = before === undefined || before === null ? row.dflt : before;
    return `Keys and prompts for ${row.label} will go to ${to} instead of ${from}. Change it?`;
  }

  /**
   * The saving loop of every row, apart from the page so a test can run it. One row saves one value at a time; an edit made while a
   * save runs is kept (the latest wins) and saved when that one ends, if it differs; the row is not painted over such an edit.
   * deps: data() the screen's settings, readRaw(row), post(body) -> Promise<{ ok, error? }>, readBack() -> Promise<settings|null>,
   * confirm(text) -> bool, toast(text), paint(row). save(opt, useDefault) resolves when the row is idle.
   */
  function p5cSaver(deps) {
    const st = {};   // opt -> { busy, want: { raw } | null }
    async function one(r, s, raw) {
      const paint = () => { if (!s.want) deps.paint(r); };
      const data = deps.data();
      const c = p5cClean(r, raw);
      if (!c.ok) { deps.toast(c.error); paint(); return; }
      const before = p5cValue(r, data);
      if (c.value === null ? before === undefined : JSON.stringify(c.value) === JSON.stringify(r.mult && typeof before === 'number' ? before * r.mult : before)) { paint(); return; }   // nothing changed
      if (r.kind === 'url' && !deps.confirm(p5cConfirmText(r, c.value, before))) { paint(); return; }
      try {
        const a = await deps.post(p5cPatch(r, c.value, data));
        if (!a || !a.ok) throw new Error((a && a.error) || 'The hub did not accept it.');
        p5cStore(r, c.value, data);
        let back = null;
        try { back = await deps.readBack(); } catch { back = null; }
        if (back && typeof back === 'object') p5cAssign(r, p5cGet(back, r.key), data);   // what the hub really holds now
        if (c.value !== null) deps.toast(`${r.name}: saved.`);
        else deps.toast(p5cValue(r, data) === undefined ? `${r.name}: back to the default.` : `${r.name}: the hub still holds a value.`);
      } catch (e) {
        deps.toast('Could not save: ' + ((e && e.message) || e));
      }
      paint();
    }
    async function save(opt, useDefault) {
      const r = p5cByOpt(opt);
      if (!r) return;
      const s = st[opt] || (st[opt] = { busy: false, want: null });
      const raw = useDefault ? null : deps.readRaw(r);
      if (s.busy) { s.want = { raw }; return; }
      let next = { raw };
      s.busy = true;
      while (next) {
        s.want = null;
        await one(r, s, next.raw);
        next = s.want;
      }
      s.busy = false;
    }
    return { save };
  }

  /** Put a saved value into the screen's copy of the settings, so the next patch and the row's state stay right. */
  function p5cStore(row, value, data) {
    const parts = String(row.key).split('.');
    let o = data;
    for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
    const last = parts[parts.length - 1];
    if (row.kind === 'url') o[last] = value === null ? row.dflt : value;
    else if (value === null) delete o[last];
    else o[last] = value;
    return data;
  }

  /** Put the value the hub reports (as stored: undefined / null = not stored) into the screen's copy. */
  function p5cAssign(row, stored, data) {
    const unset = stored === undefined || stored === null || (row.kind === 'url' && stored === '');
    const parts = String(row.key).split('.');
    let o = data;
    for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object') o[p] = {}; o = o[p]; }
    const last = parts[parts.length - 1];
    if (unset) { if (row.kind === 'url') o[last] = row.dflt; else delete o[last]; } else o[last] = stored;
    return data;
  }

  /** "Default: ..." words for a row. */
  function p5cDefaultText(row) { return `Default: ${row.def}.`; }

  // Rows that leave the Expert values section: the ROWS table moves them.
  for (const r of P5C) if (r.to) ROWS.push({ selector: `#${r.id}`, to: r.to, more: !!r.more, part: r.part, partTitle: r.partTitle });
  const EXPERT_SECTION = 'st-expert-section';

  return { GROUPS, ROWS, P5C, EXPERT_SECTION, p5cByOpt, p5cClean, p5cPatch, p5cConfirmText, p5cSaver, p5cAssign, p5cStore, p5cValue, p5cDefaultText, SHARED_SAVE_GROUPS, usesSharedSave, DEFAULT_GROUP, STORE_KEY, allSectionIds, groupOfSection, groupOfRow, defaultGroup, moreLabel, search, searchRows, byId, isGroup, movedId };
});
