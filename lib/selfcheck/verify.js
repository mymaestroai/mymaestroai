'use strict';
// What the hub saw during a check turn, turned into one verdict per action. Pure: events, the reply and a file reader in,
// verdicts out. Nothing here believes the model's word alone.
const path = require('path');
const { ACTIONS, FOLDERS } = require('./prompt');

const norm = (t) => String(t || '').replace(/^mcp__hub__/, '');
const abs = (p) => (typeof p === 'string' && p ? path.resolve(p) : null);
const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
const READ_ONLY = new Set(['Read', 'Glob', 'Grep']);

const R = {
  none: "The agent didn't do it.",
  other: 'It was done another way: the %TOOL% tool itself did not work.',
  ranWrong: 'The tool ran but returned something else.',
  fileWrong: 'The tool ran, but the file was not changed as asked.',
  noRules: "The tool ran, but your Maestro's rules were not asked first.",
};
const denied = (why) => `Refused by your Maestro's safety rules: ${why || 'no reason given'}`;
const clientRefused = (who) => `Your Maestro's rules allowed it, but ${who} refused it.`;

/** Paths a shell command writes (redirections, and the operands of cp, mv, tee, touch, mkdir, rm and friends).
 *  Not a classifier: it only has to find where a command could put a file. */
function shellWritePaths(command, cwd) {
  const { scanCommand, segmentWords } = require('../shell-scan');
  const text = String(command || '');
  const out = new Set();
  let segs;
  try { const scan = scanCommand(text); segs = scan.segments && scan.segments.length ? scan.segments : text.split(/[\n;&|]+/); } catch { segs = text.split(/[\n;&|]+/); }
  const put = (p) => { if (p && typeof p === 'string' && !/^[-&]/.test(p)) out.add(path.resolve(cwd || '/', p)); };
  for (const seg of segs) {
    let words; try { words = segmentWords(seg); } catch { words = String(seg).split(/\s+/); }
    for (let i = 0; i < words.length; i++) {
      const m = /^(?:\d*|&)(>>?\|?)(.*)$/.exec(words[i]);
      if (m && !/^[<]/.test(words[i])) { if (m[2]) put(m[2]); else if (words[i + 1]) put(words[i + 1]); }
    }
    const cmd = words.findIndex(w => !/^\w+=/.test(w) && !/^\d*[<>]/.test(w));
    const prog = cmd >= 0 ? path.basename(words[cmd]) : '';
    if (['cp', 'mv', 'tee', 'touch', 'mkdir', 'rm', 'rmdir', 'install', 'ln', 'truncate', 'sed', 'dd'].includes(prog)) {
      for (const w of words.slice(cmd + 1)) {
        if (/^of=/.test(w)) put(w.slice(3));
        else if (!/^-/.test(w) && !/^\d*[<>]/.test(w) && /[/.]/.test(w)) put(w);
        else if (!/^-/.test(w) && !/^\d*[<>]/.test(w) && ['tee', 'touch', 'mkdir', 'rm', 'rmdir'].includes(prog)) put(w);
      }
    }
  }
  return [...out];
}

