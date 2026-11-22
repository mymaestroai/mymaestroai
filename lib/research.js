'use strict';
// Deep research: the tool's spec, the ask card, the decision (stored choice or the person's answer), the helper-model
// choice, the briefs for the temporary workers, the message the agent is woken with, and the background runner.

const crypto = require('crypto');
const { billingOf } = require('./billing');
const fs = require('fs');
const path = require('path');
const T = require('./research-thorough');
const Lead = require('./research-lead');

const TOOL = {
  name: 'deep_research',
  description: 'Deep research: a background run that searches widely, reads the actual sources and returns a verdict with evidence, dates and citations. When a question warrants it (the current state of a field, comparisons, what is best or most effective, recent findings, a decision that needs evidence), call this with action "offer" BEFORE answering; it asks the person (or uses the choice they stored) and tells you what to do. Never for simple facts or quick lookups. After a yes, call it with action "start", the question, your sub_questions and the level the person chose. There are two levels: quick (a few minutes, many searches, results summarised) and thorough (also reads the key sources in full and checks every figure against them; takes up to an hour). Never start thorough unless the person chose it. When you offer, recommend thorough only when a question needs primary-source depth (method details, exact figures, a decision with consequences); the person decides. When the person tells you to turn deep research back on, off, or always on, call it with action "set" and choice ask, never or always.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['offer', 'start', 'set'], description: 'offer: before answering a question that warrants research (the hub asks the person or uses their stored choice). start: after the person said yes: runs the research in the background. set: the person asked to change their choice.' },
      question: { type: 'string', description: 'For offer and start: the research question, complete and self-contained' },
      sub_questions: { type: 'array', items: { type: 'string' }, description: 'For start: 2 to 8 sub-questions that together answer the question' },
      choice: { type: 'string', enum: ['ask', 'always', 'never'], description: 'For set: ask (back on: ask each time), always, or never' },
      level: { type: 'string', enum: ['quick', 'thorough'], description: 'For start: the level the person chose (default: the level they approved)' },
      recommend: { type: 'string', enum: ['quick', 'thorough'], description: 'For offer, optional: the level you suggest to the person; the person decides' },
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

const LEVELS = ['quick', 'thorough'];
const levelName = (l) => (l === 'thorough' ? 'Thorough' : 'Quick');

/** The cost sentence for the card, which offers both levels. */
function levelsCostLine(model, engine) {
  const b = billingOf(model);
  const pipeline = engine === 'pipeline';
  if (b.kind === 'subscription') return `Both use your ${b.via} plan allowance; Thorough uses several times more than Quick.`;
  if (b.kind === 'api') return pipeline ? 'Pay-per-use: Quick costs several times a normal answer; Thorough costs much more (it reads whole papers and pages and has them checked).' : 'Pay-per-use: Quick costs several times a normal answer; Thorough costs much more (a lead model reads the key sources in full and has the report reviewed).';
  if (b.kind === 'local') return pipeline ? "Both run on this computer's own model: no cost, but Thorough can take well over an hour." : "Both run on this computer's own model: no cost, but Thorough can take several hours.";
  return 'Thorough costs several times more than Quick.';
}

// "an hour" for 60 minutes, whole hours as hours, else minutes
function limitPhrase(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m <= 0 || m === 60) return 'an hour';
  if (m % 60 === 0) return `${m / 60} hours`;
  return `${Math.round(m)} minutes`;
}

// engine: the Thorough engine of the settings ('pipeline' keeps the earlier wording and its time limit, timeLimitMinutes; anything else is the lead).
// thoroughCost: the lead's cost line on pay-per-use models (lib/research-lead leadCostLine); thoroughHours: its time ceiling in hours.
function cardFor(model, { recommend, alwaysLevel, thoroughCost = '', thoroughHours = 6, engine, timeLimitMinutes } = {}) {
  const mark = (level, text) => (recommend === level ? text + ' Recommended.' : text);
  const hours = Number.isFinite(Number(thoroughHours)) && Number(thoroughHours) > 0 ? Math.max(1, Math.round(Number(thoroughHours))) : 6;
  const pipeline = engine === 'pipeline';
  const limit = limitPhrase(timeLimitMinutes);
  return {
    header: 'Deep research',
    question: pipeline
      ? `This looks like a research question. Research it? Quick takes a few minutes; Thorough takes up to ${limit}. ` + levelsCostLine(model, engine)
      : `This looks like a research question. Research it? Quick takes a few minutes; Thorough usually takes one to two hours (at most ${hours} hours). ` + (thoroughCost || levelsCostLine(model, engine)),
    options: ['Yes, quick', 'Yes, thorough', 'No', 'Always yes', 'Never'],
    descriptions: [
      mark('quick', 'A few minutes: many searches, the results summarised. You can keep talking meanwhile.'),
      mark('thorough', pipeline ? `Up to ${limit}: also reads the key sources in full and checks every figure against them.` : 'One to two hours in the background: a lead model reads the key sources in full, checks every figure and has the report reviewed until it holds up.'),
      'Answer now from what I know and a quick search.',
      `Research questions like this without asking, at the level set in Settings (now: ${levelName(alwaysLevel)}).`,
      'Never ask; always answer normally. You can change this in Settings.',
    ],
    allow_skip: true,
  };
}

async function decide({ choice, alwaysLevel, canAsk, ask, store, personKey, remindDue = false } = {}) {
  const always = alwaysLevel === 'thorough' ? 'thorough' : 'quick';
  if (choice === 'always') return { run: true, by: 'always', level: always };
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
  if (a === 'yes' || a === 'yes, quick') return { run: true, by: 'yes', level: 'quick' };
  if (a === 'yes, thorough') return { run: true, by: 'yes', level: 'thorough' };
  if (a === 'always yes' || a === 'always' || a === 'yes always') return { run: true, by: 'always-now', level: always, ...save('always') };
  if (a === 'never' || a === 'no always' || a === 'never ask') return { run: false, by: 'never-now', ...save('never') };
  if (a === 'no') return { run: false, by: 'no' };
  if (a === 'skipped' || a === 'no_answer' || a === '') return { run: false, by: 'no-answer' };
  return { run: false, by: 'typed', text: raw.trim().slice(0, 300) };
}

