'use strict';
// A dropped or cancelled live stream keeps the reply's own text, never the bubble's textContent: that also held the
// reasoning panel (its "Reasoning", word count, "thinking…", ⤢ and "show" labels and the whole reasoning text) and the
// tool panel, which then showed as reply text until the real reply came in (owner report 2026-11-20). The helpers are
// sliced out of app.js and run against a small stand-in DOM; the source checks pin where they are used.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const mjs = fs.readFileSync(path.join(root, 'mobile.js'), 'utf8');
const BEGIN = '// ── live reply text (begin) ──';
const END = '// ── live reply text (end) ──';

// A minimal element tree: classes, children, text; cloneNode(true), querySelectorAll('.a, .b'), remove(), textContent.
class El {
  constructor(cls = '', text = '') { this.cls = cls.split(/\s+/).filter(Boolean); this.text = text; this.children = []; this.parent = null; }
  add(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } return this; }
  get textContent() { return this.text + this.children.map((c) => c.textContent).join(''); }
  cloneNode() { const c = new El(this.cls.join(' '), this.text); c.add(...this.children.map((k) => k.cloneNode(true))); return c; }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((k) => k !== this); this.parent = null; } }
  querySelectorAll(sel) {
    const want = sel.split(',').map((s) => s.trim().replace(/^\./, ''));
    const out = [];
    const walk = (n) => { for (const k of n.children) { if (k.cls.some((c) => want.includes(c))) out.push(k); walk(k); } };
    walk(this);
    return { forEach: (fn) => out.forEach(fn) };
  }
}
const REASONING = "I'm checking the thinnest edge, which is 1 inch at the front.\n\nI'm confirming the facing target.";
// The live bubble as paintReasoning and the tool panel build it, with the reply text after them.
function liveBubble(reply) {
  const rs = new El('reason-stream live collapsed').add(
    new El('rs-head').add(new El('rs-dot'), new El('rs-label', 'Reasoning'), new El('rs-count', '· 1,238 words'), new El('rs-status', 'thinking…'), new El('rs-full', '⤢'), new El('rs-toggle', 'show')),
    new El('rs-body', REASONING), new El('rs-grip'));
  const tools = new El('tool-stream').add(new El('ts-head', 'Tools · 6 done 1 failed'));
  const msg = new El('message assistant').add(rs, tools);
  if (reply) msg.add(new El('step-text', reply));
  msg.add(new El('live-activity', 'Working · 4 min'), new El('token-usage', '12k tokens'), new El('msg-time', '10:25 AM'));
  return msg;
}
function load(dom) {
  const a = app.indexOf(BEGIN), b = app.indexOf(END);
  assert.ok(a > 0 && b > a, 'helper markers present');
  const ctx = vm.createContext({ Map, document: { getElementById: (id) => dom[id] || null } });
  vm.runInContext(`${app.slice(a, b)}; this.liveReplyText = liveReplyText; this.noteLiveReply = noteLiveReply; this.dropLiveReply = dropLiveReply;`, ctx);
  return ctx;
}

test('the old way reproduced: the bubble\'s textContent carries the panel labels and the reasoning text', () => {
  const t = liveBubble('Here is the plan.').textContent;
  assert.ok(t.startsWith('Reasoning· 1,238 wordsthinking…⤢show'), t.slice(0, 60));   // what the owner saw as reply text
  assert.ok(t.includes(REASONING));
});

test('partialReplyText: the text the stream received, never the panels\' text', () => {
  const C = load({ m1: liveBubble('Here is the') });
  C.noteLiveReply('m1', 'Here is the **plan**');
  assert.strictEqual(C.partialReplyText('m1'), 'Here is the **plan**', 'the stream\'s own text (with its Markdown)');
  C.noteLiveReply('m2', '');
  assert.strictEqual(C.partialReplyText('m2'), '', 'nothing written yet: nothing kept');
  C.dropLiveReply('m1');
  assert.strictEqual(C.liveReplyText.has('m1'), false);
});

test('partialReplyText without stream text: the message\'s own text, without the panels, buttons and status lines', () => {
  const C = load({ m1: liveBubble('Here is the plan.'), m2: liveBubble(''), m3: new El('message assistant', '⏳ Thinking...') });
  assert.strictEqual(C.partialReplyText('m1'), 'Here is the plan.');
  assert.strictEqual(C.partialReplyText('m2'), '', 'only panels: no reply text');
  assert.strictEqual(C.partialReplyText('m3'), '⏳ Thinking...', 'the placeholder, which the callers drop');
  assert.strictEqual(C.partialReplyText('missing'), '');
  for (const id of ['m1', 'm2']) {
    const own = C.partialReplyText(id);
    assert.ok(!/Reasoning|thinking…|⤢|show|Tools|checking the thinnest edge/.test(own), own);
  }
});

test('the dropped-stream and cancel paths use partialReplyText; no partial reply is read from a bubble\'s textContent', () => {
  const uses = app.match(/const existing = partialReplyText\(msgId\);/g) || [];
  assert.strictEqual(uses.length, 2, 'the cancel path and the dropped-stream path');
  assert.doesNotMatch(app, /msgEl \? msgEl\.textContent : ''/);
  assert.match(app, /const partialText = existing && existing !== '⏳ Thinking\.\.\.' && existing !== '🔄 Reconnecting\.\.\.' \? existing : '';\s*const isConnectionLoss/);
});

test('streamResponseSolo keeps liveReplyText current on every reply delta and drops it when the stream ends', () => {
  const a = app.indexOf('async function streamResponseSolo(');
  assert.ok(a > 0);
  const body = app.slice(a, app.indexOf('\n    }\n', app.indexOf('return { text: fullResponse, images, toolActivity, partial, steps };', a)));
  assert.match(body, /fullResponse \+= delta;\s*displayContent \+= delta;\s*noteLiveReply\(msgId, fullResponse\);/);
  assert.match(body, /dropLiveReply\(msgId\);\s*if \(!fullResponse\) fullResponse = '\[No response\]';/);
  assert.strictEqual((app.match(/const existing = partialReplyText\(msgId\);[^\n]*\n\s*dropLiveReply\(msgId\);/g) || []).length, 2, 'both error paths drop it after use');
});

test('the phone keeps its tracked reply text for a dropped stream (rec.full), not the bubble\'s text', () => {
  assert.match(mjs, /enterReattach\(agent, text, rec\.bubble, rec\.gotAny \? rec\.bubble\.body\.innerHTML : '', rec\.full, null, rec\.startedAt\);/);
  assert.doesNotMatch(mjs, /\.textContent : ''\)?;?\s*\n\s*(const|let) partial/);
});
