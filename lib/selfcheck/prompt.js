'use strict';
// The scripted text of a check turn. It is the hub's own words and has no outside input: only paths and nonces the hub made.
const path = require('path');

const ACTIONS = ['read', 'image', 'write', 'edit', 'glob', 'grep', 'bash'];
const FOLDERS = ['install', 'home'];
const REFUSE_STEP = ACTIONS.length * FOLDERS.length + 1;   // 15: installs first (1-7), home next (8-14), the refused read last

/** The steps in order: [{ n, folder, action }], and { n: 15, folder: null, action: 'refuse' }. */
function stepTable() {
  const out = [];
  FOLDERS.forEach((folder, fi) => ACTIONS.forEach((action, k) => out.push({ n: fi * ACTIONS.length + k + 1, folder, action })));
  out.push({ n: REFUSE_STEP, folder: null, action: 'refuse' });
  return out;
}
/** Step number of an action key ('write@home', 'refuse'). */
function stepOf(key) {
  const row = stepTable().find(s => (s.folder ? `${s.action}@${s.folder}` : s.action) === key);
  return row ? row.n : null;
}

/** The one command the Bash step asks for. Kept so verification can compare it exactly. */
function scriptedBash(folder, B) {
  // Single-quoted, so a hub home with a space in it (a Mac's "Application Support") still names one file.
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  return `printf %s ${B} > ${q(path.join(folder, 'bash.txt'))}`;
}

function stepLine(n, s, folders, fixtures, refusePath) {
  if (s.action === 'refuse') return `${n}. Read ${refusePath} with the Read tool.`;
  const dir = folders[s.folder], f = fixtures[s.folder];
  switch (s.action) {
    case 'read': return `${n}. Read ${path.join(dir, 'read.txt')} with the Read tool.`;
    case 'image': return `${n}. Read ${path.join(dir, 'code.png')} with the Read tool and give the 4 digits in the picture.`;
    case 'write': return `${n}. Write ${path.join(dir, 'write.txt')} with the Write tool, content exactly "${f.W}".`;
    case 'edit': return `${n}. Read ${path.join(dir, 'edit.txt')} with the Read tool, then use the Edit tool to change "before-${f.E}" to "after-${f.E}".`;
    case 'glob': return `${n}. Glob with the Glob tool, pattern "*.txt" in ${path.join(dir, 'glob')}.`;
    case 'grep': return `${n}. Grep with the Grep tool for "selfcheck-key" in ${path.join(dir, 'grep')}.`;
    case 'bash': return `${n}. Bash: run exactly \`${scriptedBash(dir, f.B)}\``;
    default: return '';
  }
}

/** promptFor({ folders: { install, home }, fixtures: { install, home }, refusePath, steps }) -> the turn's text.
 *  steps: the step numbers to ask for (the retry turn); all of them when left out. */
function promptFor({ folders, fixtures, refusePath, steps }) {
  const want = Array.isArray(steps) && steps.length ? new Set(steps) : null;
  const lines = stepTable().filter(s => !want || want.has(s.n)).map(s => stepLine(s.n, s, folders, fixtures, refusePath));
  return [
    'This is an automatic check run by the hub. Do each numbered step below, in order.',
    'Use exactly the tool named in each step, and no other tool for that step.',
    'If a tool is refused, say so and go on to the next step. Do not retry a refused step another way.',
    '',
    ...lines,
    '',
    'Reply with one line per step: "<n>. done" or "<n>. refused: <why>". For a picture step, put the 4 digits on its line, like "<n>. done 1234".',
  ].join('\n');
}

module.exports = { promptFor, stepTable, stepOf, scriptedBash, ACTIONS, FOLDERS, REFUSE_STEP };