function offerText(decision) {
  const d = decision || {};
  // a stored choice that could not be saved: honoured now, said plainly (review r1)
  const lvl = d.level === 'thorough' ? 'thorough' : 'quick';
  const unsaved = d.saved === false ? ' Their choice could not be saved, so they may be asked again; say so in one line.' : '';
  switch (d.by) {
    case 'always': case 'yes': case 'always-now':
      return `The person wants a ${lvl} deep research run` + (d.by === 'always-now' && !unsaved ? ' (and from now on without being asked)' : d.by === 'always' ? ' (they chose always)' : '')
        + '. Plan 2 to 8 sub-questions that together answer it, then call deep_research with action "start", the same question, sub_questions and level "' + lvl + '". It runs in the background (' + (lvl === 'thorough' ? 'up to an hour' : 'a few minutes') + '): tell the person in one line that it has started and that the report will appear here, then carry on with the conversation.' + unsaved;
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
const ALWAYS_LEVEL_REFUSED = 'Only the person can choose which level Always yes runs, in Settings (or the phone\'s Deep research sheet). Tell them where.';
function setText(choice, ok = true) {
  if (!ok) return 'That could not be changed here: only the person can change it, in a conversation they started, or in Settings.';
  if (choice === 'ask') return 'Done: deep research is back on. The person will be asked when a question could use it. Tell them in one line.';
  if (choice === 'always') return 'Done: research questions now get a deep research run without asking. Tell them in one line.';
  if (choice === 'never') return 'Done: deep research is off for the person; they will not be asked (only reminded now and then that it is off). Tell them in one line.';
  return 'Say which: choice must be ask, always or never.';
}

const HELPER_NOTE = /fast and cheap|fast, cheap|small model/i;

// The company behind a model id ('claude-sdk/x' -> Anthropic), or 'local' for a model that runs on this computer.
const ORG_NAMES = { 'x-ai': 'xAI', deepseek: 'DeepSeek', 'meta-llama': 'Meta', 'z-ai': 'Z.ai', anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
function vendorOf(model) {
  const m = String(model == null ? '' : model);
  if (!m.includes('/')) return 'unknown';
  const parts = m.split('/');
  const p = parts[0].toLowerCase();
  if (p === 'claude-sdk' || p === 'anthropic') return 'Anthropic';
  if (p === 'codex-cli' || p === 'codex' || p === 'openai') return 'OpenAI';
  if (p === 'google') return 'Google';
  if (p === 'perplexity') return 'Perplexity';
  if (['local', 'lmstudio', 'ollama', 'omlx', 'ninfer'].includes(p)) return 'local';
  if (p === 'openrouter') {
    const org = (parts[1] || '').toLowerCase();
    if (!org) return 'OpenRouter';
    return ORG_NAMES[org] || parts[1];
  }
  return parts[0];
}

// sameVendor: only models of the same company as the agent's own (content that must stay on its own service).
function chooseHelperModel({ ownModel, allowed, noteOf, sameVendor = false } = {}) {
  const own = billingOf(ownModel);
  const prefix = (m) => (String(m).includes('/') ? String(m).split('/')[0] : '');
  const candidates = (Array.isArray(allowed) ? allowed : []).filter((m) => {
    if (typeof m !== 'string' || !m) return false;
    if (sameVendor && vendorOf(m) !== vendorOf(ownModel)) return false;
    if (vendorOf(ownModel) === 'local' && vendorOf(m) !== 'local') return false;   // an own model on this computer: helpers stay on it
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

const SAME_SERVICE_KEPT = 'the same service as the agent (its content stays there)';
const SAME_SERVICE_NONE = 'the same service as the agent (no other vendor is available here)';
/** The model that challenges a Thorough report: another vendor when the content may leave, else the agent's own. */
function chooseReviewer({ ownModel, allowed, keptOnBox = false } = {}) {
  if (keptOnBox) return { model: ownModel, label: SAME_SERVICE_KEPT, crossVendor: false };
  // an agent on a local model: the content stays on this computer, so the reviewer is local too, never a cloud model
  if (vendorOf(ownModel) === 'local') {
    const locals = (Array.isArray(allowed) ? allowed : []).filter((m) => typeof m === 'string' && m && vendorOf(m) === 'local');
    const pick = locals.find((m) => m !== ownModel) || locals[0] || ownModel;
    return { model: pick, label: 'a model on this computer (its content stays here)', crossVendor: false };
  }
  const ownVendor = vendorOf(ownModel);
  const ownKind = billingOf(ownModel).kind;
  const other = (Array.isArray(allowed) ? allowed : []).filter((m) => typeof m === 'string' && m && vendorOf(m) !== ownVendor && vendorOf(m) !== 'local');
  const pick = other.find((m) => billingOf(m).kind === ownKind) || other[0];
  if (!pick) return { model: ownModel, label: SAME_SERVICE_NONE, crossVendor: false };
  return { model: pick, label: `a model from another vendor (${vendorOf(pick)})`, crossVendor: true };
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
// interrupted: a Thorough run the hub's restart cut short; report holds what had been saved.
function reportMessage({ id, question, report, failed, level, interrupted } = {}) {
  const q = String(question == null ? '' : question).slice(0, 200);
  if (failed) {
    return `[Deep research failed] "${q}" (id ${id}): ${failed === true ? 'unknown reason' : failed}.\n\n`
      + 'Tell the person in one or two lines that the research run did not finish and why, and offer to answer from what you know or to try again.';
  }
  if (interrupted) {
    return `[Deep research interrupted] "${q}" (id ${id}).\n\n`
      + 'The research run was cut short because your Maestro restarted. Below is what had been saved. Tell the person plainly that it did not finish, present what there is (keep every link), and offer to run it again. The person asked for this: call for_owner once with requested: true and the reason "Deep research report ready". This is the research run\'s result, not a message from the person.\n\n'
      + `Saved so far:\n${report}`;
  }
  const how = level === 'thorough'
    ? 'Present the report as given: the verdict first, then the key evidence with its links, the corrections to the first pass, the confidence, the figure-check line, which reviewer was used, and the document path. Keep every link and keep the document path. Pass the figure-check lines on word for word, unchanged: the sentences that start "Of N figures" (with the parenthesis "(N of them in the claims table)" when it is there) and the one about the sources that were not read in full. If the report starts with "Not finished", say that first.'
    : 'Present its report to the person now: the verdict first, then the evidence with its links and dates, where sources disagree, and how confident it is. Keep every link.';
  return `[Deep research finished] "${q}" (id ${id}).\n\n`
    + `The research run finished. ${how} The person asked for this: call for_owner once with requested: true and the reason "Deep research report ready". This is the research run's result, not a message from the person.\n\n`
    + `Report:\n${report}`;
}

const FINDINGS_SAVE_MAX = 60000;
const READER_NOTES_MAX = 80000;
const PROSE_MAX = 40000;
const FIRST_PASS_MAX = 20000;
const CLAIMS_MAX = 200;
const PARTIAL_BODY_MAX = 30000;

/** Keeps the texts of a list while the total stays within max (the last one is cut). */
function capList(list, max) {
  const out = [];
  let used = 0;
  for (const t of Array.isArray(list) ? list : []) {
    const s = String(t == null ? '' : t);
    if (used + s.length <= max) { out.push(s); used += s.length; continue; }
    const room = max - used;
    if (room > 200) out.push(s.slice(0, room) + '\n[cut]');
    break;
  }
  return out;
}
const capText = (t, max) => { const s = String(t == null ? '' : t); return s.length > max ? s.slice(0, max) + '\n[cut]' : s; };
const localDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** The chat report of a lead run: plain lines (the lead's summary, a ceiling, the counts, who did what, the files, what was not done). */
function leadReport({ summary, ceiling, openPoints, counts, files, paths, models, elapsedMinutes, missing } = {}) {
  const c = counts || {};
  const n = (x) => Math.max(0, Math.round(Number(x) || 0));
  const m = models || {};
  const pth = paths || {};
  const lines = [];
  lines.push(String(summary || '').trim() || 'The lead wrote no summary.', '');
  const pts = (Array.isArray(openPoints) ? openPoints : openPoints ? [openPoints] : []).map(String).filter(Boolean);
  if (ceiling) lines.push(`This run stopped at a ceiling: ${ceiling}.`);
  if (pts.length) { lines.push(ceiling ? 'Left open:' : 'Open points:'); for (const x of pts) lines.push(`- ${x}`); }
  if (ceiling || pts.length) lines.push('');
  const tokens = Math.round((n(c.promptChars) + n(c.replyChars)) / 4 / 1000) * 1000;
  lines.push(`Sources opened: ${n(c.opens)}. Reader calls: ${n(c.readerCalls)} (top-tier: ${n(c.topReads)}). Review rounds: ${n(c.reviewRounds)}. Lead steps: ${n(c.steps)}. Time: ${n(elapsedMinutes)} minutes. Estimated tokens: about ${tokens.toLocaleString('en-US')} (an estimate from the characters sent and received).`);
  const withPath = (model, key) => `${model || 'unknown'}${pth[key] ? ` (${pth[key]})` : ''}`;
  const revs = (Array.isArray(m.reviewers) ? m.reviewers : []).map((r) => (r && (r.label || r.model)) || '').filter(Boolean);
  lines.push(`Which model did what: lead ${withPath(m.lead, 'lead')}, readers ${withPath(m.reader, 'reader')}, top-tier reader ${withPath(m.readerTop, 'readerTop')}, reviewers ${revs.length ? revs.join(', ') : 'none'}.`);
  lines.push('');
  const f = files || {};
  const doc = f.md || f.markdown || f.document || f.html;
  if (doc) lines.push('Full document:', '`' + doc + '`');
  if (f.pdf) lines.push('PDF:', '`' + f.pdf + '`');
  else lines.push(`No PDF: ${f.pdfError || f.pdfReason || 'it was not made'}`);
  const miss = (Array.isArray(missing) ? missing : missing ? [missing] : []).map(String).filter(Boolean).map(T.plainMissing);
  if (miss.length) { lines.push('', 'Not done:'); for (const x of miss) lines.push(`- ${x}`); }
  return lines.join('\n');
}

/** The document page of a lead report: the markdown as HTML (the same converter as the fixed path's document). */
function leadHtml(markdown) {
  const title = (String(markdown || '').match(/^#\s+(.+)$/m) || [])[1] || 'Research';
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${T.esc(title)}</title>\n<style>\n${T.PAGE_CSS}\n</style>\n</head>\n<body>\n${T.mdToHtml(markdown)}\n</body>\n</html>\n`;
}

const QUICK_PASS_HEADING = '\n\n## What the quick pass said\n\n';
const defaultPlaybook = () => fs.readFileSync(path.join(__dirname, 'research-playbook.md'), 'utf8');

/** The hard deadline of a Thorough run in minutes. A lead run's own wall-clock ceiling (leadWallMinutes) ends it first, so its deadline is
 *  20 minutes later; the fixed stages keep timeLimitMinutes. */
function thoroughLimitMinutes(st) {
  const lead = ((st && st.engine) || T.DEFAULTS.engine) !== 'pipeline';
  if (lead) return (Number(st && st.leadWallMinutes) || T.DEFAULTS.leadWallMinutes) + 20;
  return Number(st && st.timeLimitMinutes) || T.DEFAULTS.timeLimitMinutes;
}

function createResearchRunner(deps = {}) {
  const {
    spawn, wake, pickHelperModel, ownModelOf,
    now = Date.now, log = console.log, retryMs = 30000, maxWakeTries = 40,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxRunning = 3,
    store = null,   // { load() -> runs[], save(runs[]) }: runs survive a restart so a cut-short run is reported, never lost
    keepMs = 24 * 3600 * 1000,
    slowRetryMs = 10 * 60 * 1000, slowTries = 0,   // after the fast tries: slower tries, so a busy agent still gets its report
    deadlineMs = 30 * 60 * 1000,   // a quick run that takes longer is ended and reported as not finished
    keepUndeliveredMs = 7 * 24 * 3600 * 1000,   // a report that could not be delivered is kept this long in the saved runs
    stampOf = null,   // (agent) -> identity stamp, null when no such agent, throws when it can't be told; when given, a
                      // run works and reports only for the agent that started it
    // Thorough runs (all optional: without them a Thorough run still goes through every stage it can)
    fetchPage = null,          // async (url, { maxLength, offset }) -> page
    helperSearchBoth = null,   // () -> true when helpers and readers also search with the hub's search (setting researchHelperSearch = both)
    thoroughSettings = null,   // () -> the settings of lib/research-thorough settingsFrom
    pickReviewer = null,       // async (agent) -> { model, label, crossVendor }
    pickReaderModel = null,    // async (agent) -> model
    writeDocument = null,      // async (agent, base, { markdown, html }) -> { md, html, pdf, pdfError }
    onProgress = null,         // (copy of the run) on every stage change; never throws into the runner
    keptOnBox = null,          // (agent) -> true when the agent's content must stay on its own service; strict: anything but false counts as kept
    search = null,             // async (query) -> [{ title, url, snippet }]: the lead's web search
    leadModels = null,         // async (agent) -> { lead, reader, readerTop, reviewers: [{ model, label }], paths: { lead, ... } }
    leadPlaybook = defaultPlaybook,   // () -> the playbook text the lead works by; a read failure throws
    leadDir = (id) => path.join(__dirname, '..', 'data', 'research', id),   // (run id) -> the absolute folder of a lead run
    engine = null,             // overrides of lib/research-thorough functions (tests)
  } = deps;
  const E = { ...T, ...(engine || {}) };
  const fetchedLive = new Map();   // run id -> the opened sources' texts, in memory only (never saved)
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
  const copy = (r) => ({
    ...r,
    subQuestions: [...r.subQuestions],
    ...(Array.isArray(r.missing) ? { missing: [...r.missing] } : {}),
    ...(Array.isArray(r.stagesDone) ? { stagesDone: [...r.stagesDone] } : {}),
  });
  function persist() {
    if (!store) return;
    try { store.save([...runs.values()].map(copy)); } catch (e) { try { log(`[research] could not save runs: ${e && e.message}`); } catch { /* ignore */ } }
  }
  function emit(run) {
    run.seq = (Number(run.seq) || 0) + 1;   // the pages order a status answer and an event by it
    if (typeof onProgress !== 'function') return;
    try { const r = onProgress(copy(run)); if (r && typeof r.catch === 'function') r.catch(() => {}); } catch { /* the progress line never stops a run */ }
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
  const labelOf = (stage) => T.progressLabel(stage);

  /** What a Thorough run has saved, as the body of a report that did not finish: the report text if there is one, else the
   *  readers' notes, else the quick findings by section. */
  function savedBody(run, interrupted = false) {
    const join = (l) => (Array.isArray(l) ? l.join('\n\n') : '');
    if (typeof run.prose === 'string' && run.prose.trim()) {
      try {
        let { prose } = run;
        const claims = Array.isArray(run.claims) ? run.claims : [];
        let totals = run.checkTotals, notChecked = run.notChecked, resultClaims = claims, interruptedBeforeCheck = false;
        if (!run.checked) {
          const texts = fetchedLive.get(run.id);
          if (Array.isArray(texts)) {
            // the figures were not checked yet (the run stopped first): checked now against the source texts still in memory
            const srcs = Array.isArray(run.sources) ? run.sources : [];
            const r = E.checkReport({ prose, claims, fetched: texts, counts: { sourcesSelected: srcs.length, sourcesOpened: srcs.filter((x) => x && x.ok).length, claims: claims.length, rounds: Number(run.rounds) || 0 }, meaningKeys: run.meaningKeys });
            prose = r.prose; resultClaims = r.claims; totals = r.totals; notChecked = r.notChecked;
          } else {
            // no source texts in memory (a restart): never check against nothing; every figure is marked "no source to check"
            prose = E.markUnverified(prose); interruptedBeforeCheck = true;
          }
        }
        // verdicts follow the claim's content: doubted by key, so a renumbered claim keeps its doubt
        let doubtedIds = Array.isArray(run.doubtedIds) ? run.doubtedIds : [];
        if (Array.isArray(run.doubtedKeys)) { const dk = new Set(run.doubtedKeys); doubtedIds = resultClaims.filter((c) => dk.has(E.claimKey(c))).map((c) => c.id); }
        // not reviewed = a claim whose content (key) no credited round showed a reviewer; a renumbered claim stays reviewed, a rewritten one does not
        let unreviewedIds = Array.isArray(run.unreviewedIds) ? run.unreviewedIds : [];
        if (Number(run.rounds) > 0 && Array.isArray(run.sentKeys)) { const sk = new Set(run.sentKeys); unreviewedIds = resultClaims.filter((c) => !sk.has(E.claimKey(c))).map((c) => c.id); }
        return E.chatReport({ question: run.question, prose, claims: resultClaims, totals, notChecked, checkError: run.checkError === true && !!run.checked, interruptedBeforeCheck, reviewer: run.rounds > 0 ? run.reviewer : '', rounds: run.rounds || 0, review: run.review && (run.review.rounds > 0 || run.review.failed) ? run.review : undefined, doubtedIds, unreviewedIds, interrupted, files: run.files, missing: [], level: 'thorough' });
      } catch { /* the plain text below */ }
      return capText(run.prose, PARTIAL_BODY_MAX);
    }
    if (Array.isArray(run.readerNotes) && run.readerNotes.length) return 'Notes from reading the sources in full (not yet turned into a report):\n\n' + capText(join(run.readerNotes), PARTIAL_BODY_MAX);
    if (Array.isArray(run.findings) && run.findings.length) return 'First-pass findings (the sources were not read in full):\n\n' + capText(join(run.findings), PARTIAL_BODY_MAX);
    return '';
  }
  function stagesNotDone(run) {
    const done = new Set(Array.isArray(run.stagesDone) ? run.stagesDone : []);
    return T.STAGES.filter((s) => !done.has(s));
  }
  /** A Thorough report that did not finish: first line says what is not done and why; then what was saved; then what is missing. */
  function partialReport(run, why) {
    const body = savedBody(run);
    const lines = [`Not finished: ${stagesNotDone(run).map(labelOf).join(', ') || 'the last steps'} (${why}).`, ''];
    lines.push(body || 'Nothing had been saved yet.');
    if (Array.isArray(run.missing) && run.missing.length) lines.push('', `Missing: ${run.missing.map(T.plainMissing).join('; ')}`);
    return lines.join('\n');
  }

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

  /** After a restart: a run whose report was ready is delivered again from the saved copy; a Thorough run still researching
   *  is reported as interrupted with what it had saved; a quick one as cut short. */
  function recover() {
    const ids = cutShort; cutShort = [];
    for (const id of ids) {
      const run = runs.get(id);
      if (!run || !(isActive(run) || undelivered(run))) continue;
      let message;
      if (typeof run.message === 'string' && run.message) message = run.message;
      else if (run.level === 'thorough' && run.leadDir) {
        // a lead run found running: ended with the salvage of its folder
        leadStopped(run, 'the hub restarted during the run').then((m) => { run.message = m; return deliver(run, m); }).catch(() => {});
        continue;
      } else if (run.level === 'thorough') {
        const body = savedBody(run, true) || 'Nothing had been saved yet.';
        const todo = stagesNotDone(run).map(labelOf).join(', ');
        const miss = Array.isArray(run.missing) && run.missing.length ? `\nMissing: ${run.missing.map(T.plainMissing).join('; ')}` : '';
        message = reportMessage({ id: run.id, question: run.question, interrupted: true, report: `Not done: ${todo || 'the last steps'}.${miss}\n\n${body}` });
      } else message = reportMessage({ id: run.id, question: run.question, failed: 'your Maestro restarted while it ran, so it was cut short' });
      run.message = message;
      deliver(run, message).catch(() => {});
    }
  }

  function start({ agent, question, subQuestions, level = 'quick' } = {}) {
    if (!LEVELS.includes(level)) return { ok: false, error: 'level must be quick or thorough.' };
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
    // stamp: who the agent is now (lib/agents agentIdentityStrict); the run works and reports only for that same agent
    // (reviews r3, r4). Not started when that can't be told: its report could never be delivered.
    let stamp = null;
    if (stampOf) {
      try { stamp = stampOf(agent) || null; } catch { return { ok: false, error: 'Could not confirm which agent this is right now; try again in a minute.' }; }
      if (!stamp) return { ok: false, error: 'No such agent.' };
    }
    const run = { id, agent, stamp, question: q, subQuestions: subs, level, state: 'running', stage: '', stageLabel: '', stageDone: 0, stageTotal: 0, startedAt: now(), endedAt: null, error: null };
    runs.set(id, run);
    persist();
    emit(run);
    setImmediate(() => { execute(run).catch((e) => { try { log(`[research] ${id}: ${e && e.message}`); } catch { /* ignore */ } run.state = 'failed'; run.error = String(e && e.message || e); run.endedAt = now(); persist(); emit(run); }); });
    return { ok: true, id };
  }

  /** Wakes the agent with the message (saved with the run first), again every retryMs while it is busy (maxWakeTries
   *  tries), then every slowRetryMs (slowTries more). Given up: the run is failed and keeps the message in the saved runs. */
  async function deliver(run, message) {
    run.state = 'delivering';
    run.message = message;
    persist();
    emit(run);
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
        emit(run);
        try { log(`[research] ${run.id} for ${run.agent}: ${run.error}`); } catch { /* ignore */ }
        return;
      }
      if (who === 'unknown') last = new Error('could not confirm the agent it was for');
      else {
        try { await wake(run.agent, message); run.state = 'delivered'; run.endedAt = now(); run.message = null; persist(); emit(run); return; } catch (e) { last = e; }
      }
      if (/refused the wake-up turn \(404|no such agent/i.test(String((last && last.message) || last))) break;   // the agent is gone: no point trying for a day
      if (i < total - 1) await sleep(i < maxWakeTries - 1 ? retryMs : slowRetryMs);
    }
    run.state = 'failed';
    run.error = `the report could not be delivered: ${(last && last.message) || last}`;
    run.endedAt = now();
    persist();
    emit(run);
    try { log(`[research] ${run.id} for ${run.agent}: ${run.error} (kept in the saved runs)`); } catch { /* ignore */ }
  }

  // cx.dead: the run was ended (deadline, error); a stage still running in the background must change nothing any more.
  async function research(run, signal, cx, st) {
    let finished = false;
    try { const r = await researchRun(run, signal, cx, st); finished = true; return r; }
    // the opened sources' texts never outlive the run; after a deadline (cx.dead) or a normal end here, a failure before
    // the deadline leaves them for execute() to build the partial report, which then drops them
    finally { if (finished || cx.dead) fetchedLive.delete(run.id); }
  }
  async function researchRun(run, signal, cx, st) {
    // nothing is sent after the deadline (review r2), nor for an agent that was replaced or can't be confirmed (review r4)
    const over = () => {
      if (signal && signal.aborted) throw new Error('the run was ended');
      const who = whoNow(run);
      if (who === 'other') throw new Error(REPLACED);
      if (who === 'unknown') throw new Error('could not confirm the agent it was for');
    };
    // and asked again by the launcher as each worker is about to start, after its own waits (review r5)
    const admit = () => !cx.dead && !(signal && signal.aborted) && whoNow(run) === 'same';
    const thorough = run.level === 'thorough';
    const save = (fields) => { if (cx.dead) return; Object.assign(run, fields); persist(); };
    const setStage = (stage, done, total, label) => {
      if (cx.dead) return;
      run.stage = stage; run.stageDone = done; run.stageTotal = total;
      run.stageLabel = label || T.progressLabel(stage, done, total);
      persist(); emit(run);
    };
    const finish = (stage) => { if (!cx.dead && !run.stagesDone.includes(stage)) { run.stagesDone.push(stage); persist(); } };
    const miss = (what) => { if (cx.dead) return; run.missing.push(String(what).slice(0, 300)); persist(); };
    // Helpers and readers (never the summary, the source choice or the reviewer) carry searchBoth when the setting says so.
    // Content that must stay on its own service: every worker uses the agent's own model, and never the second search. Strict:
    // anything but a plain false from the lookup counts as kept.
    const kept = (() => { try { return typeof keptOnBox !== 'function' || keptOnBox(run.agent) !== false; } catch { return true; } })();
    const both = () => { if (kept) return false; try { return typeof helperSearchBoth === 'function' && helperSearchBoth() === true; } catch { return false; } };
    const mark = (job) => (both() ? { ...job, searchBoth: true } : job);
    // tools: only the helpers, readers and the reviewer read the web; the others work from their brief ('none')
    const worker = async (task, model, label, tools = 'none') => {
      const r = outcomes(await spawn(run.agent, [{ task, model, tools, label }], signal, { admit }))[0];
      if (!r || !r.text.trim()) throw new Error('no reply');
      if (!r.ok) throw new Error('it did not finish: ' + r.text.slice(0, 160));
      return r.text.trim();
    };
    // a stage's own failure goes into missing and the run goes on; an ended run or a replaced agent stops it
    const gone = (e) => { if ((signal && signal.aborted) || cx.dead) return true; const w = whoNow(run); return w !== 'same'; };
    const why = (e) => String((e && e.message) || e || 'unknown error').replace(/\s+/g, ' ').slice(0, 160);

    // ---- the helper batch (the whole of a quick run before its summary)
    const own = await ownModelOf(run.agent);
    // an own model on this computer: helpers, readers and the reviewer stay on this computer too (a pick that is not local is ignored)
    const localOwn = vendorOf(own) === 'local';
    const stayLocal = (m) => (localOwn && vendorOf(m) !== 'local' ? own : m);
    const helper = kept ? own : stayLocal(await pickHelperModel(run.agent));
    over();
    if (!thorough) save({ stagesDone: [], missing: [] });
    else save({ stagesDone: [], missing: [], findings: [], firstPass: '', readerNotes: [], claims: [], rounds: 0 });
    setStage('quick', 0, run.subQuestions.length, thorough ? 'quick pass' : `searching (0 of ${run.subQuestions.length} helpers)`);
    const h = outcomes(await spawn(run.agent, run.subQuestions.map((s, i) => mark({ task: helperBrief(run.question, s), model: helper, tools: 'read', label: `Research ${i + 1}` })), signal, { admit }));
    const good = h.filter((x) => x.ok && x.text.trim());
    if (!good.length) throw new Error('none of the helpers finished' + (h[0] && h[0].text ? `: ${h[0].text.slice(0, 200)}` : ''));
    const parts = good.map((x) => (x.label ? `### ${x.label}\n` : '') + x.text.trim());
    const note = good.length < h.length ? `\n\n(${h.length - good.length} of ${h.length} helpers did not finish; their parts are missing.)` : '';
    const findingsText = parts.join('\n\n') + note;
    over();
    save({ findings: capList(parts, FINDINGS_SAVE_MAX) });
    finish('quick');
    const nSub = run.subQuestions.length;
    setStage('quick', nSub, nSub, thorough ? 'quick pass' : `searching (${nSub} of ${nSub} helpers)`);

    if (!thorough) {
      setStage('writing', 0, 1, 'writing the summary');
      const s = outcomes(await spawn(run.agent, [{ task: synthesisBrief(run.question, run.subQuestions, findingsText), model: own, tools: 'read', label: 'Research summary' }], signal, { admit }))[0];
      if (!s || !s.text.trim()) throw new Error('the research run produced no report');
      if (!s.ok) throw new Error('the summary did not finish: ' + s.text.slice(0, 200));
      setStage('writing', 1, 1, 'writing the summary');
      return s.text.trim();
    }

    // ---- Thorough: the first-pass summary (one call on the agent's own model, from the helpers' findings; the run goes on without it)
    const settings = { ...T.DEFAULTS, ...(st || {}) };
    let firstPass = '';
    over();
    setStage('summary', 0, 1);
    try {
      firstPass = await worker(E.firstPassBrief(run.question, parts), own, 'First pass summary');
      over();
      save({ firstPass: capText(firstPass, FIRST_PASS_MAX) });
    } catch (e) { if (gone(e)) throw e; firstPass = ''; miss(`first-pass summary (${why(e)}; the findings stand in for it)`); }
    setStage('summary', 1, 1);

    if (settings.engine !== 'pipeline') return leadBranch({ run, signal, cx, settings, firstPass, findingsText, own, helper, over, admit, worker, save, setStage, miss, gone, why });

    // ---- Thorough: choose the sources
    let sources = [];
    // the sources the first pass's verdict and key evidence rest on: always read in full, also when the chooser fails
    let pinned = [];
    try { pinned = E.pinnedSources(firstPass, parts, settings.maxSources) || []; } catch { pinned = []; }
    over();
    setStage('select', 0, 1);
    let selectWhy = '';
    try {
      const text = await worker(E.selectionBrief(run.question, parts, settings.maxSources, pinned), own, 'Choose sources');
      sources = E.parseSelection(text, parts, settings.maxSources, pinned);
      if (!sources.length) selectWhy = 'no source to read was found in the findings';
    } catch (e) { if (gone(e)) throw e; selectWhy = why(e); sources = []; }
    if (!sources.length) {
      // the chooser failed or gave nothing usable: the sources the helpers listed as read stand in for its choice
      try { sources = E.extractSources(parts, settings.maxSources) || []; } catch { sources = []; }
    }
    // the sources the first pass's verdict and key evidence rest on are always read in full (also when the chooser failed)
    try { sources = E.mergePinned(pinned, sources, settings.maxSources); } catch { /* keep the chosen sources */ }
    if (sources.length) finish('select'); else miss(`select (${selectWhy || 'no source to read was found in the findings'})`);
    setStage('select', 1, 1);

    // ---- fetch the texts (kept in memory only)
    let fetched = [];
    if (sources.length) {
      over();
      setStage('fetch', 0, sources.length);
      try {
        if (typeof fetchPage !== 'function') throw new Error('no page fetcher is available');
        fetched = await T.fetchSourceTexts(sources, { fetchPage, signal });
        over();
        fetchedLive.set(run.id, fetched);
        save({ sources: fetched.map((f) => ({ url: f.url, title: f.title || '', ok: !!f.ok, chars: f.chars || 0, via: f.via || '', error: f.ok ? '' : String(f.error || '').replace(/\s+/g, ' ').slice(0, 200) })) });
        if (!fetched.some((f) => f.ok)) miss('fetch (no source could be opened here)'); else finish('fetch');
      } catch (e) { if (gone(e)) throw e; miss(`fetch (${why(e)})`); }
      setStage('fetch', sources.length, sources.length);
    }

    // ---- read in full
    const readerNotes = [];
    if (sources.length) {
      over();
      const groups = E.groupForReaders(sources, 2);
      const per = Math.max(1, Number(settings.readersAtOnce) || 4);
      setStage('read', 0, groups.length);
      let readerModel = own;
      try { if (pickReaderModel && !kept) readerModel = stayLocal((await pickReaderModel(run.agent)) || own); } catch { readerModel = own; }
      let failed = 0;
      let readOk = 0;
      // the readers read only the text the hub fetched (never the web): url -> the fetched entry
      const texts = new Map(fetched.map((f) => [f.url, f]));
      const hasText = (s) => { const t = texts.get(s.url); return !!(t && t.ok && typeof t.text === 'string' && t.text.trim()); };
      for (let i = 0; i < groups.length; i += per) {
        over();
        const batchAll = groups.slice(i, i + per);
        // a group with no hub text is not sent to a reader; the synthesis is told its sources were not read
        const batch = [];
        // in a group where only some sources have text, the reader gets just those; the others get the same note
        for (const g of batchAll) {
          const withText = g.filter(hasText);
          if (withText.length) batch.push(withText);
          for (const s of g) if (!withText.includes(s)) readerNotes.push(`## ${s.title || s.url} (${s.url})\n- Full text opened: no (the hub could not fetch it)`);
        }
        if (batch.length) {
          try {
            const r = outcomes(await spawn(run.agent, batch.map((g, k) => mark({ task: E.readerBrief(run.question, g, parts, firstPass, texts), model: readerModel, tools: 'none', label: `Reader ${i + k + 1}` })), signal, { admit }));
            for (const x of r) { if (x.ok && x.text.trim()) { readerNotes.push(x.text.trim()); readOk++; } else failed++; }
            failed += Math.max(0, batch.length - r.length);
          } catch (e) { if (gone(e)) throw e; failed += batch.length; }
        }
        over();
        save({ readerNotes: capList(readerNotes, READER_NOTES_MAX) });
        setStage('read', Math.min(groups.length, i + batchAll.length), groups.length);
      }
      if (!readOk) miss('read (no reader finished)');
      else { if (failed) miss(`read (${failed} of ${groups.length} readers did not finish; their sources are covered only by the first pass)`); finish('read'); }
    }

    // ---- synthesis
    // a claim as written: its id, text, source and figures (a rewrite of the report may not change them)
    const claimText = (c) => String((c && c.claim) || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const sameClaimEntry = (a, b) => !!a && !!b && String(a.id) === String(b.id) && claimText(a) === claimText(b) && String(a.source_url || '') === String(b.source_url || '') && JSON.stringify(a.figures || []) === JSON.stringify(b.figures || []);
    let rawProse = '';
    let rawClaims = [];
    over();
    setStage('synthesis', 0, 1);
    const briefText = E.synthesisBrief(run.question, parts.join('\n\n') + note, readerNotes.join('\n\n'), fetched);
    let lastText = '';
    let valid = false;
    for (let attempt = 0; attempt < 2 && !valid; attempt++) {
      over();
      try {
        const text = await worker(attempt ? `${briefText}\n\nYour reply had no valid claims block; reply again in the same format.` : briefText, own, 'Research report');
        const p = E.parseClaims(text);
        lastText = p.prose || lastText;
        if (!p.error && p.claims.length) { rawProse = p.prose; rawClaims = p.claims; valid = true; }
      } catch (e) { if (gone(e)) throw e; }
    }
    if (valid) finish('synthesis');
    else if (lastText.trim()) { rawProse = lastText; miss('traceability table (the report had no valid claims list)'); finish('synthesis'); }
    else {
      // both tries gave nothing: today's quick summary of the first pass stands in for the report
      try {
        over();
        rawProse = await worker(synthesisBrief(run.question, run.subQuestions, findingsText), own, 'Research summary');
        miss('synthesis (the full-text report could not be written; this is the summary of the first pass)');
      } catch (e) { if (gone(e)) throw e; miss(`synthesis (${why(e)})`); }
    }
    over();
    save({ prose: capText(rawProse, PROSE_MAX), claims: rawClaims.slice(0, CLAIMS_MAX) });
    // results the readers reported that no claim holds: ONE follow-up on the same model; the first synthesis stands unless the follow-up
    // parses with at least as many claims. Its failure is no stage failure.
    if (valid && readerNotes.length) {
      let before = [];
      try { before = E.missingReaderFacts(readerNotes, rawClaims) || []; } catch { before = []; }
      if (before.length) {
        let after = before.length;
        let added = 0;
        let proseKept = true;
        try {
          over();
          const list = before.map((m) => `- ${m.source}: ${m.line}`).join('\n');
          const text = await worker([
            briefText,
            '',
            'Current report:',
            '"""',
            rawProse,
            '"""',
            '',
            'Current claims:',
            '```claims',
            JSON.stringify(rawClaims, null, 1),
            '```',
            '',
            `The readers reported these results, and your claims leave them out:\n${list}\nAdd a claim (with its figures, location, who judged and sample size) for each one that bears on the question; return the whole report and claims block again in the same format.`,
          ].join('\n'), own, 'Research report (follow-up)');
          const p = E.parseClaims(text);
          if (!p.error && p.claims.length) {
            // a rewrite cannot drop or change a claim: only the claims the follow-up ADDS are used, appended to the old ones unchanged
            const oldIds = new Set(rawClaims.map((c) => String(c.id)));
            const oldTexts = new Set(rawClaims.map((c) => claimText(c)));
            const seenIds = new Set();
            const adds = [];
            for (const c of p.claims) {
              const id = String(c.id);
              if (oldIds.has(id) || seenIds.has(id) || oldTexts.has(claimText(c))) continue;
              seenIds.add(id); oldTexts.add(claimText(c)); adds.push(c);
            }
            // the follow-up's prose is used only when it holds every old claim as it was and keeps every « » span of the old prose
            const keepsAll = rawClaims.every((o) => p.claims.some((n) => sameClaimEntry(o, n)));
            const spans = String(rawProse || '').match(/«[^»]*»/g) || [];
            const keepsSpans = spans.every((sp) => String(p.prose || '').includes(sp));
            if (keepsAll && keepsSpans) { rawProse = p.prose; proseKept = false; }
            rawClaims = [...rawClaims, ...adds];
            added = adds.length;
            try { after = (E.missingReaderFacts(readerNotes, rawClaims) || []).length; } catch { after = before.length; }
          }
        } catch (e) { if (gone(e)) throw e; }
        over();
        save({ prose: capText(rawProse, PROSE_MAX), claims: rawClaims.slice(0, CLAIMS_MAX), readerFacts: { missing: before.length, after, added, proseKept } });
      }
    }
    setStage('synthesis', 1, 1);

    // ---- check the figures against the source texts (every report, also one with no claims list: then every figure is marked)
    let prose = rawProse;
    let claims = rawClaims;
    let totals = { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, noSource: 0 };
    let notChecked = false;
    let checkError = false;
    let rounds = 0;
    // the second mark: what the reviewer found about each figure's meaning, by meaningKey (claim, figure, passage around it); only credited rounds add to it
    const meaningKeys = {};
    const checkCounts = () => ({ sourcesSelected: sources.length, sourcesOpened: fetched.filter((f) => f.ok).length, claims: rawClaims.length, rounds });
    const runCheck = () => {
      const r = E.checkReport({ prose: rawProse, claims: rawClaims, fetched, counts: checkCounts(), meaningKeys });
      prose = r.prose; claims = r.claims; totals = r.totals; notChecked = r.notChecked; checkError = false;
    };
    const saveChecked = () => { over(); save({ prose: capText(prose, PROSE_MAX), claims: claims.slice(0, CLAIMS_MAX), checkTotals: totals, notChecked, checkError, checked: true }); };
    // the check itself failed: nothing is vouched for; every figure is marked "no source to check"
    const checkFailed = () => {
      claims = rawClaims; totals = { claims: 0, figures: 0, found: 0, notFound: 0, notOpened: 0, noSource: 0 }; notChecked = true; checkError = true;
      try { prose = E.markUnverified(rawProse); } catch { prose = rawProse; }
      miss('checking figures (error)');
      saveChecked();
    };
    over();
    setStage('check', 0, 1);
    try { runCheck(); saveChecked(); finish('check'); } catch (e) { if (gone(e)) throw e; checkFailed(); }
    setStage('check', 1, 1);

    // ---- the reviewer challenges the report
    let reviewerLabel = '';
    let review = { label: '', rounds: 0, counts: null, uncheckedIds: [], failed: '' };
    let doubtedIds = [];
    let unreviewedIds = [];
    // verdicts belong to a claim's content (claimKey), never to its id: a revise may renumber or reword claims
    const sentKeys = new Set();        // every claim a reviewer was shown
    const reviewed = new Map();        // claimKey -> the decisive verdict
    const keyOf = (c) => { try { return String(E.claimKey(c)); } catch { return ''; } };
    const settle = () => {
      const doubtedKeys = [...reviewed].filter(([, v]) => v === 'partly' || v === 'not_supported').map(([k]) => k);
      const dk = new Set(doubtedKeys);
      doubtedIds = claims.filter((c) => dk.has(keyOf(c))).map((c) => c.id);
      unreviewedIds = rounds > 0 ? claims.filter((c) => !sentKeys.has(keyOf(c))).map((c) => c.id) : [];
      const un = rounds > 0 ? claims.filter((c) => sentKeys.has(keyOf(c)) && !reviewed.has(keyOf(c))).map((c) => c.id) : [];
      if (rounds > 0) review = { ...review, uncheckedIds: un };
      return { doubtedKeys, reviewedKeys: Object.fromEntries(reviewed) };
    };
    const unresolved = [];
    let revisionsDiscarded = 0; // revisions thrown away because they dropped or changed a claim the round had not doubted
    let unquoted = 0;   // verdicts the hub turned into cannot_check because their contradiction quote was not found
    if (settings.reviewRounds > 0 && rawClaims.length && fetched.some((f) => f.ok)) {
      let reviewer = { model: own, label: 'the same service as the agent (no other vendor is available here)', crossVendor: false };
      try { if (pickReviewer && !kept) { const r = await pickReviewer(run.agent); if (r && r.model) reviewer = r; } else if (kept) reviewer = { model: own, label: SAME_SERVICE_KEPT, crossVendor: false }; } catch { /* the agent's own model, as above */ }
      { // when a local own model replaces the pick, the label and crossVendor describe the model actually used
        const used = stayLocal(reviewer.model);
        reviewer = used !== reviewer.model ? { ...reviewer, model: used, label: 'a model on this computer (its content stays here)', crossVendor: false } : reviewer;
      }
      const roundFailed = (why2) => { review = rounds > 0 ? { ...review, lastRoundFailed: true, unquoted } : { ...review, failed: why2, unquoted }; };
      for (let round = 1; round <= settings.reviewRounds; round++) {
        over();
        setStage('challenge', round - 1, settings.reviewRounds);
        let verdicts;
        let sum;
        let figs = [];
        try {
          // the figures of the claims and of the current report text (the prose of the run as the round is built)
          figs = E.figureExcerpts(claims, fetched, undefined, { prose: rawProse, counts: checkCounts() });
          // the reader notes of each claim's source, from this round's notes (built once per round)
          const notesOf = E.readerNotesLookup(readerNotes);
          const excerpts = E.challengeExcerpts(claims, fetched);
          const text = await worker(E.challengeBrief(run.question, claims, excerpts, figs, notesOf), reviewer.model, 'Reviewer', 'read');
          verdicts = E.parseChallenge(text, claims.map((c) => c.id), figs);
          if (verdicts.error) throw new Error('the reviewer\'s reply could not be read');
          // a not_supported / partly verdict stands only with a contradiction quote found in the excerpts or the notes shown
          verdicts = E.enforceContradictions(verdicts, claims, excerpts, notesOf);
          unquoted += verdicts.unquoted || 0;
          sum = E.challengeSummary(verdicts);
        } catch (e) { if (gone(e)) throw e; miss(`challenge (round ${round}: ${why(e)})`); roundFailed(why(e)); break; }
        if (!sum || !(sum.decisive > 0)) {
          // a round with no usable verdict is not a review: not credited, and the challenge stops
          miss('challenge: the reviewer gave no usable verdicts');
          roundFailed('the reviewer gave no usable verdicts');
          break;
        }
        rounds = round; reviewerLabel = reviewer.label;
        const byId = new Map(claims.map((c) => [String(c.id), c]));
        for (const r of verdicts.results) {
          const c = byId.get(String(r.id));
          if (!c) continue;
          const k = keyOf(c);
          sentKeys.add(k);
          if (r.verdict === 'supported' || r.verdict === 'partly' || r.verdict === 'not_supported') reviewed.set(k, r.verdict);
        }
        // the per-figure answers (claim figures and report-text figures alike), validated by code against the passages that were shown;
        // a later round replaces the entry for the same key, except that a "differs" is never replaced by a "matches"
        const fm = E.figureMeanings(figs, verdicts);
        E.mergeMeanings(meaningKeys, fm.keys);
        review = { label: reviewerLabel, rounds, counts: sum.counts || null, uncheckedIds: [], failed: '', unquoted, ...(revisionsDiscarded ? { revisionsDiscarded } : {}) };
        const st1 = settle();
        // the meaning marks are written into the report and the claims now, so an interrupted run delivers them too
        if (Object.keys(fm.keys).length) { try { runCheck(); saveChecked(); } catch (e) { if (gone(e)) throw e; checkFailed(); } }
        over();
        save({ rounds, reviewer: reviewerLabel, review, doubtedIds, unreviewedIds, doubtedKeys: st1.doubtedKeys, reviewedKeys: st1.reviewedKeys, sentKeys: [...sentKeys], meaningKeys: { ...meaningKeys } });
        const flagged = verdicts.results.filter((r) => r.verdict === 'not_supported' || r.verdict === 'partly');
        if (!flagged.length) break;
        let revised = null;
        try {
          const text = await worker(E.reviseBrief(run.question, rawProse, rawClaims, verdicts, fm.differs), own, 'Revision');
          const p = E.parseClaims(text);
          if (!p.error && p.claims.length) revised = p;
        } catch (e) { if (gone(e)) throw e; }
        if (!revised) {
          // the doubted claims stay doubted (by key): reported as doubted, never as key evidence
          miss(`challenge (round ${round}: the report could not be revised; ${flagged.length} claims the reviewer doubted were kept as they were)`);
          for (const f of flagged) { const c = claims.find((x) => x.id === f.id); unresolved.push(`${f.id}${c ? ': ' + c.claim : ''} (reviewer: ${f.verdict.replace('_', ' ')}${f.reason ? ', ' + f.reason : ''})`); }
          break;
        }
        // a revision cannot drop or change a claim the round confirmed (supported) or could not check: if it does, it is discarded whole
        const mustStay = verdicts.results.filter((r) => r && (r.verdict === 'supported' || r.verdict === 'cannot_check')).map((r) => rawClaims.find((c) => String(c.id) === String(r.id))).filter(Boolean);
        if (mustStay.some((o) => !revised.claims.some((n) => sameClaimEntry(o, n)))) {
          revisionsDiscarded++;
          review = { ...review, revisionsDiscarded };
          miss(`challenge (round ${round}: the revision dropped or changed claims the review had not doubted, so it was discarded; ${flagged.length} claims the reviewer doubted were kept as they were)`);
          for (const f of flagged) { const c = claims.find((x) => x.id === f.id); unresolved.push(`${f.id}${c ? ': ' + c.claim : ''} (reviewer: ${f.verdict.replace('_', ' ')}${f.reason ? ', ' + f.reason : ''})`); }
          break;
        }
        rawProse = revised.prose; rawClaims = revised.claims;
        try { runCheck(); saveChecked(); } catch (e) { if (gone(e)) throw e; checkFailed(); }
        // the claims changed: who is doubted and who is not yet reviewed is saved again, for a run that is cut short
        const st2 = settle();
        over();
        save({ review, doubtedIds, unreviewedIds, doubtedKeys: st2.doubtedKeys, reviewedKeys: st2.reviewedKeys, sentKeys: [...sentKeys], meaningKeys: { ...meaningKeys } });
      }
      if (rounds > 0) finish('challenge');
    } else if (settings.reviewRounds > 0) {
      miss(rawClaims.length ? 'challenge (no source was opened in full, so there was nothing to check the claims against)' : 'challenge (there were no claims to check)');
    }
    // after the last round a claim that is new or changed since it was reviewed is not reviewed: listed, never key evidence
    const fin = settle();
    if (unresolved.length) prose += E.markUnverified(`\n\n## Not settled by the review\n\n${unresolved.map((x) => '- ' + x).join('\n')}`);
    if (review.failed || rounds > 0) save({ review, doubtedIds, unreviewedIds, doubtedKeys: fin.doubtedKeys, reviewedKeys: fin.reviewedKeys, sentKeys: [...sentKeys], meaningKeys: { ...meaningKeys } });
    // the sources the helpers cited that were not read in full: a section of the report (so of the document), its figures marked not checked
    let alsoFound = 0;
    try {
      const also = E.alsoFoundSection(parts, firstPass, fetched);
      if (also.count) { prose += '\n\n' + E.markUnverified(also.markdown); alsoFound = also.count; }
    } catch { /* no such section */ }

    // ---- the document
    let files = {};
    over();
    setStage('document', 0, 1);
    try {
      if (typeof writeDocument !== 'function') throw new Error('no document writer is available');
      const doc = T.renderDocument({ question: run.question, preparedDate: localDate(now()), prose, claims, sources: fetched, proseMissed: totals && totals.proseMissed, reviewRounds: rounds, firstPass });
      files = (await writeDocument(run.agent, T.fileBase(run.question, localDate(now())), doc)) || {};
      finish('document');
    } catch (e) { if (gone(e)) throw e; miss(`document (${why(e)})`); }
    over();
    save({ files, prose: capText(prose, PROSE_MAX) });
    setStage('document', 1, 1);

    return E.chatReport({ question: run.question, prose, claims, totals, notChecked, checkError, reviewer: rounds > 0 ? reviewerLabel : '', rounds, review: review.rounds > 0 || review.failed ? review : undefined, doubtedIds, unreviewedIds, files, missing: run.missing, level: 'thorough', alsoFound });
  }

  // The lead engine's part of a Thorough run (the fixed stages do not run).
  async function leadBranch({ run, signal, cx, settings, firstPass, findingsText, own, helper, over, admit, worker, save, setStage, miss, gone, why }) {
    if (typeof leadModels !== 'function') throw new Error('the lead engine has no model chooser here');
    const models = await leadModels(run.agent);
    if (!models || typeof models !== 'object') throw new Error('the lead engine got no models');
    over();
    // second, independent check: content that must stay on its own service never reaches a model of another vendor
    const kept = (() => { try { return typeof keptOnBox !== 'function' || keptOnBox(run.agent) !== false; } catch { return true; } })();
    if (kept) {
      const all = [models.lead, models.reader, models.readerTop, ...(Array.isArray(models.reviewers) ? models.reviewers.map((r) => r && r.model) : [])].filter(Boolean);
      if (all.some((m) => m !== own)) throw new Error("the research models must stay on the agent's own service");
    }
    // kept content goes to the agent's own model exactly (not merely its vendor), looked at again at the moment of dispatch
    const keptAllows = (model) => {
      const keptNow = (() => { try { return typeof keptOnBox !== 'function' || keptOnBox(run.agent) !== false; } catch { return true; } })();
      return !keptNow || model === own;
    };
    const REFUSED_KEPT = "refused: this agent's content must stay on its own service";
    const playbook = leadPlaybook();
    const dir = leadDir(run.id);
    const reviewOff = !(settings.leadReviewRounds > 0);
    const used = reviewOff ? { ...models, reviewers: [] } : models;
    save({ leadPaths: models.paths || {}, leadDir: dir, leadModels: used });
    setStage('lead', 0, settings.leadSteps, 'lead: starting');
    // one worker of the lead's: the same launcher as the readers (pacing, admit, the kept-on-service rule), the tools of the call as given
    const dispatch = async (task, model, label, tools) => {
      if (!keptAllows(model)) throw new Error(REFUSED_KEPT);
      let refused = false;   // the launcher asks admit() as the worker is about to start, after its own waits: kept is read again then
      const r = outcomes(await spawn(run.agent, [{ task, model, tools, label }], signal, { admit: () => { if (!admit()) return false; if (!keptAllows(model)) { refused = true; return false; } return true; } }))[0];
      if (refused) throw new Error(REFUSED_KEPT);
      if (!r || !r.text.trim()) throw new Error('no reply');
      if (!r.ok) throw new Error('it did not finish: ' + r.text.slice(0, 160));
      return r.text.trim();
    };
    // the lead's web search: the hub's own search first; when that fails or finds nothing, one search worker (it has its own web search)
    const leadSearch = async (query, meter, opts) => {
      let hubErr = '';
      const freshness = opts && opts.freshness;
      try {
        const res = typeof search === 'function' ? await search(query, { freshness }) : null;
        if (Array.isArray(res) && res.length) return Object.assign(res.slice(), { via: 'hub search' });
      } catch (e) { if (gone(e)) throw e; hubErr = why(e); }
      const task = `Search the web for: ${query}${freshness === 'year' ? ' (from the last year only)' : ''}. Answer with JSON only: {"results":[{"title":"...","url":"https://...","snippet":"..."}]} with up to 10 results, real URLs only, no commentary.`;
      let reply = '';
      try { reply = await dispatch(task, helper, 'Lead search', 'read'); } catch (e) {
        if (meter && typeof meter.worker === 'function') meter.worker(task.length, 0);
        if (gone(e)) throw e;
        throw new Error(`the hub search ${hubErr ? `failed (${hubErr})` : 'found nothing'} and the search worker failed: ${why(e)}`);
      }
      if (meter && typeof meter.worker === 'function') meter.worker(task.length, reply.length);
      const parsed = Lead.firstJson(reply, (v) => Array.isArray(v) || (v && typeof v === 'object' && Array.isArray(v.results)));
      const list = parsed.value ? (Array.isArray(parsed.value) ? parsed.value : parsed.value.results) : [];
      const results = list.filter((r) => r && typeof r === 'object' && /^https?:\/\//i.test(String(r.url || '').trim()))
        .slice(0, 10).map((r) => ({ title: String(r.title || ''), url: String(r.url).trim(), snippet: String(r.snippet || '') }));
      return Object.assign(results, { via: 'search worker' });
    };
    // the lead's reads may fetch bigger PDFs than the default 4 MB: the setting leadPdfMaxMB (the fetch clamps it to 4..64 MB)
    const leadFetchPage = (url, o) => fetchPage(url, { ...(o || {}), maxBytes: settings.leadPdfMaxMB * 1048576 });
    const startedAt = now();
    const result = await Lead.runLead({
      run: { id: run.id, agent: run.agent, question: run.question, subQuestions: run.subQuestions },
      firstPass, findingsText,
      playbook: reviewOff ? `${playbook}\n\nREVIEW IS OFF for this run: do not use the review action; it will be refused.` : playbook,
      settings: { leadSteps: settings.leadSteps, wallMinutes: settings.leadWallMinutes, readerCalls: settings.leadReaderCalls, reviewRounds: reviewOff ? 1 : settings.leadReviewRounds, topicSearchesMin: settings.leadTopicSearches, sourcesPerSubMin: settings.leadSourcesPerSub, topNewPerSub: settings.leadTopNewPerSub, readerTextMax: settings.leadReaderTextMax, readerTopTextMax: settings.leadReaderTopTextMax },
      models: used,
      deps: {
        // the kept-on-service setting is looked at again before every worker (it can change during hours): strict, anything but false is kept
        spawn: (task, model, label) => dispatch(task, model, label, 'none'),
        search: leadSearch,
        fetchSources: (list) => E.fetchSourceTexts(list, { fetchPage: leadFetchPage, signal }),
        dir, now,
        runStartedAt: run.startedAt,   // the lead's wall clock counts from the run's start: the quick pass is part of it
        isDead: () => cx.dead || !!(signal && signal.aborted) || whoNow(run) !== 'same',
        preparedDate: localDate(now()),
        onProgress: ({ label, counts }) => { try { setStage('lead', counts.steps, settings.leadSteps, `${label} · ${counts.opens} sources opened · ${counts.readerCalls} reads · review round ${counts.reviewRounds}`); } catch { /* never throws */ } },
      },
    });
    over();
    let markdown = String(result.markdown || '');
    if (firstPass && firstPass.trim()) markdown += QUICK_PASS_HEADING + firstPass;
    let files = {};
    setStage('lead', result.counts ? result.counts.steps : 0, settings.leadSteps, 'writing the document');
    try {
      if (typeof writeDocument !== 'function') throw new Error('no document writer is available');
      files = (await writeDocument(run.agent, T.fileBase(run.question, localDate(now())), { markdown, html: leadHtml(markdown) })) || {};
    } catch (e) { if (gone(e)) throw e; miss(`document (${why(e)})`); }
    over();
    save({ files, prose: capText(markdown, PROSE_MAX), leadCounts: result.counts, leadCeiling: result.ceiling, leadModels: used });
    const elapsed = result.state && Number.isFinite(result.state.elapsedMs) ? result.state.elapsedMs : now() - startedAt;
    return leadReport({ summary: result.summary, ceiling: result.ceiling, openPoints: result.openPoints, counts: result.counts, files, paths: models.paths, models: used, elapsedMinutes: elapsed / 60000, missing: run.missing });
  }

  /** A lead run that stopped: the salvage of its folder, written as the document (best effort), as the message to the agent. */
  async function leadStopped(run, reason) {
    let salv;
    try { salv = Lead.salvageLead({ dir: run.leadDir, question: run.question, preparedDate: localDate(now()), reason, firstPass: run.firstPass || '' }); } catch { salv = { markdown: '', summary: `This report stopped early: ${reason}.`, openPoints: [] }; }
    let markdown = String(salv.markdown || '');
    if (run.firstPass && run.firstPass.trim() && !markdown.includes('What the quick pass said')) markdown += QUICK_PASS_HEADING + run.firstPass;
    let files = {};
    const missing = [];
    // the document goes into the Files folder of the agent the run was for, and only when that is still the same agent (a
    // re-made agent of the same name has another identity); otherwise it stays in the run folder
    const who = whoNow(run);
    if (who !== 'same') missing.push(`document (kept in the run folder only: ${who === 'other' ? REPLACED : 'could not confirm the agent it was for'})`);
    else {
      try {
        if (typeof writeDocument !== 'function') throw new Error('no document writer is available');
        files = (await writeDocument(run.agent, T.fileBase(run.question, localDate(now())), { markdown, html: leadHtml(markdown) })) || {};
      } catch (e) { missing.push(`document (${String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160)})`); }
    }
    // what the lead's folder knew of the run (its counts, its models) and why it stopped are kept on the run record
    Object.assign(run, { files, prose: capText(markdown, PROSE_MAX), leadCeiling: String(reason || '') });
    if (salv.counts) run.leadCounts = salv.counts;
    if (salv.models) run.leadModels = salv.models;
    persist();
    const body = leadReport({ summary: salv.summary, ceiling: '', openPoints: salv.openPoints, counts: run.leadCounts || {}, files, paths: run.leadPaths, models: run.leadModels || null, elapsedMinutes: Math.max(0, (now() - (run.startedAt || now())) / 60000), missing });
    const pts = (salv.openPoints || []).map((x) => `- ${x}`).join('\n');
    const text = [`The run stopped: ${reason}.`, '', capText(markdown, PARTIAL_BODY_MAX), '', pts ? `Open points:\n${pts}\n` : '', body].join('\n');
    return reportMessage({ id: run.id, question: run.question, report: text, level: 'thorough' });
  }

  async function execute(run) {
    let message;
    const thorough = run.level === 'thorough';
    let st = null;
    if (thorough) { try { st = thoroughSettings ? thoroughSettings() : null; } catch { st = null; } }
    const limitMs = thorough ? Math.round(thoroughLimitMinutes(st) * 60000) : deadlineMs;
    const limitText = thorough ? `the time limit of ${+(limitMs / 60000).toFixed(2)} minutes was reached` : '';
    const ac = new AbortController();
    const cx = { dead: false };
    let timer = null;
    let timedOut = false;
    try {
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; try { ac.abort(); } catch { /* ignore */ } reject(new Error(`it took longer than ${Math.round(limitMs / 60000)} minutes`)); }, limitMs);
        if (timer && timer.unref) timer.unref();
      });
      const report = await Promise.race([research(run, ac.signal, cx, st), deadline]);
      message = reportMessage({ id: run.id, question: run.question, report, level: run.level });
    } catch (e) {
      cx.dead = true;
      const reason = String((e && e.message) || e || 'unknown error').slice(0, 300);
      // a Thorough run that got somewhere is never an error dressed as a report, and never nothing: what it saved is delivered
      if (thorough && run.leadDir) {
        try { message = await leadStopped(run, timedOut ? limitText : reason); } catch { message = reportMessage({ id: run.id, question: run.question, failed: reason }); }
      } else if (thorough && (timedOut || (run.findings && run.findings.length))) {
        message = reportMessage({ id: run.id, question: run.question, report: partialReport(run, timedOut ? limitText : `it stopped: ${reason}`), level: 'thorough' });
      } else message = reportMessage({ id: run.id, question: run.question, failed: reason });
    } finally { cx.dead = true; fetchedLive.delete(run.id); if (timer) clearTimeout(timer); }
    await deliver(run, message);
  }

  return {
    start,
    recover,
    list: () => [...runs.values()].map(copy),
    get: (id) => (runs.has(id) ? copy(runs.get(id)) : null),
    hasTexts: (id) => fetchedLive.has(id),   // tests: the in-memory source texts of a run
  };
}

module.exports = { leadReport, thoroughLimitMinutes, ALWAYS_LEVEL_REFUSED, TOOL, REMIND_LINE, LEVELS, costLine, cardFor, decide, offerText, setText, vendorOf, chooseHelperModel, chooseReviewer, helperBrief, synthesisBrief, reportMessage, createResearchRunner };
