'use strict';
// Agent-authored context compression. The provider never summarises an agent's session: when the
// hub's own threshold is reached (or the agent / owner asks), the hub runs the AGENT's compression turn.
// The agent, who knows what matters, updates its Records with every fact not yet there and writes a
// working brief (a Record) of what to carry forward verbatim. Only in modes 'on' / 'assisted' does the
// hub then open a fresh provider session (Claude) or restart the recent window (gateway models), seeded
// with the Records (brief included), the recent turns verbatim from the transcript archive, and recall
// for everything else. Nothing is lost: the archive keeps every turn.
//
// Modes (agents.json `compaction.mode`, else settings.compactionMode, else 'dry'; local models default
// to 'assisted'):
//   off      - the hub does nothing (the provider's own guard still exists at the very top of the window)
//   dry      - at the threshold the agent writes its brief; nothing is reset; the owner reads it first
//   on       - the agent writes its brief in one turn, then the hub resets
//   assisted - for small models: the hub feeds the recent transcript in slices the model can hold, the
//              agent extracts facts/decisions into its Records from each, then writes the brief from its
//              own extractions on a fixed template; then the hub resets. The agent writes every word.
// Threshold: `compaction.at` (fraction of the context window, else settings.compactionAt, else 0.75;
// local default 0.6).

const fs = require('fs');
const path = require('path');

const DEFAULT_AT = 0.75;
const DEFAULT_MODE = 'dry';
const LOCAL_AT = 0.6;
const LOCAL_MODE = 'assisted';
const MIN_GAP_MS = 60 * 60 * 1000;   // never twice within an hour for the same agent
const MODES = ['off', 'dry', 'on', 'assisted'];
const STATE_FILE = process.env.HUB_COMPACTION_FILE || path.join(__dirname, '..', 'data', 'compaction.json');

const BRIEF_FILE = 'working-brief.md';
const LOCAL_RE = /^(lmstudio|ollama|omlx|ninfer|local)\//i;

const BRIEF_TEMPLATE = `# Working brief
## Open threads (what is in progress, and its current state)
## Recent decisions (what was decided, and why)
## Pending (what is waiting, on whom, by when)
## Facts I must keep in front of me (numbers, names, dates; verbatim where wording matters)
## The owner's last words (the last three or four messages, quoted verbatim)
## What the owner most wants right now (one line)
## Where to look for the rest (which Records, what to recall)`;

function compressionPrompt({ agent, pct, mode, reason }) {
  const why = reason === 'owner' ? 'The owner asked for a compression now.' : reason === 'agent' ? 'You asked for a compression.' : `Your working context is at ${pct}% of its window.`;
  const tail = (mode === 'on' || mode === 'assisted')
    ? `After you reply, the hub starts you a FRESH session seeded with your Records (this brief included), the most recent turns verbatim from your transcript archive, and recall for everything older. So the brief must hold what you need in front of you; everything else is one recall away.`
    : `This is a DRY RUN: your session will NOT be reset. The owner will read your brief first and decide. Write it exactly as if it were real.`;
  return `[Context compression, from the hub] ${why} You are the expert on what matters here, so you write the carry-forward, not the provider. Do these in order, with your tools:
1. Update your Records (record_write; append where that keeps them tidy) with every fact, number, date, dosage or decision and the reason for it from this session that is not already in them.
2. Write the Record "${BRIEF_FILE}": what you want in front of you when you resume. Open threads and their state; recent decisions and why; what is pending, with whom, and by when; anything you would otherwise have to re-derive. Verbatim where exact wording matters. Include a section "The owner's last words" with the owner's last three or four messages quoted verbatim, and a one-line "What the owner most wants right now". Replace the previous brief if there is one.
3. Append to your long-term memory (append_memory) any lesson or standing rule from this session that should outlive it, if it is not already there.
4. Reply with a short list of what you updated and anything you chose to leave to recall.
${tail}`;
}

function assistedPartPrompt({ i, n, chunk }) {
  return `[Context compression, part ${i} of ${n}, from the hub] Below is a slice of your recent transcript. Do ONE thing: use record_write (append=true where that keeps a Record tidy) to add to your Records every fact, number, date, decision and reason in this slice that is not already in your Records. Patient, client or project facts go in that Record; general lessons in a Record named lessons.md. Do not write the brief yet. Reply with one line per Record you changed, or "nothing new".

--- transcript slice ${i}/${n} ---
${chunk}
--- end of slice ---`;
}

function assistedFinalPrompt({ reason, pct }) {
  const why = reason === 'owner' ? 'The owner asked for a compression.' : reason === 'agent' ? 'You asked for a compression.' : `Your working context reached ${pct}% of its window.`;
  return `[Context compression, final step, from the hub] ${why} Your Records are up to date from the slices you just processed. Now write the Record "${BRIEF_FILE}" with record_write, using exactly this template and filling every section from your Records and what you remember (write "none" where a section is empty):

${BRIEF_TEMPLATE}

After you reply, the hub starts you fresh: your Records (this brief included) and the most recent turns are loaded for you, and recall finds everything older. Reply "brief written" plus one line on anything you left to recall.`;
}

