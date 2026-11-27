/**
 * ui-agent-card-basics.js — the rows of the agent card's "Basics" and "Role and team" sections (loaded after lib/ui-agent-card.js).
 *
 * Every row is a rowDef registered under its settings record id (see the header of lib/ui-agent-card.js). Saves go through the
 * routes the pages use today, so the server's checks and the settings journal apply:
 *   PATCH /api/agents/<name> (ctx.patch)  POST /api/agents/<name>/model  /display  /icon  POST /api/agents/rename
 *   DELETE /api/agents/<name>  PUT /api/notify/prefs {agent, prefs}
 * Lists the controls need (models, faces, voices, users, notification prefs) are read once, lazily, on the first draw of a row
 * and the card is redrawn when they arrive (loaded(ctx)).
 *
 * Node (tests): module.exports. Text is set by the card with textContent; this file builds only controls through ctx.doc.
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module && module.exports;
  const card = isNode ? require('./ui-agent-card.js') : (root && root.hubAgentCard) || null;
  const api = factory(card);
  if (isNode) module.exports = api;
  if (root) root.hubAgentCardBasics = api;
})(typeof window !== 'undefined' ? window : null, function (card) {
  'use strict';

  // ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────
  const AUTO = '__auto__';
  const NOTIFY_KINDS = ['questions', 'requested', 'other'];
  const MODE_WORDS = { on: 'On', off: 'Off', away: "Only when I'm away" };
  const PRESETS = [
    { value: 'all', label: 'Everything' },
    { value: 'asks', label: 'Only questions and requests' },
    { value: 'away', label: "Only when I'm away" },
  ];
  // The chat header's effort words (app.js EFFORT_LEVELS / EFFORT_ULTRA).
  const EFFORT_WORDS = { default: 'Default effort', low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra high effort', max: 'Max effort', ultra: 'Ultra (uses several helpers; uses much more of the ChatGPT plan)' };
  const CALL_FIXED = [{ value: 'none', label: 'None' }, { value: 'orb', label: 'Orb' }];
  const CLOUD_VOICES = {
    openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'],
    google: ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr'],
  };
  const ENGINE_NAMES = { openai: 'OpenAI', google: 'Google', elevenlabs: 'ElevenLabs' };
  const ELEVEN_ID = /^[A-Za-z0-9]{10,40}$/;
  const VD_FACTORY = { endPause: 1200, continueWait: 3000, interruptSensitivity: 50, voiceSpeed: 1 };
  const deleteQuestion = (agent) => 'Delete ' + displayOf(agent) + "? Its files, chats and memory are kept with the hub's deleted agents, and its name is free again.";
  const SAVE_FAILED = 'Could not save.';

  const str = (v) => (v == null ? '' : String(v));
  const modelOf = (a) => str(a && a.model);
  const displayOf = (a) => str((a && (a.display || a.name)) || 'this agent');
  const isAdmin = (ctx) => !!(ctx && ctx.isAdmin);
  const hidden = { visible: () => false };

  /** Who pays, from the model id alone (the same words as the chat header's billingDisplay). */
  function billingDisplay(model, compact) {
    const m = str(model); const p = m.includes('/') ? m.split('/')[0] : ''; const name = m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;
    const full = p === 'claude-sdk' ? 'Subscription (Claude sign-in)' : (p === 'codex-cli' || p === 'codex') ? 'Subscription (ChatGPT)'
      : ['anthropic', 'openai', 'google', 'perplexity', 'openrouter'].includes(p) ? 'API $' : ['lmstudio', 'ollama', 'omlx', 'ninfer', 'local'].includes(p) ? 'Local (' + p + ')' : '?';
    const short = full.startsWith('Subscription') ? 'Subscription' : full.startsWith('Local') ? 'Local' : full;
    return name + ' · ' + (compact ? short : full);
  }
  const routeShort = (model) => billingDisplay(model, true).split(' · ')[1] || '';
  /** "claude-sdk/claude-sonnet-4-6" -> "Sonnet"; other ids keep their own name. */
  function modelName(model) {
    const m = str(model); const n = m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;
    const c = /^claude-([a-z]+)(?:-[\d.-]+)?$/i.exec(n);
    if (c) return c[1].charAt(0).toUpperCase() + c[1].slice(1);
    return n || 'no model';
  }
  /** The short words of a model: "Sonnet · Subscription" (the same as the Basics summary). */
  const modelWords = (model) => modelName(model) + (routeShort(model) ? ' · ' + routeShort(model) : '');
  const healthNote = (h) => (h && (h.state === 'fail' || h.state === 'warn') && h.short ? ' — ⚠ ' + h.short : '');

  // ── lazy lists ───────────────────────────────────────────────────────────────────────────────────────────────
  const stores = new WeakMap();   // fetch function -> { key -> { at, data, loading } }
  const storeOf = (ctx) => { const k = ctx && ctx.fetch; if (!k) return null; let s = stores.get(k); if (!s) { s = {}; stores.set(k, s); } return s; };
  /** The cached list `key` (null until it has arrived); the first call starts the read, and the card is redrawn when it lands. */
  const RETRY_MS = 10000;   // a list that failed to load is asked for again after this long (at the next draw)
  function lazy(ctx, key, load, maxAge) {
    const s = storeOf(ctx);
    if (!s) return null;
    const e = s[key] || (s[key] = { at: 0, data: null, loading: false, failed: false });
    const stale = !e.at || (e.failed && Date.now() - e.at > Math.min(maxAge || RETRY_MS, RETRY_MS)) || (maxAge && Date.now() - e.at > maxAge);
    if (stale && !e.loading) {
      e.loading = true;
      Promise.resolve().then(load).then((data) => {
        const changed = JSON.stringify(data) !== JSON.stringify(e.data);
        e.data = data; e.at = Date.now(); e.failed = false; e.loading = false;
        // the list is shared by every card of this page: whichever card is open now is redrawn, not only the one that started the read
        const again = ctx.refreshOpen || ctx.refresh;
        if (changed && again) { try { again(); } catch { /* the card is gone */ } }
      }).catch(() => {
        const was = e.failed;
        e.failed = true; e.loading = false; e.at = Date.now();
        // a list that just turned failed: redraw once so rows waiting on it say "Not available" (no loop: a failed list is asked again only after RETRY_MS)
        const again = ctx.refreshOpen || ctx.refresh;
        if (!was && again) { try { again(); } catch { /* the card is gone */ } }
      });
    }
    return e.data;
  }
  const setLazy = (ctx, key, data) => { const s = storeOf(ctx); if (s) s[key] = { at: Date.now(), data, loading: false, failed: false }; };
  async function getJson(ctx, url) {
    const r = await card.request(ctx, url, { credentials: 'include' });   // bounded: headers and body
    if (!r || !r.ok) throw new Error('no answer');
    return r.json;
  }
  async function send(ctx, method, url, body) {
    try {
      const r = await card.request(ctx, url, { method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = r.json;
      if (r && r.ok && !(j && (j.success === false || j.ok === false))) return { ok: true, data: j };
      return { ok: false, error: (j && (j.error || j.message || j.detail)) || (SAVE_FAILED.replace(/\.$/, '') + ' (' + (r ? r.status : 'no answer') + ').'), data: j };
    } catch (e) { return { ok: false, error: (e && e.message) || SAVE_FAILED }; }
  }
  const modelsOf = (ctx) => lazy(ctx, 'models', () => getJson(ctx, '/api/models').then((d) => ({ models: d.models || [], billing: d.billing || {}, health: d.health || {} })));
  const facesOf = (ctx) => lazy(ctx, 'faces', () => getJson(ctx, '/api/faces').then((d) => ({ packs: Array.isArray(d.packs) ? d.packs : [], available: Array.isArray(d.available) ? d.available : [] })));
  const voicesOf = (ctx) => lazy(ctx, 'voices', () => getJson(ctx, '/api/voice/status').then((d) => ({ voices: Array.isArray(d.voices) ? d.voices : [] })));
  const usersOf = (ctx) => (isAdmin(ctx) ? lazy(ctx, 'users', () => getJson(ctx, '/api/users').then((d) => ({ users: Array.isArray(d.users) ? d.users : [] }))) : null);
  const notifyOf = (ctx) => lazy(ctx, 'notify', () => getJson(ctx, '/api/notify/prefs').then((d) => (d && d.prefs) || {}), 20000);
  const openRouterOf = (ctx) => (isAdmin(ctx) ? lazy(ctx, 'openrouter', () => getJson(ctx, '/api/openrouter').then((d) => ({ models: (d.models || []).map((m) => ({ id: m.id, reasoning: !!m.reasoning })) }))) : null);

  // ── model ────────────────────────────────────────────────────────────────────────────────────────────────────
  /** The admin's list a member may pick from: me.memberModels (the hub's settings.memberModels) when the server sent it. */
  const memberList = (ctx) => (ctx && ctx.me && Array.isArray(ctx.me.memberModels) ? ctx.me.memberModels.filter((m) => typeof m === 'string' && m) : []);
  function modelOptions(agent, ctx) {
    const d = modelsOf(ctx);
    const cur = modelOf(agent);
    let list = d ? d.models.slice() : [];
    if (!isAdmin(ctx)) list = memberList(ctx).filter((m) => !d || d.models.includes(m));
    const out = [];
    if (isAdmin(ctx) || agent.autoModel) out.push({ value: AUTO, label: 'Auto' });
    if (cur && !list.includes(cur)) out.push({ value: cur, label: modelWords(cur) + (list.length || d ? ' · not offered right now' : '') });
    for (const m of list) out.push({ value: m, label: modelWords(m) + healthNote(d && d.health[m]) });
    // two options with the same words: each of those gets its full model id (provider included: two local servers may offer the same model)
    const count = new Map();
    for (const o of out) if (o.value !== AUTO) count.set(o.label, (count.get(o.label) || 0) + 1);
    for (const o of out) if (o.value !== AUTO && count.get(o.label) > 1) o.label += ' (' + o.value + ')';
    return out;
  }
  const MODEL = {
    members: (agent, ctx) => memberList(ctx).length > 0,
    live: (agent, ctx) => isAdmin(ctx) || memberList(ctx).length > 0,
    get: (agent, ctx) => {
      modelsOf(ctx);
      const v = agent.autoModel ? AUTO : modelOf(agent);
      return { value: v, display: agent.autoModel ? 'Auto' : modelWords(modelOf(agent)) };
    },
    control: { type: 'select', options: modelOptions },
    desc: (agent, ctx) => {
      const r = routeShort(modelOf(agent));
      const tail = r === 'Subscription' ? ' Subscription means no extra cost per message.' : (r === 'API $' ? ' API means you pay per message.' : (r === 'Local' ? ' Local runs on this computer.' : ''));
      // the current model is not among the models the hub found: say who is not offering it
      const d = modelsOf(ctx);
      const gone = d && modelOf(agent) && !agent.autoModel && !d.models.includes(modelOf(agent))
        ? ' ' + (r === 'Subscription' ? "Your subscription isn't offering this model right now." : "Your provider isn't offering this model right now.") : '';
      return 'What ' + displayOf(agent) + ' thinks with.' + tail + gone;
    },
    save: async (agent, value, ctx) => {
      if (value === AUTO) { if (!isAdmin(ctx)) return { ok: false, error: 'Only an admin can turn Auto on.' }; return ctx.patch({ autoModel: true }); }
      if (value !== modelOf(agent)) {
        const r = await send(ctx, 'POST', '/api/agents/' + encodeURIComponent(ctx.name) + '/model', { model: value });
        if (!r.ok) return { ok: false, error: r.error };
      }
      if (agent.autoModel && isAdmin(ctx)) return ctx.patch({ autoModel: false });
      return { ok: true };
    },
    summary: (agent, ctx) => (agent.autoModel ? 'Auto' : modelWords(modelOf(agent))),
  };

  // ── thinking effort (the levels the current model takes: lib/effort.js, same words as the chat header) ────────
  function openaiLevels(name) {
    if (/^gpt-5\.5-pro(?:$|[-.])/.test(name)) return ['medium', 'high', 'xhigh'];
    if (/^(?:gpt-5\.6|gpt-6)(?:$|[-.])/.test(name)) return ['low', 'medium', 'high', 'xhigh', 'max'];
    return ['low', 'medium', 'high', 'xhigh'];
  }
  /** The levels (besides "default") the model takes, [] when it takes none. */
  function effortLevels(model, agent, ctx) {
    const m = str(model); const p = m.includes('/') ? m.split('/')[0] : ''; const n = (m.includes('/') ? m.slice(m.indexOf('/') + 1) : m).toLowerCase();
    let out = [];
    if (p === 'claude-sdk' || p === 'anthropic') out = ['low', 'medium', 'high', 'xhigh', 'max'];
    else if (p === 'codex-cli' || p === 'codex') { out = openaiLevels(n); if (agent && agent.effortUltra === true) out = out.concat('ultra'); }
    else if (p === 'openai') out = /^(gpt-5|gpt-6|o[1-9])/.test(n) ? openaiLevels(n) : [];
    else if (p === 'google') out = /gemini-(2\.5|[3-9])|gemini-(pro|flash)(-lite)?-latest/.test(n) ? ['low', 'medium', 'high'] : [];
    else if (p === 'openrouter') {
      const d = openRouterOf(ctx);
      const hit = d && d.models.find((x) => x.id === m.slice(m.indexOf('/') + 1));
      out = hit && hit.reasoning ? ['low', 'medium', 'high'] : [];
    }
    return out;
  }
  const effortShown = (agent) => { const l = str(agent && agent.effort) || 'default'; return l === 'ultra' && agent.effortUltra !== true ? 'max' : l; };
  function effortOptions(agent, ctx) {
    const levels = effortLevels(modelOf(agent), agent, ctx);
    const vals = ['default'].concat(levels);
    const cur = effortShown(agent);
    if (!vals.includes(cur)) vals.push(cur);
    return vals.map((v) => ({ value: v, label: EFFORT_WORDS[v] || v }));
  }
  const EFFORT = {
    // A member always sees the row (read-only, the stored level as text); the model's levels may be unknown to them.
    visible: (agent, ctx) => !isAdmin(ctx) || (!agent.autoModel && effortLevels(modelOf(agent), agent, ctx).length > 0),
    live: (agent, ctx) => isAdmin(ctx),
    get: (agent, ctx) => {
      const v = effortShown(agent);
      if (!isAdmin(ctx)) return { value: v, display: str(agent && agent.effort) ? (EFFORT_WORDS[v] || v) : 'Default' };
      return { value: v, display: EFFORT_WORDS[v] || v };
    },
    // Segmented for up to four choices, a select beyond (P3-2): the row builds whichever fits the levels of the current model.
    control: {
      type: 'custom',
      build: ({ mk, agent, ctx, got, label, send: go }) => {
        const opts = effortOptions(agent, ctx);
        if (opts.length > 4) {
          const sel = mk('select', 'ac-select'); sel.setAttribute('aria-label', label);
          for (const op of opts) { const e = mk('option', '', op.label); e.setAttribute('value', op.value); e.value = op.value; sel.appendChild(e); }
          sel.value = str(got.value);
          sel.addEventListener('change', () => go(sel.value));
          return sel;
        }
        const seg = mk('div', 'ac-seg'); seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', label);
        for (const op of opts) {
          const on = op.value === str(got.value);
          const b = mk('button', 'ac-seg-b' + (on ? ' on' : ''), op.label);
          b.setAttribute('type', 'button'); b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', on ? 'true' : 'false'); b.setAttribute('data-value', op.value);
          b.addEventListener('click', () => { if (!on && !b.disabled) go(op.value); });
          seg.appendChild(b);
        }
        return seg;
      },
    },
    save: (agent, value, ctx) => ctx.patch({ effort: value }),
    summary: (agent, ctx) => (!agent.autoModel && effortLevels(modelOf(agent), agent, ctx).length ? (EFFORT_WORDS[effortShown(agent)] || '') : ''),
  };

  // ── notifications ────────────────────────────────────────────────────────────────────────────────────────────
  const effectiveMode = (prefs, name, kind) => {
    const own = prefs && prefs.agents && prefs.agents[name] ? prefs.agents[name][kind] : undefined;
    if (own === 'on' || own === 'off' || own === 'away') return own;
    const def = prefs && prefs.default ? prefs.default[kind] : undefined;
    return def === 'off' || def === 'away' ? def : 'on';
  };
  /** The three kinds -> { on: this agent notifies at all, preset: 'all'|'asks'|'away'|'custom'|'off' }. */
  function notifyState(prefs, name) {
    const m = NOTIFY_KINDS.map((k) => effectiveMode(prefs, name, k));
    const on = m.some((x) => x !== 'off');
    let preset = 'custom';
    if (!on) preset = 'off';
    else if (m.every((x) => x === 'on')) preset = 'all';
    else if (m[0] === 'on' && m[1] === 'on' && m[2] === 'off') preset = 'asks';
    else if (m.every((x) => x === 'away')) preset = 'away';
    return { on, preset };
  }
  /** The stored kinds a preset means. */
  function presetKinds(preset) {
    if (preset === 'asks') return { questions: 'on', requested: 'on', other: 'off' };
    if (preset === 'away') return { questions: 'away', requested: 'away', other: 'away' };
    if (preset === 'off') return { questions: 'off', requested: 'off', other: 'off' };
    return { questions: 'on', requested: 'on', other: 'on' };
  }
  const presetWord = (preset) => (preset === 'off' ? 'Off' : (preset === 'custom' ? 'Custom' : ((PRESETS.find((x) => x.value === preset) || {}).label || 'Everything')));
  const hasOwnNotify = (prefs, name) => !!(prefs && prefs.agents && prefs.agents[name] && NOTIFY_KINDS.some((k) => prefs.agents[name][k]));
  async function putNotify(ctx, body) {
    const r = await send(ctx, 'PUT', '/api/notify/prefs', body);
    if (!r.ok) return { ok: false, error: r.error };
    if (r.data && r.data.prefs) setLazy(ctx, 'notify', r.data.prefs);
    return { ok: true };
  }
  async function ensureNotify(ctx) {
    let p = notifyOf(ctx);
    if (p) return p;
    try { p = (await getJson(ctx, '/api/notify/prefs')).prefs || {}; setLazy(ctx, 'notify', p); } catch { p = {}; }
    return p;
  }
  /** Has the notification read failed (the row then says "Not available" until a later draw reads it again)? */
  const notifyFailed = (ctx) => { const s = storeOf(ctx); return !!(s && s.notify && s.notify.failed && !s.notify.data); };
  function notifyChoices(ctx) {
    const p = notifyOf(ctx) || {};
    const out = [{ value: '', label: 'Same as all agents (' + presetWord(notifyState({ default: p.default }, ctx.name).preset) + ')' }];
    for (const op of PRESETS) out.push(op);
    out.push({ value: 'off', label: 'Off' });
    if (hasOwnNotify(p, ctx.name) && notifyState(p, ctx.name).preset === 'custom') out.push({ value: 'custom', label: 'Custom (see More)' });
    return out;
  }
  const NOTIFY = {
    get: (agent, ctx) => {
      const p = notifyOf(ctx);
      // not read yet (or the read failed): say so, never a guessed "Same as all agents (Everything)"
      if (!p) return { value: null, display: notifyFailed(ctx) ? 'Not available' : 'Checking…' };
      const own = hasOwnNotify(p, ctx.name);
      const s = notifyState(p, ctx.name);
      return { value: own ? s.preset : '', display: own ? presetWord(s.preset) : 'Same as all agents (' + presetWord(notifyState({ default: p.default }, ctx.name).preset) + ')', isDefault: !own };
    },
    label: (agent) => 'Notifications for ' + displayOf(agent),
    desc: (agent) => 'Tell me when ' + displayOf(agent) + ' finishes work or needs an answer.',
    control: {
      type: 'custom',
      build: ({ mk, ctx, got, label, send: go }) => {
        if (got.value === null) { const v = mk('span', 'ac-value', got.display); v.setAttribute('aria-live', 'polite'); return v; }
        const sel = mk('select', 'ac-select'); sel.setAttribute('aria-label', label);
        for (const op of notifyChoices(ctx)) { const e = mk('option', '', op.label); e.setAttribute('value', op.value); e.value = op.value; sel.appendChild(e); }
        sel.value = String(got.value);
        sel.addEventListener('change', () => { if (sel.value !== 'custom') go(sel.value); });
        return sel;
      },
    },
    save: async (agent, value, ctx) => {
      await ensureNotify(ctx);
      const preset = typeof value === 'string' ? value : '';
      if (preset === 'custom') return { ok: true };
      if (preset === '') return putNotify(ctx, { agent: ctx.name, prefs: null });   // back to the hub default (no "Use default again" button: this choice is it)
      return putNotify(ctx, { agent: ctx.name, prefs: presetKinds(preset) });
    },
  };
  const kindRow = (kind, label) => ({
    get: (agent, ctx) => {
      const p = notifyOf(ctx) || {};
      const own = p.agents && p.agents[ctx.name] ? p.agents[ctx.name][kind] : '';
      return { value: own || '', display: own ? MODE_WORDS[own] : 'Same as my default (' + MODE_WORDS[effectiveMode({ default: p.default }, ctx.name, kind)] + ')', isDefault: !own };
    },
    label,
    control: { type: 'select', options: () => [{ value: '', label: 'Use my default' }, { value: 'on', label: MODE_WORDS.on }, { value: 'off', label: MODE_WORDS.off }, { value: 'away', label: MODE_WORDS.away }] },
    save: async (agent, value, ctx) => { await ensureNotify(ctx); return putNotify(ctx, { agent: ctx.name, prefs: { [kind]: value || null } }); },
    resetDefault: (agent, ctx) => putNotify(ctx, { agent: ctx.name, prefs: { [kind]: null } }),
  });

  // ── voice ────────────────────────────────────────────────────────────────────────────────────────────────────
  const ownVoiceFlag = new Set();   // agents the person chose "Its own voice" for, before any field is stored
  const voiceOf = (a) => (a && a.voice && typeof a.voice === 'object' ? a.voice : {});
  /** "Its own voice" = any of the four voice fields (voice, stt, tts, cloudVoice) is set. */
  function hasOwnVoice(agent) {
    const v = voiceOf(agent);
    return !!(v.voice || (v.stt && v.stt !== 'local') || (v.tts && v.tts !== 'local') || v.cloudVoice);
  }
  /** The agent as the hub has it right now (ctx.fresh()), or { error }: what a voice save decides on (cloud confirmation, the ElevenLabs id) is read from it. */
  async function freshOf(agent, ctx) {
    if (!ctx || typeof ctx.fresh !== 'function') return { agent };
    const a = await ctx.fresh();
    return a ? { agent: a } : { error: 'Could not read the current settings. Try again.' };
  }
  const ownVoiceNow = (agent) => hasOwnVoice(agent) || ownVoiceFlag.has(agent.name);
  const needOwn = (agent) => ownVoiceNow(agent);
  const ownWord = (agent) => (!hasOwnVoice(agent) && ownVoiceFlag.has(agent.name) ? 'Its own voice (choose below)' : 'Its own voice');
  function voiceBody(agent, change) {
    const v = voiceOf(agent);
    const out = { voice: v.voice || '', stt: v.stt || 'local', tts: v.tts || 'local' };
    if (v.cloudVoice) out.cloudVoice = v.cloudVoice;
    Object.assign(out, change);
    if (out.tts === 'local') delete out.cloudVoice;
    return out;
  }
  const engineList = (engines) => engines.map((e) => ENGINE_NAMES[e] || e).join(' and ');
  /** PATCH {voice}; a cloud engine for an agent kept on this computer needs the owner's confirmation first (as the page asks). */
  async function saveVoice(shown, change, ctx) {
    const f = await freshOf(shown, ctx);   // what the voice would be (stored + this change) is checked against what the hub has now; only the change is sent
    if (f.error) return { ok: false, error: f.error };
    const agent = f.agent;
    const whole = voiceBody(agent, change);
    const engines = [whole.stt, whole.tts].filter((e, i, a) => e !== 'local' && a.indexOf(e) === i);
    if (whole.tts === 'elevenlabs' && !ELEVEN_ID.test(str(whole.cloudVoice))) return { ok: false, error: 'Enter the ElevenLabs voice ID (10 to 40 letters and digits) to use ElevenLabs.' };
    const body = Object.assign({}, change);   // the server merges the changed keys into the stored voice
    if (change.tts === 'local' && voiceOf(agent).cloudVoice) body.cloudVoice = null;   // local speech has no cloud voice: null removes it
    if (agent.keptOnBox && engines.length) {
      const saved = [voiceOf(agent).stt, voiceOf(agent).tts];
      const added = engines.filter((e) => !saved.includes(e));
      if (added.length || !voiceOf(agent).cloudConfirmedBy) {
        const w = ctx.win;
        const q = "This agent's data is meant to stay on this computer.\n\nA cloud engine sends what you say, and what the agent says, to " + engineList(engines) + '.\n\nUse it anyway? Only the owner of this Maestro can confirm this.';
        if (!(w && typeof w.confirm === 'function' && w.confirm(q))) return { ok: true };
      }
      body.cloudConfirm = true;
    }
    const r = await ctx.patch({ voice: body });
    if (!r.ok && r.error === 'owner_confirmation_required') return { ok: false, error: 'Only the owner of this Maestro can choose a cloud engine for this agent.' };
    return r;
  }
  const VOICE = {
    label: (agent) => 'Voice for ' + displayOf(agent),
    live: (agent, ctx) => isAdmin(ctx),
    desc: (agent) => 'The voice ' + displayOf(agent) + ' speaks with.',
    // "Its own voice" chosen but nothing stored yet says so ("choose below"); it is the stored detail that makes the voice the agent's own
    get: (agent) => { const own = ownVoiceNow(agent); return { value: own ? 'own' : 'same', display: own ? ownWord(agent) : 'Same as all agents', isDefault: !own }; },
    control: { type: 'select', options: (agent) => [{ value: 'same', label: 'Same as all agents' }, { value: 'own', label: ownWord(agent) }] },
    save: async (agent, value, ctx) => {
      if (value === 'own') { ownVoiceFlag.add(agent.name); if (ctx.openMore) ctx.openMore(); return { ok: true }; }
      ownVoiceFlag.delete(agent.name);
      if (!hasOwnVoice(agent) && !agent.voice) return { ok: true };
      return ctx.patch({ voice: null });
    },
    resetDefault: async (agent, ctx) => { ownVoiceFlag.delete(agent.name); return ctx.patch({ voice: null }); },
  };
  const cloudValue = (agent) => { const v = voiceOf(agent); return v.tts === 'openai' || v.tts === 'google' ? v.tts + ':' + (v.cloudVoice || CLOUD_VOICES[v.tts][0]) : (v.tts === 'elevenlabs' ? 'elevenlabs' : 'local'); };
  const ownRow = (def) => Object.assign({ visible: needOwn, live: (agent, ctx) => isAdmin(ctx) }, def);

  // ── call display, call timing, recordings ────────────────────────────────────────────────────────────────────
  function callOptions(agent, ctx) {
    const f = facesOf(ctx) || { packs: [], available: [] };
    const cur = str(agent.callDisplay) || 'none';
    const out = CALL_FIXED.slice(); const seen = new Set();
    for (const p of f.packs) { if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue; seen.add(p.id); out.push({ value: 'pack:' + p.id, label: p.name || p.id }); }
    for (const p of f.available) {
      if (!p || typeof p.id !== 'string' || seen.has(p.id)) continue; seen.add(p.id);
      const mb = Math.round((Number(p.size) || 0) / 1000000);
      out.push({ value: 'pack:' + p.id, label: (p.name || p.id) + (mb > 0 ? ' · downloads ' + mb + ' MB' : ' · downloads on first use') });
    }
    if (!out.some((o) => o.value === cur)) out.push({ value: cur, label: cur.replace(/^pack:/, '') + ' (not installed)' });
    return out;
  }
  const CALL = {
    label: 'Call display',
    live: (agent, ctx) => isAdmin(ctx),
    desc: (agent) => 'What you see during a call with ' + displayOf(agent) + '.',
    get: (agent, ctx) => {
      facesOf(ctx);
      const v = str(agent.callDisplay) || 'none';
      if (!isAdmin(ctx)) {   // a member: the stored value's label (the faces list may not be readable for them), else the value itself
        const f = CALL_FIXED.find((x) => x.value === v) || ((facesOf(ctx) || { packs: [] }).packs || []).map((p) => p && { value: 'pack:' + p.id, label: p.name || p.id }).find((x) => x && x.value === v);
        return { value: v, display: f ? f.label : v };
      }
      const o = callOptions(agent, ctx).find((x) => x.value === v);
      return { value: v, display: o ? o.label : v };
    },
    control: { type: 'select', options: callOptions },
    save: (agent, value, ctx) => ctx.patch({ callDisplay: value }),
  };
  const vdOf = (a) => (a && a.voiceDefaults && typeof a.voiceDefaults === 'object' ? a.voiceDefaults : null);
  const vdMode = (a) => { const d = vdOf(a); return !d ? 'none' : (d.preset === 'patient' ? 'patient' : 'custom'); };
  /** The four timing numbers (the factory values under whatever is stored), no preset name: the body of a custom call timing. */
  const customTiming = (agent, change) => { const d = Object.assign({}, VD_FACTORY, vdOf(agent) || {}, change || {}); delete d.preset; return d; };
  const vdNumber = (key, label, c) => ({
    label, live: (agent, ctx) => isAdmin(ctx), visible: (agent) => vdMode(agent) === 'custom',
    get: (agent) => { const d = Object.assign({}, VD_FACTORY, vdOf(agent) || {}); return { value: d[key], display: str(d[key]) }; },
    control: Object.assign({ type: 'number' }, c),
    save: (agent, value, ctx) => {   // only the changed number: the server merges it into the stored timing
      const n = Number(value);
      if (c && c.min != null && c.max != null && (!Number.isFinite(n) || n < c.min || n > c.max)) return { ok: false, error: 'Enter a number from ' + c.min + ' to ' + c.max + '.' };   // refused here: the server would clamp it silently
      if (c && c.whole && (String(value).trim() === '' || !Number.isInteger(n))) return { ok: false, error: 'Enter a whole number from ' + c.min + ' to ' + c.max + '.' };
      if (c && c.multipleOf) { const k = n / c.multipleOf; if (Math.abs(k - Math.round(k)) > 1e-6) return { ok: false, error: 'Enter a speed in steps of ' + c.multipleOf + ' (for example 1.05), from ' + c.min + ' to ' + c.max + '.' }; }
      return ctx.patch({ voiceDefaults: { [key]: n } });
    },
  });
  /** A timing the server accepts only from a fixed list (lib/ui-voice VOICE_END_PAUSES / VOICE_CONTINUE_WAITS): a select of exactly those values. */
  const vdChoice = (key, label, choices) => Object.assign(vdNumber(key, label, {}), {
    control: { type: 'select', options: () => choices.map((o) => ({ value: o.value, label: o.label })) },
    save: (agent, value, ctx) => {
      const n = Number(value);
      if (!choices.some((o) => o.value === n)) return { ok: false, error: 'Choose one of: ' + choices.map((o) => o.label).join(', ') + '.' };
      return ctx.patch({ voiceDefaults: { [key]: n } });
    },
  });
  const END_PAUSES = [{ value: 800, label: 'Short (0.8 s)' }, { value: 1200, label: 'Normal (1.2 s)' }, { value: 2000, label: 'Long (2 s)' }, { value: 4000, label: 'Very long (4 s)' }];   // = VOICE_END_PAUSES
  const CONTINUE_WAITS = [{ value: 1500, label: 'Short (1.5 s)' }, { value: 3000, label: 'Normal (3 s)' }, { value: 5000, label: 'Long (5 s)' }, { value: 8000, label: 'Very long (8 s)' }];   // = VOICE_CONTINUE_WAITS
  const recOf = (a) => Object.assign({ keep: false, allowed: [], keepReplies: false, consentLine: '', mic: 'processed', announce: 'first' }, a && a.recordings && typeof a.recordings === 'object' ? a.recordings : {});
  const ownerOnly = (agent, ctx) => !!(ctx && ctx.me && ctx.me.isOwner === true);
  const recRow = (key, control, extra) => Object.assign({
    live: ownerOnly,
    get: (agent) => { const v = recOf(agent)[key]; return { value: v, display: typeof v === 'boolean' ? (v ? 'On' : 'Off') : str(v) }; },
    control,
    save: (agent, value, ctx) => ctx.patch({ recordings: { [key]: value } }),   // the server merges the changed key into the stored object
  }, extra || {});

  // ── models rows under More ───────────────────────────────────────────────────────────────────────────────────
  const modelPickRow = (key, noneLabel, extra) => Object.assign({
    get: (agent, ctx) => { modelsOf(ctx); const v = str(agent[key]); return { value: v, display: v ? billingDisplay(v, true) : noneLabel, isDefault: !v }; },
    control: { type: 'select', options: (agent, ctx) => {
      const d = modelsOf(ctx); const out = [{ value: '', label: noneLabel }];
      if (extra && extra.none) out.push({ value: 'none', label: 'Never switch' });
      const list = d ? d.models : [];
      const cur = str(agent[key]);
      if (cur && cur !== 'none' && !list.includes(cur)) out.push({ value: cur, label: billingDisplay(cur, true) });
      for (const m of list) out.push({ value: m, label: billingDisplay(m, true) });
      return out;
    } },
    save: (agent, value, ctx) => ctx.patch({ [key]: value || null }),
    resetDefault: (agent, ctx) => ctx.patch({ [key]: null }),
  }, {});
  const toggleRow = (key, extra) => Object.assign({
    get: (agent) => ({ value: agent[key] === true || (key !== 'lead' && !!agent[key]), display: agent[key] ? 'On' : 'Off' }),
    control: { type: 'toggle' },
    save: (agent, value, ctx) => ctx.patch({ [key]: !!value }),
  }, extra || {});

  // ── recordings: who may download, storage ───────────────────────────────────────────────────────────────────
  const OWNER_ONLY = 'Only the owner of this Maestro can change this.';
  const listOf = (v) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const userNameOf = (users, id) => { const u = (users || []).find((x) => String(x.id) === String(id)); return u ? userLabel(u) : String(id); };
  const listFailed = (ctx, key) => { const s = storeOf(ctx); return !!(s && s[key] && s[key].failed && !s[key].data); };
  const recordingsOf = (ctx) => lazy(ctx, 'recordings', () => getJson(ctx, '/api/recordings').then((d) => ({ agents: Array.isArray(d && d.agents) ? d.agents : [] })), 20000);
  function storageLine(ctx) {
    const d = recordingsOf(ctx);
    if (!d) return listFailed(ctx, 'recordings') ? 'Not available' : 'Checking…';
    const mine = d.agents.find((a) => a && a.name === ctx.name);
    if (!mine) return 'Nothing stored';
    const n = Number(mine.sessions) || 0;
    const hours = (Number(mine.speechMs) || 0) / 3600000;
    const mb = (Number(mine.bytes) || 0) / 1048576;
    return n + (n === 1 ? ' call' : ' calls') + ', ' + hours.toFixed(1) + ' hours of speech, ' + mb.toFixed(1) + ' MB on this computer';
  }
  const RECORDINGS_WHO = {
    live: ownerOnly,
    whyNot: () => OWNER_ONLY,
    get: (agent, ctx) => {
      const d = usersOf(ctx);
      const ids = listOf(recOf(agent).allowed);
      return { value: ids, display: ids.length ? ids.map((id) => userNameOf(d && d.users, id)).join(', ') : 'Nobody' };
    },
    control: {
      type: 'custom',
      build: ({ mk, ctx, got, label, send: go }) => {
        const d = usersOf(ctx);
        const wrap = mk('div', 'ac-checks'); wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', label);
        const ids = Array.isArray(got.value) ? got.value.map(String) : [];
        const boxes = [];
        for (const u of (d ? d.users : [])) {
          const row = mk('label', 'ac-check');
          const cb = mk('input', ''); cb.setAttribute('type', 'checkbox'); cb.setAttribute('value', String(u.id)); cb.checked = ids.includes(String(u.id));
          row.appendChild(cb); row.appendChild(mk('span', '', userLabel(u)));
          cb.addEventListener('change', () => go(boxes.filter((b) => b.checked).map((b) => b.getAttribute('value'))));
          boxes.push(cb); wrap.appendChild(row);
        }
        // accounts that could not be read: nothing to tick, the people already allowed stay as they are
        if (!boxes.length) wrap.appendChild(mk('span', 'ac-value', d ? 'No accounts yet.' : (listFailed(ctx, 'users') ? "The accounts couldn't be loaded; the people already ticked stay as they are." : 'Checking…')));
        return wrap;
      },
    },
    save: (agent, value, ctx) => ctx.patch({ recordings: { allowed: listOf(value) } }),   // the server merges the changed key into the stored object
  };
  const STORAGE = { get: (agent, ctx) => { const s = storageLine(ctx); return { value: s, display: s }; }, control: { type: 'readonly' } };

  // ── the model: a suggestion, a test ─────────────────────────────────────────────────────────────────────────
  const offerKey = (ctx) => 'offer|' + ctx.name;
  /** { offer } once read ({ offer: null } = none), else null while it is being read or could not be. */
  const offerOf = (ctx) => lazy(ctx, offerKey(ctx), () => getJson(ctx, '/api/agents/' + encodeURIComponent(ctx.name) + '/model-offer').then((d) => ({ offer: d && d.offer && d.offer.to ? d.offer : null })), 15000);
  const currentOffer = (agent, ctx) => { if (!isAdmin(ctx) || (agent && agent.modelPinned)) return null; const d = offerOf(ctx); return d && d.offer ? d.offer : null; };
  const offerTitle = (o) => (o.kind === 'stronger' ? 'A stronger model for second opinions: ' : 'A newer model is available: ') + modelWords(o.to);
  const OFFER = {
    visible: (agent, ctx) => !!currentOffer(agent, ctx),
    live: (agent, ctx) => isAdmin(ctx),
    label: 'Switch to the suggested model?',
    desc: (agent, ctx) => {
      const o = currentOffer(agent, ctx);
      if (!o) return '';
      return offerTitle(o) + (o.why ? '. ' + String(o.why).replace(/\.$/, '') : '') + (o.route ? '; ' + o.route : '') + (o.cost ? ', ' + o.cost : '') + '.';
    },
    get: () => ({ value: '', display: '' }),
    control: {
      type: 'custom',
      build: ({ mk, ctx, label, send: go }) => {
        const wrap = mk('div', 'ac-offer'); wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', label);
        const yes = mk('button', 'ac-action ac-switch-now', 'Switch'); yes.setAttribute('type', 'button');
        yes.addEventListener('click', () => { if (!yes.disabled) go('switch'); });
        const no = mk('button', 'ac-action ac-not-now', 'Not now'); no.setAttribute('type', 'button');
        no.addEventListener('click', () => { if (!no.disabled) go('decline'); });
        wrap.appendChild(yes); wrap.appendChild(no);
        return wrap;
      },
    },
    save: async (agent, value, ctx) => {
      const o = currentOffer(agent, ctx);
      if (!o) return { ok: false, error: 'That suggestion is no longer there.' };
      const base = '/api/agents/' + encodeURIComponent(ctx.name);
      const r = value === 'decline' ? await send(ctx, 'POST', base + '/model-offer/decline', { model: o.to }) : await send(ctx, 'POST', base + '/model', { model: o.to });
      if (!r.ok) return { ok: false, error: r.error };
      setLazy(ctx, offerKey(ctx), { offer: null });
      return { ok: true };
    },
  };
  const healthLine = (agent, ctx) => { const d = modelsOf(ctx); const h = d && d.health[modelOf(agent)]; return !h ? 'Not checked yet' : (h.state === 'ok' ? 'Working here' : (h.short || h.state || '')); };
  const testNotes = new Map();   // "<agent>|<model>" -> the last answer of Test, in one line
  const testKey = (agent, ctx) => ctx.name + '|' + modelOf(agent);
  const TEST = {
    live: (agent, ctx) => isAdmin(ctx) && !!modelOf(agent),
    desc: (agent, ctx) => testNotes.get(testKey(agent, ctx)) || healthLine(agent, ctx),
    get: (agent, ctx) => ({ value: '', display: isAdmin(ctx) ? 'Test' : healthLine(agent, ctx) }),
    control: { type: 'action' },
    save: async (agent, value, ctx) => {
      const model = modelOf(agent);
      if (!model) return { ok: false, error: 'This agent has no model to test.' };
      const key = testKey(agent, ctx);
      const r = await send(ctx, 'POST', '/api/models/test', { model });
      const j = r.data || {};
      if (r.ok && j.success && j.toolCall === false) {   // it answered, but did not call the test tool: agents here need tools
        testNotes.delete(key);
        return { ok: false, error: (str(j.title || model) + ' ' + str(j.what) + ' ' + str(j.fix)).replace(/\s+/g, ' ').trim() };
      }
      if (r.ok && j.success !== false) { testNotes.set(key, 'It answered in ' + nfms(j.latency) + (j.response ? ': "' + str(j.response).slice(0, 120) + '"' : '') + '.'); return { ok: true }; }
      testNotes.delete(key);
      return { ok: false, error: str(model) + ': ' + (r.error || j.error || 'it did not answer') };
    },
  };
  const nfms = (ms) => (Number.isFinite(Number(ms)) ? Number(ms) + ' ms' : 'time');

  // ── build team / optimize team (admins; the lead's or reviewer's chat opens afterwards) ─────────────────────────
  const nodeRequire = (typeof module === 'object' && module && typeof require === 'function') ? require : null;
  function teamsLib(ctx) {
    const w = ctx && ctx.win;
    if (w && w.hubTeams && typeof w.hubTeams.hasTeam === 'function') return w.hubTeams;
    try { if (nodeRequire) return nodeRequire('./ui-teams.js'); } catch { /* the plain rule below */ }
    return {
      isMain: (a) => !!(a && (a.category === 'primary' || a.lead === true)),
      hasTeam: (name, list) => (list || []).some((x) => x && x.reportsTo === name),
    };
  }
  const isMainOf = (agent, ctx) => teamsLib(ctx).isMain(agent);
  const hasTeamOf = (agent, ctx) => teamsLib(ctx).hasTeam(agent.name, ctx.agents || []);
  /** Open the chat of the agent that got the work (the page's own way: the desktop's startSoloChat, the phone's navigate). */
  function openChatOf(ctx, name) {
    const w = ctx && ctx.win;
    if (!w || !name) return;
    const a = (ctx.agents || []).find((x) => x && x.name === name);
    try {
      if (typeof w.startSoloChat === 'function') w.startSoloChat(name, (a && a.model) || '');
      else if (typeof w.navigate === 'function') w.navigate('chat', name);
    } catch { /* the chat stays closed */ }
  }
  const estimateOf = (ctx) => lazy(ctx, 'estimate|' + ctx.name, () => getJson(ctx, '/api/agents/' + encodeURIComponent(ctx.name) + '/optimize-team/estimate').then((d) => ({ days: d && d.days, turns: d && d.turns, handOffs: d && d.handOffs })), 20000);
  async function startTeamWork(ctx, kind) {   // kind: 'build' | 'optimize'
    const w = ctx.win;
    const page = w && w[kind === 'build' ? 'buildTeamStart' : 'optimizeTeamStart'];
    if (typeof page === 'function') {   // the page's own function does the request, the busy marks, the messages and opens the chat
      try { await page.call(w, ctx.name); return { ok: true }; } catch (e) { return { ok: false, error: (e && e.message) || 'Could not start.' }; }
    }
    const r = await send(ctx, 'POST', '/api/agents/' + encodeURIComponent(ctx.name) + (kind === 'build' ? '/build-team' : '/optimize-team'), {});
    if (!r.ok) return { ok: false, error: r.error || (kind === 'build' ? 'Could not start building a team.' : 'Could not start the review.') };
    const d = r.data || {};
    openChatOf(ctx, kind === 'build' ? d.lead : d.reviewer);
    return { ok: true };
  }
  const BUILD = {
    visible: (agent, ctx) => isAdmin(ctx) && isMainOf(agent, ctx) && !hasTeamOf(agent, ctx),
    live: (agent, ctx) => isAdmin(ctx),
    desc: 'Asks the lead to suggest a team for this main agent. The proposal arrives in the lead\'s chat.',
    get: () => ({ value: '', display: 'Build team' }),
    control: { type: 'action' },
    save: (agent, value, ctx) => startTeamWork(ctx, 'build'),
  };
  const OPTIMIZE = {
    visible: (agent, ctx) => isAdmin(ctx) && isMainOf(agent, ctx) && hasTeamOf(agent, ctx),
    live: (agent, ctx) => isAdmin(ctx),
    desc: (agent, ctx) => {
      const e = estimateOf(ctx);
      const sub = e ? 'reads ' + (Number(e.days) || 30) + ' days: ' + (Number(e.turns) || 0) + ' turns, ' + (Number(e.handOffs) || 0) + ' hand-offs' : 'reads the last 30 days';
      return 'Asks a reviewer to read the last 30 days of this team\'s work and suggest changes; ' + sub + '.';
    },
    get: () => ({ value: '', display: 'Optimize team' }),
    control: { type: 'action' },
    save: (agent, value, ctx) => startTeamWork(ctx, 'optimize'),
  };

  // ── Role and team ────────────────────────────────────────────────────────────────────────────────────────────
  const CATEGORIES = [{ value: 'primary', label: 'Primary agent' }, { value: 'specialist', label: 'Domain specialist' }, { value: 'worker', label: 'Worker agent' }];
  const agentChoices = (ctx, noneLabel) => {
    const out = [{ value: '', label: noneLabel }];
    for (const a of (ctx.agents || [])) if (a && a.name && a.name !== ctx.name) out.push({ value: a.name, label: a.display || a.name });
    return out;
  };
  const userLabel = (u) => str(u.name || u.login || u.id) + (u.disabled ? ' (disabled)' : '');
  const RENAME_RE = /[^a-z0-9_-]/g;
  async function renameTo(agent, value, ctx) {
    const next = str(value).trim().toLowerCase().replace(RENAME_RE, '');
    if (!next) return { ok: false, error: 'The short name can not be empty.' };
    if (next === ctx.name) return { ok: false, error: 'That is the current short name.' };
    const w = ctx.win;
    if (!(w && typeof w.confirm === 'function' && w.confirm('Rename agent "' + ctx.name + '" to "' + next + '"?  This renames the workspace folder, conversation file, and config entry.'))) return { ok: true };
    const r = await send(ctx, 'POST', '/api/agents/rename', { oldName: ctx.name, newName: next });
    if (!r.ok) return { ok: false, error: r.error };
    // The card was open on the old name: reopen it on the new one, at this row.
    if (typeof ctx.open === 'function') { try { await ctx.open(next, { row: 'OPT-0001' }); } catch { /* the page's own list follows */ } }
    return { ok: true };
  }
  async function deleteAgent(agent, value, ctx) {
    const r = await send(ctx, 'DELETE', '/api/agents/' + encodeURIComponent(ctx.name));
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  const ROWS = {
    // ── Basics ──
    'OPT-0047': MODEL,
    'OPT-0057': EFFORT,
    'OPT-0168': NOTIFY,
    'OPT-0023': VOICE,
    'OPT-0063': CALL,
    'OPT-0169': kindRow('questions', 'Questions'),
    'OPT-0170': kindRow('requested', 'Requests you made'),
    'OPT-0171': kindRow('other', 'Everything else'),
    // voice details (under More, shown once "Its own voice" is chosen)
    'OPT-0022': ownRow({
      get: (agent) => { const v = voiceOf(agent).stt || 'local'; return { value: v, display: v === 'local' ? 'This computer (free)' : (ENGINE_NAMES[v] || v) }; },
      control: { type: 'select', options: () => [{ value: 'local', label: 'This computer (free)' }, { value: 'openai', label: 'OpenAI' }, { value: 'google', label: 'Google' }] },
      save: (agent, value, ctx) => saveVoice(agent, { stt: value }, ctx),
    }),
    'OPT-0024': ownRow({
      label: 'Speaks with',
      get: (agent) => { const v = cloudValue(agent); return { value: v, display: v === 'local' ? 'This computer (free)' : (v === 'elevenlabs' ? 'ElevenLabs' : v.replace(':', ' · ')) }; },
      control: { type: 'select', options: (agent) => {
        const out = [{ value: 'local', label: 'This computer (free)' }];
        for (const e of ['openai', 'google']) for (const v of CLOUD_VOICES[e]) out.push({ value: e + ':' + v, label: ENGINE_NAMES[e] + ' · ' + v });
        if (voiceOf(agent).tts === 'elevenlabs') out.push({ value: 'elevenlabs', label: 'ElevenLabs (voice ID below)' });
        return out;
      } },
      save: (agent, value, ctx) => {
        if (value === 'elevenlabs') return { ok: true };
        if (value === 'local') return saveVoice(agent, { tts: 'local' }, ctx);
        const [engine, voice] = String(value).split(':');
        return saveVoice(agent, { tts: engine, cloudVoice: voice }, ctx);
      },
    }),
    'OPT-0025': ownRow({
      get: (agent) => ({ value: voiceOf(agent).tts === 'elevenlabs' ? str(voiceOf(agent).cloudVoice) : '', display: voiceOf(agent).tts === 'elevenlabs' ? str(voiceOf(agent).cloudVoice) : '' }),
      control: { type: 'text', max: 40 },
      save: (agent, value, ctx) => {
        const id = str(value).trim();
        if (!id) return voiceOf(agent).tts === 'elevenlabs' ? saveVoice(agent, { tts: 'local' }, ctx) : { ok: true };
        return saveVoice(agent, { tts: 'elevenlabs', cloudVoice: id }, ctx);
      },
    }),
    'OPT-0026': ownRow({
      get: (agent, ctx) => { voicesOf(ctx); const v = voiceOf(agent).voice || ''; const d = voicesOf(ctx); const hit = d && d.voices.find((x) => x.id === v); return { value: v, display: v ? ((hit && (hit.label || hit.id)) || v) : 'Hub default' }; },
      control: { type: 'select', options: (agent, ctx) => {
        const d = voicesOf(ctx); const out = [{ value: '', label: 'Hub default' }];
        const cur = voiceOf(agent).voice || '';
        const list = d ? d.voices : [];
        if (cur && !list.some((x) => x.id === cur)) out.push({ value: cur, label: cur });
        for (const v of list) out.push({ value: v.id, label: v.label || v.id });
        return out;
      } },
      save: (agent, value, ctx) => saveVoice(agent, { voice: value }, ctx),
    }),
    // call timing
    'OPT-0028': {
      live: (agent, ctx) => isAdmin(ctx),
      get: (agent) => { const m = vdMode(agent); return { value: m, display: m === 'none' ? 'Each device decides' : (m === 'patient' ? 'Patient' : 'Custom'), isDefault: m === 'none' }; },
      control: { type: 'select', options: () => [{ value: 'none', label: 'Each device decides' }, { value: 'patient', label: 'Patient' }, { value: 'custom', label: 'Custom' }] },
      save: async (agent, value, ctx) => {
        if (value === 'none') return ctx.patch({ voiceDefaults: null });
        if (value === 'patient') return ctx.patch({ voiceDefaults: { preset: 'patient' } });
        // Custom: the preset name goes (null) and the four numbers are set; they are read from the hub now, so a number another device just set stays
        const f = await freshOf(agent, ctx);
        if (f.error) return { ok: false, error: f.error };
        return ctx.patch({ voiceDefaults: Object.assign({ preset: null }, customTiming(f.agent)) });
      },
      resetDefault: (agent, ctx) => ctx.patch({ voiceDefaults: null }),
    },
    'OPT-0029': vdChoice('endPause', 'Pause before it answers', END_PAUSES),
    'OPT-0030': vdChoice('continueWait', 'Wait if I pause', CONTINUE_WAITS),
    'OPT-0031': vdNumber('interruptSensitivity', 'How easily it is interrupted (0-100)', { min: 0, max: 100, step: 5, whole: true }),
    'OPT-0032': vdNumber('voiceSpeed', 'Voice speed', { min: 0.75, max: 1.5, step: 0.05, multipleOf: 0.05 }),
    // recordings (the route: the owner only)
    'OPT-0033': recRow('keep', { type: 'toggle' }),
    'OPT-0035': recRow('consentLine', { type: 'text', max: 400 }),
    'OPT-0036': recRow('announce', { type: 'select', options: () => [{ value: 'first', label: 'First call with each person' }, { value: 'every', label: 'Every call' }, { value: 'never', label: 'Never' }] }),
    'OPT-0037': recRow('keepReplies', { type: 'toggle' }),
    'OPT-0038': recRow('mic', { type: 'select', options: () => [{ value: 'processed', label: 'Processed (clearer on a speakerphone)' }, { value: 'unprocessed', label: 'Unprocessed (best for a future voice model; use a headset or a quiet room)' }] }),
    // model extras
    'OPT-0049': toggleRow('modelPinned', { live: (agent, ctx) => isAdmin(ctx) }),
    'OPT-0051': toggleRow('autoModel', { live: (agent, ctx) => isAdmin(ctx) }),
    'OPT-0052': {
      visible: (agent) => !!agent.autoModel,
      get: (agent) => ({ value: Array.isArray(agent.autoModelAllowedModels) ? agent.autoModelAllowedModels : [], display: Array.isArray(agent.autoModelAllowedModels) && agent.autoModelAllowedModels.length ? agent.autoModelAllowedModels.join(', ') : 'All models', isDefault: !Array.isArray(agent.autoModelAllowedModels) || !agent.autoModelAllowedModels.length }),
      control: { type: 'list' },
      save: (agent, value, ctx) => ctx.patch({ autoModelAllowedModels: Array.isArray(value) && value.length ? value : null }),
      resetDefault: (agent, ctx) => ctx.patch({ autoModelAllowedModels: null }),
    },
    'OPT-0058': {
      visible: (agent) => Array.isArray(agent.tierOptions) && agent.tierOptions.length > 1,
      get: (agent) => { const v = str(agent.tier) || 'standard'; return { value: v, display: (agent.tierLabels && agent.tierLabels[v]) || v }; },
      control: { type: 'select', options: (agent) => (agent.tierOptions || []).map((v) => ({ value: v, label: (agent.tierLabels && agent.tierLabels[v]) || v })) },
      save: (agent, value, ctx) => ctx.patch({ tier: value }),
    },
    'OPT-0050': TEST,
    'OPT-0048': OFFER,
    'OPT-0034': RECORDINGS_WHO,
    'OPT-0039': STORAGE,
    'OPT-0138': BUILD,
    'OPT-0139': OPTIMIZE,
    'OPT-0066': {
      members: () => true,
      get: (agent) => ({ value: agent.maxOutputTokens || '', display: agent.maxOutputTokens ? str(agent.maxOutputTokens) : 'Default', isDefault: !agent.maxOutputTokens }),
      control: { type: 'number', min: 100, max: 128000, step: 100 },
      save: (agent, value, ctx) => ctx.patch({ maxOutputTokens: value }),
      resetDefault: (agent, ctx) => ctx.patch({ maxOutputTokens: null }),
    },
    'OPT-0075': modelPickRow('minModel', 'No limit'),
    'OPT-0076': modelPickRow('fallbackModel', "The hub's usual substitute", { none: true }),
    // ── Role and team ──
    'OPT-0001': {
      label: 'Short name',
      get: (agent) => ({ value: agent.name, display: agent.name }),
      control: { type: 'text', max: 64 },
      save: renameTo,
    },
    'OPT-0002': {
      get: (agent) => ({ value: str(agent.display), display: str(agent.display) }),
      control: { type: 'text', max: 60 },
      save: async (agent, value, ctx) => {
        const display = str(value).trim();
        if (!display) return { ok: false, error: 'The name can not be empty.' };
        const r = await send(ctx, 'POST', '/api/agents/' + encodeURIComponent(ctx.name) + '/display', { display });
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
    },
    'OPT-0003': {
      get: (agent) => { const v = str(agent.category) || 'specialist'; const o = CATEGORIES.find((c) => c.value === v); return { value: v, display: o ? o.label : v }; },
      control: { type: 'select', options: () => CATEGORIES },
      save: (agent, value, ctx) => ctx.patch({ category: value }),
      summary: (agent, ctx) => card.roleLine(agent, ctx.agents),
    },
    'OPT-0004': toggleRow('lead'),
    'OPT-0006': {
      live: (agent, ctx) => isAdmin(ctx) && !!usersOf(ctx),
      get: (agent, ctx) => { const d = usersOf(ctx); const u = d && d.users.find((x) => String(x.id) === String(agent.owner)); return { value: agent.owner ? String(agent.owner) : '', display: agent.owner ? (u ? userLabel(u) : String(agent.owner)) : 'Infrastructure (no owner)' }; },
      control: { type: 'select', options: (agent, ctx) => {
        const d = usersOf(ctx); const out = [{ value: '', label: 'Infrastructure (no owner)' }];
        const list = d ? d.users : [];
        if (agent.owner && !list.some((u) => String(u.id) === String(agent.owner))) out.push({ value: String(agent.owner), label: String(agent.owner) });
        for (const u of list) out.push({ value: String(u.id), label: userLabel(u) });
        return out;
      } },
      save: (agent, value, ctx) => ctx.patch({ owner: value || null }),
    },
    'OPT-0007': {
      live: (agent, ctx) => isAdmin(ctx) && !!usersOf(ctx),
      get: (agent, ctx) => { const d = usersOf(ctx); const ids = Array.isArray(agent.sharedWith) ? agent.sharedWith.map(String) : []; const names = ids.map((id) => { const u = d && d.users.find((x) => String(x.id) === id); return u ? userLabel(u) : id; }); return { value: ids, display: names.length ? names.join(', ') : 'Nobody' }; },
      control: {
        type: 'custom',
        build: ({ mk, agent, ctx, got, label, send: go }) => {
          const d = usersOf(ctx);
          const wrap = mk('div', 'ac-checks'); wrap.setAttribute('role', 'group'); wrap.setAttribute('aria-label', label);
          const ids = Array.isArray(got.value) ? got.value.map(String) : [];
          const boxes = [];
          for (const u of (d ? d.users : [])) {
            const isOwner = agent.owner != null && String(agent.owner) === String(u.id);
            const row = mk('label', 'ac-check');
            const cb = mk('input', ''); cb.setAttribute('type', 'checkbox'); cb.setAttribute('value', String(u.id)); cb.checked = ids.includes(String(u.id));
            if (isOwner) { cb.disabled = true; cb.setAttribute('disabled', ''); }
            row.appendChild(cb); row.appendChild(mk('span', '', userLabel(u) + (isOwner ? ', the owner' : '')));
            cb.addEventListener('change', () => go(boxes.filter((b) => b.checked).map((b) => b.getAttribute('value'))));
            boxes.push(cb); wrap.appendChild(row);
          }
          if (!boxes.length) wrap.appendChild(mk('span', 'ac-value', ids.length ? ids.join(', ') : 'Nobody'));
          return wrap;
        },
      },
      save: (agent, value, ctx) => ctx.patch({ sharedWith: Array.isArray(value) ? value : [] }),
    },
    'OPT-0045': {
      get: (agent) => ({ value: str(agent.icon), display: str(agent.icon) }),
      control: { type: 'text', max: 8 },
      save: async (agent, value, ctx) => {
        const r = await send(ctx, 'POST', '/api/agents/' + encodeURIComponent(ctx.name) + '/icon', { icon: str(value).trim() });   // empty = made automatically
        return r.ok ? { ok: true } : { ok: false, error: r.error };
      },
    },
    'OPT-0059': {
      get: (agent) => { const v = str(agent.teamGuidance) || 'inherit'; return { value: v, display: v === 'inherit' ? 'Use the hub setting' : (v === 'on' ? 'On' : 'Off'), isDefault: v === 'inherit' }; },
      control: { type: 'select', options: () => [{ value: 'inherit', label: 'Use the hub setting' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] },
      save: (agent, value, ctx) => ctx.patch({ teamGuidance: value }),
      resetDefault: (agent, ctx) => ctx.patch({ teamGuidance: 'inherit' }),
    },
    'OPT-0060': {
      get: (agent) => { const v = str(agent.teamRole); return { value: v, display: v === 'worker' ? 'Worker' : (v === 'challenger' ? 'Challenger' : 'None') }; },
      control: { type: 'select', options: () => [{ value: '', label: 'None' }, { value: 'worker', label: 'Worker' }, { value: 'challenger', label: 'Challenger' }] },
      save: (agent, value, ctx) => ctx.patch({ teamRole: value }),
    },
    'OPT-0061': {
      get: (agent) => ({ value: str(agent.buildPartner), display: str(agent.buildPartner) || 'None' }),
      control: { type: 'select', options: (agent, ctx) => agentChoices(ctx, 'None') },
      save: (agent, value, ctx) => ctx.patch({ buildPartner: value }),
    },
    'OPT-0062': {
      live: (agent, ctx) => isAdmin(ctx) && agent.category !== 'primary',
      get: (agent, ctx) => { const b = (ctx.agents || []).find((a) => a && a.name === agent.reportsTo); return { value: str(agent.reportsTo), display: agent.reportsTo ? ((b && b.display) || agent.reportsTo) : (agent.category === 'primary' ? displayOf(agent) + ' is a primary agent and takes its work from you.' : 'Nobody') }; },
      whyNot: (agent) => (agent.category === 'primary' ? '' : undefined),   // undefined: the card's own "change it elsewhere" line
      control: { type: 'select', options: (agent, ctx) => agentChoices(ctx, 'Nobody') },
      save: (agent, value, ctx) => ctx.patch({ reportsTo: value }),
    },
    'OPT-0074': { bottom: true, label: 'Remove this agent', confirm: (agent) => deleteQuestion(agent), control: { type: 'action' }, get: () => ({ value: '', display: 'Remove this agent' }), save: deleteAgent },
  };
  // Records whose control lives elsewhere (a chip, another phone screen, a per-device value) or repeats a row above: not drawn on the card.
  for (const id of ['OPT-0817', 'OPT-0827', 'OPT-0885', 'OPT-0046', 'OPT-0137', 'OPT-0142', 'OPT-0143', 'OPT-0140', 'OPT-0178', 'OPT-0219', 'OPT-0475', 'OPT-0476', 'OPT-0477', 'OPT-0702', 'OPT-0826', 'OPT-0844', 'OPT-0866', 'OPT-0867', 'OPT-0868', 'OPT-0873', 'OPT-0878', 'OPT-0879', 'OPT-0880', 'OPT-1030', 'OPT-1040', 'OPT-1074', 'OPT-1075', 'OPT-1076', 'OPT-1077']) ROWS[id] = hidden;

  const FIRST_ROWS = {
    basics: ['OPT-0047', 'OPT-0057', 'OPT-0168', 'OPT-0023', 'OPT-0063'],   // Model, Thinking effort, Notifications, Voice, Call display
    role: ['OPT-0003', 'OPT-0062', 'OPT-0060'],                             // Role, Reports to, Its job in the team (rename, owner, sharing: under More)
  };
  if (card) { card.registerMany(ROWS); card.setFirstRows('basics', FIRST_ROWS.basics); card.setFirstRows('role', FIRST_ROWS.role); }

  /** For the tests: forget the "its own voice" marks (the lists are cached per fetch function). */
  function reset() { ownVoiceFlag.clear(); }
  return { ROWS, FIRST_ROWS, effortLevels, effortOptions, notifyState, presetKinds, effectiveMode, hasOwnVoice, voiceBody, billingDisplay, modelName, PRESETS, EFFORT_WORDS, reset };
});
