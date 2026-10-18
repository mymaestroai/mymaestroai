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
  assert.match(app, /function enterReattach\(chatId, msgId, content, partialText, reason, since = null\)/);
  assert.match(app, /chat\.reattach = \{ msgId, content, since, partial/);
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
  assert.match(m, /function enterReattach\(agent, text, bubble, partialHtml, partial, since = null\)/);
  assert.match(m, /if \(ra\.text\) for \(let i = hist\.length - 1; i >= 0; i--\)/);
  assert.match(m, /\} else if \(!ra\.text && ra\.since\) \{/);
  assert.match(m, /if \(stillBusy === true \|\| reply\.inProgress\) \{[^\n]*\n\s*\/\/ Still working/);
  assert.match(m, /if \(ui < 0 && ra\.text\) \{/);
  assert.match(read('sw.js'), /const VERSION = 'hub-mobile-v44'/);
});

test('a chat opened while its agent is mid-turn (reload, or reopened from the sidebar) follows the turn at once', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(app.includes("chats[chatId].historyLoaded.then(() => { if (chats[chatId]) pollAgentStatus(); });"), 'startSoloChat asks the hub for live status once history is in');
  assert.match(app, /function applyStatusSnapshot\(map\) \{[\s\S]{0,700}if \(s\.busy\) reattachIfIdle\(name, s\.busySince \|\| null\);/, 'a busy agent in the snapshot re-attaches its open chat (dot, Interject, live feed)');
});
