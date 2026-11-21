'use strict';
// A hand-off's turn is in the turn registry, with its hand-off id, before the turn can answer 200 (which is what admits
// it: startHubTurn resolves, and a wake-up's 'started' hook runs). So a stop or a note for that hand-off (they act only on
// a running turn whose origin carries the id) always finds the turn it admitted, never another one.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { makeIsolatedInstall } = require('./helpers/isolated-install');
const ISO = makeIsolatedInstall('hand-off-turn-order-iso-');
const L = (p) => require(path.join(ISO.lib, p));
const sdkChat = L('sdk-chat');
const { turnRegistry, setTestStreamer } = sdkChat.__turn;

const AGENT = 'zz_ho_order_a';
const convDir = path.join(ISO.data, 'conversations');
fs.mkdirSync(convDir, { recursive: true });
after(() => { setTestStreamer(null); try { fs.unlinkSync(path.join(convDir, `${AGENT}.jsonl`)); } catch {} });

test('a hand-off turn is registered with its id before it can answer 200', async () => {
  let atStart = null, atAdmit = null;
  setTestStreamer(async ({ res }) => {
    atStart = turnRegistry.get(AGENT) || null;   // the model call begins: nothing can have answered 200 before this point
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end();
  });
  const id = 'ho-0000abcd';
  const admitted = sdkChat.startHubTurn(AGENT, 'continue the job', { origin: { kind: 'hand_off', from: 'zz_ho_order_b', handOff: id } })
    .then((r) => { atAdmit = turnRegistry.get(AGENT) || null; return r; });
  const r = await admitted;
  await r.done;
  assert.ok(atStart, 'registered before the model call');
  assert.strictEqual(atStart.origin.kind, 'hand_off');
  assert.strictEqual(atStart.origin.handOff, id);
  assert.ok(atAdmit && atAdmit.origin.handOff === id, 'still there when the hand-off code resumes after admission');
});
