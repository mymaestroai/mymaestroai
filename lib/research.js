'use strict';
// Deep research: the tool's spec, the ask card, the decision (stored choice or the person's answer), the helper-model
// choice, the briefs for the temporary workers, the message the agent is woken with, and the background runner.

const crypto = require('crypto');
const { billingOf } = require('./billing');

const TOOL = {
  name: 'deep_research',
  description: 'Deep research: a background run that searches widely, reads the actual sources and returns a verdict with evidence, dates and citations. When a question warrants it (the current state of a field, comparisons, what is best or most effective, recent findings, a decision that needs evidence), call this with action "offer" BEFORE answering; it asks the person (or uses the choice they stored) and tells you what to do. Never for simple facts or quick lookups. After a yes, call it with action "start", the question and your sub_questions. When the person tells you to turn deep research back on, off, or always on, call it with action "set" and choice ask, never or always.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['offer', 'start', 'set'], description: 'offer: before answering a question that warrants research (the hub asks the person or uses their stored choice). start: after the person said yes: runs the research in the background. set: the person asked to change their choice.' },
      question: { type: 'string', description: 'For offer and start: the research question, complete and self-contained' },
      sub_questions: { type: 'array', items: { type: 'string' }, description: 'For start: 2 to 8 sub-questions that together answer the question' },
      choice: { type: 'string', enum: ['ask', 'always', 'never'], description: 'For set: ask (back on: ask each time), always, or never' },
    },
    required: ['action'],
  },
};

// The one line a person who chose Never gets now and then (at most once per reminder interval).
const REMIND_LINE = 'Deep research is off for you; this question could use it. Say "turn deep research back on" or switch it in Settings.';

function costLine(model) {
  const b = billingOf(model);
  if (b.kind === 'subscription') return `Uses your ${b.via} plan allowance: several times a normal answer.`;
  if (b.kind === 'api') return 'Pay-per-use: costs several times a normal answer (many searches and pages read).';
  if (b.kind === 'local') return "Runs on this computer's own model: no cost, but slower.";
  return 'Costs several times a normal answer.';
}

function cardFor(model) {
  return {
    header: 'Deep research',
    question: 'This looks like a research question. Do a deep research run (a few minutes, many sources)? ' + costLine(model),
    options: ['Yes', 'No', 'Always yes', 'Never'],
    descriptions: [
      'Research it now, in the background; you can keep talking meanwhile.',
      'Answer now from what I know and a quick search.',
      'Research questions like this without asking. You can change this in Settings.',
      'Never ask; always answer normally. You can change this in Settings.',
    ],
    allow_skip: true,
  };
}

async function decide({ choice, canAsk, ask, store, personKey, remindDue = false } = {}) {
  if (choice === 'always') return { run: true, by: 'always' };
  if (choice === 'never') {
    if (!remindDue) return { run: false, by: 'never' };
    try { store.markReminded(personKey); } catch { /* the line is still given; the next one may come sooner */ }
    return { run: false, by: 'never-remind' };
  }
  if (!canAsk) return { run: false, by: 'no-one-to-ask' };
  let answer;
  try { answer = await ask(); } catch { return { run: false, by: 'no-answer' }; }
  const raw = typeof answer === 'string' ? answer : '';
  const a = raw.trim().toLowerCase();
  const save = (value) => {
    try { store.setChoice(personKey, value); return {}; } catch { return { saved: false }; }
  };
  if (a === 'yes') return { run: true, by: 'yes' };
  if (a === 'always yes' || a === 'always' || a === 'yes always') return { run: true, by: 'always-now', ...save('always') };
  if (a === 'never' || a === 'no always' || a === 'never ask') return { run: false, by: 'never-now', ...save('never') };
  if (a === 'no') return { run: false, by: 'no' };
  if (a === 'skipped' || a === 'no_answer' || a === '') return { run: false, by: 'no-answer' };
  return { run: false, by: 'typed', text: raw.trim().slice(0, 300) };
}

