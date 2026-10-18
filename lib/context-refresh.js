'use strict';
/**
 * context-refresh: keeps resumed Claude-client sessions current.
 *
 * The Claude client keeps the system prompt it was given when a session STARTED; on a resumed session the hub's
 * fresh systemPrompt.append is not applied. So an agent never saw a Records, SOUL, memory or settings change made
 * after its session began (verified: a canary Record added to a resumed session was invisible; the reported
 * system-prompt size did not move). This module remembers, per agent and session, the context text the session
 * has actually received, and on each resumed turn returns a <hub_context_update> block with only what changed,
 * to send at the top of the user message. Unchanged turns cost nothing.
 *
 * Granularity: the context is split on the hub's section divider ("\n\n---\n\n"); the Records section is split
 * further per record ("### <name>"). A changed section whose new text extends the old one is sent as the
 * appended part only (an agent appending to its own log does not get the whole file back each turn).
 * State: data/context-refresh/<agent>.json { sessionId, sections: { key: text }, at }.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIVIDER = '\n\n---\n\n';
const DEFAULT_MAX_CHARS = 400000;

/** Split a context string into an ordered list of [key, text]. Keys are stable across turns. */
function splitSections(text) {
  const out = [];
  const seen = new Map();
  const add = (key, body) => {
    const n = (seen.get(key) || 0) + 1; seen.set(key, n);
    out.push([n > 1 ? `${key} (${n})` : key, body]);
  };
  for (const raw of String(text || '').split(DIVIDER)) {
    const sec = raw.trim();
    if (!sec) continue;
    const first = sec.split('\n', 1)[0].trim().slice(0, 120) || '(untitled)';
    if (/^# Records\b/.test(first)) {
      const parts = sec.split(/\n\n(?=### )/);
      add('Records', parts[0]);
      for (const p of parts.slice(1)) add(`Records › ${p.split('\n', 1)[0].replace(/^###\s*/, '').trim()}`, p);
    } else add(first, sec);
  }
  return out;
}

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

function createContextRefresh({ dir = path.join(__dirname, '..', 'data', 'context-refresh'), maxChars = DEFAULT_MAX_CHARS, log = () => {} } = {}) {
  const file = (agent) => path.join(dir, `${String(agent).replace(/[^a-z0-9_-]/gi, '_')}.json`);
  function load(agent) { try { return JSON.parse(fs.readFileSync(file(agent), 'utf8')); } catch { return null; } }
  function save(agent, state) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const f = file(agent); const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, f);
  }

  /**
   * plan({ agent, sessionId, resumed, context }) -> { block: string|null, commit(sessionId) , summary }
   * Call before the turn; call commit(sessionId) once the turn has gone through (the session id is known by then).
   * A fresh session receives the whole context as its system prompt, so it needs no block, only a baseline.
   */
  function plan({ agent, sessionId = null, resumed = false, context = '' }) {
    const cur = splitSections(context);
    const curMap = Object.fromEntries(cur);
    const commit = (sid) => {
      try { save(agent, { sessionId: sid || sessionId || null, sections: curMap, at: new Date().toISOString() }); }
      catch (e) { log(`[context-refresh] ${agent}: could not save state: ${e.message}`); }
    };
    if (!resumed) return { block: null, commit, summary: 'fresh session' };

    const state = load(agent);
    const known = state && state.sessionId && state.sessionId === sessionId ? state.sections || {} : null;
    const changed = []; const removed = [];
    if (!known) {
      // A session that began before this module (or before its state was kept): its view is unknown, so it gets
      // the full current context once.
      for (const [k, t] of cur) changed.push({ key: k, text: t, kind: 'current' });
    } else {
      for (const [k, t] of cur) {
        const old = known[k];
        if (old === undefined) changed.push({ key: k, text: t, kind: 'new' });
        else if (old !== t) {
          if (t.startsWith(old) && t.length > old.length) changed.push({ key: k, text: t.slice(old.length).replace(/^\n+/, ''), kind: 'appended' });
          else changed.push({ key: k, text: t, kind: 'changed' });
        }
      }
      for (const k of Object.keys(known)) if (!(k in curMap)) removed.push(k);
    }
    if (!changed.length && !removed.length) return { block: null, commit, summary: 'unchanged' };

    const head = known
      ? 'Parts of your instructions, memory or Records changed since this conversation began. The system prompt you were given at its start is NOT refreshed, so the text below is authoritative: it replaces (or, where marked "appended", extends) the same sections you were given earlier.'
      : 'This is the CURRENT version of your full instructions, memory and Records. The system prompt you were given when this conversation began may be out of date; where they differ, this text wins.';
    const body = [];
    let size = 0; const skipped = [];
    for (const c of changed) {
      const label = c.kind === 'appended' ? `${c.key} (appended since you last saw it)` : c.kind === 'new' ? `${c.key} (new)` : c.kind === 'changed' ? `${c.key} (changed; full current text)` : c.key;
      const piece = `## ${label}\n${c.text}`;
      if (size + piece.length > maxChars) { skipped.push(c.key); continue; }
      body.push(piece); size += piece.length;
    }
    if (removed.length) body.push(`## Removed since you last saw them\n${removed.map(k => `- ${k}`).join('\n')}`);
    if (skipped.length) body.push(`## Too large to include here\n${skipped.map(k => `- ${k}`).join('\n')}\nRead those files from your workspace (records/ folder for Records) before relying on them.`);
    const block = `<hub_context_update>\n${head}\n\n${body.join('\n\n')}\n</hub_context_update>\n\n`;
    const summary = `${known ? 'update' : 'full refresh'}: ${changed.length} section(s) ${changed.map(c => `${c.key}[${c.kind}]`).slice(0, 8).join(', ')}${changed.length > 8 ? '…' : ''}${removed.length ? `; removed ${removed.length}` : ''}; ${block.length.toLocaleString()} chars`;
    return { block, commit, summary };
  }

  function forget(agent) { try { fs.unlinkSync(file(agent)); } catch {} }

  return { plan, forget, load };
}

let singleton = null;
function getContextRefresh() { if (!singleton) singleton = createContextRefresh({ log: (...a) => console.log(...a) }); return singleton; }

module.exports = { createContextRefresh, getContextRefresh, splitSections, digest, DIVIDER };
