'use strict';
// One shared way to change a setting. The screens' routes (POST /api/settings, the one-value routes, PATCH /api/agents/:name) and
// the lead's settings tool all use the checks and the writers in this file, so a change made by the tool is held to exactly the
// rules a change made on a screen is held to. Nothing here writes a store directly: every write goes through the store's own
// function (updateSettings, updateAgentField, the preferences setters), inside settings-journal withActor(), so each change is
// journaled once with who made it.
//
//   target(record)                      where a record's value lives: settings | agent | prefs | device | screen
//   current({ record, agent, user })    the value now (a secret is { set: true }, never the value)
//   check({ record, value, ... })       { ok, value (cleaned), error } with the route's own rules
//   apply({ record, value, ... })       check, then write; resolves { ok, before, after, journalIds, restart }
//   cleanSettingsPatch(patch, ctx)      the per-key cleaners and guards of POST /api/settings
//   agentFieldAllowed(fields, ctx)      the guards of PATCH /api/agents/:name
//   setGlobalSetting(key, value)        the six one-value routes (max_completion_tokens, ...): writes only that key
// lib/settings reads data/settings.json as soon as it is loaded; it is loaded on first use, so the journal's record lookup (which only
// needs target()) never makes a preference store elsewhere read the install's settings.
const hubSettings = new Proxy({}, { get: (_, k) => require('./settings')[k] });
const journal = require('./settings-journal');

// ── POST /api/settings: dropped keys, guards and per-key cleaners ─────────────────────────────────────
// Keys the bulk route never writes (each has its own screen or file), with the line it logs.
const DROPPED_KEYS = {
  // The wallet-agent list is not a UI setting: widening it hands signing tools to another agent. Owner edits data/settings.json by hand.
  // Backups (key, folders) change only through /api/backups/*, which asks for the password and two-factor code again.
  backup: '[settings] ignored backup in /api/settings patch (use Settings → Backups)',
  walletAgents: '[settings] ignored walletAgents in /api/settings patch (edit data/settings.json directly)',
  // The owner's receiving address decides where wallet value may go: not a UI setting either (review F10). HUB_WALLET_OWNER in .env, or data/settings.json by hand.
  walletOwner: '[settings] ignored walletOwner in /api/settings patch (set HUB_WALLET_OWNER or edit data/settings.json directly)',
  // The admin two-factor rule changes only through /api/security/admin-2fa, which asks for the password (and code) again.
  requireAdmin2fa: '[settings] ignored requireAdmin2fa in /api/settings patch (use Settings → Security)',
  // receiverAliases makes paths public (lib/modules/receivers): set only by hand in data/settings.json.
  receiverAliases: '[settings] ignored receiverAliases in /api/settings patch (edit data/settings.json directly)',
  // The tool safety rules switch and the medical and legal team templates are install-wide protections shown read-only on the settings page (phase 5c): file edit only.
  toolPolicy: '[settings] ignored toolPolicy in /api/settings patch (edit data/settings.json directly)',
  teamTemplates: '[settings] ignored teamTemplates in /api/settings patch (edit data/settings.json directly)',
};

// ── Cleaners for the numbers, words, switches and addresses the Settings page now sets (phase 5c) ─────
// null (or blank) means "use the default": the cleaner hands null on and updateSettings deletes the stored key (lib/settings REMOVE_ON_NULL),
// so a reader that asks with a fallback gets its fallback, not null.
const MODEL_ID = /^[A-Za-z0-9._:/@[\]-]{1,120}$/;
const NUMBER_KEYS = {
  approvalTimeoutMinutes: { min: 1, max: 10080, int: true, what: 'minutes' },
  connectorsUnlockMinutes: { min: 0, max: 10080, int: true, what: 'minutes' },
  filesMaxUploadMb: { min: 1, max: 102400, int: true, what: 'MB' },
  filesZipMaxMb: { min: 1, max: 3900, int: true, what: 'MB' },
  filesZipMaxFiles: { min: 1, max: 65535, int: true, what: 'files' },
  recordsMaxBytes: { min: 4096, max: 2097152, int: true, what: 'bytes' },
  sandboxHomeMoveMinutes: { min: 1, max: 1440, int: true, what: 'minutes' },
  compactionAt: { min: 0.3, max: 0.95, int: false, what: '(a fraction, 0.3 to 0.95)' },
  jobMemoryLimitGb: { min: 0, max: 4096, int: false, what: 'GB (0 = no limit)' },
};
const ENUM_KEYS = {
  compactionMode: ['off', 'dry', 'on', 'assisted'],
  imageProvider: ['google', 'openai'],
};
const BOOL_KEYS = ['confirmTools', 'hubBrief'];
const numberFrom = (v) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN);
/** { value } (null = use the default) or { error }, for one of NUMBER_KEYS. */
function cleanNumberKey(key, v) {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return { value: null };
  const spec = NUMBER_KEYS[key], n = numberFrom(v);
  const range = `${spec.int ? 'a whole number' : 'a number'} from ${spec.min} to ${spec.max}`;
  if (!Number.isFinite(n) || n < spec.min || n > spec.max || (spec.int && !Number.isInteger(n))) return { error: `${key} must be ${range}${spec.what && !spec.what.startsWith('(') ? ' ' + spec.what : ''}` };
  return { value: n };
}
/** { value } or { error } for a provider's address: http(s), no user name or password in it, blank = the provider's own. */
function cleanProviderUrl(label, v) {
  if (v === null || v === '') return { value: '' };
  if (typeof v !== 'string') return { error: `${label} must be a web address` };
  const s = v.trim();
  let u = null;
  try { u = new URL(s); } catch { u = null; }
  if (!u || s.length > 300 || /\s/.test(s) || !/^https?:$/.test(u.protocol)) return { error: `${label} must be a web address starting with http:// or https://` };
  if (u.username || u.password) return { error: `${label} must not hold a user name or password` };
  return { value: s };
}
const isModelId = (v) => typeof v === 'string' && MODEL_ID.test(v);

/**
 * Checks and cleans a settings patch exactly as POST /api/settings does. Changes `patch` in place (dropped keys removed, each
 * cleaner's result put back) and returns { patch, errors, status, lockboxChange, dropped }. errors is empty when the patch may be
 * written; otherwise it holds the first refusal (the route answers `status` with { error: errors[0] }).
 * ctx: { ownSession: a signed-in admin's own browser session, who: name for the lockbox notice, getSetting }.
 */