function offerText(decision) {
  const d = decision || {};
  // a stored choice that could not be saved: honoured now, said plainly (review r1)
  const unsaved = d.saved === false ? ' Their choice could not be saved, so they may be asked again; say so in one line.' : '';
  switch (d.by) {
    case 'always': case 'yes': case 'always-now':
      return 'The person wants a deep research run' + (d.by === 'always-now' && !unsaved ? ' (and from now on without being asked)' : d.by === 'always' ? ' (they chose always)' : '')
        + '. Plan 2 to 8 sub-questions that together answer it, then call deep_research with action "start", the same question and sub_questions. It runs in the background: tell the person in one line that it has started and that the report will appear here, then carry on with the conversation.' + unsaved;
    case 'never':
      return 'The person chose never to be asked about deep research. Answer normally (what you know, plus a quick search if needed). Do not offer research.';
    case 'never-remind':
      return `The person turned deep research off (Never). Answer normally (what you know, plus a quick search if needed), then end your reply with this one line, word for word, and nothing else about it: ${REMIND_LINE}`;
    case 'never-now':
      return unsaved ? 'The person said never. Answer normally now.' + unsaved : 'The person said never: they will not be asked again. Answer normally now.';
    case 'no':
      return 'The person said no to deep research this time. Answer normally now.';
    case 'no-one-to-ask':
      return 'No one can be asked right now (this turn was not started by the person). Answer normally, and end with one line offering a deep research run if they want one.';
    case 'typed':
      return `The person typed "${d.text}" instead of choosing. That is not a yes: answer normally now. If their words ask for research, call deep_research with action "offer" again so they can choose Yes.`;
    case 'no-answer':
    default:
      return 'No answer came. Answer normally, and offer a deep research run in one line at the end.';
  }
}

/** The tool's result for action "set" (the person asked to change their choice); ok false: it could not be changed. */
function setText(choice, ok = true) {
  if (!ok) return 'That could not be changed here: only the person can change it, in a conversation they started, or in Settings.';
  if (choice === 'ask') return 'Done: deep research is back on. The person will be asked when a question could use it. Tell them in one line.';
  if (choice === 'always') return 'Done: research questions now get a deep research run without asking. Tell them in one line.';
  if (choice === 'never') return 'Done: deep research is off for the person; they will not be asked (only reminded now and then that it is off). Tell them in one line.';
  return 'Say which: choice must be ask, always or never.';
}

const HELPER_NOTE = /fast and cheap|fast, cheap|small model/i;

function chooseHelperModel({ ownModel, allowed, noteOf } = {}) {
  const own = billingOf(ownModel);
  const prefix = (m) => (String(m).includes('/') ? String(m).split('/')[0] : '');
  const candidates = (Array.isArray(allowed) ? allowed : []).filter((m) => {
    if (typeof m !== 'string' || !m) return false;
    let note = '';
    try { note = String(noteOf ? noteOf(m) : '') || ''; } catch { note = ''; }
    if (!HELPER_NOTE.test(note)) return false;
    return billingOf(m).kind !== 'local' || own.kind === 'local';
  });
  const sameKind = candidates.filter((m) => billingOf(m).kind === own.kind);
  const pick = sameKind.find((m) => prefix(m) === prefix(ownModel))
    || sameKind[0]
    || (own.kind === 'api' ? candidates.find((m) => billingOf(m).kind === 'api') : undefined);
  return pick || ownModel;
}

function helperBrief(question, sub) {
  return `Research task. The overall question is: ${question}\n\nYour part is this sub-question: ${sub}\n\n`
    + 'Search widely: several different searches with different wordings. Open and read the actual sources (papers, benchmark and leaderboard pages, official documentation, reputable reviews), not just search snippets; prefer primary and recent sources. For each finding give the claim, the source\'s title and URL, its date, and how strong the evidence is. Note where sources disagree. Say what you could not find. End with a list headed SOURCES READ: one line per source you actually opened, with its URL. At most about 700 words.';
}

const FINDINGS_MAX = 60000;