/** verifyClass -> { actions: { '<action>@<folder>': { ok, reason, tried }, refuse: {...} }, extra: [{ tool, path }] }. */
function verifyClass({ events = [], reply = '', fixtures, folders, refusePath, scriptedBash, readFile, bashWritePaths = () => [], clientTools = false }) {
  const evs = events.filter(e => e && typeof e === 'object').map(e => ({ ...e, tool: norm(e.tool), input: e.input && typeof e.input === 'object' ? e.input : {} }));
  const decisions = evs.filter(e => e.type === 'decision');
  const results = evs.filter(e => e.type === 'result');
  const who = clientTools ? 'the Claude client' : 'the tool';
  const refuseAbs = abs(refusePath);
  const dirs = [folders.install, folders.home].map(abs);

  const filePath = (e) => abs(e.input.file_path);
  const dirOf = (e) => abs(e.input.path) || (typeof e.input.pattern === 'string' && path.isAbsolute(e.input.pattern) ? abs(path.dirname(e.input.pattern)) : null);
  const onFile = (tool, file) => (e) => e.tool === tool && filePath(e) === file;
  const onDir = (tool, dir) => (e) => {
    if (e.tool !== tool) return false;
    const d = dirOf(e);
    return !!d && inside(d, dir);
  };
  const onBash = (file) => (e) => e.tool === 'Bash' && typeof e.input.command === 'string' && e.input.command.includes(file);

  // The ladder of reasons. `match` picks the calls that belong to the step; `contentOk(result)` is whether a result has what was expected;
  // `fileOk()` is the check of the file on disk afterwards (null when the step has none).
  function judge(match, contentOk, fileOk, extraFail) {
    const ds = decisions.filter(match), rs = results.filter(match);
    if (extraFail) return { ok: false, reason: extraFail, tried: true };
    if (!ds.length && !rs.length) return { ok: false, reason: R.none, tried: false };
    const allow = ds.filter(d => d.decision === 'allow'), deny = ds.filter(d => d.decision === 'deny');
    const okRes = rs.filter(r => r.ok === true);
    if (!allow.length && deny.length) return { ok: false, reason: denied(deny[0].reason), tried: true };
    if (!allow.length) return { ok: false, reason: okRes.length ? R.noRules : denied((ds[0] && ds[0].reason) || 'it was held for approval'), tried: true };
    if (!okRes.length) return { ok: false, reason: clientRefused(who), tried: true };
    if (!okRes.some(contentOk)) return { ok: false, reason: R.ranWrong, tried: true };
    if (fileOk && !fileOk()) return { ok: false, reason: R.fileWrong, tried: true };
    return { ok: true, reason: '', tried: true };
  }

  // Another allowed tool touching a file the Write or Edit step owns: the Nov 10 fallback shape.
  function doneAnotherWay(file, ownTool) {
    return decisions.some(d => d.decision === 'allow' && d.tool !== ownTool && !READ_ONLY.has(d.tool) && (
      (d.tool !== 'Bash' && filePath(d) === file) ||
      (d.tool === 'Bash' && typeof d.input.command === 'string' && (
        d.input.command.includes(file) || bashWritePaths(d.input.command, folders.install).map(abs).includes(file) ||
        // the bare file name counts too, unless the command names the other folder (the same name lives there as well)
        (d.input.command.includes(path.basename(file)) && !dirs.filter(x => x !== path.dirname(file)).some(x => d.input.command.includes(x)))))));
  }

  const actions = {};
  for (const f of FOLDERS) {
    const dir = abs(folders[f]), fx = fixtures[f], key = (a) => `${a}@${f}`;
    const p = (name) => path.join(dir, name);
    const same = (v) => (readFile(p(v.file)) === v.want);
    actions[key('read')] = judge(onFile('Read', p('read.txt')), r => String(r.text || '').includes(fx.R));
    // The picture: the result only says the Read worked; the digits must be in the reply.
    const digits = new RegExp(`\\b${fx.D}\\b`).test(String(reply));
    actions[key('image')] = judge(onFile('Read', p('code.png')), () => digits);
    const w = doneAnotherWay(p('write.txt'), 'Write');
    actions[key('write')] = judge(onFile('Write', p('write.txt')), () => true, () => same({ file: 'write.txt', want: fx.W }), w ? R.other.replace('%TOOL%', 'Write') : null);
    const e = doneAnotherWay(p('edit.txt'), 'Edit');
    actions[key('edit')] = judge(onFile('Edit', p('edit.txt')), () => true, () => same({ file: 'edit.txt', want: `status: after-${fx.E}\n` }), e ? R.other.replace('%TOOL%', 'Edit') : null);
    actions[key('glob')] = judge(onDir('Glob', p('glob')), r => String(r.text || '').includes(`g-${fx.G}`));
    actions[key('grep')] = judge(onDir('Grep', p('grep')), r => String(r.text || '').includes(fx.K));
    // Bash: the command must be exactly the scripted one; a different one that names bash.txt is its own failure.
    const cmd = scriptedBash[f], bashMatch = onBash(p('bash.txt'));
    const ownBash = (x) => bashMatch(x) && x.input.command === cmd;
    const anyBash = decisions.some(bashMatch) || results.some(bashMatch);
    const wrongCmd = anyBash && !decisions.some(ownBash) && !results.some(ownBash);
    actions[key('bash')] = wrongCmd ? { ok: false, reason: 'It ran a different command than the one the check asked for.', tried: true }
      : judge(ownBash, () => true, () => readFile(p('bash.txt')) === fx.B);
  }

  // Refuse: a gate DENY on the call and no result that worked.
  const touches = (e) => abs(e.input.file_path) === refuseAbs || abs(e.input.path) === refuseAbs || JSON.stringify(e.input).includes(refusePath);
  const rds = decisions.filter(touches), rrs = results.filter(touches);
  if (!rds.length && !rrs.length) actions.refuse = { ok: false, reason: "The agent didn't try it.", tried: false };
  else if (rds.some(d => d.decision === 'allow') || rrs.some(r => r.ok === true)) actions.refuse = { ok: false, reason: "Your Maestro's safety rules let it read call recordings.", tried: true };
  else if (rds.some(d => d.decision === 'deny')) actions.refuse = { ok: true, reason: '', tried: true };
  else actions.refuse = { ok: false, reason: "Your Maestro's safety rules asked about it instead of refusing it.", tried: true };

  // Anything written outside both check folders.
  const extra = [], seen = new Set();
  const add = (tool, p) => { if (p && !seen.has(p)) { seen.add(p); extra.push({ tool, path: p }); } };
  for (const d of decisions) {
    if (d.decision !== 'allow') continue;
    if (d.tool === 'Write' || d.tool === 'Edit') {
      const p = filePath(d);
      if (p && !dirs.some(x => inside(p, x))) add(d.tool, p);
    } else if (d.tool === 'Bash' && typeof d.input.command === 'string') {
      for (const p of bashWritePaths(d.input.command, folders.install).map(abs)) if (p && !dirs.some(x => inside(p, x))) add('Bash', p);
    }
  }
  return { actions, extra };
}

module.exports = { verifyClass, shellWritePaths, ACTIONS, FOLDERS };
