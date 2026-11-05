'use strict';
// Memory health: how each agent's memory is doing, checked every night and on demand (Settings → Status → Memory). Red
// agents go on the setup checklist, and admins get one phone notice when an agent turns red; the phone ⋮ menu lists the
// agents that need attention. It measures and explains; nothing here changes an agent, and nothing depends on anyone
// acting.
//
// Per agent:
//   records      its Records against the cap its route loads them under, worked out as the gateway does before a turn
//                (lib/records routeCap + usage): amber from 75% (the agent itself is told then, on every turn), red once
//                a file no longer loads; always amber when the cap is an estimate (a local model server didn't answer);
//                red for files that look like Records but are never loaded (a dead link, a link the hub won't follow)
//   context      how full its recent turns ended (lib/compaction history: the context size at the end of each turn,
//                for Claude-client and gateway agents): for information, and amber when its last turn ended at 90% or
//                more while compression is off or only a dry run for it
//   compression  how often it ran lately, and amber when the last run (within a week) failed
//   archive      its conversation archive (lib/transcript health, from the index only): entries, size, rows added in
//                30 days, and how long its own searches of the last 7 days took (lib/transcript searchTimes): amber when
//                3 or more took 500 ms or longer, red when 3 or more took 2 s or longer; red when it can't be read
//   chat         its chat file: messages and size, for information (the hub keeps the newest 200 to 300 messages
//                there; the archive keeps everything)
// A measurement that fails is reported as such (amber), never as fine.
//
// Actions, each offered with the finding it answers and run only when an admin presses it (POST /api/memory-health/
// action; nothing ever depends on one being pressed):
//   condense          a turn for the agent asking it to condense its Records, keeping every fact it still needs
//   compression-on    its compression off or a dry run -> on
//   compress-earlier  its compression threshold down to 60% (offered when its recent turns reached 80%)
//   tidy-index        its archive's search index merged, a bounded step at a time
//   delete-bundle     a deleted agent's folder removed for good (the admin types the agent's name)
//   delete-pre-split  the combined archive kept after the split removed for good (the admin types "delete")
// Hub-wide: deleted agents' folders (data/archived-agents, lib/agent-archive) and the combined archive kept after the
// split (data/transcript.db.pre-split*), with their sizes.

const fs = require('fs');
const path = require('path');

const LEVEL = { green: 0, amber: 1, red: 2 };
const worse = (a, b) => (LEVEL[b] > LEVEL[a] ? b : a);
const RECORDS_AMBER = 75;
const NEARLY_FULL = 90;
const SEARCH_AMBER_MS = 500, SEARCH_RED_MS = 2000, SLOW_SEARCHES = 3;
const MIN_READINGS = 3;
const DAY = 86400000, HOUR = 3600000;
const NIGHT = [2, 5];   // the nightly check runs between these hours of the hub's time zone
const EARLIER_AT = 0.6, EARLIER_WHEN = 80;   // compress-earlier sets this threshold; offered once turns reached this %
const TIDY_MAX_MS = 10 * 60 * 1000;          // a tidy stops after this long (each step is small; it can be run again)
const TIDY_PAUSE_MS = 25, TIDY_ANSWER_MS = 20000;   // the pause between tidy steps; how long the press waits for the end
const TIDY_NOTES = 10;                              // tidy outcomes kept for the pages following them
const FILE = path.join(__dirname, '..', 'data', 'memory-health.json');