function synthesisBrief(question, subs, findings) {
  const list = (Array.isArray(subs) ? subs : []).map((s, i) => `${i + 1}. ${s}`).join('\n');
  let text = String(findings == null ? '' : findings);
  if (text.length > FINDINGS_MAX) text = text.slice(0, FINDINGS_MAX) + '\n[cut]';
  return `Research question: ${question}\n\nSub-questions:\n${list}\n\nFindings from the helpers:\n${text}\n\n`
    + 'Cross-check the claims across sources; when two sources disagree on something that matters, open them again. Then write the report in this order: **Verdict** (2 to 4 sentences: the direct answer), **Evidence** (bullets, each with the source title, URL and date), **Where sources disagree**, **Confidence** (high, medium or low, and why), **Sources** (numbered, only sources actually read, and how many). Plain words; no filler.';
}

// failed: falsy for a finished run, otherwise the reason (a string) the run did not finish.
function reportMessage({ id, question, report, failed } = {}) {
  const q = String(question == null ? '' : question).slice(0, 200);
  if (failed) {
    return `[Deep research failed] "${q}" (id ${id}): ${failed === true ? 'unknown reason' : failed}.\n\n`
      + 'Tell the person in one or two lines that the research run did not finish and why, and offer to answer from what you know or to try again.';
  }
  return `[Deep research finished] "${q}" (id ${id}).\n\n`
    + 'The research run finished. Present its report to the person now: the verdict first, then the evidence with its links and dates, where sources disagree, and how confident it is. Keep every link. The person asked for this: call for_owner once with requested: true and the reason "Deep research report ready". This is the research run\'s result, not a message from the person.\n\n'
    + `Report:\n${report}`;
}

