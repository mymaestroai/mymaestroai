'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SdkInterjectionChannel, stashUndelivered, takeUndelivered, formatCarried, INTERJECTION_PREFIX,
} = require('../lib/sdk-interject');

// A tiny queue with the same drain/peek contract sdk-chat.js provides.
function makeQueue() {
  const q = [];
  return { q, push: m => q.push({ message: m, ts: '2026-09-21T12:00:00Z' }), drain: () => q.splice(0), peek: () => q.length };
}
const tick = () => new Promise(r => setImmediate(r));

// Pull the next message from the generator without blocking forever.
async function next(gen, ms = 200) {
  return Promise.race([gen.next(), new Promise(r => setTimeout(() => r({ timeout: true }), ms))]);
}

describe('SDK interjection channel', () => {
  it('yields the initial message with a uuid, then waits', async () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel(Q);
    const gen = ch.stream('hello');
    const first = await next(gen);
    assert.strictEqual(first.value.type, 'user');
    assert.strictEqual(first.value.message.content, 'hello');
    assert.match(first.value.uuid, /^[0-9a-f-]{36}$/);
    assert.strictEqual(first.value.priority, undefined, 'priority must stay unset: "next" drops messages, "now" cuts the turn');
    const second = await next(gen, 60);
    assert.ok(second.timeout, 'generator must stay open while the turn runs');
    ch.close();
  });

  it('mid-turn: interjection is yielded on notify, acked, and one result closes the stream', async () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel(Q);
    const gen = ch.stream('task');
    const first = (await next(gen)).value; ch.ack(first.uuid);
    const pending = next(gen, 500);               // generator is now asleep
    await tick(); Q.push('also do X'); ch.notify();
    const ij = (await pending).value;
    assert.strictEqual(ij.message.content, INTERJECTION_PREFIX + 'also do X');
    const rec = ch.ack(ij.uuid);
    assert.strictEqual(rec.message, 'also do X', 'ack returns the interjection record for UI notification');
    assert.strictEqual(ch.ack(ij.uuid), null, 'duplicate ack is ignored');
    assert.strictEqual(ch.onResult(), true, 'everything acked -> close');
    assert.strictEqual((await next(gen)).done, true);
    assert.deepStrictEqual(ch.undelivered(), []);
    assert.strictEqual(ch.delivered().length, 1);
  });

  it('during final answer: result with an un-acked interjection holds the stream open for the follow-up turn', async () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel(Q);
    const gen = ch.stream('write a story');
    const first = (await next(gen)).value; ch.ack(first.uuid);
    const pending = next(gen, 500); await tick(); Q.push('late thought'); ch.notify();
    const ij = (await pending).value;             // handed to the SDK, not yet consumed
    assert.strictEqual(ch.onResult(), false, 'result #1 must NOT close: the SDK still owes a follow-up turn');
    assert.strictEqual(ch.closed, false);
    ch.ack(ij.uuid);                              // SDK consumes it, runs turn 2
    assert.strictEqual(ch.onResult(), true, 'result #2 closes');
    assert.strictEqual(ch.results, 2);
  });

  it('interjection queued but not yet yielded when the result arrives is still sent', async () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel(Q);
    const gen = ch.stream('task');
    const first = (await next(gen)).value; ch.ack(first.uuid);
    const pending = next(gen, 500); await tick();
    Q.push('squeaked in');                        // queued, but nobody called notify() yet
    assert.strictEqual(ch.onResult(), false, 'must not close with a queued interjection');
    const ij = (await pending).value;
    assert.strictEqual(ij.message.content, INTERJECTION_PREFIX + 'squeaked in');
    ch.ack(ij.uuid);
    assert.strictEqual(ch.onResult(), true);
  });

  it('safety timer closes the stream if an ack never comes, and the message is reported undelivered', async () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel({ ...Q, ackSafetyMs: 40 });
    const gen = ch.stream('task');
    const first = (await next(gen)).value; ch.ack(first.uuid);
    const pending = next(gen, 500); await tick(); Q.push('never acked'); ch.notify();
    await pending;
    assert.strictEqual(ch.onResult(), false);
    await new Promise(r => setTimeout(r, 90));
    assert.strictEqual(ch.closed, true);
    assert.deepStrictEqual(ch.undelivered().map(i => i.message), ['never acked']);
  });

  it('abort mid-batch: drained-but-unyielded interjections are not lost', async () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel(Q);
    const gen = ch.stream('task');
    const first = (await next(gen)).value; ch.ack(first.uuid);
    const pending = next(gen, 500); await tick(); Q.push('one'); Q.push('two'); Q.push('three'); ch.notify();
    await pending;                                // 'one' yielded; 'two','three' sit in the buffer
    ch.close();                                   // turn aborted
    assert.deepStrictEqual(ch.undelivered().map(i => i.message).sort(), ['one', 'three', 'two']);
  });

  it('acks for unknown uuids are ignored', () => {
    const Q = makeQueue(); const ch = new SdkInterjectionChannel(Q);
    assert.strictEqual(ch.ack('not-ours'), null);
  });
});

