'use strict';
// A turn the hub starts (a schedule, a job notice or report) must not take the screen:
// only the person's own actions switch the active chat.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Text of `[async] function name(...) { ... }`, up to the matching closing brace.
function bodyOf(name) {
  const m = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(src);
  assert.ok(m, `function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', src.indexOf('(', m.index)) + 1);   // the body brace, after the parameter list
  return src.slice(m.index, matchingBrace(src, open) + 1);
}
function matchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

const solo = bodyOf('startSoloChat');
const turnStart = bodyOf('onHubTurnStart');
const turnEnd = bodyOf('onHubTurnEnd');

test('onHubTurnStart opens the window in the background and never switches', () => {
  assert.match(turnStart, /startSoloChat\([^)]*\{\s*background:\s*true\s*\}\s*\)/);
  assert.doesNotMatch(turnStart, /switchToChat\(/);
});

test('the hub-turn end handler never switches (job reports included)', () => {
  assert.match(turnEnd, /job report|Hub turns/i);   // the comment is there to explain why
  assert.doesNotMatch(turnEnd, /switchToChat\(/);
  assert.match(turnEnd, /markTabUnread\(/);
});

test('startSoloChat takes the screen only when not in the background', () => {
  assert.match(solo, /\{\s*background\s*=\s*false\s*\}\s*=\s*\{\}/);
  // Ranges covered by `if (!background) { ... }` blocks.
  const blocks = [];
  const re = /if\s*\(\s*!background\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(solo))) blocks.push([m.index, matchingBrace(solo, m.index + m[0].length - 1)]);
  const guarded = (at) => {
    if (blocks.some(([a, b]) => at > a && at < b)) return true;
    const line = solo.slice(solo.lastIndexOf('\n', at) + 1, solo.indexOf('\n', at));   // or a one-line `if (!background) call();`
    return /if\s*\(\s*!background\s*\)/.test(line.slice(0, at - (solo.lastIndexOf('\n', at) + 1)));
  };
  const risky = [/switchToChat\(/g, /closeSidebarOnMobile\(/g, /getElementById\('empty-state'\)/g];
  for (const pattern of risky) {
    const hits = [...solo.matchAll(pattern)];
    assert.ok(hits.length > 0, `${pattern} no longer appears in startSoloChat: update this test`);
    for (const h of hits) assert.ok(guarded(h.index), `${pattern} at offset ${h.index} is not under if (!background)`);
  }
});

test('a tab that changed while it was not on screen opens at its newest message', () => {
  const sw = bodyOf('switchToChat');
  assert.match(sw, /wasUnread = [^;]*classList\.contains\('unread'\)/);
  assert.match(sw, /if \(wasUnread\) \{.*scrollTop = m\.scrollHeight/);
});