function cleanSettingsPatch(patch, ctx = {}) {
  const getSetting = typeof ctx.getSetting === 'function' ? ctx.getSetting : hubSettings.getSetting;
  const out = { patch, errors: [], status: 200, lockboxChange: null, dropped: [] };
  const fail = (msg, status = 400) => { out.errors.push(msg); out.status = status; return out; };
  if (!patch || typeof patch !== 'object') return out;

  for (const [key, line] of Object.entries(DROPPED_KEYS)) {
    if (key in patch) { console.warn(line); delete patch[key]; out.dropped.push(key); }
  }
  // The command lockbox hub default (off | watch | enforce): a signed-in admin's own browser session only; a change is audited and told to the admins.
  const lockboxCheck = require('./lockbox/settings').checkDefaultPatchFor(patch, { ownSession: !!ctx.ownSession, who: ctx.who }, getSetting);
  if (!lockboxCheck.ok) return fail(lockboxCheck.error, lockboxCheck.status);
  out.lockboxChange = lockboxCheck.change;
  // Hub default for every member agent: grantable classes and valid decisions only (lib/tool-policy).
  if (patch.memberPolicy !== undefined) patch.memberPolicy = require('./tool-policy').sanitizeGrants({ policy: patch.memberPolicy }).policy || {};
  // Per-class approval cards: known class names only (lib/policy-gate APPROVAL_CLASSES).
  if (patch.approvalClasses !== undefined) { const ok = require('./policy-gate').APPROVAL_CLASSES; patch.approvalClasses = Array.isArray(patch.approvalClasses) ? [...new Set(patch.approvalClasses.map(String).filter(c => ok.includes(c)))] : []; }
  // The look a new member starts with: one of the registry's ids (lib/ui-looks); anything else is refused.
  if (patch.lookDefaultForNewMembers !== undefined && !require('./ui-looks').byId(patch.lookDefaultForNewMembers)) return fail('lookDefaultForNewMembers must be one of: ' + require('./ui-looks').LOOKS.map(l => l.id).join(', '));
  // Claude plan: warning levels, and the optional automatic switch (merged onto the stored policy, so its map survives).
  if (patch.planWarn !== undefined) patch.planWarn = require('./plan-usage').cleanWarn(patch.planWarn);
  if (patch.notify !== undefined) patch.notify = require('./push').cleanNotifySettings(patch.notify);
  if (patch.openrouter !== undefined) patch.openrouter = require('./openrouter').cleanOpenRouterSettings(patch.openrouter);
  if (patch.planFallback !== undefined) {
    // the plan level to switch at is 1..100 and each lighter model is a Claude model id (the cleaner below would only skip a bad one)
    // null removes: the whole policy, its threshold (at), its list of substitutes (map) or one family's entry ({ family: null })
    const pf = patch.planFallback;
    if (pf && typeof pf === 'object' && !Array.isArray(pf)) {
      if (pf.at !== undefined && pf.at !== null) { const n = numberFrom(pf.at); if (!Number.isFinite(n) || n < 1 || n > 100) return fail('planFallback.at must be a number from 1 to 100'); }
      if (pf.map !== undefined && pf.map !== null) {
        if (!pf.map || typeof pf.map !== 'object' || Array.isArray(pf.map)) return fail('planFallback.map must be a list of model families and models');
        for (const [fam, m] of Object.entries(pf.map)) if (m !== null && !/^claude-sdk\/[\w.[\]-]+$/.test(String(m))) return fail(`planFallback.map.${fam} must be a Claude model such as claude-sdk/claude-sonnet-5-5`);
      }
    }
    if (pf === null) patch.planFallback = null;
    else {
      const next = require('./plan-usage').cleanPolicy(pf, getSetting('planFallback'));
      patch.planFallback = Object.keys(next).length ? next : null;
    }
  }
  // Share links: enabled, defaultHours, maxHours (hard maximum 168), merged onto the stored value (lib/share-links cleanSettings).
  if (patch.shareLinks !== undefined) patch.shareLinks = require('./share-links').cleanSettings(patch.shareLinks, getSetting('shareLinks'));
  // The reasoning panel (lib/sdk-chat showReasoning): on unless turned off.
  if (patch.showReasoning !== undefined) patch.showReasoning = patch.showReasoning !== false;
  if (patch.modelOffers !== undefined) patch.modelOffers = patch.modelOffers !== false;
  // Deep research (lib/research): how often a person who chose Never is reminded that it is off, in days 0..365 (0 = never).
  if (patch.researchReminderDays !== undefined) {
    const d = Number(patch.researchReminderDays);
    if (!Number.isInteger(d) || d < 0 || d > 365) return fail('researchReminderDays must be a whole number of days from 0 to 365');
    patch.researchReminderDays = d;
  }
  // Deep research, how long a question waits for the person before a quick run starts by itself, in seconds 0..600 (0 = no card, start at once).
  if (patch.researchOfferWaitSeconds !== undefined) {
    const v = patch.researchOfferWaitSeconds;
    const n = typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 600) return fail('researchOfferWaitSeconds must be a whole number of seconds from 0 to 600');
    patch.researchOfferWaitSeconds = n;
  }
  // Deep research started by agents without a yes: the daily limits per agent (0..100) and for the install (0..1000), 0 = no limit; merged onto the stored value.
  if (patch.researchAgentCaps !== undefined) {
    const v = patch.researchAgentCaps;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('researchAgentCaps must be an object');
    const ranges = { perAgent: [0, 100], install: [0, 1000] };
    const merged = { ...(getSetting('researchAgentCaps') || {}) };
    for (const [k, val] of Object.entries(v)) {
      if (!ranges[k]) return fail(`researchAgentCaps.${k} is not a setting`);
      const [lo, hi] = ranges[k];
      const n = typeof val === 'string' && /^\s*\d+\s*$/.test(val) ? Number(val) : val;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) return fail(`researchAgentCaps.${k} must be a whole number from ${lo} to ${hi}`);
      merged[k] = n;
    }
    patch.researchAgentCaps = merged;
  }
  // Thorough deep research caps (admin): known fields only, each in its range (lib/research-thorough); merged onto the stored value.
  if (patch.researchThorough !== undefined) {
    const v = patch.researchThorough;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('researchThorough must be an object');
    const ranges = { maxSources: [1, 40], readersAtOnce: [1, 12], reviewRounds: [0, 5], timeLimitMinutes: [10, 240],
      leadSteps: [5, 300], leadWallMinutes: [10, 1440], leadReaderCalls: [1, 400], leadReviewRounds: [0, 50], leadTopicSearches: [0, 20], leadSourcesPerSub: [0, 20], leadTopNewPerSub: [0, 10], leadPdfMaxMB: [4, 64], leadReaderTextMax: [20000, 2000000], leadReaderTopTextMax: [20000, 2000000] };
    const modelKeys = ['leadModel', 'leadReaderModel', 'leadReaderTopModel'];
    const known = [...Object.keys(ranges), 'pdf', 'readerModel', 'engine', ...modelKeys];
    const merged = { ...(getSetting('researchThorough') || {}) };
    for (const [k, val] of Object.entries(v)) {
      if (!known.includes(k)) return fail(`researchThorough.${k} is not a setting`);
      if (ranges[k]) {
        const [lo, hi] = ranges[k];
        const n = typeof val === 'string' && /^\s*-?\d+\s*$/.test(val) ? Number(val) : val;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < lo || n > hi) return fail(`researchThorough.${k} must be a whole number from ${lo} to ${hi}`);
        merged[k] = n;
      } else if (k === 'pdf') {
        if (typeof val !== 'boolean') return fail('researchThorough.pdf must be true or false');
        merged[k] = val;
      } else if (k === 'engine') {
        if (val !== 'lead' && val !== 'pipeline') return fail("researchThorough.engine must be 'lead' or 'pipeline'");
        merged[k] = val;
      } else if (modelKeys.includes(k)) {
        if (typeof val !== 'string' || !(val === 'auto' || (val.length >= 1 && val.length <= 120 && /^[A-Za-z0-9._:/@[\]-]+$/.test(val)))) return fail(`researchThorough.${k} must be 'auto' or a model id`);
        merged[k] = val;
      } else {
        if (val !== 'own' && val !== 'helper') return fail("researchThorough.readerModel must be 'own' or 'helper'");
        merged[k] = val;
      }
    }
    patch.researchThorough = merged;
  }
  // Which search the research helpers use: their usual one (default) or also the hub's (a test option).
  if (patch.researchHelperSearch !== undefined && patch.researchHelperSearch !== 'default' && patch.researchHelperSearch !== 'both') return fail("researchHelperSearch must be 'default' or 'both'");
  // Subscription usage (lib/codex-usage, Settings → Subscriptions): on unless turned off.
  if (patch.subscriptionUsage !== undefined) patch.subscriptionUsage = patch.subscriptionUsage !== false;
  if (patch.componentUpdates !== undefined) patch.componentUpdates = { codex: ['auto', 'notify', 'off'].includes(patch.componentUpdates && patch.componentUpdates.codex) ? patch.componentUpdates.codex : 'auto' };
  if (patch.walletLockedNotice !== undefined) patch.walletLockedNotice = patch.walletLockedNotice !== false;
  // Workers allowed at once per AI service: integers 1..32 only (lib/provider-pacing); applied to the running hub by afterSettingsWrite.
  if (patch.workersAtOnce !== undefined) patch.workersAtOnce = require('./provider-pacing').cleanWorkersAtOnce(patch.workersAtOnce);
  // Long waits on workers (lib/long-waits): minutes 0..240 (0 = off, junk = the default 10); the lead notice is on unless false.
  if (patch.handOffWaitMinutes !== undefined) patch.handOffWaitMinutes = require('./long-waits').cleanMinutes(patch.handOffWaitMinutes);
  if (patch.buildPartnerNotice !== undefined) patch.buildPartnerNotice = patch.buildPartnerNotice !== false;
  // Sidebar sections that are off until switched on: true only for a real true.
  if (patch.sidebarTigerTeam !== undefined) patch.sidebarTigerTeam = patch.sidebarTigerTeam === true;
  if (patch.sidebarGuide !== undefined) patch.sidebarGuide = patch.sidebarGuide === true;
  if (patch.sidebarTeams !== undefined) patch.sidebarTeams = patch.sidebarTeams !== false;   // the Teams tab is on unless switched off
  // Voice: known keys only, merged onto the stored value (lib/voice/manifest cleanVoiceSettings). "enabled" changes
  // only through /api/voice/enable and /disable, which also install the engines and stop or resume the worker.
  if (patch.voice !== undefined) {
    const storedVoice = getSetting('voice');
    // the speech recognition size: blank (decided by a speed check) or one of the two sizes; the cleaner below would only skip another word
    if (patch.voice && typeof patch.voice === 'object' && patch.voice.sttModel !== undefined) {
      if (patch.voice.sttModel === null) patch.voice.sttModel = '';
      if (patch.voice.sttModel !== '' && !['tiny.en', 'small.en'].includes(patch.voice.sttModel)) return fail('voice.sttModel must be blank, "tiny.en" or "small.en"');
    }
    // updateSettings replaces the whole voice object, so an unset switch must stay absent from it (cleanVoicePatch).
    patch.voice = require('./voice/manifest').cleanVoicePatch(patch.voice, storedVoice);
  }

  // ── The numbers, words, switches and addresses of the Settings page (phase 5c): each refuses garbage with a plain error ──
  for (const key of Object.keys(NUMBER_KEYS)) {
    if (patch[key] === undefined) continue;
    const r = cleanNumberKey(key, patch[key]);
    if (r.error) return fail(r.error);
    patch[key] = r.value;
  }
  for (const [key, allowed] of Object.entries(ENUM_KEYS)) {
    if (patch[key] === undefined) continue;
    if (patch[key] === null || patch[key] === '') { patch[key] = null; continue; }
    if (!allowed.includes(patch[key])) return fail(`${key} must be one of: ${allowed.join(', ')}`);
  }
  for (const key of BOOL_KEYS) {
    if (patch[key] !== undefined && patch[key] !== null && typeof patch[key] !== 'boolean') return fail(`${key} must be true or false`);
  }
  // Each AI service's address (the key and the prompts go there): http(s) only, no sign-in details in it.
  // Only an address that differs from the stored one is checked: the main Save sends every address, and an odd one already stored passes untouched.
  if (patch.providers !== undefined && patch.providers && typeof patch.providers === 'object' && !Array.isArray(patch.providers)) {
    const storedProviders = getSetting('providers');
    for (const [p, conf] of Object.entries(patch.providers)) {
      if (!conf || typeof conf !== 'object' || conf.url === undefined) continue;
      const was = isObj(storedProviders) && isObj(storedProviders[p]) ? storedProviders[p].url : undefined;
      if (typeof conf.url === 'string' && typeof was === 'string' && (conf.url === was || conf.url.trim() === was.trim())) continue;
      const r = cleanProviderUrl(`providers.${p}.url`, conf.url);
      if (r.error) return fail(r.error);
      conf.url = r.value;
    }
  }
  // Update checks: switch and hours, merged onto the stored value (updateSettings replaces the whole object).
  if (patch.updateCheck !== undefined) {
    const v = patch.updateCheck;
    if (v === null) patch.updateCheck = null;   // back to the default: the key goes
    else {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('updateCheck must be an object');
      const merged = { ...(getSetting('updateCheck') || {}) };
      for (const [k, val] of Object.entries(v)) {
        if (val === null) { delete merged[k]; continue; }   // a key sent as null is removed from the stored value (back to its default)
        if (k === 'enabled') { if (typeof val !== 'boolean') return fail('updateCheck.enabled must be true or false'); merged.enabled = val; }
        else if (k === 'hours') {
          if (val === '') { delete merged.hours; continue; }
          const n = numberFrom(val);
          if (!Number.isFinite(n) || n < 1 || n > 8760 || !Number.isInteger(n)) return fail('updateCheck.hours must be a whole number of hours from 1 to 8760');
          merged.hours = n;
        } else merged[k] = val;   // (other fields, such as the last check, belong to lib/update-check)
      }
      patch.updateCheck = merged;
    }
  }
  // Docker's memory size for each box ("4g", "512m") and its processor share (0.1 to 256).
  if (patch.sandboxMemory !== undefined) {
    const v = patch.sandboxMemory;
    if (v === null || v === '') patch.sandboxMemory = null;
    else if (typeof v !== 'string' || !/^[1-9]\d{0,5}[bkmg]?$/i.test(v.trim())) return fail('sandboxMemory must be a size such as 4g or 512m');
    else patch.sandboxMemory = v.trim().toLowerCase();
  }
  if (patch.sandboxCpus !== undefined) {
    const v = patch.sandboxCpus;
    if (v === null || v === '') patch.sandboxCpus = null;
    else {
      const n = numberFrom(v);
      if (!Number.isFinite(n) || n < 0.1 || n > 256) return fail('sandboxCpus must be a number from 0.1 to 256');
      patch.sandboxCpus = String(n);
    }
  }
  // Models members may use: model ids only.
  if (patch.memberDefaultModel !== undefined) {
    const v = patch.memberDefaultModel;
    if (v === null || v === '') patch.memberDefaultModel = null;
    else if (!isModelId(v)) return fail('memberDefaultModel must be a model id');
  }
  if (patch.memberModels !== undefined) {
    const v = patch.memberModels;
    if (v === null) patch.memberModels = null;   // back to the default: the key goes
    else if (!Array.isArray(v) || v.length > 300 || v.some((m) => !isModelId(m))) return fail('memberModels must be a list of model ids');
    else patch.memberModels = [...new Set(v)];
  }
  // The picture service's models: { google: { fast, best }, openai: { fast, best } }, merged onto the stored value; blank = the default.
  if (patch.imageModels !== undefined) {
    const v = patch.imageModels;
    // null or {} removes the key (back to the defaults); so does clearing the last tier
    if (v === null || (isObj(v) && Object.keys(v).length === 0)) patch.imageModels = null;
    else {
      if (!isObj(v)) return fail('imageModels must be an object');
      const merged = JSON.parse(JSON.stringify(getSetting('imageModels') || {}));
      for (const [prov, conf] of Object.entries(v)) {
        if (!ENUM_KEYS.imageProvider.includes(prov)) return fail(`imageModels.${prov} is not a picture service (${ENUM_KEYS.imageProvider.join(', ')})`);
        if (conf === null) { delete merged[prov]; continue; }   // a whole service sent as null: both its tiers go
        if (!isObj(conf)) return fail(`imageModels.${prov} must be an object with fast and best`);
        const m = isObj(merged[prov]) ? merged[prov] : {};
        for (const [tier, name] of Object.entries(conf)) {
          if (tier !== 'fast' && tier !== 'best') return fail(`imageModels.${prov}.${tier} is not a setting (fast or best)`);
          if (name === null || name === '') delete m[tier];
          else if (!isModelId(name)) return fail(`imageModels.${prov}.${tier} must be a model name`);
          else m[tier] = name;
        }
        if (Object.keys(m).length) merged[prov] = m; else delete merged[prov];
      }
      patch.imageModels = Object.keys(merged).length ? merged : null;
    }
  }
  // Reusing earlier text: { enabled, ttl: "5m" | "1h" }, merged onto the stored value.
  if (patch.promptCache !== undefined) {
    const v = patch.promptCache;
    if (v === null) patch.promptCache = null;   // back to the default: the key goes
    else {
      if (!isObj(v)) return fail('promptCache must be an object');
      const merged = { ...(getSetting('promptCache') || {}) };
      for (const [k, val] of Object.entries(v)) {
        if (k !== 'enabled' && k !== 'ttl') return fail(`promptCache.${k} is not a setting`);
        if (val === null) { delete merged[k]; continue; }   // one field sent as null: that field goes
        if (k === 'enabled') { if (typeof val !== 'boolean') return fail('promptCache.enabled must be true or false'); merged.enabled = val; }
        else { if (val !== '5m' && val !== '1h') return fail('promptCache.ttl must be "5m" or "1h"'); merged.ttl = val; }
      }
      patch.promptCache = Object.keys(merged).length ? merged : null;
    }
  }
  // The monthly spending cap goes through the ledger's own cleaner (the same one POST /api/ledger/caps uses), so no other route bypasses it.
  if (patch.ledger !== undefined) {
    const v = patch.ledger;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('ledger must be an object');
    if ('monthlyUsd' in v || 'monthlyResetDay' in v) {
      let m;
      try { m = require('./ledger').cleanMonthly({ monthlyUsd: v.monthlyUsd, monthlyResetDay: v.monthlyResetDay }); } catch (e) { return fail(e.message); }
      if ('monthlyUsd' in v) v.monthlyUsd = m.monthlyUsd;
      if ('monthlyResetDay' in v) v.monthlyResetDay = m.monthlyResetDay;
    }
    for (const k of ['perAgentDailyUsd', 'hubDailyUsd']) {
      if (k in v && v[k] !== null && v[k] !== '' && !(Number.isFinite(numberFrom(v[k])) && numberFrom(v[k]) >= 0)) return fail(`ledger.${k} must be a dollar amount, or blank for none`);
      if (k in v) v[k] = v[k] === null || v[k] === '' ? null : numberFrom(v[k]) > 0 ? numberFrom(v[k]) : null;
    }
    patch.ledger = { ...(getSetting('ledger') || {}), ...v };   // updateSettings replaces the whole object: the caps not sent stay
  }
  return out;
}