describe('next-turn fallback store', () => {
  const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ij-')), 'pending.json');

  it('stashes per agent, appends, and take() clears only that agent', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ij-')), 'pending.json');
    stashUndelivered('maestro', [{ message: 'a', ts: 't1' }], f);
    stashUndelivered('maestro', [{ message: 'b', ts: 't2' }], f);
    stashUndelivered('haiku', [{ message: 'c', ts: 't3' }], f);
    assert.deepStrictEqual(takeUndelivered('maestro', f).map(i => i.message), ['a', 'b']);
    assert.deepStrictEqual(takeUndelivered('maestro', f), [], 'second take is empty');
    assert.deepStrictEqual(takeUndelivered('haiku', f).map(i => i.message), ['c']);
  });

  it('survives a missing or corrupt file', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ij-')), 'pending.json');
    assert.deepStrictEqual(takeUndelivered('x', f), []);
    fs.writeFileSync(f, '{not json');
    assert.deepStrictEqual(takeUndelivered('x', f), []);
    assert.strictEqual(stashUndelivered('x', [{ message: 'm', ts: 't' }], f), 1);
  });

  it('writes the store with private permissions', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ij-')), 'pending.json'); stashUndelivered('x', [{ message: 'm', ts: 't' }], f);
    assert.strictEqual(fs.statSync(f).mode & 0o777, 0o600);
  });

  it('formats carried interjections ahead of the current message, or nothing at all', () => {
    assert.strictEqual(formatCarried([]), '');
    const one = formatCarried([{ message: 'check the logs', ts: 't1' }]);
    assert.match(one, /OPERATOR INTERJECTION sent during your previous turn/);
    assert.match(one, /check the logs/);
    assert.ok(one.endsWith('[Current message]:\n'));
    assert.match(formatCarried([{ message: 'a' }, { message: 'b' }]), /INTERJECTIONS/);
  });
});

describe('emergency interjections', () => {
  const { peekUndelivered, prefixFor, isEmergency, emergencyFirst, EMERGENCY_PREFIX } = require('../lib/sdk-interject');
  const em = (id, message = 'alert ' + id) => ({ message, ts: 't', priority: 'emergency', id });

  it('recognises the emergency flag and picks the matching prefix', () => {
    assert.strictEqual(isEmergency(em('HF_LOW')), true);
    assert.strictEqual(isEmergency({ message: 'plain', ts: 't' }), false);
    assert.strictEqual(isEmergency({ message: 'plain', priority: 'high' }), false);
    assert.strictEqual(prefixFor(em('HF_LOW')), EMERGENCY_PREFIX);
    assert.strictEqual(prefixFor({ message: 'plain' }), INTERJECTION_PREFIX);
    assert.match(EMERGENCY_PREFIX, /^\[EMERGENCY INTERJECTION/);
  });

  it('orders emergencies first but keeps the relative order inside each group', () => {
    const items = [{ message: 'a' }, em('X'), { message: 'b' }, em('Y')];
    assert.deepStrictEqual(emergencyFirst(items).map(i => i.message), ['alert X', 'alert Y', 'a', 'b']);
    assert.deepStrictEqual(items.map(i => i.message), ['a', 'alert X', 'b', 'alert Y'], 'input not mutated');
  });

  it('streams an emergency ahead of routine interjections queued before it', async () => {
    const queue = makeQueue();
    const ch = new SdkInterjectionChannel({ drain: queue.drain, peek: queue.peek });
    const gen = ch.stream('go'); await next(gen);
    const waiting = next(gen); await tick();
    queue.push('routine one'); queue.push('routine two'); queue.q.push(em('CRASH_FAST'));
    ch.notify();
    const first = await waiting;
    assert.strictEqual(first.value.message.content, EMERGENCY_PREFIX + 'alert CRASH_FAST');
    assert.strictEqual((await next(gen)).value.message.content, INTERJECTION_PREFIX + 'routine one');
    assert.strictEqual((await next(gen)).value.message.content, INTERJECTION_PREFIX + 'routine two');
    ch.close();
  });

  it('stash keeps priority and id; peek is read-only; carried text marks emergencies first', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ij-')), 'pending.json');
    stashUndelivered('trader', [{ message: 'routine', ts: 't1' }, em('HF_LOW')], f);
    const peeked = peekUndelivered('trader', f);
    assert.deepStrictEqual(peeked.map(i => [i.message, i.priority, i.id]), [['routine', undefined, undefined], ['alert HF_LOW', 'emergency', 'HF_LOW']]);
    assert.strictEqual(peekUndelivered('trader', f).length, 2, 'peek does not consume');
    assert.deepStrictEqual(peekUndelivered('nobody', f), []);
    const text = formatCarried(takeUndelivered('trader', f));
    assert.ok(text.indexOf('[EMERGENCY] (t) alert HF_LOW') < text.indexOf('(t1) routine'));
    assert.match(text, /items marked \[EMERGENCY\] come first/);
    assert.doesNotMatch(formatCarried([{ message: 'x', ts: 't' }]), /EMERGENCY/);
    assert.deepStrictEqual(takeUndelivered('trader', f), []);
  });
});
