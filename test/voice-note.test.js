'use strict';
// Voice turns get a note: a short spoken answer first, detail in the chat. The pages send voice: true in the body of
// POST /api/chat/stream for turns started by voice; handleChatStreamReserved hands it to the three routes (gateway, Claude
// client, Codex client), and each adds VOICE_NOTE only when voice is true and the turn is not ephemeral.
// The routes need a model and a live hub, so these are checks of the source, as for the other prompt-building tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
// lib/ comes from a throwaway install (test/helpers/isolated-install.js), so nothing under the real data/ is touched.
const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('voice-note-iso-');
const L = (p) => require(path.join(ISO.lib, p));

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
const lineOf = (needle, from = 0) => { const i = src.indexOf(needle, from); assert.ok(i >= 0, `missing: ${needle}`); return i; };

// Strengthened (voice fixes round 1): the owner heard dashes and symbols read out, so the note now says what the spoken part
// must not contain; the old exact-text pin is replaced by this one.
// Changed on purpose (owner, 2026-11-13: agents should not put out tables when talking through voice): on a call the agent speaks
// plainly and writes nothing for the screen; detail is offered for the chat after the call.
test('VOICE_NOTE is the agreed text: plain conversational speech only, no written part during the call', () => {
  const { VOICE_NOTE } = L('sdk-chat');
  assert.strictEqual(VOICE_NOTE, 'This is a voice conversation: reply in plain conversational speech only, in one to three short sentences unless the person asks for more, written to be heard, with numbers, dates and times written the way you would say them. Your replies must not contain tables, lists, headings, code, file paths, links, ids, symbols or emoji (an optional mood word, when one is asked for below, is the only exception) or a separate written part; this is about what you say, so use your tools for the work as usual. If the answer really needs detail on screen, say so in one sentence and offer to put it in the chat after the call; do not write it during the call.');
  for (const w of ['plain conversational speech only', 'one to three short sentences', 'numbers, dates and times', 'tables', 'lists', 'headings', 'code', 'file paths', 'links', 'ids', 'symbols', 'separate written part', 'after the call',
    'use your tools for the work as usual', 'mood word']) assert.ok(VOICE_NOTE.includes(w), w);   // the rule is about the spoken reply, not tool work; the face's mood word stays allowed
  assert.ok(!/after the spoken answer|written part of the chat/.test(VOICE_NOTE), 'the old "detail after the spoken answer" rule is gone');
  assert.ok(VOICE_NOTE.split(/[.!?]\s/).length <= 3, 'three sentences at most');
  assert.ok([...VOICE_NOTE].every(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127), 'plain ASCII only: no invisible characters');
});

test('handleChatStreamReserved reads voice from the body and passes voice: !!voice to all three routes', () => {
  const start = lineOf('async function handleChatStreamReserved(body, res, ctx) {');
  const end = lineOf('\nasync function ', start + 10);
  const body = src.slice(start, end);
  assert.match(body, /\bturn_link, owner_turn, voice \} = body;/);
  for (const route of ['streamViaCodex', 'streamViaSdk', 'streamViaGateway']) {
    const call = body.slice(body.indexOf(`await ${route}(agent, finalMessage, imagePaths, res, {`));
    assert.ok(call.length, route);
    assert.match(call.slice(0, 200), /voice: !!voice,/, `${route} gets the flag`);
  }
});

test('gateway: the note is appended to the system prompt only for a voice turn that is not ephemeral', () => {
  const at = lineOf("if (!ephemeral) systemPrompt += (await visualsTextFor(agentName))");
  const next = src.slice(at, at + 600).split('\n');
  assert.ok(next[1].includes('if (voiceNoteFor(options, ephemeral)) systemPrompt += `\\n\\n${voiceNoteFor(options, ephemeral)}\\n`;'), next[1]);
});

test('Claude client: the note goes in the per-turn prefix (a resumed session keeps its old system prompt), not in the appended system prompt', () => {
  const at = lineOf('contextPrefix = `${timeZoneLib.localTimeTag(timeZoneLib.zoneForAgent(agentName))}\\n`;');
  const after = src.slice(at, at + 700).split('\n');
  assert.ok(after[1].includes('if (voiceNoteFor(options, ephemeral)) contextPrefix += `${voiceNoteFor(options, ephemeral)}\\n`;'), after[1]);
  const sysAt = lineOf('append: agentContext + workerPolicyText + jobsPolicyText + visualsText + handsNote');
  assert.ok(!src.slice(sysAt, sysAt + 400).includes('VOICE_NOTE'));
});

test('Codex client: the note goes in the per-turn prompt', () => {
  const at = lineOf('let prompt = `${timeZoneLib.localTimeTag(timeZoneLib.zoneForAgent(agentName))}\\n` + (voiceNoteFor(options, ephemeral) ? `${voiceNoteFor(options, ephemeral)}\\n` : \'\')');
  assert.ok(at > 0);
});

test('the note is added in exactly three places, always through voiceNoteFor (behind the voice flag and not ephemeral)', () => {
  const uses = src.split('\n').filter(l => l.includes('voiceNoteFor(options, ephemeral)') && !l.startsWith('function voiceNoteFor') && !l.trim().startsWith('//'));
  assert.strictEqual(uses.length, 3, uses.join('\n'));
  const { VOICE_NOTE, __voiceFace: { voiceNoteFor } } = L('sdk-chat');
  assert.strictEqual(voiceNoteFor({ voice: true }, false), VOICE_NOTE, 'a plain voice turn gets exactly VOICE_NOTE');
  assert.strictEqual(voiceNoteFor({ voice: true, faceMood: false }, false), VOICE_NOTE);
  assert.strictEqual(voiceNoteFor({ voice: true }, true), '', 'ephemeral: none');
  assert.strictEqual(voiceNoteFor({}, false), '', 'not a voice turn: none');
  assert.strictEqual(voiceNoteFor({ voice: 'yes' }, false), '', 'only a real true');
  // the only extra a voice turn can get is the mood note, and only behind faceMood === true
  assert.ok(voiceNoteFor({ voice: true, faceMood: true }, false).startsWith(VOICE_NOTE));
  assert.strictEqual(voiceNoteFor({ faceMood: true }, false), '', 'faceMood alone adds nothing');
});