/** What the running hub needs after a settings patch was saved: the new worker caps, a rediscovery after a provider change. */
function afterSettingsWrite(patch, { providersChanged = false, getPacing = null, runDiscovery = null } = {}) {
  if (!patch || typeof patch !== 'object') return;
  // (updateSettings takes `providers` out of the patch it is given, so the caller says whether it was there: providersChanged)
  if (patch.workersAtOnce !== undefined) (getPacing ? getPacing() : require('./sdk-chat').getPacing()).setCaps(hubSettings.getSetting('workersAtOnce'));
  // A new key or URL changes which models exist: rediscover now rather than waiting for the 6-hour cycle.
  if (providersChanged) (runDiscovery || require('./model-discovery').runDiscovery)({ again: true }).catch(e => console.error('[settings] Rediscovery failed:', e.message));
}

/** The audit line and the admin notice for a changed lockbox default (a signed-in admin's own change). */
function announceLockboxChange(change, { userId = null, ip = null } = {}) {
  if (!change) return;
  try { require('./auth').getAuth().audit(userId == null ? null : String(userId), 'settings.lockboxDefault', change, ip); } catch {}
  try { Promise.resolve(require('./push').getPush().notify({ title: 'Command lockbox changed', body: change, tag: 'lockbox-change' }, { adminsOnly: true, kind: 'security' })).catch(() => {}); } catch {}
}

