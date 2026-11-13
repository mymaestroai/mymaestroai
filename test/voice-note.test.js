'use strict';
// Voice turns get a note: a short spoken answer first, detail in the chat. The pages send voice: true in the body of
// POST /api/chat/stream for turns started by voice; handleChatStreamReserved hands it to the three routes (gateway, Claude
// client, Codex client), and each adds VOICE_NOTE only when voice is true and the turn is not ephemeral.
// The routes need a model and a live hub, so these are checks of the source, as for the other prompt-building tests.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sdk-chat.js'), 'utf8');
const lineOf = (needle, from = 0) => { const i = src.indexOf(needle, from); assert.ok(i >= 0, `missing: ${needle}`); return i; };

// Strengthened (voice fixes round 1): the owner heard dashes and symbols read out, so the note now says what the spoken part
// must not contain; the old exact-text pin is replaced by this one.
test('VOICE_NOTE is the agreed text: a plain spoken answer first, symbols and detail only in the written part', () => {
  const { VOICE_NOTE } = require('../lib/sdk-chat');
  assert.strictEqual(VOICE_NOTE, 'This is a voice conversation: lead with a short spoken answer of one to three plain sentences, written to be heard, with no dashes, bullets, asterisks, slashes, arrows, emoji, parentheses, code, file paths, URLs or abbreviations that read badly, and with numbers, dates and times written the way you would say them. Put tables, lists, code, symbols and long detail only after the spoken answer, in the written part of the chat.');
  for (const w of ['dashes', 'bullets', 'asterisks', 'slashes', 'arrows', 'emoji', 'parentheses', 'code', 'file paths', 'URLs', 'abbreviations', 'numbers, dates and times', 'after the spoken answer']) assert.ok(VOICE_NOTE.includes(w), w);
  assert.ok(VOICE_NOTE.split(/[.!?]\s/).length <= 3, 'two or three sentences');
  assert.ok([...VOICE_NOTE].every(ch => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) < 127), 'plain ASCII only: no invisible characters');
});

test('handleChatStreamReserved reads voice from the body and passes voice: !!voice to all three routes', () => {
  const start = lineOf('async function handleChatStreamReserved(body, res) {');
  const end = lineOf('\nasync function ', start + 10);
  const body = src.slice(start, end);
  assert.match(body.split('\n')[1], /\bturn_link, owner_turn, voice \} = body;/);
  for (const route of ['streamViaCodex', 'streamViaSdk', 'streamViaGateway']) {
    const call = body.slice(body.indexOf(`await ${route}(agent, finalMessage, imagePaths, res, {`));
    assert.ok(call.length, route);
    assert.match(call.slice(0, 200), /voice: !!voice,/, `${route} gets the flag`);
  }
});

test('gateway: the note is appended to the system prompt only for a voice turn that is not ephemeral', () => {
  const at = lineOf("if (!ephemeral) systemPrompt += (await visualsTextFor(agentName))");
  const next = src.slice(at, at + 600).split('\n');
  assert.ok(next[1].includes('if (!ephemeral && options.voice === true) systemPrompt += `\\n\\n${VOICE_NOTE}\\n`;'), next[1]);
});

test('Claude client: the note goes in the per-turn prefix (a resumed session keeps its old system prompt), not in the appended system prompt', () => {
  const at = lineOf('contextPrefix = `${timeZoneLib.localTimeTag(timeZoneLib.zoneForAgent(agentName))}\\n`;');
  const after = src.slice(at, at + 700).split('\n');
  assert.ok(after[1].includes('if (!ephemeral && options.voice === true) contextPrefix += `${VOICE_NOTE}\\n`;'), after[1]);
  const sysAt = lineOf('append: agentContext + workerPolicyText + jobsPolicyText + visualsText + handsNote');
  assert.ok(!src.slice(sysAt, sysAt + 400).includes('VOICE_NOTE'));
});

test('Codex client: the note goes in the per-turn prompt', () => {
  const at = lineOf('let prompt = `${timeZoneLib.localTimeTag(timeZoneLib.zoneForAgent(agentName))}\\n` + (!ephemeral && options.voice === true ? `${VOICE_NOTE}\\n` : \'\')');
  assert.ok(at > 0);
});

test('the note is added in exactly three places and always behind the voice flag', () => {
  const uses = src.split('\n').filter(l => l.includes('VOICE_NOTE') && !l.trim().startsWith('//') && !l.includes('const VOICE_NOTE') && !l.includes('holdConsultForCall, voiceGateKind'));
  assert.strictEqual(uses.length, 3, uses.join('\n'));
  for (const l of uses) assert.ok(l.includes('options.voice === true') && l.includes('!ephemeral'), l);
});