function sizeLabel(n) {
  n = Number(n) || 0;
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(1)} GB`;
}
function tokensLabel(n) {
  n = Number(n) || 0;
  return n >= 1000000 ? `${+(n / 1000000).toFixed(1)}M` : `${Math.round(n / 1000)}K`;
}
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const num = (n) => (Number(n) || 0).toLocaleString('en-US');
function dateIn(zone, ms) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString().slice(0, 10); }
}
function hourIn(zone, ms) {
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms))) % 24; }
  catch { return new Date(ms).getUTCHours(); }
}

function createMemoryHealth({
  file = FILE, now = Date.now, log = (m) => console.log(m), zone = () => 'UTC',
  listAgents = async () => [],                    // -> [{ name, display, record }]
  recordsUsage = async () => null,                // (agent) -> lib/records usage { used, cap, pct, files, notLoaded } + estimated; throws when unreadable
  history = () => ({ readings: [], runs: [] }),   // (name) -> lib/compaction history
  compactionSettings = () => ({ mode: 'on', at: 0.75 }),   // (name) -> { mode: 'off' | 'dry' | 'on' | 'assisted', at }
  archiveHealth = () => ({ entries: 0 }),         // (name, since) -> lib/transcript health; null = can't be read
  searchTimes = () => ({ count: 0, maxMs: 0, slow: 0, verySlow: 0 }),   // (name) -> lib/transcript searchTimes
  chatFile = async () => null,                    // (name) -> { messages, bytes } | null (none); throws when unreadable
  bundles = async () => [],                       // -> [{ folder, name, bytes, complete, partial }]
  preSplit = () => [],                            // -> [{ file, bytes }]
  notify = () => {},                              // (payload) -> { sent, failed } of a phone notice to admins
  // Actions (only an admin's press runs them):
  agentBusy = () => false,                        // (name) -> a turn or a background job is running
  snapshotRecords = async () => ({ file: null, name: null, files: 0 }),   // (agent) -> lib/records snapshot (not pruned); throws when one can't be read
  discardSnapshot = async () => {},               // (agent, snapshot) -> that copy removed again (the turn was refused: nothing changed)
  pruneSnapshots = async () => 0,                 // (agent, snapshot) -> the older copies beyond the newest few removed, never this one (once a turn started)
  startTurn = async () => ({ done: Promise.resolve('') }),   // (name, message) -> resolves once the hub admitted the turn; rejects with its reason (err.status)
  setCompaction = async () => ({ success: true }),   // (name, change) -> only the given field ({ mode } or { at }) over the agent's own setting
  tidyStep = () => ({ done: true }),              // (name, { first }) -> lib/transcript tidyStep
  removeBundle = async () => ({}),                // (folder, { expectName }) -> lib/agent-archive removeBundle
  removePreSplit = async () => ({}),              // (file) -> the file (and its -wal/-shm) removed
  pause = () => new Promise(r => setImmediate(r)),   // between agents, so the hub keeps answering during a check
  sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
  tidyPauseMs = TIDY_PAUSE_MS, tidyAnswerMs = TIDY_ANSWER_MS,
} = {}) {
  const stamp = (t) => { try { return require('./timezone').stamp(t, zone()); } catch { return new Date(t).toISOString(); } };

  async function checkAgent(a) {
    const items = [];
    const add = (key, status, title, detail, actions = null) => items.push({ key, status, title, detail, ...(actions && actions.length ? { actions } : {}) });
    const failed = (key, what, e) => add(key, 'amber', `Couldn't check its ${what}`, `${String((e && e.message) || e)}.`);

    let u = null;
    try { u = await recordsUsage(a); } catch (e) { failed('records', 'Records', e); }
    if (u && (u.files || (u.notLoaded || []).length)) {
      const missing = u.notLoaded || [];
      const files = missing.map(f => `${f.name} (${sizeLabel(f.bytes)})`).join(', ');
      // An estimated cap (a local model server that didn't answer) decides nothing: amber, with what would settle it.
      const settle = 'Starting the model server, or setting the agent\'s context window on its settings page, lets a check a few minutes later confirm it.';
      const condense = [{ id: 'condense', label: 'Ask it to condense its Records' }];
      if (u.estimated && missing.length) add('records', 'amber', 'Some Records may not be loading', `${files} may not fit in its Records cap of about ${sizeLabel(u.cap)}: its local model server didn't say how big its window is, so the cap is an estimate. ${settle}`);
      else if (u.estimated) add('records', 'amber', 'Records cap not confirmed', `${sizeLabel(u.used)} of its Records would load under a cap of about ${sizeLabel(u.cap)}, but its local model server didn't say how big its window is. ${settle}`);
      else if (missing.length) add('records', 'red', 'Some Records aren\'t loading', `${files} ${missing.length === 1 ? 'doesn\'t' : 'don\'t'} fit in its ${sizeLabel(u.cap)} Records cap, so ${missing.length === 1 ? 'it isn\'t' : 'they aren\'t'} in front of it. It is told about this on every turn.`, condense);
      else if (u.pct >= RECORDS_AMBER) add('records', 'amber', 'Records nearly full', `${sizeLabel(u.used)} of its ${sizeLabel(u.cap)} cap (${u.pct}%). It is told on every turn to condense them.`, condense);
      else add('records', 'green', 'Records', `${sizeLabel(u.used)} of its ${sizeLabel(u.cap)} cap (${u.pct}%).`);
    }
    const links = ((u && u.unloadable) || []).filter(f => f.kind !== 'name'), names = ((u && u.unloadable) || []).filter(f => f.kind === 'name');
    if (links.length) add('records', 'red', 'Some Records can\'t be loaded', `${links.map(f => `${f.name} (${f.why})`).join(', ')}. ${links.length === 1 ? 'It isn\'t' : 'They aren\'t'} in front of it, and it isn't told.`);
    if (names.length) add('records', 'amber', `${names.length === 1 ? 'A file' : 'Some files'} in its Records folder can't be opened`, `${names.map(f => `${f.name} (${f.why})`).join(', ')}. ${names.length === 1 ? 'It isn\'t' : 'They aren\'t'} loaded as a Record.`);

    let h = { readings: [], runs: [] };
    try { h = history(a.name) || h; } catch (e) { failed('context', 'context readings', e); }
    const rs = (h.readings || []).filter(r => Number(r.tokens) > 0 && Number(r.limit) > 0);
    if (rs.length >= MIN_READINGS) {
      const pcts = rs.map(r => (r.tokens / r.limit) * 100);
      const lo = Math.round(Math.min(...pcts)), hi = Math.round(Math.max(...pcts)), last = Math.round(pcts[pcts.length - 1]);
      const window = tokensLabel(rs[rs.length - 1].limit);
      const oneWindow = rs.every(r => r.limit === rs[0].limit);
      let cs = null;
      try { cs = compactionSettings(a.name) || null; } catch (e) { failed('context', 'compression setting', e); }
      const mode = cs && cs.mode, at = cs && Number(cs.at);
      if (last >= NEARLY_FULL && (mode === 'off' || mode === 'dry')) add('context', 'amber', 'Context nearly full', `Its last turn ended at ${last}% of its ${window}-token window, and compression is ${mode === 'off' ? 'off' : 'only a dry run'} for it.`, [{ id: 'compression-on', label: 'Turn compression on' }]);
      else add('context', 'green', 'Context', `Its last ${rs.length} turns ended between ${lo}% and ${hi}% of ${oneWindow ? `its ${window}-token window` : `the window each turn had (the latest was ${window} tokens)`}.`,
        (mode === 'on' || mode === 'assisted') && at > EARLIER_AT && hi >= EARLIER_WHEN ? [{ id: 'compress-earlier', label: `Compress earlier (at ${Math.round(EARLIER_AT * 100)}% instead of ${Math.round(at * 100)}%)` }] : null);
    }

    const runs = Array.isArray(h.runs) ? h.runs : [];
    const lastRun = runs[runs.length - 1];
    if (lastRun && !lastRun.ok && now() - Date.parse(lastRun.at) < 7 * DAY) add('compression', 'amber', 'The last compression failed', `${stamp(lastRun.at)}: ${lastRun.error || 'no reason given'}.`);
    else if (lastRun) add('compression', 'green', 'Compression', `${plural(runs.filter(r => now() - Date.parse(r.at) < 7 * DAY).length, 'run')} in the last 7 days; last ${stamp(lastRun.at)}.`);

    let ah = { entries: 0 };
    try { ah = archiveHealth(a.name, now() - 30 * DAY); } catch (e) { failed('archive', 'archive', e); ah = { entries: 0 }; }
    if (ah === null) add('archive', 'red', 'Its archive can\'t be read', 'Recall and search find nothing from its past conversations until the file is repaired or restored from a backup.');
    else if (ah && ah.entries) {
      let t = { count: 0, maxMs: 0, slow: 0, verySlow: 0 }; try { t = searchTimes(a.name) || t; } catch {}
      const status = t.verySlow >= SLOW_SEARCHES ? 'red' : t.slow >= SLOW_SEARCHES ? 'amber' : 'green';
      const speed = !t.count ? '' : status === 'green' ? `; the slowest of its ${plural(t.count, 'search', 'searches')} this week took ${num(Math.round(t.maxMs))} ms`
        : `; ${t[status === 'red' ? 'verySlow' : 'slow']} of its ${plural(t.count, 'search', 'searches')} this week took ${status === 'red' ? '2 seconds' : '500 ms'} or longer (the slowest ${num(Math.round(t.maxMs))} ms)`;
      add('archive', status, status === 'green' ? 'Archive' : 'Searching its archive is slow',
        `${num(ah.entries)} entries${ah.fileBytes != null ? `, ${sizeLabel(ah.fileBytes)}` : ''}; ${num(ah.recent)} added in the last 30 days${speed}.`,
        status === 'green' || ah.fileBytes == null ? null : [{ id: 'tidy-index', label: 'Tidy its search index' }]);   // no own file: all agents still share one
      if (t.failed) add('archive', 'amber', 'Some searches of its archive failed', `${plural(t.failed, 'search', 'searches')} this week failed, so recall may have missed its past conversations then.`);
    }

    try {
      const c = await chatFile(a.name);
      if (c && c.messages) add('chat', 'green', 'Chat', `${plural(c.messages, 'message')} in its chat file, ${sizeLabel(c.bytes)}.`);
    } catch (e) { failed('chat', 'chat file', e); }

    return { agent: a.name, display: a.display || a.name, status: items.reduce((w, i) => worse(w, i.status), 'green'), items };
  }

  let last = null, running = null, gen = 0;
  // This process's results: gen rises with each check; a page that sees another epoch (a restart, a restored file)
  // starts comparing afresh.
  const epoch = require('crypto').randomBytes(4).toString('hex');
  function readStored() { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
  function store(r) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(r, null, 1), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log(`[memory-health] could not save the result: ${e.message}`); }
  }

  /** run() -> the result (one check at a time: a second call while one runs gets that one). */
  function run() {
    if (running) return running;
    running = (async () => {
      const before = last || readStored();
      gen = Math.max(gen, Number(before && before.gen) || 0) + 1;   // checks run one at a time, so a later check has a higher number
      const myGen = gen;
      const agents = await listAgents();
      const out = [];
      for (const a of agents) {
        try { out.push(await checkAgent(a)); }
        catch (e) { out.push({ agent: a.name, display: a.display || a.name, status: 'amber', items: [{ key: 'check', status: 'amber', title: 'Couldn\'t be checked', detail: `${String((e && e.message) || e)}.` }] }); }
        await pause();
      }
      const order = (x) => -LEVEL[x.status];
      out.sort((x, y) => (order(x) - order(y)) || x.display.localeCompare(y.display));
      let bs = [], ps = [];
      try { bs = (await bundles()) || []; } catch (e) { log(`[memory-health] deleted agents' folders: ${e.message}`); }
      try { ps = preSplit() || []; } catch (e) { log(`[memory-health] combined archive: ${e.message}`); }
      const counts = { red: 0, amber: 0, green: 0 };
      for (const x of out) counts[x.status]++;
      const result = { epoch, gen: myGen, checkedAt: new Date(now()).toISOString(), agents: out, counts, ...(tidyNotes.size ? { tidies: [...tidyNotes.values()] } : {}),
        extras: { bundles: { count: bs.length, bytes: bs.reduce((s, b) => s + (Number(b.bytes) || 0), 0), complete: bs.every(b => b.complete !== false),
          items: bs.map(b => ({ ...b, ...(b.partial ? {} : { action: { id: 'delete-bundle', folder: b.folder, confirm: b.name || b.folder } }) })) },
        preSplit: ps.map(p => ({ ...p, action: { id: 'delete-pre-split', file: p.file, confirm: 'delete' } })) } };
      // One phone notice for agents that turned red. An agent counts as told once a notice reached a device (or there
      // was no device to send it to); when sending failed, the next check tries again.
      const told = new Set(Array.isArray(before && before.notified) ? before.notified : ((before && before.agents) || []).filter(x => x.status === 'red').map(x => x.agent));
      const fresh = out.filter(x => x.status === 'red' && !told.has(x.agent));
      let delivered = false;
      if (fresh.length) {
        const top = (x) => (x.items.find(i => i.status === 'red') || {}).title || 'needs attention';
        try {
          const r = await notify({ title: fresh.length === 1 ? `${fresh[0].display}: ${top(fresh[0]).toLowerCase()}` : `${fresh.length} agents need attention`,
            body: fresh.length === 1 ? 'Open Settings → Status → Memory to see what would help.' : fresh.map(x => `${x.display}: ${top(x).toLowerCase()}`).join('; '),
            url: '/?memory=1', tag: 'memory-health' });
          delivered = !(r && (r.error || (r.sent === 0 && r.failed > 0)));   // r.error: the push service itself failed
        } catch (e) { log(`[memory-health] notice failed: ${e.message}`); }
      }
      result.notified = out.filter(x => x.status === 'red' && (told.has(x.agent) || delivered)).map(x => x.agent);
      store(result);
      last = result;
      log(`[memory-health] ${counts.red} red, ${counts.amber} amber, ${counts.green} fine`);
      return result;
    })().finally(() => { running = null; });
    return running;
  }

  // tidy-index runs in steps with a pause between them, one tidy per agent at a time. Its outcome, under its own id,
  // rides on the checks after it (tidies), which the page follows when the press was answered before the tidy ended.
  const tidying = new Set();
  const tidyNotes = new Map();   // id -> outcome, the newest TIDY_NOTES (each press follows its own)
  let tidySeq = 0;
  const pctOf = (at) => Math.round(Number(at) * 100) || 75;
  const refusal = (e, name) => (e && e.status === 409 ? `${name} started working on something else just now. Try again when it's done.`
    : `The hub didn't start ${name}'s turn: ${String((e && e.message) || e)}.`);
  /** A check that starts after whatever an action just changed: one already running may have read the old state. */
  async function freshRun() { const prior = running; if (prior) { try { await prior; } catch {} } return run(); }

  /**
   * act({ action, agent, folder, file, confirm }) -> { ok, message, result?, pending? } | { ok: false, error }: one action
   * an admin pressed. Each is checked against what it applies to now; the deletes need the typed word (the agent's
   * name, or "delete"). A finished action checks again and returns the new result. The condense turn runs on (the next
   * check shows what it did); a tidy that outlasts the press answers with pending and finishes in the background.
   */
  async function act({ action, agent = null, folder = null, file = null, confirm = null } = {}) {
    const fail = (error) => ({ ok: false, error });
    if (['condense', 'compression-on', 'compress-earlier', 'tidy-index'].includes(action)) {
      const a = (await listAgents()).find(x => x.name === String(agent || ''));
      if (!a) return fail('There is no agent by that name.');
      const name = a.display || a.name;
      if (agentBusy(a.name)) return fail(`${name} is working right now (a reply or a background job). Try again when it's done.`);
      if (action === 'condense') {
        let u = null; try { u = await recordsUsage(a); } catch (e) { return fail(`Couldn't read ${name}'s Records: ${e.message}.`); }
        if (!u || !(u.files || (u.notLoaded || []).length)) return fail(`${name} has no Records to condense.`);
        let snap; try { snap = await snapshotRecords(a); } catch (e) { return fail(`Couldn't keep a copy of ${name}'s Records first (${e.message}), so nothing was asked.`); }
        const missing = (u.notLoaded || []).map(f => f.name);
        const copy = snap && snap.name ? ` A copy of your Records as they are now is in your workspace (${snap.name}).` : '';
        const msg = `[From the hub, at an admin's request] Your Records use ${sizeLabel(u.used)} of their ${sizeLabel(u.cap)} cap (${u.pct}%)${missing.length ? `, and ${missing.join(', ')} ${missing.length === 1 ? "doesn't" : "don't"} fit, so ${missing.length === 1 ? "it isn't" : "they aren't"} loaded` : ''}. Condense them now. First read every Record in full: the ones in front of you, and with your Read tool any that aren't loaded (record_list shows their folder). If one can't be read, change nothing and say which. Then rewrite the ones that need it with record_write: keep every fact, number, date, decision and reason you still need; remove what is out of date or repeated, and what recall can find again in your archive. Never drop a fact you still need to make them fit, and don't merge files: an emptied file stays behind and saves no space.${copy} Reply with one line per Record you changed and its size now.`;
        try { await startTurn(a.name, msg); }
        catch (e) { try { await discardSnapshot(a, snap); } catch {} return fail(refusal(e, name)); }   // nothing was asked, so nothing is kept
        try { await pruneSnapshots(a, snap); } catch (e) { log(`[memory-health] old copies of ${a.name}'s Records: ${e.message}`); }   // only now: a refused press never pushes out a copy
        return { ok: true, message: `Asked ${name} to condense its Records. It is working on it now, and the next check shows the result.${snap && snap.name ? ` A copy of them as they were is in its workspace (${snap.name}).` : ''}` };
      }
      if (action === 'tidy-index') {
        if (tidying.has(a.name)) return fail(`${name}'s search index is being tidied already.`);
        tidying.add(a.name);
        let r0;
        try { r0 = tidyStep(a.name, { first: true }); } catch (e) { tidying.delete(a.name); return fail(`Couldn't tidy ${name}'s search index: ${e.message}.`); }
        const no = r0 === null || r0 === undefined ? `${name} has no archive yet.`
          : r0 === false ? `Couldn't open ${name}'s archive, so its search index can't be tidied.`
          : r0.combined ? `Every agent's archive is still in the one shared file of an earlier version, so ${name}'s search index can't be tidied on its own. Your Maestro splits that file at its next start.` : null;
        if (no) { tidying.delete(a.name); return fail(no); }
        const id = `t${now().toString(36)}${++tidySeq}`;
        const job = (async () => {
          const t0 = now(); let steps = 1, done = !!r0.done, error = null;
          try {
            while (!done && now() - t0 < TIDY_MAX_MS) {
              await sleep(tidyPauseMs);
              const r = tidyStep(a.name, { first: false });
              if (!r || r.combined) { error = 'the agent was renamed or deleted while it ran, so its archive moved'; break; }
              done = !!r.done; steps++;
            }
          } catch (e) { error = String((e && e.message) || e); }
          const message = error ? `Couldn't finish tidying ${name}'s search index: ${error}.`
            : done ? `Tidied ${name}'s search index (${plural(steps, 'step')}).`
            : `Tidied part of ${name}'s search index in ${Math.round(TIDY_MAX_MS / 60000)} minutes; press it again to go on.`;
          const note = { id, agent: a.name, ok: !error, done, steps, message, at: new Date(now()).toISOString() };
          tidyNotes.set(id, note);
          while (tidyNotes.size > TIDY_NOTES) tidyNotes.delete(tidyNotes.keys().next().value);
          tidying.delete(a.name);
          log(`[memory-health] ${message}`);
          let result = null; try { result = await freshRun(); } catch (e) { log(`[memory-health] the check after a tidy failed: ${e.message}`); }
          return { note, result };
        })();
        const quick = await Promise.race([job, sleep(tidyAnswerMs).then(() => null)]);
        if (quick) return quick.note.ok ? { ok: true, message: quick.note.message, result: quick.result } : fail(quick.note.message);
        return { ok: true, pending: { tidy: id }, message: `Tidying ${name}'s search index. It goes on in the background (at most ${Math.round(TIDY_MAX_MS / 60000)} minutes), and this list updates when it's done.` };
      }
      let cs; try { cs = compactionSettings(a.name) || {}; } catch (e) { return fail(`Couldn't read ${name}'s compression setting: ${e.message}.`); }
      const after = () => { try { return compactionSettings(a.name) || cs; } catch { return cs; } };
      if (action === 'compression-on') {
        if (cs.mode === 'on' || cs.mode === 'assisted') return fail(`Compression is already on for ${name}.`);
        const r = await setCompaction(a.name, { mode: 'on' });
        if (!r || !r.success) return fail((r && r.error) || 'The setting could not be saved.');
        return { ok: true, message: `Compression is on for ${name}: it compresses when its context reaches ${pctOf(after().at)}% of its window.`, result: await freshRun() };
      }
      // compress-earlier
      if (!(Number(cs.at) > EARLIER_AT)) return fail(`${name} already compresses at ${pctOf(cs.at)}%.`);
      const r = await setCompaction(a.name, { at: EARLIER_AT });
      if (!r || !r.success) return fail((r && r.error) || 'The setting could not be saved.');
      const mode = after().mode;
      return { ok: true, message: `${name} now compresses when its context reaches ${pctOf(EARLIER_AT)}% of its window${mode === 'on' || mode === 'assisted' ? '' : ' (its compression is not on, so this applies once it is)'}.`, result: await freshRun() };
    }
    if (action === 'delete-bundle') {
      const r = stored();
      const b = (((r && r.extras && r.extras.bundles && r.extras.bundles.items) || []).find(x => x.folder === String(folder || '')));
      if (!b || !b.action) return fail('There is no such folder of a deleted agent (check again: it may be gone, or still being put away).');
      if (String(confirm || '').trim() !== b.action.confirm) return fail(`Type ${b.action.confirm} to delete it for good.`);
      try { await removeBundle(b.folder, { expectName: b.action.confirm }); } catch (e) { return fail(`Couldn't delete it: ${e.message}.`); }
      return { ok: true, message: `Deleted ${b.name || b.folder}'s folder for good.`, result: await freshRun() };
    }
    if (action === 'delete-pre-split') {
      let ps = []; try { ps = preSplit() || []; } catch (e) { return fail(e.message); }
      const p = ps.find(x => x.file === String(file || ''));
      if (!p) return fail('There is no such file (check again: it may be gone).');
      if (String(confirm || '').trim() !== 'delete') return fail('Type delete to remove it for good.');
      try { await removePreSplit(p.file); } catch (e) { return fail(`Couldn't delete it: ${e.message}.`); }
      return { ok: true, message: `Deleted ${p.file} for good.`, result: await freshRun() };
    }
    return fail('Unknown action.');
  }

  /** The last result when it is younger than maxAgeMs, else a fresh check. */
  async function latest({ maxAgeMs = 26 * HOUR } = {}) {
    const r = last || readStored();
    if (r && now() - Date.parse(r.checkedAt) < maxAgeMs) return { ...r, cached: true };
    return { ...(await run()), cached: false };
  }
  /** The last stored result, never a new check (the setup checklist and the phone menu read this), with the newest tidy
   *  outcomes of this process even when the check after a tidy failed. */
  function stored() {
    const r = last || readStored();
    return r && tidyNotes.size ? { ...r, tidies: [...tidyNotes.values()] } : r;
  }

  /** Setup checklist lines (lib/readiness): red agents as a warning, amber ones as a note. */
  function readinessItems() {
    const r = stored();
    if (!r || !Array.isArray(r.agents) || !r.agents.length) return [];
    const open = { label: 'Open Memory', href: '/?memory=1' };
    const red = r.agents.filter(a => a.status === 'red'), amber = r.agents.filter(a => a.status === 'amber');
    const line = (xs, level) => xs.map(x => `${x.display}: ${((x.items.find(i => i.status === level) || {}).title || '').toLowerCase()}`).join('; ');
    if (red.length) return [{ id: 'memory', level: 'warn', title: `${plural(red.length, 'agent')} ${red.length === 1 ? 'needs' : 'need'} attention for memory`, detail: `${line(red, 'red')}.`, fix: 'Settings → Status → Memory says what each one needs.', action: open }];
    if (amber.length) return [{ id: 'memory', level: 'info', title: `${plural(amber.length, 'agent')} could use a look for memory`, detail: `${line(amber, 'amber')}.`, fix: 'Settings → Status → Memory says what would help.', action: open }];
    return [{ id: 'memory', level: 'ok', title: 'Agents\' memory', detail: `All ${plural(r.agents.length, 'agent')} are fine (checked ${stamp(r.checkedAt)}).` }];
  }

  /** Is a check due? Never checked: yes (the first look after start). At night (NIGHT, the hub's time zone): when there
   *  has been no check yet on this calendar day. At any hour once the last check is 48 hours old (a computer that is
   *  off at night). */
  function isDue(ms = now()) {
    const r = stored();
    const at = r ? Date.parse(r.checkedAt) : NaN;
    if (!(at > 0)) return true;
    if (ms - at >= 48 * HOUR) return true;
    const z = zone(), h = hourIn(z, ms);
    return h >= NIGHT[0] && h < NIGHT[1] && dateIn(z, at) !== dateIn(z, ms);
  }
  let timer = null, first = null;
  /** Look every hour whether the nightly check is due (the first look a few minutes after start). */
  function schedule({ tickMs = HOUR, firstDelayMs = 5 * 60 * 1000 } = {}) {
    stop();
    const tick = () => { if (isDue()) run().catch(e => log(`[memory-health] check failed: ${e.message}`)); };
    first = setTimeout(tick, firstDelayMs); if (first.unref) first.unref();
    timer = setInterval(tick, tickMs); if (timer.unref) timer.unref();
    return true;
  }
  function stop() { if (first) clearTimeout(first); if (timer) clearInterval(timer); first = timer = null; }

  return { checkAgent, run, act, latest, stored, readinessItems, isDue, schedule, stop };
}