// ── The six one-value routes: each sets a global and saves only its own key ──────────────────────────
const GLOBAL_SETTINGS = {
  maxCompletionTokens: { global: '__maxCompletionTokens', clean: (raw) => { const v = parseInt(raw, 10); return !v || v < 256 || v > 128000 ? { error: 'value must be between 256 and 128000' } : { value: v }; } },
  maxContextMessages: { global: '__maxContextMessages', clean: (raw) => { const v = parseInt(raw, 10); return !v || v < 5 || v > 200 ? { error: 'value must be between 5 and 200' } : { value: v }; } },
  cavemanMode: { global: '__cavemanMode', clean: (raw) => ({ value: !!raw }) },
  prescanTools: { global: '__prescanToolsEnabled', clean: (raw) => ({ value: !!raw }) },
  confirmTools: { global: '__confirmToolsEnabled', clean: (raw) => ({ value: !!raw }) },
  lazyTools: { global: '__lazyToolsEnabled', clean: (raw) => ({ value: !!raw }) },
};
const isGlobalSetting = (key) => Object.prototype.hasOwnProperty.call(GLOBAL_SETTINGS, key);
/** Cleans one of the six values: { ok, value } or { ok: false, error }. */
function cleanGlobalSetting(key, raw) {
  if (!isGlobalSetting(key)) return { ok: false, error: `${key} is not a one-value setting` };
  const r = GLOBAL_SETTINGS[key].clean(raw);
  return r.error ? { ok: false, error: r.error } : { ok: true, value: r.value };
}
/** Sets the running global and saves ONLY that key (the old shared saver rewrote all six). */
function setGlobalSetting(key, raw) {
  const r = cleanGlobalSetting(key, raw);
  if (!r.ok) return r;
  global[GLOBAL_SETTINGS[key].global] = r.value;
  hubSettings.updateSettings({ [key]: r.value });
  return r;
}

// ── PATCH /api/agents/:name: who may change which field ──────────────────────────────────────────────
// A member may tune their own agent's conversation settings, never its permissions, folders, sandbox, tools, owner or sharing.
const leadConfirmedObjects = new WeakSet();
/** The proof the lead's settings tool passes (as `internal`) to check()/apply() for a write the owner confirmed on the fixed card.
 *  Only lib/settings-tool calls this; nothing built from a request body can be a member of the set. */
function leadConfirmed() { const o = Object.freeze({ by: 'lead-confirm' }); leadConfirmedObjects.add(o); return o; }
const MEMBER_EDITABLE_AGENT_FIELDS = new Set(['blurb', 'maxContextMessages', 'maxOutputTokens', 'contextBudget', 'compaction', 'minimalContext']);

/**
 * The guards of PATCH /api/agents/:name. fields: the body (an object of field -> value). ctx: { service, token, user, isAdmin,
 * isOwner, pendingTotp, ownSession } (service/token: the hub's own call or an API token; ownSession: an admin's own browser session).
 * Returns { ok: true } or { ok: false, status, error }. The value of each field is validated later, by updateAgentField.
 */
function agentFieldAllowed(fields, ctx = {}) {
  const body = fields;
  const isObject = !!body && typeof body === 'object';
  const notPerson = !!ctx.service || !!ctx.token || !ctx.user || !!ctx.pendingTotp;
  // Call recordings are switched and shared by a signed-in admin only: never a member and never the hub's own service calls (agents' tools).
  // Only the owner (the earliest admin) does: who may download a family's recordings is not any admin's call.
  if (isObject && 'recordings' in body && (notPerson || !ctx.isOwner)) return { ok: false, status: 403, error: 'only the owner can change: recordings' };
  // Which environment variables an agent's commands keep is a signed-in admin's call: never a member, and never the hub's own service calls (an agent could widen itself).
  if (isObject && 'envKeep' in body && (notPerson || !ctx.isAdmin)) return { ok: false, status: 403, error: 'only an admin can change: envKeep' };
  // Who an agent reports to is an admin's call (or the lead's team tool): never the hub's own service calls (an agent's tools).
  if (isObject && 'reportsTo' in body && (notPerson || !ctx.isAdmin)) return { ok: false, status: 403, error: 'reportsTo is set by an admin or through the team tool' };
  // The command lockbox changes what an agent's commands may touch: a signed-in admin's own browser session only (never a member, a token, the hub's own service or an agent).
  // One more case (P4-lead): the lead's settings tool, after the owner pressed Confirm on its fixed card in a turn the owner typed. The proof is an
  // object made by leadConfirmed() below; it cannot come from a request body (a parsed body never holds a member of that private set).
  if (isObject && ('lockbox' in body || 'lockboxEnv' in body) && !ctx.ownSession && !(ctx.leadConfirmed && leadConfirmedObjects.has(ctx.leadConfirmed))) return { ok: false, status: 403, error: 'Sign in with an admin account in your browser to change the command lockbox.' };
  if (!ctx.service && !ctx.isAdmin) {
    const refused = Object.keys(body || {}).filter(k => !MEMBER_EDITABLE_AGENT_FIELDS.has(k));
    if (refused.length) return { ok: false, status: 403, error: `only an admin can change: ${refused.join(', ')}` };
  }
  return { ok: true };
}

/** The context PATCH /api/agents/:name hands updateAgentField: the owner flag, who is asking, the audit line and the notices. */
function agentWriteContext({ isOwner = false, user = null, ip = null } = {}) {
  const auth = () => require('./auth').getAuth();
  const id = user && user.id != null ? String(user.id) : '';
  return {
    isOwner: !!isOwner, userId: id,
    // Changes to the call-recordings setting are audited (agent.recordings): who, which agent, keep on/off, the allowed ids, the mic.
    audit: (action, detail) => auth().audit(id || null, action, detail, ip),
    // A lockbox change is told to the admins in plain words (a security notice), like the admin 2-factor rule.
    userName: user ? String(user.name || user.login || user.id || '') : '',
    notifyAdmins: (text) => require('./push').getPush().notify({ title: 'Command lockbox changed', body: text, tag: 'lockbox-change' }, { adminsOnly: true, kind: 'security' }),
    // Reporting lines cleared because the team no longer fits are a team notice, not a security one (own title and tag).
    notifyTeam: (text) => require('./push').getPush().notify({ title: 'Team changed', body: text, tag: 'team-change' }, { adminsOnly: true, kind: 'other' }),
  };
}