const MIN_BRIEF_BYTES = 400;
const RESUME_PROMPT = `[Resumed after compression, from the hub] Your previous session was closed after you wrote your working brief. Your Records (the brief included) and your most recent turns are in front of you; recall finds anything older. In four to six short lines, tell the owner what you are in the middle of and what you will do next. Ask nothing, use no tools, then wait for them.`;

function createCompaction({ now = Date.now, log = console.log, post, resetSession, getAgent, getSetting = () => undefined, onEvent = null,
  getRecentRows = null, chunkCharsFor = null, briefStatus = null, resumeAfterReset = true, file = STATE_FILE, persist = true } = {}) {
  const state = new Map();   // agent -> { tokens, limit, pct, sessionId, lastRunAt, lastRunSession, compactedAt, running, requested, ... }

  // Durable bits survive a restart: when an agent was last compressed (the gateway recent window starts there).
  if (persist) { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); for (const [k, v] of Object.entries(j || {})) state.set(k, { ...v, running: false, requested: null }); } catch {} }
  function save() {
    if (!persist) return;
    try {
      const out = {};
      for (const [k, v] of state) out[k] = { lastRunAt: v.lastRunAt || null, lastRunSession: v.lastRunSession || null, compactedAt: v.compactedAt || null, lastReason: v.lastReason || null, lastMode: v.lastMode || null, lastReset: !!v.lastReset, lastOk: v.lastOk !== false, lastError: v.lastError || null };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(out, null, 2));
    } catch {}
  }

  function emit(type, data) { if (onEvent) { try { onEvent({ type, ...data }); } catch {} } }

  function settingsFor(agentName) {
    let rec = null; try { rec = getAgent ? getAgent(agentName) : null; } catch {}
    const local = !!(rec && LOCAL_RE.test(String(rec.model || '')));
    const c = (rec && rec.compaction) || {};
    const settingMode = getSetting('compactionMode');
    const mode = MODES.includes(c.mode) ? c.mode : MODES.includes(settingMode) ? settingMode : (local ? LOCAL_MODE : DEFAULT_MODE);
    let at = Number(c.at); if (!(at > 0 && at < 1)) { at = Number(getSetting('compactionAt')); if (!(at > 0 && at < 1)) at = local ? LOCAL_AT : DEFAULT_AT; }
    return { mode, at, local, model: rec ? rec.model || null : null };
  }

  function get(agentName) {
    const s = state.get(agentName) || { tokens: 0, limit: 0, pct: 0, sessionId: null, lastRunAt: null, lastRunSession: null, compactedAt: null, running: false, requested: null };
    return { agent: agentName, ...s, ...settingsFor(agentName), briefFile: BRIEF_FILE };
  }
  /** When this agent was last compressed (ISO) or null: the gateway recent window starts here. */
  function compactedAt(agentName) { const s = state.get(agentName); return s && s.compactedAt ? s.compactedAt : null; }

  /** Called at the end of every provider turn with the context size the provider reported or the hub estimated. */
  function noteUsage(agentName, tokens, limit, sessionId = null) {
    const s = state.get(agentName) || {};
    const t = Number(tokens) || 0; const l = Number(limit) || 0;
    const pct = l ? Math.round((t / l) * 100) : 0;
    state.set(agentName, { ...s, tokens: t, limit: l, pct, sessionId: sessionId || s.sessionId || null });
    const { mode, at } = settingsFor(agentName);
    const due = mode !== 'off' && l > 0 && t >= at * l;
    const requested = !!s.requested;
    if (!due && !requested) return null;
    return maybeRun(agentName, requested ? s.requested : 'threshold');
  }

  /** The agent asked (compress_context tool) or the owner pressed the button: run after the current turn. */
  function request(agentName, reason = 'agent') {
    const s = state.get(agentName) || {};
    state.set(agentName, { ...s, requested: reason });
    const { mode } = settingsFor(agentName);
    if (mode === 'off') return `Context compression is OFF for you (the owner can switch it to dry run, on or assisted in your settings). Nothing will happen.`;
    if (mode === 'dry') return `Noted. Your compression turn runs as soon as this turn ends (dry run: your session stays as it is; the owner reads your brief first).`;
    return `Noted. Your compression runs as soon as this turn ends${mode === 'assisted' ? ' (in slices sized to your window)' : ''}, and then you resume fresh, seeded with your Records and the recent turns.`;
  }

  function maybeRun(agentName, reason) {
    const s = state.get(agentName) || {};
    if (s.running) return null;
    const { mode } = settingsFor(agentName);
    if (mode === 'off') { state.set(agentName, { ...s, requested: null }); return null; }
    if (reason === 'threshold') {
      if (s.lastRunSession && s.sessionId && s.lastRunSession === s.sessionId && mode === 'dry') return null;   // dry run already written for this session
      if (s.lastRunAt && now() - s.lastRunAt < MIN_GAP_MS) return null;
    }
    return run(agentName, reason);
  }

  /** run(agent, reason) -> Promise<{ ok, mode, reset, reply, parts }>. Runs the agent's compression turn(s); resets only in modes on / assisted. */
  async function run(agentName, reason = 'owner') {
    const s = state.get(agentName) || {};
    if (s.running) return { ok: false, error: 'already running' };
    const { mode } = settingsFor(agentName);
    if (mode === 'off' && reason !== 'owner') return { ok: false, error: 'compression is off for this agent' };
    const effMode = mode === 'off' ? 'dry' : mode;   // an owner's manual press on an 'off' agent is a dry run
    state.set(agentName, { ...s, running: true, requested: null });
    const runStartedAt = now();
    log(`[compaction] ${agentName}: compression (${effMode}, ${reason}, context ${s.pct || 0}%)`);
    emit('compaction_start', { agent: agentName, mode: effMode, reason, pct: s.pct || 0 });
    let reply = ''; let ok = true; let error = null; let parts = 0;
    try {
      if (effMode === 'assisted') {
        // Slices sized to the model's window; the agent extracts from each, then writes the brief from its Records.
        const rows = getRecentRows ? await getRecentRows(agentName, { since: s.compactedAt || null }) : [];
        const chunkChars = Math.max(2000, chunkCharsFor ? await chunkCharsFor(agentName) : 12000);
        const chunks = require('./context-budget').chunkRows(rows, chunkChars);
        parts = chunks.length;
        for (let i = 0; i < chunks.length; i++) {
          emit('compaction_progress', { agent: agentName, part: i + 1, parts: chunks.length });
          await post(agentName, assistedPartPrompt({ i: i + 1, n: chunks.length, chunk: chunks[i] }));
        }
        reply = String(await post(agentName, assistedFinalPrompt({ reason, pct: s.pct || 0 })) || '');
      } else {
        reply = String(await post(agentName, compressionPrompt({ agent: agentName, pct: s.pct || 0, mode: effMode, reason })) || '');
      }
    } catch (e) { ok = false; error = e.message; }
    let reset = false; let resumed = null;
    if (ok && (effMode === 'on' || effMode === 'assisted')) {
      // Safety: never close a session unless the agent actually wrote its brief during this run.
      let brief = null; try { brief = briefStatus ? await briefStatus(agentName) : null; } catch {}
      if (briefStatus && !(brief && brief.exists && brief.bytes >= MIN_BRIEF_BYTES && brief.mtimeMs >= runStartedAt - 5000)) {
        ok = false; error = `brief not written (${brief && brief.exists ? `${brief.bytes} bytes, last changed ${new Date(brief.mtimeMs).toISOString()}` : 'missing'}); session kept`;
        log(`[compaction] ${agentName}: ${error}`);
      } else {
        try { await resetSession(agentName); reset = true; log(`[compaction] ${agentName}: session reset; next turn starts fresh from Records + archive`); }
        catch (e) { ok = false; error = `reset failed: ${e.message}`; }
      }
      // The first words after a rollover go into the chat, so the owner can see at once whether the agent came back coherent.
      if (reset && resumeAfterReset) {
        try { resumed = String(await post(agentName, RESUME_PROMPT) || '').slice(0, 2000); emit('compaction_resumed', { agent: agentName, reply: resumed.slice(0, 600) }); }
        catch (e) { log(`[compaction] ${agentName}: resume turn failed: ${e.message}`); }
      }
    }
    const after = state.get(agentName) || {};
    const ts = new Date(now()).toISOString();
    state.set(agentName, { ...after, running: false, lastRunAt: now(), lastRunSession: after.sessionId || s.sessionId || null, lastReason: reason, lastMode: effMode, lastReset: reset, lastOk: ok, lastError: error, lastParts: parts,
      ...(reset ? { tokens: 0, pct: 0, sessionId: null, compactedAt: ts } : {}) });
    save();
    emit('compaction_end', { agent: agentName, mode: effMode, reason, ok, reset, error, parts });
    return { ok, mode: effMode, reset, reply, error, parts, resumed };
  }

  return { get, noteUsage, request, run, settingsFor, compactedAt, compressionPrompt, assistedPartPrompt, assistedFinalPrompt, BRIEF_FILE, BRIEF_TEMPLATE, DEFAULT_AT, DEFAULT_MODE, MODES };
}

let shared = null;
function getCompaction(opts) { if (!shared) shared = createCompaction(opts); return shared; }

module.exports = { createCompaction, getCompaction, compressionPrompt, assistedPartPrompt, assistedFinalPrompt, BRIEF_FILE, BRIEF_TEMPLATE, DEFAULT_AT, DEFAULT_MODE, LOCAL_AT, LOCAL_MODE, MIN_GAP_MS, MODES, MIN_BRIEF_BYTES, RESUME_PROMPT };