// The size of folders without holding up the hub: one entry at a time, and no more than budget.left entries across
// every call that shares the budget. complete is false when the budget ran out (the size is then at least bytes).
async function folderBytes(dir, budget = { left: 200000 }) {
  let bytes = 0, complete = true;
  const walk = async (d) => {
    let names = []; try { names = await fs.promises.readdir(d); } catch { return; }
    for (const n of names) {
      if (--budget.left < 0) { complete = false; return; }
      const p = path.join(d, n);
      let st; try { st = await fs.promises.lstat(p); } catch { continue; }
      if (st.isDirectory()) { await walk(p); if (!complete) return; } else if (st.isFile()) bytes += st.size;
    }
  };
  await walk(dir);
  return { bytes, complete };
}

let shared = null;
function getMemoryHealth() {
  if (shared) return shared;
  const transcriptLib = require('./transcript');
  const tr = () => transcriptLib.getTranscript();
  const comp = () => require('./sdk-chat').getCompaction();
  const conversations = path.join(__dirname, '..', 'data', 'conversations');
  shared = createMemoryHealth({
    zone: () => { try { return require('./timezone').hubZone(); } catch { return 'UTC'; } },
    listAgents: async () => (await require('./agents').getAgents()).map(a => ({ name: a.name, display: a.display || a.name, record: a })),
    recordsUsage: async (a) => {
      const records = require('./records');
      const rc = await records.routeCap(a.name, { agentRecord: a.record });
      return { ...records.usage(a.name, { agentRecord: a.record, strict: true, cap: rc.cap }), estimated: rc.estimated, unloadable: records.unloadable(a.name) };
    },
    history: (n) => comp().history(n),
    compactionSettings: (n) => { const st = comp().settingsFor(n); return { mode: st.mode, at: st.at }; },
    archiveHealth: (n, since) => tr().health(n, { since }),
    searchTimes: (n) => tr().searchTimes(n),
    chatFile: async (n) => {
      let b;
      try { b = await fs.promises.readFile(path.join(conversations, `${n}.jsonl`)); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
      let lines = 0; for (let i = 0; i < b.length; i++) if (b[i] === 10) lines++;
      if (b.length && b[b.length - 1] !== 10) lines++;
      return { messages: lines, bytes: b.length };
    },
    bundles: async () => {
      const budget = { left: 200000 }, out = [];
      for (const b of require('./agents').getAgentArchive().bundles()) {
        const sz = await folderBytes(b.dir, budget);
        out.push({ folder: b.folder, name: b.manifest ? b.manifest.name : null, partial: b.partial, bytes: sz.bytes, complete: sz.complete });
      }
      return out;
    },
    preSplit: () => {
      const f = transcriptLib.DB_FILE, d = path.dirname(f), base = path.basename(f);
      let names = []; try { names = fs.readdirSync(d); } catch { return []; }
      return names.filter(n => n.startsWith(`${base}.pre-split`) && !/-(wal|shm)$/.test(n)).map(n => {
        let bytes = 0; for (const x of ['', '-wal', '-shm']) { try { bytes += fs.statSync(path.join(d, n + x)).size; } catch {} }
        return { file: n, bytes };
      });
    },
    notify: (payload) => require('./push').getPush().notify(payload, { adminsOnly: true }),
    agentBusy: (n) => require('./agents').agentBusy(n),
    snapshotRecords: async (a) => require('./records').snapshot(a.name, { prune: false }),
    discardSnapshot: async (a, snap) => { if (snap && snap.name) require('./records').discardSnapshot(a.name, snap.name); },
    pruneSnapshots: async (a, snap) => require('./records').pruneSnapshots(a.name, { protect: snap && snap.name }),
    startTurn: (n, message) => require('./sdk-chat').startHubTurn(n, message, { origin: { kind: 'task', from: 'hub', label: 'condense Records' } }),
    // only the field the action changes, over the agent's own setting: the other one keeps following the hub default
    setCompaction: async (n, change) => {
      const agents = require('./agents');
      const cur = (await agents.getAgents()).find(x => x.name === n);
      const own = cur && cur.compaction && typeof cur.compaction === 'object' ? cur.compaction : {};
      return agents.updateAgentField(n, { compaction: { ...own, ...change } });
    },
    tidyStep: (n, o) => tr().tidyStep(n, o),
    removeBundle: (folder, o) => require('./agents').getAgentArchive().removeBundle(folder, o),
    removePreSplit: async (file) => {
      const f = transcriptLib.DB_FILE, d = path.dirname(f), base = path.basename(f);
      if (!String(file).startsWith(`${base}.pre-split`) || /[\\/]/.test(String(file)) || /-(wal|shm)$/.test(String(file))) throw new Error('not the combined archive');
      for (const x of ['-wal', '-shm', '']) { try { await fs.promises.unlink(path.join(d, file + x)); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    },
  });
  return shared;
}

module.exports = { createMemoryHealth, getMemoryHealth, folderBytes, sizeLabel, tokensLabel, hourIn, dateIn, RECORDS_AMBER, NEARLY_FULL, SEARCH_AMBER_MS, SEARCH_RED_MS, SLOW_SEARCHES, MIN_READINGS, NIGHT };