function createResearchRunner(deps = {}) {
  const {
    spawn, wake, pickHelperModel, ownModelOf,
    now = Date.now, log = console.log, retryMs = 30000, maxWakeTries = 40,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRunning = 3,
    store = null,   // { load() -> runs[], save(runs[]) }: runs survive a restart so a cut-short run is reported, never lost
    keepMs = 24 * 3600 * 1000,
    slowRetryMs = 10 * 60 * 1000, slowTries = 0,   // after the fast tries: slower tries, so a busy agent still gets its report
    deadlineMs = 30 * 60 * 1000,   // a run that takes longer is ended and reported as not finished
    keepUndeliveredMs = 7 * 24 * 3600 * 1000,   // a report that could not be delivered is kept this long in the saved runs
    stampOf = null,   // (agent) -> identity stamp, null when no such agent, throws when it can't be told; when given, a
                      // run works and reports only for the agent that started it
  } = deps;
  const runs = new Map();
  // 'same' | 'other' (gone, or the name now belongs to another agent) | 'unknown' (the lookup failed: can't tell now)
  function whoNow(run) {
    if (!stampOf) return 'same';
    let s;
    try { s = stampOf(run.agent) || null; } catch { return 'unknown'; }
    return run.stamp && s === run.stamp ? 'same' : 'other';
  }
  const REPLACED = 'the agent it was for is gone or was replaced';
  const isActive = (r) => r.state === 'running' || r.state === 'delivering';
  const copy = (r) => ({ ...r, subQuestions: [...r.subQuestions] });
  function persist() {
    if (!store) return;
    try { store.save([...runs.values()].map(copy)); } catch (e) { try { log(`[research] could not save runs: ${e && e.message}`); } catch { /* ignore */ } }
  }
  function prune() {
    const t = now();
    for (const [id, r] of runs) {
      if (isActive(r)) continue;
      const keep = r.state === 'failed' && r.message ? keepUndeliveredMs : keepMs;
      if ((r.endedAt || r.startedAt) < t - keep) runs.delete(id);
    }
  }
  /** What the workers gave: [{ label, ok, text }]. A refusal string throws; a plain string (a stand-in) is one result. */
  function outcomes(res) {
    if (typeof res === 'string') {
      if (res.startsWith('[spawn_workers]')) throw new Error(res.slice(0, 300));
      return [{ label: '', ok: !!res.trim(), text: res }];
    }
    if (!Array.isArray(res)) throw new Error('the workers gave no result');
    // a placeholder (no reply, an empty one, a stopped call) is not a result (review r2)
    const placeholder = /^\((no response|empty reply|stopped by user)\)$/i;
    return res.map((r) => {
      const text = String((r && r.text) || '');
      return { label: String((r && r.label) || ''), ok: !!(r && r.ok) && !placeholder.test(text.trim()), text };
    });
  }
  const undelivered = (r) => r.state === 'failed' && typeof r.message === 'string' && !!r.message;
  // Runs saved before a restart: an unfinished one is reported as cut short by recover(); a report not yet delivered
  // (still trying, or given up before the restart) is tried again.
  let cutShort = [];
  if (store) {
    let saved = [];
    try { saved = store.load() || []; } catch { saved = []; }
    for (const r of Array.isArray(saved) ? saved : []) {
      if (!r || typeof r.id !== 'string' || typeof r.agent !== 'string' || !Array.isArray(r.subQuestions)) continue;
      runs.set(r.id, { ...r });
      if (isActive(r) || undelivered(r)) cutShort.push(r.id);
    }
    prune();
  }

  /** After a restart: a run whose report was ready is delivered again from the saved copy; one still researching is
   *  reported as cut short. */
  function recover() {
    const ids = cutShort; cutShort = [];
    for (const id of ids) {
      const run = runs.get(id);
      if (!run || !(isActive(run) || undelivered(run))) continue;
      const message = typeof run.message === 'string' && run.message
        ? run.message
        : reportMessage({ id: run.id, question: run.question, failed: 'your Maestro restarted while it ran, so it was cut short' });
      run.message = message;
      deliver(run, message).catch(() => {});
    }
  }

  function start({ agent, question, subQuestions } = {}) {
    if (typeof agent !== 'string' || !agent) return { ok: false, error: 'No agent was given for the research run.' };
    const q = typeof question === 'string' ? question.trim() : '';
    if (q.length < 1 || q.length > 2000) return { ok: false, error: 'The question must be 1 to 2000 characters.' };
    if (!Array.isArray(subQuestions)) return { ok: false, error: 'sub_questions must be a list of 2 to 8 sub-questions.' };
    const subs = [];
    for (const s of subQuestions) {
      if (typeof s !== 'string') continue;
      const t = s.trim();
      if (t && !subs.includes(t)) subs.push(t);
    }
    if (subs.length < 2 || subs.length > 8) return { ok: false, error: 'Give 2 to 8 different sub-questions that together answer the question.' };
    if (subs.some((s) => s.length > 500)) return { ok: false, error: 'Each sub-question must be at most 500 characters.' };
    const all = [...runs.values()].filter(isActive);
    if (all.some((r) => r.agent === agent)) return { ok: false, error: 'A research run for this question is already under way for you; its report will come here.' };
    if (all.length >= maxRunning) return { ok: false, error: 'Too many research runs are under way right now; try again in a few minutes.' };
    prune();
    let id;
    do { id = 'dr-' + crypto.randomBytes(4).toString('hex'); } while (runs.has(id));
    // stamp: who the agent is now (lib/agents agentIdentity); the run works and reports only for that same agent
    // (reviews r3, r4). Not started when that can't be told: its report could never be delivered.
    let stamp = null;
    if (stampOf) {
      try { stamp = stampOf(agent) || null; } catch { return { ok: false, error: 'Could not confirm which agent this is right now; try again in a minute.' }; }
      if (!stamp) return { ok: false, error: 'No such agent.' };
    }
    const run = { id, agent, stamp, question: q, subQuestions: subs, state: 'running', startedAt: now(), endedAt: null, error: null };
    runs.set(id, run);
    persist();
    setImmediate(() => { execute(run).catch((e) => { try { log(`[research] ${id}: ${e && e.message}`); } catch { /* ignore */ } run.state = 'failed'; run.error = String(e && e.message || e); run.endedAt = now(); persist(); }); });
    return { ok: true, id };
  }

  /** Wakes the agent with the message (saved with the run first), again every retryMs while it is busy (maxWakeTries
   *  tries), then every slowRetryMs (slowTries more). Given up: the run is failed and keeps the message in the saved runs. */
  async function deliver(run, message) {
    run.state = 'delivering';
    run.message = message;
    persist();
    let last = null;
    const total = maxWakeTries + Math.max(0, slowTries);
    for (let i = 0; i < total; i++) {
      // the agent it was for is gone, or its name now belongs to another agent: never delivered elsewhere, and dropped.
      // A lookup that failed is not proof of that: the report is kept and tried again (review r4).
      const who = whoNow(run);
      if (who === 'other') {
        run.state = 'failed'; run.message = null; run.endedAt = now();
        run.error = REPLACED + '; the report was not delivered';
        persist();
        try { log(`[research] ${run.id} for ${run.agent}: ${run.error}`); } catch { /* ignore */ }
        return;
      }
      if (who === 'unknown') last = new Error('could not confirm the agent it was for');
      else {
        try { await wake(run.agent, message); run.state = 'delivered'; run.endedAt = now(); run.message = null; persist(); return; } catch (e) { last = e; }
      }
      if (/refused the wake-up turn \(404|no such agent/i.test(String((last && last.message) || last))) break;   // the agent is gone: no point trying for a day
      if (i < total - 1) await sleep(i < maxWakeTries - 1 ? retryMs : slowRetryMs);
    }
    run.state = 'failed';
    run.error = `the report could not be delivered: ${(last && last.message) || last}`;
    run.endedAt = now();
    persist();
    try { log(`[research] ${run.id} for ${run.agent}: ${run.error} (kept in the saved runs)`); } catch { /* ignore */ }
  }

  async function research(run, signal) {
    // nothing is sent after the deadline (review r2), nor for an agent that was replaced or can't be confirmed (review r4)
    const over = () => {
      if (signal && signal.aborted) throw new Error('the run was ended');
      const who = whoNow(run);
      if (who === 'other') throw new Error(REPLACED);
      if (who === 'unknown') throw new Error('could not confirm the agent it was for');
    };
    // and asked again by the launcher as each worker is about to start, after its own waits (review r5)
    const admit = () => !(signal && signal.aborted) && whoNow(run) === 'same';
    const helper = await pickHelperModel(run.agent);
    const own = await ownModelOf(run.agent);
    over();
    const h = outcomes(await spawn(run.agent, run.subQuestions.map((s, i) => ({ task: helperBrief(run.question, s), model: helper, tools: 'read', label: `Research ${i + 1}` })), signal, { admit }));
    const good = h.filter((x) => x.ok && x.text.trim());
    if (!good.length) throw new Error('none of the helpers finished' + (h[0] && h[0].text ? `: ${h[0].text.slice(0, 200)}` : ''));
    const findings = good.map((x) => (x.label ? `### ${x.label}\n` : '') + x.text.trim()).join('\n\n')
      + (good.length < h.length ? `\n\n(${h.length - good.length} of ${h.length} helpers did not finish; their parts are missing.)` : '');
    over();
    const s = outcomes(await spawn(run.agent, [{ task: synthesisBrief(run.question, run.subQuestions, findings), model: own, tools: 'read', label: 'Research summary' }], signal, { admit }))[0];
    if (!s || !s.text.trim()) throw new Error('the research run produced no report');
    if (!s.ok) throw new Error('the summary did not finish: ' + s.text.slice(0, 200));
    return s.text.trim();
  }

  async function execute(run) {
    let message;
    const ac = new AbortController();
    let timer = null;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { try { ac.abort(); } catch { /* ignore */ } reject(new Error(`it took longer than ${Math.round(deadlineMs / 60000)} minutes`)); }, deadlineMs);
        if (timer && timer.unref) timer.unref();
      });
      const report = await Promise.race([research(run, ac.signal), deadline]);
      message = reportMessage({ id: run.id, question: run.question, report });
    } catch (e) {
      const reason = String((e && e.message) || e || 'unknown error').slice(0, 300);
      message = reportMessage({ id: run.id, question: run.question, failed: reason });
    } finally { if (timer) clearTimeout(timer); }
    await deliver(run, message);
  }

  return {
    start,
    recover,
    list: () => [...runs.values()].map(copy),
    get: (id) => (runs.has(id) ? copy(runs.get(id)) : null),
  };
}

module.exports = { TOOL, REMIND_LINE, costLine, cardFor, decide, offerText, setText, chooseHelperModel, helperBrief, synthesisBrief, reportMessage, createResearchRunner };