// ── Records -> where the value lives ─────────────────────────────────────────────────────────────────
const SEG = '[A-Za-z_][A-Za-z0-9_-]*';
const PATH = `${SEG}(?:\\.${SEG})*`;
const TAIL = '(?=$|[\\s(+,;/|])';   // what may follow a spelled-out path: the end, or a note (a placeholder like <id> or a list [] does not match)
const RE_SETTINGS = new RegExp(`^settings\\.(${PATH})${TAIL}`);
const RE_AGENT = new RegExp(`^agents\\[\\]\\.(${PATH})${TAIL}`);
const KINDS_NOTIFY = ['questions', 'requested', 'other', 'security'];

/** { kind: 'settings', path } | { kind: 'agent', field } | { kind: 'prefs', store, field, ... } | { kind: 'device' } | { kind: 'screen' } */
function target(record) {
  const s = record && typeof record.storedAs === 'string' ? record.storedAs.trim() : '';
  if (!s) return { kind: 'screen' };
  if (/^(localStorage|sessionStorage)\b/.test(s)) return { kind: 'device' };
  // Stop all agents (the kill switch): not a stored value but an action with two states, 'stopped' and 'running'
  if (/^(data\/hub-halt\.json|action:hub-halt)\b/.test(s)) return { kind: 'action', action: 'hub-halt' };
  let m;
  // One line of the startup file (.env): only the allow-list of lib/env-file is changeable; every other variable is read-only on its screen.
  if ((m = s.match(/^env:([A-Z][A-Z0-9_]*)\s*$/))) return require('./env-file').isWritable(m[1]) ? { kind: 'env', key: m[1] } : { kind: 'screen' };
  if ((m = s.match(RE_SETTINGS))) {
    const rest = s.slice(m[0].length);
    if (/^\s*\(contains /.test(rest)) return { kind: 'screen' };   // one entry of a list: the screen edits the list
    return { kind: 'settings', path: m[1] };
  }
  if ((m = s.match(RE_AGENT))) return { kind: 'agent', field: m[1] };
  // A person's page preferences (users.json): prefs.<field> or users[].<field>
  if ((m = s.match(/^(?:prefs|users\[\])\.(uiMode|theme|planBadge)\b/))) return { kind: 'prefs', store: 'users', field: m[1] };
  if (/^users\[\]\.timeZone\b/.test(s)) return { kind: 'prefs', store: 'users', field: 'timeZone' };
  // Notification preferences: per kind, for all agents or for one agent
  if ((m = s.match(new RegExp(`^(?:prefs\\.notify|data/push/prefs\\.json users\\[user\\]|notify-prefs\\.<userId>|notify prefs:?)\\.?\\s*(?:default\\.(${KINDS_NOTIFY.join('|')})|agents(?:\\[<agent>\\]|\\[agent\\]|\\.<agent>)\\.(${KINDS_NOTIFY.join('|')}))${TAIL}`)))) {
    return m[1] ? { kind: 'prefs', store: 'notify', scope: 'default', field: m[1] } : { kind: 'prefs', store: 'notify', scope: 'agent', field: m[2] };
  }
  // Deep research choice (research-prefs.json)
  if ((m = s.match(/^(?:data\/research-prefs\.json people(?:\[user\]|\.<id>)|research-prefs(?: people\.<id>)?|research-pref)\.?\s*(?:people\.<id>\.)?(choice|alwaysLevel)\b/))) return { kind: 'prefs', store: 'research', field: m[1] };
  // Voice person preferences (voice-person-prefs.json)
  if (/voice-person-prefs|interruptReminder/.test(s)) return { kind: 'prefs', store: 'voice', field: 'interruptReminder' };
  return { kind: 'screen' };
}

// ── Secrets ──────────────────────────────────────────────────────────────────────────────────────────
function secretKeyOf(t, record, agent, user) {
  if (t.kind === 'settings') return { key: t.path, store: 'settings' };
  if (t.kind === 'agent') return { key: `agents.${agent || 'x'}.${t.field}`, store: 'agents' };
  if (t.kind === 'prefs') return { key: `prefs.${user || 'x'}.${t.field}`, store: 'prefs' };
  return { key: '', store: 'settings' };
}
function isSecretRecord(t, record, agent, user) {
  const { key, store } = secretKeyOf(t, record, agent, user);
  return journal.isSecretKey(key, record, store);
}

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────────
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function getIn(obj, parts) {
  let v = obj;
  for (const p of parts) { if (isObj(v) && Object.prototype.hasOwnProperty.call(v, p)) v = v[p]; else return undefined; }
  return v;
}
function setIn(obj, parts, value) {
  const root = isObj(obj) ? clone(obj) : {};
  let o = root;
  for (const p of parts.slice(0, -1)) { if (!isObj(o[p])) o[p] = {}; o = o[p]; }
  o[parts[parts.length - 1]] = value;
  return root;
}
const BAD = new Set(['__proto__', 'constructor', 'prototype']);
function userIdOf(user) { return user && typeof user === 'object' ? (user.id != null ? String(user.id) : '') : (user != null ? String(user) : ''); }
function userObj(user, auth) {
  if (user && typeof user === 'object') return user;
  const id = userIdOf(user);
  if (!id) return null;
  let u = null; try { u = (auth || require('./auth').getAuth()).getUser(id); } catch { /* no accounts */ }
  return u || { id };
}
function findAgent(name) {
  try { return require('./agents').loadAgentsFromDisk().find(a => a.name === name) || null; } catch { return null; }
}
function personKey(user, auth) {
  // research preferences are kept per person id ('owner' on an install with no accounts)
  const id = userIdOf(user);
  if (id) return id.slice(0, 64);
  try { return (auth || require('./auth').getAuth()).hasUsers() ? '' : 'owner'; } catch { return ''; }
}

// ── current ──────────────────────────────────────────────────────────────────────────────────────────
/** The value the record holds now. A secret is { set: true|false }, never the value. agent: an agent name; user: a user or id. */
function current({ record, agent, user, auth, envFile } = {}) {
  const t = target(record);
  if (t.kind === 'action') return require('./hub-halt').getHubHalt().isHalted() ? 'stopped' : 'running';
  if (t.kind === 'env') { const row = require('./env-file').read({ file: envFile }).rows.find((r) => r.key === t.key); return row && row.value !== null ? row.value : undefined; }
  const secret = isSecretRecord(t, record, agent, userIdOf(user));
  let v;
  if (t.kind === 'settings') v = hubSettings.getPath(t.path);
  else if (t.kind === 'agent') { const a = findAgent(agent); v = a ? getIn(a, t.field.split('.')) : undefined; }
  else if (t.kind === 'prefs') {
    const id = userIdOf(user);
    try {
      if (t.store === 'users') { const u = id ? (auth || require('./auth').getAuth()).getUser(id) : null; v = u ? u[t.field] : undefined; }
      else if (t.store === 'research') { const p = require('./research-prefs').getResearchPrefs(); const k = personKey(user, auth); v = t.field === 'choice' ? p.choiceOf(k) : p.alwaysLevelOf(k); }
      else if (t.store === 'notify') { const view = id ? require('./notify-prefs').getNotifyPrefs().get(id) : null; v = view ? (t.scope === 'default' ? view.default[t.field] : (view.agents[agent] || {})[t.field]) : undefined; }
      else if (t.store === 'voice') v = require('./voice-person-prefs').getVoicePersonPrefs().interruptReminder(id);
    } catch { v = undefined; }
  }
  if (secret) return { set: v !== undefined && v !== null && v !== '' };
  return v === undefined ? undefined : clone(v);
}

// ── check ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Whether this person may set this record to this value, and the cleaned value. Never throws.
 * { record, value, agent, user, isAdmin, ownSession } -> { ok: true, value, ... } | { ok: false, error }
 * error: 'secret' (never through here), 'screen' (only on its screen), 'protected' (a key no route writes), 'admin', 'sign in',
 * 'not your agent', 'no such agent', or the route's own plain-words message.
 */
function check(args = {}) {
  try { return checkInner(args); } catch (e) { return { ok: false, error: (e && e.message) || 'could not check that' }; }
}
function checkInner({ record, value, agent, user, isAdmin = false, ownSession = false, auth = null, internal = null } = {}) {
  const t = target(record);
  const uid = userIdOf(user);
  if (t.kind === 'action') {
    if (!isAdmin) return { ok: false, error: 'admin' };
    const v = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (['stopped', 'stop', 'halt', 'halted'].includes(v)) return { ok: true, value: 'stopped' };
    if (['running', 'resume', 'resumed', 'run'].includes(v)) return { ok: true, value: 'running' };
    return { ok: false, error: 'the value must be "stopped" (Stop all agents) or "running" (Resume)' };
  }
  if (isSecretRecord(t, record, agent, uid)) return { ok: false, error: 'secret' };
  if (t.kind === 'device' || t.kind === 'screen') return { ok: false, error: 'screen' };
  if (t.kind === 'env') {
    // a line of the startup file: an admin only, the value held to the key's own rule ('' or null puts it back to the default: the line goes)
    if (!isAdmin) return { ok: false, error: 'admin' };
    if (value === undefined) return { ok: false, error: 'a value is needed' };
    const v = require('./env-file').validate(t.key, value);
    return v.ok ? { ok: true, value: v.value, key: t.key } : { ok: false, error: v.error };
  }
  const u = userObj(user, auth);

  if (t.kind === 'settings') {
    if (!isAdmin) return { ok: false, error: 'admin' };
    const parts = t.path.split('.');
    if (parts.some(p => BAD.has(p))) return { ok: false, error: 'protected' };
    const top = parts[0];
    if (isGlobalSetting(top) && parts.length === 1) {
      const g = cleanGlobalSetting(top, value);
      return g.ok ? { ok: true, value: g.value, patch: { [top]: g.value }, global: top } : { ok: false, error: g.error };
    }
    if (value === undefined) return { ok: false, error: 'a value is needed' };
    // providers: updateSettings merges a nested patch itself (and null clears a provider), so the patch stays as narrow as the record
    const nested = top === 'providers' && parts.length > 1;
    const patch = nested ? { providers: setIn({}, parts.slice(1), value) } : { [top]: parts.length === 1 ? clone(value) : setIn(hubSettings.getPath(top), parts.slice(1), clone(value)) };
    const cleaned = cleanSettingsPatch(patch, { ownSession, who: u && (u.name || u.login || u.id), getSetting: hubSettings.getSetting });
    if (cleaned.errors.length) return { ok: false, error: cleaned.errors[0] };
    if (cleaned.dropped.length || !(top in patch)) return { ok: false, error: 'protected' };
    const out = nested ? getIn(patch.providers, parts.slice(1)) : (parts.length === 1 ? patch[top] : getIn(patch[top], parts.slice(1)));
    if (out === undefined) return { ok: false, error: 'protected' };
    return { ok: true, value: out, patch, lockboxChange: cleaned.lockboxChange };
  }

  if (t.kind === 'agent') {
    const parts = t.field.split('.');
    const top = parts[0];
    if (!require('./agents').AGENT_PATCH_FIELDS.includes(top)) return { ok: false, error: 'screen' };
    const rec = findAgent(agent);
    if (!rec) return { ok: false, error: 'no such agent' };
    if (value === undefined) return { ok: false, error: 'a value is needed' };
    const merged = parts.length === 1 ? value : setIn(rec[top], parts.slice(1), value);
    let isOwner = false;
    try { isOwner = !!u && (auth || require('./auth').getAuth()).isOwner(u); } catch { isOwner = false; }
    const g = agentFieldAllowed({ [top]: merged }, { service: false, token: false, user: u, isAdmin: !!isAdmin, isOwner, pendingTotp: false, ownSession: !!ownSession, leadConfirmed: internal });
    if (!g.ok) return { ok: false, error: g.error };
    if (!isAdmin && !(u && rec.owner && String(rec.owner) === String(u.id))) return { ok: false, error: 'not your agent' };
    return { ok: true, value: parts.length === 1 ? value : getIn({ [top]: merged }, parts), fields: { [top]: merged } };
  }

  // prefs: each store's own validation
  if (!uid && t.store !== 'research') return { ok: false, error: 'sign in' };
  if (t.store === 'users') {
    if (t.field === 'timeZone') {
      if (value !== null && value !== '' && !(typeof value === 'string' && require('./timezone').isZone(value))) return { ok: false, error: 'unknown time zone' };
      return { ok: true, value: value || null };
    }
    const allowed = require('./auth').PREF_VALUES[t.field];
    if (!allowed.includes(value)) return { ok: false, error: `${t.field} must be ${allowed.slice(0, -1).join(', ')} or ${allowed[allowed.length - 1]}` };
    return { ok: true, value };
  }
  if (t.store === 'research') {
    const mod = require('./research-prefs');
    const list = t.field === 'choice' ? mod.CHOICES : mod.LEVELS;
    if (!personKey(user, auth)) return { ok: false, error: 'sign in' };
    if (!list.includes(value)) return { ok: false, error: `${t.field === 'choice' ? 'choice' : 'alwaysLevel'} must be one of: ${list.join(', ')}` };
    let on = false;
    try { on = require('./behaviour-changes').isOn('deep-research'); } catch { on = false; }
    if (!on) return { ok: false, error: 'Deep research is off on this Maestro.' };
    return { ok: true, value };
  }
  if (t.store === 'notify') {
    if (!require('./notify-prefs').MODES.includes(value)) return { ok: false, error: 'mode must be on, off or away' };
    if (t.scope === 'agent') {
      if (!agent) return { ok: false, error: 'an agent is needed' };
      if (t.field === 'security') return { ok: false, error: 'security is set for all agents at once' };
    }
    return { ok: true, value };
  }
  if (t.store === 'voice') {
    if (typeof value !== 'boolean') return { ok: false, error: 'on must be true or false' };
    return { ok: true, value };
  }
  return { ok: false, error: 'screen' };
}

// ── After an agent field was saved (PATCH /api/agents/:name, the lead's tool and Restore all use this) ──
/** Tell open pages that an agent's settings changed: hub event 'agent_updated' (the same event server.js publishAgentUpdate sends). */
async function publishAgentUpdate(name, changed = []) {
  try {
    const a = (await require('./agents').getAgents()).find(x => x.name === name);
    if (!a) return;
    require('./hub-events').events.publish('agent_updated', { agent: name, model: a.model || null, display: a.display || null, icon: a.icon || null, category: a.category || null, autoModel: !!a.autoModel, effort: a.effort || 'default', changed: Array.isArray(changed) ? changed : [] });
  } catch { /* events are best effort */ }
}
/** The people on a recordings access list now (before a change, to tell who to notify afterwards). */
function recordingsAllowed(agentName) {
  try { return require('./recordings/settings').recordingsOf(findAgent(agentName)).allowed.slice(); } catch { return []; }
}
/**
 * The steps after an agent field was saved, in one place (the route, the lead's tool and Restore all run it):
 *  - handing an agent to a member: it introduces itself in its (still empty) chat
 *  - a change of who may download its recordings is told to everybody on the old and the new list (allowedBefore: the list before)
 *  - folders, sandbox mode or hands changed: the container is rebuilt on the agent's next turn (and removed when the sandbox is off)
 *  - open pages are told (opts.publish(name, changedKeys), or the default; false: the caller does it itself)
 * (The lockbox audit line and admin notice are made by updateAgentField through agentWriteContext.) Never throws.
 * opts: { publish, allowedBefore }
 */
async function afterAgentChange(name, fields, opts = {}) {
  const keys = fields && typeof fields === 'object' ? Object.keys(fields) : [];
  try {
    if (fields && fields.owner) { const u = require('./auth').getAuth().getUser(String(fields.owner)); if (u && u.role === 'member') require('./teams').greetIfFresh(name, u).catch(() => {}); }
  } catch { /* the greeting is best effort */ }
  if (keys.includes('recordings') && Array.isArray(opts.allowedBefore)) {
    try {
      const rec = findAgent(name);
      const allowedAfter = require('./recordings/settings').recordingsOf(rec).allowed;
      const allowedBefore = opts.allowedBefore;
      if (allowedBefore.length !== allowedAfter.length || allowedBefore.some(id => !allowedAfter.includes(id))) {
        await require('./push').getPush().notifyUsers({
          title: 'Recording access changed',
          body: `${(rec && rec.display) || name}: the list of people who can download its recordings was changed.`,
          tag: `rec-access-${name}`,
        }, [...new Set([...allowedBefore, ...allowedAfter])], { kind: 'security' });
      }
    } catch { /* the notice is best effort */ }
  }
  if (opts.publish !== false) { try { await (typeof opts.publish === 'function' ? opts.publish(name, keys) : publishAgentUpdate(name, keys)); } catch { /* best effort */ } }
  if (['policy', 'sandbox', 'tools'].some(k => keys.includes(k))) {
    try {
      const rec = findAgent(name);
      // (a test seam, and never the real container tool inside a test run)
      if (rec && sandboxRemover.fn) Promise.resolve(sandboxRemover.fn(rec)).catch(() => {});
      else if (rec && !process.env.NODE_TEST_CONTEXT) require('./sandbox').getSandbox().remove(rec).catch(() => {});
    } catch { /* the next turn rebuilds it anyway */ }
  }
}
const sandboxRemover = { fn: null };
/** Tests: replace the container removal after a folders / sandbox / hands change (fn(agentRecord)), or null for the real one. */
function _setSandboxRemover(fn) { sandboxRemover.fn = typeof fn === 'function' ? fn : null; }

/**
 * Restore of one agent field (lib/settings-journal): through updateAgentField, with the guards of PATCH /api/agents/:name and the same
 * follow-ups (afterAgentChange). dotted: "voiceDefaults.voiceSpeed" or "blurb"; value undefined: the field was not there before.
 * who: { user, isAdmin, isAdminSession } of the person restoring. Synchronous. Returns { ok } or { ok: false, error }.
 */
function restoreAgentField(agentName, dotted, value, who = {}) {
  const ag = require('./agents');
  const parts = String(dotted).split('.');
  if (parts.some(p => BAD.has(p))) return { ok: false, error: 'bad key' };
  const top = parts[0];
  if (!ag.AGENT_PATCH_FIELDS.includes(top)) return { ok: false, error: 'This one is changed on its own screen, so it cannot be restored here.' };
  const rec = findAgent(agentName);
  if (!rec) return { ok: false, error: 'That agent is gone, so nothing was restored.' };
  let merged;
  // These three merge a partial object into the stored one and remove a key sent as null: the key alone goes (null when it was absent before),
  // never the whole object without the key (the merge would keep the key).
  const partial = parts.length === 2 && (top === 'voiceDefaults' || top === 'compaction' || (top === 'voice' && ['voice', 'stt', 'tts', 'cloudVoice'].includes(parts[1])));
  if (parts.length === 1) merged = value === undefined ? null : value;
  else if (partial) merged = { [parts[1]]: value === undefined ? null : value };
  else {
    const root = isObj(rec[top]) ? clone(rec[top]) : {};
    let o = root;
    for (const p of parts.slice(1, -1)) { if (!isObj(o[p])) o[p] = {}; o = o[p]; }
    const last = parts[parts.length - 1];
    if (value === undefined) delete o[last]; else o[last] = value;
    merged = root;
  }
  const fields = { [top]: merged };
  const u = userObj(who.user, null);
  let isOwner = false; try { isOwner = !!u && require('./auth').getAuth().isOwner(u); } catch { isOwner = false; }
  const g = agentFieldAllowed(fields, { service: false, token: false, user: u, isAdmin: !!who.isAdmin, isOwner, pendingTotp: false, ownSession: !!who.isAdminSession });
  if (!g.ok) return { ok: false, error: g.error };
  const allowedBefore = top === 'recordings' ? recordingsAllowed(agentName) : null;
  const r = ag.updateAgentFieldSync(agentName, fields, agentWriteContext({ isOwner, user: u }));
  if (!r || !r.success) return { ok: false, error: (r && r.error) || 'could not save that' };
  afterAgentChange(agentName, fields, { allowedBefore }).catch(() => {});
  if (partial) {   // read back: a cleaner that kept or reshaped the value would otherwise report a restore that did not happen
    let now; try { now = ag.readAgentValue(agentName, dotted); } catch { now = undefined; }
    // an openai or google voice with no cloudVoice stored is stored as the engine's default: that is "not set" for the person
    let isDefault = false;
    if (value === undefined && dotted === 'voice.cloudVoice' && now !== undefined) {
      try { const tts = ag.readAgentValue(agentName, 'voice.tts'); isDefault = now === require('./voice/cloud').DEFAULT_CLOUD_VOICE[tts]; } catch { isDefault = false; }
    }
    // a voice key that was absent before: the effective value must be the default (engine local, hub voice '') or still not stored
    if (value === undefined && top === 'voice' && (parts[1] === 'stt' || parts[1] === 'tts')) {
      isDefault = now === undefined || now === 'local';
      if (!isDefault) return { ok: false, error: `That value was not put back: the ${parts[1] === 'stt' ? 'speech recognition' : 'voice engine'} is still ${now}, not the default (local). Change ${dotted} on the agent page.` };
    } else if (value === undefined && top === 'voice' && parts[1] === 'voice') {
      isDefault = now === undefined || now === '';
    }
    if (!isDefault && !journal.same(now, value)) {
      let shown; try { shown = journal.displayValue(journal.redactUrls(journal.stripSecrets(now))); } catch { shown = 'unknown'; }
      return { ok: false, error: `That value was not put back: the setting kept its own, and ${shown === 'not set' ? 'it is not set now' : 'it is now ' + shown}. Change ${dotted} on the agent page.` };
    }
  }
  return { ok: true };
}

/**
 * Restore of one settings key (lib/settings-journal): through the same validated setters and runtime follow-ups as the original change,
 * never setPath alone. A one-value global (maxCompletionTokens, cavemanMode, ...) goes through setGlobalSetting; any other key through
 * cleanSettingsPatch (the bulk route's cleaners and guards) + updateSettings + afterSettingsWrite (worker caps, rediscovery).
 * A key that was not there before (value undefined) is removed (the only thing updateSettings cannot do), then the same follow-ups run.
 * who: { user, isAdminSession }. opts: { getPacing, runDiscovery } for afterSettingsWrite (tests). Returns { ok } or { ok: false, error }.
 */
function restoreSetting(key, value, who = {}, opts = {}) {
  const parts = String(key).split('.');
  if (parts.some(p => !p || BAD.has(p))) return { ok: false, error: 'bad key' };
  const top = parts[0];
  const after = (patch, providersChanged) => {
    try { afterSettingsWrite(patch, { providersChanged, getPacing: opts.getPacing || null, runDiscovery: opts.runDiscovery || null }); }
    catch (e) { console.warn('[settings] restored, but the follow-up failed:', e.message); }
  };
  // After the write the value is read back: a cleaner that reshapes it (voice.enabled keeps the stored switch, a clamp, a default) would
  // report success and change nothing, so a value that differs is an error naming the screen where the setting is changed.
  const screenOf = () => { const r = journal.recordFor('settings', key); return r && r.home ? r.home : 'its own screen in Settings'; };
  const verified = () => {
    let now; try { now = hubSettings.getPath(key); } catch { now = undefined; }
    if (journal.same(now, value)) return { ok: true };
    // The message states what the setting is now (shown the way the change history shows a value: credentials in a URL and secret fields are left out).
    let shown; try { shown = journal.displayValue(journal.redactUrls(journal.stripSecrets(now))); } catch { shown = 'unknown'; }
    const state = shown === 'not set' ? 'it is not set now' : `it is now ${shown}`;
    return { ok: false, error: `That value was not put back: the setting changed it or kept its own, and ${state}. Change ${key} on its screen (${screenOf()}).` };
  };
  // Voice is switched on and off by the Voice screen's routes (which install the engines and start or stop the worker): there is no
  // operation to call from here, and setting the value alone would leave the worker as it was.
  if (key === 'voice.enabled' || key === 'voice') return { ok: false, error: `Voice is switched on or off on its own screen, which also installs or stops what it needs, so it cannot be restored here. Change it in ${screenOf()}.` };
  try {
    if (value === undefined) {
      const lockBefore = top === 'lockboxDefault' ? hubSettings.getSetting('lockboxDefault') : null;
      hubSettings.setPath(key, undefined, { remove: true });   // updateSettings cannot remove a key; setPath also re-applies the globals
      after({ [top]: hubSettings.getSetting(top) ?? {} }, top === 'providers');   // (a removed key still counts as changed for the follow-ups)
      // the same follow-up a change of the lockbox default gets: the audit line and the admin notice
      if (top === 'lockboxDefault') {
        try {
          const lb = require('./lockbox/settings'), was = ['off', 'watch', 'enforce'].includes(lockBefore) ? lockBefore : 'off';
          if (was !== 'off') announceLockboxChange(lb.describeDefaultChange(was, 'off', who.user), { userId: who.user == null ? null : String(who.user) });
        } catch { /* the notice is best effort */ }
      }
      return verified();
    }
    if (parts.length === 1 && isGlobalSetting(top)) {
      const r = setGlobalSetting(top, value);
      return r.ok ? verified() : { ok: false, error: r.error };
    }
    let patch;
    if (top === 'providers') patch = { providers: setIn({}, parts.slice(1), value) };   // updateSettings merges a provider's key and url itself
    else patch = { [top]: parts.length === 1 ? clone(value) : setIn(hubSettings.getSetting(top), parts.slice(1), clone(value)) };
    const c = cleanSettingsPatch(patch, { ownSession: !!who.isAdminSession, who: who.user });
    if (c.errors.length) return { ok: false, error: c.errors[0] };
    if (c.dropped.length || !(top in patch)) return { ok: false, error: 'This is a protection with its own screen, so it cannot be restored here.' };
    const providersChanged = !!patch.providers;
    hubSettings.updateSettings(patch);
    after(patch, providersChanged);
    if (c.lockboxChange) announceLockboxChange(c.lockboxChange, { userId: who.user == null ? null : String(who.user) });
    return verified();
  } catch (e) { return { ok: false, error: (e && e.message) || 'could not restore that' }; }
}

// ── The startup file (.env): the one validated, journaled write ──────────────────────────────────────
/**
 * Changes one allow-listed line of the startup file (lib/env-file) and journals it (store "env", key = the variable's name; before and
 * after are the values, never a secret: a secret-looking key is refused). value '' or null removes the line (back to the default).
 * The screen's route, the lead's tool and Restore all come through here. The journal line is written first (pending) and committed after
 * the file was written; a write that fails marks it failed, so history never shows a change that did not happen.
 * opts: { file (a test's own startup file), journal (a journal with recordChange/commit/recordFailure) }.
 * Returns { ok, key, before, after, changed, restartNeeded: true } or { ok: false, error }.
 */
function setEnv(key, raw, opts = {}) {
  const ef = require('./env-file');
  const v = ef.validate(key, raw);
  if (!v.ok) return v;
  const j = opts.journal || journal;
  const now = ef.read({ file: opts.file });
  if (now.error) return { ok: false, error: now.error };
  const row = now.rows.find((r) => r.key === key);
  const before = row && row.value !== null ? row.value : undefined;
  const after = v.value === '' ? undefined : v.value;
  let entries = [];
  if (!journal.same(before, after)) {
    try { entries = j.recordChange('env', [{ key, before, after }], { pending: true }); }
    catch (e) { return { ok: false, error: `Nothing was changed: the change journal could not be written (${e.message}).` }; }
  }
  const w = ef.write(key, v.value, { file: opts.file });
  if (!w.ok) { if (entries.length) j.recordFailure(entries); return { ok: false, error: w.error }; }
  if (entries.length) j.commit(entries);
  return { ok: true, key, before: before === undefined ? null : before, after: after === undefined ? null : after, changed: entries.length > 0, restartNeeded: true };
}

// ── apply ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Checks, then writes through the store's own function inside withActor(actor). Resolves { ok, before, after, journalIds, restart }
 * or { ok: false, error } with nothing written. journalIds are the entries THIS operation recorded (collected in its own flow: a
 * write by someone else meanwhile is never in it). onAgentChanged(name, fields): the caller's own way to tell the open pages after an
 * agent field was saved (replaces the default event); the rest of afterAgentChange (sandbox rebuild, greeting, recordings notice) always runs.
 */
async function apply(args = {}) {
  const { record, agent, user, actor = null, auth = null, onAgentChanged = null } = args;
  const c = check(args);
  if (!c.ok) return { ok: false, error: c.error };
  const t = target(record);
  const before = current({ record, agent, user, auth, envFile: args.envFile });
  const uid = userIdOf(user);
  const write = async () => {
    if (t.kind === 'env') { const r = setEnv(t.key, c.value, { file: args.envFile, journal: args.envJournal }); return r.ok ? { ok: true } : { ok: false, error: r.error }; }
    if (t.kind === 'action') {
      // Stop / Resume: the hub's own halt and resume (each writes its own journal line, restorable false, as this actor)
      const ops = args.hubOps || require('./sdk-chat');
      const a = actor && typeof actor === 'object' ? actor : { kind: 'hub' };
      const by = args.by || a.user || null;
      if (c.value === 'stopped') ops.haltHub(a.why || 'asked in chat', { actor: a, by });
      else ops.resumeHub({ actor: a, reason: a.why || 'asked in chat' });
      return { ok: true };
    }
    if (t.kind === 'settings') {
      const providersChanged = !!c.patch.providers;
      hubSettings.updateSettings(c.patch);
      try { afterSettingsWrite(c.patch, { providersChanged }); } catch (e) { console.warn('[settings] saved, but the follow-up failed:', e.message); }
      return { ok: true };
    }
    if (t.kind === 'agent') {
      const u = userObj(user, auth);
      let isOwner = false; try { isOwner = !!u && (auth || require('./auth').getAuth()).isOwner(u); } catch { isOwner = false; }
      const wctx = agentWriteContext({ isOwner, user: u });
      if (args.expectStamp !== undefined) wctx.expectStamp = args.expectStamp;   // the agent must still be the one the person was shown (lib/agents stampOf)
      const allowedBefore = 'recordings' in c.fields ? recordingsAllowed(agent) : null;
      // policyIfMatch: the policy the caller read (the lead's folder rows): nothing is written when the stored policy is not that one (409)
      let fields = args.policyIfMatch !== undefined && 'policy' in c.fields ? { ...c.fields, policyIfMatch: args.policyIfMatch } : c.fields;
      // lockboxEnvIfMatch: the kept variables the caller read; nothing is written when the stored list is not that one (409)
      if (args.lockboxEnvIfMatch !== undefined && 'lockboxEnv' in c.fields) fields = { ...fields, lockboxEnvIfMatch: args.lockboxEnvIfMatch };
      const r = await require('./agents').updateAgentField(agent, fields, wctx);
      if (!r || !r.success) return { ok: false, error: (r && r.error) || 'could not save that', status: r && r.status };
      // The route's follow-ups, shared (sandbox rebuild, greeting, recordings notice, open pages); the caller's own publish replaces the default one.
      await afterAgentChange(agent, c.fields, { allowedBefore, publish: typeof onAgentChanged === 'function' ? onAgentChanged : undefined });
      return { ok: true };
    }
    const a = auth || require('./auth').getAuth();
    if (t.store === 'users') {
      const r = t.field === 'timeZone' ? a.setTimeZone(uid, c.value, { pinned: !!c.value }) : a.setPrefs(uid, { [t.field]: c.value });
      return r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'could not save that' };
    }
    if (t.store === 'research') {
      const p = require('./research-prefs').getResearchPrefs(), k = personKey(user, a);
      if (t.field === 'choice') p.setChoice(k, c.value); else p.setAlwaysLevel(k, c.value);
      return { ok: true };
    }
    if (t.store === 'notify') {
      const np = require('./notify-prefs').getNotifyPrefs();
      if (t.scope === 'default') np.setDefault(uid, { [t.field]: c.value }); else np.setAgent(uid, agent, { [t.field]: c.value });
      return { ok: true };
    }
    if (t.store === 'voice') { require('./voice-person-prefs').getVoicePersonPrefs().setInterruptReminder(uid, c.value); return { ok: true }; }
    return { ok: false, error: 'screen' };
  };
  let w, ids, history;
  try { ({ result: w, ids, history } = await journal.withActorCollect(actor || { kind: 'hub' }, write)); }
  catch (e) { return { ok: false, error: (e && e.message) || 'could not save that' }; }
  if (!w.ok) return { ok: false, error: w.error, status: w.status };
  if (c.lockboxChange) announceLockboxChange(c.lockboxChange, { userId: uid });
  const out = { ok: true, before, after: current({ record, agent, user, auth, envFile: args.envFile }), journalIds: ids, restart: !!(record && record.restart) };
  // The change is saved but its history line could not be written: still ok, but no entries (so no Undo and no change line) and history:false.
  if (history === false) { out.history = false; out.journalIds = []; out.note = 'saved; the history line could not be written'; }
  return out;
}

module.exports = {
  target, current, check, apply, leadConfirmed, setEnv,
  afterAgentChange, publishAgentUpdate, restoreAgentField, restoreSetting, recordingsAllowed, _setSandboxRemover,
  cleanSettingsPatch, afterSettingsWrite, announceLockboxChange, DROPPED_KEYS,
  setGlobalSetting, cleanGlobalSetting, isGlobalSetting, GLOBAL_SETTINGS,
  agentFieldAllowed, agentWriteContext, MEMBER_EDITABLE_AGENT_FIELDS,
};
