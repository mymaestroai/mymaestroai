'use strict';
// A window or phone that loads (or wakes from a blank screen) while its agent is mid-turn on the
// server must follow that turn and show the reply when it lands, without a refresh. Source-level
// checks on app.js / mobile.js (the pages are not run here).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('desktop: a busy agent in the status snapshot re-attaches an idle open chat; history lookup anchors on the turn start', () => {
  const app = read('app.js');
  assert.match(app, /for \(const \[name, s\] of Object\.entries\(map\)\) if \(s\.busy\) reattachIfIdle\(name, s\.busySince \|\| null\);/);
  assert.match(app, /async function reattachIfIdle\(agentName, since\)/);
  assert.match(app, /if \(!chat \|\| chat\.controller \|\| chat\.reattach \|\| chat\.status === 'thinking'\) return;\s*if \(Object\.values\(hubTurns\)\.some\(t => t\.chatId === chat\.id\)\) return;/);
  assert.match(app, /enterReattach\(chat\.id, msgId, null, partial, '[^']+', since\)/);   // partial: that turn's text saved so far
  assert.match(app, /function enterReattach\(chatId, msgId, content, partialText, reason, since = null, sentAt = null\)/);
  assert.match(app, /chat\.reattach = \{ msgId, content, since, sentAt, partial/);
  // No user entry to anchor on -> newest assistant entry since the turn began
  assert.match(app, /if \(!reply && ui < 0 && ra\.since\) \{/);
  // While the agent is still busy an assistant entry is only the partial save: keep waiting
  assert.match(app, /if \(reply && \(stillBusy === true \|\| reply\.inProgress\)\) \{[^\n]*\n[^\n]*\n\s*if \(reply\.content && reply\.content\.length > \(ra\.partial \|\| ''\)\.length\) ra\.partial = reply\.content;/);
  // "hub never received this message" only applies when this window sent one
  assert.match(app, /if \(ui < 0 && ra\.content\) \{/);
});

test('mobile: same re-attach on snapshot and when opening a busy agent\'s chat; sw bumped', () => {
  const m = read('mobile.js');
  assert.match(m, /function reattachIfIdle\(agent, partial = ''\) \{/);
  assert.match(m, /if \(!agent \|\| !chatOpenFor\(agent\) \|\| streams\.has\(agent\) \|\| reattaches\.has\(agent\)\) return;/);
  assert.match(m, /enterReattach\(agent, null, addAssistantBubble\(\), '', partial, s\.busySince \|\| null\)/);
  assert.match(m, /if \(current && map\[current\] && map\[current\]\.busy && !Object\.values\(hubTurns\)\.some\(t => t\.agent === current\)\) reattachIfIdle\(current\);/);
  assert.match(m, /reattachIfIdle\(name, inProgress \? String\(inProgress\.content \|\| ''\) : ''\);[\s\S]{0,420}if \(parked\) \{ pendingQuestionsByAgent\.delete\(name\); showQuestion\(parked\); \}\s*paintChatStatus\(\);\s*scrollChat\(true\);/);
  assert.match(m, /function enterReattach\(agent, text, bubble, partialHtml, partial, since = null, sentAt = null\)/);
  assert.match(m, /const ui = ra\.text \? ownEntryIndex\(hist, ra\.text, ra\.sentAt \|\| ra\.startedAt, r\.headers\.get\('Date'\)\) : -1;/);
  assert.match(m, /\} else if \(!ra\.text && ra\.since\) \{/);
  assert.match(m, /if \(stillBusy === true \|\| reply\.inProgress\) \{[^\n]*\n\s*\/\/ Still working/);
  assert.match(m, /if \(ui < 0 && ra\.text\) \{/);
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v51'/);
});

test('a chat opened while its agent is mid-turn (reload, or reopened from the sidebar) follows the turn at once', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes("chats[chatId].historyLoaded.then(() => { if (chats[chatId]) pollAgentStatus(); });"), 'startSoloChat asks the hub for live status once history is in');
  assert.match(app, /function applyStatusSnapshot\(map\) \{[\s\S]{0,700}if \(s\.busy\) reattachIfIdle\(name, s\.busySince \|\| null\);/, 'a busy agent in the snapshot re-attaches its open chat (dot, Interject, live feed)');
});

// A send that never reached the hub (network drop) must not be matched to an identical earlier message:
// on 2026-10-18 a phone's "Build it" was lost and the page showed the reply to the morning's "Build it".
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} not found`);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return new Function(`${src.slice(start, i + 1)}; return ${name};`)();
}

test('a lost send only matches a history entry the hub saved after it left (desktop and phone)', () => {
  const app = read('app.js');
  const m = read('mobile.js');
  // The send time travels with the reattach record on both pages
  assert.match(app, /const sentAt = Date\.now\(\);/);
  assert.match(app, /enterReattach\(chatId, msgId, content, partialText, err\.message, null, sentAt\);/);
  assert.match(app, /const ui = ra\.content \? ownEntryIndex\(history, ra\.content, ra\.sentAt \|\| ra\.startedAt, r\.headers\.get\('Date'\)\) : -1;/);
  assert.match(m, /enterReattach\(agent, text, rec\.bubble, rec\.gotAny \? rec\.bubble\.body\.innerHTML : '', rec\.full, null, rec\.startedAt\);/);
  assert.doesNotMatch(app, /history\[i\]\.content === ra\.content/);
  assert.doesNotMatch(m, /hist\[i\]\.content === ra\.text/);

  const hist = [
    { role: 'user', content: 'Build it', ts: '2026-10-18T10:47:33.933Z' },
    { role: 'assistant', content: 'Building OpenRouter support…', ts: '2026-10-18T11:04:23.544Z' },
    { role: 'user', content: '[Resumed after compression, from the hub] …', ts: '2026-10-18T16:57:36.039Z' },
    { role: 'assistant', content: "I'm back after the context save.", ts: '2026-10-18T16:57:52.487Z' },
  ];
  const hubNow = Date.parse('2026-10-18T17:45:20Z');
  const hubDate = new Date(hubNow).toUTCString();   // what the Date header carries (whole seconds)
  for (const [page, src] of [['desktop', app], ['phone', m]]) {
    const ownEntryIndex = extractFn(src, 'ownEntryIndex');
    for (const skew of [0, 5 * 60000, -5 * 60000]) {   // this device's clock right, five minutes fast, five minutes slow
      const now = hubNow + skew;
      const sentAt = now - 4000;   // sent four seconds before the check
      // The hub never got it: the morning's identical "Build it" is not this message
      assert.strictEqual(ownEntryIndex(hist, 'Build it', sentAt, hubDate, now), -1, `${page} skew ${skew}: old message taken for the lost one`);
      // The hub did get it: its entry is found, not the older twin
      const got = [...hist, { role: 'user', content: 'Build it', ts: new Date(hubNow - 3500).toISOString() }];
      assert.strictEqual(ownEntryIndex(got, 'Build it', sentAt, hubDate, now), 4, `${page} skew ${skew}: own entry not found`);
      // A long turn whose stream dropped after twenty minutes: its entry is twenty minutes old and still matches
      const longTurn = [...hist, { role: 'user', content: 'Build it', ts: new Date(hubNow - 20 * 60000).toISOString() }, { role: 'assistant', content: 'partial', ts: new Date(hubNow - 60000).toISOString() }];
      assert.strictEqual(ownEntryIndex(longTurn, 'Build it', now - 20 * 60000 - 500, hubDate, now), 4, `${page} skew ${skew}: long turn lost its entry`);
    }
    // No Date header: the device clock is used, and the old twin is still refused
    assert.strictEqual(ownEntryIndex(hist, 'Build it', hubNow - 4000, null, hubNow), -1);
    // An entry without a time can't be proven new
    assert.strictEqual(ownEntryIndex([{ role: 'user', content: 'Build it' }], 'Build it', hubNow - 4000, hubDate, hubNow), -1);
  }
});
